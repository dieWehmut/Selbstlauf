// Exercise settings through the production WebUI and the real HTTP/file boundary.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { startWatchdogProcess } from '../../apps/cli/dist/src/index.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(repository, 'tmp/settings-verification-20261022/live');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-settings-live-'));
const state = join(root, 'ai-cli-bypass/continuation');
const claudeSettingsPath = join(root, '.claude/settings.json');
const codexConfigPath = join(root, '.codex/config.toml');
const options = { stateDirectory: state, claudeSettingsPath, codexConfigPath,
  staticDirectory: join(repository, 'apps/web/dist'), port: 0 };
await mkdir(artifacts, { recursive: true });
await mkdir(dirname(claudeSettingsPath), { recursive: true });
await mkdir(dirname(codexConfigPath), { recursive: true });
const originalClaude = '{ "permissions": { "allow": [] } }\n';
await writeFile(claudeSettingsPath, originalClaude);
await writeFile(codexConfigPath, 'model = "verification-model"\nbase_url = "https://example.com/v1"\n');
// Real config, Hook, endpoint, static serving and file writes; discovery is
// isolated so this verifier cannot send continuation into the user's sessions.
const sessions = { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) };
let service;
let browser;
const notes = [];
const note = (message) => { notes.push(message); process.stdout.write(`ok  ${message}\n`); };
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}
async function select(page, name) {
  const rail = page.getByRole('tablist', { name: '设置分区' });
  const narrow = page.viewportSize().width <= 960;
  if (narrow && !await page.locator('.sidebar--settings').evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  }
  await rail.getByRole('tab', { name, exact: true }).click();
  await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
  await settle(page);
}
try {
  note(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}`);
  service = await startWatchdogProcess(options, sessions);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(service.server.url());
  await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
  await page.keyboard.press('Control+,');
  await select(page, '常规');
  await page.getByLabel('轮询间隔（毫秒）').fill('1750');
  await page.getByLabel('每轮最大尝试').fill('3');
  await page.getByLabel('启用自动续写', { exact: true }).uncheck();
  await page.getByLabel('监控 Claude', { exact: true }).uncheck();
  await page.getByLabel('监控 Codex', { exact: true }).uncheck();
  await page.getByLabel('监控 DeepSeek Harness', { exact: true }).uncheck();
  await page.getByLabel('Goal 状态 active', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(join(state, 'config.json'), 'utf8')).pollIntervalMs).toBe(1750);
  const savedConfig = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
  assert.equal(savedConfig.maxAttemptsPerQuietPeriod, 3);
  assert.equal(savedConfig.enabled, false);
  for (const tool of ['claude', 'codex', 'dsh']) assert.equal(savedConfig.tools[tool].enabled, false);
  assert.deepEqual(savedConfig.tools.codex.goalStatuses, ['paused']);
  note('editing settings in the production WebUI changes the real config.json');

  await select(page, '导入');
  await page.getByLabel('JSON 文本').fill('{"pollIntervalMs":0}');
  await page.getByRole('button', { name: '导入文本', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '导入失败' })).toBeVisible();
  assert.deepEqual(JSON.parse(await readFile(join(state, 'config.json'), 'utf8')), savedConfig);
  await settle(page);
  await page.screenshot({ path: join(artifacts, 'import-real-rejection.png'), fullPage: true });
  note('a real service rejection appears as import failure and leaves the config unchanged');

  await select(page, '续写与进程');
  await page.getByRole('button', { name: '安装 Stop Hook', exact: true }).click();
  await expect.poll(async () => (await readFile(claudeSettingsPath, 'utf8')).includes('selbstlauf-continuation-v1')).toBe(true);
  await expect(page.getByRole('button', { name: '卸载 Stop Hook', exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'hook-installed.png'), fullPage: true });
  await page.getByRole('button', { name: '卸载 Stop Hook', exact: true }).click();
  await expect.poll(() => readFile(claudeSettingsPath, 'utf8')).toBe(originalClaude);
  note('Stop Hook install writes the owned hook; uninstall restores original settings bytes');

  await page.getByLabel('接口地址').fill('https://example.org/verified/v1');
  await page.getByRole('button', { name: '应用端点配置', exact: true }).click();
  await expect.poll(() => readFile(codexConfigPath, 'utf8')).toContain('https://example.org/verified/v1');
  const backups = (await readdir(dirname(codexConfigPath))).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(await readFile(join(dirname(codexConfigPath), backups[0]), 'utf8'), /example\.com/u);
  note('Codex endpoint apply changes the isolated config.toml and keeps a backup');

  const names = await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab').allTextContents();
  const expected = ['常规', '外观', '通知', '键盘快捷键', '个人资料', '宠物', '启动与托盘', '续写与进程', '导入', '电脑操控', '插件', '浏览器', '关于'];
  assert.deepEqual(names, expected);
  for (const theme of ['light', 'dark']) {
    await select(page, '外观');
    await page.getByRole('radio', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [index, name] of names.entries()) {
        await select(page, name);
        await expect(page.locator('.settings-content h2').first()).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} ${theme} ${width} horizontal overflow`);
        if (width === 390) assert.equal(await page.locator('.sidebar--settings').evaluate((node) => node.classList.contains('is-open')), false);
        const label = `${String(index + 1).padStart(2, '0')}-${theme}-${width}`;
        await page.screenshot({ path: join(artifacts, `${label}-top.png`), fullPage: true });
        const scrolled = await page.locator('.workspace').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop > 0;
        });
        if (scrolled) await page.screenshot({ path: join(artifacts, `${label}-bottom.png`), fullPage: true });
      }
    }
  }
  note('all 13 settings sections render without overflow in both themes at 1280 and 390 pixels (52 views plus scroll bottoms)');
  assert.deepEqual(pageErrors, []);
  await context.close();
  await service.stop();
  service = await startWatchdogProcess(options, sessions);
  assert.deepEqual(await (await fetch(`${service.server.url()}/api/config`)).json(), savedConfig);
  assert.match(await readFile(codexConfigPath, 'utf8'), /example\.org\/verified/u);
  note('service restart retains the saved configuration and endpoint');
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, runtime: process.version, node: process.execPath,
    conda: process.env.CONDA_PREFIX, notes, sections: names, screenshots: 52 }, null, 2)}\n`);
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally {
  await browser?.close();
  await service?.stop();
  await rm(root, { recursive: true, force: true });
}
