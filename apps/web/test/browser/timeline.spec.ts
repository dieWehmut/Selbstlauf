import { expect, test } from '@playwright/test';

/**
 * The 事件记录 page in a real browser.
 *
 * The browser suite only ever navigated to 设置, so this page's layout was covered
 * by jsdom alone — and jsdom does no layout, so an overflow, a collapsed column or
 * a growing document width would not have shown up anywhere.
 */
test('renders the timeline page at desktop and mobile widths', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '事件' }).click();

  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
  const timeline = page.locator('.timeline');
  await expect(timeline).toBeVisible();
  // Each audit row carries a title and a timestamp.
  const items = timeline.locator('.timeline__item');
  await expect(items.first()).toBeVisible();
  const itemCount = await items.count();
  expect(itemCount).toBeGreaterThan(0);

  // No row may spill out of the viewport, and the page must not scroll sideways.
  const boxes = await items.evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  }));
  for (const box of boxes) {
    expect(box.left, `a timeline row starts left of the viewport: ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(0);
    expect(box.right, `a timeline row runs past the viewport: ${JSON.stringify(box)}`).toBeLessThanOrEqual(1280);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.screenshot({ path: testInfo.outputPath('timeline-1280x900.png'), fullPage: true });

  // The same page on a narrow viewport, where the sidebar becomes a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '事件' }).click();

  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
  await expect(page.locator('.timeline')).toBeVisible();
  const narrowBoxes = await page.locator('.timeline__item').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right) };
  }));
  for (const box of narrowBoxes) {
    expect(box.left, `row starts left of a 390px viewport: ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(0);
    expect(box.right, `row runs past a 390px viewport: ${JSON.stringify(box)}`).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.screenshot({ path: testInfo.outputPath('timeline-390x844.png'), fullPage: true });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});