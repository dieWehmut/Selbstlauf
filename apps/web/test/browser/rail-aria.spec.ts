import { expect, test } from '@playwright/test';

/**
 * The settings rail declares `role="tablist"` with `role="tab"` children, so it is
 * claiming to implement the WAI-ARIA tabs pattern. That pattern requires two things:
 * arrow keys move between tabs, and only one tab sits in the page tab order (a
 * roving tabindex). Neither was implemented or checked.
 *
 * The practical effect is that a keyboard user must press Tab once per section — 18
 * times — to reach the last one, and the arrow keys do nothing on a control that
 * announces itself as a tab list.
 */
test('the settings rail behaves like the tablist it declares itself to be', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();

  const rail = page.getByRole('tablist', { name: '设置分区' });
  const tabs = rail.getByRole('tab');
  await expect(tabs).toHaveCount(18);

  const state = () => tabs.evaluateAll((els) => els.map((el, index) => ({
    index,
    label: el.textContent?.trim(),
    tabIndex: el.tabIndex,
    selected: el.getAttribute('aria-selected') === 'true',
    focused: el === document.activeElement,
  })));

  // 1. Roving tabindex: exactly one tab may be in the page tab order.
  const before = await state();
  const inTabOrder = before.filter((t) => t.tabIndex >= 0);
  expect(
    inTabOrder.length,
    `all ${inTabOrder.length} tabs are in the page tab order, so reaching the last `
    + 'section costs one Tab press per section',
  ).toBe(1);
  // And the one in the tab order must be the selected tab.
  expect(inTabOrder[0].selected, 'the tab in the page tab order is not the selected one').toBe(true);

  // 2. Arrow keys move the selection.
  await tabs.first().focus();
  const selectedStart = (await state()).find((t) => t.selected);
  expect(selectedStart?.index).toBe(0);

  await page.keyboard.press('ArrowDown');
  const afterDown = (await state()).find((t) => t.selected);
  expect(afterDown?.index, 'ArrowDown did not move to the next section').toBe(1);
  expect(afterDown?.focused, 'focus did not follow the arrow key').toBe(true);

  await page.keyboard.press('ArrowUp');
  expect((await state()).find((t) => t.selected)?.index, 'ArrowUp did not move back').toBe(0);

  // 3. Home and End jump to the ends, which the pattern also requires.
  await page.keyboard.press('End');
  const afterEnd = (await state()).find((t) => t.selected);
  expect(afterEnd?.index, 'End did not move to the last section').toBe(17);

  await page.keyboard.press('Home');
  expect((await state()).find((t) => t.selected)?.index, 'Home did not return to the first').toBe(0);

  // 4. The arrow keys must not move focus out of the rail.
  const focusedNow = (await state()).find((t) => t.focused);
  expect(focusedNow, 'focus left the rail after the arrow keys').toBeDefined();

  await page.screenshot({ path: testInfo.outputPath('rail-keyboard.png'), fullPage: true });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});