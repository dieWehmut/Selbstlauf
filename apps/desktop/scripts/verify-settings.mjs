// Real Electron settings and menu behavior. Run through scripts/verify/in-conda.sh.
import { _electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '../..');
const artifacts = process.env.SELBSTLAUF_SETTINGS_ARTIFACTS ?? join(repositoryRoot, 'tmp/settings-verification-20261022/app');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-settings-'));
await mkdir(artifacts, { recursive: true });
const electronPath = process.env.ELECTRON_BIN ?? createRequire(import.meta.url)('electron');
const environment = { ...process.env, XDG_STATE_HOME: root };
if (process.platform === 'win32') environment.LOCALAPPDATA = root;
else delete environment.LOCALAPPDATA;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_PATH;
const notes = [];
const pageErrors = [];
let desktop;
let page;
let agentId;
let externalPids = [];
const menuOnly = process.argv.includes('--menu-only');
const check = (condition, label) => { if (!condition) throw new Error(label); notes.push(`PASS ${label}`); };
const screenshot = async (name) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
const mainWindow = (callback, argument) => desktop.evaluate(({ BrowserWindow }, data) => {
  const window = BrowserWindow.getAllWindows()[0];
  return window[data.method](...(data.args ?? []));
}, { method: callback, args: argument });
const openSection = async (name) => {
  await page.getByRole('heading', { name: /进程监控|Watchdog 设置/u }).first().waitFor();
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+,');
  if (!await page.getByRole('tablist', { name: '设置分区' }).isVisible()) {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('selbstlauf:command', { command: 'open-settings' }));
  }
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name, exact: true }).click();
};
try {
  desktop = await _electron.launch({
    executablePath: electronPath,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--user-data-dir=${join(root, 'electron')}`, appRoot],
    env: environment, timeout: 60_000,
  });
  page = await desktop.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await mainWindow('show');
  await mainWindow('focus');
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible({ timeout: 30_000 });
  check(await page.evaluate(() => typeof window.selbstlaufDesktop?.settings?.onChange) === 'function', 'preload exposes live settings subscriptions');
  await openSection('个人资料');
  const input = page.getByLabel('显示名称');
  await input.fill('COPY_FROM_REAL_DESKTOP');
  await input.selectText();
  await page.locator('.titlebar__menu-button').getByText('编辑', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^复制/u }).click();
  await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('COPY_FROM_REAL_DESKTOP');
  check(true, 'renderer Copy reaches the real Electron clipboard');
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('PASTED_BY_REAL_DESKTOP_MENU'));
  await input.selectText();
  await page.locator('.titlebar__menu-button').getByText('编辑', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^粘贴/u }).click();
  await expect(input).toHaveValue('PASTED_BY_REAL_DESKTOP_MENU');
  check(true, 'renderer Paste changes the actual settings input');
  await screenshot('01-menu-edit-dark');

  await page.locator('.titlebar__menu-button').getByText('视图', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^放大/u }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(1);
  await screenshot('01-menu-zoom-dark');
  await page.locator('.titlebar__menu-button').getByText('视图', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^实际大小/u }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(0);
  check(true, 'renderer zoom increases then returns to actual size');
  await page.locator('.titlebar__menu-button').getByText('视图', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^切换全屏/u }).click();
  await expect.poll(() => mainWindow('isFullScreen')).toBe(true);
  await screenshot('01-menu-fullscreen-dark');
  await page.evaluate(() => window.selbstlaufDesktop.shell.toggleFullScreen());
  await expect.poll(() => mainWindow('isFullScreen')).toBe(false);
  check(true, 'renderer fullscreen enters and leaves actual OS fullscreen');
  await openSection('外观');
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await mainWindow('setSize', [1024, 768]);
  await screenshot('01-menu-appearance-light-1024');
  if (!menuOnly) {
    await openSection('启动与托盘');
    await expect(page.getByLabel('首选终端')).toBeEnabled();
    await page.getByLabel('首选终端').selectOption(process.platform === 'win32' ? 'powershell' : 'xterm');
    const selected = process.platform === 'win32' ? 'powershell' : 'xterm';
    await expect.poll(() => page.evaluate(() => window.selbstlaufDesktop.settings.get())).toMatchObject({ preferredTerminal: selected });
    await screenshot('02-startup-preference-light-1024');
    await mainWindow('setSize', [1440, 900]);
    await openSection('外观');
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await openSection('启动与托盘');
    await screenshot('02-startup-preference-dark-1440');
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await page.getByRole('button', { name: '启动智能体', exact: true }).click();
    await page.getByLabel('智能体', { exact: true }).selectOption('shell');
    const workDirectory = join(root, 'terminal cwd 项目 空格');
    await mkdir(workDirectory, { recursive: true });
    await page.getByLabel('工作目录', { exact: true }).fill(workDirectory);
    await page.getByLabel('窗口名称（可选）').fill('设置终端验证');
    const launched = page.waitForResponse((response) => response.url().endsWith('/api/agents') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '启动', exact: true }).click();
    agentId = (await (await launched).json()).id;
    await page.getByRole('tab', { name: '设置终端验证', exact: true }).click();
    await expect(page.getByRole('button', { name: '独立窗口', exact: true })).toBeVisible();
    const opened = desktop.waitForEvent('window');
    await page.getByRole('button', { name: '独立窗口', exact: true }).click();
    const child = await opened;
    await expect(child.getByRole('tabpanel').getByText('终端已连接', { exact: true })).toBeVisible();
    const received = child.evaluate(() => new Promise((resolve) => {
      const unsubscribe = window.selbstlaufDesktop.settings.onChange((prefs) => { unsubscribe(); resolve(prefs); });
    }));
    await page.evaluate(() => window.selbstlaufDesktop.settings.set({ closeToTray: false }));
    check((await received).closeToTray === false, 'independent viewer receives confirmed settings changes');
    await child.screenshot({ path: join(artifacts, '02-settings-independent-viewer.png'), fullPage: true });
    await child.close();
    if (process.platform === 'win32') {
      const run = promisify(execFile);
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const list = async () => {
        const payload = JSON.parse((await run(powershell, ['-NoLogo', '-NoProfile', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -like "*-NoExit*" } | ForEach-Object { @{ Id = $_.ProcessId } }) | ConvertTo-Json -Compress'], { encoding: 'utf8' })).stdout || '[]');
        return Array.isArray(payload) ? payload : [payload];
      };
      const before = new Set((await list()).map((entry) => entry.Id));
      const result = await page.evaluate((id) => window.selbstlaufDesktop.shell.openTerminal(id), agentId);
      check(result.ok && result.terminal === 'powershell', `saved preference launches a real PowerShell (${JSON.stringify(result)})`);
      await expect.poll(async () => { externalPids = (await list()).filter((entry) => !before.has(entry.Id)).map((entry) => entry.Id); return externalPids.length; }, { timeout: 15_000 }).toBeGreaterThan(0);
      const terminal = externalPids[0];
      // Read the real process environment block. Windows 11's delegated console
      // host owns the window, so PowerShell itself can have MainWindowHandle=0.
      const processes = await run(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(repositoryRoot, 'apps/cli/src/process/windows-processes.ps1'), '-IncludeProcessId', String(terminal)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const terminalProcess = JSON.parse(processes.stdout).find((entry) => entry.pid === terminal);
      check(terminalProcess?.workingDirectory?.replace(/[\\/]$/u, '') === workDirectory.replace(/[\\/]$/u, ''), `real PowerShell PID ${terminal} has the service-resolved Unicode directory (${terminalProcess?.workingDirectory})`);
      await screenshot('02-terminal-preference-real-spawn');
    }
    await page.evaluate(() => window.selbstlaufDesktop.settings.set({ closeToTray: true }));
    await mainWindow('close');
    await expect.poll(() => mainWindow('isVisible')).toBe(false);
    check(true, 'close-to-tray keeps the actual main window alive and hidden');
    await mainWindow('show');
    await mainWindow('focus');
    await screenshot('02-close-to-tray-restored');
    await page.evaluate(() => window.selbstlaufDesktop.settings.set({ closeToTray: false }));
    const exit = new Promise((resolve) => desktop.process().once('exit', resolve));
    await mainWindow('close');
    await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('close-to-tray off did not quit')), 15_000))]);
    check(true, 'turning close-to-tray off makes closing quit the actual app');
  }
  check(pageErrors.length === 0, `no renderer errors (${pageErrors.join('; ')})`);
} catch (error) {
  if (page) await screenshot('settings-failure').catch(() => undefined);
  notes.push(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (page && agentId && !page.isClosed()) await page.request.post(new URL(`/api/agents/${agentId}/terminate`, page.url()).href, { headers: { origin: new URL(page.url()).origin } }).catch(() => undefined);
  if (process.platform === 'win32' && externalPids.length) {
    await promisify(execFile)('taskkill.exe', ['/PID', String(externalPids[0]), '/T', '/F']).catch(() => undefined);
  }
  if (desktop) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await desktop.close().catch(() => undefined);
  }
  await writeFile(join(artifacts, menuOnly ? '01-menu-verification.log' : '02-settings-verification.log'), `${notes.join('\n')}\n`, 'utf8');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
  process.stdout.write(`${notes.join('\n')}\n`);
}
