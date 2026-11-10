# Selbstlauf Android 客户端

该应用沿用 Orchester 手机端的 Vue + Capacitor 结构、四栏底部导航、圆角卡片和六套深色主题，并使用 Selbstlauf 桌面端相同的霞鹜文楷。它通过独立的 `/remote/v1` 网关连接电脑，不会直接暴露原有 loopback 管理 API。

## 功能

- 保存多台电脑地址，使用电脑显示的十分钟一次性配对码建立连接。
- Android 原生版本把 bearer token 加密保存在 Android Keystore；地址和设备名称只保存在普通偏好中。
- “控制台”显示看门狗、发现会话和托管智能体窗口状态，可启动或停止看门狗。
- “会话”按 Windows / WSL 与项目根目录分组，可读取记录、暂停、恢复、聚焦电脑窗口并发送提示。
- “智能体”可在电脑真实目录中启动已安装的预设智能体，用 xterm 显示 ANSI/VT 终端、自动同步尺寸、输入、中断、结束和删除窗口。
- 网络中断时轮询保留游标并重试；401 会停止重试并要求重新配对。

## 开发

在仓库根目录运行：

```sh
npm install
npm run test --workspace @ai-cli-bypass/mobile
npm run build --workspace @ai-cli-bypass/mobile
npm run build:android --workspace @ai-cli-bypass/mobile
```

浏览器预览：

```sh
npm run dev --workspace @ai-cli-bypass/mobile
```

浏览器预览只在当前页面内存中保存 token；刷新后需要重新配对。Android 构建使用原生凭据插件。

## 连接

省略端口时客户端默认使用 `48921`。在电脑的“设置 → 手机远控”选择“局域网 / VPN”、设置端口并启用；然后在手机“设置 → 电脑设备”输入电脑 IP、手机名称和一次性配对码。网关使用桌面当前服务，可直接控制桌面创建的托管窗口。电脑端可刷新配对码、撤销手机或关闭远控；关闭远控不结束电脑任务。

仅在模拟器或隧道中使用时，保留默认“仅本机”范围。命令行也可运行 `npm --workspace @ai-cli-bypass/cli start -- --remote --remote-bind 0.0.0.0`（先运行根目录 `npm run build`）。局域网连接时使用电脑可达的 LAN/VPN 地址。明文 HTTP 仅适用于可信局域网或 VPN，不应直接暴露到公网。

本机模拟器测试可通过 `adb reverse tcp:48921 tcp:48921` 连接电脑 loopback 网关，然后在应用中输入 `127.0.0.1:48921`。`adb reverse` 只证明模拟器到本机的链路，不能替代物理手机的 Wi-Fi/VPN 验收。

## 原生验证

需要 Java 21、Android SDK 36 和已连接的 Android 设备。在仓库根目录运行：

```sh
npm run test:android --workspace @ai-cli-bypass/mobile
```

原生测试验证 APK 内的凭据桥接、Keystore 密文及活动重建、无 CORS 原生 HTTP、主题保存。`pairedAppControlsDesktopSessionsAndRealShell` 需要通过 instrumentation 参数 `gateway` 与 `code` 指定一次性测试服务；不提供参数时该远控测试会跳过，不能用其证明远控验收。

Debug APK 位于 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。它用于本机测试；发布版本需要自行配置签名。

已有 APK 与测试 APK 后，可运行完整本机远控旅程：

```sh
ANDROID_SERIAL=emulator-5554 node scripts/verify/mobile-android-live.mjs
```

`SELBSTLAUF_ADB` 可指定 adb 可执行文件，WSL 可使用 Windows SDK 的 `adb.exe`。旅程使用独立状态目录、模拟发现会话和真实主机 Shell PTY；结束后关闭网关、删除测试状态并移除端口反向映射，不更改现有桌面配置。

## 应用图标

Android 启动器图标和桌面 ICO 共用 `assets/selbstlauf-icon-source.png`。传统图标使用满幅原图；自适应图标把原图置于 108dp 图层中央的 66dp 区域，并向外延展边缘像素，圆形与圆角启动器不会出现棕色边框。启动图也沿用同一张原图。

生成 Android 启动器图标（Python 3 + Pillow，仅生成工具需要）：

```sh
python -m pip install -r scripts/mobile/requirements-icons.txt
python scripts/mobile/generate-icon-assets.py
```

脚本生成五套密度的普通、圆形、自适应前景图及背景色，重复执行输出一致。修改源图时，需同时运行桌面端 `scripts/desktop/generate-icon-assets.ps1` 并更新启动图。然后重新构建并安装 APK，启动器才会显示新图标。
