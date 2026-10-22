import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createStaticDemoApi } from '../../src/api/static-demo';

const evidence = resolve(process.cwd(), '../../tmp/settings-verification-20261022/webui');

async function openImport(page: Page) {
  await page.keyboard.press('Control+,');
  if (await page.getByRole('button', { name: '打开菜单' }).isVisible()) {
    await page.getByRole('button', { name: '打开菜单' }).click();
  }
  await page.getByRole('tab', { name: '导入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '导入', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar--settings')).not.toHaveClass(/is-open/u);
  await settle(page);
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test(`imports JSON files, exports the saved config, and applies pasted themes (${theme}, ${viewport.width})`, async ({ page }) => {
      await mkdir(evidence, { recursive: true });
      await page.setViewportSize(viewport);
      await page.addInitScript((theme) => localStorage.setItem('watchdog-theme', theme), theme);
      await page.goto('/');
      await openImport(page);
      const config = { ...await createStaticDemoApi().config(), dryRun: false, pollIntervalMs: 1750 };
      await page.getByLabel('读取 JSON 文件').setInputFiles({
        name: 'saved-config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)),
      });
      await expect(page.getByRole('status').filter({ hasText: '已读取 saved-config.json' })).toBeVisible();
      await expect(page.getByLabel('JSON 文本')).toHaveValue(JSON.stringify(config));
      await settle(page);
      await page.screenshot({ path: resolve(evidence, `01-import-${theme}-${viewport.width}-file.png`), fullPage: true });
      await page.getByRole('button', { name: '导入文本', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '已导入配置' })).toBeVisible();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出配置', exact: true }).click();
      const download = await downloadPromise;
      const exportPath = resolve(evidence, `01-config-export-${theme}-${viewport.width}.json`);
      await download.saveAs(exportPath);
      const { readFile } = await import('node:fs/promises');
      expect(JSON.parse(await readFile(exportPath, 'utf8'))).toMatchObject({ dryRun: false, pollIntervalMs: 1750 });
      await page.getByLabel('JSON 文本').fill(JSON.stringify({ background: '#102030', foreground: '#e0e0e0', accent: '#ff8800' }));
      await page.getByLabel('导入类型').selectOption('theme');
      await page.getByRole('button', { name: '导入文本', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '已导入主题' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#ff8800');
      await settle(page);
      await page.screenshot({ path: resolve(evidence, `01-import-${theme}-${viewport.width}-applied.png`), fullPage: true });
    });
  }
}

test('a real HTTP configuration rejection is shown without claiming success and can be retried', async ({ page }) => {
  const demo = createStaticDemoApi();
  let saved = await demo.config();
  let reject = true;
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/config' && route.request().method() === 'PUT') {
      if (reject) return respond({ error: '配置未写入磁盘' }, 400);
      saved = route.request().postDataJSON();
      return respond(saved);
    }
    switch (path) {
      case '/api/config': return respond(saved);
      case '/api/health': return respond(await demo.health());
      case '/api/sessions': return respond(await demo.sessions());
      case '/api/startup': return respond(await demo.startup());
      case '/api/claude-hook': return respond(await demo.claudeHook());
      case '/api/codex/profiles': return respond(await demo.codexProfiles());
      case '/api/environment': return respond(await demo.environment());
      case '/api/events': return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
      default: return respond({});
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // The suite starts both servers; this assertion specifically needs the bundle with the real API client.
  await page.goto('http://127.0.0.1:4175');
  await openImport(page);
  await page.getByLabel('JSON 文本').fill(JSON.stringify({ ...saved, pollIntervalMs: 1750 }));
  await page.getByRole('button', { name: '导入文本', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '导入失败：配置未写入磁盘' })).toBeVisible();
  await expect(page.getByText('已导入配置', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, '01-import-http-rejected.png'), fullPage: true });
  reject = false;
  await page.getByRole('button', { name: '导入文本', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已导入配置' })).toBeVisible();
  expect(saved.pollIntervalMs).toBe(1750);
  await page.screenshot({ path: resolve(evidence, '01-import-http-retried.png'), fullPage: true });
});
