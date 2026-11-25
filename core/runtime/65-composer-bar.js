/**
 * Part 65: Linear Responsive Inline Effort Switcher & Live Quota/Context Meter
 *
 * - Supports every visible `.agy-composer-footer` (Main pane + Side Question pane)
 * - Uses ResizeObserver for zero-overlap responsive layout:
 *     - Wide (>= 600px): `Model ▾  |  低  中  高  极高`  ...  `◔ 71% · Ctx 32%`  `Permissions`
 *     - Narrow (< 600px, split view): compact Effort cycler pill `[ 高 ]` & compact `◔ 71%`
 *       so nothing ever collides or gets crushed
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
      let popoverOpen = false;
      let popoverEl = null;
      let lastPopoverCtrl = null;
      let lastPopoverFooter = null;
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
        if (/google\s+ai\s+ultra/i.test(s)) return 'ULTRA';
        if (/google\s+ai\s+pro/i.test(s)) return 'PRO';
        if (/google\s+ai\s+plus/i.test(s)) return 'PLUS';
        return s.replace(/^Google\s+AI\s+/i, '').trim();
      }

      function formatShortCountdown(resetSeconds) {
        const sec = Number(resetSeconds) || 0;
        if (!sec) return '';
        const diffSec = Math.max(0, Math.round(sec - Date.now() / 1000));
        if (diffSec <= 0) return '即将';
        const d = Math.floor(diffSec / 86400);
        const h = Math.floor((diffSec % 86400) / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
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

      function formatResetCountdown(resetSeconds) {
        const sec = Number(resetSeconds) || 0;
        if (!sec) return '';
        const diffSec = Math.max(0, Math.round(sec - Date.now() / 1000));
        if (diffSec <= 0) return '即将重置';
        const d = Math.floor(diffSec / 86400);
        const h = Math.floor((diffSec % 86400) / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        if (d > 0) return `${d}d ${h}h 后重置`;
        if (h > 0) return `${h}h ${m}m 后重置`;
        return `${m}m 后重置`;
      }

      function readQuotaFraction(modelObj) {
        if (!modelObj || !modelObj.quotaInfo) return null;
        const q = modelObj.quotaInfo;
        const frac =
          typeof q.remainingFraction === 'number'
            ? q.remainingFraction
            : typeof q.remaining === 'number'
              ? q.remaining
              : modelObj.disabled
                ? 0
                : null;
        if (frac === null || Number.isNaN(frac)) return null;
        const resetSec =
          q.resetTime && typeof q.resetTime.seconds !== 'undefined'
            ? Number(q.resetTime.seconds)
            : 0;
        return {
          pct: Math.max(0, Math.min(100, Math.round(frac * 100))),
          resetSec
        };
      }

      function stripDisplayNoise(name) {
        return String(name || '')
          .replace(/\s*\((thinking|low|medium|high|xhigh|extra|max|ultra)\)\s*$/i, '')
          .trim();
      }

      function collectQuotaRows(ctrl) {
        const rawConfigs = ctrl?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        const rawOptions = ctrl?.modelOptions;
        const merged = [];
        const seenLabels = new Set();

        for (const list of [rawOptions, rawConfigs]) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (!item || !item.label) continue;
            if (seenLabels.has(item.label)) continue;
            seenLabels.add(item.label);
            merged.push(item);
          }
        }

        const selLabel = ctrl?.selectedModel?.label || '';
        const orchMatch = selLabel.match(/^Orchestrator\s*\(([^)]+)\)/i);
        const orchSub = orchMatch ? orchMatch[1].trim().toLowerCase() : '';
        const curFamily = selLabel
          ? stripDisplayNoise(splitModelFamilyAndEffort(selLabel).family)
          : '';

        const families = [];
        const seenFamily = new Set();
        for (const opt of merged) {
          const base = stripDisplayNoise(splitModelFamilyAndEffort(opt.label).family);
          if (!base || seenFamily.has(base)) continue;
          if (/^Orchestrator\b/i.test(base)) continue;
          const q = readQuotaFraction(opt);
          if (!q) continue;
          seenFamily.add(base);
          const isOrchTarget = Boolean(orchSub && base.toLowerCase().includes(orchSub));
          families.push({
            family: base,
            pct: q.pct,
            disabled: Boolean(opt.disabled) || q.pct <= 0,
            resetSec: q.resetSec,
            resetStr: q.resetSec ? formatShortCountdown(q.resetSec) : q.pct <= 0 ? '已耗尽' : '',
            resetFull: q.resetSec ? formatResetCountdown(q.resetSec) : q.pct <= 0 ? '已耗尽' : '',
            active: base === curFamily || isOrchTarget
          });
        }

        families.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          const aDepleted = a.disabled || a.pct <= 0;
          const bDepleted = b.disabled || b.pct <= 0;
          if (aDepleted !== bDepleted) return aDepleted ? 1 : -1;
          return 0;
        });
        return families;
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

      function syncAccountSnapshot(ctrl, quota, families) {
        const sw = window.__isdouAccountSwitcher;
        if (!sw || typeof sw.recordAccountSnapshot !== 'function') return { email: '', tier: '' };
        const info = typeof sw.getCurrentAccountInfo === 'function' ? sw.getCurrentAccountInfo() : null;
        const email = ctrl?.userStatus?.email || info?.email || '';
        const tier = ctrl?.userStatus?.userTier?.name || info?.tier || '';
        if (email) {
          const list = Array.isArray(families) ? families : collectQuotaRows(ctrl);
          const activeFam = list.find((f) => f.active) || list[0] || null;
          const pct = quota ? quota.pct : activeFam ? activeFam.pct : null;
          const resetSec = quota?.resetSec || activeFam?.resetSec || 0;
          sw.recordAccountSnapshot({ email, tier, pct, resetSec });
        }
        return { email, tier };
      }

      function onPopoverClick(ev) {
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-isdou-action]') : null;
        if (!target) return;
        const action = target.getAttribute('data-isdou-action');
        const email = target.getAttribute('data-email') || '';
        if (action === 'switch-account') {
          ev.preventDefault();
          ev.stopPropagation();
          hidePopover();
          window.__isdouAccountSwitcher?.switchAccount?.(email);
        } else if (action === 'reopen-auth') {
          ev.preventDefault();
          ev.stopPropagation();
          hidePopover();
          window.__isdouAccountSwitcher?.reopenAuthUrl?.();
        } else if (action === 'copy-auth') {
          ev.preventDefault();
          ev.stopPropagation();
          window.__isdouAccountSwitcher?.copyAuthUrl?.();
        } else if (action === 'cancel-auth') {
          ev.preventDefault();
          ev.stopPropagation();
          window.__isdouAccountSwitcher?.cancelAccountSwitch?.();
        } else if (action === 'remove-account') {
          ev.preventDefault();
          ev.stopPropagation();
          if (email && window.__isdouAccountSwitcher?.removeKnownAccount?.(email)) {
            if (popoverOpen) renderPopoverContent(lastPopoverCtrl, lastPopoverFooter);
          }
        }
      }

      function ensurePopover() {
        if (popoverEl && document.body.contains(popoverEl)) return popoverEl;
        const el = document.createElement('div');
        el.id = 'isdou-usage-popover';
        el.addEventListener('mouseenter', () => {
          if (hoverTimer) clearTimeout(hoverTimer);
        });
        el.addEventListener('mouseleave', () => {
          if (!pinnedOpen) scheduleHidePopover();
        });
        el.addEventListener('click', onPopoverClick);
        document.body.appendChild(el);
        popoverEl = el;
        return el;
      }

      function renderPopoverContent(ctrl, footer) {
        lastPopoverCtrl = ctrl;
        lastPopoverFooter = footer;
        const el = ensurePopover();
        const families = collectQuotaRows(ctrl);
        const stats = getActiveMetricsStats(footer);
        const selQuota = ctrl?.selectedModel ? readQuotaFraction(ctrl.selectedModel) : null;
        const { email, tier } = syncAccountSnapshot(ctrl, selQuota, families);
        const otherAccounts = window.__isdouAccountSwitcher?.getKnownAccounts?.(email) || [];
        const isPendingAuth = Boolean(window.__isdouAccountSwitcher?.isAuthenticating?.());
        const shortTier = formatShortTier(tier);

        let html = `<div class="isdou-up-acct-sec">`;
        html +=
          `<div class="isdou-up-acct-bar">` +
          `<div class="isdou-up-acct-cur">` +
          `<span class="isdou-up-acct-dot" aria-hidden="true"></span>` +
          `<span class="isdou-up-acct-email" title="${escapeHtml(email || '')}">${escapeHtml(email || '当前账号')}</span>` +
          (shortTier ? `<span class="isdou-up-tier" title="${escapeHtml(tier)}">${escapeHtml(shortTier)}</span>` : '') +
          `</div>` +
          (isPendingAuth
            ? `<div class="isdou-up-acct-meta">` +
              `<button type="button" class="isdou-up-switch-btn" data-isdou-action="reopen-auth" title="重新打开浏览器验证页">重开</button>` +
              `<button type="button" class="isdou-up-switch-btn" data-isdou-action="copy-auth" title="复制验证链接">复制</button>` +
              `<button type="button" class="isdou-up-switch-btn" data-isdou-action="cancel-auth" title="取消验证并恢复当前账号">取消</button>` +
              `</div>`
            : `<button type="button" class="isdou-up-switch-btn" data-isdou-action="switch-account" title="切换 Google 会员账号">⇄ 切换</button>`) +
          `</div>`;

        if (otherAccounts.length > 0) {
          html += `<div class="isdou-up-acct-list">`;
          for (const acc of otherAccounts) {
            const accPct = acc.effectivePct;
            const accTone = accPct === null || accPct === undefined ? 'ok' : accPct <= 10 ? 'crit' : accPct <= 30 ? 'warn' : 'ok';
            const statusStr = acc.isReset ? '已重置' : acc.resetSec ? formatShortCountdown(acc.resetSec) : '';
            const pctStr = accPct !== null && accPct !== undefined ? `${accPct}%` : '--';
            const accShortTier = formatShortTier(acc.tier);
            html +=
              `<div class="isdou-up-acct-item">` +
              `<button type="button" class="isdou-up-acct-main" data-isdou-action="switch-account" data-email="${escapeHtml(acc.email)}" title="点击复制邮箱并打开浏览器切换到 ${escapeHtml(acc.email)}">` +
              `<span class="isdou-up-acct-arrow" aria-hidden="true">↪</span>` +
              `<span class="isdou-up-acct-subemail">${escapeHtml(acc.email)}</span>` +
              (accShortTier ? `<span class="isdou-up-tier isdou-up-tier-muted" title="${escapeHtml(acc.tier)}">${escapeHtml(accShortTier)}</span>` : '') +
              `<span class="isdou-up-acct-meta">` +
              (statusStr ? `<span class="isdou-up-reset">${escapeHtml(statusStr)}</span>` : '') +
              `<span class="isdou-up-val" data-tone="${accTone}">${pctStr}</span>` +
              `</span>` +
              `</button>` +
              `<button type="button" class="isdou-up-acct-del" data-isdou-action="remove-account" data-email="${escapeHtml(acc.email)}" aria-label="移除账号记录" title="移除此账号记录">×</button>` +
              `</div>`;
          }
          html += `</div>`;
        }
        html += `</div>`;

        const inactiveDepleted = families.filter((f) => !f.active && (f.pct <= 0 || f.disabled));
        const shouldCollapseDepleted = inactiveDepleted.length >= 2;
        const visibleRows = shouldCollapseDepleted
          ? families.filter((f) => f.active || (f.pct > 0 && !f.disabled))
          : families;
        const collapsedDepleted = shouldCollapseDepleted ? inactiveDepleted : [];

        html += `<div class="isdou-up-sec">`;
        html += `<div class="isdou-up-hdr"><span>模型配额</span><span class="isdou-up-sub">重置 · 剩余</span></div>`;
        if (families.length === 0) {
          html += `<div class="isdou-up-empty">暂无配额数据</div>`;
        } else {
          for (const f of visibleRows) {
            const tone = f.pct <= 10 ? 'crit' : f.pct <= 30 ? 'warn' : 'ok';
            const displayFamily = formatCompactModelDisplay(f.family);
            const barWidth = f.pct > 0 ? Math.max(4, Math.min(100, f.pct)) : 0;
            html +=
              `<div class="isdou-up-row ${f.active ? 'is-active' : ''} ${f.disabled ? 'is-depleted' : ''}">` +
              `<span class="isdou-up-name" title="${escapeHtml(f.family)}">` +
              (f.active ? `<span class="isdou-up-active-dot" aria-hidden="true"></span>` : '') +
              `<span>${escapeHtml(displayFamily)}</span>` +
              `</span>` +
              `<span class="isdou-up-reset" title="${escapeHtml(f.resetFull || '')}">${escapeHtml(f.resetStr || '--')}</span>` +
              `<div class="isdou-up-bar"><div class="isdou-up-fill" data-tone="${tone}" style="width:${barWidth}%"></div></div>` +
              `<span class="isdou-up-val" data-tone="${tone}">${f.pct}%</span>` +
              `</div>`;
          }
          if (collapsedDepleted.length > 0) {
            html += `<div class="isdou-up-depleted-group">`;
            html += `<span class="isdou-up-depleted-lbl">已耗尽 0%</span>`;
            html += `<div class="isdou-up-depleted-tags">`;
            for (const d of collapsedDepleted) {
              const shortName = formatCompactModelDisplay(d.family);
              const tip = d.resetFull && d.resetFull !== '已耗尽' ? `${d.family} · ${d.resetFull}` : `${d.family} · 已耗尽`;
              html += `<span class="isdou-up-depleted-chip" title="${escapeHtml(tip)}">${escapeHtml(shortName)}</span>`;
            }
            html += `</div></div>`;
          }
        }
        html += `</div>`;

        if (stats) {
          const ctxTone = stats.ctxPct >= 90 ? 'crit' : stats.ctxPct >= 75 ? 'warn' : 'ok';
          const ctxWidth = Math.max(0, Math.min(100, Number(stats.ctxPct) || 0));
          html += `<div class="isdou-up-sec isdou-up-divider">`;
          html +=
            `<div class="isdou-up-hdr">` +
            `<span>会话上下文</span>` +
            `<span class="isdou-up-sub">${formatCompactTokens(stats.ctx)} / ${escapeHtml(stats.limitStr || '256k')} · <strong class="isdou-up-ctx-pct" data-tone="${ctxTone}">${stats.ctxPct}%</strong></span>` +
            `</div>`;
          html += `<div class="isdou-up-ctx-track"><div class="isdou-up-ctx-fill" data-tone="${ctxTone}" style="width:${ctxWidth}%"></div></div>`;
          html +=
            `<div class="isdou-up-stat-grid">` +
            `<div class="isdou-up-stat-card"><span>缓存命中</span><strong>${escapeHtml(stats.sessionCacheRate || '--')}</strong></div>` +
            `<div class="isdou-up-stat-card"><span>生成速度</span><strong>${stats.tps ? stats.tps + ' tok/s' : '--'}</strong></div>` +
            `<div class="isdou-up-stat-card"><span>首字延迟</span><strong>${stats.ttft ? stats.ttft + 's' : '--'}</strong></div>` +
            `</div>`;
          html += `</div>`;
        }

        if (el.__lastHtml !== html) {
          el.__lastHtml = html;
          el.innerHTML = html;
        }
      }

      function showPopover(anchorEl, ctrl, footer) {
        if (hoverTimer) clearTimeout(hoverTimer);
        renderPopoverContent(ctrl, footer);
        const el = ensurePopover();
        const r = anchorEl.getBoundingClientRect();
        const popW = Math.min(368, Math.max(260, window.innerWidth - 24));
        const left = Math.max(12, Math.min(window.innerWidth - popW - 12, r.right - popW));
        const bottom = Math.max(12, window.innerHeight - r.top + 8);
        el.style.left = `${left}px`;
        el.style.bottom = `${bottom}px`;
        el.setAttribute('data-open', 'true');
        popoverOpen = true;
      }

      function hidePopover() {
        pinnedOpen = false;
        popoverOpen = false;
        if (popoverEl) popoverEl.removeAttribute('data-open');
      }

      function scheduleHidePopover() {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (!pinnedOpen) hidePopover();
        }, 140);
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
        const shortLabel = formatCompactModelDisplay(baseName);

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

        // 2. 外置实时用量徽章（宽屏 `◔ 71% · Ctx 32%` / 窄屏 `◔ 71%`）
        const rightGroup = footer.lastElementChild;
        if (!rightGroup) return;

        let badgeEl = footer.querySelector('.isdou-usage-badge');
        if (!badgeEl) {
          badgeEl = document.createElement('button');
          badgeEl.className = 'isdou-usage-badge';
          badgeEl.type = 'button';
          badgeEl.addEventListener('mouseenter', () => {
            const latestCtrl = readModelFiberController(modelBtn);
            showPopover(badgeEl, latestCtrl, footer);
          });
          badgeEl.addEventListener('mouseleave', () => {
            if (!pinnedOpen) scheduleHidePopover();
          });
          badgeEl.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const latestCtrl = readModelFiberController(modelBtn);
            if (pinnedOpen) {
              hidePopover();
            } else {
              pinnedOpen = true;
              showPopover(badgeEl, latestCtrl, footer);
            }
          });
          rightGroup.insertBefore(badgeEl, rightGroup.firstChild);
        } else if (badgeEl.parentElement !== rightGroup || rightGroup.firstChild !== badgeEl) {
          rightGroup.insertBefore(badgeEl, rightGroup.firstChild);
        }

        const quota = readQuotaFraction(sel);
        const stats = getActiveMetricsStats(footer);
        syncAccountSnapshot(ctrl, quota, null);

        const parts = [];
        if (quota) {
          const qTone = quota.pct <= 10 ? 'crit' : quota.pct <= 30 ? 'warn' : 'ok';
          parts.push(
            `<span class="isdou-ub-item" data-tone="${qTone}">${buildRingSvg(quota.pct, qTone)}<span>${quota.pct}%</span></span>`
          );
        }
        if (!compactUsage && stats && typeof stats.ctxPct === 'number') {
          const cTone = stats.ctxPct >= 90 ? 'crit' : stats.ctxPct >= 75 ? 'warn' : 'ok';
          parts.push(
            `<span class="isdou-ub-item" data-tone="${cTone}"><span>Ctx ${stats.ctxPct}%</span></span>`
          );
        }

        if (parts.length > 0) {
          const nextHtml = parts.join('<span class="isdou-ub-sep">·</span>');
          if (badgeEl.__lastHtml !== nextHtml) {
            badgeEl.__lastHtml = nextHtml;
            badgeEl.innerHTML = nextHtml;
          }
          badgeEl.hidden = false;
        } else {
          badgeEl.hidden = true;
        }

        if (popoverOpen) {
          renderPopoverContent(ctrl, footer);
        }
      }

      function syncAllFooters() {
        if (disposed) return;
        const footers = document.querySelectorAll('.agy-composer-footer, [data-agent-composer-root]');
        for (const f of footers) {
          syncSingleFooter(f);
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
        if (!popoverOpen) return;
        if (popoverEl && popoverEl.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest('.isdou-usage-badge')) return;
        hidePopover();
      }

      function onDocKeyDown(e) {
        if (popoverOpen && e.key === 'Escape') hidePopover();
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
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('keydown', onDocKeyDown, true);
        window.removeEventListener('isdou:account-switched', onAccountSwitched);
        document.querySelectorAll('.isdou-effort-seg, .isdou-usage-badge').forEach((el) => el.remove());
        if (popoverEl) popoverEl.remove();
        document.querySelectorAll('[data-testid="model-selector-trigger"]').forEach((btn) => {
          tidyModelTriggerLabel(btn, false, '', true);
        });
      });
    })();
  }
