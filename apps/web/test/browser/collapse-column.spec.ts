import { expect, test } from '@playwright/test';

/**
 * Collapsing on 设置 must reclaim the rail's column.
 *
 * `.app-shell--settings` and `.app-shell--compact` are both single-class selectors, so
 * whichever came last in the stylesheet decided the grid. With the settings rule later,
 * hiding the rail left its 268px column reserved and squeezed the content into the left
 * third of the window — a collapsed page that looked broken rather than collapsed.
 *
 * Both states are asserted as geometry, since the column width is the thing that was
 * wrong and a class list would have looked identical either way.
 */
test('collapsing on 设置 reclaims the left column instead of leaving it empty', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  const shell = page.locator('.app-shell');
  const workspace = page.locator('.workspace');
  const toggle = page.locator('.titlebar').locator('.titlebar__button').first();

  // Expanded: the rail column is reserved and the content sits to its right.
  const expanded = (await workspace.boundingBox())!;
  const expandedColumns = await shell.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(expandedColumns.split(' ').length, 'the settings page does not have two columns').toBe(2);
  expect(Math.round(expanded.x), 'the content does not start beside the rail').toBeGreaterThan(200);

  // Collapsed: the rail is gone and the column with it.
  await expect(toggle).toHaveAttribute('aria-label', '收起侧栏');
  await toggle.click();
  await expect(page.locator('.settings-rail')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-label', '展开侧栏');

  const collapsed = (await workspace.boundingBox())!;
  const collapsedColumns = await shell.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(
    Math.round(collapsed.x),
    'the collapsed page still reserves a column for the hidden rail',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.round(collapsed.width),
    `the content did not reclaim the width: ${collapsedColumns}`,
  ).toBe(1249);
  // The panel the person was reading must still be rendered, not blanked with the rail.
  expect(await page.locator('.settings-content > *').count()).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('settings-collapsed.png') });

  // Restoring brings the rail and its column back exactly as they were.
  await toggle.click();
  await expect(page.locator('.settings-rail')).toBeVisible();
  const restored = (await workspace.boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(expanded.x));
  expect(Math.round(restored.width)).toBe(Math.round(expanded.width));

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('collapsing still reclaims the column on the dashboard', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  const workspace = page.locator('.workspace');
  const toggle = page.locator('.titlebar').locator('.titlebar__button').first();
  const expanded = (await workspace.boundingBox())!;
  await toggle.click();
  await expect(page.locator('.sidebar')).toBeHidden();
  const collapsed = (await workspace.boundingBox())!;
  // The same invariant as the settings page, so the shared rule cannot regress for one
  // page while passing for the other.
  expect(Math.round(collapsed.x)).toBeLessThanOrEqual(1);
  expect(Math.round(collapsed.width)).toBe(1249);
  expect(collapsed.width).toBeGreaterThan(expanded.width);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});