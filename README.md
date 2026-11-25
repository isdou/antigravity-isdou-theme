# antigravity-isdou-theme

面向 Google Antigravity 的 **Linear 极简克制风格** 界面主题、中文汉化与 Claude Code 风格输入框 `Tab` 下一句预测。

## 样式模块分层

所有视觉样式均以 [00-tokens.css](core/styles/00-tokens.css) 中的 Design Tokens 为单一数据源，无冗余挂件：

- `core/styles/00-tokens.css` — Linear 昼夜色阶（Daylight / Obsidian）、6px 精密几何圆角、字重与边线变量
- `core/styles/10-sidebar.css` — Linear 极简侧边栏（1px 发丝线、6px 利落胶囊、项目树垂直引导线、隐形滚动条）
- `core/styles/15-topbar.css` — Linear 正交顶栏、面包屑与面板切换图标
- `core/styles/20-chat.css` — 主对话气泡、Markdown 排版、代码块与工具调用活动时间轴
- `core/styles/30-composer.css` — 底部输入框、6px 属性芯片与 Claude Code 风格浅灰 `Tab` / `→` 下一句预测
- `core/styles/40-modals-home.css` — 系统设置弹窗、命令面板（`⌘K`）与首页空白欢迎页

## 安装与日常命令

```bash
node install.mjs build-manifest
npm run check
node install.mjs install --sync-user
node --disable-warning=ExperimentalWarning install.mjs doctor
```

## 致谢与协议

底层 CDP 热重载注入与 `2.33.0+` 冷启动接力机制参考了社区 MIT 开源项目 [Anarcadia/chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) 与 [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme)，视觉设计与交互层完全重制。基于 [MIT License](LICENSE) 开源。
