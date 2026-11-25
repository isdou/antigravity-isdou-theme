/**
 * Part 62: 原生一键切换账号与多会员配额快照（方案 A）
 *
 * - 直接调用 Antigravity 内置 authService.loginWithRedirect（RE_SIGN_IN 流程），免去手动登出与进入设置页
 * - 在 `Authenticating...`（[data-testid="feature-banner"]）与配额浮窗中内置「重新打开 / 复制链接 / 授权码 / 取消」操作，避免关闭浏览器后死等卡死
 * - 仅在 localStorage（isdou.accountSnapshotsV1）保存非敏感展示元数据（邮箱、套餐名、剩余配额%、重置时间），绝不接触凭据或 Token
 * - 切回窗口自动节流刷新 UserStatus，并派发 `isdou:account-switched` 联动配额浮窗与续跑条
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.accountSwitcher !== false) {
    (() => {
      const STORAGE_KEY = 'isdou.accountSnapshotsV1';
      const TOAST_ID = 'isdou-drop-toast';
      const BANNER_ACTIONS_ID = 'isdou-auth-banner-actions';
      const MAX_ACCOUNTS = 10;
      const SWITCH_LOCK_TIMEOUT_MS = 45000;
      const FOCUS_REFRESH_THROTTLE_MS = 3000;

      let cachedStore = null;
      let isSwitching = false;
      let switchLockTimer = 0;
      let toastTimer = 0;
      let pollTimer = 0;
      let lastFocusRefreshAt = 0;
      let cachedAuthUrl = '';
      let cachedAuthMode = 'none';
      let lastTargetEmail = '';
      let authCodePanelOpen = false;
      let watchedAuthService = null;
      let unsubLoginSession = null;

      function getFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        return key ? el[key] : null;
      }

      function scanFiberTree(matcher) {
        const anchors = [
          document.querySelector('.surface-composer'),
          document.querySelector('[data-testid="feature-banner"]'),
          document.querySelector('[data-testid="sidebar-add-project-button"]'),
          document.getElementById('root')?.firstElementChild,
          document.getElementById('root')
        ];

        for (const anchor of anchors) {
          let cur = getFiber(anchor);
          let guard = 0;
          while (cur && guard++ < 80) {
            const hit = matcher(cur);
            if (hit) return hit;
            cur = cur.return;
          }
        }

        const rootEl = document.getElementById('root');
        const start = getFiber(rootEl) || getFiber(rootEl?.firstElementChild);
        if (!start) return null;
        const queue = [start];
        let visited = 0;
        while (queue.length > 0 && visited++ < 800) {
          const node = queue.shift();
          if (!node) continue;
          const hit = matcher(node);
          if (hit) return hit;
          if (node.child) queue.push(node.child);
          if (node.sibling) queue.push(node.sibling);
        }
        return null;
      }

      function findAuthService() {
        const as = scanFiberTree((fiber) => {
          let dep = fiber.dependencies?.firstContext;
          while (dep) {
            const candidate = dep.memoizedValue?.core?.authService;
            if (
              candidate &&
              typeof candidate.loginWithRedirect === 'function' &&
              typeof candidate.logout === 'function'
            ) {
              return candidate;
            }
            dep = dep.next;
          }
          return null;
        });
        if (as && as !== watchedAuthService) {
          attachSessionWatcher(as);
        }
        return as;
      }

      function attachSessionWatcher(as) {
        if (unsubLoginSession) {
          try {
            unsubLoginSession.dispose?.();
          } catch {}
          unsubLoginSession = null;
        }
        watchedAuthService = as;
        if (as && typeof as.onDidChangeLoginSession === 'function') {
          try {
            // 订阅一次可激活 Antigravity 内置 Clb sessionTracker 轮询 authUrl
            unsubLoginSession = as.onDidChangeLoginSession((snap) => {
              if (snap && snap.active) {
                if (snap.authUrl) cachedAuthUrl = snap.authUrl;
                if (snap.mode) cachedAuthMode = snap.mode;
              } else if (snap && !snap.active && as._authState?.state !== 'validatingLogin') {
                cachedAuthUrl = '';
                cachedAuthMode = 'none';
                authCodePanelOpen = false;
              }
              syncAuthBanner();
              window.dispatchEvent(new CustomEvent('isdou:account-switched'));
            });
          } catch {}
        }
      }

      function findReduxStore() {
        if (cachedStore && typeof cachedStore.getState === 'function') return cachedStore;
        const store = scanFiberTree((fiber) => {
          let dep = fiber.dependencies?.firstContext;
          while (dep) {
            const st = dep.memoizedValue?.store;
            if (st && typeof st.getState === 'function') return st;
            dep = dep.next;
          }
          return null;
        });
        if (store) cachedStore = store;
        return cachedStore;
      }

      function showAccountToast(text, tone = 'info') {
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

      async function copyTextSafe(text) {
        if (!text) return false;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch {}
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }

      function openUrlExternally(url) {
        if (!url) return false;
        try {
          if (typeof window.electronNative?.openExternal === 'function') {
            window.electronNative.openExternal(url);
            return true;
          }
        } catch {}
        try {
          const w = window.open(url, '_blank', 'noopener,noreferrer');
          return Boolean(w);
        } catch {
          return false;
        }
      }

      function readSnapshotsMap() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return {};
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      }

      function writeSnapshotsMap(map) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        } catch {}
      }

      function recordAccountSnapshot({ email, tier, pct, resetSec } = {}) {
        const cleanEmail = typeof email === 'string' ? email.trim() : '';
        if (!cleanEmail) return;

        const map = readSnapshotsMap();
        const prev = map[cleanEmail] || {};
        const normPct =
          typeof pct === 'number' && !Number.isNaN(pct)
            ? Math.max(0, Math.min(100, Math.round(pct)))
            : typeof prev.pct === 'number'
              ? prev.pct
              : null;
        const normResetSec =
          typeof resetSec === 'number' && resetSec > 0
            ? resetSec
            : typeof prev.resetSec === 'number'
              ? prev.resetSec
              : 0;

        map[cleanEmail] = {
          email: cleanEmail,
          tier: typeof tier === 'string' && tier.trim() ? tier.trim() : prev.tier || '',
          pct: normPct,
          resetSec: normResetSec,
          updatedAt: Date.now()
        };

        const entries = Object.values(map)
          .filter((item) => item && typeof item.email === 'string')
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, MAX_ACCOUNTS);

        const trimmed = {};
        for (const item of entries) {
          trimmed[item.email] = item;
        }
        writeSnapshotsMap(trimmed);
      }

      function getKnownAccounts(excludeEmail = '') {
        const exclude = typeof excludeEmail === 'string' ? excludeEmail.trim() : '';
        const map = readSnapshotsMap();
        const nowSec = Date.now() / 1000;
        return Object.values(map)
          .filter((acc) => acc && typeof acc.email === 'string' && acc.email !== exclude)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map((acc) => {
            const isReset = Boolean(acc.resetSec && nowSec >= acc.resetSec);
            const effectivePct = isReset ? 100 : acc.pct;
            return {
              email: acc.email,
              tier: acc.tier || '',
              pct: acc.pct,
              resetSec: acc.resetSec || 0,
              updatedAt: acc.updatedAt || 0,
              isReset,
              effectivePct
            };
          });
      }

      function removeKnownAccount(email) {
        const target = typeof email === 'string' ? email.trim() : '';
        if (!target) return false;
        const map = readSnapshotsMap();
        if (!Object.prototype.hasOwnProperty.call(map, target)) return false;
        delete map[target];
        writeSnapshotsMap(map);
        return true;
      }

      function getCurrentAccountInfo() {
        const store = findReduxStore();
        const us = store?.getState?.()?.userStatus;
        if (!us || typeof us !== 'object') {
          return { email: '', name: '', tier: '' };
        }
        return {
          email: typeof us.email === 'string' ? us.email : '',
          name: typeof us.name === 'string' ? us.name : '',
          tier: typeof us.userTier?.name === 'string' ? us.userTier.name : ''
        };
      }

      function isAuthenticating() {
        const as = findAuthService();
        return Boolean(isSwitching || as?._authState?.state === 'validatingLogin');
      }

      async function fetchActiveAuthUrl({ switchToAuthCodeIfEmpty = false } = {}) {
        const as = findAuthService();
        if (!as) return { url: '', mode: 'none' };

        const snap = as.getLoginSessionSnapshot?.();
        if (snap?.active) {
          if (snap.authUrl) cachedAuthUrl = snap.authUrl;
          if (snap.mode) cachedAuthMode = snap.mode;
          if (cachedAuthUrl) return { url: cachedAuthUrl, mode: cachedAuthMode };
        }

        try {
          const res = await as._lsClient?.getLoginSession?.({});
          if (res?.active) {
            const m = res.mode === 1 ? 'loopback' : res.mode === 2 ? 'authCode' : 'none';
            if (res.authUrl) cachedAuthUrl = res.authUrl;
            if (m !== 'none') cachedAuthMode = m;
            if (cachedAuthUrl) return { url: cachedAuthUrl, mode: cachedAuthMode };
          }
        } catch {}

        if (switchToAuthCodeIfEmpty && typeof as.switchLoginToAuthCode === 'function') {
          try {
            const sw = await as.switchLoginToAuthCode(false);
            if (sw?.authUrl) cachedAuthUrl = sw.authUrl;
            if (sw?.mode) cachedAuthMode = sw.mode;
            return { url: cachedAuthUrl, mode: cachedAuthMode || 'authCode' };
          } catch {}
        }

        return { url: cachedAuthUrl, mode: cachedAuthMode };
      }

      async function reopenAuthUrl() {
        const { url, mode } = await fetchActiveAuthUrl({ switchToAuthCodeIfEmpty: false });
        if (url && openUrlExternally(url)) {
          showAccountToast(
            mode === 'authCode' ? '已重开验证页（完成授权后请粘贴授权码）' : '已重新打开浏览器验证页',
            'info'
          );
          return true;
        }
        // 环回模式下服务端未暴露 authUrl 时，取消旧等待并重建全新环回授权会话
        await cancelAccountSwitch({ quiet: true });
        return switchAccount(lastTargetEmail);
      }

      async function copyAuthUrl() {
        const { url, mode } = await fetchActiveAuthUrl({ switchToAuthCodeIfEmpty: true });
        if (!url) {
          showAccountToast('暂未获取到验证链接，请点「重新打开」重建授权流程', 'warn');
          return false;
        }
        const copied = await copyTextSafe(url);
        if (mode === 'authCode') {
          authCodePanelOpen = true;
          syncAuthBanner();
        }
        showAccountToast(
          copied
            ? mode === 'authCode'
              ? '已复制验证链接，浏览器授权后请在下方填入授权码'
              : '已复制验证链接，可粘贴到指定浏览器完成登录'
            : '复制失败，请手动点「重新打开」',
          copied ? 'info' : 'warn'
        );
        return copied;
      }

      async function submitAuthCode(rawCode) {
        const code = String(rawCode || '').trim();
        if (!code) {
          showAccountToast('请先粘贴 Google 授权码', 'warn');
          return false;
        }
        const as = findAuthService();
        if (!as || typeof as.submitLoginAuthCode !== 'function') {
          showAccountToast('当前版本不支持提交授权码', 'error');
          return false;
        }
        try {
          const res = await as.submitLoginAuthCode(code);
          if (res?.accepted) {
            authCodePanelOpen = false;
            cachedAuthUrl = '';
            cachedAuthMode = 'none';
            isSwitching = false;
            try {
              await as.checkCurrentAuthStatus?.();
              await as.refreshUserStatus?.();
            } catch {}
            showAccountToast('授权码验证成功', 'ok');
            syncAuthBanner();
            window.dispatchEvent(new CustomEvent('isdou:account-switched'));
            return true;
          }
          showAccountToast(res?.retryError || '授权码无效或已过期，请检查后重试', 'error');
          return false;
        } catch (err) {
          showAccountToast(`提交失败: ${err?.message || '未知错误'}`, 'error');
          return false;
        }
      }

      async function cancelAccountSwitch({ quiet = false } = {}) {
        const as = findAuthService();
        if (switchLockTimer) {
          clearTimeout(switchLockTimer);
          switchLockTimer = 0;
        }
        isSwitching = false;
        cachedAuthUrl = '';
        cachedAuthMode = 'none';
        authCodePanelOpen = false;

        if (as) {
          try {
            await as.cancelLogin?.();
          } catch {}
          try {
            // 若原账号仍有本地凭证，checkCurrentAuthStatus 会把 _authState 立即恢复为 signedIn
            await as.checkCurrentAuthStatus?.();
            await as.refreshUserStatus?.();
          } catch {}
        }

        syncAuthBanner();
        window.dispatchEvent(new CustomEvent('isdou:account-switched'));
        if (!quiet) {
          showAccountToast('已取消验证并恢复当前账号', 'info');
        }
        return true;
      }

      async function switchAccount(targetEmail = '') {
        if (isAuthenticating()) {
          if (targetEmail && targetEmail !== lastTargetEmail) {
            lastTargetEmail = targetEmail;
            await copyTextSafe(targetEmail);
          }
          return reopenAuthUrl();
        }

        const cleanTarget = typeof targetEmail === 'string' ? targetEmail.trim() : '';
        lastTargetEmail = cleanTarget;
        if (cleanTarget) {
          copyTextSafe(cleanTarget);
          showAccountToast(`正在打开浏览器切换账号（已复制 ${cleanTarget}）`, 'info');
        } else {
          showAccountToast('正在打开浏览器切换 Google 账号…', 'info');
        }

        const authService = findAuthService();
        if (!authService) {
          showAccountToast('未找到认证服务，请稍后重试', 'warn');
          return false;
        }

        attachSessionWatcher(authService);
        isSwitching = true;
        cachedAuthUrl = '';
        cachedAuthMode = 'none';
        authCodePanelOpen = false;
        if (switchLockTimer) clearTimeout(switchLockTimer);
        switchLockTimer = setTimeout(() => {
          isSwitching = false;
          syncAuthBanner();
        }, SWITCH_LOCK_TIMEOUT_MS);

        // 异步探测一次 authUrl，方便用户关掉浏览器后立刻点重开或复制
        setTimeout(() => {
          if (isAuthenticating()) {
            fetchActiveAuthUrl({ switchToAuthCodeIfEmpty: false }).then(() => syncAuthBanner());
          }
        }, 350);

        syncAuthBanner();

        try {
          const beforeEmail = getCurrentAccountInfo().email;
          const beforeCount = authService._authState?.context?.authSuccessCount ?? 0;
          const isGcpTos = Boolean(authService._authState?.context?.isGcpTos);
          const t0 = Date.now();

          await authService.loginWithRedirect({ isGcpTos, enableBusinessLogin: false });

          const afterCount = authService._authState?.context?.authSuccessCount ?? 0;
          const afterEmail = getCurrentAccountInfo().email;
          if (
            authService._authState?.state === 'signedIn' &&
            Date.now() - t0 < 800 &&
            afterCount === beforeCount &&
            afterEmail === beforeEmail
          ) {
            await authService.logout();
            await authService.loginWithRedirect({ isGcpTos, enableBusinessLogin: false });
          }

          try {
            await authService.refreshUserStatus?.();
          } catch {}

          syncAuthBanner();
          window.dispatchEvent(new CustomEvent('isdou:account-switched'));
          return true;
        } catch (err) {
          console.error('[isdou-account-switcher] switchAccount failed:', err);
          showAccountToast('切换账号未完成，可点取消或重开链接', 'error');
          return false;
        } finally {
          if (switchLockTimer) {
            clearTimeout(switchLockTimer);
            switchLockTimer = 0;
          }
          isSwitching = false;
          syncAuthBanner();
        }
      }

      function syncAuthBanner() {
        const existingActions = document.getElementById(BANNER_ACTIONS_ID);
        const banners = Array.from(document.querySelectorAll('[data-testid="feature-banner"]'));
        const asState = findAuthService()?._authState?.state;
        const banner =
          banners.find((el) => /Authenticating|正在验证|验证中/i.test(el.textContent || '')) ||
          (asState === 'validatingLogin' ? banners[0] : null);
        const active = Boolean(banner && (/Authenticating|正在验证|验证中/i.test(banner.textContent || '') || asState === 'validatingLogin'));

        if (!active) {
          if (existingActions) existingActions.remove();
          return;
        }

        let box = existingActions;
        if (!box) {
          box = document.createElement('span');
          box.id = BANNER_ACTIONS_ID;
          box.setAttribute('data-ag-i18n-exclude', 'true');
        }

        if (box.parentElement !== banner) {
          banner.appendChild(box);
        }

        const wantCodeInput = authCodePanelOpen || cachedAuthMode === 'authCode';
        const sig = `auth:${wantCodeInput ? 1 : 0}`;
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.innerHTML = '';

        const reopenBtn = document.createElement('button');
        reopenBtn.type = 'button';
        reopenBtn.className = 'isdou-ab-btn isdou-ab-primary';
        reopenBtn.textContent = '🌐 打开验证页';
        reopenBtn.title = '重新在浏览器中打开 Google 登录验证页面';
        reopenBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          reopenAuthUrl();
        });

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'isdou-ab-btn';
        copyBtn.textContent = '📋 复制链接';
        copyBtn.title = '复制验证链接，可自行粘贴到任意浏览器或指定个人资料';
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyAuthUrl();
        });

        box.append(reopenBtn, copyBtn);

        if (wantCodeInput) {
          const codeInput = document.createElement('input');
          codeInput.type = 'text';
          codeInput.className = 'isdou-ab-input';
          codeInput.placeholder = '粘贴授权码';
          codeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitAuthCode(codeInput.value);
            }
          });

          const submitBtn = document.createElement('button');
          submitBtn.type = 'button';
          submitBtn.className = 'isdou-ab-btn isdou-ab-primary';
          submitBtn.textContent = '提交';
          submitBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            submitAuthCode(codeInput.value);
          });
          box.append(codeInput, submitBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'isdou-ab-btn isdou-ab-cancel';
        cancelBtn.textContent = '取消验证';
        cancelBtn.title = '取消本次切号并恢复原账号';
        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelAccountSwitch();
        });
        box.appendChild(cancelBtn);
      }

      async function onWindowFocus() {
        syncAuthBanner();
        const now = Date.now();
        if (now - lastFocusRefreshAt <= FOCUS_REFRESH_THROTTLE_MS) return;
        const authService = findAuthService();
        if (!authService || authService._authState?.state !== 'signedIn') return;
        lastFocusRefreshAt = now;
        try {
          await authService.refreshUserStatus?.();
          window.dispatchEvent(new CustomEvent('isdou:account-switched'));
        } catch {}
      }

      window.addEventListener('focus', onWindowFocus, true);
      pollTimer = setInterval(syncAuthBanner, 900);
      setTimeout(syncAuthBanner, 500);

      window.__isdouAccountSwitcher = {
        switchAccount,
        reopenAuthUrl,
        copyAuthUrl,
        submitAuthCode,
        cancelAccountSwitch,
        isAuthenticating,
        recordAccountSnapshot,
        getKnownAccounts,
        removeKnownAccount,
        getCurrentAccountInfo,
        hasAuthService: () => Boolean(findAuthService()),
        isSwitching: () => isSwitching
      };

      window.__ag_cleanup_fns.push(() => {
        window.removeEventListener('focus', onWindowFocus, true);
        if (pollTimer) clearInterval(pollTimer);
        if (switchLockTimer) clearTimeout(switchLockTimer);
        if (toastTimer) clearTimeout(toastTimer);
        if (unsubLoginSession) {
          try {
            unsubLoginSession.dispose?.();
          } catch {}
          unsubLoginSession = null;
        }
        document.getElementById(BANNER_ACTIONS_ID)?.remove();
        if (window.__isdouAccountSwitcher) {
          delete window.__isdouAccountSwitcher;
        }
      });
    })();
  }
