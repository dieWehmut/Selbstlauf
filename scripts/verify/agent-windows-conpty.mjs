// Windows-native verification: the real service on ConPTY, the real agent CLIs, real input and output.

// The WSL script (agent-windows-live.mjs) proves the browser path. This one proves the platform the
// desktop app actually ships on: Windows, where node-pty talks to ConPTY instead of a POSIX pty.
// It drives the same REST surface the WebUI drives, so a pass here means the window page works.
//
// Requires a Windows host with node on PATH. No browser needed.
// Usage: node scripts/verify/agent-windows-conpty.mjs [--tool=claude,opencode,codex]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.SELBSTLAUF_CONPTY_PORT ?? 49395);
const origin = `http://127.0.0.1:${port}`;
const stateRoot = mkdtempSync(join(tmpdir(), 'selbstlauf-conpty-'));
const requested = process.argv.find((argument) => argument.startsWith('--tool='));
const tools = requested === undefined ? ['claude', 'opencode', 'codex'] : requested.slice('--tool='.length).split(',').filter(Boolean);

const notes = [];
const failures = [];
const check = (condition, message) => {
  notes.push(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
  return condition;
};

const stripAnsi = (value) => value
  .replace(/\u001b\][^\u0007]*\u0007/gu, '')
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001b[@-Z\\-_]/gu, '')
  .replace(/\r/gu, '');
const flat = (value) => value.replace(/\s+/gu, '');

if (process.platform !== 'win32') {
  console.error('this check only runs on Windows: it verifies the ConPTY path');
  process.exit(2);
}

const service = spawn(process.execPath, [join(repositoryRoot, 'apps/cli/dist/src/index.js')], {
  cwd: repositoryRoot,
  env: { ...process.env, WATCHDOG_PORT: String(port), LOCALAPPDATA: join(stateRoot, 'appdata'), XDG_STATE_HOME: join(stateRoot, 'state') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceLog = '';
service.stdout.on('data', (data) => { serviceLog += String(data); });
service.stderr.on('data', (data) => { serviceLog += String(data); });

async function waitForHealth(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`the service did not start on ${origin}: ${serviceLog}`);
}

async function api(path, init) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin, ...init?.headers },
  });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: response.status, json, body };
}

const readOutput = async (id) => {
  const response = await api(`/api/agents/${encodeURIComponent(id)}/output`);
  return typeof response.json?.data === 'string' ? stripAnsi(response.json.data) : `<no output: HTTP ${response.status}>`;
};

async function waitForOutput(id, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = await readOutput(id);
    if (pattern.test(seen) || pattern.test(flat(seen))) return seen;
    await new Promise((done) => setTimeout(done, 500));
  }
  return seen;
}

const banners = {
  claude: /Welcome to Claude Code|ClaudeCode/iu,
  opencode: /Ask anything|opencode/iu,
  codex: /OpenAI Codex|AskCodex/iu,
};

const created = [];
try {
  const health = await waitForHealth();
  check(health.ok === true, 'the service runs natively on Windows (ConPTY host)');

  const catalog = await api('/api/agents/catalog');
  check(catalog.status === 200, 'the catalog endpoint answers');
  const available = Object.fromEntries((catalog.json?.tools ?? []).map((tool) => [tool.id, tool]));
  for (const tool of tools) {
    check(available[tool]?.available === true, `${tool} is discoverable on the Windows PATH (${available[tool]?.command ?? 'missing'})`);
  }

  for (const tool of tools) {
    if (available[tool]?.available !== true) continue;
    const launched = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ tool, title: `${tool} ConPTY`, cwd: process.env.USERPROFILE }),
    });
    if (!check(launched.status === 201, `${tool}: the service started a real Windows process`)) {
      notes.push(`      service said: ${launched.body.slice(0, 300)}`);
      continue;
    }
    created.push(launched.json.id);
    check(launched.json.pid > 0, `${tool}: PID ${launched.json.pid} running ${launched.json.command}`);
    const seen = await waitForOutput(launched.json.id, banners[tool], 120_000);
    check(banners[tool].test(flat(seen)), `${tool}: its own TUI reached the output stream`);
    notes.push(`      ${tool} first screen: ${flat(seen).slice(0, 140)}`);
  }

  // Input round trip on a real ConPTY. The command line echoes what was typed and then prints the
  // result, so the marker must appear at least twice; once would only prove the echo.
  const shell = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ tool: 'shell', title: 'ConPTY echo', cwd: process.env.USERPROFILE }),
  });
  if (check(shell.status === 201, 'a shell window started on ConPTY')) {
    created.push(shell.json.id);
    await waitForOutput(shell.json.id, /[$>#]/, 20_000);
    const marker = 'SELBSTLAUF_INPUT_OK';
    await api(`/api/agents/${encodeURIComponent(shell.json.id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: `echo ${marker}\r` }),
    });
    const seen = await waitForOutput(shell.json.id, new RegExp(`${marker}[\\s\\S]*${marker}`, 'u'), 20_000);
    const occurrences = flat(seen).split(marker).length - 1;
    check(occurrences >= 2, `typed text reached the process and its output came back (${occurrences} occurrences)`);
    notes.push(`      ${flat(seen).slice(-160)}`);
  }
} catch (error) {
  notes.push(`FAIL  the run threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  failures.push(String(error));
} finally {
  for (const id of created) {
    await api(`/api/agents/${encodeURIComponent(id)}/terminate`, { method: 'POST' }).catch(() => undefined);
    await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  }
  service.kill();
  await new Promise((done) => setTimeout(done, 1_500));
  if (existsSync(stateRoot)) { try { rmSync(stateRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.stdout.write(`${notes.join('\n')}\n`);
  process.stdout.write(failures.length === 0 ? '\nwindows ConPTY verification: PASS\n' : `\n${failures.length} failure(s)\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}