# CodeBuddy Workbench（Codex 插件）

把当前项目在浏览器里打开成 **CodeBuddy IDE 风格的四区工作台**：左侧文件树（git 状态徽标）、中上文件预览（代码 / Markdown / 图片 / PDF）、中下真实 PTY 终端、右侧接 `codex exec` 的聊天栏。聊天栏调用的是你本机真正的 Codex，不是模拟。

> Codex 官方应用不提供改写自身窗口布局的扩展点，因此本插件用「自研前端 + 本地服务」在独立浏览器窗口里实现完整布局。

## 布局

```
┌──────────┬─────────────────────────────┬──────────┐
│  文件树   │  预览（代码/MD/图片/PDF 多标签）│  Codex   │
│  +git徽标 │ ─────────────────────────── │  对话     │
│           │  终端（真实 PTY，可隐藏）    │ （接exec）│
└──────────┴─────────────────────────────┴──────────┘
```

## 安装

```bash
# 1. 把本仓库作为本地 marketplace 加入 Codex（路径 = 仓库根目录）
codex plugin marketplace add "C:/路径/到/codex-codebuddy-workbench"

# 2. 安装插件
codex plugin add codex-codebuddy-workbench@codex-codebuddy-workbench
```

在 Codex 里说「**用 CodeBuddy 布局打开当前项目**」即自动起服务并打开工作台；说「**关闭工作台**」停服务。也可手动：

```bash
node plugins/codex-codebuddy-workbench/skills/codebuddy-workbench/server/server.js --daemon --root "<项目目录>"
node plugins/codex-codebuddy-workbench/skills/codebuddy-workbench/server/server.js --stop
```

服务只监听 `127.0.0.1`，所有请求需带启动时生成的随机 token；文件访问被限制在项目根目录内。

## 为什么是两层目录

仓库根是 **Codex marketplace**：`.agents/plugins/marketplace.json` 的 `source.path` 指向 `./plugins/codex-codebuddy-workbench`，这是 Codex 读取插件的固定位置，不能把插件直接摊到根目录。因此插件本体（manifest、技能、服务、前端）都在 `plugins/codex-codebuddy-workbench/` 里，本文件则是仓库首页说明，详细技术文档见插件目录内的 `README.md`。

## 目录结构

```
codex-codebuddy-workbench/
├─ README.md                         # 本文件：仓库首页说明
├─ LICENSE
├─ .agents/plugins/marketplace.json  # marketplace 清单（指向下面的插件目录）
└─ plugins/codex-codebuddy-workbench/
   ├─ README.md                     # 插件技术文档（布局 / 安装 / 技术说明）
   ├─ 使用说明.md                    # 面向非技术用户的中文操作手册
   ├─ .codex-plugin/plugin.json     # 插件 manifest
   ├─ browser.mjs                   # 零依赖 Chromium CDP 驱动（AI / 脚本用）
   ├─ scripts/smoke.mjs             # 零依赖全链路自检脚本
   ├─ assets/                       # 图标
   └─ skills/codebuddy-workbench/
      ├─ SKILL.md                   # Codex 技能说明（触发词与操作步骤）
      ├─ server/                    # 本地服务（HTTP + WS + 真 PTY + codex 桥）
      └─ web/                       # 前端（index.html / app.js / vendor）
```

## Windows 上不再弹命令行黑框

工作台会频繁拉起子进程（git 刷新、定时任务、终端、codex 会话），旧实现有几处会闪出控制台窗口，已全部收敛：

- 所有控制台类子进程统一隐藏窗口；GUI 程序（浏览器、资源管理器）不加隐藏标志，避免正常窗口被一起隐藏。
- 打开浏览器改用 `rundll32`（失败回退 `explorer`），不再用 `cmd /c start` + `shell:true` 连开两层 cmd.exe。
- 关闭 PTY 终端不再 fork 一个 node.exe；ConPTY 的 `ClosePseudoConsole` 已能结束附加进程。
- `codex` 统一解析成原生 exe 或 `node + codex.js` 直接启动，完全不经过 `.cmd` 垫片；shell 探测改为同步扫描 PATH；git 自动刷新降频且后台标签页跳过。

## 自检

```bash
node plugins/codex-codebuddy-workbench/scripts/smoke.mjs
```

零第三方依赖，在临时目录创建隔离的 git 仓库与假 codex，起停独立服务，逐项检查 HTTP / WebSocket、git 操作、定时任务、PTY 终端、聊天桥接与弹窗隐患，**44 项全部通过时退出码为 0**，不改动你的项目和 Codex 配置。Node ≥ 22 才会跑 WebSocket 用例。

## 文档

- [插件技术文档](plugins/codex-codebuddy-workbench/README.md)
- [中文使用说明](plugins/codex-codebuddy-workbench/使用说明.md)
- [Codex 技能说明](plugins/codex-codebuddy-workbench/skills/codebuddy-workbench/SKILL.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
