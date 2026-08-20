<h1 align="center">Selbstlauf</h1>

<p align="center">
  <img src="https://count.getloli.com/get/@Selbstlauf?theme=rule34" alt="Visitors">
</p>

<div align="center">

[![Windows](https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square&logo=windows)](https://www.microsoft.com/windows)
[![PowerShell](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?style=flat-square&logo=powershell)](https://learn.microsoft.com/powershell/)
[![Tools](https://img.shields.io/badge/AI_CLI-3-2E8B57?style=flat-square)](#支援的工具)
[![License](https://img.shields.io/badge/License-MIT-333333?style=flat-square)](../LICENSE)

</div>

<div align="center">

[简体中文](../README.md) | 繁體中文 | [English](README.en.md)

</div>

---

## 概覽

`Selbstlauf`（原 `ai-cli-bypass`）為 Claude Code、Codex CLI 與 OpenCode 提供 Windows 一鍵安裝/解除安裝指令碼，並保留既有的 Linux root/sudo 環境指令碼。Windows 版本會安裝官方 npm 套件，在使用者目錄建立獨立 wrapper，自動注入略過核准參數，不會覆寫 npm 原有的 `.cmd` shim。

> [!WARNING]
> 這些指令碼會關閉或繞過工具原本的權限核准、沙箱或確認保護。惡意提示、相依套件或命令可能直接讀寫檔案並執行系統操作。只應在你完全信任的隔離環境、容器或已強化沙箱中使用；請勿在存放重要資料或憑證的日常主機上執行。

## 支援的工具

| 工具 | 官方 npm 套件 | Windows 安裝 / 解除安裝 | Linux 安裝 / 重設 | 自動注入參數 |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | `install-claude-windows.ps1` / `uninstall-claude-windows.ps1` | `install-claude-root.sh` / `reset-claude.sh` | `--dangerously-skip-permissions` |
| Codex CLI | `@openai/codex` | `install-codex-windows.ps1` / `uninstall-codex-windows.ps1` | `install-codex-root.sh` / `reset-codex.sh` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode-ai` | `install-opencode-windows.ps1` / `uninstall-opencode-windows.ps1` | `install-opencode-root.sh` / `reset-opencode.sh` | `--auto` |

## 環境需求

### Windows

- Windows 10 或更新版本
- Windows PowerShell 5.1 或更新版本
- Node.js 與 npm，且 `npm.cmd` 已加入 PATH
- Claude Code 原生 Windows 使用方式還需要 [Git for Windows](https://git-scm.com/download/win)；請依上游要求設定 Git Bash

指令碼只修改目前使用者環境，不需要系統管理員權限。安裝後若目前終端仍找不到命令，請重新開啟 PowerShell。

### Linux

- Debian、Ubuntu、Fedora、RHEL 或 Alpine Linux
- Node.js / npm
- Claude Code root 繞過需要 `gcc`；安裝指令碼會在缺少時嘗試安裝

## Windows 一鍵安裝

在 PowerShell 中執行對應命令：

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-opencode-windows.ps1 | iex
```

接著直接執行 `claude`、`codex` 或 `opencode`。重複執行安裝指令碼是冪等的，不會遞迴包裝既有 wrapper。

## Windows 一鍵解除安裝

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1 | iex
```

解除安裝會刪除本專案的 wrapper 與狀態。只有 npm 套件最初由本專案安裝時才會一併移除；原先存在的套件會保留。驗證、工作階段、provider 與 CLI 設定不會被刪除。

保留 npm CLI 套件、只移除繞過 wrapper：

```powershell
# 將 URL 換成對應工具的 uninstall-*-windows.ps1
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1'))) -KeepCli
```

## Linux 安裝與重設

下載後再執行，方便先檢查指令碼內容：

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

恢復各工具的一般啟動方式：

```bash
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-claude.sh -o reset-claude.sh
chmod +x reset-claude.sh && ./reset-claude.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-codex.sh -o reset-codex.sh
chmod +x reset-codex.sh && ./reset-codex.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-opencode.sh -o reset-opencode.sh
chmod +x reset-opencode.sh && ./reset-opencode.sh
```

## 運作方式

Windows 入口指令碼會載入 `scripts/windows/AiCliBypass.ps1`，並執行下列操作：

1. 透過 npm 安裝或更新對應的官方 CLI 套件。
2. 找到 npm 產生的真實 `.cmd` shim，保持原始檔案不變。
3. 在 `%LOCALAPPDATA%\ai-cli-bypass\bin` 寫入獨立 wrapper，將危險參數放在所有使用者參數之前。
4. 在 `%LOCALAPPDATA%\ai-cli-bypass\state` 記錄套件與 PATH 所有權，解除安裝時只撤銷本專案建立的資源。
5. 驗證寫入、重新安裝與失敗路徑並進行回復；wrapper 會保留上游結束碼與使用者參數。

Linux 指令碼使用各工具專用 wrapper；Claude Code 另透過 `LD_PRELOAD` 處理 root UID 檢查。

## 疑難排解

- **找不到 `npm.cmd`**：安裝 Node.js/npm，確認新的 PowerShell 中 `Get-Command npm.cmd` 有結果。
- **安裝成功但找不到命令**：重新開啟 PowerShell 讓使用者 PATH 生效；也可以重新執行對應安裝指令碼。
- **Claude Code 在 Windows 無法啟動**：安裝 Git for Windows，並依 Claude Code 官方說明設定 Git Bash 路徑。
- **npm 套件解除安裝失敗**：修復 npm 網路或權限後重試；狀態會保留供再次執行。
- **只想恢復核准模式**：執行對應 `uninstall-*-windows.ps1`；需要保留 CLI 時使用 `-KeepCli`。

## 專案結構

```text
.
|-- install-*-windows.ps1       # 相容入口
|-- uninstall-*-windows.ps1     # 相容入口
|-- install-*-root.sh           # 相容入口
|-- reset-*.sh                  # 相容入口
|-- scripts/install/windows/*   # Windows 安裝腳本
|-- scripts/install/linux/*     # Linux 安裝腳本
|-- scripts/uninstall/windows/* # Windows 解除安裝腳本
|-- scripts/uninstall/linux/*  # Linux 重設腳本
|-- scripts/windows/AiCliBypass.ps1
|-- scripts/continuation/*      # watchdog 生命週期
|-- tests/Test-WindowsScripts.ps1
|-- tests/Test-Documentation.ps1
|-- docs/README.zh-TW.md
|-- docs/README.en.md
`-- LICENSE
```

## Codex Full Access on Windows

The Codex installer persistently writes the official Full Access settings to
`CODEX_HOME/config.toml`:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

Repeated setup detects the installed command, skips npm and core downloads,
and uninstall restores settings owned by this project unless you changed them.

> [!WARNING]
> Full Access disables normal approval and sandbox protections. Use it only in
> an environment you fully trust.

## Continuation Watchdog

本機 watchdog 會分別監控同一使用者的 Claude/Codex 程序，等待設定的靜默
時間後記錄決策；一般對話使用 `继续`，只有可恢復的 Codex Goal 才使用
`/goal resume`。先在 WebUI 檢查傳輸能力，再關閉 Dry Run。

```powershell
npm install
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\start-watchdog.ps1 -DryRun
Start-Process http://127.0.0.1:48920/
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\stop-watchdog.ps1
```

可重複執行目前使用者的安裝；需要登入後自動啟動時加上 `-Startup`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\install-watchdog.ps1 -DryRun -Startup
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\uninstall-watchdog.ps1
```

安裝器只擁有 `%LOCALAPPDATA%\ai-cli-bypass\continuation`，並以
`install-manifest.json` 記錄所有權。解除安裝器會驗證 manifest、PID 與儲存庫
路徑，只移除自有狀態及自有登入工作，不會刪除 npm 套件、CLI wrapper、認證、
工作階段或其他 `ai-cli-bypass` 狀態。WebUI 使用 `/api/watchdog/start`、
`/api/watchdog/stop` 與 `/api/uninstall` 執行這些生命週期操作。

只有經 PID 驗證的 classic Console、服務擁有的 PTY 或 Codex App Server 才能
寫入；不支援的 ConPTY 會保持 `monitor-only`，服務不使用全域鍵盤 API。WebUI
可暫停程序、修改提示文字、查看已遮罩的事件時間線，以及移除 watchdog 自己擁有的狀態。

## 上游文件

- [Claude Code 文件](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI 文件](https://developers.openai.com/codex/cli/)
- [OpenCode 文件](https://opencode.ai/docs/)

## 授權

本專案採用 [MIT License](../LICENSE)。
