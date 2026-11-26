# isdou 主题安装包

需要 Node.js 22.13 或更高版本。解压整个 ZIP，在含有 `install.mjs` 的目录打开终端。

## 首次安装和订阅

```bash
node install.mjs install --auto-update
```

安装后就可以关闭终端。后台服务会从项目的正式发行版检查更新，新样式和中文文案会自动出现在打开的窗口里。如果新版涉及运行程序，点侧栏的「更新主题」打开对应发行页，下载新 ZIP，解压并再运行上面的安装命令。正常升级会保留个人配置。

## 常用命令

```bash
node install.mjs update --check
node install.mjs update
node install.mjs update --rollback
node install.mjs uninstall
```

普通安装可以使用 `node install.mjs install`。安装后的个人设置在 `~/.gemini/antigravity/isdou-theme/user/config.json`，其中 `autoUpdate` 控制自动检查。更新、回退均在本机进行。

[完整使用文档](https://github.com/isdou/antigravity-isdou-theme) · [正式发行版](https://github.com/isdou/antigravity-isdou-theme/releases)
