# Harness continuation and session locations — 2026-09-18

This record captures the two verification scripts on the Windows on ARM host that
motivated the work: one proves the watchdog can continue a DeepSeek Harness
session, the other proves every local agent is found and located.

## Continuing a harness session

```powershell
node scripts\verify\dsh-continuation.mjs
```

The script creates a disposable harness session through the harness's own
loopback API, sends `继续` with the exact transport the watchdog uses, and
cancels the turn it started so the machine pays nothing for the proof.

```text
harness origin: http://127.0.0.1:3080
scratch session: session-8818d2d2-1bcf-4b8b-a910-0a8003aaf3e4 (workspace C:\Users\30119\AppData\Local\Temp\selbstlauf-dsh-continuation-CE1EZu)

ok    the harness host (PID 97368) answered and accepted the local credential
ok    the harness created a disposable session for the verification
ok    the harness accepted a continuation for session-8818d2d2-1bcf-4b8b-a910-0a8003aaf3e4:
ok    a session with an unfinished step is never handed a second continuation
ok    a continuation is refused for a process that does not own the session
ok    the harness materialized the session on disk
ok    the session log recorded the continuation (session.v3.jsonl.zstd.f5eb659c2cc7.tmp)
ok    the session log grew to 362 bytes
ok    the verification cancelled the turn it started

DSH continuation verification passed
```

The disposable sessions created by this run were deleted afterwards; the harness
keeps them in memory until it restarts, which is why a stale row can survive in
the WebUI session list.

## Every local agent, with its location

```powershell
node scripts\verify\live-monitoring.mjs
```

```text
machine agents: 8 codex root process(es), 1 DeepSeek Harness host(s), 4 live harness session(s)
...
ok    every live session names where it runs (missing: none)
ok    codex:5132 runs in Visual Studio Code [editor]
ok    codex:62072 runs in Codex 应用 [desktop-app]
ok    codex:77248 runs in Codex 应用 [desktop-app]
ok    codex:79556 runs in Tabby [terminal]
ok    dsh:session-3acd60b1-9056-4191-9070-8cd3563436a7 runs in Microsoft Edge [browser]
ok    dsh:session-7a950179-084b-4992-9320-f18dfeed11a2 runs in Microsoft Edge [browser]
ok    codex:96368 runs in Tabby [terminal]
ok    codex:114336 runs in Tabby [terminal]
ok    codex:126328 runs in Tabby [terminal]
ok    dsh:session-3acd60b1-9056-4191-9070-8cd3563436a7 is located in a browser interface (Microsoft Edge)
...
live monitoring verification passed
```

## Revealing a window

`focusWindow` restores and raises the window a session runs in. On this host the
first attempt reported `foreground-refused` — Windows does not hand the
foreground to a process that did not receive the last input — and the final
implementation (attach the input queue after giving the calling thread a message
queue, then the window manager's own activation path, and finally a
topmost/not-topmost raise) reports success:

```text
focusing msedge.exe handle=2427170 "Reference attachments for goal objective — DSH 本地构建"
{"ok":true,"focused":true,"title":"Reference attachments for goal objective — DSH 本地构建","processId":35544}
```

When the OS still refuses, the window is raised to the top of the z-order and the
endpoint answers with `focused: false` plus the reason, so the dashboard can say
"raised, focus not granted" instead of claiming success.

## Installed app on the same host

The updated arm64 setup was installed, started, and asked what it watches. The
installed app - not a repository checkout - reports a location for every session:

```text
health running=True dryRun=True
sessions=11

codex:5132                                         Visual Studio Code  [editor]      win=67092     title=orchester.jsonc - Nexus - Visual Studio Code
codex:62072                                        Codex 应用          [desktop-app] win=18220776  title=ChatGPT
codex:77248                                        Codex 应用          [desktop-app] win=18220776  title=ChatGPT
dsh:session-3acd60b1-9056-4191-9070-8cd3563436a7   Microsoft Edge      [browser]     win=2427170   title=帮我优化排版 命令栏应该在输 — DSH 本地构建
dsh:session-7a950179-084b-4992-9320-f18dfeed11a2   Microsoft Edge      [browser]     win=2427170   title=帮我优化排版 命令栏应该在输 — DSH 本地构建
codex:96368                                        Tabby               [terminal]    win=459954    title= deepseek-harness
codex:114336                                       Tabby               [terminal]    win=459954    title= deepseek-harness
codex:126328                                       Tabby               [terminal]    win=459954    title= deepseek-harness
codex:130968                                       Tabby               [terminal]    win=459954    title= deepseek-harness

focus script shipped: True
bundle has 运行位置: True      bundle has 打开运行位置: True      bundle has Harness API: True
```

Revealing works from the installed app for all three host kinds:

```text
reveal codex:96368                                      -> ok=True focused=True
reveal dsh:session-3acd60b1-9056-4191-9070-8cd3563436a7 -> ok=True focused=True
reveal codex:62072                                      -> ok=True focused=True
```

The two `session-4af0…` / `session-8818…` rows are the disposable sessions the
continuation check created. Their directories were deleted afterwards, but the
running harness still serves them from memory until it restarts, which is why a
harness row can outlive its files.

The packaged service also carries the new modules, so the installed app has the
same code paths as the checkout:
`resources/service-dist/src/dsh/web-host.js`, `.../dsh/loopback-ports.js`,
`.../transport/dsh-transport.js`, and `.../process/window-focus.ps1`.

## Defects this run uncovered

- Every session initially reported the harness browser window, because the
  harness title hint was applied to all tools instead of only to harness rows.
- The reveal script did not compile under Windows PowerShell 5.1: the in-box C#
  compiler predates inline `out` declarations (`out uint pid`), which failed the
  whole `Add-Type` and made every reveal attempt report a command failure.
- Declaring the window-handle P/Invokes with `long` instead of `IntPtr` returned a
  wrong window title, which would have shown the operator the wrong destination.
- Window titles and paths were emitted in the console code page when stdout was
  redirected, so non-ASCII titles arrived as mojibake.