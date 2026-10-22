# Agent windows: real input, real output, real agents — 2026-10-22

This records what was actually exercised on this machine for the objective
"每个窗口页面要能真正实现输入输出，以及要能启动别的智能体，比如 Claude、OpenCode".
Every claim below comes from a command whose result is quoted, not from reading the code.

## What "a window" means here

Each window in 智能体窗口 owns one PTY (a real pseudo-terminal, not a pipe) and the process
started on it. The browser draws that PTY's byte stream through xterm, and every keystroke,
paste or composer submission is written back to the same PTY. Nothing is replayed from a
transcript: the bytes on screen are the bytes the process wrote.

## Gate results

| Gate | Command | Result |
| --- | --- | --- |
| CLI workspace | `npm --workspace apps/cli test` | 306 tests: 295 pass, 0 fail, 11 skipped (Windows-only) |
| Web unit | `npm --workspace apps/web test` | 24 files, 270 tests pass |
| Web browser | `npx playwright test --workers=1` (in `apps/web`) | 93 tests pass |
| Agent browser | `npm --workspace apps/web run test:agents` | 6 tests pass — 3 scenarios × {packaged service, Vite dev proxy} |
| Desktop | `npm --workspace apps/desktop test` | 149 tests pass |
| Live agent windows | `node scripts/verify/agent-windows-live.mjs` | PASS — see below |

The browser suites need `LD_LIBRARY_PATH` pointing at the extracted browser runtime in
`tmp/browser-runtime/root/usr/lib/x86_64-linux-gnu` on this WSL image, because `libnspr4`,
`libnss3` and `libasound2` are not installed system-wide. That is a property of the machine,
not of the product.

The browser suites are run with `--workers=1`. Run in parallel on this 20-core box, nine
`demo` specs timed out on `page.goto` / `hover`; the same specs pass in isolation and pass
in a serial run, so the failures are load, not behaviour. The serial run is the gate.

## Live verification: the whole path, no fixtures

`scripts/verify/agent-windows-live.mjs` starts the real service (`apps/cli/dist/src/index.js`)
on a throwaway state directory, drives it with a real Chromium through the real WebUI, and
asserts on what the browser received. Fixtures are used only for the echo window, and even
there the process is a real PTY.

```
ok    the service is up on the loopback origin
ok    claude is discoverable on PATH (/mnt/c/Users/han/AppData/Roaming/npm/claude)
ok    opencode is discoverable on PATH (/mnt/c/Users/han/AppData/Roaming/npm/opencode)
ok    codex is discoverable on PATH (/home/han/.nvm/versions/node/v24.21.0/bin/codex)
ok    the app shell renders
ok    claude 真实 CLI: the service started a real process
ok    claude 真实 CLI: PID 2822786 running /mnt/c/Users/han/AppData/Roaming/npm/claude
ok    claude 真实 CLI: the window is connected
ok    claude: its own TUI reached the browser window
ok    opencode 真实 CLI: the service started a real process
ok    opencode: its own TUI reached the browser window
ok    codex 真实 CLI: the service started a real process
ok    codex: its own TUI reached the browser window
ok    往返验证窗口: the service started a real process
ok    the round-trip window owns a real TTY
ok    the process received both lines and its reply reached the window
ok    xterm rendered that reply on screen
ok    codex answered a prompt typed into the window (the answer is not in the prompt)
      marker occurrences: 1
ok    no page errors ()

agent windows live verification: PASS
```

The first screen each CLI painted, as the browser received it (whitespace collapsed; the
spaces between words are cursor moves in these TUIs, not literal characters):

- **Claude Code** `2.1.278` — `WelcometoClaudeCodev2.1.278`
- **OpenCode** `1.19.3` — the `opencode` wordmark plus `Ask anything…` and the build line
- **Codex** `0.163.0` — `OpenAI Codex (v0.163.0)` with `› Ask Codex to do anything`

The model round-trip asks the model to reverse a token rather than echo it. An echo proves nothing: the
prompt contains the token and the TUI echoes the prompt, so the marker would appear even with no model
involved. The reversed string never appears in the prompt, so its presence is a reply the model produced.
It was observed with marker occurrences: 1.

Two screenshots are retained: `live-codex-model.png` (the model reply inside the window) and
`live-round-trip.png` (multiline Chinese input, both lines answered, rendered by xterm).

## The same check on Windows (ConPTY)

Windows is the platform the desktop app ships on, and it does not use a POSIX pty: node-pty talks to ConPTY.
scripts/verify/agent-windows-conpty.mjs repeats the exercise natively on Windows, driving the same REST
surface the WebUI drives (no browser needed):

```
ok    the service runs natively on Windows (ConPTY host)
ok    claude is discoverable on the Windows PATH (claude.ps1)
ok    opencode is discoverable on the Windows PATH (opencode.ps1)
ok    codex is discoverable on the Windows PATH (codex.ps1)
ok    claude: PID 19088 running C:/Users/han/AppData/Roaming/npm/claude.ps1
ok    claude: its own TUI reached the output stream
ok    opencode: PID 14040 running C:/Users/han/AppData/Roaming/npm/opencode.ps1
ok    opencode: its own TUI reached the output stream
ok    codex: PID 13376 running C:/Users/han/AppData/Roaming/npm/codex.ps1
ok    codex: its own TUI reached the output stream
ok    a shell window started on ConPTY
ok    typed text reached the process and its output came back (2 occurrences)

windows ConPTY verification: PASS
```

The three TUIs painted themselves through ConPTY exactly as they did through the POSIX pty: Welcome to
Claude Code v2.1.278, the OpenCode wordmark with Ask anything, and OpenAI Codex (v0.163.0) with Ask Codex
to do anything. The echo window shows the typed line and its result:
PS C:/Users/han> echo SELBSTLAUF_INPUT_OK, then SELBSTLAUF_INPUT_OK.

This also exercises the Windows argument path: the presets resolve to .ps1 shims on this machine, and the
launcher hands them to PowerShell through -EncodedCommand instead of passing a script path as a literal
argument. Those shims started and rendered, which is what that code path exists for.

Run it with node scripts/verify/agent-windows-conpty.mjs, or npm run verify:agent-windows:conpty.
It exits 2 off Windows rather than pretending to pass.

## The real desktop application

The two checks above drive the WebUI. The desktop app is a different process, and it is what actually ships,
so it was verified too: Electron 44.4.1 (win32-x64), the checkout build, launched by Playwright and driven
through its own window. apps/desktop/scripts/verify-agents-live.mjs starts the three presets from the
launcher dialog and asserts on what the window shows:

```
ok    the packaged desktop shell rendered its main window
ok    the preload bridge is wired
ok    claude: PID 31640 running C:/Users/han/AppData/Roaming/npm/claude.ps1
ok    claude: its own interface appeared inside the desktop window
ok    opencode: PID 13132 running C:/Users/han/AppData/Roaming/npm/opencode.ps1
ok    opencode: its own interface appeared inside the desktop window
ok    codex: PID 32024 running C:/Users/han/AppData/Roaming/npm/codex.ps1
ok    codex: its own interface appeared inside the desktop window
ok    the window owns a real TTY
ok    the process received both lines and its reply reached the window

desktop live verification: PASS
```

The screenshots are the app itself, under tmp/agent-window-verification/: electron-live-claude.png,
electron-live-opencode.png (the OpenCode wordmark, Ask anything, Build - Big Pickle, version 1.19.3),
electron-live-codex.png (OpenAI Codex v0.163.0), and electron-live-round-trip.png.

apps/desktop/scripts/verify-agents.mjs was run the same way and passed: native PTY, Unicode and multiline
input, output, the independent BrowserWindow, and continued input after that window closes.

The desktop app was also driven with --model, which asks the window to reverse a token. Input reaches the
TUI and Codex replies back into the window, but on this Windows host Codex is configured to use a
third-party gateway in ~/.codex/config.toml that answers with a malformed body, which Codex renders in
the window as an invalid-character error. That is the host configuration, not the window: the text was
delivered, the process answered, and the answer came back. The real model round-trip is demonstrated in
the WSL run above, where codex has working credentials.

Two environment traps had to be fixed before any of this could run, and both are handled in the scripts
rather than worked around by hand:

- ELECTRON_RUN_AS_NODE, inherited from a Node-based harness, makes Electron behave as a plain Node process.
  The app never starts and Playwright only reports "Process failed to launch!". The scripts delete it from
  the child environment.
- process.execPath is Electron inside the desktop app, not node. Using it to start the fixture launched the
  fixture in app mode, which exited 0 with no output. NODE_BIN now lets a harness supply a real node binary.

Running it needs a real Electron binary; ELECTRON_BIN points at one when the package cannot be resolved
from the module graph, because a runtime that exposes electron as a builtin resolves it to a namespace
instead of a path.

## What this run does not claim

- **Claude Code cannot reach its API on this machine.** The claude window paints
  `Welcome to Claude Code v2.1.278` and then
  `Failed to connect to api.anthropic.com: UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`. That is the
  environment's TLS interception, not the window: the process starts, its TUI renders, and its
  output reaches the browser. The real model round-trip is therefore demonstrated on Codex,
  which does have working credentials here (`~/.codex/auth.json`).
- **No window is captured for a process.** The desktop shell can preview and type into the
  window a *monitored* session runs in, but a window opened here is rendered by the app itself
  and needs no OS-level capture.
- **Electron was not launched under WSL.** It was launched on the Windows host instead, which is the
  platform it ships on; see "The real desktop application" above. The WSL image has no X server and is
  missing the shared libraries Electron links against, so the Linux desktop run is still not covered
  here. [agent-windows.md](../implementation/agent-windows.md) task 4 records the earlier Linux run.

## How to reproduce

```bash
npm run build
node scripts/verify/agent-windows-live.mjs              # includes the model round-trip
node scripts/verify/agent-windows-live.mjs --no-model   # UI + PTY round-trip only
```

```bash
# the real desktop app on Windows, with the real CLIs
node apps/desktop/scripts/verify-agents-live.mjs
```

That one needs a display and a real Electron binary. Set ELECTRON_BIN when the package cannot be
resolved, and NODE_BIN to a real node for the echo window. Both scripts exit non-zero on failure.

`--no-model` skips the step that spends real tokens. `--keep-state` keeps the throwaway state
directory for inspection. `SELBSTLAUF_LIVE_PORT` changes the port (default 49390).

## Running the app

```bash
npm run build && npm start     # service + WebUI on http://127.0.0.1:48920
```

`npm start` previously did not exist; the CLI workspace now has a `start` script
(`node dist/src/index.js`), which is what the service is.
