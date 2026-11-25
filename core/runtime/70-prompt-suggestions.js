/**
 * Part 70: Claude Code-style Prompt Suggestions (Ghost Text + Tab/RightArrow Accept + On-Demand Tab Trigger)
 */
  function cleanupPromptSuggestionsDom() {
    try {
      document.querySelectorAll('.ag-prompt-ghost-overlay').forEach((el) => {
        if (el.parentElement) el.parentElement.removeAttribute('data-ag-has-suggestion');
        el.remove();
      });
      document.querySelectorAll('[data-ag-has-suggestion]').forEach((el) => {
        el.removeAttribute('data-ag-has-suggestion');
      });
    } catch {}
    try {
      delete window.__ag_on_prompt_suggestion;
    } catch {
      window.__ag_on_prompt_suggestion = null;
    }
  }

  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.promptSuggestions) {
    (function initPromptSuggestions() {
      const OVERLAY_CLASS = 'ag-prompt-ghost-overlay';
      const HAS_SUGGESTION_ATTR = 'data-ag-has-suggestion';
      const MANUAL_AUTO_FILL_WINDOW_MS = 6000;
      const INFLIGHT_STALE_MS = 18000;

      let disposed = false;
      let currentSuggestion = '';
      let currentFingerprint = '';
      let currentScopeKey = '';
      let dismissedFingerprint = '';
      let inflightFingerprint = '';
      let inflightReqId = '';
      let inflightStartedAt = 0;
      let inflightManual = false;
      let pendingTabEditor = null;
      let pendingTabAt = 0;
      let reqSeq = 0;
      let isComposing = false;
      let isAccepting = false;
      let wasGenerating = false;
      let scanTimer = null;
      const createdOverlays = new Set();
      const localCache = new Map();

      function isSideQuestionEl(el) {
        return Boolean(
          el &&
            typeof el.closest === 'function' &&
            el.closest('[data-testid="side-question-panel"], [class*="side-question"]')
        );
      }

      function getScopeRoot(editor) {
        if (editor && isSideQuestionEl(editor)) {
          return editor.closest('[data-testid="side-question-panel"], [class*="side-question"]');
        }
        return document;
      }

      function isGenerating(scopeRoot = document) {
        const sel =
          '[data-testid="input-cancel-button"], [data-tooltip-id="input-send-button-cancel-tooltip"], [aria-label^="Cancel ("], [aria-label^="取消生成"]';
        if (scopeRoot && scopeRoot !== document) {
          return Boolean(scopeRoot.querySelector(sel));
        }
        const matches = document.querySelectorAll(sel);
        for (const el of matches) {
          if (!isSideQuestionEl(el)) return true;
        }
        return false;
      }

      function hasOpenPopupMenu() {
        const menus = document.querySelectorAll('[role="listbox"], [role="menu"], .agy-fastpick');
        for (const m of menus) {
          const rect = m.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
        return false;
      }

      function isNonChatEditableFocused(activeEl) {
        if (!activeEl) return false;
        if (activeEl.closest && activeEl.closest('[role="dialog"], [role="menu"], [role="listbox"], .agy-fastpick')) {
          return true;
        }
        const tag = activeEl.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (activeEl.isContentEditable && !(activeEl.closest && activeEl.closest('[data-lexical-editor="true"]'))) {
          return true;
        }
        return false;
      }

      function getEditors() {
        return Array.from(document.querySelectorAll('[data-lexical-editor="true"]')).filter((ed) => {
          const rect = ed.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      }

      function getTargetEditor() {
        const activeEl = document.activeElement;
        const focused = activeEl && activeEl.closest ? activeEl.closest('[data-lexical-editor="true"]') : null;
        if (focused) {
          const r = focused.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return focused;
        }
        const eds = getEditors();
        if (eds.length === 0) return null;
        return eds.find((ed) => !isSideQuestionEl(ed)) || eds[0];
      }

      function isEditorEmpty(editor) {
        if (!editor) return false;
        const text = (editor.innerText || editor.textContent || '')
          .replace(/[\u200B-\u200D\uFEFF\n\r]/g, '')
          .trim();
        return text.length === 0;
      }

      function hashText(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
      }

      function extractLatestTurn(editor = getTargetEditor()) {
        if (!editor) return null;
        const inSide = isSideQuestionEl(editor);
        const scopeRoot = getScopeRoot(editor) || document;
        const belongsToPane = (el) => (inSide ? isSideQuestionEl(el) : !isSideQuestionEl(el));

        const userNodes = Array.from(
          scopeRoot.querySelectorAll('[data-testid="user-message-content"], .agy-user-bubble')
        ).filter((el) => belongsToPane(el) && el.getBoundingClientRect().height > 0);

        const assistantNodes = Array.from(scopeRoot.querySelectorAll('[data-markdown-root]')).filter((el) => {
          if (!belongsToPane(el)) return false;
          if (
            el.closest(
              '[data-testid="user-message-content"], .agy-user-bubble, [data-lexical-editor="true"], [data-testid*="thought"], [class*="thought"], details:not([open])'
            )
          ) {
            return false;
          }
          return el.getBoundingClientRect().height > 0 && (el.innerText || '').trim().length > 0;
        });

        if (assistantNodes.length === 0) return null;

        const lastUserEl = userNodes.length > 0 ? userNodes[userNodes.length - 1] : null;
        const postUserAssistant = lastUserEl
          ? assistantNodes.filter((el) => Boolean(lastUserEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
          : [assistantNodes[assistantNodes.length - 1]];

        if (postUserAssistant.length === 0) return null;

        const lastAssistantFull = postUserAssistant
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        const lastUser = lastUserEl ? (lastUserEl.innerText || '').trim() : '';
        if (!lastAssistantFull) return null;

        const scopeKey = `${inSide ? 'side' : 'main'}|${location.pathname || ''}|${document.title || ''}`;
        const fingerprint = `${hashText(scopeKey)}_${hashText(lastUser.slice(-200) + '||' + lastAssistantFull.slice(-300))}`;
        return {
          scopeKey,
          fingerprint,
          lastUser: lastUser.slice(-600),
          lastAssistant: lastAssistantFull.slice(-1400)
        };
      }

      function clearPendingTabState() {
        pendingTabEditor = null;
        pendingTabAt = 0;
        inflightManual = false;
      }

      window.__ag_on_prompt_suggestion = (reqId, payload) => {
        if (disposed || !reqId || reqId !== inflightReqId) return;
        const fp = inflightFingerprint;
        const wasManual = inflightManual;
        const tabEditor = pendingTabEditor;
        const tabAt = pendingTabAt;

        inflightReqId = '';
        inflightFingerprint = '';
        inflightManual = false;
        pendingTabEditor = null;
        pendingTabAt = 0;

        const transient = Boolean(payload && payload.transient);
        const text =
          payload && payload.ok && payload.suggestion ? String(payload.suggestion).trim() : '';

        if (!transient) {
          currentFingerprint = fp;
          currentSuggestion = text;
        }

        if (
          text &&
          wasManual &&
          tabEditor &&
          tabEditor.isConnected &&
          isEditorEmpty(tabEditor) &&
          Date.now() - tabAt <= MANUAL_AUTO_FILL_WINDOW_MS &&
          !isNonChatEditableFocused(document.activeElement)
        ) {
          acceptSuggestion(tabEditor);
          return;
        }

        syncOverlays();
      };

      function getFiber(el) {
        if (!el) return null;
        const fk = Object.keys(el).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        return fk ? el[fk] : null;
      }

      function findLsClient() {
        const anchors = [
          document.querySelector('.surface-composer'),
          document.querySelector('[data-testid="model-selector-trigger"]'),
          document.getElementById('root')?.firstElementChild,
          document.getElementById('root')
        ];
        for (const anchor of anchors) {
          let cur = getFiber(anchor);
          for (let i = 0; i < 80 && cur; i++, cur = cur.return) {
            let dep = cur.dependencies?.firstContext;
            while (dep) {
              const ls = dep.memoizedValue?.core?.authService?._lsClient;
              if (ls && typeof ls.getModelResponse === 'function') {
                return ls;
              }
              dep = dep.next;
            }
          }
        }
        return null;
      }

      function resolveSuggestModelId() {
        const btn = document.querySelector('[data-testid="model-selector-trigger"]');
        let cur = getFiber(btn);
        let opts = null;
        let selectedVal = 0;
        for (let i = 0; i < 40 && cur; i++, cur = cur.return) {
          const p = cur.memoizedProps;
          if (p && Array.isArray(p.modelOptions)) {
            opts = p.modelOptions;
            selectedVal = Number(p.selectedModel?.value) || 0;
            break;
          }
        }
        if (Array.isArray(opts) && opts.length > 0) {
          const isUsable = (o) => {
            if (!o || o.disabled || !o.value) return false;
            const frac = o.quotaInfo?.remainingFraction ?? o.quotaInfo?.remaining;
            return frac === undefined || frac > 0;
          };
          const pick =
            opts.find((o) => isUsable(o) && /gemini-3\.8-flash-low/i.test(String(o.modelId || ''))) ||
            opts.find((o) => isUsable(o) && /3\.8\s*flash.*low/i.test(String(o.label || ''))) ||
            opts.find(
              (o) =>
                isUsable(o) &&
                /flash/i.test(String(o.modelId || o.label || '')) &&
                /\blow\b/i.test(String(o.modelId || o.label || ''))
            ) ||
            opts.find(
              (o) =>
                isUsable(o) &&
                /flash|hydrogen/i.test(String(o.modelId || o.label || '')) &&
                /\blow\b/i.test(String(o.modelId || o.label || ''))
            ) ||
            opts.find((o) => isUsable(o) && /\blow\b/i.test(String(o.modelId || o.label || ''))) ||
            opts.find((o) => isUsable(o));
          if (pick && Number(pick.value) > 0) return Number(pick.value);
        }
        return selectedVal > 0 ? selectedVal : 1320;
      }

      function cleanSuggestionText(raw) {
        if (!raw) return '';
        let text = String(raw)
          .replace(/```[\s\S]*?```/g, '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        if (!text) return '';
        text = text
          .replace(/^["'“”‘’`⟫>:\-\s]+/, '')
          .replace(/["'“”‘’`]+$/, '')
          .trim();
        if (!text || /^none$/i.test(text) || /^无$/i.test(text) || text.length < 2 || text.length > 60) {
          return '';
        }
        return text;
      }

      function requestSuggestion(turn, { force = false, autoAcceptEditor = null } = {}) {
        if (!turn || !turn.fingerprint) return;

        if (inflightReqId && inflightStartedAt && Date.now() - inflightStartedAt > INFLIGHT_STALE_MS) {
          inflightReqId = '';
          inflightFingerprint = '';
          inflightStartedAt = 0;
          clearPendingTabState();
        }

        if (turn.fingerprint === inflightFingerprint && inflightReqId) {
          if (force && autoAcceptEditor) {
            inflightManual = true;
            pendingTabEditor = autoAcceptEditor;
            pendingTabAt = Date.now();
            syncOverlays();
          }
          return;
        }

        if (!force) {
          if (turn.fingerprint === currentFingerprint || turn.fingerprint === dismissedFingerprint) {
            return;
          }
        } else {
          if (dismissedFingerprint === turn.fingerprint) dismissedFingerprint = '';
          if (autoAcceptEditor) {
            inflightManual = true;
            pendingTabEditor = autoAcceptEditor;
            pendingTabAt = Date.now();
          }
        }

        reqSeq += 1;
        const reqId = `ps-${Date.now()}-${reqSeq}`;
        inflightReqId = reqId;
        inflightFingerprint = turn.fingerprint;
        inflightStartedAt = Date.now();
        currentScopeKey = turn.scopeKey || '';

        if (localCache.has(turn.fingerprint)) {
          const cached = localCache.get(turn.fingerprint);
          if (cached || !force) {
            Promise.resolve().then(() => {
              window.__ag_on_prompt_suggestion?.(reqId, {
                ok: true,
                suggestion: cached,
                transient: false
              });
            });
            return;
          }
        }

        const ls = findLsClient();
        if (ls) {
          const lead = force
            ? '用户刚按下 Tab 请求提示，请结合以下刚结束的对话片段，务必给出最贴切、最顺手的一句简短后续指令（4~28字，直接输出句子本身，不要引号、解释或换行，尽量不要输出 NONE）：'
            : '你是一个聊天输入框的「下一句提示词预测器」。请站在用户视角，结合以下刚结束的对话片段，输出用户下一步最可能发出的一句简短中文指令（4~28字，直接输出句子本身，不要引号、解释或换行；仅当对话彻底结束无后续动作时输出 NONE）：';
          const prompt = [
            lead,
            turn.lastUser ? `用户：${turn.lastUser}` : '',
            `助手：${turn.lastAssistant}`
          ]
            .filter(Boolean)
            .join('\n');
          const modelVal = resolveSuggestModelId();
          if (force) syncOverlays();
          ls.getModelResponse({ prompt, model: modelVal }, { timeoutMs: 12000 })
            .then((res) => {
              if (disposed || reqId !== inflightReqId) return;
              const suggestion = cleanSuggestionText(res?.response || '');
              if (turn.fingerprint) {
                if (localCache.size >= 80) {
                  localCache.delete(localCache.keys().next().value);
                }
                localCache.set(turn.fingerprint, suggestion);
              }
              window.__ag_on_prompt_suggestion?.(reqId, {
                ok: true,
                suggestion,
                transient: false
              });
            })
            .catch(() => {
              if (disposed || reqId !== inflightReqId) return;
              window.__ag_on_prompt_suggestion?.(reqId, {
                ok: false,
                suggestion: '',
                transient: true
              });
            });
          return;
        }

        if (typeof window.__agRequestPromptSuggestion !== 'function') {
          inflightReqId = '';
          inflightFingerprint = '';
          inflightStartedAt = 0;
          clearPendingTabState();
          return;
        }

        try {
          window.__agRequestPromptSuggestion(
            JSON.stringify({
              reqId,
              fingerprint: turn.fingerprint,
              lastUser: turn.lastUser,
              lastAssistant: turn.lastAssistant,
              force: Boolean(force)
            })
          );
          if (force) syncOverlays();
        } catch {
          inflightReqId = '';
          inflightFingerprint = '';
          inflightStartedAt = 0;
          clearPendingTabState();
        }
      }

      function moveCaretToEnd(editor) {
        try {
          const sel = window.getSelection();
          if (!sel) return;
          const range = document.createRange();
          const target = editor.querySelector('p') || editor;
          range.selectNodeContents(target);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {}
      }

      function findLexicalCommand(lex, typeName) {
        if (!lex || !lex._commands || typeof lex._commands.keys !== 'function') return null;
        try {
          for (const key of lex._commands.keys()) {
            if (key && key.type === typeName) return key;
          }
        } catch {}
        return null;
      }

      function insertTextIntoLexical(editor, text, onDone) {
        if (!editor || !text || isAccepting) return false;
        isAccepting = true;

        const finish = () => {
          moveCaretToEnd(editor);
          isAccepting = false;
          if (typeof onDone === 'function') onDone(!isEditorEmpty(editor));
        };

        const runFallbackBeforeInput = () => {
          editor.focus();
          moveCaretToEnd(editor);
          let handled = false;
          try {
            const ev = new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: text,
              bubbles: true,
              cancelable: true
            });
            editor.dispatchEvent(ev);
            handled = Boolean(ev.defaultPrevented);
          } catch {}

          // 等待 Lexical 微任务调和刷新 DOM，避免同步误判为空后重复写入
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (!isEditorEmpty(editor)) {
                finish();
                return;
              }
              if (!handled) {
                try {
                  editor.focus();
                  moveCaretToEnd(editor);
                  document.execCommand('insertText', false, text);
                } catch {}
              }
              requestAnimationFrame(() => {
                if (isEditorEmpty(editor)) {
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
                finish();
              });
            }, 0);
          });
        };

        const lex = editor.__lexicalEditor;
        const controlledInsertCmd = findLexicalCommand(lex, 'CONTROLLED_TEXT_INSERTION_COMMAND');
        if (lex && typeof lex.focus === 'function' && typeof lex.dispatchCommand === 'function' && controlledInsertCmd) {
          editor.focus();
          try {
            lex.focus(undefined, { defaultSelection: 'rootEnd' });
          } catch {}
          requestAnimationFrame(() => {
            if (!isEditorEmpty(editor)) {
              finish();
              return;
            }
            try {
              lex.dispatchCommand(controlledInsertCmd, text);
            } catch {}
            requestAnimationFrame(() => {
              setTimeout(() => {
                if (!isEditorEmpty(editor)) {
                  finish();
                  return;
                }
                runFallbackBeforeInput();
              }, 0);
            });
          });
          return true;
        }

        runFallbackBeforeInput();
        return true;
      }

      function ensureOverlayDom(editor) {
        const host = editor.parentElement;
        if (!host) return null;
        let overlay = host.querySelector('.' + OVERLAY_CLASS);
        if (!overlay) {
          if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
          }
          overlay = document.createElement('div');
          overlay.className = OVERLAY_CLASS;

          const textEl = document.createElement('div');
          textEl.className = 'ag-prompt-ghost-text';

          const kbd = document.createElement('kbd');
          kbd.className = 'ag-prompt-ghost-kbd';
          kbd.textContent = 'Tab';
          kbd.title = '按 Tab 或 → 填入预测输入';
          const suppressKbdEvent = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          };
          kbd.addEventListener('pointerdown', (ev) => {
            suppressKbdEvent(ev);
            if (overlay.classList.contains('is-loading')) {
              clearPendingTabState();
              syncOverlays();
              return;
            }
            acceptSuggestion(editor);
          });
          kbd.addEventListener('mousedown', suppressKbdEvent);
          kbd.addEventListener('click', suppressKbdEvent);

          overlay.appendChild(textEl);
          overlay.appendChild(kbd);
          host.appendChild(overlay);
          createdOverlays.add(overlay);
        }

        const cs = getComputedStyle(editor);
        overlay.style.paddingTop = cs.paddingTop;
        overlay.style.paddingLeft = cs.paddingLeft;
        overlay.style.paddingRight = cs.paddingRight;
        overlay.style.fontSize = cs.fontSize;
        overlay.style.lineHeight = cs.lineHeight;
        return overlay;
      }

      function syncOverlays() {
        if (disposed) return;
        const primaryEditor = getTargetEditor();
        const editors = getEditors();
        const hasReadySuggestion = Boolean(
          currentSuggestion &&
            currentFingerprint &&
            currentFingerprint !== dismissedFingerprint &&
            !isGenerating(getScopeRoot(primaryEditor))
        );

        for (const editor of editors) {
          const host = editor.parentElement;
          if (!host) continue;

          const isTarget = editor === primaryEditor;
          const isLoadingThis = Boolean(
            inflightManual && pendingTabEditor === editor && !hasReadySuggestion && !isGenerating(getScopeRoot(editor))
          );
          const showSuggestion = Boolean(isTarget && hasReadySuggestion && !isComposing && isEditorEmpty(editor));
          const showLoading = Boolean(isLoadingThis && !isComposing && isEditorEmpty(editor));

          let overlay = host.querySelector('.' + OVERLAY_CLASS);
          if (!showSuggestion && !showLoading) {
            if (overlay) {
              overlay.hidden = true;
              overlay.classList.remove('is-loading');
            }
            host.removeAttribute(HAS_SUGGESTION_ATTR);
            continue;
          }

          overlay = ensureOverlayDom(editor);
          if (!overlay) continue;

          const textEl = overlay.querySelector('.ag-prompt-ghost-text');
          const kbd = overlay.querySelector('.ag-prompt-ghost-kbd');

          if (showLoading) {
            overlay.classList.add('is-loading');
            if (textEl) textEl.textContent = '正在生成下一句提示…';
            if (kbd) {
              kbd.textContent = 'Esc';
              kbd.title = '取消等待提示';
            }
          } else {
            overlay.classList.remove('is-loading');
            if (textEl && textEl.textContent !== currentSuggestion) {
              textEl.textContent = currentSuggestion;
            }
            if (kbd) {
              kbd.textContent = 'Tab';
              kbd.title = '按 Tab 或 → 填入预测输入';
            }
          }

          overlay.hidden = false;
          host.setAttribute(HAS_SUGGESTION_ATTR, 'true');
        }
      }

      function acceptSuggestion(editor) {
        const text = currentSuggestion;
        if (!editor || !text || isAccepting || !isEditorEmpty(editor)) return false;
        dismissedFingerprint = currentFingerprint;
        currentSuggestion = '';
        clearPendingTabState();
        syncOverlays();
        return insertTextIntoLexical(editor, text, () => {
          syncOverlays();
        });
      }

      function tick() {
        if (disposed) return;
        const targetEditor = getTargetEditor();
        const generating = isGenerating(getScopeRoot(targetEditor));
        if (generating) {
          if (!wasGenerating) {
            wasGenerating = true;
            currentSuggestion = '';
            clearPendingTabState();
            syncOverlays();
          }
          return;
        }

        wasGenerating = false;
        const turn = extractLatestTurn(targetEditor);
        if (!turn) {
          if (currentSuggestion || inflightManual) {
            currentSuggestion = '';
            currentFingerprint = '';
            clearPendingTabState();
          }
          syncOverlays();
          return;
        }

        if (currentScopeKey && turn.scopeKey !== currentScopeKey) {
          currentSuggestion = '';
          currentFingerprint = '';
          clearPendingTabState();
        }
        currentScopeKey = turn.scopeKey;

        if (turn.fingerprint !== currentFingerprint && turn.fingerprint !== dismissedFingerprint) {
          requestSuggestion(turn);
        }
        syncOverlays();
      }

      function scheduleTick(delayMs = 260) {
        if (disposed) return;
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
          scanTimer = null;
          tick();
        }, delayMs);
      }

      function onKeyDown(e) {
        if (disposed || e.isComposing || isComposing) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
          if (e.key === 'Escape' && (currentSuggestion || inflightManual)) {
            dismissedFingerprint = currentFingerprint;
            currentSuggestion = '';
            clearPendingTabState();
            syncOverlays();
          }
          return;
        }

        if (e.key === 'Escape') {
          if (currentSuggestion || inflightManual) {
            dismissedFingerprint = currentFingerprint;
            currentSuggestion = '';
            clearPendingTabState();
            syncOverlays();
          }
          return;
        }

        if (e.key !== 'Tab' && e.key !== 'ArrowRight') return;
        if (hasOpenPopupMenu() || isNonChatEditableFocused(document.activeElement)) return;

        const activeEl = document.activeElement;
        const focusedEditor =
          activeEl && activeEl.closest ? activeEl.closest('[data-lexical-editor="true"]') : null;
        const targetEditor = focusedEditor || getTargetEditor();
        if (!targetEditor || !isEditorEmpty(targetEditor)) return;
        if (isGenerating(getScopeRoot(targetEditor))) return;

        const hasReadySuggestion = Boolean(
          currentSuggestion && currentFingerprint && currentFingerprint !== dismissedFingerprint
        );

        // ArrowRight 仅在焦点位于空输入框且已有提示时生效；Tab 允许在页面任意非输入焦点直接采纳可见提示
        if (e.key === 'ArrowRight' && !focusedEditor) return;

        if (hasReadySuggestion) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          acceptSuggestion(targetEditor);
          return;
        }

        // 在空输入框内直接按 Tab：即使尚无提示或上次被跳过，也立即触发按需预测并在就绪后填入
        if (e.key === 'Tab' && focusedEditor) {
          const turn = extractLatestTurn(focusedEditor);
          if (!turn) return;
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          requestSuggestion(turn, { force: true, autoAcceptEditor: focusedEditor });
        }
      }

      function onCompositionStart() {
        isComposing = true;
        clearPendingTabState();
        syncOverlays();
      }

      function onCompositionEnd() {
        isComposing = false;
        scheduleTick(60);
      }

      function onInput(ev) {
        if (inflightManual && ev?.target?.closest?.('[data-lexical-editor="true"]')) {
          clearPendingTabState();
        }
        syncOverlays();
      }

      function onAccountSwitched() {
        currentSuggestion = '';
        currentFingerprint = '';
        dismissedFingerprint = '';
        inflightReqId = '';
        inflightFingerprint = '';
        inflightStartedAt = 0;
        localCache.clear();
        clearPendingTabState();
        syncOverlays();
        scheduleTick(450);
      }

      const observer =
        typeof MutationObserver !== 'undefined'
          ? new MutationObserver(() => scheduleTick(260))
          : null;
      if (observer && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }

      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('isdou:account-switched', onAccountSwitched);
      document.addEventListener('compositionstart', onCompositionStart, true);
      document.addEventListener('compositionend', onCompositionEnd, true);
      document.addEventListener('input', onInput, true);

      scheduleTick(400);

      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        if (scanTimer) clearTimeout(scanTimer);
        if (observer) observer.disconnect();
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('isdou:account-switched', onAccountSwitched);
        document.removeEventListener('compositionstart', onCompositionStart, true);
        document.removeEventListener('compositionend', onCompositionEnd, true);
        document.removeEventListener('input', onInput, true);
        for (const ov of createdOverlays) {
          if (ov.parentElement) ov.parentElement.removeAttribute(HAS_SUGGESTION_ATTR);
          ov.remove();
        }
        createdOverlays.clear();
        cleanupPromptSuggestionsDom();
      });
    })();
  } else {
    cleanupPromptSuggestionsDom();
  }
