/**
 * Part 80: 拖放本地文件夹直接打开为 Antigravity 项目（Codex 体验同步）
 *
 * - 支持从 Finder / 桌面直接将文件夹拖入 Antigravity 窗口任意位置打开
 * - 普通文件 / 图片拖入输入框仍保持 Antigravity 原生附件上传行为，互不干扰
 * - 若文件夹已存在于项目列表中，直接跳转并聚焦该项目，跳过重复提示弹窗
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.folderDrop !== false) {
    (() => {
      const OVERLAY_ID = 'isdou-drop-overlay';
      const TOAST_ID = 'isdou-drop-toast';

      let dragDepth = 0;
      let dragKnownDir = false;
      let toastTimer = 0;
      let isOpening = false;

      function normalizeFsPath(raw) {
        if (!raw || typeof raw !== 'string') return '';
        let p = raw.trim();
        if (p.length > 1) p = p.replace(/\/+$/, '');
        return p;
      }

      function pathToFileUri(fsPath) {
        const norm = normalizeFsPath(fsPath);
        if (!norm) return '';
        if (norm === '/') return 'file:///';
        const encoded = norm
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        return `file:///${encoded}`;
      }

      function uriToFsPath(uri) {
        if (!uri || typeof uri !== 'string') return '';
        try {
          if (uri.startsWith('file://')) {
            return normalizeFsPath(decodeURIComponent(new URL(uri).pathname));
          }
        } catch {}
        return normalizeFsPath(uri);
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
        }, 2800);
      }

      function ensureOverlay() {
        if (!document.body) return null;
        let el = document.getElementById(OVERLAY_ID);
        if (!el) {
          el = document.createElement('div');
          el.id = OVERLAY_ID;
          el.setAttribute('data-ag-i18n-exclude', 'true');
          el.innerHTML =
            '<div class="isdou-drop-card">' +
            '<div class="isdou-drop-icon" aria-hidden="true">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>' +
            '</svg>' +
            '</div>' +
            '<div class="isdou-drop-title">松开即可打开项目文件夹</div>' +
            '<div class="isdou-drop-sub">将直接添加并在 Antigravity 中切换至此目录</div>' +
            '</div>';
          document.body.appendChild(el);
        }
        return el;
      }

      function setOverlayVisible(visible) {
        const el = document.getElementById(OVERLAY_ID) || (visible ? ensureOverlay() : null);
        if (!el) return;
        el.classList.toggle('is-visible', Boolean(visible));
      }

      function isFileDrag(e) {
        const types = e?.dataTransfer?.types;
        if (!types) return false;
        return Array.from(types).includes('Files');
      }

      function hasDirectoryInItems(dt) {
        if (!dt?.items) return false;
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i];
          if (item.kind !== 'file') continue;
          try {
            const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
            if (entry && entry.isDirectory) return true;
          } catch {}
        }
        return false;
      }

      function isInsideSidebar(target) {
        return Boolean(target && typeof target.closest === 'function' && target.closest('.bg-sidebar'));
      }

      function isInsideComposer(target) {
        return Boolean(target && typeof target.closest === 'function' && target.closest('.surface-composer'));
      }

      function resolveDroppedDirPaths(dt) {
        const paths = [];
        if (!dt?.items) return paths;
        const getPath = typeof window.electronNative?.getPathForFile === 'function'
          ? (f) => window.electronNative.getPathForFile(f)
          : (f) => f?.path || '';

        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i];
          if (item.kind !== 'file') continue;
          let entry = null;
          try {
            entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
          } catch {}
          if (!entry || !entry.isDirectory) continue;
          const file = typeof item.getAsFile === 'function' ? item.getAsFile() : dt.files?.[i];
          if (!file) continue;
          const fsPath = normalizeFsPath(getPath(file));
          if (fsPath && !paths.includes(fsPath)) {
            paths.push(fsPath);
          }
        }
        return paths;
      }

      function getFiberFromElement(el) {
        if (!el) return null;
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
      }

      function findUvdFiber() {
        const btn = document.querySelector('[data-testid="sidebar-add-project-button"]');
        if (btn) {
          let cur = getFiberFromElement(btn);
          let guard = 0;
          while (cur && guard++ < 60) {
            if (cur.elementType?.name === 'Uvd' || cur.type?.name === 'Uvd') return cur;
            cur = cur.return;
          }
        }
        const root = document.getElementById('root') || document.body;
        const start = getFiberFromElement(root) || getFiberFromElement(root?.firstElementChild);
        if (!start) return null;
        const queue = [start];
        let visited = 0;
        while (queue.length > 0 && visited++ < 1200) {
          const node = queue.shift();
          if (!node) continue;
          if (node.elementType?.name === 'Uvd' || node.type?.name === 'Uvd') return node;
          if (node.child) queue.push(node.child);
          if (node.sibling) queue.push(node.sibling);
        }
        return null;
      }

      function extractUvdHandles(uvdFiber) {
        if (!uvdFiber) return null;
        let store = null;
        let fkMap = null;
        let dep = uvdFiber.dependencies?.firstContext;
        while (dep) {
          const val = dep.memoizedValue;
          if (val && typeof val === 'object') {
            if (!store && val.store && typeof val.store.getState === 'function') {
              store = val.store;
            }
            if (!fkMap && typeof val.get === 'function' && Array.isArray(val.get('addWorkspaceFeatures'))) {
              fkMap = val;
            }
          }
          dep = dep.next;
        }

        let newProjectOnClick = null;
        let selectProjectFn = null;
        let st = uvdFiber.memoizedState;
        let guard = 0;
        while (st && guard++ < 150) {
          const val = st.memoizedState;
          if (Array.isArray(val) && val.length >= 1) {
            const first = val[0];
            if (!newProjectOnClick && Array.isArray(first)) {
              const found = first.find((x) => x && x.type === 'NEW_PROJECT' && typeof x.onClick === 'function');
              if (found) newProjectOnClick = found.onClick;
            } else if (!selectProjectFn && typeof first === 'function') {
              const src = String(first);
              if (src.length < 160 && /\(\{\s*project\s*:\s*[a-zA-Z_$][\w$]*\s*\}\)/.test(src)) {
                selectProjectFn = first;
              }
            }
          }
          st = st.next;
        }
        return { store, fkMap, newProjectOnClick, selectProjectFn };
      }

      function findExistingProjectByPath(store, fsPath) {
        if (!store || !fsPath) return null;
        const target = normalizeFsPath(fsPath);
        const st = store.getState();
        const rawProjects = st?.sidebarProjects?.projects;
        if (!rawProjects) return null;
        const list = Array.isArray(rawProjects) ? rawProjects : Object.values(rawProjects);
        for (const proj of list) {
          if (!proj || !Array.isArray(proj.folderUris)) continue;
          for (const uri of proj.folderUris) {
            if (uriToFsPath(uri) === target) return proj;
          }
        }
        return null;
      }

      function focusSidebarProject(projectName) {
        if (!projectName) return false;
        const headers = document.querySelectorAll('[data-testid="project-header"]');
        for (const el of headers) {
          const lbl = el.getAttribute('data-project-label') || el.textContent?.trim();
          if (lbl === projectName) {
            if (el.getAttribute('aria-expanded') === 'false') {
              el.click();
            }
            el.scrollIntoView({ block: 'nearest' });
            return true;
          }
        }
        return false;
      }

      async function openFolderInAntigravity(fsPath) {
        const uri = pathToFileUri(fsPath);
        const baseName = normalizeFsPath(fsPath).split('/').filter(Boolean).pop() || fsPath;
        if (!uri) {
          showToast('无法解析文件夹路径', 'error');
          return false;
        }

        const uvd = findUvdFiber();
        const handles = extractUvdHandles(uvd);
        if (!handles) {
          showToast('请先切换到 Antigravity 主窗口再拖入文件夹', 'warn');
          return false;
        }

        const existing = findExistingProjectByPath(handles.store, fsPath);
        if (existing) {
          if (typeof handles.selectProjectFn === 'function') {
            handles.selectProjectFn(existing.id);
          } else {
            focusSidebarProject(existing.name);
          }
          setTimeout(() => focusSidebarProject(existing.name), 120);
          showToast(`已打开项目 · ${existing.name || baseName}`, 'ok');
          return true;
        }

        const addFeatures = handles.fkMap?.get('addWorkspaceFeatures');
        const addFolderFeature = Array.isArray(addFeatures)
          ? addFeatures.find((w) => w && w.id === 'add-folder' && typeof w.addWorkspace === 'function')
          : null;

        if (!addFolderFeature || typeof handles.newProjectOnClick !== 'function') {
          showToast('未能定位 Antigravity 原生添加项目入口', 'error');
          return false;
        }

        const origAddWorkspace = addFolderFeature.addWorkspace;
        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;
          try {
            addFolderFeature.addWorkspace = origAddWorkspace;
          } catch {}
        };

        const failsafe = setTimeout(restore, 4000);
        try {
          addFolderFeature.addWorkspace = async () => {
            restore();
            clearTimeout(failsafe);
            return { workspaceUri: uri };
          };
          showToast(`正在打开文件夹 · ${baseName}`, 'ok');
          await handles.newProjectOnClick();
          return true;
        } catch (err) {
          console.error('[isdou-folder-drop] openFolder failed:', err);
          showToast(`打开文件夹失败: ${err?.message || '未知错误'}`, 'error');
          return false;
        } finally {
          clearTimeout(failsafe);
          restore();
        }
      }

      async function handleDroppedFolders(paths) {
        if (!paths.length || isOpening) return;
        isOpening = true;
        try {
          for (let i = 0; i < paths.length; i++) {
            await openFolderInAntigravity(paths[i]);
            if (i + 1 < paths.length) {
              await new Promise((r) => setTimeout(r, 180));
            }
          }
        } finally {
          isOpening = false;
        }
      }

      function resetDragState() {
        dragDepth = 0;
        dragKnownDir = false;
        setOverlayVisible(false);
      }

      function onDragEnter(e) {
        if (!isFileDrag(e)) return;
        dragDepth++;
        if (hasDirectoryInItems(e.dataTransfer)) {
          dragKnownDir = true;
        }
        if (dragKnownDir || isInsideSidebar(e.target)) {
          setOverlayVisible(true);
        }
      }

      function onDragOver(e) {
        if (!isFileDrag(e)) return;
        if (hasDirectoryInItems(e.dataTransfer)) {
          dragKnownDir = true;
        }
        // 在输入框之外默认放行 dragover，确保整个窗口都能接收文件夹 drop；
        // 输入框内部保留 Antigravity 原生拖放逻辑（文件/图片附件）
        if (!isInsideComposer(e.target) && !e.defaultPrevented) {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        }
        if (dragKnownDir || isInsideSidebar(e.target)) {
          setOverlayVisible(true);
        } else {
          setOverlayVisible(false);
        }
      }

      function onDragLeave(e) {
        if (!e.relatedTarget) {
          resetDragState();
          return;
        }
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          resetDragState();
        }
      }

      function onDropCapture(e) {
        const dt = e?.dataTransfer;
        const dirPaths = dt ? resolveDroppedDirPaths(dt) : [];
        resetDragState();
        if (dirPaths.length === 0) return;

        // 仅当包含文件夹时截获，避免影响聊天输入框的普通文件/图片拖放
        e.preventDefault();
        e.stopImmediatePropagation();
        handleDroppedFolders(dirPaths);
      }

      window.addEventListener('dragenter', onDragEnter, true);
      window.addEventListener('dragover', onDragOver, false);
      window.addEventListener('dragleave', onDragLeave, true);
      window.addEventListener('drop', onDropCapture, true);
      window.addEventListener('dragend', resetDragState, true);
      window.addEventListener('blur', resetDragState, true);

      window.__ag_cleanup_fns.push(() => {
        window.removeEventListener('dragenter', onDragEnter, true);
        window.removeEventListener('dragover', onDragOver, false);
        window.removeEventListener('dragleave', onDragLeave, true);
        window.removeEventListener('drop', onDropCapture, true);
        window.removeEventListener('dragend', resetDragState, true);
        window.removeEventListener('blur', resetDragState, true);
        if (toastTimer) clearTimeout(toastTimer);
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(TOAST_ID)?.remove();
      });
    })();
  }
