---
name: "codebuddy-workbench"
description: "把当前项目打开成 CodeBuddy 风格的工作台布局：左侧文件树（带 git 状态徽标）、中间上方文件预览（代码/Markdown/图片/PDF）、中间下方可隐藏的网页终端（真实 PTY + shell 选择）、右侧接 codex exec 的聊天栏。当用户说“打开工作台布局”“用 CodeBuddy 布局打开项目”“buddy layout”“打开文件树+终端+预览”时使用。"
---

# CodeBuddy Workbench — CodeBuddy 风格工作台

一个本地网页工作台，复刻腾讯 CodeBuddy IDE 的四区布局，运行在用户默认浏览器中（独立窗口，布局完全自主，不受 Codex 分栏限制）：

- **左** 文件树：懒加载展开、git 状态徽标（M/A/U/D/R）、底部 git 栏（分支、↑ahead ↓behind、更改数）
- **中上** 预览：多标签页；代码（行号）、Markdown（渲染 + 相对链接跳转）、图片、PDF
- **中下** 终端：真 PTY（node-pty + ConPTY），xterm.js 前端，可选 PowerShell 7 / Windows PowerShell / cmd / bash，可整栏隐藏
- **右** 聊天：把消息桥接给 `codex exec --json`（含 resume 续聊、工具/思考/命令折叠卡片、沙箱档位切换），每轮结束自动刷新 git 状态
- 三栏可拖拽调宽、可隐藏，状态存 localStorage

## 何时使用

用户说：打开工作台布局 / CodeBuddy 布局 / buddy layout / 打开文件树和终端 / 启动工作台 / 关闭工作台（→ stop）。

## 操作步骤

技能目录 = 本 SKILL.md 所在目录（下文记为 `$SKILL`）。所有命令用系统 Node（≥18）直接运行，脚本零第三方依赖（node-pty 原生模块已随插件 vendor）。

### 打开工作台

1. 确定项目根目录：用户在哪个项目里说这句话，就用那个目录（当前工作目录）。用户指定了路径就用用户的。
2. 后台启动服务（daemon 化，命令本身立即返回）：

```bash
node "$SKILL/server/server.js" --daemon --root "<项目根目录>"
```

输出 `READY http://127.0.0.1:<port>/ token=<t>` → 服务已在后台运行，且**已自动在用户默认浏览器打开整页工作台**（Windows 上用 `rundll32` 打开，不产生命令行黑框）。把 URL 也告诉用户，方便他们在别的浏览器/分屏里打开。

3. 若输出 `ALREADY_RUNNING <url>`：服务已在跑。如果用户想换项目目录，先执行 stop 再重新 open。

### 关闭工作台

```bash
node "$SKILL/server/server.js" --stop
```

### 状态排查

- 端口被占会自动 +1 递增（默认从 5399 起）。
- 服务日志：`~/.codex/codebuddy-workbench/server.log`；状态文件：`~/.codex/codebuddy-workbench/state.json`。
- 终端栏显示 "node-pty 不可用"：说明 Node 架构与 vendor 的 win32-x64 原生模块不匹配（如 arm64/32 位 Node）。其余功能不受影响；可让用户在终端里改用 Codex 自己的 shell 面板，或重装对应架构插件。
- 聊天栏报"未找到 codex 可执行文件"：把 `codex` 加入 PATH，或用 `BUDDY_CODEX_BIN` 指向 `codex.exe` / `codex.js`。服务会把 npm 的 `.cmd` 垫片解析成 JS 入口，用 `node` 直接启动，不走 cmd.exe。聊天桥接命令是 `codex exec --json -C <root> --skip-git-repo-check -s <sandbox> <prompt>`，续聊用 `codex exec resume <thread_id> <prompt>`。
- Windows 下服务全程不弹命令行窗口：控制台类子进程统一隐藏窗口，打开浏览器走 `rundll32`，关闭 PTY 终端不再 fork 子进程。若仍看到黑框，先确认 Codex 插件缓存里跑的是新版源码。
- 全链路自检：`node "$SKILL/../../scripts/smoke.mjs"`（在隔离临时目录里起停服务，不触碰用户数据；全部通过时退出码为 0）。

## 浏览器自动化（browser.mjs）

若需要让 Codex 亲自"看"或"操作"网页（如验证工作台 UI、截图、点按钮、跑 JS），可用插件根目录附带的零依赖 Chromium 驱动。它直连 Chrome DevTools Protocol，无需 `playwright` npm 包或浏览器 MCP。Chromium 自动从 `~/.../ms-playwright/chromium-*` 探测，也可用 `BROWSER_MJS_CHROME` 环境变量覆盖。

```bash
node "$SKILL/../../browser.mjs" start                # 拉起无头 Chromium（守护）
node "$SKILL/../../browser.mjs" open "<url>"         # 打开页面（file:// 或 localhost）
node "$SKILL/../../browser.mjs" eval "<js>"          # 执行 JS
node "$SKILL/../../browser.mjs" click "<选择器>"      # 点元素（取中心）
node "$SKILL/../../browser.mjs" screenshot [out.png] # 截图（默认写当前目录）
node "$SKILL/../../browser.mjs" html [out.html]      # 取页面 HTML
node "$SKILL/../../browser.mjs" stop                  # 关闭
```

`$SKILL` 为 SKILL.md 所在目录（`skills/codebuddy-workbench/`），`browser.mjs` 在其上一级插件根目录。截图 / HTML 默认写到当前工作目录，可直接交给用户查看。

## 安全边界

- 服务只监听 `127.0.0.1`，所有 HTTP/WS 请求必须带启动时随机生成的 token；文件 API 被限制在项目根目录内（路径穿越会拒绝）。
- 聊天栏的沙箱档位直接透传给 `codex exec -s`，默认 `workspace-write`（与你当前 Codex 会话一致），`full-access` 需用户自己在界面上点选。
- 技能本身不会改动 `~/.codex/config.toml`，也不注册 MCP server；工作台里的「Codex 设置」面板只在**用户主动修改并保存**时写入该文件（写入前会备份 `.bak`）。

## 局限（如实告知用户）

- 这是独立浏览器窗口的工作台，**不是替换 Codex 应用本身的窗口**；Codex 官方应用没有提供改自身布局的扩展点。想要"整窗都是 CodeBuddy 布局"，本工作台就是最接近的形态：聊天栏接的就是真 Codex。
- 聊天桥接走 `codex exec`，每轮是一个完整回合（无逐 token 流式）；审批类交互不支持——需要审批的操作请留在 read-only / workspace-write 档位。
