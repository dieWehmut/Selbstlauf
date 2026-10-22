// Live proof: a real browser drives the real service, which owns real PTYs running the real agent CLIs.
//
// The fixture-based browser suite proves the terminal protocol deterministically. This script proves the
// thing a person actually does: open the page, press 启动智能体, pick Claude / OpenCode / Codex, and see that
// CLI's own TUI in the window; then type into the composer and get the process's output back.
//
// Usage: node scripts/verify/agent-windows-live.mjs [--no-model] [--keep-state]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(repositoryRoot, 'tmp', 'agent-window-verification');
const stateRoot = await mkdtemp(join(tmpdir(), 'selbstlauf-live-'));
const port = Number(process.env.SELBSTLAUF_LIVE_PORT ?? 49390);
const origin = `http://127.0.0.1:${port}`;
const modelRoundTrip = !process.argv.includes('--no-model');
const failures = [];
const notes = [];
const check = (condition, message) => {
  notes.push(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
  return condition;
};

const service = spawn(process.execPath, [join(repositoryRoot, 'apps/cli/dist/src/index.js')], {
  cwd: repositoryRoot,
  env: { ...process.env, WATCHDOG_PORT: String(port), XDG_STATE_HOME: join(stateRoot, 'state'), LOCALAPPDATA: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceLog = '';
service.stdout.on('data', (data) => { serviceLog += String(data); });
service.stderr.on('data', (data) => { serviceLog += String(data); });

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`service did not answer on ${origin}: ${serviceLog}`);
}

const flat = (value) => value.replace(/\s+/gu, '');
const stripAnsi = (value) => value
  .replace(/\u001b\][^\u0007]*\u0007/gu, '')
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001b[@-Z\\-_]/gu, '')
  .replace(/\r/gu, '');

let browser;
const launched = [];
const results = {};
try {
  const health = await waitForHealth();
  check(health.ok === true, 'the service is up on the loopback origin');
  const catalog = await (await fetch(`${origin}/api/agents/catalog`)).json();
  const available = Object.fromEntries(catalog.tools.map((tool) => [tool.id, tool]));
  for (const tool of ['claude', 'opencode', 'codex']) {
    check(available[tool]?.available === true, `${tool} is discoverable on PATH (${available[tool]?.command ?? 'missing'})`);
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await expectVisible(page.getByRole('heading', { name: '进程监控', exact: true }), 'the app shell renders');

  const outputOf = async (id) => {
    const response = await page.request.get(`${origin}/api/agents/${id}/output`);
    const body = await response.json().catch(() => null);
    return typeof body?.data === 'string' ? stripAnsi(body.data) : `<no output: HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}>`;
  };
  const waitForOutput = async (id, pattern, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let seen = '';
    while (Date.now() < deadline) {
      seen = await outputOf(id);
      if (pattern.test(seen) || pattern.test(flat(seen))) return seen;
      await page.waitForTimeout(400);
    }
    return seen;
  };
  const launch = async ({ tool, title, command, args }) => {
    await page.getByRole('button', { name: '启动智能体', exact: true }).click();
    await expectVisible(page.getByLabel('智能体', { exact: true }), `the launcher opens for ${title}`);
    await page.getByLabel('智能体', { exact: true }).selectOption(tool);
    if (command !== undefined) {
      if (!(await page.getByLabel('启动命令', { exact: true }).isVisible())) await page.getByText('启动命令与参数', { exact: true }).click();
      await page.getByLabel('启动命令', { exact: true }).fill(command);
    }
    if (args !== undefined) await page.getByLabel('额外启动参数（每行一个）').fill(args.join('\n'));
    await page.getByLabel('窗口名称（可选）').fill(title);
    const created = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const response = await created;
    const session = await response.json();
    if (!check(response.status() === 201, `${title}: the service started a real process`)) {
      notes.push(`      service said: ${JSON.stringify(session)}`);
      return null;
    }
    launched.push(session.id);
    check(session.pid > 0 && typeof session.command === 'string', `${title}: PID ${session.pid} running ${session.command}`);
    await page.getByRole('tab', { name: title, exact: true }).click();
    await expectVisible(page.getByRole('tabpanel').getByText('终端已连接', { exact: true }), `${title}: the window is connected`);
    return session;
  };

  // The three presets, started exactly as a person starts them: pick the tool, name the window, press 启动.
  const banners = {
    claude: /WelcometoClaudeCode|ClaudeCode|claude/iu,
    opencode: /Askanything|opencode/iu,
    codex: /AskCodex|OpenCodex|codex/iu,
  };
  for (const tool of ['claude', 'opencode', 'codex']) {
    const title = `${tool} 真实 CLI`;
    const session = await launch({ tool, title });
    if (session === null) continue;
    const seen = await waitForOutput(session.id, banners[tool], 90_000);
    results[tool] = seen;
    check(banners[tool].test(flat(seen)), `${tool}: its own TUI reached the browser window`);
    notes.push(`      ${tool} first screen: ${seen.replace(/\s+/gu, ' ').trim().slice(0, 200)}`);
    await page.screenshot({ path: join(artifacts, `live-${tool}-window.png`), fullPage: true });
  }

  // Input/output round trip through the window's own composer, against a real TTY.
  const fixture = join(repositoryRoot, 'apps/cli/dist/test/fixtures/agent-terminal.js');
  const roundTrip = await launch({ tool: 'custom', title: '往返验证窗口', command: process.execPath, args: [fixture] });
  if (roundTrip !== null) {
    const ready = await waitForOutput(roundTrip.id, /READY/iu, 30_000);
    check(/"tty":true/u.test(ready), 'the round-trip window owns a real TTY');
    await page.getByLabel('发送到 往返验证窗口 的内容').fill('窗口输入 中文第一行\n窗口输入 中文第二行');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const replied = await waitForOutput(roundTrip.id, /REPLY 窗口输入 中文第二行/u, 20_000);
    check(/REPLY 窗口输入 中文第二行/u.test(replied), 'the process received both lines and its reply reached the window');
    const tree = page.getByRole('tabpanel').locator('.xterm-accessibility-tree');
    let rendered = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rendered = await tree.innerText().catch(() => '');
      if (rendered.includes('REPLY 窗口输入 中文第二行')) break;
      await page.waitForTimeout(200);
    }
    check(rendered.includes('REPLY 窗口输入 中文第二行'), 'xterm rendered that reply on screen');
    if (!rendered.includes('REPLY 窗口输入 中文第二行')) notes.push(`      terminal text: ${rendered.slice(-300).replace(/\s+/gu, ' ')}`);
    await page.screenshot({ path: join(artifacts, 'live-round-trip.png'), fullPage: true });
  }

  // A real model answer, not an echo: the codex TUI is driven through the same composer.
  const codexSession = launched.find((id) => results.codex !== undefined && true) && launched[2];
  if (modelRoundTrip && results.codex !== undefined && codexSession !== undefined) {
    await page.getByRole('tab', { name: 'codex 真实 CLI', exact: true }).click();
    await page.getByLabel('发送到 codex 真实 CLI 的内容').fill('Reply with exactly SELBSTLAUF_WINDOW_OK and nothing else.');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    // The prompt itself contains the marker, and the TUI echoes it, so one occurrence proves nothing.
    // A real answer is a second, independent occurrence after the echoed prompt.
    const marker = 'SELBSTLAUF_WINDOW_OK';
    const deadline = Date.now() + 240_000;
    let seen = '';
    let answered = false;
    while (Date.now() < deadline) {
      seen = await outputOf(codexSession);
      const flatSeen = flat(seen);
      const first = flatSeen.indexOf(marker);
      if (first >= 0 && flatSeen.indexOf(marker, first + marker.length) >= 0) { answered = true; break; }
      await page.waitForTimeout(2_000);
    }
    check(answered, 'codex answered a prompt typed into the window (real model round-trip, not the echoed prompt)');
    notes.push(`      marker occurrences: ${flat(seen).split(marker).length - 1}`);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(artifacts, 'live-codex-model.png'), fullPage: true });
  }

  check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
} catch (error) {
  notes.push(`FAIL  the run threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  failures.push(String(error));
} finally {
  for (const id of launched) {
    await fetch(`${origin}/api/agents/${encodeURIComponent(id)}/terminate`, { method: 'POST', headers: { origin } }).catch(() => undefined);
    await fetch(`${origin}/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { origin } }).catch(() => undefined);
  }
  if (browser) await browser.close().catch(() => undefined);
  service.kill('SIGTERM');
  await new Promise((done) => { const timer = setTimeout(done, 5_000); service.once('exit', () => { clearTimeout(timer); done(); }); });
  if (!process.argv.includes('--keep-state')) await rm(stateRoot, { recursive: true, force: true });
  process.stdout.write(`${notes.join('\n')}\n`);
  process.stdout.write(failures.length === 0 ? '\nagent windows live verification: PASS\n' : `\n${failures.length} failure(s)\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

async function expectVisible(locator, what) {
  try { await locator.waitFor({ state: 'visible', timeout: 20_000 }); check(true, what); }
  catch { check(false, what); }
}