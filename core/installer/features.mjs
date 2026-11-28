/**
 * core/installer/features.mjs — Selective Feature Profiles & Sparse Checkout Paths
 */

export const BASE_SPARSE_PATHS = Object.freeze([
  '/install.mjs',
  '/package.json',
  '/distribution/README.md',
  '/SKILL.md',
  '/LICENSE',
  '/user/config.json',
  '/user/custom.css',
  '/user/custom.js',
  '/core/daemon.mjs',
  '/core/shared.mjs',
  '/core/manifest.json',
  '/core/installer',
  '/core/daemon/paths.mjs',
  '/core/daemon/cdp-bridge.mjs',
  '/core/daemon/cdp-relaunch.mjs',
  '/core/runtime/00-head.js',
  '/core/runtime/90-tail.js'
]);

export const FEATURE_GROUPS = Object.freeze({
  theme: {
    id: 'theme',
    label: 'Linear 极简克制主题 (linear-light / linear-dark)',
    configKeys: ['theme'],
    sparsePaths: [
      '/core/styles/00-tokens.css',
      '/core/styles/10-sidebar.css',
      '/core/styles/15-topbar.css',
      '/core/styles/20-chat.css',
      '/core/styles/30-composer.css',
      '/core/styles/40-modals-home.css',
      '/core/runtime/20-theme-sync.js',
      '/core/runtime/52-t3-sidebar.js'
    ],
    coreRelPaths: [
      'styles/00-tokens.css',
      'styles/10-sidebar.css',
      'styles/15-topbar.css',
      'styles/20-chat.css',
      'styles/30-composer.css',
      'styles/40-modals-home.css',
      'runtime/20-theme-sync.js',
      'runtime/52-t3-sidebar.js'
    ],
    aliases: ['theme', 'linear', 'style', 'styles', 'css', 'dark', 'light']
  },
  i18n: {
    id: 'i18n',
    label: '中文界面本地化 (900+ 词条)',
    configKeys: ['i18n'],
    sparsePaths: [
      '/core/i18n.json',
      '/core/runtime/60-i18n-engine.js',
      '/user/i18n.override.json'
    ],
    coreRelPaths: [
      'i18n.json',
      'runtime/60-i18n-engine.js'
    ],
    aliases: ['i18n', 'zh', 'cn', 'chinese', 'locale', 'l10n', 'translate']
  },
  metrics: {
    id: 'metrics',
    label: '实时会话状态指示、一/二级统计面板与每轮尾部统计',
    configKeys: ['metrics'],
    sparsePaths: [
      '/core/styles/30-telemetry.css',
      '/core/runtime/30-antigravity-probe.js',
      '/core/runtime/40-status-machine.js',
      '/core/runtime/50-telemetry-ui.js',
      '/core/daemon/ls-log.mjs',
      '/core/daemon/protobuf.mjs',
      '/core/daemon/sqlite-metrics.mjs',
      '/core/daemon/telemetry-renderer.mjs'
    ],
    coreRelPaths: [
      'styles/30-telemetry.css',
      'runtime/30-antigravity-probe.js',
      'runtime/40-status-machine.js',
      'runtime/50-telemetry-ui.js',
      'daemon/ls-log.mjs',
      'daemon/protobuf.mjs',
      'daemon/sqlite-metrics.mjs',
      'daemon/telemetry-renderer.mjs'
    ],
    aliases: ['metrics', 'status', 'telemetry', 'stats', 'panel', 'metricscapsule']
  },
  fixes: {
    id: 'fixes',
    label: '设置死锁修复、侧栏项目隐藏、SkillDex 图鉴、Worktree 清理、原生一键切号、拖拽打开文件夹、配额恢复续跑与缩放快捷键',
    configKeys: ['deadlockHealer', 'zoomShortcuts', 'projectHider', 'skillDex', 'worktreeCleaner', 'accountSwitcher', 'folderDrop', 'quotaResume'],
    sparsePaths: [
      '/core/runtime/10-guards.js',
      '/core/runtime/55-project-hider.js',
      '/core/runtime/58-skilldex.js',
      '/core/styles/45-skilldex.css',
      '/core/daemon/skilldex.mjs',
      '/core/runtime/59-worktree-cleaner.js',
      '/core/styles/46-worktree-cleaner.css',
      '/core/daemon/worktree-cleaner.mjs',
      '/core/runtime/62-account-switcher.js',
      '/core/runtime/80-folder-drop.js',
      '/core/runtime/85-quota-resume.js'
    ],
    coreRelPaths: [
      'runtime/10-guards.js',
      'runtime/55-project-hider.js',
      'runtime/58-skilldex.js',
      'styles/45-skilldex.css',
      'daemon/skilldex.mjs',
      'runtime/59-worktree-cleaner.js',
      'styles/46-worktree-cleaner.css',
      'daemon/worktree-cleaner.mjs',
      'runtime/62-account-switcher.js',
      'runtime/80-folder-drop.js',
      'runtime/85-quota-resume.js'
    ],
    aliases: ['fixes', 'fix', 'guards', 'deadlock', 'deadlockhealer', 'zoom', 'zoomshortcuts', 'hide', 'project', 'skilldex', 'worktree', 'worktreecleaner', 'account', 'switch', 'drop', 'resume']
  }
});

const ALIAS_TO_FEATURE = (() => {
  const map = new Map();
  for (const [id, meta] of Object.entries(FEATURE_GROUPS)) {
    map.set(id, id);
    for (const alias of meta.aliases) {
      map.set(alias.toLowerCase(), id);
    }
  }
  return map;
})();

function parseFeatureTokenList(raw) {
  const tokens = String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Empty feature list. Expected one or more of: theme, i18n, metrics, fixes, all');
  }
  const ids = [];
  for (const tok of tokens) {
    if (tok === 'all' || tok === 'full') {
      return Object.keys(FEATURE_GROUPS);
    }
    const resolved = ALIAS_TO_FEATURE.get(tok);
    if (!resolved) {
      throw new Error(`Unknown feature "${tok}". Valid options: theme, i18n, metrics, fixes, all`);
    }
    if (!ids.includes(resolved)) ids.push(resolved);
  }
  return ids;
}

export function parseFeatureSelection({ onlyArg = null, withoutArg = null } = {}) {
  const hasOnly = onlyArg !== null && onlyArg !== undefined && String(onlyArg).trim() !== '';
  const hasWithout = withoutArg !== null && withoutArg !== undefined && String(withoutArg).trim() !== '';
  const selected = {
    theme: true,
    i18n: true,
    metrics: true,
    fixes: true
  };

  if (hasOnly) {
    for (const k of Object.keys(selected)) selected[k] = false;
    for (const id of parseFeatureTokenList(onlyArg)) {
      selected[id] = true;
    }
  }
  if (hasWithout) {
    for (const id of parseFeatureTokenList(withoutArg)) {
      selected[id] = false;
    }
  }

  const modulesPatch = {};
  for (const [id, meta] of Object.entries(FEATURE_GROUPS)) {
    const enabled = Boolean(selected[id]);
    for (const cfgKey of meta.configKeys) {
      modulesPatch[cfgKey] = enabled;
    }
  }

  return {
    explicit: hasOnly || hasWithout,
    selected,
    modulesPatch
  };
}

export function getSparseCheckoutPaths(selected = { theme: true, i18n: true, metrics: true, fixes: true }) {
  const out = [...BASE_SPARSE_PATHS];
  for (const [id, meta] of Object.entries(FEATURE_GROUPS)) {
    if (selected[id]) {
      for (const p of meta.sparsePaths) {
        if (!out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

export function getExcludedCoreRelPaths(selected) {
  const excluded = [];
  for (const [id, meta] of Object.entries(FEATURE_GROUPS)) {
    if (!selected[id]) {
      excluded.push(...meta.coreRelPaths);
    }
  }
  return excluded;
}
