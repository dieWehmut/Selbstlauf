<h1 align="center">Selbstlauf</h1>

<p align="center">
  <img src="https://count.getloli.com/get/@Selbstlauf?theme=rule34" alt="Visitors">
</p>

<div align="center">

[![Windows](https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square&logo=windows)](https://www.microsoft.com/windows)
[![PowerShell](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?style=flat-square&logo=powershell)](https://learn.microsoft.com/powershell/)
[![Tools](https://img.shields.io/badge/AI_CLI-3-2E8B57?style=flat-square)](#支持的工具)
[![License](https://img.shields.io/badge/License-MIT-333333?style=flat-square)](LICENSE)

</div>

<div align="center">

简体中文 | [繁體中文](docs/README.zh-TW.md) | [English](docs/README.en.md)

</div>

---

## 概览

`Selbstlauf`（原 `ai-cli-bypass`）为 Claude Code、Codex CLI 和 OpenCode 提供 Windows 一键安装/卸载脚本，并保留现有 Linux root/sudo 环境脚本。Windows 版本安装官方 npm 包，在用户目录创建独立 wrapper，自动注入跳过审批参数，不覆盖 npm 自带的 `.cmd` shim。

> [!WARNING]
> 这些脚本会关闭或绕过工具的正常权限审批、沙箱或确认保护。恶意提示、依赖或命令可能直接读写文件并执行系统操作。仅在你完全信任的隔离环境、容器或已加固沙箱中使用；不要在包含重要数据或凭据的日常主机上运行。

## 支持的工具

| 工具 | 官方 npm 包 | Windows 安装 / 卸载 | Linux 安装 / 重置 | 自动注入参数 |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | `install-claude-windows.ps1` / `uninstall-claude-windows.ps1` | `install-claude-root.sh` / `reset-claude.sh` | `--dangerously-skip-permissions` |
| Codex CLI | `@openai/codex` | `install-codex-windows.ps1` / `uninstall-codex-windows.ps1` | `install-codex-root.sh` / `reset-codex.sh` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode-ai` | `install-opencode-windows.ps1` / `uninstall-opencode-windows.ps1` | `install-opencode-root.sh` / `reset-opencode.sh` | `--auto` |

## 环境要求

### Windows

- Windows 10 或更高版本
- Windows PowerShell 5.1 或更高版本
- Node.js 和 npm，且 `npm.cmd` 已加入 PATH
- Claude Code 原生 Windows 使用还需要 [Git for Windows](https://git-scm.com/download/win)；按上游要求配置 Git Bash

脚本只修改当前用户环境，不需要管理员权限。安装完成后若当前终端仍找不到命令，请重新打开 PowerShell。

### Linux

- Debian、Ubuntu、Fedora、RHEL 或 Alpine Linux
- Node.js / npm
- Claude Code root 绕过需要 `gcc`；安装脚本会在缺失时尝试安装

## Windows 一键安装

在 PowerShell 中运行对应命令：

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-opencode-windows.ps1 | iex
```

随后直接运行 `claude`、`codex` 或 `opencode`。重复执行安装脚本是幂等的，不会递归包装现有 wrapper。

## Windows 一键卸载

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1 | iex
```

卸载会删除本项目的 wrapper 和状态。只有当 npm 包最初由本项目安装时，才会同时卸载该包；预先存在的包会保留。认证、会话、provider 和 CLI 配置不会被删除。

保留 npm CLI 包、只移除绕过 wrapper：

```powershell
# 将 URL 换成对应工具的 uninstall-*-windows.ps1
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1'))) -KeepCli
```

## Linux 安装与重置

下载后执行，便于先检查脚本内容：

```bash
# Claude Code
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-claude-root.sh -o install-claude-root.sh
chmod +x install-claude-root.sh && ./install-claude-root.sh

# Codex CLI
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-root.sh -o install-codex-root.sh
chmod +x install-codex-root.sh && ./install-codex-root.sh

# OpenCode
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-opencode-root.sh -o install-opencode-root.sh
chmod +x install-opencode-root.sh && ./install-opencode-root.sh
```

恢复各工具的普通启动方式：

```bash
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-claude.sh -o reset-claude.sh
chmod +x reset-claude.sh && ./reset-claude.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-codex.sh -o reset-codex.sh
chmod +x reset-codex.sh && ./reset-codex.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-opencode.sh -o reset-opencode.sh
chmod +x reset-opencode.sh && ./reset-opencode.sh
```

## 工作原理

Windows 入口脚本加载 `scripts/windows/AiCliBypass.ps1`，完成以下操作：

1. 通过 npm 安装或更新对应的官方 CLI 包。
2. 定位 npm 生成的真实 `.cmd` shim，保持其原文件不变。
3. 在 `%LOCALAPPDATA%\ai-cli-bypass\bin` 写入独立 wrapper，并把危险参数放在用户参数之前。
4. 在 `%LOCALAPPDATA%\ai-cli-bypass\state` 记录包与 PATH 所有权，以便卸载时只撤销本项目创建的资源。
5. 对写入、重装和失败路径执行校验与回滚；wrapper 会保留上游退出码和用户参数。

Linux 脚本使用工具专用 wrapper；Claude Code 额外通过 `LD_PRELOAD` 处理 root UID 检查。

## 故障排查

- **提示找不到 `npm.cmd`**：安装 Node.js/npm，确认新 PowerShell 中 `Get-Command npm.cmd` 有结果。
- **安装成功但找不到命令**：重新打开 PowerShell，让用户 PATH 生效；也可重新执行对应安装脚本。
- **Claude Code 在 Windows 启动失败**：安装 Git for Windows，并按 Claude Code 官方说明设置 Git Bash 路径。
- **卸载 npm 包失败**：修复 npm 网络或权限问题后重试卸载；状态会保留以便再次执行。
- **只想恢复审批模式**：执行对应 `uninstall-*-windows.ps1`；需要保留 CLI 时使用 `-KeepCli`。

## 项目结构

```text
.
|-- install-*-windows.ps1       # 兼容入口
|-- uninstall-*-windows.ps1     # 兼容入口
|-- install-*-root.sh           # 兼容入口
|-- reset-*.sh                  # 兼容入口
|-- scripts/install/windows/*   # Windows 安装脚本
|-- scripts/install/linux/*     # Linux 安装脚本
|-- scripts/uninstall/windows/* # Windows 卸载脚本
|-- scripts/uninstall/linux/*   # Linux 重置脚本
|-- scripts/windows/AiCliBypass.ps1
|-- scripts/continuation/*      # watchdog 生命周期
|-- scripts/desktop/*           # 安装程序验收与图标生成
|-- assets/*                    # 图标源图
|-- apps/cli/src/process/*      # 进程发现与 PowerShell provider
|-- apps/cli/src/association/*  # Claude / DeepSeek Harness 会话关联
|-- tests/Test-WindowsScripts.ps1
|-- tests/Test-Documentation.ps1
|-- docs/README.zh-TW.md
|-- docs/README.en.md
`-- LICENSE
```

## Codex Full Access on Windows

The Codex installer persistently writes the official Full Access settings to
the active `CODEX_HOME/config.toml`:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

This makes ordinary `codex` launches use Full Access even when an existing
PowerShell session resolves npm before the wrapper. Re-running the installer
detects the existing Codex command, skips npm and core downloads, and repairs
only the bypass-owned files. Uninstall restores the previous Codex settings
unless you changed them after installation.

> [!WARNING]
> Full Access disables normal approval and sandbox protections. Use it only in
> an environment you fully trust.

## Continuation Watchdog

The local watchdog monitors each same-user Claude/Codex process independently.
It waits for the configured quiet period, records every decision, and uses
`继续` for ordinary sessions or `/goal resume` only for a resumable Codex goal.
Set `dryRun` in the WebUI before enabling writes.

```powershell
npm install
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\start-watchdog.ps1 -DryRun
Start-Process http://127.0.0.1:48920/
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\stop-watchdog.ps1
```

安装为当前用户可重复执行；需要登录后自动启动时加上 `-Startup`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\install-watchdog.ps1 -DryRun -Startup
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\uninstall-watchdog.ps1
```

安装器只拥有 `%LOCALAPPDATA%\ai-cli-bypass\continuation`，并在其中写入
`install-manifest.json`。卸载器会验证 manifest、PID 和仓库路径，只删除该目录
及 manifest 声明的登录任务；不会删除 npm 包、CLI wrapper、认证、会话或其他
`ai-cli-bypass` 状态。WebUI 对应的本机路由是 `/api/watchdog/start`、
`/api/watchdog/stop`、`/api/install`、`/api/startup`、
`/api/startup/install`、`/api/startup/uninstall` 和 `/api/uninstall`。

### 本机工具发现与 DeepSeek Harness

每个轮询周期只读地枚举当前用户的进程，并把同一工具进程树的根与子进程合并成一个逻辑会话：

| 工具 | 进程签名 | 会话关联 | 写入通道 |
|---|---|---|---|
| Claude Code | `claude.ps1`、`claude-code` | `~/.claude/projects` 的 JSONL | Console / PTY / Stop Hook |
| Codex CLI | `codex.exe`、`@openai/codex`、`codex.js` | `~/.codex` 的线程与 goal 状态库 | Codex App Server |
| DeepSeek Harness | `dsh.exe` / `dsh.cmd`、`@deepseek-ai/dsh`、`deepseek-harness` 下的 `apps/cli/lib/bin.js` 与 `subprocess-local/runner.js` | `$DSH_HOME/sessions` 的会话目录与 `storages/session_projcache` 投影 | Harness 本机会话接口 |

DeepSeek Harness 的 `web` 宿主机是一个进程服务多个工作区，所以宿主机本身不是一个 agent：
watchdog 会把每个仍然活跃的 harness 会话展开成独立的一行，会话 ID 取自 harness 自己的
`session-…` 标识，工作区取自会话投影里的 `cwd`，静默时间取自会话日志与投影的最新写入时间。
投影中的 `turnBoundary.lastStepBoundary.kind` 直接说明该会话是否还有未结束的步骤，界面因此能
区分“步骤执行中”和“等待输入”。从未收到过提示的空会话、以及在活动窗口之外的历史会话不会
出现在列表里。

harness 的会话日志是 zstd 压缩的追加日志，watchdog 只读取第一行会话头用于补齐 `cwd`，绝不写入。

### 续写 DeepSeek Harness

harness 没有控制台，也没有以 PID 为作用域的写入通道：会话由自己的身份寻址，宿主是一个长驻的
`web` 进程。watchdog 因此走 harness 自己的本机接口：它枚举宿主机监听的 loopback 端口，用
`GET /` 的 401 指纹确认那就是 harness，然后读取 harness 自己存在
`$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 密钥，签出与浏览器相同的
会话 cookie，并调用 UI 自己使用的 `session/prompt`（`mode: queue`）。

安全边界是刻意收窄的：

- 只对 `127.0.0.1` 的 http 源生效；证书只读、只用于本次请求，绝不写日志、绝不落盘。
- 只有会话当前**没有未结束的步骤**（`turnOpen === false`）时才写入；正在执行的 agent 不会被
  打断。这是独立于静默阈值的第二道闸门。
- `dry run` 期间只探测 harness 位置、不读取密钥，也不写入；`tools.dsh` 关闭时同样不写入。
- 任何一步失败（读不到密钥、指纹不符、cookie 被拒、会话消失）都退回 `monitor-only`，
  并在界面上给出原因，而不是猜测。
- 写入只通过 harness 自己的会话控制器完成，不使用全局键盘或鼠标 API。

`tools.dsh.allowApiInput`（默认开启）控制这条通道；`tools.dsh.sessionWindowMs`（默认 1 小时）
决定多久没有活动的会话会被当作历史。

### 会话运行位置与一键打开

每一行都会给出该 agent 实际所在的宿主，而不只是 PID：进程发现会沿父链回溯，并用一次
`EnumWindows` 拿到这些祖先拥有的一级窗口，据此识别 **Tabby / Windows Terminal / VS Code /
Cursor / Codex 应用（ChatGPT.exe）/ Edge / Chrome / Firefox** 等宿主，并记录可置前的窗口句柄。
界面里的「运行位置」列显示宿主名称与窗口标题，旁边的按钮会调用
`POST /api/sessions/<id>/focus` 把那个窗口恢复并置前。

harness 行是例外：它的界面由浏览器提供，浏览器不在会话的进程树里。因此 harness 行按窗口标题中
的 `DSH` 标记找到正在显示 WebUI 的浏览器窗口（优先浏览器，其次任何匹配窗口）；若找不到窗口，
则显示「DeepSeek Harness 网页界面」并改为打开该 loopback 地址。置前只使用窗口管理 API
（`SetForegroundWindow`、`AttachThreadInput`、`SwitchToThisWindow`、`SetWindowPos`），从不合成
键盘或鼠标输入；Windows 若因前台锁拒绝授予焦点，窗口仍会被置顶显示，界面会说明这一点。

进程发现需要 `powershell.exe`（Windows PowerShell 5.1 或更高版本）。拥有者 SID 通过进程令牌
读取，而不是逐进程调用 WMI 的 `GetOwnerSid()`，因为后者在进程较多的桌面上每次轮询要花掉近
一分钟；这也让“发现 → 关联 → 决策”的完整链路能在默认 2 秒轮询间隔下真正跑完。

要在这台机器上验证监控与续写确实生效，而不是只看健康检查：

```powershell
npm run build
node .\scripts\verify\live-monitoring.mjs      # 每个本机 agent 都被发现，并给出运行位置
node .\scripts\verify\dsh-continuation.mjs     # harness 真的接受了一次「继续」
```

`live-monitoring.mjs` 会独立枚举本机进程与 harness 会话，再要求正在运行的服务为每一个都给出
对应的一行、正确的工具、工作区、运行位置与传输，并确认已经写入活动/决策事件且没有任何注入。
`dsh-continuation.mjs` 会自己创建一个一次性 harness 会话，用 watchdog 的同一个传输写入「继续」，
验证 harness 接受并落盘，然后取消它启动的那一轮。真机运行记录见
[docs/verification/2026-09-17-live-monitoring.md](docs/verification/2026-09-17-live-monitoring.md)
与 [docs/verification/2026-09-18-harness-continuation.md](docs/verification/2026-09-18-harness-continuation.md)。

## 桌面应用与安装程序

Electron 桌面版把 watchdog 服务与 WebUI 放进同一个窗口，无需再单独运行
`start-watchdog.ps1`。在 [GitHub Releases](https://github.com/dieWehmut/Selbstlauf/releases)
下载 `Selbstlauf-Setup-<version>-<arch>.exe` 后直接运行：安装程序写入
`%LOCALAPPDATA%\Programs\Selbstlauf`，创建桌面和开始菜单快捷方式，并注册卸载器；
它只作用于当前用户，不需要管理员权限。

发布流程由 `.github/workflows/release-desktop.yml` 负责，可用 `v*` tag 触发或手动运行：
它会构建并测试所有 workspace、对桌面 shell 做 smoke 测试、打包 x64 与 arm64 安装程序，
并用 `scripts/desktop/verify-installer.ps1` 验收 x64 安装程序（安装完整性、快捷方式、
卸载注册表项、内置服务健康检查、WebUI 可访问、卸载干净）；tag 触发时把安装程序发布到
GitHub Release，否则保留为 workflow artifact。

该验收脚本还会启动一个带有受支持签名的探针进程，并要求**已安装**的应用把它发现出来、
标记为存活、并写入 per-session 决策，然后才删除探针。只检查健康检查和 WebUI 是不够的：
`tsc` 不会产出 PowerShell 资源，服务又把它当作自己的同级文件解析，如果安装程序漏带该资源，
应用会正常启动、正常提供 WebUI，却一个进程都发现不了。`resources/service-dist/src/process/windows-processes.ps1`
因此同时是打包清单和验收清单的一部分。

```powershell
npm install
npm run build
npm --workspace apps/desktop run package:win   # 输出到 tmp\desktop-dist
npm --workspace apps/desktop run smoke         # 无界面校验内置服务
```

安装完成后，WebUI 设置页的“安装启动项”会从安装目录注册当前用户的登录任务，
“移除启动项”会删除该任务。该任务运行安装目录内的
`resources\scripts\continuation\start-watchdog.ps1`，并回退到随包提供的
`service-dist` 入口，因此不依赖仓库源码。

### Claude Stop Hook

Claude 的 Stop Hook 默认关闭。打开本机 WebUI 的“设置”页，确认 `dryRun` 状态，
在 Claude Stop Hook 区块调整 Lease 有效期、命令超时和自定义普通提示，然后按
“安装 Stop Hook”并保存配置。安装只会修改当前用户的
`%USERPROFILE%\.claude\settings.json`，并在 watchdog 自有状态目录保存校验清单；
已经打开的 Claude 窗口必须完全退出并重新启动，才会加载新的 Hook。

Hook 只会消费与进程、工作目录、会话和 transcript 活动指纹完全匹配的一次性
Lease。Claude 有新输出、会话不唯一、Hook 被递归调用或 Lease 过期时会返回空决策，
不会输入内容。页面上的“停用 Stop Hook”会清理待处理 Lease；“卸载 Stop Hook”会
按校验清单恢复原始 settings 字节。若文件在安装后被用户修改，页面会标记“需人工检查”
并拒绝覆盖，先保留文件和备份，再由用户审阅后处理。

Stop Hook 命令通过受限的本地 CLI 运行，不读取 transcript 内容，也不使用全局键盘
API。Codex 仍由 App Server 或经 PID 验证的终端传输负责；不支持安全写入的会话保持
`monitor-only`。要恢复普通 watchdog 状态，可停用 Hook 后再卸载，或运行上面的
`uninstall-watchdog.ps1`；这些操作不会删除 CLI、认证或会话。

Input is accepted only through a PID-validated classic Console bridge or a
service-owned PTY. Codex sessions use the local App Server when the thread can
be associated safely; unsupported ConPTY sessions stay `monitor-only`. No
global keyboard API is used. The WebUI can pause a process, change prompts,
inspect the redacted audit timeline, or uninstall only watchdog-owned state.

### Codex 端点切换

本机 WebUI 的设置页提供“端点配置”面板，用来在 `CODEX_HOME/config.toml` 中切换
Codex 的接入端点。面板会列出当前生效的 `model`、`review_model`、
`model_reasoning_effort`、`base_url` 和 `experimental_bearer_token`，并把
`config.toml` 里以注释形式闲置的旧端点显示为可点击的备选胶囊；点击胶囊即可
切回对应端点，也可以在输入框里手写新值后按“应用端点配置”。

切换完全按照手工维护该文件的方式改写：命中的注释行会被激活，原先生效的赋值会
被改写为注释保留下来，未知取值会替换当前行，缺失的键会追加到最后一个顶层赋值
之后；`[section]` 之外的无关内容与项目段落按字节原样保留。每次写入前都会先写入
一份 `.bak` 备份和 `sha256` 校验边车文件，写入本身通过临时文件原子替换完成，
因此中断的切换可以人工恢复。写入会串行化，避免并发切换互相覆盖。

本机路由为 `GET /api/codex/profiles` 和 `PUT /api/codex/profiles`（请求体
`{ "fields": [{ "key": "base_url", "value": "..." }] }`）；变更会记入审计日志
的 `user-override` 事件。该面板只在本机 watchdog 界面可用，Pages 演示站使用
内存样例数据，不会修改任何本地文件。
### 本地工具升级

设置页的“关于”分区会列出目录里每个 agent CLI 的当前版本与 npm 上的最新版本，
并对落后的工具显示“可升级”标记。每张卡片上的“升级”按钮会调用本机
`POST /api/environment/upgrade`（请求体 `{ "id": "claude" }`），
头部“全部升级”调用 `POST /api/environment/upgrade-all`，只升级报告里标记为
落后且已安装的工具，不会顺手装上一台机器上原本没有的软件。

服务端只接受目录里的工具 id，命令由目录条目拼装，调用方无法把任意包名或多余
npm 参数塞进安装命令；全局安装一次只跑一个，避免并发写坏同一个 prefix；安装
完成后会重新扫描环境，让面板显示真正装上版本。安装结果会写入审计日志，但不记录
token 或路径。Pages 演示站用内存样例模拟同样的按钮，不会安装任何东西。

### 外观设置

设置页侧栏的“外观”分区提供外观选择：三张主题预览卡分别对应系统、浅色和深色，
下方的代码对比条展示当前主题与修改后的 surface、accent 和 contrast 取值。
卡片下面是逐行的设置列表：强调色下拉框、背景与前景取色器、UI 字体与字重、
内容字体（可选“与界面字体相同”）、半透明侧边栏开关，以及对比度滑杆。

对比度决定面板、边框与页面背景的距离：数值越高，表面越清楚地从背景上浮起；
半透明侧边栏让侧栏透出页面背景，整体读作一个表面而不是两块拼板。自定义以
配色方案为单位保存在浏览器里，因此自定义过的深色配色不会在切到浅色再切回来时
丢失；“恢复默认”把当前方案还原成内置配色。所有改动都是纯前端行为，不会写入
服务端状态。

### 设置分区

设置页用**左侧分类导航**取代了原先的分区标签栏：顶部是“返回应用”和“搜索设置”
（按名称实时过滤分区），下面按“个人”和“集成”两组列出全部分区。

**在设置页里，左侧这一栏就是应用侧栏的位置**：应用自己的侧栏（品牌、主导航、进程
列表、底部条）不会显示，避免出现两条并排的左栏。返回其它页面用“返回应用”，或用
标题栏的后退/前进。窄窗口（≤960px）下这一栏和侧栏一样是抽屉，由顶栏的菜单按钮打开，
选中分区后自动收起。

- **个人**：常规、外观、通知、键盘快捷键、个人资料、宠物。
- **集成**：启动与托盘、续写与进程、导入历史、电脑操控、插件、浏览器、关于。

**每个分区都改变应用真实会做的事**。此前这里有四个分区什么都改变不了，已经删除：

| 删除的分区 | 为什么删 |
| --- | --- |
| 家长控制 | 只用一个本机混淆的 PIN 挡住一个开关，**它从来不是安全边界**（4-8 位数字可暴力破解，且任何人改 `localStorage` 即可绕过）。同时它会给保存配置加一道 PIN 提示，分区删掉后提示也一并删除——否则存过该偏好的用户会被要求输入一个**已经没有地方可以修改或清除**的 PIN。 |
| 信任联系人 | 存一个姓名和邮箱，**从来没有发送到任何地方**。 |
| 语音 | 一个开关，背后**没有任何实现**。 |
| 使用统计 | 数的是屏幕上已经显示的东西。 |

“个性化”并入 **外观**（那里的调色板本来就含强调色），“应用快照”删除，“配置”改名为
**续写与进程**，“账户”改名为 **关于**。新的 **启动与托盘** 把原先塞在“电脑操控”里的
开机自启、关闭行为、首选终端移了出来——那些是窗口自己的行为，放在“电脑操控”（讲的是应用
能对这台机器做什么）下面，想找“关窗口会怎样”的人不会想到去点它。

“关于”的数值由当前会话与环境报告实时算出，不显示占位数字；“电脑操控”的“允许打开运行
位置”会真正禁用进程表里的对应按钮；“个人资料”的显示名称会显示在底部条的面板里；“通知”里的
“保留最近事件条数”会真正限制事件时间线保留的条数。

### 侧栏进程列表

侧栏顶部直接是“进程 / 事件”两个主导航（**顶部不再列“设置”**——设置页的左侧栏本身就是设置
导航，入口放在底部条面板里和 `Ctrl+,`），**下面是发现到的进程列表**：按**运行位置分组**
（Tabby、Visual Studio Code、dsh-shortcut 等，即主表格“运行位置”一列显示的宿主），每组一个
小标题；**点选某一行会在主区域打开该进程的详情页**，侧栏对应行整行高亮。列表有独立的搜索框
与独立滚动区，进程再多也不会把主导航和底部条挤出视野，也不会撑宽侧栏。

侧栏顶部**不再有品牌区**（那是每个页面都重复一次应用名、却点不动的东西）；图标与显示
名称移到底部条弹出的面板里，和服务状态放在一起。

**每一行都显示该进程所在的对话**，不只有选中行才显示——“这个进程在哪个对话里”正是决定
能不能续写它的依据，所以放在行上而不是藏在一次点击之后。行是**紧凑的两行**（宿主不再重复，
它就是上方的小标题）：

```
● Codex                                    34m 10s
  Goal · complete · 01a0bd1e
```

**置顶**：鼠标移到某一行（或键盘聚焦）时行尾出现图钉，点一下把该进程提到最上面的**“置顶”
分组**里。置顶是**移动而不是复制**，所以一个进程不会出现两次；置顶顺序按最近置顶排前，并且
作为偏好保存，重开应用仍在。没有置顶任何进程时，“置顶”分组不出现。

对话文案由侧栏与主表格**共用同一个函数**，因此同一会话在两处不会出现不同说法；没有关联
对话的进程只显示“普通对话”。id 会缩短显示，但**不会缩成所有会话共有的前缀**——
`session-b9dbc639-…` 显示为 `b9dbc639` 而不是 `session-`。

分组顺序按宿主类别固定，组内按静默时间从长到短排列——顺序稳定才点得准，而静默
最久的最需要处理。没有识别出宿主的进程归入“未识别宿主”，不会被丢掉。收起侧栏会
把整条侧栏隐藏（不留图标窄栏），标题栏上的开关随时可以展开。

### 动效

界面里的动效都是**短而小**的：行在列表重建时轻微上浮淡入，导航图标在悬停时轻微位移，
切换设置分区时面板上浮淡入，行钉按钮淡入。侧栏是每次会话要用几十次的地方，**慢一点或大一点
的动画会变成干扰而不是质感**，所以时长都在 .18–.22s。

这些都遵守系统的**“减少动态效果”**设置：开启后所有动画与过渡都归零，而不是缩短——
动效的作用是让变化被注意到，缩短版仍然在动。这一点有浏览器测试覆盖，并且验证过
**把该规则去掉后测试会失败**。

### 写入会话

进程详情页有**输入框**，可以把一行文字写入该会话，与「立即续写」走**同一条受校验通道**。

这**不是新能力**——应用本来就会往会话里写文字（「立即续写」发送配置好的续写提示词）；这里只是
让**你自己决定写什么**。之所以不用模拟按键：实测 `WM_CHAR` 只对**前台**窗口有效，而续写必须在
**你不看那个窗口**时送达才有意义。

规则与服务端一致，所以拒绝会在界面上说清楚，而不是变成一个看不懂的 HTTP 400：

| 情况 | 行为 |
| --- | --- |
| 空 / 纯空格 | 按钮禁用，并提示「请输入要发送的内容」 |
| 超过 4096 字符 | 输入框本身就限制到上限，与服务端一致 |
| **粘贴多行** | **换行被转成空格**（见下） |
| 会话不可写入 | 输入框禁用，并说明「该会话不可写入」 |
| 发送失败 | **保留已输入内容**并显示原因，不静默丢失 |

**为什么单独处理粘贴**：实测 `<input type="text">` 会执行 HTML 的取值净化算法，**把换行直接删掉**——
粘贴 `line one\nline two` 会变成 `line oneline two`，**在任何校验能看到之前就已经损坏了**。所以
靠"拒绝换行"的规则**永远不会触发**；必须用 `onPaste` 在净化**之前**接住并转成空格。

输入框是**单行**的，并且明确写出**将写入哪个 PID**，因为这个操作会落到**正在运行的会话**里。切换
到另一个进程时草稿会清空——为某个进程写的话不该离「发送到另一个进程」只有一次点击。

### 进程窗口预览

进程详情页有**该进程所在窗口的画面**，以及一个**“切换到该窗口”**按钮。它解决的是
“那个我现在看不见的 Tabby 会话里到底在发生什么”——**已经摆在你眼前的窗口不需要预览**。

用途边界是实测定下来的，不是猜的：

| 窗口状态 | 能否预览 |
| --- | --- |
| **可见但被别的窗口挡住** | **能**，画面完整（实测被完全遮挡时仍抓到 162 种颜色，与未被遮挡时一致） |
| **最小化** | **不能**。它**根本不在系统提供的窗口列表里**（不是抓到空白），还原后才重新出现 |
| 进程没有自己的窗口 | 不适用：面板会**按该进程实际报告的内容**说明（Harness 的界面是浏览器网页；其他情况则指出已识别到的运行位置） |
| 多个进程共用一个窗口 | 画面是**整个窗口**，面板会写明“此窗口内有 N 个受监控进程” |

因此面板**如实说明当前是哪种情况**，而不是给一个空白框。两处措辞都是刻意不写死单一原因的：

- 抓不到时提示“无法抓取该窗口的画面。**通常是最小化了**，还原它后点刷新即可查看”。实测发现
  **最小化的窗口和刚刚关闭的窗口在捕获层看来完全一样**（都只是从窗口列表里消失，没有任何额外
  信号），所以写死“已最小化”会在窗口已经关闭时给出**做不到的建议**。
- “没有窗口”的原因**由会话自身的数据推导**，不是硬编码。“句柄为空”有好几种成因（Harness 的
  网页界面、裸控制台或 shell、或宿主窗口未能解析），早先的文案对**任何**无窗口进程都断言
  “DeepSeek Harness 是网页界面”——在这台机器上恰好都对，但**作为一般陈述是错的**：一个跑在
  裸控制台里的 Codex 会话会被告知它是 DeepSeek Harness。一次抓取会枚举并截取机器上
**所有**窗口、耗时约 300ms 且**不随窗口数量增长**，所以它**按需抓取**（切换进程时抓一次，
另有刷新按钮），不是定时轮询——这一点也实测过：打开详情页抓 1 次，之后 40 秒轮询期间
**0 次**，点刷新 +1，切换进程 +1。

**“切换到该窗口”走的是应用已有的 focus 接口**，把该窗口带到前台。预览是**只读**的：它只
读取窗口画面，不向任何窗口注入输入。

> **为什么不做“直接在预览里输入”**：实测 `PostMessage WM_CHAR` 在窗口**处于前台**时有效，
> 但**失焦后完全无效**（字段为空、零事件）。续写必须在你不看那个窗口时送达才有意义，所以
> 要让它工作只能抢前台焦点（会打断你正在做的事）。应用本来就有更可靠的写入通道
> （console bridge / Codex adapter / DSH web-host），正确做法是扩展它们，而不是模拟按键。

预览需要桌面版：网页版没有桥接，面板会直接说明“当前环境不支持窗口预览”，而不是显示空框。

### 窗口标题栏与托盘

桌面版使用自绘标题栏 + 原生窗口按钮：标题栏一行左侧是侧栏开关、后退、前进，
然后是“文件 / 编辑 / 视图 / 帮助”四个可展开的菜单，右侧保留系统的最小化、
最大化与关闭按钮。第二行仍是原来的页面标题与操作区。

**标题栏始终固定在窗口顶部**：外壳是视口高度的网格，只有中间内容列滚动，所以页面
内容再长，标题栏和它下面的页面标题行也不会被卷走。

侧栏**底部条点击后向上弹出面板**（应用图标与显示名称、服务状态，以及主题切换、设置、
收起侧栏）：向下弹会掉出窗口底部。Escape 与点击外部都能关闭，与标题栏下拉菜单行为
一致。

关闭窗口不会退出应用，也不会停止 watchdog 服务，而是隐藏到系统托盘。
**只有托盘菜单里的“退出”会真正退出**：

- 左键单击托盘图标：显示并聚焦主窗口（最小化时先还原）。
- 右键菜单：打开主界面、设置（直接进入设置页）、开机自启（复选框，状态取自
  服务端返回值）、关于 Selbstlauf（直接进入“账户”分区）、退出。

托盘不可用的机器上窗口会正常关闭，避免应用变成既无窗口又无托盘的隐藏进程。
启用“开机自启”会在安装目录注册当前用户的登录任务。

### 图标资源

所有图标（安装程序、桌面与开始菜单快捷方式、窗口与任务栏、WebUI favicon 与
侧栏品牌图标）都由同一张源图生成：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop\generate-icon-assets.ps1
```

脚本只使用内置 GDI+，从 `assets/selbstlauf-icon-source.png` 生成 7 帧 ICO
（16/24/32/48/64/128/256）和各个尺寸的 PNG，重复执行结果一致，可用 `-Source`
指定其他源图。

## WebUI demo site

The management UI lives in `apps/web`. Run it locally with:

```powershell
npm install
npm --workspace apps/web run dev
```

The repository includes `.github/workflows/deploy-pages.yml`. In repository
Settings > Pages > Build and deployment, set Source to **GitHub Actions** once.
Pushes to `main`, `feature/continuation-watchdog`, or
`feature/continuation-pages` then build and deploy the static demo. Demo mode
uses local sample data and never connects to or injects input into local CLI
processes.

The project-site URL is
`https://dieWehmut.github.io/Selbstlauf/`. The Pages demo uses in-memory sample
data and never touches local CLI processes; local installation and Hook actions
are available only from the watchdog served on `127.0.0.1`. Pushes to `main`
run `.github/workflows/deploy-pages.yml`, build the static demo, and publish it
through GitHub Actions.

## 上游文档

- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI 文档](https://developers.openai.com/codex/cli/)
- [OpenCode 文档](https://opencode.ai/docs/)

## 许可证

本项目采用 [MIT License](LICENSE)。
