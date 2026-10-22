// Exercise the production UI and HTTP config boundary with disposable WSL
// probes and real SQLite snapshots. No installed distribution is contacted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = resolve(process.env.WSL_VERIFY_CLI_DIRECTORY ?? join(repository, 'tmp/wsl-settings-testbuild'));
const web = resolve(process.env.WSL_VERIFY_WEB_DIRECTORY ?? join(repository, 'apps/web/dist'));
const artifacts = join(repository, 'tmp/settings-verification-20261022/webui/05-wsl-distribution');
const moduleAt = (path) => import(pathToFileURL(join(compiled, 'src', path)).href);
const [{ defaultConfig }, { AppServerClient }, { CodexAdapter }, { snapshotWslCodexState }, { WatchdogController }, { WatchdogHttpServer }, { ConfigStore }, { AuditStore }, { CodexConfigProfiles }] = await Promise.all([
  moduleAt('domain/config.js'), moduleAt('codex/app-server.js'), moduleAt('codex/codex-adapter.js'), moduleAt('codex/wsl-state.js'),
  moduleAt('runtime/watchdog-controller.js'), moduleAt('server/http-server.js'), moduleAt('store/config-store.js'), moduleAt('store/audit-store.js'), moduleAt('codex/profile-store.js'),
]);
const scratch = await mkdtemp(join(tmpdir(), 'selbstlauf-wsl-settings-'));
const screenshots = [];
const notes = [];
const evidence = [];
let browser;
let context;
let controller;
let service;
let appServerStarts = 0;
let inputWrites = 0;
const originals = { initialize: AppServerClient.prototype.initialize, queuePrompt: AppServerClient.prototype.queuePrompt, startTurn: AppServerClient.prototype.startTurn, close: CodexAdapter.prototype.close };
AppServerClient.prototype.initialize = async function () { appServerStarts += 1; throw new Error('WSL verifier must not launch an App Server'); };
AppServerClient.prototype.queuePrompt = async function () { inputWrites += 1; throw new Error('WSL verifier must not write a prompt'); };
AppServerClient.prototype.startTurn = async function () { inputWrites += 1; throw new Error('WSL verifier must not start a turn'); };
let closeCount = 0;
CodexAdapter.prototype.close = function () { closeCount += 1; return originals.close.call(this); };

function stateDatabase(directory, id, cwd) {
  const path = join(directory, 'state_5.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  database.prepare('INSERT INTO threads VALUES (?, ?, NULL, 1000, 2000)').run(id, cwd);
  database.close();
  return path;
}
async function select(page, name) {
  const drawer = page.locator('.sidebar--settings');
  if (page.viewportSize().width <= 960 && !await drawer.evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  }
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name, exact: true }).click();
  await expect(page.locator('.settings-content h2').first()).toBeVisible();
}
async function capture(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const path = join(artifacts, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
}
async function saveDistribution(page, value) {
  const input = page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true });
  await input.fill(value);
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).wslDistribution, value);
  await expect(input).toHaveValue(value);
}
async function overview(page) {
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/sessions') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  assert.equal((await refreshed).status(), 200);
}
async function general(page) {
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Watchdog 设置', exact: true })).toBeVisible();
  await select(page, '常规');
}
async function showThread(page, id) {
  if (page.viewportSize().width > 960) {
    await expect(page.locator('.workspace').getByText(id, { exact: true })).toBeVisible();
    return;
  }
  // The mobile process cards omit IDs; its actual sidebar process list exposes
  // the associated conversation alongside the distribution and process title.
  await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await expect(page.locator('.sidebar-row__conversation').filter({ hasText: id })).toBeVisible();
}
async function closeDrawer(page) {
  const close = page.locator('#watchdog-sidebar').getByRole('button', { name: '关闭菜单', exact: true });
  if (await close.isVisible()) await close.click();
}

try {
  await mkdir(artifacts, { recursive: true });
  await rm(join(artifacts, 'failure.txt'), { force: true });
  await rm(join(artifacts, 'failure.png'), { force: true });
  const indexHtml = await readFile(join(web, 'index.html'), 'utf8');
  notes.push(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}; web ${web}`);
  browser = await chromium.launch();
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    const label = `${theme}-${width}`;
    const root = join(scratch, label);
    const sources = { 'Fixture-A': join(root, 'A'), 'Fixture-B': join(root, 'B') };
    const native = join(root, 'native');
    for (const path of [...Object.values(sources), native]) await mkdir(path, { recursive: true });
    stateDatabase(sources['Fixture-A'], 'thread-A', '/work/project');
    stateDatabase(sources['Fixture-B'], 'thread-B', '/work/project');
    const nativePath = stateDatabase(native, 'thread-native', '/native/project');
    const configStore = new ConfigStore(join(root, 'config.json'));
    const auditStore = new AuditStore(join(root, 'audit.jsonl'));
    await configStore.save({ ...defaultConfig, enabled: true, dryRun: true, wslDistribution: '', pollIntervalMs: 60000 });
    const snapshots = [];
    const probes = [];
    const associations = [];
    const closeStart = closeCount;
    const clock = Date.now();
    let liveService;
    controller = new WatchdogController({
      configStore, auditStore, platform: 'win32', currentProcessId: 999, now: () => clock,
      codexStatePath: nativePath, codexGoalPath: nativePath,
      provider: { listProcesses: async () => [
        { pid: 999, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1000, userSid: 'fixture' },
        { pid: 100, parentPid: 1, name: 'node.exe', commandLine: 'node C:\\tools\\codex.js', executablePath: null, creationTimeMs: 1000, userSid: 'fixture', workingDirectory: '/native/project' },
      ] },
      wslRun: async (distribution, script) => {
        const home = distribution === 'Fixture-A' ? '/home/alice' : '/home/bob';
        const kind = script === 'printf %s "$HOME"' ? 'home' : script.includes('ps -eo') ? 'processes' : 'launch';
        probes.push({ distribution, kind });
        if (kind === 'home') return home;
        if (kind === 'processes') return `42\t1\tnode\tnode ${home}/bin/codex\t/work/project\t\t0\n`;
        return `${home}/bin/node\t${home}/bin/codex`;
      },
      wslStateSnapshot: (options) => {
        const distribution = options.uncCodexHome.includes('\\Fixture-A\\') ? 'Fixture-A' : 'Fixture-B';
        const snapshot = snapshotWslCodexState({ uncCodexHome: sources[distribution] });
        assert.ok(snapshot);
        snapshots.push({ distribution, unc: options.uncCodexHome, directory: snapshot.directory });
        return snapshot;
      },
      publish: (event, data) => liveService?.publish(event, data),
    });
    const codexConfig = join(root, 'codex.toml');
    await writeFile(codexConfig, 'model = "fixture-model"\n');
    service = new WatchdogHttpServer({
      configStore, auditStore, sessions: controller, port: 0, staticDirectory: web,
      codexProfiles: new CodexConfigProfiles({ configPath: codexConfig }), status: () => controller.status(),
      environment: { report: async () => ({ checkedAt: new Date().toISOString(), node: { version: process.version, executable: process.execPath }, npm: { version: 'fixture', executable: 'fixture' }, tools: [], upgrades: [], manualCommands: [] }) },
    });
    liveService = service;
    service.setLifecycle({ startupStatus: async () => ({ installed: false }), claudeHookStatus: async () => ({ installed: false, restartRequired: false, manualReviewRequired: false }) });
    await service.start();
    await controller.start();
    context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(service.url());
    await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
    await general(page);
    await select(page, '外观');
    await page.getByRole('radio', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click();
    await select(page, '常规');
    assert.deepEqual(probes, []);
    await saveDistribution(page, 'Fixture-A');
    await controller.poll();
    associations.push({ distribution: 'Fixture-A', rows: await controller.list() });
    await page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, `${label}-01-selected-A-settings`);
    await overview(page);
    if (width === 390) {
      const card = page.locator('article').filter({ hasText: 'Fixture-A' });
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await capture(page, `${label}-02-A-overview-cards`);
    }
    await showThread(page, 'thread-A');
    await capture(page, `${label}-02-A-overview`);
    await closeDrawer(page);
    const aSnapshot = snapshots[0].directory;
    await general(page);
    await saveDistribution(page, 'Fixture-B');
    assert.equal(existsSync(aSnapshot), false);
    assert.equal(closeCount - closeStart, 1);
    await controller.poll();
    associations.push({ distribution: 'Fixture-B', rows: await controller.list() });
    await page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, `${label}-03-selected-B-settings`);
    await overview(page);
    if (width === 390) {
      const card = page.locator('article').filter({ hasText: 'Fixture-B' });
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await capture(page, `${label}-04-B-overview-cards`);
    }
    await showThread(page, 'thread-B');
    await expect(page.locator('.workspace').getByText('thread-A', { exact: true })).toHaveCount(0);
    await capture(page, `${label}-04-B-overview`);
    await closeDrawer(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
    await general(page);
    await expect(page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true })).toHaveValue('Fixture-B');
    await page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, `${label}-05-B-reload-persists`);
    const bSnapshot = snapshots[1].directory;
    await saveDistribution(page, '');
    assert.equal(existsSync(bSnapshot), false);
    assert.equal(closeCount - closeStart, 2, 'native adapter must remain open');
    await controller.poll();
    await page.getByRole('textbox', { name: 'WSL 发行版名称', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, `${label}-06-disabled-settings`);
    await overview(page);
    if (width === 390) {
      await expect(page.locator('article').filter({ hasText: 'Fixture-B' })).toHaveCount(0);
      await page.locator('article').filter({ hasText: '/native/project' }).scrollIntoViewIfNeeded();
      await capture(page, `${label}-07-disabled-overview-cards`);
    }
    await showThread(page, 'thread-native');
    await expect(page.locator('.workspace').getByText('thread-B', { exact: true })).toHaveCount(0);
    await capture(page, `${label}-07-disabled-native-overview`);
    await closeDrawer(page);
    const rows = await controller.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversationId, 'thread-native');
    assert.equal((await configStore.load()).dryRun, true);
    assert.equal(appServerStarts, 0);
    assert.equal(inputWrites, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(probes.filter((probe) => probe.kind !== 'processes'), [
      { distribution: 'Fixture-A', kind: 'home' }, { distribution: 'Fixture-A', kind: 'launch' },
      { distribution: 'Fixture-B', kind: 'home' }, { distribution: 'Fixture-B', kind: 'launch' },
    ]);
    evidence.push({ label, url: service.url(), probes, snapshots, associations, oldSnapshotsRemoved: snapshots.every((snapshot) => !existsSync(snapshot.directory)), rows, appServerStarts, inputWrites });
    notes.push(`${label}: real HTTP/UI disabled → A → B → disabled; separate home/launcher/SQLite associations, previous snapshots removed, native retained, reload persists, zero input writes`);
    process.stdout.write(`ok  ${notes.at(-1)}\n`);
    await context.close(); context = null;
    await controller.stop(); controller = null;
    await service.stop(); service = null;
  }
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, runtime: process.version, node: process.execPath, conda: process.env.CONDA_PREFIX, compiled, web, indexSha256: createHash('sha256').update(indexHtml).digest('hex'), screenshots, notes, evidence }, null, 2)}\n`);
} catch (error) {
  await context?.pages()[0]?.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally {
  await context?.close(); await browser?.close(); await controller?.stop(); await service?.stop();
  Object.assign(AppServerClient.prototype, { initialize: originals.initialize, queuePrompt: originals.queuePrompt, startTurn: originals.startTurn });
  CodexAdapter.prototype.close = originals.close;
  await rm(scratch, { recursive: true, force: true });
}
