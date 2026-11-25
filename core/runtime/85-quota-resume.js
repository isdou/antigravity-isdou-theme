/**
 * Part 85: 模型配额用尽 / 切换账号后一键续跑（Quota Recovery & Resume Bar）
 *
 * 解决痛点：
 * - 模型配额耗尽停止后，切换账号或更换可用模型回来，原生无“继续执行”按钮，只能手打新消息
 * - 记录受阻会话与账号/配额快照（支持切号重载后跨页保留），恢复后高亮提供一键续跑
 * - 支持开启“配额恢复后自动继续”（切号/换模型且检测到可用配额后倒计时自动续跑）
 * - 优先尝试 Antigravity 原生重试指令（sendMessage type: 7）；若后端未重启则无缝回退为自动发送“继续”
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.quotaResume !== false) {
    (() => {
      const BAR_ID = 'isdou-resume-bar';
      const STORAGE_KEY = 'isdou.quotaResumeV1';
      const MAX_RECORD_AGE_MS = 6 * 3600 * 1000;
      const RECENT_ERROR_AGE_MS = 2 * 3600 * 1000;

      const QUOTA_RE =
        /Model quota reached|Baseline model quota reached|Individual quota reached|quota_exceeded|Resource has been exhausted|insufficient credits|模型配额已用尽|配额已用尽|配额不足|Quota exceeded/i;
      const ERROR_BANNER_RE =
        /Agent terminated due to error|Authentication expired|Session has expired|智能体因错误而终止|身份验证已过期/i;
      const BANNER_ACTION_RE =
        /Upgrade|Select another model|Try again|Retry|Copy debug info|Log back in|升级|选择其他模型|重试|再试一次|复制调试信息/i;

      let cachedStore = null;
      let lastSeenEmail = '';
      let lastSeenRemaining = null;
      let isResuming = false;
      let autoCountdownTimer = 0;
      let autoCountdownTargetCid = '';
      let autoCountdownLeft = 0;
      let pollTimer = 0;
      let dismissedByCid = new Map();

      function readStateStore() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return { lastEmail: '', pendingByCid: {} };
          const parsed = JSON.parse(raw);
          const now = Date.now();
          const cleaned = {};
          for (const [k, v] of Object.entries(parsed?.pendingByCid || {})) {
            if (v && now - (v.blockedAt || 0) < MAX_RECORD_AGE_MS) {
              cleaned[k] = v;
            }
          }
          return {
            lastEmail: typeof parsed?.lastEmail === 'string' ? parsed.lastEmail : '',
            pendingByCid: cleaned
          };
        } catch {
          return { lastEmail: '', pendingByCid: {} };
        }
      }

      function writeStateStore(data) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {}
      }

      function getFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
      }

      function getReduxStore() {
        if (cachedStore && typeof cachedStore.getState === 'function') return cachedStore;
        const anchor =
          document.querySelector('[data-testid="sidebar-add-project-button"]') ||
          document.querySelector('.surface-composer') ||
          document.getElementById('root')?.firstElementChild;
        let cur = getFiber(anchor);
        let guard = 0;
        while (cur && guard++ < 80) {
          let dep = cur.dependencies?.firstContext;
          while (dep) {
            const val = dep.memoizedValue;
            if (val?.store && typeof val.store.getState === 'function') {
              cachedStore = val.store;
              return cachedStore;
            }
            dep = dep.next;
          }
          cur = cur.return;
        }
        return null;
      }

      function getComposerLkdContext() {
        const comp = document.querySelector('.surface-composer');
        if (!comp) return null;
        let cur = getFiber(comp);
        let guard = 0;
        while (cur && guard++ < 45) {
          let dep = cur.dependencies?.firstContext;
          while (dep) {
            const val = dep.memoizedValue;
            if (val && typeof val === 'object' && 'sendMessage' in val && 'cascadeContext' in val) {
              return val;
            }
            dep = dep.next;
          }
          cur = cur.return;
        }
        return null;
      }

      function getCurrentCid(ctx) {
        const searchCid = new URLSearchParams(location.search).get('cascadeId');
        if (searchCid) return searchCid;
        const pathMatch = location.pathname.match(/\/c\/([^/?]+)/);
        if (pathMatch) return pathMatch[1];
        const aspCid = ctx?.cascadeContext?.state?.agentStateProvider?.getState?.()?.conversationId;
        return aspCid || '';
      }

      function parseProtoTimestampMs(ts) {
        if (!ts) return 0;
        if (typeof ts === 'number') return ts;
        if (typeof ts === 'string') {
          const d = Date.parse(ts);
          return Number.isNaN(d) ? 0 : d;
        }
        if (typeof ts === 'object' && ts.seconds !== undefined) {
          return Number(ts.seconds) * 1000 + Math.floor(Number(ts.nanos || 0) / 1e6);
        }
        return 0;
      }

      function detectDomInterruptionBanner() {
        const composer = document.querySelector('.surface-composer');
        const scopes = [composer?.parentElement, composer?.parentElement?.parentElement].filter(Boolean);
        let foundQuota = false;
        let foundError = false;
        let bannerEl = null;

        for (const scope of scopes) {
          const buttons = scope.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.closest('#' + BAR_ID)) continue;
            if (btn.closest('[data-testid="agent-response"], [data-testid="user-message"], .prose, .markdown')) {
              continue;
            }
            const btnText = (btn.textContent || '').trim();
            if (!BANNER_ACTION_RE.test(btnText)) continue;
            // 向上找卡片容器
            let box = btn.parentElement;
            let hops = 0;
            while (box && box !== scope && hops++ < 5) {
              if (box.matches('.surface-composer')) break;
              const txt = box.textContent || '';
              if (QUOTA_RE.test(txt)) {
                foundQuota = true;
                bannerEl = box;
                break;
              }
              if (ERROR_BANNER_RE.test(txt)) {
                foundError = true;
                bannerEl = box;
                break;
              }
              box = box.parentElement;
            }
            if (bannerEl) break;
          }
          if (bannerEl) break;
        }

        return { foundQuota, foundError, bannerEl };
      }

      function dismissStaleBanner(bannerEl) {
        if (!bannerEl) return;
        const closeBtn = bannerEl.querySelector(
          'button[aria-label="Close"], button[aria-label="Dismiss"], button[aria-label="关闭"], button[title="Dismiss"]'
        );
        if (closeBtn) {
          try {
            closeBtn.click();
          } catch {}
        }
      }

      function getSnapshot() {
        const ctx = getComposerLkdContext();
        const store = getReduxStore();
        const st = store ? store.getState() : null;
        const cid = getCurrentCid(ctx);
        const email = st?.userStatus?.email || ctx?.userStatus?.email || '';
        const selectedModel = ctx?.cascadeContext?.state?.selectedModel || null;
        const modelLabel = selectedModel?.label || '';
        const remaining =
          typeof selectedModel?.quotaInfo?.remainingFraction === 'number'
            ? selectedModel.quotaInfo.remainingFraction
            : null;
        const aspState = ctx?.cascadeContext?.state?.agentStateProvider?.getState?.() || null;
        const summary = cid ? st?.trajectorySummaries?.summaries?.[cid] || null : null;

        const runStatus = aspState?.status ?? summary?.status ?? 0;
        const termReason = aspState?.executorMetadata?.terminationReason ?? summary?.latestExecutorTerminationReason ?? 0;
        const stepCount = summary?.stepCount ?? 0;
        const lastModMs = parseProtoTimestampMs(summary?.lastModifiedTime);
        const isIdle = runStatus !== 2;
        const isErrorTerm = termReason === 1 || termReason === 11 || Boolean(summary?.interrupted);
        const domBanner = detectDomInterruptionBanner();

        return {
          ctx,
          cid,
          email,
          modelLabel,
          remaining,
          runStatus,
          termReason,
          stepCount,
          lastModMs,
          isIdle,
          isErrorTerm,
          domBanner
        };
      }

      function insertAndSendPrompt(ctx, text) {
        const editor =
          ctx?.inputBoxRef?.current?.lexicalRef?.current?.getRootElement?.() ||
          document.querySelector('.surface-composer [contenteditable="true"]');
        if (!editor) return false;

        editor.focus();
        const existing = (editor.textContent || '').trim();
        if (!existing) {
          try {
            const sel = window.getSelection();
            if (sel) {
              const range = document.createRange();
              const target = editor.querySelector('p') || editor;
              range.selectNodeContents(target);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch {}
          try {
            editor.dispatchEvent(
              new InputEvent('beforeinput', {
                inputType: 'insertText',
                data: text,
                bubbles: true,
                cancelable: true
              })
            );
          } catch {}

          requestAnimationFrame(() => {
            if (!(editor.textContent || '').trim()) {
              try {
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                editor.dispatchEvent(
                  new ClipboardEvent('paste', {
                    clipboardData: dt,
                    bubbles: true,
                    cancelable: true
                  })
                );
              } catch {}
            }
            setTimeout(() => {
              const submitFn = ctx?.inputBoxRef?.current?.submit;
              const sendBtn = document.querySelector('[data-testid="input-send-button"]');
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
              } else if (typeof submitFn === 'function') {
                submitFn();
              } else {
                editor.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                  })
                );
              }
            }, 90);
          });
        } else {
          // 用户框里已自己写了补充说明，直接替他提交
          const submitFn = ctx?.inputBoxRef?.current?.submit;
          if (typeof submitFn === 'function') submitFn();
        }
        return true;
      }

      function cancelAutoCountdown() {
        if (autoCountdownTimer) {
          clearInterval(autoCountdownTimer);
          autoCountdownTimer = 0;
        }
        autoCountdownTargetCid = '';
        autoCountdownLeft = 0;
      }

      async function resumeExecution() {
        if (isResuming) return;
        cancelAutoCountdown();
        const snap = getSnapshot();
        if (!snap.cid || !snap.isIdle) return;

        isResuming = true;
        renderBar();
        dismissStaleBanner(snap.domBanner.bannerEl);

        const stateStore = readStateStore();
        const prevPending = stateStore.pendingByCid[snap.cid];
        const canTryNativeRetry = Boolean(snap.ctx?.sendMessage && snap.isErrorTerm);

        try {
          if (canTryNativeRetry) {
            try {
              snap.ctx.sendMessage({ type: 7, cascadeId: snap.cid });
              await new Promise((r) => setTimeout(r, 950));
            } catch {}
          }

          const after = getSnapshot();
          if (after.runStatus !== 2) {
            // 切号或长配额错误时，原生 type:7 可能被服务端忽略，直接回退发送“继续”
            insertAndSendPrompt(after.ctx || snap.ctx, '继续');
            await new Promise((r) => setTimeout(r, 500));
          }

          const post = getSnapshot();
          if (post.runStatus === 2 || !post.domBanner.foundQuota) {
            delete stateStore.pendingByCid[snap.cid];
            writeStateStore(stateStore);
          } else if (prevPending) {
            prevPending.autoResumeArmed = false;
            writeStateStore(stateStore);
          }
        } finally {
          isResuming = false;
          renderBar();
        }
      }

      function startAutoCountdown(cid) {
        if (autoCountdownTimer && autoCountdownTargetCid === cid) return;
        cancelAutoCountdown();
        autoCountdownTargetCid = cid;
        autoCountdownLeft = 2;
        renderBar();
        autoCountdownTimer = setInterval(() => {
          autoCountdownLeft -= 1;
          if (autoCountdownLeft <= 0) {
            cancelAutoCountdown();
            resumeExecution();
          } else {
            renderBar();
          }
        }, 1000);
      }

      function ensureBarElement() {
        const composer = document.querySelector('.surface-composer');
        if (!composer) return null;
        let bar = document.getElementById(BAR_ID);
        if (!bar) {
          bar = document.createElement('div');
          bar.id = BAR_ID;
          bar.setAttribute('data-ag-i18n-exclude', 'true');
        }
        const host = composer.parentElement;
        if (host && bar.parentElement !== host) {
          host.insertBefore(bar, composer);
        }
        return bar;
      }

      function removeBarElement() {
        document.getElementById(BAR_ID)?.remove();
      }

      function renderBar() {
        const snap = getSnapshot();
        const { cid, email, modelLabel, remaining, isIdle, isErrorTerm, stepCount, lastModMs, domBanner } = snap;

        const storeData = readStateStore();
        const emailChangedGlobal = Boolean(lastSeenEmail && email && email !== lastSeenEmail);
        const persistedEmailChanged = Boolean(storeData.lastEmail && email && email !== storeData.lastEmail);
        if (email && email !== storeData.lastEmail) {
          storeData.lastEmail = email;
          writeStateStore(storeData);
        }
        if (email) lastSeenEmail = email;

        if (!cid || !isIdle) {
          cancelAutoCountdown();
          if (cid && storeData.pendingByCid[cid] && snap.runStatus === 2) {
            delete storeData.pendingByCid[cid];
            writeStateStore(storeData);
          }
          removeBarElement();
          return;
        }

        const existingRec = storeData.pendingByCid[cid] || null;
        const isQuotaZero = remaining !== null && remaining <= 0.0001;
        const hasQuotaSignal = domBanner.foundQuota || (isErrorTerm && isQuotaZero);
        const isRecentError =
          isErrorTerm &&
          (lastModMs === 0 || Date.now() - lastModMs < RECENT_ERROR_AGE_MS || emailChangedGlobal || persistedEmailChanged);

        // 只要出现过配额耗尽或近期错误终止，记入持久状态（切号重载后依然能识别）
        if (hasQuotaSignal || domBanner.foundError || (isRecentError && !existingRec && dismissedByCid.get(cid) !== stepCount)) {
          const nextKind = hasQuotaSignal || existingRec?.kind === 'quota' ? 'quota' : 'error';
          if (!existingRec || existingRec.kind !== nextKind || existingRec.stepCount !== stepCount) {
            storeData.pendingByCid[cid] = {
              cid,
              kind: nextKind,
              blockedAt: existingRec?.blockedAt || Date.now(),
              blockedEmail: existingRec?.blockedEmail || email || '',
              blockedModel: existingRec?.blockedModel || modelLabel || '',
              stepCount,
              autoResumeArmed: Boolean(existingRec?.autoResumeArmed)
            };
            writeStateStore(storeData);
          }
        }

        const rec = storeData.pendingByCid[cid] || null;
        const dismissedStep = dismissedByCid.get(cid);
        if (!rec || dismissedStep === stepCount) {
          cancelAutoCountdown();
          lastSeenRemaining = remaining;
          removeBarElement();
          return;
        }

        const switchedAccount = Boolean(rec.blockedEmail && email && email !== rec.blockedEmail);
        const switchedModelWithQuota = Boolean(
          rec.blockedModel && modelLabel && modelLabel !== rec.blockedModel && remaining !== null && remaining > 0.01
        );
        const quotaRefilledOnSameAccount = Boolean(
          rec.kind === 'quota' &&
            lastSeenRemaining !== null &&
            lastSeenRemaining <= 0.0001 &&
            remaining !== null &&
            remaining > 0.01
        );
        const hasRecovered =
          !isQuotaZero &&
          (switchedAccount ||
            switchedModelWithQuota ||
            quotaRefilledOnSameAccount ||
            (!domBanner.foundQuota && rec.kind === 'quota' && remaining !== null && remaining > 0.01));

        lastSeenRemaining = remaining;

        if (hasRecovered && rec.autoResumeArmed && !isResuming) {
          startAutoCountdown(cid);
        }

        const bar = ensureBarElement();
        if (!bar) return;

        bar.dataset.state = isResuming ? 'resuming' : hasRecovered ? 'ready' : 'blocked';

        const pctText = remaining !== null ? `${Math.round(remaining * 100)}%` : '';
        let statusText = '';
        if (isResuming) {
          statusText = '正在恢复执行任务…';
        } else if (autoCountdownTimer && autoCountdownTargetCid === cid) {
          statusText = `账号配额已恢复${pctText ? ` (${pctText})` : ''}，${autoCountdownLeft}s 后自动继续…`;
        } else if (hasRecovered) {
          statusText = switchedAccount
            ? `已切换账号 (${email})${pctText ? ` · 配额 ${pctText}` : ''}，可继续刚才中断的任务`
            : `模型配额已可用${pctText ? ` (${pctText})` : ''}，可继续刚才中断的任务`;
        } else if (rec.kind === 'quota') {
          statusText = '当前账号/模型配额已耗尽 · 切换账号或换模型后可一键继续';
        } else {
          statusText = '任务因错误或异常中断 · 恢复后可一键继续';
        }

        bar.innerHTML = '';
        const left = document.createElement('div');
        left.className = 'isdou-resume-left';
        const dot = document.createElement('span');
        dot.className = 'isdou-resume-dot';
        const msg = document.createElement('span');
        msg.className = 'isdou-resume-text';
        msg.textContent = statusText;
        left.append(dot, msg);

        const right = document.createElement('div');
        right.className = 'isdou-resume-actions';

        if (autoCountdownTimer && autoCountdownTargetCid === cid) {
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'isdou-resume-chip';
          cancelBtn.textContent = '取消自动';
          cancelBtn.addEventListener('click', () => {
            rec.autoResumeArmed = false;
            writeStateStore(storeData);
            cancelAutoCountdown();
            renderBar();
          });
          right.appendChild(cancelBtn);
        } else if (!hasRecovered) {
          const armBtn = document.createElement('button');
          armBtn.type = 'button';
          armBtn.className = 'isdou-resume-chip' + (rec.autoResumeArmed ? ' is-armed' : '');
          armBtn.textContent = rec.autoResumeArmed ? '已开启切号自动继续' : '切号后自动继续';
          armBtn.title = '开启后，当你切换账号或模型恢复配额时自动续跑';
          armBtn.addEventListener('click', () => {
            const latest = readStateStore();
            if (latest.pendingByCid[cid]) {
              latest.pendingByCid[cid].autoResumeArmed = !latest.pendingByCid[cid].autoResumeArmed;
              writeStateStore(latest);
            }
            renderBar();
          });
          right.appendChild(armBtn);
        }

        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'isdou-resume-btn';
        goBtn.disabled = isResuming;
        goBtn.textContent = isResuming ? '恢复中…' : hasRecovered ? '▶ 继续执行' : '↻ 继续执行';
        goBtn.title = '继续完成中断的任务 (⌘⇧Enter)';
        goBtn.addEventListener('click', () => resumeExecution());
        right.appendChild(goBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'isdou-resume-close';
        closeBtn.setAttribute('aria-label', '关闭提示');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
          cancelAutoCountdown();
          dismissedByCid.set(cid, stepCount);
          const latest = readStateStore();
          delete latest.pendingByCid[cid];
          writeStateStore(latest);
          removeBarElement();
        });
        right.appendChild(closeBtn);

        bar.append(left, right);
      }

      function onKeyDown(e) {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
          const bar = document.getElementById(BAR_ID);
          if (bar) {
            e.preventDefault();
            e.stopPropagation();
            resumeExecution();
          }
        }
      }

      window.addEventListener('keydown', onKeyDown, true);
      pollTimer = setInterval(renderBar, 1200);
      setTimeout(renderBar, 600);

      window.__ag_cleanup_fns.push(() => {
        if (pollTimer) clearInterval(pollTimer);
        cancelAutoCountdown();
        window.removeEventListener('keydown', onKeyDown, true);
        removeBarElement();
      });
    })();
  }
