# CodeBuddy Workbench — CodeBuddy 风格工作台（Codex 插件）

把当前项目打开成 **CodeBuddy IDE 风格** 的工作台布局。因 Codex 官方应用不提供改写自身窗口的扩展点，本插件采用"自研前端 + 本地服务"的方式：在**你的默认浏览器**里弹出一个独立窗口，呈现完整的四区布局，聊天栏接的就是**真 Codex**（`codex exec`）。

## 布局

```
┌──────────┬─────────────────────────────┬──────────┐
│  文件树   │  预览（代码/MD/图片/PDF 多标签）│  Codex   │
│  +git徽标 │ ─────────────────────────── │  对话     │
│           │  终端（真实 PTY，可隐藏）    │ （接exec）│
└──────────┴─────────────────────────────┴──────────┘
```

- **左 · 文件树**：懒加载展开、git 状态徽标（M/A/U/D/R）、底部 git 栏（分支、↑ahead ↓behind、更改数）；"问题"面板列出未提交改动，点击可跳转并展开
- **中上 · 预览**：多标签页；代码（带行号、自动换行）、Markdown（渲染 + 相对链接跳转）、图片、PDF
- **中下 · 终端**：真实 PTY（node-pty + ConPTY），xterm.js 前端，可在 PowerShell 7 / Windows PowerShell / cmd / bash 间切换；整栏可隐藏
- **右 · 聊天**：把消息桥接给 `codex exec --json`（含续聊 resume、工具/思考/命令折叠卡片、沙箱档位切换）；每轮结束自动刷新 git 状态
- 三栏均可拖拽调宽、可隐藏，状态存浏览器 localStorage

## 安装

```bash
# 1. 把仓库作为本地 marketplace 加入 Codex
codex plugin marketplace add "C:/路径/到/codex-codebuddy-workbench"

# 2. 安装插件（名为 codex-codebuddy-workbench）
codex plugin add codex-codebuddy-workbench@codex-codebuddy-workbench
```

> marketplace 路径即本仓库根目录（含 `.agents/plugins/marketplace.json`）。也可直接复制 `plugins/codex-codebuddy-workbench` 到 `~/.codex/plugins/` 后用 `codex plugin add`。

## 使用

在 Codex 里说：

- **"用 CodeBuddy 布局打开当前项目"** → 后台起服务，自动在浏览器打开工作台
- **"关闭工作台"** → 停掉后台服务

或手动起服务（任何项目目录）：

```bash
node <插件>/skills/codebuddy-workbench/server/server.js --daemon --root "<项目目录>"
# 浏览器打开它打印的 http://127.0.0.1:<端口>/?token=...
node <插件>/skills/codebuddy-workbench/server/server.js --stop
```

## 技术说明

- 服务零第三方依赖（`node-pty` 原生模块已随插件 vendor，仅含 win32-x64 预编译；其余均为 Node 内置）。
- 服务只监听 `127.0.0.1`；所有 HTTP/WS 必须带随机 token（首次访问写入同站 Cookie，之后免 token）。文件 API 限制在项目根目录内。
- 聊天栏沙箱档位透传给 `codex exec -s`，默认 `workspace-write`，`full-access` 需手动点选。
- 兼容 `codex` 的多种安装形态：npm 全局、官方原生 `codex.exe`（在 npm 包内）、PATH 中的可执行文件；统一解析成原生 exe 或 `node + codex.js` 直接启动，**完全不经过 cmd.exe / `.cmd` 垫片 / `shell:true`**。

## Windows 上不再弹命令行黑框

工作台会频繁拉起子进程（git 状态、定时任务、终端、codex 会话），旧实现有几处会闪出控制台窗口。当前版本已全部收敛：

- 所有控制台类子进程统一带 `windowsHide: true`（git / taskkill / PowerShell 目录选择 / 定时命令 / codex）；GUI 程序（浏览器、资源管理器）不加该标志，避免正常窗口被一起隐藏。
- 打开浏览器改用 `rundll32`（失败回退 `explorer`），不再用 `cmd /c start` + `shell:true` 连开两层 cmd.exe。
- 关闭 PTY 终端不再 `fork` 出一个 node.exe；ConPTY 的 `ClosePseudoConsole` 已能结束附加进程，而原来的 `AttachConsole` 调用在现代 Windows 上必然失败并打印崩溃堆栈。
- shell 探测改为同步扫描 PATH，不再每次刷新页面启动 3 个 `where.exe`；git 自动刷新从 6 秒放宽到 12 秒，且后台标签页不刷新。
- `codex.exe` / `codex.js` / npm `.cmd` 垫片都被解析成可执行文件，聊天与定时任务不再依赖 `shell: true`（同时消除 Node 的 DEP0190 告警与参数拼接风险）。

环境变量：`BUDDY_CODEX_BIN`（手动指定 codex 可执行文件 / JS 入口）、`BUDDY_STATE_DIR`（隔离状态目录，供多实例与自检使用）、`BUDDY_FALLBACK_MODEL`（限流时自动回退的模型）。

## 自检

```bash
node plugins/codex-codebuddy-workbench/scripts/smoke.mjs
```

零第三方依赖，自动在临时目录创建隔离的 git 仓库与假 codex，起停一个独立服务实例（不触碰用户真实状态），覆盖 HTTP/WS、git 操作、定时任务、PTY 终端、聊天桥接，并静态检查弹窗隐患；全部通过时退出码为 0。Node ≥ 22 才会跑 WebSocket 用例（用到内置 `WebSocket`）。

## 浏览器自动化工具（browser.mjs）

仓库自带一个**零依赖**的 Chromium 驱动（`plugins/codex-codebuddy-workbench/browser.mjs`，仅用 Node 内置 WebSocket 直连 Chrome DevTools Protocol）。它让 AI / 脚本能自己拉起浏览器、打开本地页面、执行 JS、点击、截图、取 HTML——**无需安装 `playwright` npm 包，也不依赖任何浏览器类 MCP**。

前提：本机装了 Playwright 的 Chromium 内核（脚本会自动探测 `~/.../ms-playwright/chromium-*`；找不到时用环境变量 `BROWSER_MJS_CHROME` 指向 chrome 可执行文件）。

```bash
node plugins/codex-codebuddy-workbench/browser.mjs start                  # 拉起无头 Chromium（守护）
node plugins/codex-codebuddy-workbench/browser.mjs open "<url>"            # 打开页面（file:// 或 localhost）
node plugins/codex-codebuddy-workbench/browser.mjs eval "<js>"             # 执行 JS，打印返回值
node plugins/codex-codebuddy-workbench/browser.mjs click "<选择器>"         # 按 CSS 选择器点击（取元素中心）
node plugins/codex-codebuddy-workbench/browser.mjs click <x> <y>            # 按坐标点击
node plugins/codex-codebuddy-workbench/browser.mjs screenshot [out.png]    # 截图存盘
node plugins/codex-codebuddy-workbench/browser.mjs html [out.html]          # 导出页面 HTML
node plugins/codex-codebuddy-workbench/browser.mjs stop                     # 关闭浏览器
```

> 这是给 AI / 脚本用的"手和眼"，与工作台里给人看的预览窗口互不冲突。

## 局限

- 这是独立浏览器窗口的工作台，**不是替换 Codex 应用本身的窗口**——Codex 官方应用没有改自身布局的扩展点。本工作台是"整窗 CodeBuddy 布局"最接近的形态，聊天栏接的就是真 Codex。
- 聊天桥接走 `codex exec`，每轮是一个完整回合（无逐 token 流式）；交互式审批类操作建议留在 read-only / workspace-write 档位。
- 终端依赖 win32-x64 原生模块；在 arm64/32 位 Node 上终端栏会显示"node-pty 不可用"（其余功能正常）。

## 目录结构

```
codex-codebuddy-workbench/                 # marketplace 根
├─ .agents/plugins/marketplace.json
└─ plugins/codex-codebuddy-workbench/
   ├─ .codex-plugin/plugin.json
   ├─ browser.mjs                 # 零依赖 Chromium CDP 驱动（AI/脚本用）
   ├─ scripts/smoke.mjs           # 零依赖全链路自检脚本
   └─ skills/codebuddy-workbench/
      ├─ SKILL.md                   # Codex 技能说明
      ├─ server/server.js           # 零依赖本地服务（HTTP + WS + PTY + codex exec 桥）
      ├─ server/node-pty/           # vendor 的 node-pty（含 win32-x64 预编译）
      └─ web/                       # 前端（index.html / app.js / vendor 中的 xterm/marked/dompurify）
```
