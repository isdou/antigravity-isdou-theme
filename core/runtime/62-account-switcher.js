/**
 * Part 62: 原生一键切换账号与多会员配额快照（方案 A）
 *
 * - 直接调用 Antigravity 内置 authService.loginWithRedirect（RE_SIGN_IN 流程），免去手动登出与进入设置页
 * - 仅在 localStorage（isdou.accountSnapshotsV1）保存非敏感展示元数据（邮箱、套餐名、剩余配额%、重置时间），绝不接触凭据或 Token
 * - 切回窗口自动节流刷新 UserStatus，并派发 `isdou:account-switched` 联动配额浮窗与续跑条
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.accountSwitcher !== false) {
    (() => {
      const STORAGE_KEY = 'isdou.accountSnapshotsV1';
      const TOAST_ID = 'isdou-drop-toast';
      const MAX_ACCOUNTS = 10;
      const SWITCH_LOCK_TIMEOUT_MS = 45000;
      const FOCUS_REFRESH_THROTTLE_MS = 3000;

      let cachedStore = null;
      let isSwitching = false;
      let switchLockTimer = 0;
      let toastTimer = 0;
      let lastFocusRefreshAt = 0;

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

        // BFS 兜底（比如欢迎页或隐藏侧栏场景）
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
        return scanFiberTree((fiber) => {
          let dep = fiber.dependencies?.firstContext;
          while (dep) {
            const as = dep.memoizedValue?.core?.authService;
            if (
              as &&
              typeof as.loginWithRedirect === 'function' &&
              typeof as.logout === 'function'
            ) {
              return as;
            }
            dep = dep.next;
          }
          return null;
        });
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
        }, 2600);
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

      async function switchAccount(targetEmail = '') {
        if (isSwitching) {
          showAccountToast('账号切换流程正在进行中，请在浏览器完成授权', 'info');
          return false;
        }

        const cleanTarget = typeof targetEmail === 'string' ? targetEmail.trim() : '';
        if (cleanTarget) {
          try {
            navigator.clipboard?.writeText?.(cleanTarget)?.catch?.(() => {});
          } catch {}
          showAccountToast(`正在打开浏览器切换账号（已复制 ${cleanTarget}）`, 'info');
        } else {
          showAccountToast('正在打开浏览器切换 Google 账号…', 'info');
        }

        const authService = findAuthService();
        if (!authService) {
          showAccountToast('未找到认证服务，请稍后重试', 'warn');
          return false;
        }

        isSwitching = true;
        if (switchLockTimer) clearTimeout(switchLockTimer);
        switchLockTimer = setTimeout(() => {
          isSwitching = false;
        }, SWITCH_LOCK_TIMEOUT_MS);

        try {
          const beforeEmail = getCurrentAccountInfo().email;
          const beforeCount = authService._authState?.context?.authSuccessCount ?? 0;
          const isGcpTos = Boolean(authService._authState?.context?.isGcpTos);
          const t0 = Date.now();

          await authService.loginWithRedirect({ isGcpTos, enableBusinessLogin: false });

          const afterCount = authService._authState?.context?.authSuccessCount ?? 0;
          const afterEmail = getCurrentAccountInfo().email;
          if (Date.now() - t0 < 800 && afterCount === beforeCount && afterEmail === beforeEmail) {
            await authService.logout();
            await authService.loginWithRedirect({ isGcpTos, enableBusinessLogin: false });
          }

          try {
            await authService.refreshUserStatus?.();
          } catch {}

          window.dispatchEvent(new CustomEvent('isdou:account-switched'));
          return true;
        } catch (err) {
          console.error('[isdou-account-switcher] switchAccount failed:', err);
          showAccountToast('切换账号未完成，请重试', 'error');
          return false;
        } finally {
          if (switchLockTimer) {
            clearTimeout(switchLockTimer);
            switchLockTimer = 0;
          }
          isSwitching = false;
        }
      }

      async function onWindowFocus() {
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

      window.__isdouAccountSwitcher = {
        switchAccount,
        recordAccountSnapshot,
        getKnownAccounts,
        removeKnownAccount,
        getCurrentAccountInfo,
        hasAuthService: () => Boolean(findAuthService()),
        isSwitching: () => isSwitching
      };

      window.__ag_cleanup_fns.push(() => {
        window.removeEventListener('focus', onWindowFocus, true);
        if (switchLockTimer) clearTimeout(switchLockTimer);
        if (toastTimer) clearTimeout(toastTimer);
        if (window.__isdouAccountSwitcher) {
          delete window.__isdouAccountSwitcher;
        }
      });
    })();
  }
