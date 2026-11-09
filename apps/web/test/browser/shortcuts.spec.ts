import { expect, test } from '@playwright/test';

/** Keyboard navigation and fixed rail controls must agree with the documented shortcuts. */
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
    // The alternative settings shortcut.
    { keys: 'Control+,', heading: 'Watchdog 设置' },
  ];

  for (const { keys, heading } of cases) {
    await page.keyboard.press(keys);
    await expect(
      page.getByRole('heading', { name: heading }),
      `${keys} did not reach ${heading}`,
    ).toBeVisible();
  }

  // Settings remains available from the fixed rail as well as the keyboard.
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
  await page.locator('.navigation-rail').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();
  await page.getByRole('tab', { name: '键盘快捷键' }).click();
  const table = page.locator('.shortcuts-table');
  await expect(table).toContainText('Ctrl+,');
  await expect(table).toContainText('Ctrl+1');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});