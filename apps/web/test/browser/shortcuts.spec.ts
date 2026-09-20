import { expect, test } from '@playwright/test';

/**
 * Every shortcut the app documents must actually work.
 *
 * The bottom bar's menu displayed `Ctrl+,` beside 设置 while nothing bound it, so the hint
 * promised something the app did not do — and the 键盘快捷键 settings list, whose own
 * contract is "exactly the shortcuts the application honours today", had drifted the same
 * way. jsdom can assert the key handler, but only a real browser proves the binding
 * survives actual focus and event routing.
 */
test('honours the documented page shortcuts, including the advertised Ctrl+,', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  const cases = [
    { keys: 'Control+2', heading: '事件记录' },
    { keys: 'Control+3', heading: 'Watchdog 设置' },
    { keys: 'Control+1', heading: '进程监控' },
    // The one the menu advertises.
    { keys: 'Control+,', heading: 'Watchdog 设置' },
  ];

  for (const { keys, heading } of cases) {
    await page.keyboard.press(keys);
    await expect(
      page.getByRole('heading', { name: heading }),
      `${keys} did not reach ${heading}`,
    ).toBeVisible();
  }

  // The hint on the menu and the documented list must agree with each other and with the
  // app, so both are read back rather than assumed.
  await expect(page.locator('.account-bar__button')).toBeVisible();
  await page.locator('.account-bar__button').click();
  await expect(page.getByRole('menuitem', { name: /设置/u })).toContainText('Ctrl+,');
  await page.keyboard.press('Escape');

  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();
  await page.getByRole('tab', { name: '键盘快捷键' }).click();
  const table = page.locator('.shortcuts-table');
  await expect(table).toContainText('Ctrl+,');
  await expect(table).toContainText('Ctrl+1');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});