// Exercises the real Electron main process, native PTY, renderer bridge and independent BrowserWindow.
import { _electron, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '../..');
const artifacts = join(repositoryRoot, 'tmp', 'agent-window-verification');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-electron-agent-'));
const packaged = process.env.SELBSTLAUF_PACKAGED_EXECUTABLE;
// ELECTRON_BIN lets a harness point at a specific binary; otherwise resolve the package.
// The package is CommonJS, so require() returns the path string; import() can hand back the
// module namespace instead (and a runtime that exposes electron as a builtin returns neither).
const electronPath = (() => {
  if (process.env.ELECTRON_BIN) return resolve(process.env.ELECTRON_BIN);
  const loaded = createRequire(import.meta.url)('electron');
  if (typeof loaded === 'string') return loaded;
  if (typeof loaded?.default === 'string') return loaded.default;
  throw new Error('could not resolve the Electron executable; set ELECTRON_BIN');
})();
let executable = packaged === undefined ? electronPath : resolve(packaged);
if (packaged !== undefined) {
  // An installed service must not accidentally resolve dependencies from the repository's node_modules.
  const installed = join(root, 'installed');
  await cp(dirname(executable), installed, { recursive: true });
  executable = join(installed, basename(executable));
}
const environment = { ...process.env, LOCALAPPDATA: root, XDG_STATE_HOME: root };
delete environment.NODE_PATH;
// Inherited from a Node-based harness, this makes Electron run as a plain Node process, so the
// app never starts and Playwright reports only "Process failed to launch!".
delete environment.ELECTRON_RUN_AS_NODE;
let desktop;
let page;
let id;
let stderr = '';
try {
  desktop = await _electron.launch({
    executablePath: executable,
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${join(root, 'electron')}`, ...(packaged === undefined ? [appRoot] : []),
    ],
    env: environment, timeout: 30000,
  });
  desktop.process().stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-4000); });
  page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); } });
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
  expect(await page.evaluate(() => typeof window.selbstlaufDesktop?.shell?.openAgentWindow)).toBe('function');
  await page.getByRole('button', { name: '启动智能体', exact: true }).click();
  await page.getByLabel('智能体', { exact: true }).selectOption('custom');
  if (!await page.getByLabel('启动命令', { exact: true }).isVisible()) await page.getByText('启动命令与参数', { exact: true }).click();
  // process.execPath is Electron here, not node: it would start the fixture in app mode and exit
  // silently. NODE_BIN lets a harness supply a real node; the checkout path is the fallback.
  const nodeBinary = process.env.NODE_BIN ?? process.execPath;
  await page.getByLabel('启动命令', { exact: true }).fill(nodeBinary);
  await page.getByLabel('额外启动参数（每行一个）').fill(resolve(repositoryRoot, 'apps/cli/dist/test/fixtures/agent-terminal.js'));
  await page.getByLabel('窗口名称（可选）').fill('Electron 真实终端');
  const launched = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '启动', exact: true }).click();
  const result = await launched;
  expect(result.status()).toBe(201); id = (await result.json()).id;
  const output = async () => (await (await page.request.get(new URL(`/api/agents/${id}/output`, page.url()).href)).json()).data;
  await expect.poll(output).toContain('"tty":true');
  await page.getByLabel('发送到 Electron 真实终端 的内容').fill('Electron 主窗口输入\n中文第二行');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(output).toContain('REPLY 中文第二行');
  const opened = desktop.waitForEvent('window');
  await page.getByRole('button', { name: '独立窗口', exact: true }).click();
  const child = await opened;
  await expect(child.getByRole('tabpanel').getByText('终端已连接', { exact: true })).toBeVisible();
  await child.getByLabel('发送到 Electron 真实终端 的内容').fill('Electron 独立窗口输入');
  await child.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(output).toContain('REPLY Electron 独立窗口输入');
  await child.close();
  await page.getByLabel('发送到 Electron 真实终端 的内容').fill('子窗口关闭后继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(output).toContain('REPLY 子窗口关闭后继续');
  await page.screenshot({ path: join(artifacts, packaged === undefined ? 'desktop-terminal.png' : 'packaged-desktop-terminal.png'), fullPage: true });
  process.stdout.write(`Electron ${packaged === undefined ? 'checkout' : 'packaged'}: native PTY, Unicode/multiline input, output and child window passed\n`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'desktop-failure.png'), fullPage: true }).catch(() => undefined);
  process.stderr.write(stderr);
  throw error;
} finally {
  if (page && id) await page.request.post(new URL(`/api/agents/${id}/terminate`, page.url()).href, { headers: { origin: new URL(page.url()).origin } }).catch(() => undefined);
  if (desktop) {
    // Bypass hide-to-tray only for test teardown; the test-owned PTY was terminated above.
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await desktop.close().catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
}
