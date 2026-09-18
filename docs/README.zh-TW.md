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

### 本機工具探索與 DeepSeek Harness

每個輪詢週期只讀列舉同一使用者的程序，並把同一工具的程序樹根與子程序合併成一個
邏輯工作階段：

| 工具 | 程序簽章 | 工作階段關聯 | 寫入通道 |
|---|---|---|---|
| Claude Code | `claude.ps1`、`claude-code` | `~/.claude/projects` 的 JSONL | Console / PTY / Stop Hook |
| Codex CLI | `codex.exe`、`@openai/codex`、`codex.js` | `~/.codex` 的執行緒與 goal 狀態庫 | Codex App Server |
| DeepSeek Harness | `dsh.exe` / `dsh.cmd`、`@deepseek-ai/dsh`、`deepseek-harness` 下的 `apps/cli/lib/bin.js` 與 `subprocess-local/runner.js` | `$DSH_HOME/sessions` 的工作階段目錄與 `storages/session_projcache` 投影 | Harness 本機工作階段介面 |

DeepSeek Harness 的 `web` 宿主機是一個程序服務多個工作區，因此宿主機本身不是 agent：
watchdog 會把每個仍活躍的 harness 工作階段展開成獨立的一列，工作階段 ID 取自 harness
自己的 `session-…` 識別，工作區取自工作階段投影的 `cwd`，靜默時間取自工作階段日誌與
投影的最新寫入時間。投影中的 `turnBoundary.lastStepBoundary.kind` 直接說明該工作階段
是否還有未結束的步驟，介面因此能區分「步驟執行中」與「等待輸入」。從未收到提示的空
工作階段，以及活動視窗之外的歷史工作階段不會出現在清單中。

harness 的工作階段日誌是 zstd 壓縮的追加日誌，watchdog 只讀取第一行工作階段標頭以補齊
`cwd`，絕不寫入。

### 續寫 DeepSeek Harness

harness 沒有主控台，也沒有以 PID 為範圍的寫入通道：工作階段以自身識別定址，宿主是一個長駐
的 `web` 程序。watchdog 因此走 harness 自己的本機介面：列舉宿主監聽的 loopback 連接埠，
以 `GET /` 的 401 指紋確認那是 harness，讀取 harness 自己存在
`$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 密鑰，簽出與瀏覽器相同
的 session cookie，並呼叫 UI 自己使用的 `session/prompt`（`mode: queue`）。

安全邊界刻意收窄：

- 只對 `127.0.0.1` 的 http 來源生效；憑證唯讀、只用於該次請求，絕不寫入日誌、絕不落盤。
- 只有在工作階段**沒有未結束的步驟**（`turnOpen === false`）時才寫入；執行中的 agent 不會被
  打斷。這是獨立於靜默門檻的第二道門。
- `dry run` 期間只探測 harness 位置、不讀取密鑰，也不寫入；關閉 `tools.dsh` 時同樣不寫入。
- 任何一步失敗（讀不到密鑰、指紋不符、cookie 被拒、工作階段消失）都退回 `monitor-only`
  並在介面說明原因，而不是猜測。
- 寫入只透過 harness 自己的工作階段控制器完成，不使用全域鍵盤或滑鼠 API。

`tools.dsh.allowApiInput`（預設開啟）控制這條通道；`tools.dsh.sessionWindowMs`（預設 1 小時）
決定多久沒有活動的工作階段會被視為歷史。

### 工作階段執行位置與一鍵開啟

每一列都會給出該 agent 實際所在的宿主，而不只是 PID：程序探索會沿父鏈回溯，並以一次
`EnumWindows` 取得這些祖先所擁有的一級視窗，據此辨識 **Tabby / Windows Terminal / VS Code /
Cursor / Codex 應用（ChatGPT.exe）/ Edge / Chrome / Firefox** 等宿主，並記錄可置前的視窗
控制代碼。介面的「執行位置」欄顯示宿主名稱與視窗標題，旁邊的按鈕會呼叫
`POST /api/sessions/<id>/focus` 把該視窗還原並置前。

harness 列是例外：它的介面由瀏覽器提供，瀏覽器不在工作階段的程序樹裡。因此 harness 列依視窗
標題中的 `DSH` 標記找到正在顯示 WebUI 的瀏覽器視窗（優先瀏覽器，其次任何相符視窗）；若找不到
視窗，則顯示「DeepSeek Harness 網頁介面」並改為開啟該 loopback 位址。置前只使用視窗管理 API
（`SetForegroundWindow`、`AttachThreadInput`、`SwitchToThisWindow`、`SetWindowPos`），從不合成
鍵盤或滑鼠輸入；Windows 若因前台鎖拒絕授予焦點，視窗仍會置頂顯示，介面會說明這一點。

程序探索需要 `powershell.exe`（Windows PowerShell 5.1 或更高版本）。擁有者 SID 透過
程序權杖讀取，而非逐程序呼叫 WMI 的 `GetOwnerSid()`；後者在程序較多的桌面上每次輪詢
要花掉近一分鐘，改寫後「探索 → 關聯 → 決策」的完整鏈路才能在預設 2 秒輪詢間隔內跑完。

要在這台機器上驗證監控與續寫確實生效，而不是只看健康檢查：

```powershell
npm run build
node .\scripts\verify\live-monitoring.mjs      # 每個本機 agent 都被發現，並給出執行位置
node .\scripts\verify\dsh-continuation.mjs     # harness 真的接受了一次「繼續」
```

`live-monitoring.mjs` 會獨立列舉本機程序與 harness 工作階段，再要求執行中的服務為每一個都
給出對應的一列、正確的工具、工作區、執行位置與傳輸，並確認已寫入活動／決策事件且沒有任何
注入。`dsh-continuation.mjs` 會自己建立一個一次性 harness 工作階段，用 watchdog 的同一個傳輸
寫入「繼續」，驗證 harness 接受並落盤，然後取消它啟動的那一輪。真機執行記錄見
[verification/2026-09-17-live-monitoring.md](verification/2026-09-17-live-monitoring.md)
與 [verification/2026-09-18-harness-continuation.md](verification/2026-09-18-harness-continuation.md)。

## 桌面應用與安裝程式

Electron 桌面版把 watchdog 服務與 WebUI 放在同一個視窗，不需要再單獨執行
`start-watchdog.ps1`。從 [GitHub Releases](https://github.com/dieWehmut/Selbstlauf/releases)
下載 `Selbstlauf-Setup-<version>-<arch>.exe` 後直接執行：安裝程式寫入
`%LOCALAPPDATA%\Programs\Selbstlauf`，建立桌面與開始功能表捷徑，並註冊卸載程式；
它只作用於目前使用者，不需要系統管理員權限。

發佈流程由 `.github/workflows/release-desktop.yml` 負責，可用 `v*` tag 觸發或手動執行：
它會建置並測試所有 workspace、對桌面 shell 做 smoke 測試、封裝 x64 與 arm64 安裝程式，
並以 `scripts/desktop/verify-installer.ps1` 驗收 x64 安裝程式（安裝完整性、捷徑、
卸載登錄項目、內建服務健康檢查、WebUI 可存取、卸載乾淨）；tag 觸發時把安裝程式發佈到
GitHub Release，否則保留為 workflow artifact。

驗收腳本還會啟動一個帶有受支援簽章的探針程序，要求**已安裝**的應用把它探索出來、
標記為存活、並寫入 per-session 決策，之後才移除探針。只檢查健康檢查與 WebUI 並不足夠：
`tsc` 不會產出 PowerShell 資源，服務又把它當作自己的同級檔案解析，若安裝程式漏帶該資源，
應用會正常啟動、正常提供 WebUI，卻一個程序都探索不到。
`resources/service-dist/src/process/windows-processes.ps1` 因此同時是封裝清單與驗收清單的一部分。

```powershell
npm install
npm run build
npm --workspace apps/desktop run package:win   # 輸出到 tmp\desktop-dist
npm --workspace apps/desktop run smoke         # 無介面驗證內建服務
```

安裝完成後，WebUI 設定頁的「安裝啟動項」會從安裝目錄註冊目前使用者的登入工作，
「移除啟動項」會刪除該工作。該工作執行安裝目錄內的
`resources\scripts\continuation\start-watchdog.ps1`，並回退到隨套件提供的
`service-dist` 進入點，因此不依賴原始碼倉庫。

### Claude Stop Hook

Claude Stop Hook 預設關閉。開啟本機 WebUI 的設定頁，先確認 `dryRun` 狀態，
再調整 Lease 有效期、命令逾時與一般 Claude 提示文字，按「安裝 Stop Hook」並
儲存設定。安裝只會修改目前使用者的
`%USERPROFILE%\.claude\settings.json`，並在 watchdog 自有狀態目錄保存受校驗的
所有權 manifest。已開啟的 Claude 程序必須完全退出並重新啟動，才會載入新的 Hook。

Hook 只有在工作階段、程序身分、工作目錄、transcript 路徑與活動指紋全部一致時，
才會消費一次性 Lease。若已有新輸出、關聯不唯一、遞迴呼叫 Hook 或 Lease 已過期，
會回傳空決策而不送出文字。「停用 Stop Hook」會清除待處理 Lease；「解除安裝
Stop Hook」會依 manifest 從備份還原原始 settings 位元組。若檔案在安裝後被修改，
介面會標示「需要人工檢查」並拒絕覆寫，保留檔案與備份供使用者審閱。

Hook CLI 不會讀取 transcript 內容，也不使用全域鍵盤 API。Codex 仍透過 App Server
或 PID 驗證的終端傳輸；無法安全寫入的程序會保持 `monitor-only`。需要時先停用
Hook 再解除安裝 watchdog；CLI、認證與對話資料都不會被這些生命週期操作刪除。

只有經 PID 驗證的 classic Console、服務擁有的 PTY 或 Codex App Server 才能
寫入；不支援的 ConPTY 會保持 `monitor-only`，服務不使用全域鍵盤 API。WebUI
可暫停程序、修改提示文字、查看已遮罩的事件時間線，以及移除 watchdog 自己擁有的狀態。

### Codex 端點切換

本機 WebUI 的設定頁提供「端點配置」面板，用來在 `CODEX_HOME/config.toml` 中切換
Codex 的接入端點。面板會列出目前生效的 `model`、`review_model`、
`model_reasoning_effort`、`base_url` 與 `experimental_bearer_token`，並把
`config.toml` 中以註解形式閒置的舊端點顯示為可點擊的備選膠囊；點擊膠囊即可
切回對應端點，也可以在輸入框手寫新值後按「套用端點配置」。

切換完全依照手工維護該檔案的方式改寫：命中的註解行會被啟用，原先生效的賦值會
被改寫為註解保留，未知取值會取代目前行，缺少的鍵會追加到最後一個頂層賦值之後；
`[section]` 之外的無關內容與專案段落按位元組原樣保留。每次寫入前都會先寫入一份
`.bak` 備份與 `sha256` 校驗邊車檔案，寫入本身以暫存檔原子替換完成，因此中斷的
切換可以人工復原。寫入會串行化，避免並發切換互相覆蓋。

本機路由為 `GET /api/codex/profiles` 與 `PUT /api/codex/profiles`（請求體
`{ "fields": [{ "key": "base_url", "value": "..." }] }`）；變更會記入審計日誌
的 `user-override` 事件。此面板僅在本機 watchdog 介面提供，Pages 展示站使用
記憶體內範例資料，不會修改任何本機檔案。
## WebUI 展示站

在本機啟動管理介面：

```powershell
npm install
npm --workspace apps/web run dev
```

`.github/workflows/deploy-pages.yml` 會在推送 `main` 時建置靜態展示並透過
GitHub Actions 發佈；請先在儲存庫 Settings 將 Pages 來源設為 **GitHub Actions**。
公開網址是 [https://dieWehmut.github.io/Selbstlauf/](https://dieWehmut.github.io/Selbstlauf/)。
Pages 使用記憶體內範例資料，不會安裝本機 Hook 或對程序輸入；這些操作只在
`127.0.0.1` 的 watchdog 介面提供。

## 上游文件

- [Claude Code 文件](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI 文件](https://developers.openai.com/codex/cli/)
- [OpenCode 文件](https://opencode.ai/docs/)

## 授權

本專案採用 [MIT License](../LICENSE)。
