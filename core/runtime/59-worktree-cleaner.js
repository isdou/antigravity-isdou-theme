/**
 * Part 59: Worktree Cleaner 内置 Git Worktree 可视化清理与缓存瘦身工作台
 * - 入口：左侧边栏底栏独立 Git 分支图标（通过 __isdouSidebarTools 注册）或全局快捷键 ⌘⇧W / Ctrl+Shift+W
 * - 能力：扫描 Codex/Claude/Cursor/Trae 遗留 Worktree · 预览 Diff · 瘦身构建缓存 · 备份 .env · 推送分支 · 安全移入废纸篓 · Prune 幽灵记录
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.worktreeCleaner !== false) {
    (() => {
      const BACKDROP_ID = 'isdou-wtc-backdrop';
      const MODAL_ID = 'isdou-wtc-modal';
      const TOOL_ID = 'worktree-cleaner';
      const SHORTCUT_LABEL = boot.platform === 'darwin' ? '⌘⇧W' : 'Ctrl+Shift+W';

      const WTC_SVG =
        '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="4.25" cy="3.5" r="1.75"/>' +
        '<circle cx="4.25" cy="12.5" r="1.75"/>' +
        '<circle cx="11.75" cy="6" r="1.75"/>' +
        '<path d="M4.25 5.25v5.5"/>' +
        '<path d="M11.75 7.75c0 2.5-2.2 3.25-7.5 3.25"/>' +
        '</svg>';

      let isOpen = false;
      let isLoading = false;
      let scanData = null;
      let filterStatus = 'all';
      let filterSource = 'all';
      let selectedPath = '';
      let diffCache = new Map();
      let diffLoadingPath = '';
      let pendingConfirmKey = '';
      let toastTimer = null;
      let toastState = null;

      let reqSeq = 1;
      const pendingReqs = new Map();

      window.__ag_on_worktree_response = (reqId, payload) => {
        const cb = pendingReqs.get(String(reqId));
        if (!cb) return;
        pendingReqs.delete(String(reqId));
        cb(payload);
      };

      function callBackend(payload) {
        return new Promise((resolve) => {
          if (typeof window.__agWorktreeRequest !== 'function') {
            resolve({ ok: false, error: 'Worktree Cleaner 守护进程未连接，请重启主题守护服务' });
            return;
          }
          const reqId = 'wtc_' + Date.now() + '_' + reqSeq++;
          const timer = setTimeout(() => {
            if (pendingReqs.has(reqId)) {
              pendingReqs.delete(reqId);
              resolve({ ok: false, error: '操作超时，请重试' });
            }
          }, 35000);
          pendingReqs.set(reqId, (res) => {
            clearTimeout(timer);
            resolve(res || { ok: false, error: '空响应' });
          });
          try {
            window.__agWorktreeRequest(JSON.stringify(Object.assign({ reqId }, payload)));
          } catch (err) {
            clearTimeout(timer);
            pendingReqs.delete(reqId);
            resolve({ ok: false, error: err?.message || '调用失败' });
          }
        });
      }

      function esc(str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      }

      function formatRelTime(ms) {
        if (!ms) return '';
        const diff = Math.max(0, Date.now() - ms);
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return mins <= 1 ? '刚刚' : mins + ' 分钟前';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + ' 小时前';
        const days = Math.floor(hrs / 24);
        return days + ' 天前';
      }

      function statusMeta(st) {
        if (st === 'safe') return { label: '可安全清理', cls: 'is-safe' };
        if (st === 'dirty') return { label: '有未提交修改', cls: 'is-dirty' };
        if (st === 'unpushed') return { label: '未推送提交', cls: 'is-unpushed' };
        if (st === 'missing') return { label: '幽灵记录', cls: 'is-missing' };
        return { label: st, cls: '' };
      }

      function showToast(msg, tone = 'ok') {
        toastState = { msg, tone };
        if (toastTimer) clearTimeout(toastTimer);
        render();
        toastTimer = setTimeout(() => {
          toastState = null;
          render();
        }, 2800);
      }

      function syncSidebarBadge() {
        const s = scanData?.summary;
        const hasAlert = Boolean(s && (s.missingCount > 0 || s.safeCount > 0 || s.cacheBytes >= 200 * 1024 * 1024));
        window.__isdouSidebarTools?.setBadge?.(TOOL_ID, hasAlert);
      }

      async function refreshScan(silent = false) {
        if (!silent) {
          isLoading = true;
          render();
        }
        const res = await callBackend({ action: 'scan' });
        isLoading = false;
        if (res && res.ok) {
          scanData = res;
          diffCache.clear();
          syncSidebarBadge();
          if (selectedPath && !res.items.some((x) => x.path === selectedPath)) {
            selectedPath = '';
          }
          if (!selectedPath && res.items.length > 0) {
            selectedPath = res.items[0].path;
          }
          if (!silent && selectedPath) {
            void loadDiff(selectedPath);
          }
        } else if (!silent) {
          showToast(res?.error || '扫描失败', 'err');
        }
        if (!silent) render();
      }

      async function loadDiff(targetPath) {
        if (!targetPath || diffCache.has(targetPath)) return;
        diffLoadingPath = targetPath;
        render();
        const res = await callBackend({ action: 'diff', path: targetPath });
        if (diffLoadingPath === targetPath) diffLoadingPath = '';
        if (res && res.ok) {
          diffCache.set(targetPath, res);
        } else {
          diffCache.set(targetPath, { statusLines: [], commits: [], diffText: res?.error || '无法读取 Diff' });
        }
        render();
      }

      function getFilteredItems() {
        const all = scanData?.items || [];
        return all.filter((it) => {
          if (filterStatus !== 'all' && it.status !== filterStatus) return false;
          if (filterSource !== 'all' && it.source !== filterSource) return false;
          return true;
        });
      }

      function renderDiffLines(text) {
        return String(text || '')
          .split('\n')
          .map((line) => {
            let cls = 'wtc-diff-ctx';
            if (line.startsWith('+') && !line.startsWith('+++')) cls = 'wtc-diff-add';
            else if (line.startsWith('-') && !line.startsWith('---')) cls = 'wtc-diff-del';
            else if (line.startsWith('@@') || line.startsWith('diff --git')) cls = 'wtc-diff-hdr';
            return `<div class="${cls}">${esc(line || ' ')}</div>`;
          })
          .join('');
      }

      function ensureBackdrop() {
        let bd = document.getElementById(BACKDROP_ID);
        if (bd) return bd;
        bd = document.createElement('div');
        bd.id = BACKDROP_ID;
        bd.setAttribute('data-ag-i18n-exclude', 'true');
        bd.innerHTML = `<div id="${MODAL_ID}" role="dialog" aria-label="Worktree Cleaner"></div>`;
        bd.addEventListener('click', (e) => {
          if (e.target === bd) close();
        });
        const modal = bd.querySelector('#' + MODAL_ID);
        modal.addEventListener('click', handleModalClick);
        document.body.appendChild(bd);
        return bd;
      }

      async function handleModalClick(e) {
        const el = e.target.closest('[data-wtc-act]');
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();

        const act = el.getAttribute('data-wtc-act');
        const val = el.getAttribute('data-wtc-val') || '';

        if (act === 'close') {
          close();
          return;
        }
        if (act === 'refresh') {
          pendingConfirmKey = '';
          await refreshScan(false);
          return;
        }
        if (act === 'filter-status') {
          filterStatus = val;
          pendingConfirmKey = '';
          render();
          return;
        }
        if (act === 'filter-source') {
          filterSource = val;
          pendingConfirmKey = '';
          render();
          return;
        }
        if (act === 'select') {
          selectedPath = val;
          pendingConfirmKey = '';
          render();
          void loadDiff(val);
          return;
        }
        if (act === 'reveal') {
          await callBackend({ action: 'reveal', path: val });
          return;
        }
        if (act === 'prune') {
          isLoading = true;
          render();
          const res = await callBackend({ action: 'prune' });
          isLoading = false;
          if (res?.ok) {
            scanData = res.scan;
            syncSidebarBadge();
            showToast('已清理幽灵 Worktree 记录', 'ok');
          } else {
            showToast(res?.error || 'Prune 失败', 'err');
          }
          return;
        }
        if (act === 'slim') {
          isLoading = true;
          render();
          const res = await callBackend({ action: 'slim', path: val });
          isLoading = false;
          if (res?.ok) {
            scanData = res.scan;
            syncSidebarBadge();
            showToast(`已瘦身 ${res.count} 个缓存目录，释放 ${formatBytes(res.reclaimedBytes)}`, 'ok');
          } else {
            showToast(res?.error || '瘦身失败', 'err');
          }
          return;
        }
        if (act === 'copy-precious') {
          const res = await callBackend({ action: 'copyPrecious', path: val });
          if (res?.ok) {
            showToast(`已备份 ${res.copied} 个珍贵文件到主仓库（跳过已存在 ${res.skipped} 个）`, 'ok');
          } else {
            showToast(res?.error || '备份失败', 'err');
          }
          return;
        }
        if (act === 'push') {
          isLoading = true;
          render();
          const res = await callBackend({ action: 'push', path: val });
          isLoading = false;
          if (res?.ok) {
            scanData = res.scan;
            syncSidebarBadge();
            showToast(`已推送分支 ${res.branch}`, 'ok');
          } else {
            showToast(res?.error || '推送失败', 'err');
          }
          return;
        }
        if (act === 'remove') {
          const cKey = 'rm:' + val;
          if (pendingConfirmKey !== cKey) {
            pendingConfirmKey = cKey;
            render();
            return;
          }
          pendingConfirmKey = '';
          isLoading = true;
          render();
          const res = await callBackend({ action: 'remove', paths: [val] });
          isLoading = false;
          if (res?.ok) {
            scanData = res.scan;
            selectedPath = scanData.items[0]?.path || '';
            syncSidebarBadge();
            showToast(`已安全移入废纸篓，释放 ${formatBytes(res.reclaimedBytes)}`, 'ok');
            if (selectedPath) void loadDiff(selectedPath);
          } else {
            showToast(res?.error || '移除失败', 'err');
          }
          return;
        }
        if (act === 'clean-safe') {
          const safePaths = (scanData?.items || []).filter((x) => x.status === 'safe').map((x) => x.path);
          if (!safePaths.length) return;
          if (pendingConfirmKey !== 'clean-safe') {
            pendingConfirmKey = 'clean-safe';
            render();
            return;
          }
          pendingConfirmKey = '';
          isLoading = true;
          render();
          const res = await callBackend({ action: 'remove', paths: safePaths });
          isLoading = false;
          if (res?.ok) {
            scanData = res.scan;
            selectedPath = scanData.items[0]?.path || '';
            syncSidebarBadge();
            showToast(`已批量移入废纸篓 ${res.removed} 个安全 Worktree，释放 ${formatBytes(res.reclaimedBytes)}`, 'ok');
          } else {
            showToast(res?.error || '批量清理失败', 'err');
          }
        }
      }

      function render() {
        const bd = document.getElementById(BACKDROP_ID);
        if (!bd) return;
        const modal = bd.querySelector('#' + MODAL_ID);
        if (!modal) return;

        const sum = scanData?.summary || {
          totalCount: 0,
          safeCount: 0,
          dirtyCount: 0,
          unpushedCount: 0,
          missingCount: 0,
          totalBytes: 0,
          cacheBytes: 0,
          safeBytes: 0
        };
        const items = getFilteredItems();
        const sources = Array.from(new Set((scanData?.items || []).map((x) => x.source)));
        const sel = (scanData?.items || []).find((x) => x.path === selectedPath) || items[0] || null;
        if (sel && sel.path !== selectedPath) selectedPath = sel.path;

        const topbarHtml = `
          <div class="wtc-topbar">
            <div class="wtc-brand">
              <span class="wtc-logo">${WTC_SVG}</span>
              <span>Worktree Cleaner</span>
              <span class="wtc-kbd">${SHORTCUT_LABEL}</span>
            </div>
            <div class="wtc-top-actions">
              ${sum.missingCount > 0 ? `<button type="button" class="wtc-btn" data-wtc-act="prune">Prune 幽灵 (${sum.missingCount})</button>` : ''}
              ${
                sum.safeCount > 0
                  ? `<button type="button" class="wtc-btn ${pendingConfirmKey === 'clean-safe' ? 'is-danger' : 'is-accent'}" data-wtc-act="clean-safe">${
                      pendingConfirmKey === 'clean-safe'
                        ? `再次点击确认移入废纸篓 (${sum.safeCount})`
                        : `清理安全项 (${sum.safeCount} · ${formatBytes(sum.safeBytes)})`
                    }</button>`
                  : ''
              }
              <button type="button" class="wtc-icon-btn" data-wtc-act="refresh" title="重新扫描">↻</button>
              <button type="button" class="wtc-icon-btn" data-wtc-act="close" title="关闭 (Esc)">✕</button>
            </div>
          </div>
        `;

        const statsHtml = `
          <div class="wtc-stats">
            <div class="wtc-stat"><span class="wtc-stat-k">已发现</span><span class="wtc-stat-v">${sum.totalCount}</span></div>
            <div class="wtc-stat"><span class="wtc-stat-k">总占盘</span><span class="wtc-stat-v">${formatBytes(sum.totalBytes)}</span></div>
            <div class="wtc-stat"><span class="wtc-stat-k">可瘦身缓存</span><span class="wtc-stat-v is-amber">${formatBytes(sum.cacheBytes)}</span></div>
            <div class="wtc-stat"><span class="wtc-stat-k">可安全清理</span><span class="wtc-stat-v is-green">${sum.safeCount} 项</span></div>
          </div>
        `;

        const statusTabs = [
          ['all', `全部 ${sum.totalCount}`],
          ['safe', `可清理 ${sum.safeCount}`],
          ['dirty', `有改动 ${sum.dirtyCount}`],
          ['unpushed', `未推送 ${sum.unpushedCount}`],
          ['missing', `幽灵 ${sum.missingCount}`]
        ];
        const filterHtml = `
          <div class="wtc-filters">
            <div class="wtc-pill-group">
              ${statusTabs
                .map(
                  ([k, lbl]) =>
                    `<button type="button" class="wtc-pill${filterStatus === k ? ' is-active' : ''}" data-wtc-act="filter-status" data-wtc-val="${k}">${lbl}</button>`
                )
                .join('')}
            </div>
            ${
              sources.length > 1
                ? `<div class="wtc-pill-group">
                    <button type="button" class="wtc-pill${filterSource === 'all' ? ' is-active' : ''}" data-wtc-act="filter-source" data-wtc-val="all">全部来源</button>
                    ${sources
                      .map(
                        (s) =>
                          `<button type="button" class="wtc-pill${filterSource === s ? ' is-active' : ''}" data-wtc-act="filter-source" data-wtc-val="${esc(s)}">${esc(s)}</button>`
                      )
                      .join('')}
                  </div>`
                : ''
            }
          </div>
        `;

        const listHtml =
          isLoading && !scanData
            ? '<div class="wtc-empty">正在扫描本机 Git Worktrees 与构建缓存…</div>'
            : items.length === 0
            ? '<div class="wtc-empty">当前筛选下没有遗留 Worktree，磁盘很干净 ✨</div>'
            : items
                .map((it) => {
                  const st = statusMeta(it.status);
                  const active = sel && sel.path === it.path;
                  return `
                    <button type="button" class="wtc-row${active ? ' is-selected' : ''}" data-wtc-act="select" data-wtc-val="${esc(it.path)}">
                      <div class="wtc-row-top">
                        <span class="wtc-src">${esc(it.source)}</span>
                        <span class="wtc-repo">${esc(it.repoName)}</span>
                        <span class="wtc-size">${formatBytes(it.totalBytes)}</span>
                      </div>
                      <div class="wtc-row-branch">${esc(it.branch)}</div>
                      <div class="wtc-row-meta">
                        <span class="wtc-badge ${st.cls}">${st.label}</span>
                        ${it.cacheBytes > 0 ? `<span class="wtc-cache-tag">缓存 ${formatBytes(it.cacheBytes)}</span>` : ''}
                        ${it.precious.length > 0 ? `<span class="wtc-precious-tag">含 .env (${it.precious.length})</span>` : ''}
                        <span class="wtc-time">${formatRelTime(it.mtimeMs)}</span>
                      </div>
                    </button>
                  `;
                })
                .join('');

        let detailHtml = '<div class="wtc-empty">选择左侧任意 Worktree 查看改动与清理选项</div>';
        if (sel) {
          const st = statusMeta(sel.status);
          const diffObj = diffCache.get(sel.path);
          const isDiffLoading = diffLoadingPath === sel.path && !diffObj;
          const rmConfirm = pendingConfirmKey === 'rm:' + sel.path;

          detailHtml = `
            <div class="wtc-detail-head">
              <div>
                <div class="wtc-detail-title">
                  <span>${esc(sel.repoName)}</span>
                  <span class="wtc-badge ${st.cls}">${st.label}</span>
                </div>
                <div class="wtc-detail-sub">${esc(sel.branch)} · ${esc(sel.path)}</div>
              </div>
              <button type="button" class="wtc-btn" data-wtc-act="reveal" data-wtc-val="${esc(sel.path)}">Finder 打开</button>
            </div>

            <div class="wtc-detail-scroll">
              ${
                sel.precious.length > 0
                  ? `<div class="wtc-alert">
                      <div>检测到 ${sel.precious.length} 个未追踪本地文件：<code>${esc(sel.precious.map((p) => p.relPath).join(', '))}</code></div>
                      <button type="button" class="wtc-btn" data-wtc-act="copy-precious" data-wtc-val="${esc(sel.path)}">备份到主仓库</button>
                    </div>`
                  : ''
              }
              ${
                sel.caches.length > 0
                  ? `<div class="wtc-section">
                      <div class="wtc-sec-hdr">
                        <span>可瘦身构建缓存（共 ${formatBytes(sel.cacheBytes)}）</span>
                        <button type="button" class="wtc-btn is-accent" data-wtc-act="slim" data-wtc-val="${esc(sel.path)}">一键瘦身缓存</button>
                      </div>
                      <div class="wtc-chip-wrap">
                        ${sel.caches.map((c) => `<span class="wtc-mini-chip">${esc(c.relPath)} · ${formatBytes(c.bytes)}</span>`).join('')}
                      </div>
                    </div>`
                  : ''
              }
              <div class="wtc-section">
                <div class="wtc-sec-hdr"><span>最近提交与改动预览</span></div>
                ${
                  isDiffLoading || !diffObj
                    ? '<div class="wtc-muted">读取 git status 与 diff 中…</div>'
                    : `
                      ${
                        diffObj?.commits?.length
                          ? `<div class="wtc-commits">${diffObj.commits
                              .slice(0, 4)
                              .map((c) => `<div>${esc(c)}</div>`)
                              .join('')}</div>`
                          : ''
                      }
                      ${
                        diffObj?.statusLines?.length
                          ? `<div class="wtc-status-box">${diffObj.statusLines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
                          : ''
                      }
                      <pre class="wtc-diff-pre">${renderDiffLines(diffObj?.diffText || '')}</pre>
                    `
                }
              </div>
            </div>

            <div class="wtc-detail-foot">
              <div class="wtc-foot-left">
                ${sel.unpushedCount > 0 && !sel.detached ? `<button type="button" class="wtc-btn" data-wtc-act="push" data-wtc-val="${esc(sel.path)}">推送分支 (${sel.unpushedCount})</button>` : ''}
                ${sel.cacheBytes > 0 ? `<button type="button" class="wtc-btn" data-wtc-act="slim" data-wtc-val="${esc(sel.path)}">瘦身缓存 (${formatBytes(sel.cacheBytes)})</button>` : ''}
              </div>
              <button type="button" class="wtc-btn ${rmConfirm ? 'is-danger-solid' : 'is-danger'}" data-wtc-act="remove" data-wtc-val="${esc(sel.path)}">
                ${rmConfirm ? '确认移入系统废纸篓' : sel.status === 'missing' ? '移除幽灵记录' : '安全移入废纸篓'}
              </button>
            </div>
          `;
        }

        const toastHtml = toastState
          ? `<div class="wtc-toast ${toastState.tone === 'err' ? 'is-err' : 'is-ok'}">${esc(toastState.msg)}</div>`
          : '';

        modal.innerHTML = `
          ${topbarHtml}
          ${statsHtml}
          ${filterHtml}
          <div class="wtc-body">
            <div class="wtc-list">${listHtml}</div>
            <div class="wtc-detail">${detailHtml}</div>
          </div>
          ${toastHtml}
        `;
      }

      function open() {
        const bd = ensureBackdrop();
        isOpen = true;
        pendingConfirmKey = '';
        bd.setAttribute('data-open', 'true');
        render();
        void refreshScan(false);
      }

      function close() {
        isOpen = false;
        pendingConfirmKey = '';
        const bd = document.getElementById(BACKDROP_ID);
        if (bd) bd.removeAttribute('data-open');
      }

      function toggle() {
        if (isOpen) close();
        else open();
      }

      const onKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && String(e.key || '').toLowerCase() === 'w') {
          e.preventDefault();
          e.stopPropagation();
          toggle();
          return;
        }
        if (isOpen && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      };

      window.addEventListener('keydown', onKeyDown, true);

      // 通过底栏扩展注册位挂载独立图标（不硬编码进侧边栏）
      const registerTool = () => {
        window.__isdouSidebarTools?.register?.({
          id: TOOL_ID,
          title: `Worktree Cleaner (${SHORTCUT_LABEL})`,
          ariaLabel: 'Worktree Cleaner 清理工作台',
          svg: WTC_SVG,
          order: 20,
          onClick: toggle
        });
      };
      registerTool();
      const regTimer = setTimeout(registerTool, 600);
      const warmupTimer = setTimeout(() => {
        void refreshScan(true);
      }, 2800);

      window.__isdouWorktreeCleaner = { open, close, toggle, refresh: () => refreshScan(false) };

      window.__ag_cleanup_fns.push(() => {
        clearTimeout(regTimer);
        clearTimeout(warmupTimer);
        if (toastTimer) clearTimeout(toastTimer);
        window.removeEventListener('keydown', onKeyDown, true);
        window.__isdouSidebarTools?.unregister?.(TOOL_ID);
        document.getElementById(BACKDROP_ID)?.remove();
        delete window.__isdouWorktreeCleaner;
        delete window.__ag_on_worktree_response;
      });
    })();
  }
