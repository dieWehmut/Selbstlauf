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
