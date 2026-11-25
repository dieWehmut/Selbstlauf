# Codex 非 GPT 模型压缩（一键安装）

Codex 默认只为 OpenAI 后端准备压缩。用第三方网关跑 Gemini、Claude、DeepSeek 时，
上下文到顶后不会压缩，或者压缩直接报错。这个安装脚本把压缩切回 Codex 自己的
**本地摘要**路径，任何模型都能压缩。

- Windows 一键安装：`install-codex-compact-windows.ps1`
- Linux 一键安装：`install-codex-compact-root.sh`
- 唯一实现：`scripts/install/codex_compact_config.py`（纯标准库 Python）

## 症状

会话变长后，出现下面任意一种情况：

```text
remote compaction v2 expected exactly one compaction output item, got 0 from 1 output items
```

```text
POST /v1/responses/compact  ->  404 Not Found
```

或者 `/compact` 没有任何效果，上下文到顶时本次会话直接结束。

## 根因

Codex 按 **provider 名称**判断压缩策略。自定义 provider 的 `name` 写成 `"OpenAI"`
时，Codex 认为对端是 OpenAI 官方后端，于是走 OpenAI 专有的 remote compaction v2：

1. 请求里带上 `compaction_trigger` 这类 OpenAI 专有字段；
2. 期望响应里有且只有一个不透明的 `compaction` 输出项。

第三方网关只是代理普通对话模型，会返回普通的 `message` 输出项，于是 Codex 判定
"0 个 compaction 输出项" 并中止本轮。压缩因此永远不生效。

## 修复

在同一个 `config.toml` 里改两处。

### 1. 声明该 provider 使用本地压缩

```toml
[model_providers.OpenAI.capabilities]
remote_compaction = "unsupported"
```

`unsupported` 让 Codex 放弃远程压缩，回到内置的本地摘要实现——它只依赖对话内容，
与具体模型无关，所以 Gemini、Claude、DeepSeek 都能压缩。

### 2. 让自动压缩阈值真的可达

```toml
model_context_window = 256000
model_auto_compact_token_limit = 230400   # 窗口 × 0.9
```

阈值等于窗口时，Codex 会先撞到硬上限，永远不会提前触发自动压缩。脚本只在
"阈值 >= 窗口"（也就是不可达）时才下调，默认比例 0.9，可用 `--limit-ratio` / `-LimitRatio`
调整，或 `--no-auto-limit` / `-NoAutoLimit` 完全不动这一项。

## 安装

### Windows

```powershell
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-windows.ps1 | iex
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-root.sh | sudo bash
```

Linux 脚本以当前用户身份改 `~/.codex/config.toml`；用 `sudo bash` 运行时会改 root 的
`~/.codex/config.toml`。要给别的用户装，去掉 `sudo` 后以该用户身份运行即可。

### 网络受限时从本地仓库安装

有些环境（例如 WSL、公司内网）能通 `github.com`、却连不上 `raw.githubusercontent.com`，
`curl | bash` 会在下载核心脚本时失败。这时先克隆仓库，再直接跑仓库里的脚本：

```bash
git clone https://github.com/dieWehmut/Selbstlauf.git
cd Selbstlauf
bash scripts/install/linux/install-codex-compact-root.sh
```

脚本优先使用同仓库的 `scripts/install/codex_compact_config.py`，只有找不到它时才回退到
下载 `raw.githubusercontent.com` 上的副本，所以本地运行不依赖外网。
### 参数

| Windows | Linux | 说明 |
|---|---|---|
| `-DryRun` | `--dry-run` | 只打印 diff，不写文件 |
| `-Revert` | `--revert` | 精确撤销上次写入的行 |
| `-LimitRatio 0.75` | `--limit-ratio 0.75` | 阈值改为窗口的 75%（允许 0.5–1.0） |
| `-NoAutoLimit` | `--no-auto-limit` | 只加 capability，不动阈值 |
| `-Config PATH` | `--config PATH` | 指定其它 `config.toml` |
| `-SkipPlugin` | `--skip-plugin` | 不安装 `codex-context-handoff` 插件 |
| `-SkipValidation` | `--skip-validation` | 不校验改后的文件 |

不带参数的重复执行是幂等的：第二次会打印 `nothing to change`，也不会产生新的备份。

## 它到底改了什么

改动前后（`#` 注释、键顺序、引号风格都会原样保留）：

```diff
 model = "gemini-4-hydrogen"
 model_provider = "OpenAI"
 model_context_window = 256000
-model_auto_compact_token_limit = 256000   # 与窗口相同
+model_auto_compact_token_limit = 230400   # 与窗口相同

 [model_providers.OpenAI]
 name = "OpenAI"
 base_url = "https://gateway.example/v1"
 wire_api = "responses"

+[model_providers.OpenAI.capabilities]
+remote_compaction = "unsupported"
```

具体做法：

1. 从顶层 `model_provider` 读出真正在用的 provider，再定位
   `[model_providers.<provider>]`；没有这个表时只补一个 `capabilities` 子表，
   不凭空造 provider。
2. 逐行编辑，不做 TOML 反序列化重写，所以注释、空行、CRLF、UTF-8 BOM、
   末尾有无换行都不变。
3. 写入前先做时间戳备份，写完再校验；校验失败会自动把原文件还原。

## 备份、状态与回滚

| 文件 | 作用 |
|---|---|
| `config.toml.bak-compact-<UTC 时间>` | 改动前的逐字节备份 |
| `.codex-compact-state.json` | 记录本次插入了哪几行，`revert` 靠它精确还原 |

```powershell
# Windows
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-windows.ps1 | iex
# 需要带 -Revert 时用脚本块形式：
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-windows.ps1'))) -Revert
```

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-root.sh | sudo bash -s -- --revert
```

`revert` 只撤销自己写过的那几行：如果某行你后来手工改过，它会被跳过并提示，
而不是盖上你的修改。没有状态文件时 `revert` 会明确报错，不会误删配置。备份文件与插件注册的 `[marketplaces.*]` 不属于这次补丁，`revert` 不会动它们。

## 顺带安装的插件（可选）

脚本会尝试安装 [codex-context-handoff](https://github.com/Sunwaycoser/codex-context-handoff)：
在上下文达到阈值时先生成交接文档，再归档旧会话，避免压缩后丢细节。

这个插件默认会在 Windows 弹出一个系统消息框，脚本会把
`~/.codex/codex-handoff.json` 里的 `notify` 写成 `false`：**保留文字提醒，去掉弹窗**，
文件里其余的键原样保留。

装好后需要在 Codex TUI 里执行一次 `/hooks` 信任这些钩子，否则它们不会运行。
不想要插件时加 `-SkipPlugin` / `--skip-plugin`。

## 依赖

- Codex CLI（`@openai/codex`）
- Python 3.8 或更新版本（脚本会依次尝试 `py -3`、`python`、`python3`）

Windows 缺少 Python 时，脚本会提示：

```powershell
winget install --id Python.Python.3.12 -e
```

Linux 缺少 Python 时会给出对应发行版的安装命令（apt / dnf / apk / pacman）。

脚本自身不安装 Python，也不改系统包管理器状态。

## 验证

先看当前状态（不改任何文件）：

```bash
python3 scripts/install/codex_compact_config.py inspect
```

```
config:   ~/.codex/config.toml
provider: OpenAI
  name:    OpenAI
  base_url: https://gateway.example/v1
window:   256000
limit:    230400 (reachable)
compact:  remote_compaction = unsupported
state:    applied 2026-01-01T00:00:00Z by .codex-compact-state.json
```

- `compact:  remote_compaction = unsupported` 表示已切换到本地压缩；
- `limit: ... (reachable)` 表示阈值能在硬上限之前触发；
- 改完 `config.toml` 后要重启 Codex 才生效。

想确认 Codex 真的在读这个键、而不是把未知字段当噪声忽略掉：临时塞一个非法值，Codex
会拒绝启动，并顺带把合法取值列出来。把 `OpenAI` 换成你自己的 provider 名：

```bash
codex app-server --print-startup-config \
  -c 'model_providers.OpenAI.capabilities.remote_compaction="bogus"'
# -> unknown variant `bogus`, expected `unsupported` or `v2`
#     in `model_providers.OpenAI.capabilities.remote_compaction`
```

报错里列出 `unsupported` 与 `v2` 两个合法取值，就说明安装进去的 `unsupported` 是生效的：
Codex 不是忽略未知键，而是真的按这个值决定走本地压缩。

WSL 里的 codex-cli 0.172.0 已按上面这条命令验证过；下面的长会话观察是行为层面的最终确认。

跑一次长会话把上下文填到阈值附近，观察是否出现压缩摘要、会话是否继续，即可确认
Gemini 这类非 GPT 模型也能压缩了。

## 直接使用核心脚本

安装脚本只是外壳，核心可以单独跑：

```bash
python3 scripts/install/codex_compact_config.py apply  --dry-run
python3 scripts/install/codex_compact_config.py apply
python3 scripts/install/codex_compact_config.py revert --dry-run
python3 scripts/install/codex_compact_config.py revert
```

退出码：`0` 成功，`1` 失败，`2` 参数错误。

## 测试

```bash
python3 tests/test_codex_compact_config.py
```

测试覆盖：注释与格式保留、CRLF/BOM/无末尾换行、幂等、按字节还原、provider 名带空格、
非 UTF-8 配置被拒绝、阈值不可达才下调等。

## 数据安全

- 改的是你自己的 `config.toml`，不联网、不改 provider 的 `base_url` 或密钥。
- 所有写入都先备份，校验失败自动还原。
- `codex_compact_config.py` 只用 Python 标准库，不装第三方包。