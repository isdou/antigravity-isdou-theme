/**
 * Part 55: 侧边栏项目列表折叠隐藏（三个点菜单新增「在列表中隐藏」+ 一键恢复浮窗）
 *
 * - 在每个项目行的「三个点」/ 右键菜单内注入「在列表中隐藏」选项（位于删除项目之前）
 * - 通过包装 core.projectManagementService.projectsStateProvider 复用原生过滤与虚拟列表重排，零空白占位间隙
 * - 当存在被隐藏项目时，在「项目管理」标题右侧显示紧凑徽badge「隐藏 N」，点击可随时单个恢复或全部恢复
 * - 隐藏关系仅持久化在本地 localStorage（isdou.hiddenProjectsV1），不修改服务端/项目文件
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.projectHider !== false) {
    (() => {
      const STORAGE_KEY = 'isdou.hiddenProjectsV1';
      const HIDE_MENU_TESTID = 'isdou-project-hide-item';
      const BADGE_ID = 'isdou-hidden-projects-btn';
      const POPOVER_ID = 'isdou-hidden-projects-popover';
      const TOAST_ID = 'isdou-drop-toast';

      let disposed = false;
      let pmsRef = null;
      let pspRef = null;
      let rppRef = null;
      let rppEmitterRef = null;
      let lastRawArr = null;
      let lastHiddenSig = '';
      let lastMappedArr = null;
      let lastMenuTarget = null;
      let popoverOpen = false;
      let syncTimer = 0;
      let initPollTimer = 0;
      let toastTimer = 0;
      let bodyObs = null;

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function showToast(text, tone = 'info') {
        if (!document.body || !text) return;
        let toast = document.getElementById(TOAST_ID);
        if (!toast) {
          toast = document.createElement('div');
          toast.id = TOAST_ID;
          toast.setAttribute('data-ag-i18n-exclude', 'true');
          document.body.appendChild(toast);
        }
        toast.dataset.tone = tone;
        toast.textContent = text;
        toast.classList.add('is-visible');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toast.classList.remove('is-visible');
        }, 2600);
      }

      function readHiddenMap() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return {};
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      }

      function writeHiddenMap(map) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        } catch {}
      }

      function getHiddenSig(map) {
        const keys = Object.keys(map || {}).sort();
        return keys.join('\u0001');
      }

      function getFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        return key ? el[key] : null;
      }

      function findProjectManagementService() {
        if (pmsRef && pmsRef.projectsStateProvider) return pmsRef;
        const anchors = [
          document.querySelector('[data-testid="project-header"]'),
          document.querySelector('[data-testid="sidebar-add-project-button"]'),
          document.querySelector('.bg-sidebar'),
          document.getElementById('root')?.firstElementChild
        ];
        for (const anchor of anchors) {
          let cur = getFiber(anchor);
          let guard = 0;
          while (cur && guard++ < 85) {
            let dep = cur.dependencies?.firstContext;
            while (dep) {
              const pms = dep.memoizedValue?.core?.projectManagementService;
              if (pms && pms.projectsStateProvider) {
                pmsRef = pms;
                return pms;
              }
              dep = dep.next;
            }
            cur = cur.return;
          }
        }
        return null;
      }

      function applyHiddenToArray(raw, hiddenMap) {
        if (!Array.isArray(raw)) return raw;
        const sig = getHiddenSig(hiddenMap);
        if (raw === lastRawArr && sig === lastHiddenSig && lastMappedArr) {
          return lastMappedArr;
        }
        lastRawArr = raw;
        lastHiddenSig = sig;
        if (!sig) {
          lastMappedArr = raw;
          return raw;
        }
        lastMappedArr = raw.map((item) => {
          const pid = item?.project?.id;
          if (!pid || !hiddenMap[pid] || item.project.archived) return item;
          return {
            ...item,
            project: { ...item.project, archived: true }
          };
        });
        return lastMappedArr;
      }

      function applyHiddenToMap(rawMap, hiddenMap) {
        if (!(rawMap instanceof Map)) return rawMap;
        const sig = getHiddenSig(hiddenMap);
        if (!sig) return rawMap;
        const nextMap = new Map();
        for (const [pid, item] of rawMap.entries()) {
          if (hiddenMap[pid] && item?.project && !item.project.archived) {
            nextMap.set(pid, {
              ...item,
              project: { ...item.project, archived: true }
            });
          } else {
            nextMap.set(pid, item);
          }
        }
        return nextMap;
      }

      function getRppEmitter(rpp) {
        if (!rpp || typeof rpp !== 'object') return null;
        if (rppEmitterRef && typeof rppEmitterRef.fire === 'function') return rppEmitterRef;
        const emitterKey = Object.keys(rpp).find(
          (k) => k.endsWith('__onDidChange') && typeof rpp[k]?.fire === 'function'
        );
        if (emitterKey) {
          rppEmitterRef = rpp[emitterKey];
          return rppEmitterRef;
        }
        return null;
      }

      function ensureProjectsProviderPatched() {
        const pms = findProjectManagementService();
        if (!pms) return false;
        const psp = pms.projectsStateProvider;
        const rpp = pms.richProjectsProvider;
        if (!psp || typeof psp.getState !== 'function') return false;

        pmsRef = pms;
        pspRef = psp;
        rppRef = rpp || null;

        if (!psp.__isdouPatched) {
          const origGetState = psp.getState.bind(psp);
          psp.__isdouOrigGetState = origGetState;
          psp.__isdouPatched = true;
          psp.getState = () => applyHiddenToArray(origGetState(), readHiddenMap());
        }

        // Antigravity 的 yl/Al hook 更新依赖 richProjectsProvider -> Fh emitter 推送的新数组，
        // 保持 rpp.state 为干净原始 Map，仅在触发订阅回调时推送映射后的视图，避免污染真实数据
        if (rpp && !rpp.__isdouPatched && typeof rpp.setState === 'function') {
          const emitter = getRppEmitter(rpp);
          const origSetState = rpp.setState.bind(rpp);
          rpp.__isdouOrigSetState = origSetState;
          if (emitter && typeof emitter.fire === 'function') {
            rpp.__isdouOrigFire = emitter.fire.bind(emitter);
          }
          rpp.__isdouPatched = true;
          rpp.setState = (nextRawMap) => {
            const raw = nextRawMap instanceof Map ? nextRawMap : rpp.getState();
            const hiddenMap = readHiddenMap();
            if (rpp.__isdouOrigFire) {
              rpp.state = raw;
              rpp.__isdouOrigFire(applyHiddenToMap(raw, hiddenMap));
            } else {
              origSetState(applyHiddenToMap(raw, hiddenMap));
            }
          };
        }

        // 防止通过缓存的 project 对象保存设置时把本地隐藏伪造的 archived:true 写入服务端
        if (typeof pms.updateProject === 'function' && !pms.__isdouUpdatePatched) {
          const origUpdate = pms.updateProject.bind(pms);
          pms.__isdouOrigUpdateProject = origUpdate;
          pms.__isdouUpdatePatched = true;
          pms.updateProject = (proj, files) => {
            if (proj && proj.id && proj.archived === true) {
              const hiddenMap = readHiddenMap();
              const realProj = rpp?.getState?.()?.get?.(proj.id)?.project;
              if (hiddenMap[proj.id] && (!realProj || !realProj.archived)) {
                proj = { ...proj, archived: false };
              }
            }
            return origUpdate(proj, files);
          };
        }

        return true;
      }

      function triggerSidebarRefresh() {
        lastRawArr = null;
        lastHiddenSig = '';
        lastMappedArr = null;
        const pms = findProjectManagementService();
        if (!pms) return;
        ensureProjectsProviderPatched();
        const rpp = pms.richProjectsProvider;
        if (rpp && typeof rpp.getState === 'function') {
          try {
            const cur = rpp.getState();
            if (cur instanceof Map) {
              if (rpp.__isdouOrigFire) {
                rpp.__isdouOrigFire(applyHiddenToMap(cur, readHiddenMap()));
              } else if (typeof rpp.setState === 'function') {
                rpp.setState(new Map(cur));
              }
            }
          } catch {}
        }
      }

      function getHiddenList() {
        const hiddenMap = readHiddenMap();
        const entries = Object.values(hiddenMap).filter((x) => x && x.id);
        if (entries.length === 0) return [];
        const pms = findProjectManagementService();
        const liveMap = pms?.richProjectsProvider?.getState?.();
        return entries
          .map((item) => {
            const live = liveMap instanceof Map ? liveMap.get(item.id) : null;
            return {
              id: item.id,
              name: live?.project?.name || item.name || item.id,
              hiddenAt: item.hiddenAt || 0
            };
          })
          .sort((a, b) => (b.hiddenAt || 0) - (a.hiddenAt || 0));
      }

      function hideProject(projectId, projectName = '') {
        if (!projectId) return false;
        const map = readHiddenMap();
        if (map[projectId]) {
          ensureProjectsProviderPatched();
          triggerSidebarRefresh();
          syncHiddenBadge();
          return true;
        }
        map[projectId] = {
          id: projectId,
          name: projectName || projectId,
          hiddenAt: Date.now()
        };
        writeHiddenMap(map);
        ensureProjectsProviderPatched();
        triggerSidebarRefresh();
        syncHiddenBadge();
        showToast(`已隐藏文件夹 · ${projectName || projectId}（点“隐藏”可随时恢复）`, 'info');
        return true;
      }

      function unhideProject(projectId) {
        if (!projectId) return false;
        const map = readHiddenMap();
        if (!Object.prototype.hasOwnProperty.call(map, projectId)) return false;
        const name = map[projectId]?.name || projectId;
        delete map[projectId];
        writeHiddenMap(map);
        ensureProjectsProviderPatched();
        triggerSidebarRefresh();
        syncHiddenBadge();
        if (popoverOpen) {
          if (getHiddenList().length === 0) closePopover();
          else renderPopover();
        }
        showToast(`已恢复显示 · ${name}`, 'ok');
        return true;
      }

      function unhideAllProjects() {
        const list = getHiddenList();
        if (list.length === 0) return;
        writeHiddenMap({});
        ensureProjectsProviderPatched();
        triggerSidebarRefresh();
        closePopover();
        syncHiddenBadge();
        showToast(`已恢复全部 ${list.length} 个隐藏文件夹`, 'ok');
      }

      function resolveProjectFromContainer(containerEl) {
        if (!containerEl) return null;
        const hdr = containerEl.querySelector('[data-testid="project-header"]');
        const label =
          hdr?.getAttribute('data-project-label') ||
          hdr?.querySelector('.truncate')?.textContent?.trim() ||
          '';
        let cur = getFiber(hdr || containerEl);
        let guard = 0;
        let projectId = '';
        while (cur && guard++ < 14) {
          const p = cur.memoizedProps;
          if (p && typeof p.projectId === 'string' && p.projectId) {
            projectId = p.projectId;
            break;
          }
          cur = cur.return;
        }
        return projectId ? { id: projectId, name: label || projectId } : null;
      }

      function onCaptureMenuTrigger(ev) {
        const target = ev.target;
        if (!target || typeof target.closest !== 'function') return;
        const container = target.closest('[data-testid="project-header-container"]');
        if (!container) return;
        const info = resolveProjectFromContainer(container);
        if (!info) return;
        const triggerBtn = target.closest('button[aria-haspopup="menu"]');
        lastMenuTarget = {
          id: info.id,
          name: info.name,
          triggerBtnId: triggerBtn?.id || '',
          at: Date.now()
        };
        setTimeout(() => injectHideItemIntoOpenMenus(), 0);
      }

      function buildHideMenuItem(ctx) {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '-1');
        item.setAttribute('data-testid', HIDE_MENU_TESTID);
        item.setAttribute('data-ag-i18n-exclude', 'true');
        item.dataset.projectId = ctx.id;
        item.className =
          'agy-overlay-item group w-full pr-2 pl-2 [&:has(>svg:first-child)]:pl-1.5 text-left text-compact cursor-pointer data-[disabled]:cursor-not-allowed outline-none no-focus-ring transition-colors select-none flex items-center rounded-md py-1 gap-1.5 focus:bg-secondary focus:text-foreground data-[highlighted]:bg-secondary data-[highlighted]:text-foreground text-secondary-foreground';
        item.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 text-secondary-foreground">' +
          '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>' +
          '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path>' +
          '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path>' +
          '<line x1="2" x2="22" y1="2" y2="22"></line>' +
          '</svg>' +
          '<span class="truncate">在列表中隐藏</span>';

        item.addEventListener('mouseenter', () => {
          item.setAttribute('data-highlighted', '');
        });
        item.addEventListener('mouseleave', () => {
          item.removeAttribute('data-highlighted');
        });
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const pid = item.dataset.projectId || ctx.id;
          const pname = ctx.name;
          const menuEl = item.closest('[role="menu"]') || document;
          try {
            menuEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          } catch {}
          hideProject(pid, pname);
        });
        return item;
      }

      function resolveTargetFromMenuLabel(labelledBy) {
        if (!labelledBy) return null;
        const triggerEl = document.getElementById(labelledBy);
        const container = triggerEl?.closest?.('[data-testid="project-header-container"]');
        if (!container) return null;
        const info = resolveProjectFromContainer(container);
        return info ? { id: info.id, name: info.name, triggerBtnId: labelledBy } : null;
      }

      function injectHideItemIntoOpenMenus() {
        if (disposed) return;
        const recentTarget =
          lastMenuTarget && Date.now() - lastMenuTarget.at <= 4000 ? lastMenuTarget : null;
        const menus = document.querySelectorAll('[role="menu"]');
        for (const menu of menus) {
          const isProjectMenu = Boolean(
            menu.querySelector(
              '[data-testid="group-header-copy-item"], [data-testid="group-header-settings-item"], [data-testid="group-header-reveal-item"], [data-testid="group-header-delete-item"]'
            )
          );
          if (!isProjectMenu) continue;

          const labelledBy = menu.getAttribute('aria-labelledby') || '';
          let ctx = resolveTargetFromMenuLabel(labelledBy);
          if (!ctx && recentTarget) {
            if (!recentTarget.triggerBtnId || !labelledBy || recentTarget.triggerBtnId === labelledBy) {
              ctx = recentTarget;
            }
          }
          if (!ctx || !ctx.id) continue;

          const existing = menu.querySelector(`[data-testid="${HIDE_MENU_TESTID}"]`);
          if (existing) {
            if (existing.dataset.projectId === ctx.id) continue;
            existing.remove();
          }

          const hideItem = buildHideMenuItem(ctx);
          const deleteItem = menu.querySelector('[data-testid="group-header-delete-item"]');
          if (deleteItem && deleteItem.parentElement === menu) {
            menu.insertBefore(hideItem, deleteItem);
          } else {
            menu.appendChild(hideItem);
          }
        }
      }

      function closePopover() {
        popoverOpen = false;
        const pop = document.getElementById(POPOVER_ID);
        if (pop) pop.removeAttribute('data-open');
      }

      function ensurePopover() {
        let pop = document.getElementById(POPOVER_ID);
        if (!pop) {
          pop = document.createElement('div');
          pop.id = POPOVER_ID;
          pop.setAttribute('data-ag-i18n-exclude', 'true');
          pop.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('[data-isdou-hp-action]') : null;
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const act = btn.getAttribute('data-isdou-hp-action');
            if (act === 'unhide-one') {
              const pid = btn.getAttribute('data-project-id') || '';
              if (pid) unhideProject(pid);
            } else if (act === 'unhide-all') {
              unhideAllProjects();
            }
          });
          document.body.appendChild(pop);
        }
        return pop;
      }

      function renderPopover() {
        const pop = ensurePopover();
        const list = getHiddenList();
        let html =
          `<div class="isdou-hp-hdr">` +
          `<span>已隐藏项目 (${list.length})</span>` +
          (list.length > 0
            ? `<button type="button" class="isdou-hp-all" data-isdou-hp-action="unhide-all">全部恢复</button>`
            : '') +
          `</div>`;

        if (list.length === 0) {
          html += `<div class="isdou-hp-empty">暂无隐藏的文件夹</div>`;
        } else {
          html += `<div class="isdou-hp-list">`;
          for (const item of list) {
            html +=
              `<div class="isdou-hp-row">` +
              `<span class="isdou-hp-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>` +
              `<button type="button" class="isdou-hp-restore" data-isdou-hp-action="unhide-one" data-project-id="${escapeHtml(item.id)}">恢复显示</button>` +
              `</div>`;
          }
          html += `</div>`;
        }
        pop.innerHTML = html;
      }

      function openPopover(anchorEl) {
        renderPopover();
        const pop = ensurePopover();
        const r = anchorEl.getBoundingClientRect();
        const popW = 248;
        const left = Math.max(8, Math.min(window.innerWidth - popW - 10, r.left));
        const top = Math.min(window.innerHeight - 180, r.bottom + 6);
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.setAttribute('data-open', 'true');
        popoverOpen = true;
      }

      function syncHiddenBadge() {
        if (disposed) return;
        const list = getHiddenList();
        const existingBtn = document.getElementById(BADGE_ID);

        if (list.length === 0) {
          if (existingBtn) existingBtn.remove();
          if (popoverOpen) closePopover();
          return;
        }

        const addBtn = document.querySelector('[data-testid="sidebar-add-project-button"]');
        const secHdr =
          document.querySelector('[data-testid="section-header"][data-section-id="main-section-header"]') ||
          addBtn?.closest('[data-testid="section-header"]');
        const actionsHost = secHdr?.querySelector('div.flex.items-center.justify-end') || addBtn?.parentElement?.parentElement;
        if (!actionsHost) return;

        let btn = existingBtn;
        if (!btn) {
          btn = document.createElement('button');
          btn.id = BADGE_ID;
          btn.type = 'button';
          btn.setAttribute('data-ag-i18n-exclude', 'true');
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (popoverOpen) closePopover();
            else openPopover(btn);
          });
        }

        if (btn.parentElement !== actionsHost) {
          actionsHost.insertBefore(btn, actionsHost.firstChild);
        }

        const sig = String(list.length);
        if (btn.dataset.count !== sig) {
          btn.dataset.count = sig;
          btn.title = `管理已隐藏的 ${list.length} 个文件夹`;
          btn.innerHTML =
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>' +
            '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path>' +
            '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path>' +
            '<line x1="2" x2="22" y1="2" y2="22"></line>' +
            '</svg>' +
            `<span>隐藏 ${list.length}</span>`;
        }

        if (popoverOpen) {
          renderPopover();
        }
      }

      function scheduleSync() {
        if (disposed || syncTimer) return;
        syncTimer = setTimeout(() => {
          syncTimer = 0;
          const patchedNow =
            (!pspRef?.__isdouPatched || !rppRef?.__isdouPatched) && ensureProjectsProviderPatched();
          if (patchedNow && getHiddenList().length > 0) {
            triggerSidebarRefresh();
          }
          injectHideItemIntoOpenMenus();
          syncHiddenBadge();
        }, 60);
      }

      function onDocPointerDown(e) {
        if (!popoverOpen) return;
        const pop = document.getElementById(POPOVER_ID);
        const btn = document.getElementById(BADGE_ID);
        if (pop && pop.contains(e.target)) return;
        if (btn && btn.contains(e.target)) return;
        closePopover();
      }

      function onDocKeyDown(e) {
        if (popoverOpen && e.key === 'Escape') {
          closePopover();
        }
      }

      document.addEventListener('pointerdown', onCaptureMenuTrigger, true);
      document.addEventListener('contextmenu', onCaptureMenuTrigger, true);
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);

      if (typeof MutationObserver !== 'undefined' && document.body) {
        bodyObs = new MutationObserver(() => {
          injectHideItemIntoOpenMenus();
          scheduleSync();
        });
        bodyObs.observe(document.body, { childList: true, subtree: true });
      }

      // 初次挂载可能早于项目列表初始化完成，短轮询直至挂上 projectsStateProvider
      let initTries = 0;
      initPollTimer = setInterval(() => {
        initTries++;
        const ok = ensureProjectsProviderPatched();
        if (ok) {
          if (getHiddenList().length > 0) triggerSidebarRefresh();
          syncHiddenBadge();
          clearInterval(initPollTimer);
          initPollTimer = 0;
        } else if (initTries > 30) {
          clearInterval(initPollTimer);
          initPollTimer = 0;
        }
      }, 250);

      if (ensureProjectsProviderPatched() && getHiddenList().length > 0) {
        triggerSidebarRefresh();
      }
      syncHiddenBadge();

      window.__isdouHiddenProjects = {
        hideProject,
        unhideProject,
        unhideAllProjects,
        getHiddenList,
        hasProvider: () => Boolean(findProjectManagementService()?.projectsStateProvider)
      };

      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        document.removeEventListener('pointerdown', onCaptureMenuTrigger, true);
        document.removeEventListener('contextmenu', onCaptureMenuTrigger, true);
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('keydown', onDocKeyDown, true);
        if (bodyObs) bodyObs.disconnect();
        if (syncTimer) clearTimeout(syncTimer);
        if (initPollTimer) clearInterval(initPollTimer);
        if (toastTimer) clearTimeout(toastTimer);
        document.getElementById(BADGE_ID)?.remove();
        document.getElementById(POPOVER_ID)?.remove();
        document.querySelectorAll(`[data-testid="${HIDE_MENU_TESTID}"]`).forEach((el) => el.remove());

        if (pmsRef && pmsRef.__isdouOrigUpdateProject) {
          try {
            pmsRef.updateProject = pmsRef.__isdouOrigUpdateProject;
            delete pmsRef.__isdouOrigUpdateProject;
            delete pmsRef.__isdouUpdatePatched;
          } catch {}
        }
        if (pspRef && pspRef.__isdouOrigGetState) {
          try {
            pspRef.getState = pspRef.__isdouOrigGetState;
            delete pspRef.__isdouOrigGetState;
            delete pspRef.__isdouPatched;
          } catch {}
        }
        if (rppRef && rppRef.__isdouOrigSetState) {
          try {
            const raw = rppRef.getState?.();
            const origFire = rppRef.__isdouOrigFire;
            rppRef.setState = rppRef.__isdouOrigSetState;
            delete rppRef.__isdouOrigSetState;
            delete rppRef.__isdouOrigFire;
            delete rppRef.__isdouPatched;
            if (origFire && raw instanceof Map) {
              origFire(raw);
            }
          } catch {}
        } else if (pspRef) {
          try {
            triggerSidebarRefresh();
          } catch {}
        }
        if (window.__isdouHiddenProjects) {
          delete window.__isdouHiddenProjects;
        }
      });
    })();
  }
