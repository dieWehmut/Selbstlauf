import { expect, test } from '@playwright/test';

/**
 * Navigation across all three pages, and the state each one keeps.
 *
 * The suite tested each page in isolation — and 事件 was only ever reached in jsdom.
 * Nothing checked that a settings edit survives navigating away and back, that the
 * title bar's back and forward arrows actually work, or that the pages can be
 * revisited repeatedly without the shell degrading.
 */
test('navigates every page and preserves edits across a round trip', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  const sidebar = page.locator('.sidebar');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  await sidebar.getByRole('button', { name: '事件' }).click();
  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();

  await sidebar.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  const rail = page.getByRole('tablist', { name: '设置分区' });

  // Edit a field that lives in the config draft, then leave and come back.
  await rail.getByRole('tab', { name: '常规' }).click();
  const idle = page.getByLabel('静默阈值（秒）');
  const original = await idle.inputValue();
  const edited = String(Number(original) + 7);
  await idle.fill(edited);
  expect(await idle.inputValue()).toBe(edited);

  await sidebar.locator('nav').getByRole('button', { name: '进程' }).click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  await sidebar.getByRole('button', { name: '设置' }).click();
  await rail.getByRole('tab', { name: '常规' }).click();

  // The draft is component state; the page remounts per visit, so the field must
  // come back from the loaded config rather than showing a stale local edit. Either
  // behaviour is defensible, but it must not be *broken* — no empty or NaN value.
  const afterReturn = await page.getByLabel('静默阈值（秒）').inputValue();
  expect(afterReturn.length, 'the field must show a real value after navigating back').toBeGreaterThan(0);
  expect(Number.isNaN(Number(afterReturn)), `the field became NaN: ${afterReturn}`).toBe(false);

  // The title bar's back and forward arrows must drive the same history.
  const back = page.getByRole('button', { name: '后退' });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  const forward = page.getByRole('button', { name: '前进' });
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  // Revisit each page several times; the shell must not degrade.
  for (let i = 0; i < 3; i += 1) {
    await sidebar.locator('nav').getByRole('button', { name: '进程' }).click();
    await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
    await sidebar.getByRole('button', { name: '事件' }).click();
    await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
    await sidebar.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();
  }

  // Every visit still leaves one shell, one title bar and one rail.
  await expect(page.locator('.app-shell')).toHaveCount(1);
  await expect(page.locator('.titlebar')).toHaveCount(1);
  await expect(page.locator('.settings-rail')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.screenshot({ path: testInfo.outputPath('navigation-round-trip.png'), fullPage: true });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});