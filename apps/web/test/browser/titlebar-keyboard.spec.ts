import { expect, test } from '@playwright/test';

/**
 * Keyboard and ARIA behaviour of the title bar menus, in a real browser.
 *
 * The menu buttons carry `aria-haspopup` and `aria-expanded` and the dropdowns are
 * `role="menu"` with `role="menuitem"` children, but nothing in the browser suite
 * checked any of it: no test asserted focus, an expanded state, or that Escape
 * closes a dropdown. Those attributes are the only thing telling a screen reader
 * that a menu opened, so a wrong or frozen value is a real defect that jsdom cannot
 * catch either, since it does not compute focus or hit-testing.
 */
test('title bar menus expose and maintain their keyboard state', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  const titlebar = page.locator('.titlebar');
  const fileMenu = titlebar.getByRole('button', { name: '文件' });

  // Closed: the trigger must say so, and no menu may be present.
  await expect(fileMenu).toHaveAttribute('aria-haspopup', 'menu');
  await expect(fileMenu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('menu', { name: '文件' })).toHaveCount(0);

  // Open it by keyboard, which is how a keyboard user reaches a menu button.
  await fileMenu.focus();
  await expect(fileMenu).toBeFocused();
  await page.keyboard.press('Enter');

  const menu = page.getByRole('menu', { name: '文件' });
  await expect(menu).toBeVisible();
  await expect(fileMenu).toHaveAttribute('aria-expanded', 'true');

  // Every item must be exposed as a menu item, and be reachable by Tab.
  const items = menu.getByRole('menuitem');
  const itemCount = await items.count();
  expect(itemCount, 'the 文件 menu must expose its items').toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  const focusedInMenu = await page.evaluate(() => {
    const el = document.activeElement;
    return el === null ? null : { role: el.getAttribute('role'), tag: el.tagName };
  });
  // Focus either lands on a menu item or stays on the trigger; both are acceptable,
  // but it must not escape to the document body, which loses the user's place.
  expect(focusedInMenu, 'focus escaped to nowhere after opening the menu').not.toBeNull();
  expect(focusedInMenu?.tag, 'focus fell through to the body').not.toBe('BODY');

  // Escape must close it and restore the closed state.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(fileMenu).toHaveAttribute('aria-expanded', 'false');

  // Only one menu may be open at a time; opening another closes the first.
  await fileMenu.click();
  await expect(page.getByRole('menu', { name: '文件' })).toBeVisible();
  await titlebar.getByRole('button', { name: '帮助' }).click();
  await expect(page.getByRole('menu', { name: '文件' })).toHaveCount(0);
  await expect(page.getByRole('menu', { name: '帮助' })).toBeVisible();
  await expect(fileMenu).toHaveAttribute('aria-expanded', 'false');

  // A menuitem must actually do something when activated by keyboard.
  const helpItems = page.getByRole('menu', { name: '帮助' }).getByRole('menuitem');
  const firstHelp = helpItems.first();
  await firstHelp.focus();
  await page.keyboard.press('Enter');
  // Activating an item closes the menu, whether or not it changed the page.
  await expect(page.getByRole('menu', { name: '帮助' })).toHaveCount(0);

  // Clicking outside must also dismiss an open menu. Click well clear of the
  // dropdown, which hangs below the 编辑 trigger near the top-left.
  await titlebar.getByRole('button', { name: '编辑' }).click();
  await expect(page.getByRole('menu', { name: '编辑' })).toBeVisible();
  await page.locator('.workspace').click({ position: { x: 600, y: 500 } });
  await expect(page.getByRole('menu', { name: '编辑' })).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath('titlebar-keyboard.png'), fullPage: true });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});