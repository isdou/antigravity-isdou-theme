/**
 * Part 58: SkillDex 内置技能图鉴与省额度体检工作台
 *
 * - 侧边栏底栏图标或快捷键 Cmd/Ctrl+Shift+K 一键呼出宽屏模态工作台
 * - 图鉴画廊：多端 Skills 卡片展示、真实调用频次、用法与 Demo 预览、触发口令一键填入 Antigravity 输入框
 * - 省额度体检：常驻 Rules Token 账单、AGY 挂载水位、0 次吃灰一键归档、重复去重、28 个插件实时开关
 * - 无痛收纳箱：查看并一键恢复 skills-archive/ 中的归档技能
 */
  if (!IS_SWARM_PLUGIN_FRAME && ENABLED && MODULES.skillDex !== false) {
    (() => {
      const BACKDROP_ID = 'isdou-skilldex-backdrop';
      const TOAST_ID = 'isdou-drop-toast';

      const CATEGORIES = [
        { id: 'all', label: '全部' },
        { id: 'ios', label: 'iOS / Swift', color: '#EA580C' },
        { id: 'design', label: 'UI / 动效', color: '#7C3AED' },
        { id: 'video', label: '视频 / 媒体', color: '#DB2777' },
        { id: 'social', label: '社媒运营', color: '#D97706' },
        { id: 'dev', label: '开发工具', color: '#2563EB' },
        { id: 'product', label: '产品 / 商业', color: '#CA8A04' },
        { id: 'data', label: '数据 / 云', color: '#0D9488' },
        { id: 'game', label: '游戏 / 3D', color: '#16A34A' },
        { id: 'other', label: '其他', color: '#64748B' }
      ];

      const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

      const CAT_ICONS = {
        ios: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"></rect><path d="M11 18h2"></path></svg>',
        design: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
        video: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="m10 8 6 4-6 4Z"></path></svg>',
        social: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path></svg>',
        dev: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg>',
        product: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path></svg>',
        data: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14a9 3 0 0 0 18 0V5"></path><path d="M3 12a9 3 0 0 0 18 0"></path></svg>',
        game: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="12" y2="12"></line><line x1="8" x2="8" y1="10" y2="14"></line><line x1="15" x2="15.01" y1="13" y2="13"></line><line x1="18" x2="18.01" y1="11" y2="11"></line><rect width="20" height="12" x="2" y="6" rx="2"></rect></svg>',
        other: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1.5"></rect><rect width="7" height="7" x="14" y="3" rx="1.5"></rect><rect width="7" height="7" x="3" y="14" rx="1.5"></rect><rect width="7" height="7" x="14" y="14" rx="1.5"></rect></svg>'
      };

      const SOURCE_COLORS = {
        Shared: '#5E6AD2',
        Antigravity: '#2563EB',
        'AGY Plugin': '#7C3AED',
        Codex: '#0D9488',
        Claude: '#D97757',
        Cursor: '#64748B'
      };

      let disposed = false;
      let isOpen = false;
      let loading = false;
      let reqSeq = 0;
      let toastTimer = 0;
      const pendingReqs = new Map();

      let snap = null;
      let activeTab = 'gallery'; // gallery | audit | archive
      let searchText = '';
      let selectedCategory = 'all';
      let selectedSource = 'agy-active';
      let usageFilter = 'all'; // all | used | unused
      let sortOrder = 'usage'; // usage | name | size
      let detailSkill = null;
      let detailTab = 'demo'; // demo | source
      let detailContent = null;
      let detailLoading = false;

      function esc(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function showToast(text, tone = 'ok') {
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
        toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2500);
      }

      function callDaemon(payload) {
        return new Promise((resolve) => {
          if (typeof window.__agSkillDexRequest !== 'function') {
            resolve({ ok: false, error: 'Daemon 未就绪，请稍后重试或运行重启守护进程' });
            return;
          }
          const reqId = `sdx-${Date.now()}-${++reqSeq}`;
          const timer = setTimeout(() => {
            pendingReqs.delete(reqId);
            resolve({ ok: false, error: '请求超时' });
          }, 15000);
          pendingReqs.set(reqId, (res) => {
            clearTimeout(timer);
            resolve(res || { ok: false, error: '空响应' });
          });
          try {
            window.__agSkillDexRequest(JSON.stringify(Object.assign({ reqId }, payload)));
          } catch (err) {
            clearTimeout(timer);
            pendingReqs.delete(reqId);
            resolve({ ok: false, error: err?.message || '发送失败' });
          }
        });
      }

      window.__ag_on_skilldex_response = (reqId, res) => {
        const cb = pendingReqs.get(reqId);
        if (cb) {
          pendingReqs.delete(reqId);
          cb(res);
        }
      };

      function insertPromptIntoComposer(text) {
        if (!text) return false;
        const editors = Array.from(document.querySelectorAll('[data-lexical-editor="true"]')).filter((ed) => {
          const r = ed.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !ed.closest('[data-testid="side-question-panel"], [class*="side-question"]');
        });
        const editor = editors[0];
        if (!editor) {
          navigator.clipboard?.writeText?.(text).catch(() => {});
          showToast('未检测到输入框，已复制到剪贴板', 'info');
          return false;
        }
        closeModal();
        const moveEnd = () => {
          try {
            const sel = window.getSelection();
            if (!sel) return;
            const range = document.createRange();
            range.selectNodeContents(editor.querySelector('p') || editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {}
        };
        editor.focus();
        moveEnd();
        const lex = editor.__lexicalEditor;
        let cmd = null;
        try {
          if (lex?._commands?.keys) {
            for (const k of lex._commands.keys()) {
              if (k && k.type === 'CONTROLLED_TEXT_INSERTION_COMMAND') {
                cmd = k;
                break;
              }
            }
          }
        } catch {}
        if (lex && typeof lex.dispatchCommand === 'function' && cmd) {
          try {
            lex.focus?.(undefined, { defaultSelection: 'rootEnd' });
            lex.dispatchCommand(cmd, text);
            moveEnd();
            showToast('已填入 Antigravity 输入框', 'ok');
            return true;
          } catch {}
        }
        try {
          const ev = new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
            cancelable: true
          });
          editor.dispatchEvent(ev);
          if (!ev.defaultPrevented) {
            document.execCommand('insertText', false, text);
          }
        } catch {
          try {
            document.execCommand('insertText', false, text);
          } catch {}
        }
        moveEnd();
        showToast('已填入 Antigravity 输入框', 'ok');
        return true;
      }

      function formatKB(bytes) {
        return `${(Number(bytes || 0) / 1024).toFixed(1)} KB`;
      }

      function shortenPath(p) {
        const home = snap?.homeDir || '';
        return home && String(p || '').startsWith(home) ? '~' + String(p).slice(home.length) : String(p || '');
      }

      function isAgyActiveSource(src) {
        return src === 'Shared' || src === 'Antigravity' || src === 'AGY Plugin';
      }

      function getFilteredSkills(list, isArchiveTab = false) {
        const q = searchText.trim().toLowerCase();
        const out = (list || []).filter((s) => {
          if (!isArchiveTab) {
            if (selectedSource === 'agy-active') {
              if (!isAgyActiveSource(s.source)) return false;
            } else if (selectedSource !== 'all' && s.source !== selectedSource) {
              return false;
            }
          }
          if (selectedCategory !== 'all' && s.category !== selectedCategory) return false;
          if (!isArchiveTab) {
            if (usageFilter === 'used' && s.totalUseCount === 0) return false;
            if (usageFilter === 'unused' && s.totalUseCount > 0) return false;
          }
          if (q) {
            const hay = `${s.name} ${s.dirName} ${s.summary} ${s.cachedDemo?.headline || ''} ${s.pluginName || ''}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        if (isArchiveTab) {
          return out.sort((a, b) => a.name.localeCompare(b.name));
        }
        if (sortOrder === 'name') return out.sort((a, b) => a.name.localeCompare(b.name));
        if (sortOrder === 'size') return out.sort((a, b) => b.fileBytes - a.fileBytes);
        return out.sort((a, b) => (b.totalUseCount - a.totalUseCount) || a.name.localeCompare(b.name));
      }

      function getAuditBadgeCount() {
        if (!snap) return 0;
        const heavyRules = (snap.rules || []).filter(
          (r) => !r.isGlobalCore && r.isPluginEnabled && (r.triggerMode === 'always_on' || r.triggerMode === 'fixed_always_on')
        ).length;
        return heavyRules + (snap.duplicates?.length || 0);
      }

      function updateFooterBadge() {
        const btn = document.querySelector('#isdou-t3-sidebar-footer [data-isdou-action="skilldex"]');
        if (!btn) return;
        const cnt = getAuditBadgeCount();
        btn.toggleAttribute('data-isdou-has-alert', cnt > 0);
      }

      function ensureBackdrop() {
        let el = document.getElementById(BACKDROP_ID);
        if (!el && document.body) {
          el = document.createElement('div');
          el.id = BACKDROP_ID;
          el.setAttribute('data-ag-i18n-exclude', 'true');
          el.innerHTML = '<div id="isdou-skilldex-modal" role="dialog" aria-modal="true" aria-label="SkillDex"></div>';
          el.addEventListener('click', (e) => {
            if (e.target === el) closeModal();
          });
          document.body.appendChild(el);
        }
        return el;
      }

      function renderBodyHtml() {
        if (loading && !snap) {
          return '<div class="sdx-empty">正在扫描本地 Skills、插件与历史日志…</div>';
        }
        if (!snap) {
          return '<div class="sdx-empty">未能连接到本地守护进程，请点击右上角刷新重试</div>';
        }
        if (detailSkill) return renderDetailView(detailSkill);
        if (activeTab === 'gallery') return renderGalleryTab();
        if (activeTab === 'audit') return renderAuditTab();
        return renderArchiveTab();
      }

      function renderSkillCard(s, isArchive) {
        const cat = CAT_MAP[s.category] || CAT_MAP.other;
        const srcColor = SOURCE_COLORS[s.source] || '#64748B';
        const headline = s.cachedDemo?.headline || s.summary;
        const firstPrompt = (s.cachedDemo?.prompts && s.cachedDemo.prompts[0]) || (s.samplePrompts && s.samplePrompts[0]) || `/${s.name}`;
        const trigger = (s.triggers && s.triggers[0]) || `/${s.name}`;
        const hasDemo = Boolean((s.previewImages && s.previewImages.length > 0) || s.cachedDemo?.isAIGenerated);
        const usageHtml =
          s.totalUseCount > 0
            ? `<span class="sdx-usage-pill is-hot">${s.totalUseCount}次</span>`
            : `<span class="sdx-usage-pill">0次</span>`;

        return (
          `<div class="sdx-card" data-sdx-open-id="${esc(s.id)}">` +
          `<div class="sdx-card-head">` +
          `<span class="sdx-cat-icon" style="--sdx-cat:${cat.color}">${CAT_ICONS[s.category] || CAT_ICONS.other}</span>` +
          `<div class="sdx-card-title-wrap">` +
          `<div class="sdx-card-title">${esc(s.name)}${s.isSymlink ? '<span class="sdx-sym" title="软链">↗</span>' : ''}</div>` +
          `<div class="sdx-card-meta">` +
          `<span class="sdx-src" style="color:${srcColor}">${esc(s.pluginName || s.source)}</span>` +
          (hasDemo ? '<span class="sdx-demo-tag">Demo</span>' : '') +
          `</div></div>` +
          (isArchive
            ? `<button type="button" class="sdx-mini-btn is-primary" data-sdx-restore="${esc(s.folderPath)}">恢复</button>`
            : usageHtml) +
          `</div>` +
          `<div class="sdx-card-desc">${esc(headline)}</div>` +
          `<div class="sdx-card-foot">` +
          `<code class="sdx-trigger">${esc(trigger)}</code>` +
          `<div class="sdx-card-actions">` +
          (!isArchive
            ? `<button type="button" class="sdx-mini-btn is-accent" data-sdx-insert="${esc(firstPrompt)}" title="直接填入 Antigravity 输入框">填入</button>` +
              (s.canArchive
                ? `<button type="button" class="sdx-mini-btn" data-sdx-archive="${esc(s.folderPath)}" title="安全移入收纳箱">归档</button>`
                : '')
            : '') +
          `</div></div></div>`
        );
      }

      function renderGalleryTab() {
        const list = getFilteredSkills(snap.activeSkills, false);
        const sources = ['agy-active', 'Shared', 'Antigravity', 'AGY Plugin', 'all', 'Codex', 'Claude', 'Cursor'].filter(
          (src) => src === 'agy-active' || src === 'all' || snap.activeSkills.some((s) => s.source === src)
        );
        const sourceLabel = (src) =>
          src === 'agy-active' ? '当前生效 (AGY)' : src === 'all' ? '全部端 (含 Codex/Claude)' : src;

        const catChips = CATEGORIES.map(
          (c) =>
            `<button type="button" class="sdx-chip${selectedCategory === c.id ? ' is-active' : ''}" data-sdx-cat="${c.id}">${esc(c.label)}</button>`
        ).join('');

        const srcOpts = sources
          .map((src) => `<option value="${esc(src)}"${selectedSource === src ? ' selected' : ''}>${esc(sourceLabel(src))}</option>`)
          .join('');

        const bodyHtml =
          list.length === 0
            ? '<div class="sdx-empty">未找到匹配的技能，试试切换筛选条件或搜索词</div>'
            : `<div class="sdx-grid">${list.map((s) => renderSkillCard(s, false)).join('')}</div>`;

        return (
          `<div class="sdx-filter-bar">` +
          `<div class="sdx-chips">${catChips}</div>` +
          `<div class="sdx-filter-right">` +
          `<select class="sdx-select" data-sdx-select="source">${srcOpts}</select>` +
          `<div class="sdx-seg">` +
          `<button type="button" class="${usageFilter === 'all' ? 'is-active' : ''}" data-sdx-usage="all">全部</button>` +
          `<button type="button" class="${usageFilter === 'used' ? 'is-active' : ''}" data-sdx-usage="used">常用</button>` +
          `<button type="button" class="${usageFilter === 'unused' ? 'is-active' : ''}" data-sdx-usage="unused">0次吃灰</button>` +
          `</div>` +
          `<select class="sdx-select" data-sdx-select="sort">` +
          `<option value="usage"${sortOrder === 'usage' ? ' selected' : ''}>按高频</option>` +
          `<option value="name"${sortOrder === 'name' ? ' selected' : ''}>按名称</option>` +
          `<option value="size"${sortOrder === 'size' ? ' selected' : ''}>按体积</option>` +
          `</select>` +
          `</div></div>` +
          `<div class="sdx-scroll">${bodyHtml}</div>`
        );
      }

      function renderDetailView(s) {
        const cat = CAT_MAP[s.category] || CAT_MAP.other;
        const prompts = (s.cachedDemo?.prompts && s.cachedDemo.prompts.length > 0 ? s.cachedDemo.prompts : s.samplePrompts) || [];
        const headline = s.cachedDemo?.headline || s.rawDescription || s.summary;

        let innerHtml = '';
        if (detailTab === 'demo') {
          const promptRows = prompts
            .map(
              (p) =>
                `<div class="sdx-prompt-row">` +
                `<span class="sdx-prompt-text">${esc(p)}</span>` +
                `<div class="sdx-prompt-btns">` +
                `<button type="button" class="sdx-mini-btn is-accent" data-sdx-insert="${esc(p)}">填入输入框</button>` +
                `<button type="button" class="sdx-mini-btn" data-sdx-copy="${esc(p)}">复制</button>` +
                `</div></div>`
            )
            .join('');

          const imgsHtml =
            detailContent?.previewImages && detailContent.previewImages.length > 0
              ? `<div class="sdx-preview-imgs">${detailContent.previewImages
                  .map(
                    (img) =>
                      `<img class="sdx-preview-img" src="${img.dataUrl}" alt="${esc(img.name)}" title="${esc(img.name)}" data-sdx-open-path="${esc(img.path)}" />`
                  )
                  .join('')}</div>`
              : '';

          const filesHtml =
            s.bundledFiles && s.bundledFiles.length > 0
              ? `<div class="sdx-file-tags">${s.bundledFiles.map((f) => `<code>${esc(f)}</code>`).join('')}</div>`
              : '';

          innerHtml =
            `<div class="sdx-detail-card"><div class="sdx-detail-lbl">它能做什么</div><div class="sdx-detail-text">${esc(headline)}</div></div>` +
            `<div class="sdx-detail-card"><div class="sdx-detail-lbl">推荐触发口令（点击直接填入当前对话框）</div><div class="sdx-prompt-list">${promptRows}</div></div>` +
            `<div class="sdx-detail-card"><div class="sdx-detail-lbl">Demo 效果与附带资源</div>` +
            (s.cachedDemo?.demoPreview ? `<div class="sdx-demo-box">${esc(s.cachedDemo.demoPreview)}</div>` : '') +
            imgsHtml +
            filesHtml +
            (!s.cachedDemo?.demoPreview && !imgsHtml && !filesHtml
              ? '<div class="sdx-muted">该技能为纯指令型 Skill，无附带图片或脚本文件</div>'
              : '') +
            `</div>` +
            `<div class="sdx-detail-card"><div class="sdx-detail-lbl">本地路径</div>` +
            `<div class="sdx-path">${esc(shortenPath(s.folderPath))}</div>` +
            (s.symlinkTarget ? `<div class="sdx-path is-sym">软链指向 → ${esc(s.symlinkTarget)}</div>` : '') +
            `</div>`;
        } else {
          innerHtml = detailLoading
            ? '<div class="sdx-empty">正在读取 SKILL.md…</div>'
            : `<pre class="sdx-source-pre">${esc(detailContent?.content || '未能读取 SKILL.md')}</pre>`;
        }

        return (
          `<div class="sdx-detail-top">` +
          `<button type="button" class="sdx-back-btn" data-sdx-back="1">← 返回列表</button>` +
          `<span class="sdx-cat-icon" style="--sdx-cat:${cat.color}">${CAT_ICONS[s.category] || CAT_ICONS.other}</span>` +
          `<div class="sdx-detail-head-info">` +
          `<div class="sdx-detail-name">${esc(s.name)} <span class="sdx-badge">${esc(s.pluginName || s.source)}</span></div>` +
          `<div class="sdx-detail-sub">${
            s.totalUseCount > 0 ? `历史调用 ${s.totalUseCount} 次（AGY ${s.agyUseCount} / Codex ${s.codexUseCount}）` : '历史 0 次调用'
          } · 清单占用 ~${s.estimatedPromptTokens} tok · ${formatKB(s.fileBytes)}</div>` +
          `</div>` +
          `<div class="sdx-seg">` +
          `<button type="button" class="${detailTab === 'demo' ? 'is-active' : ''}" data-sdx-dtab="demo">用法 & Demo</button>` +
          `<button type="button" class="${detailTab === 'source' ? 'is-active' : ''}" data-sdx-dtab="source">SKILL.md</button>` +
          `</div></div>` +
          `<div class="sdx-scroll sdx-detail-body">${innerHtml}</div>` +
          `<div class="sdx-detail-foot">` +
          `<div class="sdx-detail-foot-left">` +
          `<button type="button" class="sdx-btn" data-sdx-reveal="${esc(s.folderPath)}">Finder 打开</button>` +
          `<button type="button" class="sdx-btn" data-sdx-open-path="${esc(s.skillMdPath)}">编辑 SKILL.md</button>` +
          `</div>` +
          `<div class="sdx-detail-foot-right">` +
          (s.canArchive
            ? s.isArchived
              ? `<button type="button" class="sdx-btn is-primary" data-sdx-restore="${esc(s.folderPath)}">恢复启用</button>`
              : `<button type="button" class="sdx-btn" data-sdx-archive="${esc(s.folderPath)}">收入收纳箱</button>`
            : '') +
          (s.canArchive
            ? `<button type="button" class="sdx-btn is-danger" data-sdx-remove="${esc(s.folderPath)}">${s.isSymlink ? '移除软链' : '移入废纸篓'}</button>`
            : '') +
          `</div></div>`
        );
      }

      function renderAuditTab() {
        const unusedList = (snap.activeSkills || []).filter(
          (s) => isAgyActiveSource(s.source) && s.canArchive && s.totalUseCount === 0
        );
        const heavyRules = (snap.rules || []).filter(
          (r) => !r.isGlobalCore && r.isPluginEnabled && (r.triggerMode === 'always_on' || r.triggerMode === 'fixed_always_on')
        );
        const ratio = Math.min(100, Math.round((snap.agyMountedCount / (snap.recommendedCeiling || 160)) * 100));
        const overBudget = snap.agyMountedCount > (snap.recommendedCeiling || 160);

        const rulesHtml = (snap.rules || [])
          .map((r) => {
            const isWarn = !r.isGlobalCore && r.isPluginEnabled && (r.triggerMode === 'always_on' || r.triggerMode === 'fixed_always_on');
            const statusText = !r.isPluginEnabled
              ? '插件已关闭'
              : r.triggerMode === 'model_decision'
                ? '按需 model_decision'
                : r.isGlobalCore
                  ? '全局核心常驻'
                  : '强制常驻';
            let actBtn = '';
            if (!r.isGlobalCore) {
              if (r.pluginName) {
                actBtn = `<button type="button" class="sdx-mini-btn${r.isPluginEnabled ? ' is-warn' : ' is-accent'}" data-sdx-plugin-toggle="${esc(r.pluginName)}" data-sdx-plugin-next="${r.isPluginEnabled ? '0' : '1'}">${r.isPluginEnabled ? '关闭插件省额度' : '重新开启'}</button>`;
              } else if (r.triggerMode !== 'fixed_always_on') {
                actBtn = `<button type="button" class="sdx-mini-btn" data-sdx-rule-toggle="${esc(r.filePath)}">${r.triggerMode === 'always_on' ? '改按需加载' : '改常驻'}</button>`;
              }
            }
            return (
              `<div class="sdx-audit-row${isWarn ? ' is-warn' : ''}">` +
              `<div class="sdx-audit-info">` +
              `<div class="sdx-audit-title">${esc(r.title)} <span class="sdx-badge${isWarn ? ' is-warn' : ''}">${statusText}</span></div>` +
              `<div class="sdx-audit-sub">${formatKB(r.bytes)} · ~${r.estimatedTokens} tokens/轮 · ${esc(r.scopeLabel)}</div>` +
              `</div>` +
              `<div class="sdx-audit-acts">${actBtn}<button type="button" class="sdx-mini-btn" data-sdx-reveal="${esc(r.filePath)}">定位</button></div>` +
              `</div>`
            );
          })
          .join('');

        const dupHtml =
          snap.duplicates && snap.duplicates.length > 0
            ? `<div class="sdx-section"><div class="sdx-section-hdr"><span>重复副本 (${snap.duplicates.length})</span></div>` +
              snap.duplicates
                .map(
                  (g) =>
                    `<div class="sdx-audit-row is-warn"><div class="sdx-audit-info">` +
                    `<div class="sdx-audit-title">${esc(g.name)}</div>` +
                    `<div class="sdx-audit-sub">${esc(g.reason)} · ${g.entries.map((e) => esc(e.source)).join(' + ')}</div>` +
                    `</div><button type="button" class="sdx-mini-btn is-accent" data-sdx-dedup="${esc(g.id)}">安全去重</button></div>`
                )
                .join('') +
              `</div>`
            : '';

        const unusedSection =
          unusedList.length > 0
            ? `<div class="sdx-section"><div class="sdx-section-hdr"><span>0 次吃灰技能 (${unusedList.length})</span>` +
              `<button type="button" class="sdx-mini-btn is-warn" data-sdx-archive-unused="1">全部收入收纳箱</button></div>` +
              `<div class="sdx-unused-grid">${unusedList
                .slice(0, 24)
                .map(
                  (s) =>
                    `<div class="sdx-unused-item"><span class="sdx-unused-name" data-sdx-open-id="${esc(s.id)}">${esc(s.name)}</span>` +
                    `<button type="button" class="sdx-mini-btn" data-sdx-archive="${esc(s.folderPath)}">归档</button></div>`
                )
                .join('')}</div>` +
              (unusedList.length > 24
                ? `<button type="button" class="sdx-link-btn" data-sdx-goto-unused="1">在图鉴中筛选全部 ${unusedList.length} 个吃灰技能 →</button>`
                : '') +
              `</div>`
            : '';

        const enabledPlugCount = (snap.plugins || []).filter((p) => p.enabled).length;
        const pluginsHtml = (snap.plugins || [])
          .map(
            (p) =>
              `<div class="sdx-audit-row">` +
              `<div class="sdx-audit-info">` +
              `<div class="sdx-audit-title">${esc(p.displayName)}` +
              (p.skillCount > 0 ? `<span class="sdx-badge${p.skillCount >= 15 ? ' is-warn' : ''}">${p.skillCount} skills</span>` : '') +
              (p.ruleBytes > 0 ? `<span class="sdx-badge is-warn">常驻规则 ${formatKB(p.ruleBytes)}</span>` : '') +
              (p.mcpServers.length > 0 ? '<span class="sdx-badge is-accent">MCP</span>' : '') +
              `</div>` +
              (p.description ? `<div class="sdx-audit-sub">${esc(p.description.slice(0, 110))}</div>` : '') +
              `</div>` +
              `<button type="button" class="sdx-switch${p.enabled ? ' is-on' : ''}" role="switch" aria-checked="${p.enabled}" data-sdx-plugin-toggle="${esc(p.dirName)}" data-sdx-plugin-next="${p.enabled ? '0' : '1'}"><span></span></button>` +
              `</div>`
          )
          .join('');

        return (
          `<div class="sdx-scroll sdx-audit-body">` +
          `<div class="sdx-metrics">` +
          `<div class="sdx-metric"><div class="sdx-metric-lbl">每轮常驻 Rules</div><div class="sdx-metric-val${heavyRules.length ? ' is-warn' : ' is-ok'}">~${snap.alwaysOnRuleTokens}<span>tokens</span></div></div>` +
          `<div class="sdx-metric"><div class="sdx-metric-lbl">Antigravity 挂载水位</div><div class="sdx-metric-val${overBudget ? ' is-warn' : ''}">${snap.agyMountedCount}<span>/ ${snap.recommendedCeiling} 建议上限</span></div><div class="sdx-bar"><span style="width:${ratio}%;background:${overBudget ? '#D97706' : 'var(--isdou-accent)'}"></span></div></div>` +
          `<div class="sdx-metric"><div class="sdx-metric-lbl">0 次吃灰技能</div><div class="sdx-metric-val">${unusedList.length}<span>基于 ${snap.agySessions + snap.codexSessions} 次历史对话</span></div></div>` +
          `</div>` +
          `<div class="sdx-section"><div class="sdx-section-hdr"><span>常驻 Rules 体检</span></div>${rulesHtml || '<div class="sdx-muted">暂无常驻规则</div>'}</div>` +
          dupHtml +
          unusedSection +
          `<div class="sdx-section"><div class="sdx-section-hdr"><span>Antigravity 插件总控 (${enabledPlugCount}/${snap.plugins.length} 启用)</span></div>${pluginsHtml}</div>` +
          `</div>`
        );
      }

      function renderArchiveTab() {
        const list = getFilteredSkills(snap.archivedSkills, true);
        const bodyHtml =
          list.length === 0
            ? '<div class="sdx-empty">收纳箱是空的，归档后的技能会安全存放在 skills-archive/ 中</div>'
            : `<div class="sdx-grid">${list.map((s) => renderSkillCard(s, true)).join('')}</div>`;
        return (
          `<div class="sdx-filter-bar">` +
          `<span class="sdx-muted">已归档 ${snap.archivedSkills.length} 个技能 · 随时一键恢复原目录</span>` +
          `<button type="button" class="sdx-mini-btn" data-sdx-reveal="${esc(snap.homeDir)}/.agents/skills-archive">Finder 打开备份目录</button>` +
          `</div>` +
          `<div class="sdx-scroll">${bodyHtml}</div>`
        );
      }

      function renderModal() {
        const backdrop = ensureBackdrop();
        if (!backdrop) return;
        const modal = backdrop.querySelector('#isdou-skilldex-modal');
        if (!modal) return;

        const alertCnt = getAuditBadgeCount();
        const activeCnt = snap?.agyMountedCount ?? 0;
        const archCnt = snap?.archivedSkills?.length || 0;

        modal.innerHTML =
          `<div class="sdx-topbar">` +
          `<div class="sdx-brand">` +
          `<span class="sdx-logo" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--isdou-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path></svg></span>` +
          `<span class="sdx-brand-name">SkillDex</span>` +
          `</div>` +
          `<div class="sdx-tabs">` +
          `<button type="button" class="sdx-tab${activeTab === 'gallery' && !detailSkill ? ' is-active' : ''}" data-sdx-tab="gallery">图鉴 <span>${activeCnt}</span></button>` +
          `<button type="button" class="sdx-tab${activeTab === 'audit' && !detailSkill ? ' is-active' : ''}" data-sdx-tab="audit">体检 ${alertCnt > 0 ? `<span class="is-warn">${alertCnt}</span>` : ''}</button>` +
          `<button type="button" class="sdx-tab${activeTab === 'archive' && !detailSkill ? ' is-active' : ''}" data-sdx-tab="archive">收纳箱 <span>${archCnt}</span></button>` +
          `</div>` +
          `<div class="sdx-top-right">` +
          `<input type="search" class="sdx-search" placeholder="搜索技能、用途或插件…" value="${esc(searchText)}" data-sdx-search="1" />` +
          `<button type="button" class="sdx-icon-btn" data-sdx-refresh="1" title="重新扫描目录与历史日志"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg></button>` +
          `<button type="button" class="sdx-icon-btn" data-sdx-close="1" title="关闭 (Esc)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button>` +
          `</div></div>` +
          `<div class="sdx-body">${renderBodyHtml()}</div>`;

        bindModalEvents(modal);
        updateFooterBadge();
      }

      async function openSkillDetail(skillId) {
        if (!snap) return;
        const found =
          snap.activeSkills.find((s) => s.id === skillId) ||
          snap.archivedSkills.find((s) => s.id === skillId);
        if (!found) return;
        detailSkill = found;
        detailTab = 'demo';
        detailContent = null;
        detailLoading = true;
        renderModal();
        const res = await callDaemon({ action: 'readSkill', skillMdPath: found.skillMdPath });
        if (detailSkill && detailSkill.id === found.id) {
          detailLoading = false;
          if (res?.ok) detailContent = res;
          renderModal();
        }
      }

      async function loadSnapshot(reanalyzeLogs = false) {
        loading = true;
        if (isOpen) renderModal();
        const res = await callDaemon({ action: 'snapshot', reanalyzeLogs });
        loading = false;
        if (res?.ok) {
          snap = res;
          if (detailSkill) {
            detailSkill =
              snap.activeSkills.find((s) => s.id === detailSkill.id) ||
              snap.archivedSkills.find((s) => s.id === detailSkill.id) ||
              null;
          }
        } else if (isOpen) {
          showToast(res?.error || '扫描本地技能失败', 'error');
        }
        updateFooterBadge();
        if (isOpen) renderModal();
      }

      function bindModalEvents(modal) {
        const searchInput = modal.querySelector('[data-sdx-search="1"]');
        if (searchInput) {
          searchInput.addEventListener('input', (e) => {
            searchText = e.target.value || '';
            const pos = e.target.selectionStart;
            const body = modal.querySelector('.sdx-body');
            if (body) {
              body.innerHTML = renderBodyHtml();
              bindBodyEvents(body);
            }
            searchInput.focus();
            try {
              searchInput.setSelectionRange(pos, pos);
            } catch {}
          });
        }

        modal.querySelector('[data-sdx-close="1"]')?.addEventListener('click', closeModal);
        modal.querySelector('[data-sdx-refresh="1"]')?.addEventListener('click', () => {
          showToast('正在重新扫描本地目录与日志…', 'info');
          loadSnapshot(true);
        });
        modal.querySelectorAll('[data-sdx-tab]').forEach((btn) => {
          btn.addEventListener('click', () => {
            activeTab = btn.getAttribute('data-sdx-tab') || 'gallery';
            detailSkill = null;
            renderModal();
          });
        });

        const body = modal.querySelector('.sdx-body');
        if (body) bindBodyEvents(body);
      }

      function bindBodyEvents(body) {
        body.addEventListener('click', async (e) => {
          const t = e.target;
          if (!t || typeof t.closest !== 'function') return;

          const insertBtn = t.closest('[data-sdx-insert]');
          if (insertBtn) {
            e.stopPropagation();
            insertPromptIntoComposer(insertBtn.getAttribute('data-sdx-insert'));
            return;
          }
          const copyBtn = t.closest('[data-sdx-copy]');
          if (copyBtn) {
            e.stopPropagation();
            const text = copyBtn.getAttribute('data-sdx-copy') || '';
            navigator.clipboard?.writeText?.(text).catch(() => {});
            showToast('已复制触发口令', 'ok');
            return;
          }
          const archiveBtn = t.closest('[data-sdx-archive]');
          if (archiveBtn) {
            e.stopPropagation();
            const fp = archiveBtn.getAttribute('data-sdx-archive');
            const res = await callDaemon({ action: 'archive', folderPath: fp });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              detailSkill = null;
              showToast('已安全移入收纳箱', 'ok');
              renderModal();
            } else {
              showToast(res?.error || '归档失败', 'error');
            }
            return;
          }
          const restoreBtn = t.closest('[data-sdx-restore]');
          if (restoreBtn) {
            e.stopPropagation();
            const fp = restoreBtn.getAttribute('data-sdx-restore');
            const res = await callDaemon({ action: 'restore', folderPath: fp });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              detailSkill = null;
              showToast('已恢复启用', 'ok');
              renderModal();
            } else {
              showToast(res?.error || '恢复失败', 'error');
            }
            return;
          }
          const removeBtn = t.closest('[data-sdx-remove]');
          if (removeBtn) {
            e.stopPropagation();
            const fp = removeBtn.getAttribute('data-sdx-remove');
            const res = await callDaemon({ action: 'remove', folderPath: fp });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              detailSkill = null;
              showToast(res.wasSymlink ? '已移除软链（源文件保留）' : '已移入废纸篓', 'info');
              renderModal();
            } else {
              showToast(res?.error || '移除失败', 'error');
            }
            return;
          }
          const pluginBtn = t.closest('[data-sdx-plugin-toggle]');
          if (pluginBtn) {
            e.stopPropagation();
            const dirName = pluginBtn.getAttribute('data-sdx-plugin-toggle');
            const nextOn = pluginBtn.getAttribute('data-sdx-plugin-next') === '1';
            const res = await callDaemon({ action: 'setPlugin', dirName, enabled: nextOn });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              showToast(`${nextOn ? '已启用' : '已关闭'}插件 · ${dirName}`, 'ok');
              renderModal();
            } else {
              showToast(res?.error || '操作失败', 'error');
            }
            return;
          }
          const ruleBtn = t.closest('[data-sdx-rule-toggle]');
          if (ruleBtn) {
            e.stopPropagation();
            const res = await callDaemon({ action: 'toggleRule', filePath: ruleBtn.getAttribute('data-sdx-rule-toggle') });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              showToast('已切换规则触发模式', 'ok');
              renderModal();
            } else {
              showToast(res?.error || '切换失败', 'error');
            }
            return;
          }
          const dedupBtn = t.closest('[data-sdx-dedup]');
          if (dedupBtn) {
            e.stopPropagation();
            const res = await callDaemon({ action: 'resolveDuplicate', groupId: dedupBtn.getAttribute('data-sdx-dedup') });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              showToast(`已清理 ${res.removed || 0} 个重复副本`, 'ok');
              renderModal();
            }
            return;
          }
          const archiveUnusedBtn = t.closest('[data-sdx-archive-unused]');
          if (archiveUnusedBtn && snap) {
            e.stopPropagation();
            const paths = snap.activeSkills
              .filter((s) => isAgyActiveSource(s.source) && s.canArchive && s.totalUseCount === 0)
              .map((s) => s.folderPath);
            const res = await callDaemon({ action: 'archiveMany', folderPaths: paths });
            if (res?.ok && res.snapshot) {
              snap = res.snapshot;
              showToast(`已将 ${res.moved || 0} 个吃灰技能移入收纳箱`, 'ok');
              renderModal();
            }
            return;
          }
          const gotoUnused = t.closest('[data-sdx-goto-unused]');
          if (gotoUnused) {
            activeTab = 'gallery';
            usageFilter = 'unused';
            renderModal();
            return;
          }
          const revealBtn = t.closest('[data-sdx-reveal]');
          if (revealBtn) {
            e.stopPropagation();
            callDaemon({ action: 'reveal', targetPath: revealBtn.getAttribute('data-sdx-reveal') });
            return;
          }
          const openPathBtn = t.closest('[data-sdx-open-path]');
          if (openPathBtn) {
            e.stopPropagation();
            callDaemon({ action: 'open', targetPath: openPathBtn.getAttribute('data-sdx-open-path') });
            return;
          }
          const catBtn = t.closest('[data-sdx-cat]');
          if (catBtn) {
            selectedCategory = catBtn.getAttribute('data-sdx-cat') || 'all';
            renderModal();
            return;
          }
          const usageBtn = t.closest('[data-sdx-usage]');
          if (usageBtn) {
            usageFilter = usageBtn.getAttribute('data-sdx-usage') || 'all';
            renderModal();
            return;
          }
          const dtabBtn = t.closest('[data-sdx-dtab]');
          if (dtabBtn) {
            detailTab = dtabBtn.getAttribute('data-sdx-dtab') || 'demo';
            renderModal();
            return;
          }
          if (t.closest('[data-sdx-back]')) {
            detailSkill = null;
            renderModal();
            return;
          }
          const card = t.closest('[data-sdx-open-id]');
          if (card) {
            openSkillDetail(card.getAttribute('data-sdx-open-id'));
          }
        });

        body.querySelectorAll('[data-sdx-select]').forEach((sel) => {
          sel.addEventListener('change', () => {
            const kind = sel.getAttribute('data-sdx-select');
            if (kind === 'source') selectedSource = sel.value || 'all';
            if (kind === 'sort') sortOrder = sel.value || 'usage';
            renderModal();
          });
        });
      }

      function openModal(initialTab = null) {
        if (disposed) return;
        if (initialTab) activeTab = initialTab;
        detailSkill = null;
        isOpen = true;
        const backdrop = ensureBackdrop();
        if (backdrop) backdrop.setAttribute('data-open', 'true');
        renderModal();
        loadSnapshot(false);
      }

      function closeModal() {
        isOpen = false;
        detailSkill = null;
        const backdrop = document.getElementById(BACKDROP_ID);
        if (backdrop) backdrop.removeAttribute('data-open');
      }

      function toggleModal() {
        if (isOpen) closeModal();
        else openModal();
      }

      function onKeyDown(e) {
        if (isOpen && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (detailSkill) {
            detailSkill = null;
            renderModal();
          } else {
            closeModal();
          }
          return;
        }
        const mod = /Mac/i.test(navigator.platform || '') ? e.metaKey : e.ctrlKey;
        if (mod && e.shiftKey && !e.altKey && String(e.key || '').toLowerCase() === 'k') {
          e.preventDefault();
          e.stopPropagation();
          toggleModal();
        }
      }

      document.addEventListener('keydown', onKeyDown, true);

      window.__isdouSkillDex = {
        open: openModal,
        close: closeModal,
        toggle: toggleModal,
        refresh: () => loadSnapshot(true)
      };

      // 延迟 1.8 秒后台静默预热快照以点亮底栏体检红点提示
      const warmTimer = setTimeout(() => {
        if (!disposed && typeof window.__agSkillDexRequest === 'function') {
          loadSnapshot(false);
        }
      }, 1800);

      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        clearTimeout(warmTimer);
        if (toastTimer) clearTimeout(toastTimer);
        document.removeEventListener('keydown', onKeyDown, true);
        pendingReqs.clear();
        document.getElementById(BACKDROP_ID)?.remove();
        delete window.__ag_on_skilldex_response;
        delete window.__isdouSkillDex;
      });
    })();
  }
