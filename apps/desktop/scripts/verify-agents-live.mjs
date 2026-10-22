// Exercises the real desktop app with the real agent CLIs installed on this machine.
//
// verify-agents.mjs proves the plumbing with a fixture process. This script proves the thing a person
// does: open the app, press 启动智能体, pick Claude / OpenCode / Codex, and watch that CLI's own interface
// appear in the window; then type into a real terminal and read the answer back.
//
// Usage: node apps/desktop/scripts/verify-agents-live.mjs
//   ELECTRON_BIN  path to electron(.exe) when it cannot be resolved from the package
//   NODE_BIN      a real node binary, used for the echo window (process.execPath is Electron here)
import { _electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '../..');
const artifacts = join(repositoryRoot, 'tmp', 'agent-window-verification');
await mkdir(artifacts, { recursive: true });

const electronPath = (() => {
  if (process.env.ELECTRON_BIN) return resolve(process.env.ELECTRON_BIN);
  const loaded = createRequire(import.meta.url)('electron');
  if (typeof loaded === 'string') return loaded;
  if (typeof loaded?.default === 'string') return loaded.default;
  throw new Error('could not resolve the Electron executable; set ELECTRON_BIN');
})();

const root = await mkdtemp(join(tmpdir(), 'selbstlauf-electron-live-'));
const environment = { ...process.env, LOCALAPPDATA: root, XDG_STATE_HOME: root };
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

const notes = [];
const failures = [];
const check = (condition, message) => {
  notes.push(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
  return condition;
};
const flat = (value) => value.replace(/\s+/gu, '');
const stripAnsi = (value) => value
  .replace(/\u001b\][^\u0007]*\u0007/gu, '')
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001b[@-Z\\-_]/gu, '')
  .replace(/\r/gu, '');

const banners = {
  claude: /Welcome to Claude Code|ClaudeCode/iu,
  opencode: /Ask anything|opencode/iu,
  codex: /OpenAI Codex|AskCodex/iu,
};

let desktop;
let page;
const created = [];
try {
  desktop = await _electron.launch({
    executablePath: electronPath,
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${join(root, 'electron')}`, appRoot,
    ],
    env: environment, timeout: 60_000,
  });
  page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); } });
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible({ timeout: 30_000 });
  check(true, 'the packaged desktop shell rendered its main window');
  check(await page.evaluate(() => typeof window.selbstlaufDesktop?.shell?.openAgentWindow) === 'function', 'the preload bridge is wired');

  const outputOf = async (id) => {
    const response = await page.request.get(new URL(`/api/agents/${id}/output`, page.url()).href);
    const body = await response.json().catch(() => null);
    return typeof body?.data === 'string' ? stripAnsi(body.data) : '';
  };
  const waitForOutput = async (id, pattern, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let seen = '';
    while (Date.now() < deadline) {
      seen = await outputOf(id);
      if (pattern.test(seen) || pattern.test(flat(seen))) return seen;
      await page.waitForTimeout(500);
    }
    return seen;
  };

  const startPreset = async (tool) => {
    const title = `${tool} 桌面`;
    await page.getByRole('button', { name: '启动智能体', exact: true }).click();
    await page.getByLabel('智能体', { exact: true }).selectOption(tool);
    await page.getByLabel('窗口名称（可选）').fill(title);
    const created_ = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const response = await created_;
    const session = await response.json();
    if (!check(response.status() === 201, `${tool}: the desktop app started a real process`)) {
      notes.push(`      service said: ${JSON.stringify(session).slice(0, 200)}`);
      return null;
    }
    created.push(session.id);
    check(session.pid > 0, `${tool}: PID ${session.pid} running ${session.command}`);
    await page.getByRole('tab', { name: title, exact: true }).click();
    return { id: session.id, title };
  };

  for (const tool of ['claude', 'opencode', 'codex']) {
    const session = await startPreset(tool);
    if (session === null) continue;
    const seen = await waitForOutput(session.id, banners[tool], 120_000);
    check(banners[tool].test(flat(seen)), `${tool}: its own interface appeared inside the desktop window`);
    notes.push(`      ${tool} first screen: ${flat(seen).slice(0, 120)}`);
    await page.screenshot({ path: join(artifacts, `electron-live-${tool}.png`), fullPage: true });
  }

  // Input/output through the window's own composer, on a real ConPTY.
  const nodeBinary = process.env.NODE_BIN;
  if (nodeBinary !== undefined) {
    await page.getByRole('button', { name: '启动智能体', exact: true }).click();
    await page.getByLabel('智能体', { exact: true }).selectOption('custom');
    if (!await page.getByLabel('启动命令', { exact: true }).isVisible()) await page.getByText('启动命令与参数', { exact: true }).click();
    await page.getByLabel('启动命令', { exact: true }).fill(nodeBinary);
    await page.getByLabel('额外启动参数（每行一个）').fill(resolve(repositoryRoot, 'apps/cli/dist/test/fixtures/agent-terminal.js'));
    await page.getByLabel('窗口名称（可选）').fill('桌面往返');
    const launched = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const session = await (await launched).json();
    created.push(session.id);
    await page.getByRole('tab', { name: '桌面往返', exact: true }).click();
    const ready = await waitForOutput(session.id, /READY/iu, 30_000);
    check(/"tty":true/u.test(ready), 'the window owns a real TTY');
    await page.getByLabel('发送到 桌面往返 的内容').fill('桌面输入 第一行\n桌面输入 第二行');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const replied = await waitForOutput(session.id, /REPLY 桌面输入 第二行/u, 30_000);
    check(/REPLY 桌面输入 第二行/u.test(replied), 'the process received both lines and its reply reached the window');
    await page.screenshot({ path: join(artifacts, 'electron-live-round-trip.png'), fullPage: true });
  }
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'electron-live-failure.png'), fullPage: true }).catch(() => undefined);
  notes.push(`FAIL  the run threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  failures.push(String(error));
} finally {
  for (const id of created) {
    if (page) {
      const origin = new URL(page.url()).origin;
      await page.request.post(new URL(`/api/agents/${id}/terminate`, page.url()).href, { headers: { origin } }).catch(() => undefined);
      await page.request.delete(new URL(`/api/agents/${id}`, page.url()).href, { headers: { origin } }).catch(() => undefined);
    }
  }
  if (desktop) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await desktop.close().catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${notes.join('\n')}\n`);
  process.stdout.write(failures.length === 0 ? '\ndesktop live verification: PASS\n' : `\n${failures.length} failure(s)\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}