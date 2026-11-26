/**
 * core/daemon/skilldex.mjs — SkillDex 本地多端技能图鉴、真实用量分析与安全操作引擎
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const USAGE_CACHE_TTL_MS = 60_000;
const DEMO_CACHE_PATH = path.join(HOME, '.skilldex', 'demo-cache.json');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function stripQuotes(s) {
  let out = String(s || '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    if (out.length >= 2) out = out.slice(1, -1);
  }
  return out;
}

function parseFrontmatter(md) {
  if (!md || !md.startsWith('---')) return { fm: {}, body: md || '' };
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: md };
  const fm = {};
  let curKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      curKey = kv[1];
      let val = kv[2].trim();
      if (val === '>' || val === '>-' || val === '|' || val === '|-') val = '';
      fm[curKey] = stripQuotes(val);
    } else if (curKey && /^\s+/.test(line)) {
      const piece = line.trim();
      if (piece) fm[curKey] = fm[curKey] ? `${fm[curKey]} ${piece}` : piece;
    }
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

function categorize(name, desc) {
  const n = String(name || '').toLowerCase();
  const d = String(desc || '').toLowerCase();
  if (
    n.startsWith('asc-') ||
    n.startsWith('swift') ||
    n.startsWith('xcode') ||
    n.startsWith('ios-') ||
    ['core-data-expert', 'add-component', 'build-feature', 'explore-recipes', 'write-swift', 'spm-build-analysis', 'phone-harness'].includes(n)
  ) {
    return 'ios';
  }
  if (
    [
      'frontend-design', 'redesign-existing-projects', 'critique', 'audit', 'polish', 'adapt',
      'animate', 'apple-design', 'emil-design-eng', 'isdou-apple-ui', 'liquid-glass-ui',
      'animal-island-vue-style', 'nothing-ui-style', 'clarify', 'extract', 'bolder', 'quieter',
      'colorize', 'delight', 'distill', 'harden', 'normalize', 'onboard', 'optimize', 'superdesign',
      'figma', 'mobbin', 'stitch'
    ].some((k) => n.includes(k)) ||
    (d.includes('swiftui') && d.includes('design'))
  ) {
    return 'design';
  }
  if (
    n.startsWith('chatcut-') ||
    n.startsWith('sd-') ||
    n.startsWith('remotion') ||
    n.startsWith('flow-') ||
    n.includes('video') ||
    ['hypit', 'openmotion', 'sora', 'short-drama-director', 'invideo', 'briefing-trailer', 'music'].includes(n)
  ) {
    return 'video';
  }
  if (
    n.startsWith('xiaohongshu-') ||
    n.startsWith('x-') ||
    n.includes('wechat') ||
    n.includes('social') ||
    ['zhuque-deai-master', 'agent-reach', 'weread-skills', 'influencer-prospecting', 'comment-mining', 'outlier-post-finder', 'trend-discovery', 'ad-library-teardown'].includes(n)
  ) {
    return 'social';
  }
  if (
    n.startsWith('gcp-') ||
    n.startsWith('bigquery') ||
    n.includes('data') ||
    n.includes('dbt') ||
    n.includes('sql') ||
    ['colab-operator', 'notebook-guidance', 'schema-mapping', 'ml-best-practices'].includes(n)
  ) {
    return 'data';
  }
  if (
    n.startsWith('game-') ||
    ['develop-web-game', 'novel-to-game', 'novel-game-analyze', 'hatch-pet', 'img2threejs', 'scroll-world', 'genie-4-live-world'].includes(n)
  ) {
    return 'game';
  }
  if (
    ['prd', 'roadmap', 'pricing', 'strategy', 'competitor', 'pm-interview', 'startup', 'growth-loops', 'gtm', 'market-sizing', 'earnings', 'portfolio', 'financial', 'industry-', 'thesis-tracker', 'bottleneck-hunter'].some((k) =>
      n.includes(k)
    )
  ) {
    return 'product';
  }
  if (
    n.startsWith('codex-') ||
    n.startsWith('aihub-') ||
    n.startsWith('vercel') ||
    n.startsWith('ponytail') ||
    ['playwright', 'yeet', 'pdf', 'visualize', 'canvas', 'karpathy-guidelines', 'release-source-of-truth', 'intended-vs-implemented', 'workspace-teleport', 'parallel-agent', 'worktree-cleaner', 'branch-keeper', 'chrome-devtools'].some((k) =>
      n.includes(k)
    )
  ) {
    return 'dev';
  }
  return 'other';
}

function parseSkillMarkdown(md, fallbackName) {
  const { fm, body } = parseFrontmatter(md);
  const name = (fm.name || fallbackName || '').replace(/\s+/g, ' ').trim() || fallbackName;
  const rawDesc = (fm.description || '').replace(/\s+/g, ' ').trim();

  let summary = rawDesc.replace(/\*\*/g, '');
  if (!summary) {
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('```')) continue;
      summary = t.replace(/\*\*/g, '');
      break;
    }
  }
  if (!summary) summary = `使用 ${name} 执行专项工作流`;
  if (summary.length > 110) summary = summary.slice(0, 108) + '…';

  // 提取触发词
  const triggers = [];
  const combined = `${rawDesc}\n${body.slice(0, 1600)}`;
  const pushTrigger = (s) => {
    const clean = String(s || '').trim();
    if (!clean || clean.includes('http') || (clean.includes('/') && !clean.startsWith('/'))) return;
    if (!triggers.includes(clean) && triggers.length < 6) triggers.push(clean);
  };
  for (const m of combined.matchAll(/\/[a-zA-Z0-9_-]{2,28}/g)) pushTrigger(m[0]);
  for (const m of combined.matchAll(/「([^」]{2,24})」/g)) pushTrigger(m[1]);
  for (const m of combined.matchAll(/"([^"]{3,30})"/g)) pushTrigger(m[1]);
  if (triggers.length === 0) triggers.push(`/${name}`);

  // 提取示例口令
  const samplePrompts = [];
  let inExample = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#')) {
      const low = t.toLowerCase();
      inExample = low.includes('example') || low.includes('usage') || low.includes('示例') || low.includes('用法') || low.includes('触发');
      continue;
    }
    if (inExample && (/^[-*>]\s+/.test(t))) {
      const item = t.replace(/^[-*>]\s+/, '').replace(/[`"]/g, '').trim();
      if (item.length >= 6 && item.length <= 92 && !samplePrompts.includes(item)) {
        samplePrompts.push(item);
        if (samplePrompts.length >= 3) break;
      }
    }
  }
  if (samplePrompts.length === 0) {
    samplePrompts.push(`请使用 ${name} 技能，帮我完成当前任务`);
    const slash = triggers.find((t) => t.startsWith('/'));
    if (slash) {
      samplePrompts.push(`${slash} 结合当前项目帮我分析并给出执行方案`);
    } else if (rawDesc) {
      samplePrompts.push(`按 ${name} 的规范处理：${rawDesc.slice(0, 42)}`);
    }
  }

  const estimatedPromptTokens = Math.max(18, Math.ceil((name.length + rawDesc.length + 72) / 3));
  const contentHash = crypto.createHash('sha256').update(md).digest('hex').slice(0, 16);

  return {
    name,
    summary,
    rawDescription: rawDesc || summary,
    triggers,
    samplePrompts: samplePrompts.slice(0, 3),
    estimatedPromptTokens,
    contentHash
  };
}

function discoverBundledAssets(folderPath) {
  const images = [];
  const files = [];
  for (const sub of ['', 'assets', 'examples', 'images', 'scripts', 'references']) {
    const full = sub ? path.join(folderPath, sub) : folderPath;
    let entries = [];
    try {
      entries = fs.readdirSync(full).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'SKILL.md') continue;
      const abs = path.join(full, e);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const ext = path.extname(e).toLowerCase();
      if (IMAGE_EXTS.has(ext) && images.length < 4) images.push(abs);
      if (files.length < 12) files.push(sub ? `${sub}/${e}` : e);
    }
  }
  return { images, files };
}

function scanSkillDir(root, source, { pluginName = null, isPluginEnabled = true, isArchived = false } = {}) {
  if (!fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const dirName of names) {
    if (dirName.startsWith('.')) continue;
    const folderPath = path.join(root, dirName);
    const skillMdPath = path.join(folderPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    let mdText = '';
    try {
      mdText = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      continue;
    }
    let isSymlink = false;
    let symlinkTarget = null;
    try {
      const lst = fs.lstatSync(folderPath);
      isSymlink = lst.isSymbolicLink();
      if (isSymlink) symlinkTarget = fs.readlinkSync(folderPath);
    } catch {}
    const parsed = parseSkillMarkdown(mdText, dirName);
    const { images, files } = discoverBundledAssets(folderPath);
    out.push({
      id: `${source}|${pluginName || ''}|${isArchived ? 'arch' : 'act'}|${folderPath}`,
      dirName,
      name: parsed.name,
      summary: parsed.summary,
      rawDescription: parsed.rawDescription,
      source,
      pluginName,
      category: categorize(parsed.name, parsed.rawDescription),
      folderPath,
      skillMdPath,
      isSymlink,
      symlinkTarget,
      isArchived,
      isPluginEnabled,
      canArchive: source !== 'AGY Plugin',
      fileBytes: Buffer.byteLength(mdText, 'utf8'),
      estimatedPromptTokens: parsed.estimatedPromptTokens,
      triggers: parsed.triggers,
      samplePrompts: parsed.samplePrompts,
      previewImages: images,
      bundledFiles: files,
      contentHash: parsed.contentHash,
      agyUseCount: 0,
      codexUseCount: 0,
      totalUseCount: 0,
      lastUsedAt: null
    });
  }
  return out;
}

function inspectRuleFile(filePath, { title, scopeLabel, pluginName = null, isPluginEnabled = true, isGlobalCore = false }) {
  if (!fs.existsSync(filePath)) return null;
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) return null;
  const base = path.basename(filePath).toUpperCase();
  let triggerMode = 'always_on';
  if (base === 'AGENTS.MD' || base === 'GEMINI.MD') {
    triggerMode = 'fixed_always_on';
  } else if (content.startsWith('---') && /trigger:\s*model_decision/i.test(content)) {
    triggerMode = 'model_decision';
  }
  return {
    id: filePath,
    title,
    filePath,
    scopeLabel,
    pluginName,
    isPluginEnabled,
    bytes,
    estimatedTokens: Math.max(1, Math.ceil(bytes / 3.2)),
    triggerMode,
    isGlobalCore
  };
}

function readPluginsEnabledMap() {
  const cfg = readJsonSafe(path.join(HOME, '.gemini', 'config', 'config.json'), {});
  const out = {};
  if (cfg && cfg.plugins && typeof cfg.plugins === 'object') {
    for (const [k, v] of Object.entries(cfg.plugins)) {
      if (v && typeof v.enabled === 'boolean') out[k] = v.enabled;
    }
  }
  return out;
}

function readPluginMeta(pDir) {
  for (const rel of ['plugin.json', '.antigravity-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const obj = readJsonSafe(path.join(pDir, rel), null);
    if (obj && typeof obj === 'object') return obj;
  }
  return {};
}

function analyzeUsageLogs() {
  let agySessions = 0;
  let codexSessions = 0;
  const hits = new Map();
  const bump = (name, isAgy, mtimeMs) => {
    const cur = hits.get(name) || { agy: 0, codex: 0, lastUsed: 0 };
    if (isAgy) cur.agy++;
    else cur.codex++;
    if (mtimeMs > cur.lastUsed) cur.lastUsed = mtimeMs;
    hits.set(name, cur);
  };

  const agyRe = /\/(?:\.agents\/skills|\.gemini\/config\/skills|\.gemini\/config\/plugins\/[^\/\s"'\\]+\/skills)\/([^\/\s"'\\]+)\/SKILL\.md/g;
  for (const brainDir of [
    path.join(HOME, '.gemini', 'antigravity-insiders', 'brain'),
    path.join(HOME, '.gemini', 'antigravity', 'brain')
  ]) {
    if (!fs.existsSync(brainDir)) continue;
    let convs = [];
    try {
      convs = fs.readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const conv of convs) {
      const logPath = path.join(brainDir, conv, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(logPath)) continue;
      let st;
      let text;
      try {
        st = fs.statSync(logPath);
        text = fs.readFileSync(logPath, 'utf8');
      } catch {
        continue;
      }
      agySessions++;
      const seen = new Set();
      for (const line of text.split('\n')) {
        if (!line.includes('SKILL.md') || line.includes('"role":"system"')) continue;
        agyRe.lastIndex = 0;
        let m;
        while ((m = agyRe.exec(line)) !== null) seen.add(m[1]);
      }
      for (const sk of seen) bump(sk, true, st.mtimeMs);
    }
  }

  const codexRe = /\/(?:\.agents|\.codex)\/skills\/([^\/\s"'\\]+)\/SKILL\.md/g;
  const walkCodex = (dir, depth = 0) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        walkCodex(fp, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        let st;
        let text;
        try {
          st = fs.statSync(fp);
          text = fs.readFileSync(fp, 'utf8');
        } catch {
          continue;
        }
        codexSessions++;
        const seen = new Set();
        for (const line of text.split('\n')) {
          if (!line.includes('SKILL.md')) continue;
          if (!line.includes('"type":"function_call"') && !line.includes('"type":"custom_tool_call"') && !line.includes('"role":"assistant"')) {
            continue;
          }
          if (line.includes('Available skills') || line.includes('## Skills')) continue;
          codexRe.lastIndex = 0;
          let m;
          while ((m = codexRe.exec(line)) !== null) seen.add(m[1]);
        }
        for (const sk of seen) bump(sk, false, st.mtimeMs);
      }
    }
  };
  walkCodex(path.join(HOME, '.codex', 'sessions'));

  return { agySessions, codexSessions, hits };
}

function isManagedSkillPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const allowedParents = [
    path.join(HOME, '.agents', 'skills'),
    path.join(HOME, '.agents', 'skills-archive'),
    path.join(HOME, '.gemini', 'config', 'skills'),
    path.join(HOME, '.gemini', 'config', 'skills-archive'),
    path.join(HOME, '.codex', 'skills'),
    path.join(HOME, '.codex', 'skills-archive'),
    path.join(HOME, '.claude', 'skills'),
    path.join(HOME, '.claude', 'skills-archive'),
    path.join(HOME, '.cursor', 'skills'),
    path.join(HOME, '.cursor', 'skills-archive')
  ];
  return allowedParents.some((parent) => path.dirname(resolved) === parent);
}

function isManagedRulePath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const allowedParents = [
    path.join(HOME, '.gemini', 'config', 'rules'),
    path.join(HOME, '.agents', 'rules')
  ];
  return allowedParents.some((parent) => path.dirname(resolved) === parent);
}

function moveSafely(srcPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(srcPath);
  let dst = path.join(destDir, base);
  if (fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false })) {
    dst = path.join(destDir, `${base}-${Date.now()}`);
  }
  fs.renameSync(srcPath, dst);
  return dst;
}

function removeEntrySafely(folderPath) {
  const lst = fs.lstatSync(folderPath, { throwIfNoEntry: false });
  if (!lst) return { removed: false };
  if (lst.isSymbolicLink()) {
    fs.unlinkSync(folderPath);
    return { removed: true, wasSymlink: true };
  }
  if (process.platform === 'darwin') {
    const trashDir = path.join(HOME, '.Trash');
    moveSafely(folderPath, trashDir);
    return { removed: true, wasSymlink: false, trashed: true };
  }
  fs.rmSync(folderPath, { recursive: true, force: true });
  return { removed: true, wasSymlink: false };
}

function openExternalPath(targetPath, reveal = false) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!fs.existsSync(resolved) && !fs.lstatSync(resolved, { throwIfNoEntry: false })) {
    throw new Error('目标路径不存在');
  }
  if (process.platform === 'darwin') {
    spawn('open', reveal ? ['-R', resolved] : [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    if (reveal) {
      spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', '', resolved], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } else {
    const dir = reveal ? path.dirname(resolved) : resolved;
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }
}

export function createSkillDexEngine() {
  let usageCache = null;
  let usageCachedAt = 0;

  function getUsage(force = false) {
    if (!force && usageCache && Date.now() - usageCachedAt < USAGE_CACHE_TTL_MS) {
      return usageCache;
    }
    usageCache = analyzeUsageLogs();
    usageCachedAt = Date.now();
    return usageCache;
  }

  function buildSnapshot({ reanalyzeLogs = false } = {}) {
    const pluginsMap = readPluginsEnabledMap();
    const demoCache = readJsonSafe(DEMO_CACHE_PATH, {}) || {};

    const activeSkills = [
      ...scanSkillDir(path.join(HOME, '.agents', 'skills'), 'Shared'),
      ...scanSkillDir(path.join(HOME, '.gemini', 'config', 'skills'), 'Antigravity'),
      ...scanSkillDir(path.join(HOME, '.codex', 'skills'), 'Codex'),
      ...scanSkillDir(path.join(HOME, '.claude', 'skills'), 'Claude'),
      ...scanSkillDir(path.join(HOME, '.cursor', 'skills'), 'Cursor')
    ];

    const archivedSkills = [
      ...scanSkillDir(path.join(HOME, '.agents', 'skills-archive'), 'Shared', { isArchived: true }),
      ...scanSkillDir(path.join(HOME, '.gemini', 'config', 'skills-archive'), 'Antigravity', { isArchived: true }),
      ...scanSkillDir(path.join(HOME, '.codex', 'skills-archive'), 'Codex', { isArchived: true }),
      ...scanSkillDir(path.join(HOME, '.claude', 'skills-archive'), 'Claude', { isArchived: true }),
      ...scanSkillDir(path.join(HOME, '.cursor', 'skills-archive'), 'Cursor', { isArchived: true })
    ];

    const rules = [];
    const plugins = [];

    const pluginsDir = path.join(HOME, '.gemini', 'config', 'plugins');
    if (fs.existsSync(pluginsDir)) {
      for (const dirName of fs.readdirSync(pluginsDir).sort()) {
        const pDir = path.join(pluginsDir, dirName);
        try {
          if (!fs.statSync(pDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const meta = readPluginMeta(pDir);
        const defaultDisabled = Boolean(meta.disabled);
        const enabled = typeof pluginsMap[dirName] === 'boolean' ? pluginsMap[dirName] : !defaultDisabled;
        const displayName = String(meta.displayName || meta.name || dirName);
        const description = String(meta.description || '');

        const pSkills = scanSkillDir(path.join(pDir, 'skills'), 'AGY Plugin', {
          pluginName: dirName,
          isPluginEnabled: enabled
        });
        if (enabled) activeSkills.push(...pSkills);

        let ruleBytes = 0;
        const rDir = path.join(pDir, 'rules');
        if (fs.existsSync(rDir)) {
          for (const rf of fs.readdirSync(rDir).sort()) {
            if (!rf.endsWith('.md') && !rf.endsWith('.mdc')) continue;
            const entry = inspectRuleFile(path.join(rDir, rf), {
              title: `${displayName} · ${rf}`,
              scopeLabel: `插件 ${dirName}`,
              pluginName: dirName,
              isPluginEnabled: enabled,
              isGlobalCore: false
            });
            if (entry) {
              ruleBytes += entry.bytes;
              rules.push(entry);
            }
          }
        }

        const mcp = readJsonSafe(path.join(pDir, 'mcp_config.json'), null);
        const mcpServers = mcp?.mcpServers && typeof mcp.mcpServers === 'object' ? Object.keys(mcp.mcpServers).sort() : [];
        plugins.push({
          id: dirName,
          dirName,
          displayName,
          description,
          enabled,
          skillCount: pSkills.length,
          ruleBytes,
          mcpServers,
          hasHooks: fs.existsSync(path.join(pDir, 'hooks.json')),
          dirPath: pDir
        });
      }
    }

    for (const [fp, title] of [
      [path.join(HOME, '.gemini', 'config', 'GEMINI.md'), '全局规范 (~/.gemini/config/GEMINI.md)'],
      [path.join(HOME, '.gemini', 'GEMINI.md'), '全局规范 (~/.gemini/GEMINI.md)']
    ]) {
      const r = inspectRuleFile(fp, { title, scopeLabel: '全局核心', isGlobalCore: true });
      if (r) rules.push(r);
    }
    for (const [dir, scopeLabel] of [
      [path.join(HOME, '.gemini', 'config', 'rules'), 'Antigravity Rules'],
      [path.join(HOME, '.agents', 'rules'), '共享 Rules']
    ]) {
      if (!fs.existsSync(dir)) continue;
      for (const rf of fs.readdirSync(dir).sort()) {
        if (!rf.endsWith('.md') && !rf.endsWith('.mdc')) continue;
        const r = inspectRuleFile(path.join(dir, rf), { title: rf, scopeLabel });
        if (r) rules.push(r);
      }
    }

    const usage = getUsage(reanalyzeLogs);
    const applyHits = (list) => {
      for (const s of list) {
        const hit = usage.hits.get(s.dirName) || usage.hits.get(s.name);
        if (hit) {
          s.agyUseCount = hit.agy;
          s.codexUseCount = hit.codex;
          s.totalUseCount = hit.agy + hit.codex;
          s.lastUsedAt = hit.lastUsed || null;
        }
        const cached = demoCache[s.dirName];
        if (cached && typeof cached === 'object') {
          s.cachedDemo = {
            headline: String(cached.headline || ''),
            prompts: Array.isArray(cached.prompts) ? cached.prompts.slice(0, 3) : [],
            demoPreview: String(cached.demoPreview || ''),
            isAIGenerated: Boolean(cached.isAIGenerated)
          };
        }
      }
    };
    applyHits(activeSkills);
    applyHits(archivedSkills);

    // 重复副本检测（Antigravity 可见范围内同名冲突）
    const byName = new Map();
    for (const s of activeSkills) {
      if (s.source !== 'Shared' && s.source !== 'Antigravity' && s.source !== 'AGY Plugin') continue;
      const key = s.dirName.toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(s);
    }
    const duplicates = [];
    for (const [key, entries] of byName.entries()) {
      if (entries.length <= 1) continue;
      const sameHash = new Set(entries.map((e) => e.contentHash)).size === 1;
      duplicates.push({
        id: key,
        name: entries[0].dirName,
        reason: sameHash ? '内容完全一致的重复副本' : '同名技能在不同目录冲突',
        entries: entries.map((e) => ({
          id: e.id,
          source: e.source,
          folderPath: e.folderPath,
          canArchive: e.canArchive,
          isSymlink: e.isSymlink
        }))
      });
    }

    rules.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
    plugins.sort((a, b) => b.ruleBytes - a.ruleBytes || b.skillCount - a.skillCount);

    const alwaysOnRuleTokens = rules
      .filter((r) => r.isPluginEnabled && (r.triggerMode === 'always_on' || r.triggerMode === 'fixed_always_on'))
      .reduce((acc, r) => acc + r.estimatedTokens, 0);
    const agyMountedCount = activeSkills.filter(
      (s) => s.source === 'Shared' || s.source === 'Antigravity' || s.source === 'AGY Plugin'
    ).length;

    return {
      ok: true,
      homeDir: HOME,
      agySessions: usage.agySessions,
      codexSessions: usage.codexSessions,
      alwaysOnRuleTokens,
      agyMountedCount,
      recommendedCeiling: 160,
      activeSkills,
      archivedSkills,
      rules,
      plugins,
      duplicates
    };
  }

  function setPluginEnabled(dirName, enabled) {
    const clean = String(dirName || '').trim();
    if (!clean || clean.includes('/') || clean.includes('..')) {
      throw new Error('无效的插件名');
    }
    const cfgPath = path.join(HOME, '.gemini', 'config', 'config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const cfg = readJsonSafe(cfgPath, {}) || {};
    if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
    cfg.plugins[clean] = Object.assign({}, cfg.plugins[clean] || {}, { enabled: Boolean(enabled) });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { ok: true, dirName: clean, enabled: Boolean(enabled) };
  }

  function toggleRuleTrigger(filePath) {
    if (!isManagedRulePath(filePath)) {
      throw new Error('仅支持切换 rules/ 目录下的普通规则文件');
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const isModelDecision = raw.startsWith('---') && /trigger:\s*model_decision/i.test(raw);
    const targetMode = isModelDecision ? 'always_on' : 'model_decision';
    let next;
    if (raw.startsWith('---')) {
      if (/trigger:\s*[a-zA-Z_]+/.test(raw)) {
        next = raw.replace(/trigger:\s*[a-zA-Z_]+/, `trigger: ${targetMode}`);
      } else {
        next = raw.replace(/^---\r?\n/, `---\ntrigger: ${targetMode}\n`);
      }
    } else {
      next = `---\ntrigger: ${targetMode}\ndescription: 当任务与 ${path.basename(filePath)} 相关时按需加载\n---\n\n${raw}`;
    }
    fs.writeFileSync(filePath, next, 'utf8');
    return { ok: true, filePath, triggerMode: targetMode };
  }

  function readSkillDetail(skillMdPath) {
    const resolved = path.resolve(String(skillMdPath || ''));
    if (path.basename(resolved) !== 'SKILL.md' || !fs.existsSync(resolved)) {
      throw new Error('未找到 SKILL.md');
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const folder = path.dirname(resolved);
    const { images } = discoverBundledAssets(folder);
    const previewDataUrls = [];
    for (const imgPath of images.slice(0, 3)) {
      try {
        const st = fs.statSync(imgPath);
        if (st.size > 2 * 1024 * 1024) continue;
        const ext = path.extname(imgPath).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const b64 = fs.readFileSync(imgPath).toString('base64');
        previewDataUrls.push({
          name: path.basename(imgPath),
          path: imgPath,
          dataUrl: `data:image/${mime};base64,${b64}`
        });
      } catch {}
    }
    return { ok: true, content: content.slice(0, 48000), previewImages: previewDataUrls };
  }

  async function handleRequest(req = {}) {
    const action = String(req?.action || '').trim();
    try {
      if (action === 'snapshot') {
        return buildSnapshot({ reanalyzeLogs: Boolean(req.reanalyzeLogs) });
      }
      if (action === 'readSkill') {
        return readSkillDetail(req.skillMdPath);
      }
      if (action === 'archive') {
        const fp = path.resolve(String(req.folderPath || ''));
        if (!isManagedSkillPath(fp) || path.basename(path.dirname(fp)) !== 'skills') {
          throw new Error('不支持归档该路径');
        }
        const archiveDir = path.join(path.dirname(path.dirname(fp)), 'skills-archive');
        moveSafely(fp, archiveDir);
        return { ok: true, snapshot: buildSnapshot() };
      }
      if (action === 'archiveMany') {
        const list = Array.isArray(req.folderPaths) ? req.folderPaths : [];
        let moved = 0;
        for (const rawPath of list) {
          const fp = path.resolve(String(rawPath || ''));
          if (!isManagedSkillPath(fp) || path.basename(path.dirname(fp)) !== 'skills') continue;
          if (!fs.lstatSync(fp, { throwIfNoEntry: false })) continue;
          const archiveDir = path.join(path.dirname(path.dirname(fp)), 'skills-archive');
          moveSafely(fp, archiveDir);
          moved++;
        }
        return { ok: true, moved, snapshot: buildSnapshot() };
      }
      if (action === 'restore') {
        const fp = path.resolve(String(req.folderPath || ''));
        if (!isManagedSkillPath(fp) || path.basename(path.dirname(fp)) !== 'skills-archive') {
          throw new Error('不支持恢复该路径');
        }
        const activeDir = path.join(path.dirname(path.dirname(fp)), 'skills');
        moveSafely(fp, activeDir);
        return { ok: true, snapshot: buildSnapshot() };
      }
      if (action === 'remove') {
        const fp = path.resolve(String(req.folderPath || ''));
        if (!isManagedSkillPath(fp)) throw new Error('不允许移除非受管路径');
        const res = removeEntrySafely(fp);
        return { ok: true, ...res, snapshot: buildSnapshot() };
      }
      if (action === 'resolveDuplicate') {
        const snap = buildSnapshot();
        const group = snap.duplicates.find((g) => g.id === req.groupId);
        if (!group) return { ok: true, removed: 0, snapshot: snap };
        const prio = (src) => (src === 'AGY Plugin' ? 30 : src === 'Shared' ? 20 : 10);
        const sorted = [...group.entries].sort((a, b) => prio(b.source) - prio(a.source));
        let removed = 0;
        for (const item of sorted.slice(1)) {
          if (item.canArchive && isManagedSkillPath(item.folderPath)) {
            removeEntrySafely(item.folderPath);
            removed++;
          }
        }
        return { ok: true, removed, snapshot: buildSnapshot() };
      }
      if (action === 'setPlugin') {
        setPluginEnabled(req.dirName, req.enabled);
        return { ok: true, snapshot: buildSnapshot() };
      }
      if (action === 'toggleRule') {
        toggleRuleTrigger(req.filePath);
        return { ok: true, snapshot: buildSnapshot() };
      }
      if (action === 'reveal') {
        openExternalPath(req.targetPath, true);
        return { ok: true };
      }
      if (action === 'open') {
        openExternalPath(req.targetPath, false);
        return { ok: true };
      }
      return { ok: false, error: `未知操作: ${action}` };
    } catch (err) {
      return { ok: false, error: err?.message || String(err || '操作失败') };
    }
  }

  return { handleRequest };
}
