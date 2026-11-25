/**
 * Part 65: Linear Responsive Inline Effort Switcher & Live Quota/Context Meter
 *
 * - Supports every visible `.agy-composer-footer` (Main pane + Side Question pane)
 * - Adapts independent quota and session controls to the measured footer width.
 * - Shares one anchored, non-modal usage dialog between main and side composers.
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.theme !== false) {
    (function initLinearComposerBar() {
      const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];
      const EFFORT_LABELS = {
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '极高'
      };
      const EFFORT_RE =
        /\s*(?:\((low|medium|high|xhigh|extra\s*high|extra|max|ultra|very\s*high)\)|\b(extra\s+high|very\s+high|low|medium|high|xhigh)\b)\s*$/i;

      let disposed = false;
      let syncTimer = null;
      let hoverTimer = null;
      let pinnedOpen = false;
      let popoverEl = null;
      let anchor = null;
      let view = 'quota';
      let frame = 0;
      let lastSnapshot = '';
      const observedFooters = new Set();
      let footerRo = null;

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatCompactModelDisplay(name) {
        return String(name || '')
          .replace(/\s+/g, ' ')
          .replace(/\bGemini\s+(?=\S)/gi, '')
          .trim();
      }

      function formatShortTier(tier) {
        const s = String(tier || '').trim();
        if (!s) return '';
        if (/google\s+ai\s+ultra/i.test(s)) return 'Ultra';
        if (/google\s+ai\s+pro/i.test(s)) return 'Pro';
        if (/google\s+ai\s+plus/i.test(s)) return 'Plus';
        return s.replace(/^Google\s+AI\s+/i, '').trim();
      }

      function normalizeEffortKey(raw) {
        const s = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (
          s === 'extra high' ||
          s === 'extra-high' ||
          s === 'very high' ||
          s === 'extra' ||
          s === 'max' ||
          s === 'ultra' ||
          s === 'xhigh'
        ) {
          return 'xhigh';
        }
        if (s === 'high' || s === 'medium' || s === 'low') return s;
        return '';
      }

      function splitModelFamilyAndEffort(label) {
        const str = String(label || '').replace(/\s+/g, ' ').trim();
        const m = str.match(EFFORT_RE);
        if (!m) return { family: str, effort: '' };
        const effort = normalizeEffortKey(m[1] || m[2]);
        const family = str.slice(0, m.index).trim() || str;
        return { family, effort };
      }

      function readModelFiberController(btn) {
        if (!btn) return null;
        try {
          const fk = Object.keys(btn).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          let cur = fk ? btn[fk] : null;
          for (let i = 0; i < 30 && cur; i++, cur = cur.return) {
            const p = cur.memoizedProps;
            if (
              p &&
              p.selectedModel &&
              Array.isArray(p.modelOptions) &&
              typeof p.setSelectedModel === 'function'
            ) {
              return p;
            }
          }
        } catch {}
        return null;
      }

      function formatCompactTokens(n) {
        const num = Number(n) || 0;
        if (num >= 1000000) return (num / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(num);
      }

      function readQuotaFraction(option) {
        const info = option?.quotaInfo;
        const fraction = [info?.remainingFraction, info?.remaining].find(
          (n) => Number.isFinite(n) && n >= 0 && n <= 1
        );
        if (fraction === undefined) return null;
        const seconds = Number(info.resetTime?.seconds);
        const nanos = Number(info.resetTime?.nanos ?? 0);
        return {
          fraction,
          pct: Math.round(fraction * 100),
          resetSec: Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0,
          nanos: Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9 ? nanos : 0
        };
      }

      function quotaLabel(q) {
        if (!q) return '—';
        if (q.fraction > 0 && q.pct === 0) return '<1%';
        if (q.fraction < 1 && q.pct === 100) return '>99%';
        return q.pct + '%';
      }

      function modelBase(label) {
        const clean = String(label || '').replace(/\s+/g, ' ').trim().replace(/\s*\(thinking\)$/i, '');
        return splitModelFamilyAndEffort(clean).family.replace(/\s*\(thinking\)$/i, '').trim();
      }

      function providerOf(name) {
        if (/^Gemini\b/i.test(name) || /^(?:4\s+(?:Neon|Carbon|Argon|Hydrogen)|3\.8\s+Flash)$/i.test(name)) return 'Gemini';
        if (/^(?:Claude\b|GPT(?:\b|[- ]OSS\b))/i.test(name)) return 'Claude / GPT';
        return '';
      }

      function sameReading(a, b) {
        return Boolean(a.q && b.q && a.q.resetSec && a.q.resetSec === b.q.resetSec &&
          a.q.nanos === b.q.nanos && a.q.fraction === b.q.fraction && a.disabled === b.disabled);
      }

      function readUsageModels(ctrl) {
        const models = new Map();
        const selected = ctrl?.selectedModel;
        const lists = [[selected], ctrl?.modelOptions, ctrl?.userStatus?.cascadeModelConfigData?.clientModelConfigs];
        for (const list of lists) {
          if (!Array.isArray(list)) continue;
          for (const option of list) {
            const label = typeof option?.label === 'string' ? option.label.trim() : '';
            if (!label || /^Orchestrator\b/i.test(label)) continue;
            const key = label.toLowerCase();
            const prev = models.get(key);
            const q = readQuotaFraction(option);
            if (prev) {
              if (!prev.q && q) prev.q = q;
              if (prev.disabled == null && option.disabled != null) prev.disabled = Boolean(option.disabled);
            } else {
              models.set(key, { label, base: modelBase(label), q, disabled: option.disabled });
            }
          }
        }
        // Resolve the full selected label before considering an Orchestrator alias.
        const label = selected?.label?.trim() || '';
        const direct = models.get(label.toLowerCase());
        let targetBase = '';
        if (!direct && /^Orchestrator\b/i.test(label)) {
          const target = label.match(/^Orchestrator\s*\(([^)]+)\)/i)?.[1] ||
            label.replace(/^Orchestrator\s*/i, '');
          const normalized = (s) => modelBase(s).replace(/^Gemini\s+/i, '').toLowerCase();
          const wanted = normalized(target);
          const matching = new Set();
          for (const m of models.values()) {
            const base = normalized(m.base);
            if (wanted && (base === wanted || base.endsWith(' ' + wanted))) matching.add(m.base);
          }
          if (matching.size === 1) targetBase = [...matching][0];
          const exact = models.get(target.toLowerCase());
          if (exact) exact.active = true;
        }
        if (direct) direct.active = true;
        const entries = [...models.values()];
        for (const m of entries) m.disabled = Boolean(m.disabled);
        const activeFamilyOnly = Boolean(targetBase && !entries.some((m) => m.active));
        const byBase = new Map();
        for (const model of entries) {
          if (!byBase.has(model.base)) byBase.set(model.base, []);
          byBase.get(model.base).push(model);
        }
        const rows = [];
        for (const [base, variants] of byBase) {
          const first = variants[0];
          const active = variants.some((v) => v.active) || (activeFamilyOnly && base === targetBase);
          if (variants.length === 1 || variants.every((v) => sameReading(first, v))) {
            rows.push({ name: base, q: first.q, disabled: first.disabled, active, provider: providerOf(base) });
          } else {
            for (const v of variants) rows.push({
              name: v.label, q: v.q, disabled: v.disabled, active: Boolean(v.active), provider: providerOf(base)
            });
          }
        }
        return rows;
      }

      function groupUsageModels(rows) {
        const groups = [];
        const emitted = new Set();
        for (const row of rows) {
          if (emitted.has(row)) continue;
          const providerPeers = row.provider ? rows.filter((r) => r.provider === row.provider) : [row];
          const matchingPeers = providerPeers.length > 1 ? providerPeers.filter((r) => sameReading(row, r)) : [row];
          const grouped = matchingPeers.length > 1;
          const allProviderMatched = grouped && matchingPeers.length === providerPeers.length;
          const members = grouped ? matchingPeers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) : [row];
          members.forEach((r) => emitted.add(r));
          const groupTitle = !grouped
            ? formatCompactModelDisplay(row.name)
            : allProviderMatched
              ? row.provider
              : members.map((m) => formatCompactModelDisplay(m.name)).join(' / ');
          groups.push({
            name: groupTitle,
            members, q: row.q, disabled: row.disabled, active: members.some((r) => r.active)
          });
        }
        // Keep the provider order stable when switching the selected model.
        const rank = (g) => ({ Gemini: 0, 'Claude / GPT': 1 })[g.members[0].provider] ?? 2;
        return groups.sort((a, b) => rank(a) - rank(b) ||
          a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      }

      function getActiveMetricsStats(footer) {
        const sideContent = footer?.closest?.('[data-testid="side-question-tab-content"]');
        if (sideContent) {
          const conv = sideContent.querySelector('[data-testid="side-question-tab-conversation"][data-cascade-id]');
          const sideCid = conv ? conv.getAttribute('data-cascade-id') : '';
          const sidePayload = sideCid && window.__ag_metrics_by_cid ? window.__ag_metrics_by_cid[sideCid] : null;
          if (sidePayload && sidePayload.hasData && sidePayload.stats) return sidePayload.stats;
          return null;
        }
        const m = window.__ag_last_metrics;
        if (!m || !m.hasData || !m.stats) return null;
        return m.stats;
      }

      function buildRingSvg(pct, tone) {
        const r = 4.25;
        const c = 2 * Math.PI * r;
        const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
        return (
          `<svg class="isdou-quota-ring" data-tone="${tone}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">` +
          `<circle cx="6" cy="6" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.5"/>` +
          `<circle cx="6" cy="6" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 6 6)"/>` +
          `</svg>`
        );
      }

      function toneFor(q) {
        if (!q) return 'normal';
        return q.fraction <= .10 ? 'critical' : q.fraction <= .30 ? 'warning' : 'normal';
      }

      function contextTone(pct) {
        return pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'normal';
      }

      function resetText(sec) {
        if (!sec) return '';
        const mins = Math.ceil((sec - Date.now() / 1000) / 60);
        if (mins <= 0) return '等待额度更新';
        if (mins < 60) return `${mins} 分钟后重置`;
        const hours = Math.floor(mins / 60);
        if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
        return `${hours} 小时${mins % 60 ? ' ' + mins % 60 + ' 分' : ''}后重置`;
      }

      function getIdentity(ctrl) {
        const fallback = window.__isdouAccountSwitcher?.getCurrentAccountInfo?.();
        return {
          email: ctrl?.userStatus?.email || fallback?.email || '',
          tier: ctrl?.userStatus?.userTier?.name || fallback?.tier || ''
        };
      }

      function usageState(ctrl, footer) {
        const rows = readUsageModels(ctrl);
        const q = readQuotaFraction(ctrl?.selectedModel) || rows.find((r) => r.active)?.q || null;
        return { rows, q, stats: getActiveMetricsStats(footer), ...getIdentity(ctrl) };
      }

      function recordSnapshot(state) {
        const sw = window.__isdouAccountSwitcher;
        if (!state.email || !sw?.recordAccountSnapshot) return;
        const { email, tier, q } = state;
        const sig = JSON.stringify([email, tier, q?.pct, q?.resetSec]);
        if (sig === lastSnapshot) return;
        sw.recordAccountSnapshot({ email, tier, pct: q?.pct ?? null, resetSec: q?.resetSec ?? 0 });
        lastSnapshot = sig;
      }

      function action(id, label, email = '', description = '') {
        return `<button type="button" data-isdou-action="${id}" data-email="${escapeHtml(email)}"` +
          (description ? ` aria-label="${escapeHtml(description)}"` : '') +
          `>${escapeHtml(label)}</button>`;
      }

      function meter(value, tone) {
        const width = Math.min(100, Math.max(0, value));
        return `<span class="iu-track" aria-hidden="true"><i data-tone="${tone}" style="width:${width}%"></i></span>`;
      }

      function quotaRow(group) {
        const { name, q, disabled, members, active } = group;
        const multiple = members.length > 1;
        const state = [active ? '当前' : '', disabled ? '不可用' : q?.fraction === 0 ? '已耗尽' : ''].filter(Boolean).join(' · ');
        const head = `<span class="iu-rowhead"><span class="iu-name">${escapeHtml(name)}</span>` +
          (multiple ? '<i class="iu-chevron" aria-hidden="true"></i>' : '') +
          `<strong data-tone="${toneFor(q)}">${escapeHtml(quotaLabel(q))}</strong></span>`;
        const caption = [state, q ? resetText(q.resetSec) : '暂无配额数据'].filter(Boolean).join(' · ');
        const body = head + (q ? meter(q.fraction * 100, toneFor(q)) : '') +
          (caption ? `<small>${escapeHtml(caption)}</small>` : '');
        if (!multiple) return `<li class="iu-pool"><div class="iu-reading">${body}</div></li>`;
        const items = members.map((m) => `<li><span>${escapeHtml(m.name)}</span>` +
          (m.active ? '<small>当前</small>' : '') + '</li>').join('');
        return `<li class="iu-pool"><details data-key="${escapeHtml(name)}"><summary>${body}</summary>` +
          `<ul class="iu-members" aria-label="同额度型号">${items}</ul></details></li>`;
      }

      function quotaView(state) {
        const groups = groupUsageModels(state.rows);
        const list = groups.length ? `<ul class="iu-pools">${groups.map(quotaRow).join('')}</ul>` :
          '<p class="iu-empty">暂无模型配额数据</p>';
        const { email, tier } = state;
        const identity = `<span class="iu-name" title="${escapeHtml(email)}">${escapeHtml(email || '账号')}</span>` +
          (tier ? `<small>${escapeHtml(formatShortTier(tier))}</small>` : '');
        const sw = window.__isdouAccountSwitcher;
        let account = '';
        if (sw?.switchAccount || sw?.isAuthenticating?.()) {
          const pending = sw.isAuthenticating?.();
          account = `<footer><button class="iu-identity" type="button" data-isdou-action="accounts" aria-label="账号管理">` +
            identity + (pending ? '<small>等待验证</small>' : '') + '<i class="iu-next" aria-hidden="true"></i></button></footer>';
        } else if (email) {
          account = `<footer><div class="iu-identity">${identity}</div></footer>`;
        }
        return `<header><h2>剩余额度</h2>${action('session', '会话用量')}</header>${list}${account}`;
      }

      function contextInfo(stats) {
        if (stats?.compactingNow) return { label: '压缩中', pct: null };
        if (stats?.compactedPending) return { label: '已压缩', pct: null };
        const pct = stats?.ctxPct;
        return Number.isFinite(pct) && pct >= 0 ? { label: pct + '%', pct } : { label: '—', pct: null };
      }

      function sessionView({ stats }) {
        const header = `<header><h2>会话用量</h2>${action('quota', '剩余额度')}</header>`;
        if (!stats) return header + '<p class="iu-empty">此会话暂无统计</p>';
        const ctx = contextInfo(stats);
        const limit = stats.limitStr || (Number.isFinite(stats.contextLimit) ? formatCompactTokens(stats.contextLimit) : '');
        const usage = Number.isFinite(stats.ctx) && limit ? formatCompactTokens(stats.ctx) + ' / ' + limit : '';
        const note = ctx.pct !== null ? usage : stats.compactedPending ? '下一次调用后更新' : '';
        const lines = [
          ['缓存命中', /^\d+(?:\.\d+)?%$/.test(stats.sessionCacheRate) ? stats.sessionCacheRate : '—'],
          ['生成速度', Number.isFinite(stats.tps) && stats.tps >= 0 ? stats.tps + ' tok/s' : '—'],
          ['首 Token 延迟', Number.isFinite(stats.ttft) && stats.ttft >= 0 ? stats.ttft + ' s' : '—']
        ];
        return header + `<section class="iu-context" aria-label="上下文窗口"><div class="iu-rowhead">上下文已用` +
          `<strong data-tone="${contextTone(ctx.pct)}">${escapeHtml(ctx.label)}</strong></div>` +
          (ctx.pct === null ? '' : meter(ctx.pct, contextTone(ctx.pct))) +
          (note ? `<small>${escapeHtml(note)}</small>` : '') + '</section>' +
          `<dl class="iu-stats">${lines.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
      }

      function accountsView({ email, tier }) {
        const sw = window.__isdouAccountSwitcher;
        const head = `<header><h2>账号</h2>${action('quota', '返回额度')}</header>`;
        const identity = `<div class="iu-current"><span class="iu-name" title="${escapeHtml(email)}">${escapeHtml(email || '当前账号')}</span>` +
          `<small>${escapeHtml([formatShortTier(tier), '当前'].filter(Boolean).join(' · '))}</small></div>`;
        if (sw?.isAuthenticating?.()) {
          return head + identity + `<footer><p class="iu-note">等待浏览器验证</p><div class="iu-actions">` +
            action('reopen-auth', '重新打开') + action('copy-auth', '复制链接') + action('cancel-auth', '取消验证') + '</div></footer>';
        }
        const accounts = sw?.getKnownAccounts?.(email) || [];
        const items = accounts.map((acct) => {
          const stored = acct.isReset ? '重置时间已过' :
            Number.isFinite(acct.pct) ? `上次剩余 ${acct.pct}%` : '暂无配额快照';
          const note = [formatShortTier(acct.tier), stored, !acct.isReset && resetText(acct.resetSec)].filter(Boolean).join(' · ');
          const addr = escapeHtml(acct.email);
          return `<li><button type="button" class="iu-account" data-isdou-action="switch-account" data-email="${addr}" aria-label="切换到 ${addr}">` +
            `<span class="iu-name" title="${addr}">${addr}</span><small>${escapeHtml(note)}</small></button>` +
            action('remove-account', '移除', acct.email, '移除 ' + acct.email + ' 的本地记录') + '</li>';
        }).join('');
        return head + identity + (items ? `<ul class="iu-accounts" aria-label="已记录的账号">${items}</ul>` : '') +
          (sw?.switchAccount ? `<footer>${action('switch-account', '使用其他账号…')}</footer>` : '');
      }

      function ensurePopover() {
        if (popoverEl?.isConnected) return popoverEl;
        const el = document.createElement('div');
        el.id = 'isdou-usage-popover';
        el.setAttribute('data-ag-i18n-exclude', 'true');
        el.hidden = true;
        el.tabIndex = -1;
        el.setAttribute('role', 'dialog');
        el.addEventListener('pointerenter', cancelHover);
        el.addEventListener('pointerleave', () => scheduleClose(anchor));
        el.addEventListener('focusin', () => { pinnedOpen = true; cancelHover(); });
        el.addEventListener('click', onPopoverClick);
        el.addEventListener('toggle', schedulePosition, true);
        document.body.append(el);
        popoverEl = el;
        return el;
      }

      function focusKey(el) {
        if (el?.matches('summary')) return 'summary:' + el.parentElement.dataset.key;
        return el?.dataset.isdouAction ? JSON.stringify([el.dataset.isdouAction, el.dataset.email || '']) : '';
      }

      function renderPopover(state, reset = false) {
        const el = ensurePopover();
        const titles = { quota: '剩余额度', session: '会话用量', accounts: '账号' };
        const html = view === 'session' ? sessionView(state) : view === 'accounts' ? accountsView(state) : quotaView(state);
        el.setAttribute('aria-label', titles[view]);
        if (!reset && el.__lastHtml === html) return;
        const scroll = reset ? 0 : el.scrollTop;
        const oldFocus = document.activeElement;
        const hadFocus = el.contains(oldFocus);
        const key = !reset && hadFocus ? focusKey(oldFocus) : '';
        const expanded = new Set(reset ? [] : [...el.querySelectorAll('details[open]')].map((d) => d.dataset.key));
        el.innerHTML = html;
        el.__lastHtml = html;
        for (const detail of el.querySelectorAll('details')) detail.open = expanded.has(detail.dataset.key);
        if (hadFocus) {
          const next = key && [...el.querySelectorAll('summary,button')].find((n) => focusKey(n) === key);
          (next || el).focus({ preventScroll: true });
        }
        el.scrollTop = scroll;
        schedulePosition();
      }

      function onPopoverClick(event) {
        const button = event.target.closest('button[data-isdou-action]');
        if (!button) return;
        const { isdouAction: id, email = '' } = button.dataset;
        const sw = window.__isdouAccountSwitcher;
        if (['accounts', 'quota', 'session'].includes(id)) {
          pinnedOpen = true;
          view = id;
          renderPopover(anchor.__usageState, true);
          popoverEl.focus({ preventScroll: true });
        } else if (id === 'remove-account') {
          if (email && sw?.removeKnownAccount?.(email)) renderPopover(anchor.__usageState);
        } else if (id === 'switch-account' || id === 'reopen-auth') {
          hidePopover(true);
          if (id === 'switch-account') sw?.switchAccount?.(email);
          else sw?.reopenAuthUrl?.();
        } else if (id === 'copy-auth') {
          sw?.copyAuthUrl?.();
        } else if (id === 'cancel-auth') {
          sw?.cancelAccountSwitch?.();
          scheduleSync(50);
        }
      }

      function positionPopover() {
        frame = 0;
        if (!anchor) return;
        if (!anchor.isConnected || !anchor.getClientRects().length) return hidePopover();
        const box = anchor.getBoundingClientRect();
        const el = popoverEl;
        const W = document.documentElement.clientWidth;
        const H = document.documentElement.clientHeight;
        if (box.bottom <= 0 || box.top >= H || box.right <= 0 || box.left >= W) return hidePopover();
        const edge = 8, gap = 6;
        const above = box.top - gap - edge;
        const below = H - box.bottom - gap - edge;
        const useAbove = above >= el.scrollHeight + 2 || above >= below;
        el.style.maxHeight = Math.max(1, useAbove ? above : below) + 'px';
        const width = el.offsetWidth;
        const left = Math.max(edge, Math.min(box.right - width, W - width - edge));
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(useAbove ? box.top - gap - el.offsetHeight : box.bottom + gap) + 'px';
      }

      function schedulePosition() {
        if (anchor && !frame) frame = requestAnimationFrame(positionPopover);
      }

      function cancelHover() {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }

      function hidePopover(restore = false) {
        cancelHover();
        const owner = anchor;
        if (owner) owner.setAttribute('aria-expanded', 'false');
        anchor = null;
        pinnedOpen = false;
        if (popoverEl) {
          popoverEl.hidden = true;
          delete popoverEl.dataset.open;
        }
        if (restore && owner?.isConnected && !owner.hidden) owner.focus({ preventScroll: true });
      }

      function openPopover(button, pin) {
        if (!button.__usageState || button.hidden || !button.isConnected) return;
        if (!pin && pinnedOpen) return;
        cancelHover();
        const reset = anchor !== button || view !== button.dataset.view;
        if (anchor && anchor !== button) anchor.setAttribute('aria-expanded', 'false');
        anchor = button;
        view = button.dataset.view;
        pinnedOpen = pin;
        const el = ensurePopover();
        el.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        renderPopover(button.__usageState, reset || !el.dataset.open);
        el.dataset.open = 'true';
        if (frame) cancelAnimationFrame(frame);
        positionPopover();
        if (pin) el.focus({ preventScroll: true });
      }

      function scheduleClose(button) {
        if (pinnedOpen) return;
        cancelHover();
        if (anchor && button === anchor) hoverTimer = setTimeout(() => hidePopover(), 180);
      }

      function initBadge(kind) {
        const button = document.createElement('button');
        button.className = 'isdou-usage-badge';
        button.type = 'button';
        button.dataset.view = kind;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'isdou-usage-popover');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('pointerenter', (e) => {
          if (e.pointerType !== 'mouse' || pinnedOpen) return;
          cancelHover();
          hoverTimer = setTimeout(() => openPopover(button, false), 160);
        });
        button.addEventListener('pointerleave', () => {
          if (anchor && anchor !== button && !pinnedOpen) {
            cancelHover();
            hoverTimer = setTimeout(() => hidePopover(), 180);
          } else scheduleClose(button);
        });
        button.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (anchor === button && pinnedOpen) hidePopover(true);
          else openPopover(button, true);
        });
        return button;
      }

      function updateBadge(button, state, shown, html, label, tone) {
        button.__usageState = state;
        button.setAttribute('aria-label', label);
        button.hidden = !shown;
        button.dataset.tone = tone;
        if (button.__lastHtml !== html) {
          button.innerHTML = html;
          button.__lastHtml = html;
        }
      }

      function syncUsage(footer, ctrl, compact) {
        const right = footer.lastElementChild;
        if (!right) return;
        right.querySelectorAll(':scope > .isdou-usage-badge').forEach((el) => el.remove());
        let controls = right.querySelector(':scope > .isdou-usage-controls');
        if (!controls) {
          controls = document.createElement('div');
          controls.className = 'isdou-usage-controls';
          controls.setAttribute('data-ag-i18n-exclude', 'true');
          ensurePopover();
          controls.append(initBadge('quota'), initBadge('session'));
          right.prepend(controls);
        } else if (right.firstElementChild !== controls) {
          right.prepend(controls);
        }
        const [quotaBtn, sessionBtn] = controls.children;
        const state = usageState(ctrl, footer);
        if (!footer.closest('[data-testid="side-question-tab-content"]') || footer.contains(document.activeElement)) {
          recordSnapshot(state);
        }
        const { q, stats } = state;
        const ctx = contextInfo(stats);
        const quotaText = q ? quotaLabel(q) : '额度';
        const sessionText = ctx.pct === null && ctx.label === '—' ? '会话' : '上下文 ' + ctx.label;
        // A single trigger on narrow footers still provides both pages via the header.
        const showSession = Boolean(stats && (!compact || !q));
        const showQuota = !compact || !showSession;
        const quotaMarkup = (q ? buildRingSvg(q.fraction * 100, toneFor(q)) : '') + `<span>${escapeHtml(quotaText)}</span>`;
        updateBadge(quotaBtn, state, showQuota, quotaMarkup, '模型剩余额度' + (q ? ' ' + quotaText : ''), toneFor(q));
        updateBadge(sessionBtn, state, showSession, `<span>${escapeHtml(sessionText)}</span>`,
          '会话用量，' + sessionText, contextTone(ctx.pct));
        if (anchor && controls.contains(anchor)) {
          if (anchor.hidden) {
            const replacement = anchor === quotaBtn ? sessionBtn : quotaBtn;
            anchor.setAttribute('aria-expanded', 'false');
            anchor = replacement;
            anchor.setAttribute('aria-expanded', 'true');
          }
          renderPopover(state);
          schedulePosition();
        }
      }

      function tidyModelTriggerLabel(modelBtn, hasEffortSeg, family, restoreOnly = false) {
        if (!modelBtn) return;
        const textNodes = [];
        const walker = document.createTreeWalker(modelBtn, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode;
          if ((t.nodeValue || '').trim()) textNodes.push(t);
        }
        if (textNodes.length === 0) return;

        if (restoreOnly) {
          modelBtn.querySelectorAll('[data-isdou-effort-hidden]').forEach((el) => {
            el.removeAttribute('data-isdou-effort-hidden');
          });
          for (const tn of textNodes) {
            if (tn.__isdouOrigLabel) {
              tn.nodeValue = tn.__isdouOrigLabel;
              delete tn.__isdouOrigLabel;
              delete tn.__isdouShortLabel;
            }
          }
          return;
        }

        if (textNodes.length >= 2) {
          const lastNode = textNodes[textNodes.length - 1];
          const lastTxt = (lastNode.nodeValue || '').trim();
          const lastEffort = normalizeEffortKey(lastTxt);
          if (hasEffortSeg && family && lastEffort) {
            const parentSpan = lastNode.parentElement;
            if (parentSpan && parentSpan !== modelBtn) {
              parentSpan.setAttribute('data-isdou-effort-hidden', 'true');
            }
          } else {
            modelBtn.querySelectorAll('[data-isdou-effort-hidden]').forEach((el) => {
              el.removeAttribute('data-isdou-effort-hidden');
            });
            // 例如 Orchestrator 下第二个节点为 "Gemini 4 Carbon Medium"，同样精简前缀
            for (let i = 1; i < textNodes.length; i++) {
              const tn = textNodes[i];
              const rawSec = tn.nodeValue || '';
              const srcSec = rawSec !== tn.__isdouShortLabel ? rawSec : tn.__isdouOrigLabel || rawSec;
              let cleanSec = formatCompactModelDisplay(srcSec);
              if (hasEffortSeg) {
                cleanSec = cleanSec.replace(EFFORT_RE, '').trim();
              }
              if (cleanSec && cleanSec !== rawSec) {
                if (rawSec !== tn.__isdouShortLabel) {
                  tn.__isdouOrigLabel = rawSec;
                }
                tn.__isdouShortLabel = cleanSec;
                tn.nodeValue = cleanSec;
              }
            }
          }
        } else {
          modelBtn.querySelectorAll('[data-isdou-effort-hidden]').forEach((el) => {
            el.removeAttribute('data-isdou-effort-hidden');
          });
        }

        const primaryNode = textNodes[0];
        const rawCur = primaryNode.nodeValue || '';
        const sourceText = rawCur !== primaryNode.__isdouShortLabel ? rawCur : primaryNode.__isdouOrigLabel || rawCur;
        const baseName =
          hasEffortSeg && family && textNodes.length === 1 ? family : sourceText;
        const trailingSpace = textNodes.length >= 2 && /\s$/.test(sourceText) ? ' ' : '';
        const shortLabel = formatCompactModelDisplay(baseName) + trailingSpace;

        if (shortLabel) {
          if (rawCur !== primaryNode.__isdouShortLabel) {
            primaryNode.__isdouOrigLabel = rawCur;
          }
          primaryNode.__isdouShortLabel = shortLabel;
          if (primaryNode.nodeValue !== shortLabel) {
            primaryNode.nodeValue = shortLabel;
          }
        }
      }

      function syncSingleFooter(footer) {
        if (!footer || !document.body.contains(footer)) return;
        const modelBtn = footer.querySelector('[data-testid="model-selector-trigger"]');
        if (!modelBtn) return;

        if (footerRo && !observedFooters.has(footer)) {
          observedFooters.add(footer);
          try {
            footerRo.observe(footer);
          } catch {}
        }

        const footerW = footer.getBoundingClientRect().width || footer.clientWidth || 0;
        const hasPerm = Boolean(footer.querySelector('[data-testid="permissions-selector-trigger"]'));
        // 有权限按钮时（主栏）需要更宽松的阈值才会展开 4 档全称；无权限按钮时（Side Question）500px 即可展开
        const wideEffortThreshold = hasPerm ? 640 : 480;
        const wideUsageThreshold = hasPerm ? 580 : 430;
        const compactEffort = footerW > 0 && footerW < wideEffortThreshold;
        const compactUsage = footerW > 0 && footerW < wideUsageThreshold;
        const ultraCompact = footerW > 0 && footerW < 470;
        footer.setAttribute('data-isdou-density', ultraCompact ? 'ultra' : compactEffort ? 'compact' : 'wide');

        const ctrl = readModelFiberController(modelBtn);
        const sel = ctrl?.selectedModel || null;
        const { family, effort } = splitModelFamilyAndEffort(sel?.label || modelBtn.innerText || '');

        const leftGroup = footer.firstElementChild;
        if (!leftGroup) return;
        let modelSlot = modelBtn;
        while (modelSlot && modelSlot.parentElement && modelSlot.parentElement !== leftGroup) {
          modelSlot = modelSlot.parentElement;
        }
        const anchorNode = modelSlot && modelSlot.parentElement === leftGroup ? modelSlot : modelBtn;

        // 1. 外置 Thinking Effort 控制器（宽屏平铺全档位 / 窄屏自动收为紧凑单钮点击循环切档）
        let segEl = footer.querySelector('.isdou-effort-seg');
        const siblingTiers = [];
        if (ctrl && family) {
          const byEffort = new Map();
          for (const opt of ctrl.modelOptions) {
            if (!opt || opt.disabled) continue;
            const parsed = splitModelFamilyAndEffort(opt.label);
            if (parsed.family === family && parsed.effort && !byEffort.has(parsed.effort)) {
              byEffort.set(parsed.effort, opt);
            }
          }
          for (const k of EFFORT_ORDER) {
            if (byEffort.has(k)) {
              siblingTiers.push({ effort: k, label: EFFORT_LABELS[k], option: byEffort.get(k) });
            }
          }
        }

        if (siblingTiers.length >= 2) {
          if (!segEl) {
            segEl = document.createElement('div');
            segEl.className = 'isdou-effort-seg';
            segEl.setAttribute('role', 'group');
            segEl.setAttribute('aria-label', '推理强度档位');
            anchorNode.insertAdjacentElement('afterend', segEl);
          } else if (segEl.parentElement !== anchorNode.parentElement || segEl.previousElementSibling !== anchorNode) {
            anchorNode.insertAdjacentElement('afterend', segEl);
          }

          if (compactEffort) {
            const curIdx = Math.max(0, siblingTiers.findIndex((t) => t.effort === effort));
            const curItem = siblingTiers[curIdx] || siblingTiers[0];
            const nextItem = siblingTiers[(curIdx + 1) % siblingTiers.length];
            const sig = `compact:${curItem.effort}`;
            if (segEl.getAttribute('data-sig') !== sig) {
              segEl.setAttribute('data-sig', sig);
              segEl.innerHTML = '';
              const cyc = document.createElement('button');
              cyc.type = 'button';
              cyc.className = 'isdou-effort-btn isdou-effort-cycler';
              cyc.setAttribute('data-active', 'true');
              cyc.textContent = curItem.label;
              cyc.title = `推理强度：${curItem.label}（点击切换为 ${nextItem.label}）`;
              cyc.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                try {
                  ctrl.setSelectedModel(nextItem.option);
                } catch {}
                setTimeout(syncAllFooters, 30);
              });
              segEl.appendChild(cyc);
            }
          } else {
            const sig = 'wide:' + siblingTiers.map((t) => `${t.effort}:${t.effort === effort ? 1 : 0}`).join('|');
            if (segEl.getAttribute('data-sig') !== sig) {
              segEl.setAttribute('data-sig', sig);
              segEl.innerHTML = '';
              for (const item of siblingTiers) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'isdou-effort-btn';
                b.textContent = item.label;
                b.title = `切换推理强度：${item.option.label}`;
                if (item.effort === effort) b.setAttribute('data-active', 'true');
                b.addEventListener('click', (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  try {
                    ctrl.setSelectedModel(item.option);
                  } catch {}
                  setTimeout(syncAllFooters, 30);
                });
                segEl.appendChild(b);
              }
            }
          }
          segEl.hidden = false;
          tidyModelTriggerLabel(modelBtn, true, family);
        } else {
          if (segEl) segEl.hidden = true;
          tidyModelTriggerLabel(modelBtn, false, family);
        }

        syncUsage(footer, ctrl, compactUsage);
      }

      function syncAllFooters() {
        if (disposed) return;
        const footers = document.querySelectorAll('.agy-composer-footer, [data-agent-composer-root]');
        for (const f of observedFooters) {
          if (!f.isConnected) {
            footerRo?.unobserve(f);
            observedFooters.delete(f);
          }
        }
        if (anchor && !anchor.isConnected) hidePopover();
        for (const f of footers) {
          const model = f.querySelector('[data-testid="model-selector-trigger"]');
          if (model?.closest('.agy-composer-footer, [data-agent-composer-root]') === f) syncSingleFooter(f);
        }
      }

      function scheduleSync(delay = 80) {
        if (disposed || syncTimer) return;
        syncTimer = setTimeout(() => {
          syncTimer = null;
          syncAllFooters();
        }, delay);
      }

      function onDocPointerDown(e) {
        if (popoverEl?.contains(e.target) || e.target.closest?.('.isdou-usage-badge')) return;
        hidePopover();
      }

      function onDocFocusIn(e) {
        if (anchor && e.target !== anchor && !popoverEl.contains(e.target)) hidePopover();
      }

      function onDocKeyDown(e) {
        if (!anchor) return;
        if (e.key === 'Escape') {
          const restore = popoverEl.contains(document.activeElement);
          hidePopover(restore);
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Tab' && popoverEl.contains(document.activeElement)) {
          const stops = [...popoverEl.querySelectorAll('button, summary')].filter((n) => n.getClientRects().length);
          const active = document.activeElement;
          if (e.shiftKey && (active === stops[0] || active === popoverEl)) {
            e.preventDefault();
            hidePopover(true);
          } else if (!e.shiftKey && (!stops.length || active === stops.at(-1))) {
            // Let native Tab advance from the owning footer button.
            hidePopover(true);
          }
        }
      }

      if (typeof ResizeObserver !== 'undefined') {
        footerRo = new ResizeObserver(() => scheduleSync(40));
      }

      const obs =
        typeof MutationObserver !== 'undefined'
          ? new MutationObserver(() => scheduleSync(90))
          : null;
      if (obs && document.body) {
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      function onAccountSwitched() {
        scheduleSync(50);
      }

      const pollId = setInterval(() => syncAllFooters(), 1800);
      window.addEventListener('resize', schedulePosition);
      document.addEventListener('scroll', schedulePosition, true);
      document.addEventListener('focusin', onDocFocusIn, true);
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
      window.addEventListener('isdou:account-switched', onAccountSwitched);

      syncAllFooters();

      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        clearInterval(pollId);
        if (syncTimer) clearTimeout(syncTimer);
        if (hoverTimer) clearTimeout(hoverTimer);
        if (footerRo) footerRo.disconnect();
        if (obs) obs.disconnect();
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedulePosition);
        document.removeEventListener('scroll', schedulePosition, true);
        document.removeEventListener('focusin', onDocFocusIn, true);
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('keydown', onDocKeyDown, true);
        window.removeEventListener('isdou:account-switched', onAccountSwitched);
        document.querySelectorAll('.isdou-effort-seg, .isdou-usage-controls').forEach((el) => el.remove());
        if (popoverEl) popoverEl.remove();
        document.querySelectorAll('[data-testid="model-selector-trigger"]').forEach((btn) => {
          tidyModelTriggerLabel(btn, false, '', true);
        });
      });
    })();
  }
