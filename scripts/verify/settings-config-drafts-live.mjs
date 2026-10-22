// Production UI and real configuration writes with independent browser editors.
// Only disposable configuration files are used; no user processes are discovered.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = resolve(repository, process.argv[2] ?? 'tmp/dsh-testbuild');
const web = resolve(repository, process.argv[3] ?? 'tmp/config-drafts-web-build');
const moduleAt = (path) => import(pathToFileURL(join(compiled, 'src', path)).href);
const [{ defaultConfig }, { WatchdogHttpServer }, { ConfigStore }, { AuditStore }, { CodexConfigProfiles }] = await Promise.all([
  moduleAt('domain/config.js'), moduleAt('server/http-server.js'), moduleAt('store/config-store.js'),
  moduleAt('store/audit-store.js'), moduleAt('codex/profile-store.js'),
]);
const artifacts = join(repository, 'tmp/settings-verification-20261022/webui/05-config-drafts');
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'selbstlauf-config-drafts-'));
const notes = [];
const screenshots = [];
const note = (message) => { notes.push(message); process.stdout.write(`ok  ${message}\n`); };
let browser;
let context;
let service;

async function section(page, name) {
  if (page.viewportSize().width <= 960 && !await page.locator('.sidebar--settings').evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  }
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name, exact: true }).click();
  await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
}
async function capture(page, label, control) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await control.scrollIntoViewIfNeeded();
  const path = join(artifacts, `${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} horizontal overflow`);
}
async function openSettings(page, origin) {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
  await page.keyboard.press('Control+,');
  await section(page, '常规');
}

try {
  note(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}`);
  browser = await chromium.launch();
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    const label = `${theme}-${width}`;
    const root = join(scratch, label);
    await mkdir(root, { recursive: true });
    const configPath = join(root, 'config.json');
    const configStore = new ConfigStore(configPath);
    await configStore.save({ ...defaultConfig, enabled: false, dryRun: true, pollIntervalMs: 2000 });
    const codexPath = join(root, 'codex.toml');
    await writeFile(codexPath, 'model = "fixture-model"\n');
    service = new WatchdogHttpServer({ configStore, auditStore: new AuditStore(join(root, 'audit.jsonl')), port: 0, staticDirectory: web,
      sessions: { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) },
      codexProfiles: new CodexConfigProfiles({ configPath: codexPath }),
      environment: { report: async () => ({ tools: [], upgrades: [], missing: [], manualCommands: [], checkedAtMs: Date.now() }) },
    });
    service.setLifecycle({ startupStatus: () => ({ installed: false }), claudeHookStatus: () => ({ installed: false, restartRequired: false, manualReviewRequired: false }) });
    await service.start();
    context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const observer = await context.newPage();
    const errors = [];
    for (const viewer of [page, observer]) viewer.on('pageerror', (error) => errors.push(String(error)));
    await openSettings(page, service.url());
    await section(page, '外观');
    await page.getByRole('radio', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click();
    await section(page, '常规');
    await openSettings(observer, service.url());
    const claude = page.getByLabel('Claude', { exact: true });
    const include = page.getByLabel('包含匹配', { exact: true });
    await claude.fill('local unfinished Claude prompt');
    await include.fill('local, include');
    await section(page, '续写与进程');
    await page.getByLabel('Lease 有效期（毫秒）', { exact: true }).fill('19000');
    await capture(page, `${label}-01-local-hook-draft`, page.getByLabel('Lease 有效期（毫秒）', { exact: true }));
    service.publish('sessions', { action: 'read-only-verification-refresh' });
    // Count the production interval's own request instead of advancing fake timers.
    if (theme === 'light' && width === 1280) {
      await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET', { timeout: 12000 });
      await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET', { timeout: 12000 });
    }
    await expect(page.getByLabel('Lease 有效期（毫秒）', { exact: true })).toHaveValue('19000');
    await section(page, '常规');
    await expect(claude).toHaveValue('local unfinished Claude prompt');
    await expect(include).toHaveValue('local, include');
    await observer.getByLabel('Claude', { exact: true }).fill('external competing Claude prompt');
    await observer.getByLabel('轮询间隔（毫秒）', { exact: true }).fill('2750');
    await observer.getByLabel('排除匹配', { exact: true }).fill('external exclude');
    await section(observer, '续写与进程');
    await observer.getByLabel('命令超时（毫秒）', { exact: true }).fill('2300');
    await observer.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).pollIntervalMs).toBe(2750);
    await expect(page.getByLabel('轮询间隔（毫秒）', { exact: true })).toHaveValue('2750');
    await expect(claude).toHaveValue('local unfinished Claude prompt');
    await expect(include).toHaveValue('local, include');
    await expect(page.getByLabel('排除匹配', { exact: true })).toHaveValue('external exclude');
    await capture(page, `${label}-02-external-save-local-draft`, claude);
    await section(page, '续写与进程');
    await expect(page.getByLabel('Lease 有效期（毫秒）', { exact: true })).toHaveValue('19000');
    await expect(page.getByLabel('命令超时（毫秒）', { exact: true })).toHaveValue('2300');
    await capture(page, `${label}-03-merged-hook-values`, page.getByLabel('命令超时（毫秒）', { exact: true }));

    // Make the real atomic rename fail while the store's last confirmed value stays readable.
    const beforeFailure = await readFile(configPath, 'utf8');
    const parked = `${configPath}.before-failure`;
    await rename(configPath, parked); await mkdir(configPath);
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    assert.equal((await failed).status(), 500);
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
    await expect(page.locator('.notice[role="status"]')).toBeVisible();
    assert.equal(await readFile(parked, 'utf8'), beforeFailure);
    service.publish('sessions', { action: 'failed-save-refresh' });
    await expect(page.getByLabel('Lease 有效期（毫秒）', { exact: true })).toHaveValue('19000');
    await capture(page, `${label}-04-real-save-failure-draft-retained`, page.getByLabel('Lease 有效期（毫秒）', { exact: true }));
    await rm(configPath, { recursive: true }); await rename(parked, configPath);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).tools.claude.normalPrompt).toBe('local unfinished Claude prompt');
    const confirmed = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(confirmed.pollIntervalMs, 2750);
    assert.equal(confirmed.tools.claude.stopHook.leaseTtlMs, 19000);
    assert.equal(confirmed.tools.claude.stopHook.commandTimeoutMs, 2300);
    assert.deepEqual(confirmed.processFilters, { sameUserOnly: true, include: ['local', 'include'], exclude: ['external exclude'] });
    await capture(page, `${label}-05-retry-confirmed`, page.getByLabel('Lease 有效期（毫秒）', { exact: true }));
    await section(observer, '常规');
    await expect(observer.getByLabel('Claude', { exact: true })).toHaveValue('local unfinished Claude prompt');
    await observer.getByLabel('Claude', { exact: true }).fill('external after acknowledged save');
    await observer.getByRole('button', { name: '保存配置', exact: true }).click();
    await section(page, '常规');
    await expect(claude).toHaveValue('external after acknowledged save');

    // Hold the request at the browser boundary, then let it reach the actual service.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      markStarted(); await held; await route.continue();
    });
    await claude.fill('submitted while request pending');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await started;
    await claude.fill('newer local edit made during save');
    release();
    await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).tools.claude.normalPrompt).toBe('submitted while request pending');
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
    await expect(claude).toHaveValue('newer local edit made during save');
    await page.unroute('**/api/config');
    service.publish('sessions', { action: 'confirmed-save-refresh' });
    await expect(claude).toHaveValue('newer local edit made during save');
    await capture(page, `${label}-06-newer-edit-retained`, claude);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).tools.claude.normalPrompt).toBe('newer local edit made during save');
    await page.reload(); await page.keyboard.press('Control+,'); await section(page, '常规');
    await expect(claude).toHaveValue('newer local edit made during save');
    await capture(page, `${label}-07-reloaded-confirmed`, claude);
    assert.deepEqual(errors, []);
    note(`${label}: polling/SSE keep local drafts, another window's save updates untouched nested fields, real atomic write failure retains drafts and retries, acknowledged values accept later external changes, newer pending edits survive and reload after save`);
    await context.close(); context = null;
    await service.stop(); service = null;
  }
  await rm(join(artifacts, 'failure.txt'), { force: true });
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, runtime: process.version, node: process.execPath, conda: process.env.CONDA_PREFIX, notes, screenshots }, null, 2)}\n`);
} catch (error) {
  await context?.pages()[0]?.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally { await context?.close(); await browser?.close(); await service?.stop(); await rm(scratch, { recursive: true, force: true }); }
