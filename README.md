<h1 align="center">ai-cli-bypass</h1>

<p align="center">
  <img src="https://count.getloli.com/get/@ai-cli-bypass?theme=rule34" alt="Visitors">
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

`ai-cli-bypass` 为 Claude Code、Codex CLI 和 OpenCode 提供 Windows 一键安装/卸载脚本，并保留现有 Linux root/sudo 环境脚本。Windows 版本安装官方 npm 包，在用户目录创建独立 wrapper，自动注入跳过审批参数，不覆盖 npm 自带的 `.cmd` shim。

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
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-opencode-windows.ps1 | iex
```

随后直接运行 `claude`、`codex` 或 `opencode`。重复执行安装脚本是幂等的，不会递归包装现有 wrapper。

## Windows 一键卸载

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-opencode-windows.ps1 | iex
```

卸载会删除本项目的 wrapper 和状态。只有当 npm 包最初由本项目安装时，才会同时卸载该包；预先存在的包会保留。认证、会话、provider 和 CLI 配置不会被删除。

保留 npm CLI 包、只移除绕过 wrapper：

```powershell
# 将 URL 换成对应工具的 uninstall-*-windows.ps1
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-claude-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-codex-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/uninstall-opencode-windows.ps1'))) -KeepCli
```

## Linux 安装与重置

下载后执行，便于先检查脚本内容：

```bash
# Claude Code
curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-claude-root.sh -o install-claude-root.sh
chmod +x install-claude-root.sh && ./install-claude-root.sh

# Codex CLI
curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-codex-root.sh -o install-codex-root.sh
chmod +x install-codex-root.sh && ./install-codex-root.sh

# OpenCode
curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-opencode-root.sh -o install-opencode-root.sh
chmod +x install-opencode-root.sh && ./install-opencode-root.sh
```

恢复各工具的普通启动方式：

```bash
curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/reset-claude.sh -o reset-claude.sh
chmod +x reset-claude.sh && ./reset-claude.sh

curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/reset-codex.sh -o reset-codex.sh
chmod +x reset-codex.sh && ./reset-codex.sh

curl -L https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/reset-opencode.sh -o reset-opencode.sh
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
|-- install-*-windows.ps1       # Windows 安装入口
|-- uninstall-*-windows.ps1     # Windows 卸载入口
|-- install-*-root.sh           # Linux 安装入口
|-- reset-*.sh                  # Linux 重置入口
|-- scripts/windows/AiCliBypass.ps1
|-- tests/Test-WindowsScripts.ps1
|-- tests/Test-Documentation.ps1
|-- docs/README.zh-TW.md
|-- docs/README.en.md
`-- LICENSE
```

## 上游文档

- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI 文档](https://developers.openai.com/codex/cli/)
- [OpenCode 文档](https://opencode.ai/docs/)

## 许可证

本项目采用 [MIT License](LICENSE)。
