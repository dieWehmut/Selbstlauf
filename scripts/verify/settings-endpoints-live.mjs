// Verify endpoint editing against the real HTTP service and an isolated TOML.
// Optional args select existing CLI/Web build directories; this never builds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliDirectory = resolve(repository, process.argv[2] ?? 'apps/cli/dist');
const webDirectory = resolve(repository, process.argv[3] ?? 'apps/web/dist');
const { startWatchdogProcess } = await import(pathToFileURL(join(cliDirectory, 'src/index.js')).href);
const { readConfigSummary } = await import(pathToFileURL(join(cliDirectory, 'src/codex/config-profiles.js')).href);
const artifacts = join(repository, 'tmp/settings-verification-20261022/webui/03-endpoints');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-endpoints-live-'));
const configPath = join(root, '.codex/config.toml');
const seed = [
  'model = "verification-model"',
  'review_model = "verification-review-model"',
  'model_reasoning_effort = "high"',
  'base_url = "https://first.example/v1"',
  '# base_url = "https://second.example/v1" # parked endpoint',
  'experimental_bearer_token = "verification-token-not-a-secret" # keep label',
  '',
  '[model_providers.verification]',
  'base_url = "https://nested.example/v1"',
  'experimental_bearer_token = "nested-verification-token"',
  '',
].join('\n');
const originalActive = readConfigSummary(seed).active;
const keys = ['model', 'review_model', 'model_reasoning_effort', 'base_url', 'experimental_bearer_token'];
const labels = ['模型', '评审模型', '推理强度', '接口地址', '访问令牌'];
const options = { stateDirectory: join(root, 'ai-cli-bypass/continuation'), claudeSettingsPath: join(root, '.claude/settings.json'),
  codexConfigPath: configPath, staticDirectory: webDirectory, port: 0 };
const sessions = { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) };
const notes = [];
const screenshots = [];
const errors = [];
let service;
let browser;
const note = (message) => { notes.push(message); process.stdout.write(`ok  ${message}\n`); };
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}
async function endpoints(page) {
  await expect(page.locator('.topbar h1')).toBeVisible();
  await page.keyboard.press('Control+,');
  const rail = page.getByRole('tablist', { name: '设置分区' });
  await expect(rail).toBeAttached();
  if (page.viewportSize().width <= 960 && !await page.locator('.sidebar--settings').evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  }
  await rail.getByRole('tab', { name: '续写与进程', exact: true }).click();
  await page.locator('.codex-endpoints').scrollIntoViewIfNeeded();
  await settle(page);
}
async function screenshot(page, label) {
  await expect(page.getByRole('textbox', { name: '访问令牌', exact: true })).toBeEnabled();
  await page.locator('.codex-endpoints').evaluate((section) => {
    const workspace = section.closest('.workspace');
    workspace.scrollTop += section.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 12;
  });
  await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: horizontal overflow`);
  const path = join(artifacts, `${label}-top.png`);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
  const bottomRequired = await page.locator('.codex-endpoints').evaluate((section) => {
    const workspace = section.closest('.workspace');
    const remaining = section.getBoundingClientRect().bottom - workspace.getBoundingClientRect().bottom;
    if (remaining <= 1) return false;
    workspace.scrollTop += remaining + 12;
    return true;
  });
  if (bottomRequired) {
    await settle(page);
    const bottomPath = join(artifacts, `${label}-bottom.png`);
    await page.screenshot({ path: bottomPath, fullPage: true });
    screenshots.push(bottomPath);
  }
}
async function backups() { return (await readdir(dirname(configPath))).filter((name) => name.endsWith('.bak')); }
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, seed);
  note(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}`);
  service = await startWatchdogProcess(options, sessions);
  browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      await writeFile(configPath, seed);
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
      await context.addInitScript((value) => { localStorage.setItem('watchdog-theme', value); }, theme);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(String(error)));
      const edits = [];
      page.on('request', (request) => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/codex/profiles') edits.push(request.postDataJSON().fields);
      });
      await page.goto(service.server.url());
      await endpoints(page);
      const token = page.getByRole('textbox', { name: '访问令牌', exact: true });
      const apply = page.getByRole('button', { name: '应用端点配置', exact: true });
      await expect(token).toHaveValue(originalActive.experimental_bearer_token);
      await expect(apply).toBeDisabled();
      const observer = await context.newPage();
      observer.on('pageerror', (error) => errors.push(String(error)));
      await observer.goto(service.server.url());
      await endpoints(observer);
      const observerToken = observer.getByRole('textbox', { name: '访问令牌', exact: true });
      await expect(observerToken).toHaveValue(originalActive.experimental_bearer_token);
      const observerModel = observer.getByRole('textbox', { name: '模型', exact: true });
      await observerModel.fill('unsaved-observer-model');
      await screenshot(page, `${theme}-${width}-01-original`);

      await token.fill('');
      const refreshed = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/codex/profiles');
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await refreshed;
      await expect(token).toHaveValue('');
      await expect(apply).toBeEnabled();
      await screenshot(page, `${theme}-${width}-02-draft-after-refresh`);
      const hiddenPath = join(root, 'hidden-config.toml');
      await rename(configPath, hiddenPath);
      try {
        await apply.click();
        await expect(page.getByRole('alert')).toContainText('config.toml does not exist');
        await expect(token).toHaveValue('');
        assert.deepEqual(edits.at(-1), [{ key: 'experimental_bearer_token', value: null }]);
        await screenshot(page, `${theme}-${width}-03-real-write-failure`);
      } finally { await rename(hiddenPath, configPath); }
      const beforeBackups = await backups();
      await apply.click();
      await expect(apply).toBeDisabled();
      await expect(token).toBeEnabled();
      const removedText = await readFile(configPath, 'utf8');
      const removed = readConfigSummary(removedText);
      assert.equal(removed.active.experimental_bearer_token, undefined);
      assert.deepEqual(removed.active, Object.fromEntries(Object.entries(originalActive).filter(([key]) => key !== 'experimental_bearer_token')));
      assert.deepEqual(removed.commented.experimental_bearer_token, [originalActive.experimental_bearer_token]);
      assert.match(removedText, /# experimental_bearer_token = "verification-token-not-a-secret" # keep label/u);
      assert.match(removedText, /\[model_providers\.verification\]\nbase_url = "https:\/\/nested\.example\/v1"\nexperimental_bearer_token = "nested-verification-token"/u);
      const addedBackups = (await backups()).filter((name) => !beforeBackups.includes(name));
      assert.equal(addedBackups.length, 1);
      assert.equal(await readFile(join(dirname(configPath), addedBackups[0]), 'utf8'), seed);
      assert.equal(await readFile(join(dirname(configPath), `${addedBackups[0]}.meta`), 'utf8'), `sha256 ${createHash('sha256').update(seed).digest('hex')}\n`);
      await expect(token).toHaveValue('');
      await expect(observerToken).toHaveValue('');
      await expect(observerModel).toHaveValue('unsaved-observer-model');
      await screenshot(page, `${theme}-${width}-04-token-removed`);
      await screenshot(observer, `${theme}-${width}-04b-other-window-synced`);

      await page.reload();
      await endpoints(page);
      await expect(token).toHaveValue('');
      await expect(page.getByRole('textbox', { name: '模型', exact: true })).toHaveValue(originalActive.model);
      await screenshot(page, `${theme}-${width}-05-reloaded`);
      await page.getByRole('button', { name: originalActive.experimental_bearer_token, exact: true }).click();
      await expect(token).toHaveValue(originalActive.experimental_bearer_token);
      await expect(token).toBeEnabled();
      assert.deepEqual(edits.at(-1), [{ key: 'experimental_bearer_token', value: originalActive.experimental_bearer_token }]);
      assert.deepEqual(readConfigSummary(await readFile(configPath, 'utf8')).active, originalActive);
      await screenshot(page, `${theme}-${width}-06-token-restored`);

      for (const label of labels) await page.getByRole('textbox', { name: label, exact: true }).fill('');
      await apply.click();
      await expect(apply).toBeDisabled();
      await expect(token).toBeEnabled();
      assert.deepEqual(edits.at(-1), keys.map((key) => ({ key, value: null })));
      const allRemoved = readConfigSummary(await readFile(configPath, 'utf8'));
      assert.deepEqual(allRemoved.active, {});
      for (const key of keys) assert.ok(allRemoved.commented[key].includes(originalActive[key]));
      await screenshot(page, `${theme}-${width}-07-all-fields-removed`);

      await page.getByRole('textbox', { name: '模型', exact: true }).fill('new-verification-model');
      await page.getByRole('button', { name: 'https://second.example/v1', exact: true }).click();
      await expect(apply).toBeDisabled();
      await expect(token).toBeEnabled();
      assert.deepEqual(edits.at(-1), [{ key: 'model', value: 'new-verification-model' }, { key: 'base_url', value: 'https://second.example/v1' }]);
      const finalText = await readFile(configPath, 'utf8');
      assert.deepEqual(readConfigSummary(finalText).active, { model: 'new-verification-model', base_url: 'https://second.example/v1' });
      await screenshot(page, `${theme}-${width}-08-combined-alternative`);
      const beforeInvalidBackups = await backups();
      const invalid = await page.request.put(`${service.server.url()}/api/codex/profiles`, {
        headers: { origin: service.server.url() }, data: { fields: [{ key: 'approval_policy', value: null }] },
      });
      assert.equal(invalid.status(), 400);
      assert.equal(await readFile(configPath, 'utf8'), finalText);
      assert.deepEqual(await backups(), beforeInvalidBackups);
      await context.close();
      note(`${theme} ${width}: empty draft survives refresh/error; null removes active token with backup; other window sync, reload, restore, all-five removal, combined dirty alternative and invalid-key rejection pass`);
    }
  }
  await service.stop();
  service = await startWatchdogProcess(options, sessions);
  const persisted = await (await fetch(`${service.server.url()}/api/codex/profiles`)).json();
  assert.deepEqual(persisted.active, { model: 'new-verification-model', base_url: 'https://second.example/v1' });
  note('real service restart retains deletions and combined updates');
  assert.deepEqual(errors, []);
  await rm(join(artifacts, 'failure.txt'), { force: true });
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, runtime: process.version, node: process.execPath,
    conda: process.env.CONDA_PREFIX, cliDirectory, webDirectory, notes, screenshots }, null, 2)}\n`);
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally {
  await browser?.close();
  await service?.stop();
  await rm(root, { recursive: true, force: true });
}
