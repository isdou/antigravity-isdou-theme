/**
 * core/daemon/worktree-cleaner.mjs
 * Worktree Cleaner 独立原生引擎（纯 Node.js 零外部依赖）
 * - 扫描 Codex / Claude Code / Cursor / Trae / Git 遗留 Worktree
 * - 精准识别状态（可安全清理 / 有改动 / 未推送 / 幽灵记录）、占盘与可瘦身构建缓存、珍贵 .env 文件
 * - 支持查看 Diff、缓存瘦身、一键推送、备份珍贵文件、安全移入系统废纸篓、Prune 幽灵记录、Finder 定位
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CACHE_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.build',
  'DerivedData',
  '.codex-derived-data',
  'target',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  'Pods'
]);

const PRECIOUS_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^secrets?\.json$/i,
  /^local\.properties$/i,
  /\.sqlite3?$/i,
  /\.db$/i,
  /^service[-_]?account.*\.json$/i
];

function isPreciousName(name) {
  if (!name || name === '.env.example' || name === '.env.sample' || name === '.env.template') return false;
  return PRECIOUS_PATTERNS.some((re) => re.test(name));
}

function getAgentRoots() {
  const home = os.homedir();
  return [
    { source: 'Codex', dir: path.join(home, '.codex', 'worktrees') },
    { source: 'Claude', dir: path.join(home, '.claude', 'worktrees') },
    { source: 'Cursor', dir: path.join(home, '.cursor', 'worktrees') },
    { source: 'Trae', dir: path.join(home, '.trae-cn', 'worktrees') },
    { source: 'Trae', dir: path.join(home, '.trae', 'worktrees') }
  ];
}

function detectSource(wtPath) {
  const norm = wtPath.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/.codex/worktrees')) return 'Codex';
  if (norm.includes('/.claude/worktrees')) return 'Claude';
  if (norm.includes('/.cursor/worktrees')) return 'Cursor';
  if (norm.includes('/.trae-cn/worktrees') || norm.includes('/.trae/worktrees')) return 'Trae';
  if (norm.includes('/.gemini/') || norm.includes('/antigravity')) return 'Antigravity';
  return 'Git';
}

async function runGit(args, cwd, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024
    });
    return { ok: true, stdout: String(stdout || '') };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || '')
    };
  }
}

function safeStat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// 递归计算目录体积（忽略符号链接，防止死循环）
function calcDirBytes(dirPath, maxEntries = 25000) {
  let bytes = 0;
  let seen = 0;
  const stack = [dirPath];
  while (stack.length > 0 && seen < maxEntries) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      seen++;
      if (seen >= maxEntries) break;
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch {}
      }
    }
  }
  return bytes;
}

// 扫描 worktree 内的可再生缓存目录与珍贵未追踪文件（浅扫描 3 层保持飞快）
function inspectWorktreeFs(wtPath) {
  const caches = [];
  const precious = [];
  let totalBytes = 0;

  if (!fs.existsSync(wtPath)) {
    return { totalBytes: 0, cacheBytes: 0, caches: [], precious: [] };
  }

  // 递归扫描缓存与珍贵文件
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(wtPath, full);
      if (ent.isDirectory()) {
        if (CACHE_DIR_NAMES.has(ent.name)) {
          const sz = calcDirBytes(full);
          totalBytes += sz;
          caches.push({ name: ent.name, relPath: rel, fullPath: full, bytes: sz });
          continue; // 不再进入缓存内部找珍贵文件
        }
        if (depth < 3) {
          walk(full, depth + 1);
        } else {
          totalBytes += calcDirBytes(full, 6000);
        }
      } else if (ent.isFile()) {
        let sz = 0;
        try {
          sz = fs.statSync(full).size;
        } catch {}
        totalBytes += sz;
        if (depth <= 2 && isPreciousName(ent.name)) {
          precious.push({ name: ent.name, relPath: rel, fullPath: full, bytes: sz });
        }
      }
    }
  };

  walk(wtPath, 0);
  const cacheBytes = caches.reduce((sum, c) => sum + c.bytes, 0);
  caches.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, cacheBytes, caches, precious };
}

// 从各 AI 工具 worktree 目录发现所有关联的主 Git 仓库
async function discoverMainRepos() {
  const repoSet = new Set();
  const candidateDirs = [];

  for (const { dir } of getAgentRoots()) {
    if (!fs.existsSync(dir)) continue;
    let l1;
    try {
      l1 = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e1 of l1) {
      if (!e1.isDirectory() || e1.name.startsWith('.')) continue;
      const p1 = path.join(dir, e1.name);
      if (fs.existsSync(path.join(p1, '.git'))) {
        candidateDirs.push(p1);
      } else {
        // Codex 结构常为 ~/.codex/worktrees/<hash>/<repo-name>
        let l2;
        try {
          l2 = fs.readdirSync(p1, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e2 of l2) {
          if (!e2.isDirectory() || e2.name.startsWith('.')) continue;
          const p2 = path.join(p1, e2.name);
          if (fs.existsSync(path.join(p2, '.git'))) {
            candidateDirs.push(p2);
          }
        }
      }
    }
  }

  // 同时扫描常见桌面开发根目录下的 1 级 git 仓库（发现非 agent 目录下的手动 worktree）
  const extraScanRoots = [
    path.join(os.homedir(), 'Desktop', 'Gemini'),
    path.join(os.homedir(), 'Projects'),
    path.join(os.homedir(), 'Workspace')
  ];
  for (const root of extraScanRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const p = path.join(root, ent.name);
        if (fs.existsSync(path.join(p, '.git', 'worktrees'))) {
          repoSet.add(fs.realpathSync(p));
        }
      }
    } catch {}
  }

  for (const cand of candidateDirs) {
    const res = await runGit(['rev-parse', '--git-common-dir'], cand, 4000);
    if (!res.ok) continue;
    const commonRaw = res.stdout.trim();
    if (!commonRaw) continue;
    const commonAbs = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(cand, commonRaw);
    const mainRoot = path.basename(commonAbs) === '.git' ? path.dirname(commonAbs) : commonAbs;
    if (fs.existsSync(mainRoot)) {
      try {
        repoSet.add(fs.realpathSync(mainRoot));
      } catch {
        repoSet.add(mainRoot);
      }
    }
  }

  return Array.from(repoSet);
}

function parsePorcelainWorktrees(stdout) {
  const blocks = String(stdout || '')
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const item = { path: '', head: '', branch: '', detached: false, prunable: false, bare: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) item.path = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) item.head = line.slice(5).trim();
      else if (line.startsWith('branch ')) item.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') item.detached = true;
      else if (line === 'bare') item.bare = true;
      else if (line.startsWith('prunable')) item.prunable = true;
    }
    if (item.path) out.push(item);
  }
  return out;
}

// 将文件或目录安全移入系统废纸篓（绝不粗暴 rm -rf！）
async function moveToTrash(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return { ok: true, method: 'absent' };
  const abs = path.resolve(targetPath);
  if (abs === '/' || abs === os.homedir()) {
    throw new Error('Refused to trash protected root directory');
  }
  if (process.platform === 'darwin') {
    try {
      await execFileAsync(
        'osascript',
        ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', abs],
        { timeout: 15000 }
      );
      if (!fs.existsSync(abs)) return { ok: true, method: 'finder-trash' };
    } catch {}
    // 兜底：直接原子移动到 ~/.Trash
    const trashDir = path.join(os.homedir(), '.Trash');
    fs.mkdirSync(trashDir, { recursive: true });
    let dest = path.join(trashDir, path.basename(abs));
    if (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${path.basename(abs)}-${Date.now()}`);
    }
    fs.renameSync(abs, dest);
    return { ok: true, method: 'trash-move', dest };
  }
  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${abs.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
      ],
      { timeout: 15000 }
    );
    return { ok: true, method: 'recycle-bin' };
  }
  const xdgTrash = path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
  fs.mkdirSync(xdgTrash, { recursive: true });
  let dest = path.join(xdgTrash, `${path.basename(abs)}-${Date.now()}`);
  fs.renameSync(abs, dest);
  return { ok: true, method: 'xdg-trash', dest };
}

export function createWorktreeCleanerEngine() {
  let lastScan = null;

  async function scanAll() {
    const mainRepos = await discoverMainRepos();
    const items = [];
    const seenPaths = new Set();

    for (const mainRepo of mainRepos) {
      const repoName = path.basename(mainRepo);
      const listRes = await runGit(['worktree', 'list', '--porcelain'], mainRepo, 6000);
      if (!listRes.ok) continue;
      const entries = parsePorcelainWorktrees(listRes.stdout);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        // 第一条通常是主工作树，跳过主工作树，只展示衍生 worktrees
        const isMain = i === 0 || path.resolve(entry.path) === path.resolve(mainRepo);
        if (isMain || entry.bare) continue;

        const normKey = path.resolve(entry.path);
        if (seenPaths.has(normKey)) continue;
        seenPaths.add(normKey);

        const exists = fs.existsSync(entry.path);
        const source = detectSource(entry.path);
        const stat = exists ? safeStat(entry.path) : null;
        const mtimeMs = stat ? Math.round(stat.mtimeMs) : 0;

        let dirtyCount = 0;
        let untrackedCount = 0;
        let unpushedCount = 0;
        let lastCommitMsg = '';
        let fsInfo = { totalBytes: 0, cacheBytes: 0, caches: [], precious: [] };

        if (exists) {
          fsInfo = inspectWorktreeFs(entry.path);
          const stRes = await runGit(['status', '--porcelain'], entry.path, 5000);
          if (stRes.ok && stRes.stdout.trim()) {
            const lines = stRes.stdout.trim().split(/\r?\n/).filter(Boolean);
            for (const l of lines) {
              if (l.startsWith('??')) untrackedCount++;
              else dirtyCount++;
            }
          }
          // 检测是否有未推送 commit
          const upRes = await runGit(['rev-list', '--count', '@{u}..HEAD'], entry.path, 4000);
          if (upRes.ok) {
            unpushedCount = Number.parseInt(upRes.stdout.trim(), 10) || 0;
          } else if (entry.branch) {
            // 若未设 upstream，对比 origin/<default> 或 origin/main
            const fallbackRes = await runGit(['rev-list', '--count', `HEAD`, '--not', '--remotes'], entry.path, 4000);
            if (fallbackRes.ok) {
              unpushedCount = Number.parseInt(fallbackRes.stdout.trim(), 10) || 0;
            }
          }
          const logRes = await runGit(['log', '-1', '--pretty=%s'], entry.path, 3500);
          if (logRes.ok) lastCommitMsg = logRes.stdout.trim();
        }

        let status = 'safe';
        if (!exists || entry.prunable) status = 'missing';
        else if (dirtyCount > 0 || untrackedCount > 0) status = 'dirty';
        else if (unpushedCount > 0) status = 'unpushed';

        items.push({
          id: normKey,
          path: entry.path,
          folderName: path.basename(entry.path),
          mainRepo,
          repoName,
          source,
          branch: entry.branch || (entry.detached ? `detached@${entry.head.slice(0, 7)}` : '(unknown)'),
          headShort: entry.head.slice(0, 7),
          detached: entry.detached,
          exists,
          status,
          dirtyCount,
          untrackedCount,
          unpushedCount,
          lastCommitMsg,
          mtimeMs,
          totalBytes: fsInfo.totalBytes,
          cacheBytes: fsInfo.cacheBytes,
          caches: fsInfo.caches,
          precious: fsInfo.precious
        });
      }
    }

    // 排序：优先把占用体积大 / 幽灵记录排在前面方便一眼看到
    items.sort((a, b) => {
      if (a.status === 'missing' && b.status !== 'missing') return -1;
      if (b.status === 'missing' && a.status !== 'missing') return 1;
      return b.totalBytes - a.totalBytes || b.mtimeMs - a.mtimeMs;
    });

    const summary = {
      totalCount: items.length,
      safeCount: items.filter((x) => x.status === 'safe').length,
      dirtyCount: items.filter((x) => x.status === 'dirty').length,
      unpushedCount: items.filter((x) => x.status === 'unpushed').length,
      missingCount: items.filter((x) => x.status === 'missing').length,
      totalBytes: items.reduce((s, x) => s + x.totalBytes, 0),
      cacheBytes: items.reduce((s, x) => s + x.cacheBytes, 0),
      safeBytes: items.filter((x) => x.status === 'safe').reduce((s, x) => s + x.totalBytes, 0),
      repoCount: mainRepos.length
    };

    lastScan = { ok: true, scannedAt: Date.now(), summary, items, mainRepos };
    return lastScan;
  }

  function assertAllowedWorktree(targetPath) {
    if (!targetPath || !lastScan) {
      throw new Error('请先刷新扫描 Worktree 列表');
    }
    const norm = path.resolve(targetPath);
    const match = lastScan.items.find((it) => path.resolve(it.path) === norm);
    if (!match) {
      throw new Error('目标路径不在已扫描的 Worktree 列表中，已拒绝操作');
    }
    return match;
  }

  async function getDiff(targetPath) {
    const item = assertAllowedWorktree(targetPath);
    if (!fs.existsSync(item.path)) {
      return { ok: true, statusLines: [], commits: [], diffText: '(目录已不存在，可直接 Prune 清理幽灵记录)' };
    }
    const [stRes, logRes, diffRes] = await Promise.all([
      runGit(['status', '--short'], item.path, 5000),
      runGit(['log', '-8', '--pretty=%h %ar · %s'], item.path, 5000),
      runGit(['diff', '--stat', '--patch', '--unified=2'], item.path, 6000)
    ]);
    const statusLines = stRes.ok ? stRes.stdout.split(/\r?\n/).filter(Boolean).slice(0, 80) : [];
    const commits = logRes.ok ? logRes.stdout.split(/\r?\n/).filter(Boolean) : [];
    const rawDiff = diffRes.ok ? diffRes.stdout : '';
    const diffLines = rawDiff.split(/\r?\n/);
    const diffText =
      diffLines.length > 220
        ? diffLines.slice(0, 220).join('\n') + `\n\n…（共 ${diffLines.length} 行，已截断预览）`
        : rawDiff || '(工作区无已追踪文件 Diff)';
    return { ok: true, statusLines, commits, diffText };
  }

  async function slimCaches(targetPath) {
    const item = assertAllowedWorktree(targetPath);
    let reclaimed = 0;
    let count = 0;
    for (const c of item.caches || []) {
      if (fs.existsSync(c.fullPath)) {
        await moveToTrash(c.fullPath);
        reclaimed += c.bytes;
        count++;
      }
    }
    const refreshed = await scanAll();
    return { ok: true, count, reclaimedBytes: reclaimed, scan: refreshed };
  }

  async function copyPrecious(targetPath) {
    const item = assertAllowedWorktree(targetPath);
    let copied = 0;
    let skipped = 0;
    for (const p of item.precious || []) {
      if (!fs.existsSync(p.fullPath)) continue;
      const dest = path.join(item.mainRepo, p.relPath);
      if (fs.existsSync(dest)) {
        skipped++;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p.fullPath, dest);
      copied++;
    }
    return { ok: true, copied, skipped };
  }

  async function pushBranch(targetPath) {
    const item = assertAllowedWorktree(targetPath);
    if (!fs.existsSync(item.path)) throw new Error('目录不存在，无法推送');
    if (item.detached || !item.branch) throw new Error('当前处于 Detached HEAD，请先检出分支后再推送');
    const res = await runGit(['push', '-u', 'origin', item.branch], item.path, 30000);
    if (!res.ok) {
      throw new Error(res.stderr.trim() || 'git push 失败');
    }
    const refreshed = await scanAll();
    return { ok: true, branch: item.branch, scan: refreshed };
  }

  async function removeWorktrees(paths = []) {
    const list = Array.isArray(paths) ? paths : [paths];
    let removed = 0;
    let reclaimed = 0;
    const touchedRepos = new Set();

    for (const p of list) {
      const item = assertAllowedWorktree(p);
      touchedRepos.add(item.mainRepo);
      if (fs.existsSync(item.path)) {
        reclaimed += item.totalBytes;
        await moveToTrash(item.path);
      }
      removed++;
    }
    for (const repo of touchedRepos) {
      await runGit(['worktree', 'prune'], repo, 8000);
    }
    const refreshed = await scanAll();
    return { ok: true, removed, reclaimedBytes: reclaimed, scan: refreshed };
  }

  async function pruneAll() {
    const repos = lastScan?.mainRepos || (await discoverMainRepos());
    for (const repo of repos) {
      await runGit(['worktree', 'prune'], repo, 8000);
    }
    const refreshed = await scanAll();
    return { ok: true, prunedRepos: repos.length, scan: refreshed };
  }

  async function revealPath(targetPath) {
    const item = assertAllowedWorktree(targetPath);
    const openTarget = fs.existsSync(item.path) ? item.path : item.mainRepo;
    if (process.platform === 'darwin') {
      await execFileAsync('open', [openTarget], { timeout: 5000 });
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer.exe', [openTarget], { timeout: 5000 }).catch(() => {});
    } else {
      await execFileAsync('xdg-open', [openTarget], { timeout: 5000 }).catch(() => {});
    }
    return { ok: true };
  }

  async function handleRequest(req = {}) {
    const action = String(req?.action || 'scan');
    if (action === 'scan') return await scanAll();
    if (action === 'diff') return await getDiff(req.path);
    if (action === 'slim') return await slimCaches(req.path);
    if (action === 'copyPrecious') return await copyPrecious(req.path);
    if (action === 'push') return await pushBranch(req.path);
    if (action === 'remove') return await removeWorktrees(req.paths || req.path);
    if (action === 'prune') return await pruneAll();
    if (action === 'reveal') return await revealPath(req.path);
    return { ok: false, error: `Unknown Worktree Cleaner action: ${action}` };
  }

  return { handleRequest };
}
