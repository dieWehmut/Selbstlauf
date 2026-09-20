import { expect, test } from '@playwright/test';

/**
 * The window preview on a process detail page, in the browser build.
 *
 * The browser build has no desktop bridge, so this cannot exercise a real capture — that is
 * covered by the desktop unit tests and by driving the packaged app. What it does cover is the
 * state the *user* sees when there is nothing to capture, which must be an explanation rather
 * than an empty frame: a browser tab has no window capturer at all, and a panel that simply
 * showed nothing would read as a broken feature.
 */
test('the detail page explains that this environment cannot preview windows', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  // Open a process from the sidebar so the detail page renders.
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const panel = page.locator('.window-preview');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.window-preview__title')).toContainText('窗口内容');

  // No capturer here, so the panel says so instead of showing an empty frame.
  await expect(panel.locator('.window-preview__note')).toContainText(/不支持窗口预览|不能预览窗口/u);
  await expect(panel.locator('.window-preview__image')).toHaveCount(0);

  // The refresh control is present but must not pretend to work; the switch button exists.
  await expect(panel.getByRole('button', { name: '刷新窗口预览' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /切换到该窗口/u })).toBeVisible();

  // The panel must not introduce horizontal overflow at a narrow width either.
  await page.setViewportSize({ width: 700, height: 704 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `the preview panel overflows by ${overflow}px`).toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});