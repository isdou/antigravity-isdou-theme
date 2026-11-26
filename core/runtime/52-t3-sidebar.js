/**
 * Part 52: 紧凑卡片式侧边栏结构与元数据增强
 *
 * - 顶部收拢为「搜索框 + 显示选项 / 新建项目 / 新建对话」紧凑工具栏
 * - 底部收敛为「系统设置 / 自动化任务 / 技能与自定义」横向图标栏
 * - 为项目文件夹生成彩色缩写徽标，同首字项目用双字区分，折叠时附带计数和状态点
 * - 为会话行按需补充所属项目徽标、Git 分支与 PR 编号、模型厂商图标与状态胶囊（零造假元数据）
 * - 通过签名前置短路 + 零破坏原生 React 子节点的追加顺序，确保虚拟列表 ResizeObserver 精确对齐
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.theme !== false) {
    (() => {
      const BODY_ATTR = 'data-isdou-t3-sidebar';
      const HEADER_ID = 'isdou-t3-sidebar-header';
      const FOOTER_ID = 'isdou-t3-sidebar-footer';

      const PALETTE = [
        'violet',
        'teal',
        'emerald',
        'blue',
        'amber',
        'rose',
        'indigo',
        'cyan',
        'orange',
        'fuchsia'
      ];

      const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/;

      const DOT_PRIORITY = {
        approval: 3,
        input: 3,
        working: 2,
        done: 1,
        settled: 0
      };

      const SVG_ICONS = {
        search:
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>',
        filter:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M7 12h10"></path><path d="M10 18h4"></path></svg>',
        folderPlus:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10v6"></path><path d="M9 13h6"></path><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>',
        squarePen:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path></svg>',
        settings:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
        clock:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
        blocks:
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="14" y="3" rx="1"></rect><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"></path></svg>',
        chevronDown:
          '<svg class="isdou-t3-folder-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>',
        branch:
          '<svg width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>',
        approval:
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>',
        input:
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>',
        done:
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>',
        working:
          '<svg class="isdou-t3-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>'
      };

      const PROVIDER_SVGS = {
        claude:
          '<svg class="isdou-t3-provider-svg is-claude" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true"><path d="M8 2v12M2 8h12M3.76 3.76l8.48 8.48M12.24 3.76l-8.48 8.48M5.7 2.45l4.6 11.1M13.55 5.7l-11.1 4.6"></path></svg>',
        openai:
          '<svg class="isdou-t3-provider-svg is-openai" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07ZM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .4-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.5 4.5ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9Zm16.6 3.85-5.84-3.37 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.41-.68Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.4.68v6.72Zm1.1-2.37 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5v-3Z"></path></svg>',
        gemini:
          '<svg class="isdou-t3-provider-svg is-gemini" width="12.5" height="12.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.25c.35 3.16 1.59 4.4 4.75 4.75-3.16.35-4.4 1.59-4.75 4.75-.35-3.16-1.59-4.4-4.75-4.75 3.16-.35 4.4-1.59 4.75-4.75Z" transform="translate(0 2)"></path></svg>'
      };

      const STATUS_LABELS = {
        approval: '待确认',
        input: '待输入',
        working: '运行中',
        done: '已完成'
      };

      let disposed = false;
      let storeRef = null;
      let pmsRef = null;
      let storeUnsub = null;
      let bodyObs = null;
      let scrollElRef = null;
      let syncRaf = 0;
      let syncTimer = 0;
      let initPollTimer = 0;
      let modelEnumMapCache = null;

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function getFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        return key ? el[key] : null;
      }

      function resolveAppHandles() {
        if (storeRef && pmsRef) return { store: storeRef, pms: pmsRef };
        const anchors = [
          document.querySelector('.bg-sidebar'),
          document.querySelector('[data-testid="project-header"]'),
          document.querySelector('[data-testid="conversation-row-sidebar"]'),
          document.getElementById('root')?.firstElementChild
        ];
        for (const anchor of anchors) {
          let cur = getFiber(anchor);
          let guard = 0;
          while (cur && guard++ < 85) {
            let dep = cur.dependencies?.firstContext;
            while (dep) {
              const mv = dep.memoizedValue;
              if (mv && typeof mv === 'object') {
                if (!storeRef && mv.store && typeof mv.store.getState === 'function') {
                  storeRef = mv.store;
                }
                if (!pmsRef && mv.core?.projectManagementService) {
                  pmsRef = mv.core.projectManagementService;
                }
              }
              dep = dep.next;
            }
            if (storeRef && pmsRef) break;
            cur = cur.return;
          }
          if (storeRef && pmsRef) break;
        }
        return { store: storeRef, pms: pmsRef };
      }

      function hashTone(seed) {
        const s = String(seed || 'project');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return PALETTE[(h >>> 0) % PALETTE.length];
      }

      function computeMonogram(name, cjkLength = 1) {
        const parts = String(name || '').match(/[\p{L}\p{N}]+/gu) || [];
        if (!parts.length) return { text: 'PR', cjk: false };
        const chars = Array.from(parts[0]);
        const firstChar = chars[0];
        if (CJK_RE.test(firstChar)) {
          return { text: chars.slice(0, cjkLength).join(''), cjk: true };
        }
        const nextInitial = Array.from(parts[1] || '')[0];
        if (nextInitial && !CJK_RE.test(nextInitial)) {
          return { text: (firstChar + nextInitial).toUpperCase(), cjk: false };
        }
        const camel = parts[0].split(/(?<=[a-z0-9])(?=[A-Z])/);
        if (camel.length >= 2) {
          return {
            text: ((Array.from(camel[0])[0] || '') + (Array.from(camel[1])[0] || '')).toUpperCase(),
            cjk: false
          };
        }
        return {
          text: chars.slice(0, 2).join('').toUpperCase() || 'PR',
          cjk: false
        };
      }

      function formatRelTime(secondsVal) {
        const sec = Number(secondsVal);
        if (!Number.isFinite(sec) || sec <= 0) return '';
        const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - sec);
        if (diffSec < 60) return '刚刚';
        const mins = Math.floor(diffSec / 60);
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days}d`;
        const months = Math.floor(days / 30);
        return `${months}mo`;
      }

      function getModelProviderMap(st) {
        const configs = st?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (Array.isArray(configs) && configs.length > 0) {
          const map = new Map();
          for (const item of configs) {
            const code = item?.modelOrAlias?.choice?.value;
            const label = String(item?.label || '').toLowerCase();
            if (code == null || !label) continue;
            if (label.includes('claude')) map.set(code, 'claude');
            else if (label.includes('gpt') || label.includes('openai')) map.set(code, 'openai');
            else if (label.includes('gemini') || label.includes('orchestrator')) map.set(code, 'gemini');
          }
          if (map.size > 0) modelEnumMapCache = map;
        }
        return modelEnumMapCache;
      }

      function resolveProviderForConv(st, modelEnumMap, cascadeId) {
        const sel = st?.modelSelection?.byConversation?.[cascadeId];
        const code = sel?.model ?? sel?.value;
        if (code == null) return '';
        if (modelEnumMap && modelEnumMap.has(code)) {
          return modelEnumMap.get(code);
        }
        if (code === 1400 || code === 1401 || code === 1402 || code === 1403 || code === 1404 || code === 1405) {
          return 'claude';
        }
        if (code === 342) return 'openai';
        return 'gemini';
      }

      function computeSummaryState(s) {
        if (!s || typeof s !== 'object') return 'settled';
        if (Array.isArray(s.waitingSteps) && s.waitingSteps.length > 0) return 'approval';
        if (Number(s.openCardCount) > 0) return 'input';
        if (s.status === 2 || s.notFullyIdle || s.hasActivity || s.hasRunningSubagents) return 'working';
        const modSec = Number(s.lastModifiedTime?.seconds || 0);
        const viewSec = Number(s.annotations?.lastUserViewTime?.seconds || 0);
        if (s.status === 1 && modSec > 0 && viewSec > 0 && modSec > viewSec + 2) {
          return 'done';
        }
        return 'settled';
      }

      function pickHigherPriorityState(prev, next) {
        const prevScore = DOT_PRIORITY[prev] || 0;
        const nextScore = DOT_PRIORITY[next] || 0;
        return nextScore > prevScore ? next : prev;
      }

      function buildMetadataSnapshot() {
        const { store, pms } = resolveAppHandles();
        const st = store?.getState?.() || {};
        const projectsById = new Map();
        const projectsByName = new Map();

        const rppMap = pms?.richProjectsProvider?.getState?.();
        if (rppMap instanceof Map) {
          const firstProjectByGlyph = new Map();
          for (const item of rppMap.values()) {
            const p = item?.project;
            if (!p || !p.id) continue;
            const mono = computeMonogram(p.name || p.id);
            const info = {
              id: p.id,
              name: p.name || p.id,
              mono: mono.text,
              cjk: mono.cjk,
              tone: hashTone(p.id || p.name)
            };
            if (info.cjk) {
              const first = firstProjectByGlyph.get(mono.text);
              if (first) {
                first.mono = computeMonogram(first.name, 2).text;
                info.mono = computeMonogram(info.name, 2).text;
              } else {
                firstProjectByGlyph.set(mono.text, info);
              }
            }
            projectsById.set(p.id, info);
            if (p.name) projectsByName.set(p.name, info);
          }
        }

        const countsByProject = new Map();
        const dotsByProject = new Map();
        const sums = st?.trajectorySummaries?.summaries || {};
        for (const s of Object.values(sums)) {
          if (!s) continue;
          const pid = s.projectId || s.trajectoryMetadata?.projectId || '';
          if (!pid || pid === 'outside-of-project' || pid === 'standalone') continue;
          countsByProject.set(pid, (countsByProject.get(pid) || 0) + 1);
          const state = computeSummaryState(s);
          if (state !== 'settled') {
            const prev = dotsByProject.get(pid) || 'settled';
            dotsByProject.set(pid, pickHigherPriorityState(prev, state));
          }
        }

        return {
          st,
          sums,
          projectsById,
          projectsByName,
          countsByProject,
          dotsByProject,
          modelEnumMap: getModelProviderMap(st)
        };
      }

      function triggerVirtualSectionButton(selector) {
        const direct = document.querySelector(selector);
        if (direct) {
          direct.click();
          return;
        }
        const scroller = document.querySelector('[data-testid="conversation-list-sidebar"]');
        if (scroller) {
          scroller.scrollTop = 0;
          setTimeout(() => {
            document.querySelector(selector)?.click();
          }, 70);
        }
      }

      function ensureSidebarHeader(sidebarEl) {
        if (!sidebarEl) return;
        let hdr = document.getElementById(HEADER_ID);
        if (!hdr) {
          hdr = document.createElement('div');
          hdr.id = HEADER_ID;
          hdr.setAttribute('data-ag-i18n-exclude', 'true');
          hdr.innerHTML =
            '<button type="button" class="isdou-t3-search-btn" aria-label="搜索会话" title="搜索会话">' +
            SVG_ICONS.search +
            '<span class="isdou-t3-search-label">搜索</span>' +
            '</button>' +
            '<div class="isdou-t3-hdr-actions">' +
            '<button type="button" class="isdou-t3-icon-btn" data-isdou-action="filter" aria-label="显示选项" title="显示选项">' +
            SVG_ICONS.filter +
            '</button>' +
            '<button type="button" class="isdou-t3-icon-btn" data-isdou-action="add-project" aria-label="新建项目" title="新建项目">' +
            SVG_ICONS.folderPlus +
            '</button>' +
            '<button type="button" class="isdou-t3-icon-btn isdou-t3-compose-btn" data-isdou-action="new-chat" aria-label="新建对话" title="新建对话">' +
            SVG_ICONS.squarePen +
            '</button>' +
            '</div>';

          hdr.querySelector('.isdou-t3-search-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector('[data-testid="sidebar-search-button"]')?.click();
          });

          hdr.querySelector('[data-isdou-action="filter"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerVirtualSectionButton(
              '[data-testid="section-header"][data-section-id="main-section-header"] button[aria-haspopup="menu"]'
            );
          });

          hdr.querySelector('[data-isdou-action="add-project"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerVirtualSectionButton('[data-testid="sidebar-add-project-button"]');
          });

          hdr.querySelector('[data-isdou-action="new-chat"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector('[data-testid="new-conversation-button"]')?.click();
          });
        }

        const dragSpacer = sidebarEl.firstElementChild;
        if (dragSpacer && hdr.parentElement !== sidebarEl) {
          dragSpacer.insertAdjacentElement('afterend', hdr);
        }
      }

      function ensureSidebarFooter(sidebarEl) {
        if (!sidebarEl) return;
        let footer = document.getElementById(FOOTER_ID);
        if (!footer) {
          footer = document.createElement('div');
          footer.id = FOOTER_ID;
          footer.setAttribute('data-ag-i18n-exclude', 'true');
          footer.innerHTML =
            '<button type="button" class="isdou-t3-icon-btn" data-isdou-action="settings" aria-label="系统设置" title="系统设置">' +
            SVG_ICONS.settings +
            '</button>' +
            '<button type="button" class="isdou-t3-icon-btn" data-isdou-action="automations" aria-label="自动化任务" title="自动化任务">' +
            SVG_ICONS.clock +
            '</button>' +
            '<button type="button" class="isdou-t3-icon-btn" data-isdou-action="customizations" aria-label="技能与自定义" title="技能与自定义">' +
            SVG_ICONS.blocks +
            '</button>';

          if (boot.updateNotice) {
            const link = document.createElement('a');
            link.className = 'isdou-release-link';
            link.href = boot.updateNotice.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '更新主题';
            link.title = '查看主题新版 v' + boot.updateNotice.version;
            footer.appendChild(link);
          }

          footer.querySelector('[data-isdou-action="settings"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector('[data-testid="settings-button"]')?.click();
          });

          footer.querySelector('[data-isdou-action="automations"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector('[data-testid="automations-button"]')?.click();
          });

          footer.querySelector('[data-isdou-action="customizations"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector('.bg-sidebar a[href="/customizations"]')?.click();
          });
        }

        if (footer.parentElement !== sidebarEl) {
          sidebarEl.appendChild(footer);
        }
      }

      function syncProjectHeader(btn, snap) {
        const iconHost = btn.querySelector('[data-testid="project-header-icon"]');
        const label =
          btn.getAttribute('data-project-label') ||
          btn.querySelector('.truncate')?.textContent?.trim() ||
          '';
        const dropHost = btn.closest('[data-sidebar-section-drop-id]');
        const pid = dropHost?.getAttribute('data-sidebar-section-drop-id') || '';
        const projInfo = snap.projectsById.get(pid) || snap.projectsByName.get(label);
        const mono = projInfo
          ? { text: projInfo.mono, cjk: projInfo.cjk, tone: projInfo.tone }
          : Object.assign(computeMonogram(label), { tone: hashTone(pid || label) });

        if (iconHost) {
          iconHost.setAttribute('data-isdou-mono', mono.text);
          iconHost.setAttribute('data-isdou-cjk', mono.cjk ? '1' : '0');
          iconHost.setAttribute('data-isdou-tone', mono.tone);
        }

        const effectivePid = projInfo?.id || pid;
        const count = effectivePid ? snap.countsByProject.get(effectivePid) || 0 : 0;
        const dot = effectivePid ? snap.dotsByProject.get(effectivePid) || 'settled' : 'settled';
        const expanded = btn.getAttribute('aria-expanded') === 'true';

        if (count > 0) btn.setAttribute('data-isdou-count', String(count));
        else btn.removeAttribute('data-isdou-count');

        const dotKind = dot === 'approval' || dot === 'input' ? 'approval' : dot === 'working' || dot === 'done' ? dot : '';
        if (dotKind) btn.setAttribute('data-isdou-dot', dotKind);
        else btn.removeAttribute('data-isdou-dot');

        const trailingSig = `${expanded ? 1 : 0}|${count}|${dotKind}`;
        let trailing = btn.querySelector(':scope > .isdou-t3-proj-trailing');
        if (!trailing || trailing.dataset.isdouSig !== trailingSig) {
          if (!trailing) {
            trailing = document.createElement('span');
            trailing.className = 'isdou-t3-proj-trailing';
            trailing.setAttribute('aria-hidden', 'true');
            trailing.setAttribute('data-ag-i18n-exclude', 'true');
            btn.appendChild(trailing);
          }
          trailing.dataset.isdouSig = trailingSig;
          let html = '';
          if (!expanded && dotKind) {
            html += `<span class="isdou-t3-proj-dot is-${dotKind}"></span>`;
          }
          if (!expanded && count > 0) {
            html += `<span class="isdou-t3-proj-count">${count}</span>`;
          }
          html += SVG_ICONS.chevronDown;
          trailing.innerHTML = html;
        }
      }

      function buildStatusPillHtml(state) {
        if (!state || state === 'settled') return '';
        const cls = state === 'input' ? 'approval' : state;
        const icon = SVG_ICONS[state] || '';
        const text = STATUS_LABELS[state] || '';
        if (!text) return '';
        return `<span class="isdou-t3-status-pill is-${cls}">${icon}<span>${text}</span></span>`;
      }

      function removeInjectedChild(row, selector) {
        const el = row.querySelector(`:scope > ${selector}`);
        if (el) el.remove();
      }

      function upsertInjectedChild(row, className, html) {
        let el = row.querySelector(`:scope > .${className}`);
        if (!html) {
          if (el) el.remove();
          return;
        }
        if (!el) {
          el = document.createElement('div');
          el.className = className;
          el.setAttribute('data-ag-i18n-exclude', 'true');
          row.appendChild(el);
        }
        if (el.innerHTML !== html) {
          el.innerHTML = html;
        }
      }

      function syncConversationRow(row, snap) {
        const cascadeId = row.getAttribute('data-cascade-id') || '';
        const s = cascadeId ? snap.sums[cascadeId] : null;
        const state = computeSummaryState(s);

        const idxHost = row.closest('[data-sidebar-section-id]');
        const sectionId = idxHost?.getAttribute('data-sidebar-section-id') || '';
        const inFolder = Boolean(sectionId && sectionId !== 'standalone' && sectionId !== 'pinned');

        const pid = s?.projectId || s?.trajectoryMetadata?.projectId || '';
        const ws = (s?.workspaces && s.workspaces[0]) || (s?.trajectoryMetadata?.workspaces && s.trajectoryMetadata.workspaces[0]) || null;
        const branch = ws?.branchName ? String(ws.branchName) : '';
        const repoBase = ws?.repository?.computedName
          ? String(ws.repository.computedName).split('/').filter(Boolean).pop()
          : '';
        let folderBase = '';
        const rawUri = ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri || (s?.trajectoryMetadata?.workspaceUris && s.trajectoryMetadata.workspaceUris[0]) || '';
        if (rawUri) {
          try {
            folderBase = decodeURIComponent(String(rawUri).split('/').filter(Boolean).pop() || '');
          } catch {
            folderBase = String(rawUri).split('/').filter(Boolean).pop() || '';
          }
        }
        const prRaw = Array.isArray(s?.codeReviewIds) ? s.codeReviewIds.find((x) => typeof x === 'string' && /\/pull\/\d+/.test(x)) : '';
        const prNum = prRaw ? prRaw.match(/\/pull\/(\d+)/)?.[1] || '' : '';

        let cardProject = null;
        if (!inFolder) {
          if (pid && pid !== 'outside-of-project' && pid !== 'standalone' && snap.projectsById.has(pid)) {
            cardProject = snap.projectsById.get(pid);
          } else {
            const derivedName = repoBase || folderBase;
            if (derivedName) {
              const mono = computeMonogram(derivedName);
              cardProject = {
                id: derivedName,
                name: derivedName,
                mono: mono.text,
                cjk: mono.cjk,
                tone: hashTone(derivedName)
              };
            }
          }
        }

        const provider = cascadeId ? resolveProviderForConv(snap.st, snap.modelEnumMap, cascadeId) : '';
        const nativeTimeEl = row.querySelector('.agy-row-status [data-screenshot-volatile="true"]');
        const nativeTimeText = nativeTimeEl?.textContent?.trim() || '';
        const timeText = nativeTimeText || formatRelTime(s?.lastModifiedTime?.seconds);
        const hasBottom = Boolean(branch || prNum);
        const hasTop = Boolean(cardProject);
        const selectedAttr = row.getAttribute('data-selected') === 'true' ? '1' : '0';

        const sig = [
          selectedAttr,
          inFolder ? '1' : '0',
          state,
          cardProject ? `${cardProject.tone}:${cardProject.mono}:${cardProject.name}` : '',
          branch,
          prNum,
          provider,
          hasTop ? timeText : ''
        ].join('\u0001');

        const domIntact =
          (!hasTop || Boolean(row.querySelector(':scope > .isdou-t3-card-top'))) &&
          (!hasBottom || Boolean(row.querySelector(':scope > .isdou-t3-card-bottom')));
        if (row.dataset.isdouSig === sig && domIntact) return;
        row.dataset.isdouSig = sig;
        row.setAttribute('data-isdou-state', state);
        if (hasTop) row.setAttribute('data-isdou-has-top', '1');
        else row.removeAttribute('data-isdou-has-top');

        if (hasTop) {
          const rightTopHtml =
            state !== 'settled'
              ? buildStatusPillHtml(state)
              : timeText
                ? `<span class="isdou-t3-top-time">${escapeHtml(timeText)}</span>`
                : '';
          const topHtml =
            `<span class="isdou-t3-card-proj">` +
            `<span class="isdou-t3-mini-mono" data-isdou-cjk="${cardProject.cjk ? '1' : '0'}" data-isdou-tone="${escapeHtml(cardProject.tone)}">${escapeHtml(cardProject.mono)}</span>` +
            `<span class="isdou-t3-card-proj-name">${escapeHtml(cardProject.name)}</span>` +
            `</span>` +
            `<span class="isdou-t3-card-right">${rightTopHtml}</span>`;
          upsertInjectedChild(row, 'isdou-t3-card-top', topHtml);
        } else {
          removeInjectedChild(row, '.isdou-t3-card-top');
        }

        if (hasBottom) {
          const branchHtml = branch
            ? `<span class="isdou-t3-branch">${SVG_ICONS.branch}<span class="isdou-t3-branch-name">${escapeHtml(branch)}</span></span>`
            : '<span></span>';
          const prHtml = prNum ? `<span class="isdou-t3-pr">#${escapeHtml(prNum)}</span>` : '';
          const provHtml = provider && PROVIDER_SVGS[provider] ? `<span class="isdou-t3-provider-glyph">${PROVIDER_SVGS[provider]}</span>` : '';
          const bottomHtml =
            `<span class="isdou-t3-bottom-left">${branchHtml}${prHtml}</span>` +
            provHtml;
          upsertInjectedChild(row, 'isdou-t3-card-bottom', bottomHtml);
          removeInjectedChild(row, '.isdou-t3-inline-meta');
        } else {
          removeInjectedChild(row, '.isdou-t3-card-bottom');
          // 无底部元信息行时，在标题行右侧克制呈现状态或模型厂商徽标（避免多余文案）
          let inlineHtml = '';
          if (!hasTop && (state === 'approval' || state === 'input' || state === 'done')) {
            inlineHtml += buildStatusPillHtml(state);
          }
          if (provider && PROVIDER_SVGS[provider]) {
            inlineHtml += `<span class="isdou-t3-provider-glyph">${PROVIDER_SVGS[provider]}</span>`;
          }
          if (inlineHtml) {
            upsertInjectedChild(row, 'isdou-t3-inline-meta', inlineHtml);
          } else {
            removeInjectedChild(row, '.isdou-t3-inline-meta');
          }
        }
      }

      function attachScrollListener(sidebarEl) {
        const scroller = sidebarEl?.querySelector('[data-testid="conversation-list-sidebar"]');
        if (scroller && scroller !== scrollElRef) {
          if (scrollElRef) scrollElRef.removeEventListener('scroll', scheduleSync);
          scrollElRef = scroller;
          scrollElRef.addEventListener('scroll', scheduleSync, { passive: true });
        }
      }

      function syncAll() {
        syncRaf = 0;
        syncTimer = 0;
        if (disposed) return;

        document.documentElement.setAttribute(BODY_ATTR, '1');
        if (document.body) {
          document.body.setAttribute(BODY_ATTR, '1');
        }

        const sidebarEl = document.querySelector('.bg-sidebar:not([data-has-browser-hole="true"])');
        if (!sidebarEl) return;

        ensureSidebarHeader(sidebarEl);
        ensureSidebarFooter(sidebarEl);
        attachScrollListener(sidebarEl);

        const snap = buildMetadataSnapshot();
        const projBtns = sidebarEl.querySelectorAll('button[data-testid="project-header"]');
        for (const btn of projBtns) {
          syncProjectHeader(btn, snap);
        }
        const convRows = sidebarEl.querySelectorAll('[data-testid="conversation-row-sidebar"]');
        for (const row of convRows) {
          syncConversationRow(row, snap);
        }
      }

      function scheduleSync() {
        if (disposed || syncRaf || syncTimer) return;
        syncRaf = setTimeout(() => {
          syncRaf = 0;
          syncAll();
        }, 16);
      }

      function scheduleDelayedSync() {
        if (disposed || syncTimer) return;
        syncTimer = setTimeout(() => {
          syncTimer = 0;
          scheduleSync();
        }, 60);
      }

      function ensureStoreSubscribed() {
        if (storeUnsub) return true;
        const { store } = resolveAppHandles();
        if (!store || typeof store.subscribe !== 'function') return false;
        storeUnsub = store.subscribe(() => {
          scheduleDelayedSync();
        });
        return true;
      }

      function mountObservers() {
        if (disposed) return;
        document.documentElement.setAttribute(BODY_ATTR, '1');
        if (document.body) {
          document.body.setAttribute(BODY_ATTR, '1');
        }
        if (typeof MutationObserver !== 'undefined' && document.body && !bodyObs) {
          bodyObs = new MutationObserver((mutations) => {
            for (const m of mutations) {
              const target = m.target;
              if (target && target.nodeType === 1) {
                if (
                  target.id === HEADER_ID ||
                  target.id === FOOTER_ID ||
                  target.closest?.(`#${HEADER_ID}, #${FOOTER_ID}, .isdou-t3-card-top, .isdou-t3-card-bottom, .isdou-t3-inline-meta, .isdou-t3-proj-trailing`)
                ) {
                  continue;
                }
              }
              scheduleSync();
              break;
            }
          });
          bodyObs.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-expanded', 'data-selected', 'data-cascade-id']
          });
        }
        ensureStoreSubscribed();
        syncAll();
      }

      document.documentElement.setAttribute(BODY_ATTR, '1');
      if (document.body) {
        mountObservers();
      } else {
        window.addEventListener('DOMContentLoaded', mountObservers, { once: true });
      }

      let initTries = 0;
      initPollTimer = setInterval(() => {
        initTries++;
        const ok = ensureStoreSubscribed();
        if (document.body && !bodyObs) mountObservers();
        syncAll();
        if ((ok && document.querySelector('.bg-sidebar')) || initTries > 40) {
          clearInterval(initPollTimer);
          initPollTimer = 0;
        }
      }, 200);

      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        window.removeEventListener('DOMContentLoaded', mountObservers);
        if (bodyObs) bodyObs.disconnect();
        if (storeUnsub) {
          try {
            storeUnsub();
          } catch {}
        }
        if (scrollElRef) scrollElRef.removeEventListener('scroll', scheduleSync);
        if (syncRaf) clearTimeout(syncRaf);
        if (syncTimer) clearTimeout(syncTimer);
        if (initPollTimer) clearInterval(initPollTimer);
        document.documentElement.removeAttribute(BODY_ATTR);
        if (document.body) document.body.removeAttribute(BODY_ATTR);
        document.getElementById(HEADER_ID)?.remove();
        document.getElementById(FOOTER_ID)?.remove();
        document
          .querySelectorAll('.isdou-t3-proj-trailing, .isdou-t3-card-top, .isdou-t3-card-bottom, .isdou-t3-inline-meta')
          .forEach((el) => el.remove());
        document
          .querySelectorAll('[data-isdou-mono], [data-isdou-cjk], [data-isdou-tone], [data-isdou-count], [data-isdou-dot], [data-isdou-state], [data-isdou-has-top], [data-isdou-sig]')
          .forEach((el) => {
            el.removeAttribute('data-isdou-mono');
            el.removeAttribute('data-isdou-cjk');
            el.removeAttribute('data-isdou-tone');
            el.removeAttribute('data-isdou-count');
            el.removeAttribute('data-isdou-dot');
            el.removeAttribute('data-isdou-state');
            el.removeAttribute('data-isdou-has-top');
            el.removeAttribute('data-isdou-sig');
          });
      });
    })();
  }
