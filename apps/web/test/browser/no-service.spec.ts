import { expect, test } from '@playwright/test';

/**
 * The state the app starts in when no service is running.
 *
 * This runs on the live-API server (see playwright.config.ts), where the bundle uses the real HTTP
 * client, so its polls genuinely fail. Nothing could reach this state before that server existed:
 * the demo API always answers, so every previous spec ran against a service that was always up.
 *
 * What the user must get is a shell that still works and a panel that says what is happening — not a
 * table with no rows, and not a page stuck on a spinner.
 */
test('offers a working shell and an explained empty list when no service is running', async ({ page }) => {
  // A first load against a cold dev server plus a full settings sweep needs more than the default.
  test.setTimeout(120_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  /**
   * The service's paths, refused outright.
   *
   * The dev server proxies `/api` to the port the watchdog listens on, so without this the test
   * would depend on whether the host happens to be running one: on a machine where it is, the app
   * would connect and this spec would fail for the wrong reason. Refusing the connection is the
   * state being tested, and it is the same state on every machine.
   *
   * Matched by pathname rather than by a glob, because the app's own modules live under
   * `/src/api/` and answering those with anything but JavaScript replaces the bundle.
   */
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort('connectionrefused'));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  // The process section explains itself instead of drawing the header row of an empty table.
  const processSection = page.locator('.content-section').first();
  await expect(processSection.getByText('尚未发现进程')).toBeVisible();
  await expect(page.locator('table.process-table'), 'an empty table is a table with no data').toHaveCount(0);
  // The section says it is not connected rather than presenting live data.
  await expect(processSection.locator('.section-meta')).toContainText('等待连接');

  // The sidebar list says the same thing in its own words.
  await expect(page.locator('.sidebar-processes__empty')).toHaveText('尚未发现进程');

  // The shell is intact: every settings section still renders with no service at all. This is the
  // claim the outage spec used to make while running against a service that never went away.
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();
  const rail = page.getByRole('tablist', { name: '设置分区' });
  const labels = await rail.getByRole('tab').allTextContents();
  expect(labels.length, 'the settings rail is empty, so this proves nothing').toBeGreaterThan(4);
  const blank: string[] = [];
  for (const label of labels) {
    await rail.getByRole('tab', { name: label, exact: true }).click();
    await page.waitForTimeout(80);
    const html = await page.locator('.settings-content').innerHTML();
    if (html.trim().length === 0) blank.push(label);
  }
  expect(blank, `sections blank with no service: ${blank.join(', ')}`).toEqual([]);

  // And the app is still navigable.
  await page.getByRole('button', { name: /返回应用/u }).click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  expect(pageErrors, `page errors with no service: ${pageErrors.join(' | ')}`).toEqual([]);
});