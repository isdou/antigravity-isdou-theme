/**
 * core/daemon/prompt-suggest.mjs — Claude Code-style Background Prompt Suggestion Engine
 *
 * Uses a persistent `agy --input-format stream-json --output-format stream-json`
 * worker powered by the user's Antigravity account (zero external API key,
 * zero sidebar conversation pollution, prompt-cache accelerated).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MAX_TURNS_PER_WORKER = 40;
const WARMUP_TIMEOUT_MS = 75000;
const TURN_TIMEOUT_MS = 30000;
const CACHE_LIMIT = 100;

export const PROMPT_SUGGEST_SYSTEM_INSTRUCTION = [
  '你是一个聊天输入框的「下一句提示词预测器」（类似 Claude Code 的 Prompt Suggestions）。',
  '我会给你一段刚结束的对话片段（用户的上一条消息 + 助手的最新回复）。',
  '请站在「用户」的视角，预测用户下一步最可能、最自然想发出的那一句简短指令或追问。',
  '严格遵守以下规则：',
  '1. 只输出预测的那一句话本身，不要任何前缀、引号、解释、编号、Markdown 标记或换行。',
  '2. 保持与用户语言一致，控制在 4~28 个字以内，具体且可直接执行。',
  '3. 优先结合上下文主动预判用户最顺手、最可能发出的下一句（如继续执行、验证测试、排查细节、推送提交、追问原因、修改实现等）；仅当对话已完全结束且无任何合理后续动作时，才输出 NONE。',
  '4. 绝对不要调用任何工具，直接输出文本。'
].join('\n');

export function cleanPromptSuggestionText(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!text) return '';
  text = text
    .replace(/^["'“”‘’`⟫>:\-\s]+/, '')
    .replace(/["'“”‘’`]+$/, '')
    .trim();
  if (!text || /^none$/i.test(text) || /^无$/i.test(text) || text.length < 2 || text.length > 60) {
    return '';
  }
  return text;
}

export function resolveAgyCliBinary({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const isWin = platform === 'win32';
  const candidates = [
    env.AGY_BIN,
    ...(isWin
      ? [
          path.join(homedir, '.local', 'bin', 'agy.exe'),
          path.join(homedir, '.local', 'bin', 'agy.cmd'),
          path.join(env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'bin', 'agy.exe')
        ]
      : [
          path.join(homedir, '.local', 'bin', 'agy'),
          '/opt/homebrew/bin/agy',
          '/usr/local/bin/agy'
        ])
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }

  try {
    const probe = spawnSync(isWin ? 'where' : 'which', ['agy'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true
    });
    if (probe.status === 0) {
      const found = String(probe.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (found) return found;
    }
  } catch {}

  return '';
}

export function createPromptSuggestionEngine({ getConfig, runOnce = false, resolveBin = resolveAgyCliBinary } = {}) {
  let agyBinCache = undefined;
  let proc = null;
  let activeModel = '';
  let ready = false;
  let warmed = false;
  let turns = 0;
  let pending = null;
  let starting = false;
  let pendingStart = false;
  let restartTimer = null;
  const stoppingProcs = new Set();
  const queue = [];
  const cache = new Map();

  function destroyChildStreams(child) {
    if (!child) return;
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        if (stream && !stream.destroyed && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      } catch {}
    }
  }

  function retireChildProcess(child) {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      destroyChildStreams(child);
      return;
    }
    stoppingProcs.add(child);
    let killTimer = null;
    const cleanupStopping = () => {
      if (killTimer) clearTimeout(killTimer);
      stoppingProcs.delete(child);
      destroyChildStreams(child);
      if (stoppingProcs.size === 0 && pendingStart && isEnabled()) {
        pendingStart = false;
        ensureStarted();
      }
    };
    child.once('exit', cleanupStopping);
    try {
      child.stdin?.end();
      child.kill('SIGTERM');
    } catch {}
    killTimer = setTimeout(() => {
      if (stoppingProcs.has(child)) {
        try {
          child.kill('SIGKILL');
        } catch {}
        cleanupStopping();
      }
    }, 2500);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  }

  function getAgyBin() {
    if (agyBinCache !== undefined) return agyBinCache;
    agyBinCache = resolveBin() || '';
    return agyBinCache;
  }

  function isEnabled() {
    if (runOnce) return false;
    const cfg = typeof getConfig === 'function' ? getConfig() : null;
    return Boolean(cfg && cfg.enabled !== false && cfg.modules && cfg.modules.promptSuggestions);
  }

  function getTargetModel() {
    const cfg = typeof getConfig === 'function' ? getConfig() : null;
    const m = cfg && typeof cfg.promptSuggestionModel === 'string' ? cfg.promptSuggestionModel.trim() : '';
    return m || 'gemini-3.8-flash-low';
  }

  function stop({ wantRestart = false } = {}) {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const old = proc;
    proc = null;
    ready = false;
    warmed = false;
    turns = 0;
    pendingStart = Boolean(wantRestart);
    if (pending) {
      const cur = pending;
      pending = null;
      clearTimeout(cur.timer);
      if (!cur.settled) {
        cur.settled = true;
        cur.resolve(null);
      }
    }
    if (!wantRestart) {
      while (queue.length > 0) {
        const dropped = queue.shift();
        dropped.resolve(null);
      }
    }
    if (old) {
      retireChildProcess(old);
    }
  }

  function restart() {
    if (!isEnabled()) {
      stop({ wantRestart: false });
      return;
    }
    stop({ wantRestart: true });
    if (stoppingProcs.size === 0) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (isEnabled()) {
          pendingStart = false;
          ensureStarted();
        }
      }, 200);
    }
  }

  function sendWarmup() {
    if (pending || warmed || !proc) return;
    const warmupPrompt = `${PROMPT_SUGGEST_SYSTEM_INSTRUCTION}\n\n收到以上规则请只回复：OK`;
    const timer = setTimeout(() => {
      if (pending && pending.isWarmup) {
        pending = null;
        restart();
      }
    }, WARMUP_TIMEOUT_MS);

    pending = {
      owner: proc,
      isWarmup: true,
      settled: true,
      chunks: [],
      resolve: () => {},
      timer
    };

    try {
      proc.stdin.write(JSON.stringify({ event: 'user', message: { content: warmupPrompt } }) + '\n');
    } catch {
      clearTimeout(timer);
      pending = null;
      restart();
    }
  }

  function drain() {
    if (pending || !warmed || queue.length === 0) return;
    if (!proc || proc.killed || proc.exitCode !== null) {
      ensureStarted();
      return;
    }
    const item = queue.shift();
    const timer = setTimeout(() => {
      if (pending && pending.resolve === item.resolve) {
        const cur = pending;
        pending = null;
        if (!cur.settled) {
          cur.settled = true;
          item.resolve(null);
        }
        restart();
      }
    }, TURN_TIMEOUT_MS);

    pending = {
      owner: proc,
      isWarmup: false,
      settled: false,
      chunks: [],
      resolve: item.resolve,
      timer
    };

    try {
      proc.stdin.write(JSON.stringify({ event: 'user', message: { content: item.promptText } }) + '\n');
    } catch {
      clearTimeout(timer);
      pending = null;
      item.resolve(null);
      restart();
    }
  }

  function ensureStarted() {
    const model = getTargetModel();
    if (proc && !proc.killed && proc.exitCode === null) {
      if (activeModel === model) return true;
      stop({ wantRestart: true });
      return true;
    }
    if (stoppingProcs.size > 0) {
      pendingStart = true;
      return true;
    }
    if (starting) return true;
    const bin = getAgyBin();
    if (!bin) return false;

    starting = true;
    pendingStart = false;
    activeModel = model;
    ready = false;
    warmed = false;
    turns = 0;

    let child;
    try {
      const extraPath =
        process.platform === 'win32'
          ? ''
          : `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:`;
      child = spawn(
        bin,
        [
          '--model',
          model,
          '--effort',
          'low',
          '--disable-slash-commands',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json'
        ],
        {
          cwd: os.tmpdir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            PATH: extraPath ? `${extraPath}${process.env.PATH || ''}` : process.env.PATH
          }
        }
      );
    } catch {
      starting = false;
      while (queue.length > 0) {
        const dropped = queue.shift();
        dropped.resolve(null);
      }
      return false;
    }

    proc = child;
    starting = false;
    let childBuf = '';
    if (child.stderr && typeof child.stderr.resume === 'function') {
      child.stderr.resume();
    }

    child.stdout.on('data', (chunk) => {
      if (proc !== child) return;
      childBuf += chunk.toString('utf8');
      const lines = childBuf.split('\n');
      childBuf = lines.pop() || '';
      for (const line of lines) {
        if (proc !== child) return;
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.event === 'init') {
          ready = true;
          sendWarmup();
        } else if (evt.event === 'step_update') {
          const su = evt.step_update;
          if (su && su.step_type === 'agent_response' && pending && pending.owner === child) {
            if (su.text_delta) pending.chunks.push(String(su.text_delta));
            if (su.state === 'DONE' && !pending.settled && pending.chunks.length > 0) {
              pending.settled = true;
              pending.resolve(pending.chunks.join('').trim());
            }
          }
        } else if (evt.event === 'result') {
          const cur = pending && pending.owner === child ? pending : null;
          if (cur) {
            pending = null;
            clearTimeout(cur.timer);
            if (!cur.settled) {
              cur.settled = true;
              const raw = String((evt.result && evt.result.response) || cur.chunks.join('') || '').trim();
              cur.resolve(raw);
            }
          }
          if (!warmed) {
            warmed = true;
          } else {
            turns += 1;
          }
          if (turns >= MAX_TURNS_PER_WORKER) {
            restart();
            return;
          }
          drain();
        }
      }
    });

    child.on('error', () => {
      if (proc !== child) return;
      stop();
    });
    child.on('exit', () => {
      destroyChildStreams(child);
      if (proc !== child) return;
      ready = false;
      warmed = false;
      proc = null;
      if (pending && pending.owner === child) {
        const cur = pending;
        pending = null;
        clearTimeout(cur.timer);
        if (!cur.settled) {
          cur.settled = true;
          cur.resolve(null);
        }
      }
      if (queue.length > 0 && isEnabled()) {
        setTimeout(() => ensureStarted(), 800);
      }
    });

    return true;
  }

  function syncState() {
    if (!isEnabled()) {
      stop();
      return;
    }
    ensureStarted();
  }

  async function suggest({ fingerprint = '', lastUser = '', lastAssistant = '', force = false } = {}) {
    if (!isEnabled() || !lastAssistant) return { suggestion: '', transient: false };
    if (fingerprint && cache.has(fingerprint)) {
      const cached = cache.get(fingerprint);
      if (cached || !force) {
        return { suggestion: cached, transient: false };
      }
    }
    const promptLead = force
      ? '用户刚按下 Tab 请求提示，请结合以下刚结束的对话片段，务必给出最贴切、最顺手的一句简短后续指令（4~28字，无解释无引号，尽量不要输出 NONE）：'
      : '根据以下刚结束的对话片段，输出用户下一步最可能发的简短指令（4~28字，无解释无引号，若无合理后续才输出 NONE）：';
    const promptText = [
      promptLead,
      lastUser ? `用户：${lastUser}` : '',
      `助手：${lastAssistant}`
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await new Promise((resolve) => {
      if (!ensureStarted()) {
        resolve(null);
        return;
      }
      while (queue.length > 0) {
        const dropped = queue.shift();
        dropped.resolve(null);
      }
      queue.push({ promptText, resolve });
      if (warmed) drain();
    });

    if (raw === null) {
      return { suggestion: '', transient: true };
    }

    const suggestion = cleanPromptSuggestionText(raw);
    if (fingerprint) {
      if (cache.size >= CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
      cache.set(fingerprint, suggestion);
    }
    return { suggestion, transient: false };
  }

  return {
    syncState,
    suggest,
    restart,
    stop,
    getStatus: () => ({
      ready,
      warmed,
      turns,
      stoppingCount: stoppingProcs.size,
      cacheSize: cache.size
    })
  };
}
