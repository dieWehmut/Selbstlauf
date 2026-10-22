# 智能体窗口与真实输入输出

目标：每个智能体窗口能把输入送到真实进程、显示该进程的输出，并能启动 Claude、OpenCode 等智能体。

按任务实施，每步验证后独立提交：

1. 本机 PTY 会话服务：启动、独立输入输出、输出重放、尺寸调整、终止、HTTP/SSE。
2. 智能体启动入口：工具发现、工作目录、参数、自定义命令、明确失败原因。
3. 窗口终端：每个会话独立窗口、实时输出、键盘与多行输入、页面切换与刷新后继续使用。
4. 已有会话与桌面版：会话输出查看、Electron 的本机终端组件、打包资源。
5. 端到端验证与使用说明：真实进程输入输出、Claude/OpenCode 启动、回归测试、启动命令。

证据必须覆盖真实进程以及浏览器到服务再到进程的完整通路。示例数据和 HTTP 健康检查不能证明输入输出完成。

## 任务 1 验证

- 用 node-pty 启动两个真实 Node 进程，验证 TTY、中文和多行输入、字面参数、工作目录、窗口隔离、尺寸调整、输出游标重放及退出码。
- 通过本机 HTTP/SSE 启动、输入、读取输出、断开后重连、终止并删除真实进程。
- 验证 POSIX 进程组的子进程随窗口终止。
- `npm --workspace apps/cli test`：286 项通过，11 项 Windows 专用测试在 Linux 跳过。
- xterm 和桌面 PTY 的依赖在这一步统一准备，后续任务接入界面与 Electron。

## 任务 2 验证

- 各页面标题栏提供启动入口，工具目录来自本机 PATH；支持自定义可执行路径、工作目录、窗口名称与字面参数。
- 启动成功后进入智能体窗口列表，列表保留真实 PID、状态和结束/关闭操作。
- 启动失败保留输入字段并显示服务原因；在线演示不会请求本机启动服务。
- `npm --workspace apps/web run build` 与 `npm --workspace apps/web test` 通过，260 项前端测试通过。

## 任务 3 验证

- xterm 显示真实 PTY 输出；键盘、方向键、Ctrl+C 和多行粘贴按进程的终端协议发送。每个窗口有独立草稿与串行输入队列。
- 页面切换保留终端，刷新后重放输出；浏览器独立窗口连接同一个真实进程。
- 全局状态与各窗口输出共用一个 WebSocket，避免多个窗口耗尽浏览器 HTTP/SSE 连接数；保留 SSE API 兼容。
- 两项 Playwright 测试运行真实 PTY，覆盖中文、多行、键盘输入、窗口隔离、草稿、刷新重放、独立窗口、退出后保留输出，以及启动 DSR 查询和 bracketed paste 协议。
- 本机浏览器实际启动 PATH 中的 Claude Code、OpenCode、Codex，`--version` 均正常显示并以退出码 0 结束。这里验证真实 CLI 启动，不把测试用 Node 进程当成模型回复。
- CLI：287 项通过、11 项 Windows 专用测试跳过；前端：264 项通过；两项浏览器终端测试通过。

## 任务 5 验证

这一轮补的是「真的能用」的证据，而不是又一层单元测试。完整记录见
[2026-10-22 真机验证](../verification/2026-10-22-agent-windows-live.md)。

- 新增 `scripts/verify/agent-windows-live.mjs`：启动真实服务（一次性状态目录），用真实 Chromium 打开真实 WebUI，像人一样点「启动智能体」、选工具、命名窗口、按「启动」，然后断言浏览器收到的字节。
- 三个预设在本机各自画出了自己的 TUI：Claude Code 2.1.278（`Welcome to Claude Code`）、OpenCode 1.19.3（wordmark 与 `Ask anything`）、Codex 0.163.0（`› Ask Codex to do anything`）。
- 输入输出往返：在窗口输入框里发多行中文，PTY 收到两行并回显，xterm 把回复渲染在屏幕上。
- 真实模型往返：在 codex 窗口里发一句指令，要求只回 `SELBSTLAUF_WINDOW_OK`。断言要求**第二次**独立出现（提示词本身含标记、TUI 也会回显提示词，只出现一次什么都证明不了），实测 marker occurrences: 2。
- 启动入口：根 `package.json` 增加 `verify:agent-windows`，CLI 工作区增加 `start`，`npm start` 直接起服务。
- 回归：CLI 306 项（295 通过 / 11 项 Windows 专用跳过）、前端 270 项、浏览器 93 项、智能体浏览器 6 项、桌面 149 项。
- Windows 原生复核：新增 scripts/verify/agent-windows-conpty.mjs，在 Windows 上用 ConPTY 跑同样的流程，
  三个预设各自画出 TUI（Claude Code 2.1.278、OpenCode、Codex 0.163.0），终端窗口输入 echo 后回显两处标记，
  说明输入真的到达了进程、输出真的回到了窗口。
- 本机限制如实记录：Claude Code 在这台机器上连不上 `api.anthropic.com`（TLS 校验失败），窗口本身正常；Electron 端到端需要显示器，这台 WSL 没有，桌面版只跑了 149 项工作区测试。

## 任务 4 验证

- 原有进程详情页读取该进程唯一关联的 Claude JSONL、Codex rollout 或 DeepSeek Harness projection，展示真实输入、回复及工具输出。读取范围有上限，不接收客户端提供的文件路径；关联失败显示实际原因。
- 前端每 3 秒更新输出，切换会话时丢弃旧请求，按文本显示记录。
- Electron 主进程从应用自己的原生依赖加载 PTY；独立 BrowserWindow 连接同一会话，关闭子窗口后主窗口仍能继续输入。
- 打包显式携带 WebSocket 运行库，并解包 node-pty 的原生库及辅助文件。
- CLI：294 项通过、11 项 Windows 专用测试跳过；前端：267 项通过；桌面：149 项通过。三个工作区构建通过。
- 实际 Electron 启动验证了原生 PTY、中文/多行输入、实时输出、独立窗口与子窗口关闭后的继续交互。
- Linux 安装目录产物复制到仓库外的临时安装位置、移除 NODE_PATH 后再次运行同样的验证，成功；运行库没有依赖开发目录兜底。可通过 `SELBSTLAUF_PACKAGED_EXECUTABLE` 对打包产物重复此验证。
