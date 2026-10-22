// Four-language behavior in actual Electron windows, with an isolated service/profile.
import { _electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.env.SELBSTLAUF_SETTINGS_ARTIFACTS ?? resolve(appRoot, '../../tmp/settings-verification-20261022/app/locale');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-locale-'));
const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
const preferencesPath = join(stateDirectory, 'desktop-settings.json');
const electronPath = process.env.ELECTRON_BIN ?? createRequire(import.meta.url)('electron');
const reservePort = createServer();
await new Promise((resolve) => reservePort.listen(0, '127.0.0.1', resolve));
const port = reservePort.address().port;
await new Promise((resolve, reject) => reservePort.close((error) => error ? reject(error) : resolve()));
const environment = { ...process.env, XDG_STATE_HOME: root, WATCHDOG_PORT: String(port) };
if (process.platform === 'win32') environment.LOCALAPPDATA = root;
else delete environment.LOCALAPPDATA;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_PATH;
const notes = [];
const evidence = [];
const pageErrors = [];
let desktop;
let page;
let child;
let agentId;
let mainWindowId;
let isolated = false;
await mkdir(artifacts, { recursive: true });
await mkdir(stateDirectory, { recursive: true });
await writeFile(preferencesPath, JSON.stringify({ closeToTray: true, preferredTerminal: 'system' }));
const check = (condition, label) => { if (!condition) throw new Error(label); notes.push(`PASS ${label}`); };
const mainWindow = (method, args = []) => desktop.evaluate(({ BrowserWindow }, data) => BrowserWindow.fromId(data.id)[data.method](...data.args), { id: mainWindowId, method, args });
const screenshot = (name) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
const launch = async () => {
  isolated = false;
  desktop = await _electron.launch({
    executablePath: electronPath,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--user-data-dir=${join(root, 'electron')}`, appRoot],
    env: environment, timeout: 60_000,
  });
  page = await desktop.firstWindow();
  mainWindowId = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(join(stateDirectory, 'watchdog.pid.json'), 'utf8')).pid; } catch { return null; }
  }, { timeout: 30_000 }).not.toBeNull();
  const record = JSON.parse(await readFile(join(stateDirectory, 'watchdog.pid.json'), 'utf8'));
  const actual = await desktop.evaluate(({ app }) => ({ pid: process.pid, localAppData: process.env.LOCALAPPDATA, stateHome: process.env.XDG_STATE_HOME, userData: app.getPath('userData'), version: app.getVersion(), electron: process.versions.electron }));
  check(record.pid === actual.pid && actual.userData === join(root, 'electron') && (process.platform === 'win32' ? actual.localAppData === root : actual.stateHome === root), 'the real main process owns the temporary service, state and profile');
  evidence.push({ process: actual, service: record });
  check(Number(record.port) === port && Number(record.port) !== Number(process.env.SELBSTLAUF_SETTINGS_USER_PORT ?? 48920), 'the verification service has its own explicitly selected origin');
  isolated = true;
  await expect(page.locator('.titlebar__menu-button')).toHaveCount(4, { timeout: 30_000 });
  await mainWindow('show');
  await mainWindow('focus');
  // Observe real Tray.setContextMenu calls while retaining Electron's method.
  await desktop.evaluate(({ Tray }) => {
    globalThis.localeTrayMenus = [];
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.localeTrayMenus.push(menu.items.filter((item) => item.type !== 'separator').map((item) => ({ label: item.label, checked: item.checked, type: item.type })));
      return original.call(this, menu);
    };
  });
};
const section = async (id) => {
  await desktop.evaluate(({ BrowserWindow }, data) => BrowserWindow.fromId(data.windowId).webContents.send('selbstlauf:command', { command: 'open-settings', section: data.section }), { windowId: mainWindowId, section: id });
  await expect(page.locator(`[data-section="${id}"][role="tab"]`)).toHaveAttribute('aria-selected', 'true');
};
const languageNames = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語' };
const chooseLocale = (locale) => page.getByRole('button', { name: languageNames[locale], exact: true }).click();
const setTheme = async (theme) => {
  await section('appearance');
  await page.locator('.theme-previews [role="radio"]').nth(theme === 'dark' ? 2 : 1).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};
try {
  await launch();
  const legacy = await page.evaluate(() => window.selbstlaufDesktop.settings.get());
  check(legacy.locale === 'zh-CN' && legacy.closeToTray === true && legacy.preferredTerminal === 'system', 'old preferences receive zh-CN without resetting the terminal or tray preference');
  // A real owned PTY and its separate app window exercise the production broadcast path.
  const response = await page.request.post(new URL('/api/agents', page.url()).href, {
    headers: { origin: new URL(page.url()).origin }, data: { tool: 'shell', cwd: root, title: 'Locale verification' },
  });
  check(response.ok(), 'the app service starts an owned shell for the independent viewer');
  agentId = (await response.json()).id;
  const opening = desktop.waitForEvent('window');
  await page.evaluate((id) => window.selbstlaufDesktop.shell.openAgentWindow(id), agentId);
  child = await opening;
  child.on('pageerror', (error) => pageErrors.push(String(error)));
  await expect(child.locator('html')).toHaveAttribute('lang', 'zh-CN');

  const languages = [
    { locale: 'en', menu: ['File', 'Edit', 'View', 'Help'], tray: ['Open main window', 'Settings', 'Start at login', 'About Selbstlauf', 'Quit'], copy: 'Copy', fullscreen: 'Toggle fullscreen', closed: 'That session is no longer running.' },
    { locale: 'zh-TW', menu: ['檔案', '編輯', '檢視', '說明'], tray: ['開啟主介面', '設定', '開機自動啟動', '關於 Selbstlauf', '結束'], copy: '複製', fullscreen: '切換全螢幕', closed: '該工作階段已停止執行。' },
    { locale: 'ja', menu: ['ファイル', '編集', '表示', 'ヘルプ'], tray: ['メイン画面を開く', '設定', 'ログイン時に起動', 'Selbstlauf について', '終了'], copy: 'コピー', fullscreen: '全画面表示を切り替え', closed: 'このセッションは終了しています。' },
    { locale: 'zh-CN', menu: ['文件', '编辑', '视图', '帮助'], tray: ['打开主界面', '设置', '开机自启', '关于 Selbstlauf', '退出'], copy: '复制', fullscreen: '切换全屏', closed: '该会话已不在运行。' },
  ];
  for (const language of languages) {
    await mainWindow('focus');
    await section('appearance');
    await chooseLocale(language.locale);
    await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
    await expect(child.locator('html')).toHaveAttribute('lang', language.locale);
    const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
    check(saved.locale === language.locale && saved.preferredTerminal === 'system', `${language.locale} UI selection is persisted and reaches the independent window`);
    const native = await desktop.evaluate(({ Menu }) => ({
      application: Menu.getApplicationMenu().items.map((item) => ({ label: item.label, submenu: item.submenu.items.map((entry) => ({ label: entry.label, role: entry.role, accelerator: entry.accelerator })) })),
      tray: globalThis.localeTrayMenus.at(-1),
    }));
    check(JSON.stringify(native.application.map((item) => item.label)) === JSON.stringify(language.menu), `${language.locale} rebuilds the real application Menu`);
    check(JSON.stringify(native.tray?.map((item) => item.label)) === JSON.stringify(language.tray), `${language.locale} installs the real native tray context menu`);
    const failure = await page.evaluate(() => window.selbstlaufDesktop.shell.openTerminal('gone'));
    check(failure.ok === false && failure.reason === language.closed, `${language.locale} terminal errors use the saved native language`);
    evidence.push({ ...language, saved, native, failure });
    await child.screenshot({ path: join(artifacts, `${language.locale}-independent-viewer.png`), fullPage: true });

    await mainWindow('setSize', [1440, 900]);
    await setTheme('dark');
    await screenshot(`${language.locale}-appearance-dark-1440`);
    await page.getByRole('button', { name: languageNames[language.locale], exact: true }).scrollIntoViewIfNeeded();
    await screenshot(`${language.locale}-language-control-dark-1440`);
    await section('profile');
    const input = page.locator('.settings-content input[type="text"], .settings-content input:not([type])').first();
    await input.fill(`COPY_${language.locale}`);
    await input.selectText();
    await page.locator('.titlebar__menu-button').nth(1).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${language.copy}`) }).click();
    await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(`COPY_${language.locale}`);
    check(true, `${language.locale} translated Copy performs the real clipboard action`);
    await page.locator('.titlebar__menu-button').nth(1).click();
    await screenshot(`${language.locale}-edit-menu-dark-1440`);
    await page.keyboard.press('Escape');
    await mainWindow('focus');
    await page.locator('.titlebar__menu-button').nth(2).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${language.fullscreen}`) }).click();
    await expect.poll(() => mainWindow('isFullScreen')).toBe(true);
    await screenshot(`${language.locale}-fullscreen-dark`);
    await page.evaluate(() => window.selbstlaufDesktop.shell.toggleFullScreen());
    await expect.poll(() => mainWindow('isFullScreen')).toBe(false);
    check(true, `${language.locale} translated fullscreen menu enters and leaves actual OS fullscreen`);
    await setTheme('light');
    await mainWindow('setSize', [1024, 768]);
    await screenshot(`${language.locale}-appearance-light-1024`);
    await mainWindow('setSize', [960, 800]);
    await page.getByRole('button', { name: languageNames[language.locale], exact: true }).scrollIntoViewIfNeeded();
    await screenshot(`${language.locale}-appearance-light-960`);
  }

  // An actual filesystem write failure must leave native and renderer language unchanged.
  await mainWindow('setSize', [1440, 900]);
  await section('appearance');
  await chooseLocale('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const backup = `${preferencesPath}.backup`;
  await rename(preferencesPath, backup);
  await mkdir(preferencesPath);
  try {
    await chooseLocale('ja');
    await expect(page.getByRole('status').filter({ hasText: /Could not save language/u })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(child.locator('html')).toHaveAttribute('lang', 'en');
    check((await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].label)) === 'File', 'a real rejected save keeps the previous native menu and all viewer languages');
    await screenshot('save-failure-preserves-english');
  } finally {
    await rm(preferencesPath, { recursive: true, force: true });
    await rename(backup, preferencesPath);
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  check(true, 'renderer reload restores the authoritative saved language');
  await page.request.post(new URL(`/api/agents/${agentId}/terminate`, page.url()).href, { headers: { origin: new URL(page.url()).origin } });
  agentId = undefined;
  await child.close(); child = undefined;
  await desktop.evaluate(({ app }) => app.exit(0));
  await desktop.close(); desktop = undefined;
  await launch();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  check((await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].label)) === 'File', 'a new main process restores the saved native menu language');
  await section('appearance');
  await screenshot('restart-restores-english');
  check(pageErrors.length === 0, `no renderer errors (${pageErrors.join('; ')})`);
} catch (error) {
  if (page && isolated) await screenshot('locale-failure').catch(() => undefined);
  notes.push(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (page && isolated && agentId && !page.isClosed()) await page.request.post(new URL(`/api/agents/${agentId}/terminate`, page.url()).href, { headers: { origin: new URL(page.url()).origin } }).catch(() => undefined);
  if (desktop && isolated) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await desktop.close().catch(() => undefined);
  }
  // Keep failed artifacts, while only removing state whose ownership was proven.
  await writeFile(join(artifacts, 'locale-verification.log'), `${notes.join('\n')}\n`);
  await writeFile(join(artifacts, 'locale-evidence.json'), JSON.stringify(evidence, null, 2));
  if (isolated) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
  process.stdout.write(`${notes.join('\n')}\n`);
}
