import { expect, test } from '@playwright/test';

/**
 * The settings page's layout contract.
 *
 * Three things were asked for, and each is a structural fact rather than a style:
 *
 *  1. the app's own sidebar is not shown on 设置 — the settings rail replaces it, so the
 *     page has one left rail instead of two stacked columns;
 *  2. that rail is the left column, occupying the slot and width the sidebar would;
 *  3. the title bar stays at the top of the window rather than scrolling away with the
 *     page, which it used to do because the shell scrolled as a document.
 *
 * They are asserted as geometry because that is what "at the top" and "is the left
 * column" mean; a class name would pass while the layout was wrong.
 */
test('replaces the app sidebar with the settings rail, and keeps the title bar at the top', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  // The app sidebar is present on the dashboard, which is what makes its absence on
  // settings meaningful rather than a selector that never matched.
  await expect(page.locator('.sidebar:not(.sidebar--settings)')).toHaveCount(1);
  await expect(page.locator('.brand')).toHaveCount(1);

  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  // 1. The app sidebar is gone, entirely: not merely narrowed or hidden behind the rail.
  await expect(page.locator('.sidebar:not(.sidebar--settings)'), 'the app sidebar is still on the settings page').toHaveCount(0);
  await expect(page.locator('.brand')).toHaveCount(0);
  await expect(page.locator('.sidebar-processes')).toHaveCount(0);
  await expect(page.locator('.account-bar')).toHaveCount(0);
  await expect(page.locator('.nav-button')).toHaveCount(0);

  // 2. The settings rail is the left column, and the content sits to its right.
  const column = page.locator('.sidebar--settings');
  await expect(column).toHaveCount(1);
  const rail = page.getByRole('tablist', { name: '设置分区' });
  await expect(rail).toBeVisible();
  const columnBox = (await column.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const contentBox = (await page.locator('.workspace').boundingBox())!;
  expect(Math.round(columnBox.x), 'the rail is not at the left edge').toBeLessThanOrEqual(1);
  expect(columnBox.width, 'the rail column has no width').toBeGreaterThan(200);
  // The rail fills the column it was given, rather than floating inside it as a card.
  expect(railBox.x).toBeGreaterThanOrEqual(columnBox.x - 1);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(columnBox.x + columnBox.width + 1);
  expect(
    Math.round(contentBox.x),
    'the content does not start to the right of the rail column',
  ).toBeGreaterThanOrEqual(Math.round(columnBox.x + columnBox.width) - 1);

  await page.screenshot({ path: testInfo.outputPath('settings-layout.png') });

  // 3. The title bar does not move when the content scrolls.
  const before = Math.round((await page.locator('.titlebar').boundingBox())!.y);
  expect(before, 'the title bar does not start at the top of the window').toBe(0);
  const scrolled = await page.locator('.workspace').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, 'the content did not scroll, so this proves nothing about the title bar').toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const after = Math.round((await page.locator('.titlebar').boundingBox())!.y);
  expect(after, 'the title bar scrolled away with the content').toBe(0);
  // The page title row sticks under it rather than scrolling off too.
  expect(Math.round((await page.locator('.topbar').boundingBox())!.y)).toBeGreaterThanOrEqual(0);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the settings rail is the drawer on a narrow window, and closes when a section is picked', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');

  // Enter settings from the app sidebar's drawer.
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  // The left column is the settings rail here too, but as a closed drawer.
  const column = page.locator('.sidebar--settings');
  await expect(column).toHaveCount(1);
  await expect(column).not.toHaveClass(/is-open/u);

  // It opens from the same topbar button and offers every section.
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(column).toHaveClass(/is-open/u);
  await expect(page.getByRole('tablist', { name: '设置分区' })).toBeVisible();

  // Picking a section closes the drawer so its panel is readable.
  await page.getByRole('tab', { name: '账户' }).click();
  await expect(column).not.toHaveClass(/is-open/u);
  await expect(page.getByRole('heading', { name: '关于' })).toBeVisible();

  // The title bar is still at the top on a narrow window.
  expect(Math.round((await page.locator('.titlebar').boundingBox())!.y)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});