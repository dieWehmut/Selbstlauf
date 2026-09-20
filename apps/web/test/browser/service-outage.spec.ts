import { expect, test } from '@playwright/test';

/**
 * What the UI does when the service stops answering.
 *
 * Every browser test served a healthy API, so the failure path — the one a user
 * actually meets when the watchdog dies mid-session — had no browser coverage. The
 * concern is not that an error appears but that the app stays usable: a rejected
 * poll must not blank the page, wedge the shell, or leave the panels stuck in a
 * permanent loading state.
 */
test('survives the service going away mid-session', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  let healthy = true;
  await page.route('**/api/**', async (route) => {
    if (healthy) return route.continue();
    // A dead service is a connection failure, not an HTTP error body.
    return route.abort('connectionrefused');
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  // The service dies.
  healthy = false;
  // Wait past at least one poll interval so the failure is actually observed.
  await page.waitForTimeout(6000);

  // The shell must still be there: an unhandled rejection would take it down.
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.titlebar')).toBeVisible();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  // Navigate anyway; every page must still render with the service gone.
  await page.locator('.sidebar').getByRole('button', { name: '事件' }).click();
  await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  // And every settings section must still render rather than hang.
  const rail = page.getByRole('tablist', { name: '设置分区' });
  const labels = await rail.getByRole('tab').allTextContents();
  const empty: string[] = [];
  for (const label of labels) {
    await rail.getByRole('tab', { name: label, exact: true }).click();
    await page.waitForTimeout(80);
    const html = await page.locator('.settings-content').innerHTML();
    if (html.trim().length === 0) empty.push(label);
  }
  expect(empty, `sections blank while the service is down: ${empty.join(', ')}`).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath('service-down.png'), fullPage: true });

  // The service comes back; the app must recover without a reload.
  healthy = true;
  await page.waitForTimeout(7000);
  await page.locator('.sidebar nav').getByRole('button', { name: '进程' }).click();
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  await expect(page.locator('.app-shell')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors during the outage: ${pageErrors.join(' | ')}`).toEqual([]);
});