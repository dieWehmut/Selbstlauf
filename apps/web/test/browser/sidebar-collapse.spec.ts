import { expect, test } from '@playwright/test';

/**
 * Collapsing the sidebar hides it rather than shrinking it to an icon rail.
 *
 * It used to collapse to a 76px column of unlabelled icons: not readable, barely any
 * space saved, and it left a permanent strip down the side of every page. The toggle
 * lives in the title bar and stays put, so the sidebar can always be restored, and
 * below 961px the sidebar is a drawer that the collapsed state must not remove.
 */
test('collapsing the sidebar hides it and restores the full content width', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  const sidebar = page.locator('.sidebar');
  // Two controls carry this label — the title bar one and the one in the sidebar
  // footer — so the title bar's is targeted explicitly.
  const titlebar = page.locator('.titlebar');
  const toggle = titlebar.getByRole('button', { name: '收起侧栏' });
  const workspace = page.locator('.workspace');

  await expect(sidebar).toBeVisible();
  const expanded = (await workspace.boundingBox())!;

  await toggle.click();

  // Gone, not narrowed: no leftover column where the rail used to be.
  await expect(sidebar).toBeHidden();
  await expect(titlebar.getByRole('button', { name: '展开侧栏' })).toBeVisible();

  const collapsed = (await workspace.boundingBox())!;
  // The content must start at the window's left edge, which is what proves no 76px
  // strip was left behind.
  expect(Math.round(collapsed.x), 'content did not reclaim the sidebar column').toBeLessThanOrEqual(1);
  expect(collapsed.width).toBeGreaterThan(expanded.width);
  expect(Math.round(collapsed.width)).toBe(1280);
  // Nothing may spill sideways now that the grid lost a column.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('sidebar-collapsed-1280.png') });

  // And it comes back.
  await titlebar.getByRole('button', { name: '展开侧栏' }).click();
  await expect(sidebar).toBeVisible();
  await expect(titlebar.getByRole('button', { name: '收起侧栏' })).toBeVisible();
  const restored = (await workspace.boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(expanded.x));
  expect(Math.round(restored.width)).toBe(Math.round(expanded.width));

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('a collapsed sidebar does not remove the mobile drawer', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // Collapse at a wide width first, then narrow the window: below 961px the sidebar
  // becomes a drawer, and the collapsed state must not make it unreachable.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('.titlebar').getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.locator('.sidebar')).toBeHidden();

  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(300);

  // The drawer button must open it.
  await page.getByRole('button', { name: '打开菜单' }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toHaveClass(/is-open/u);

  // It must be the full labelled sidebar, not the old icon rail: the nav labels are the
  // thing the rail used to hide. The sidebar has no brand header any more, so the labels
  // are what is checked.
  const box = (await sidebar.boundingBox())!;
  expect(Math.round(box.width), 'the drawer is not the full sidebar width').toBe(236);
  await expect(sidebar.locator('nav').getByRole('button', { name: '进程' })).toBeVisible();
  await expect(sidebar.locator('.sidebar-row__conversation').first()).toBeVisible();
  const labelVisible = await sidebar.locator('.nav-button span').first().evaluate(
    (el) => getComputedStyle(el).display !== 'none',
  );
  expect(labelVisible, 'the drawer is showing the icon-only rail, not the labelled sidebar').toBe(true);

  await page.screenshot({ path: testInfo.outputPath('sidebar-drawer-900.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});