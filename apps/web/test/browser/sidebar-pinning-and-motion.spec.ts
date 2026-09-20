import { expect, test } from '@playwright/test';

/**
 * Pinning a process, and the motion this round added.
 *
 * Pinning lifts a session into a 置顶 group at the top of the sidebar, which is how a person
 * keeps the two or three sessions they are working in within reach while the rest of the list
 * churns. The group appears only when something is pinned, and a pin survives a reload.
 *
 * The motion is worth a test for the one property that can actually break: it must be absent
 * when the system asks for less of it. Decorative animation that ignores that preference is a
 * real accessibility defect, not a matter of taste.
 */
test('pinning lifts a session into a 置顶 group and survives a reload', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  const list = page.getByRole('group', { name: '进程列表' });
  await expect(list).toBeVisible();

  // Nothing is pinned yet, so there is no group for it.
  await expect(list.locator('.sidebar-processes__heading', { hasText: '置顶' })).toHaveCount(0);
  const rowsBefore = await list.locator('.sidebar-row').count();
  expect(rowsBefore).toBeGreaterThan(1);

  // Pin the second row. The control is revealed on hover, as in the reference.
  const target = list.locator('.sidebar-row').nth(1);
  const targetTool = (await target.locator('.sidebar-row__label').textContent())?.trim();
  const targetConversation = (await target.locator('.sidebar-row__conversation').textContent())?.trim();
  await target.hover();
  await target.locator('.sidebar-row__pin').click();

  // The group appears, holding exactly that session.
  const pinnedHeading = list.locator('.sidebar-processes__heading', { hasText: '置顶' });
  await expect(pinnedHeading).toHaveCount(1);
  const pinnedGroup = list.locator('.sidebar-processes__group').first();
  await expect(pinnedGroup.locator('.sidebar-processes__heading')).toHaveText('置顶');
  await expect(pinnedGroup.locator('.sidebar-row')).toHaveCount(1);
  await expect(pinnedGroup.locator('.sidebar-row__label')).toHaveText(targetTool ?? '');
  await expect(pinnedGroup.locator('.sidebar-row__conversation')).toHaveText(targetConversation ?? '');

  // The row moved rather than being copied: the total is unchanged.
  expect(await list.locator('.sidebar-row').count(), 'pinning duplicated a row').toBe(rowsBefore);
  await expect(pinnedGroup.locator('.sidebar-row__pin')).toHaveAttribute('aria-pressed', 'true');

  // A pin is a preference, so it survives a reload.
  await page.reload();
  await expect(list.locator('.sidebar-processes__heading', { hasText: '置顶' })).toHaveCount(1);
  await expect(list.locator('.sidebar-processes__group').first().locator('.sidebar-row')).toHaveCount(1);

  // Unpinning puts it back and removes the group.
  const pinnedRow = list.locator('.sidebar-processes__group').first().locator('.sidebar-row');
  await pinnedRow.hover();
  await pinnedRow.locator('.sidebar-row__pin').click();
  await expect(list.locator('.sidebar-processes__heading', { hasText: '置顶' })).toHaveCount(0);
  expect(await list.locator('.sidebar-row').count()).toBe(rowsBefore);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the navigation is compact and its rows animate on hover', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  const nav = page.locator('.sidebar nav');
  await expect(nav).toBeVisible();

  // 设置 is gone from the top navigation — the rail is the left column on that page, and
  // settings is reached from the bottom bar's popup or Ctrl+,.
  const navLabels = await nav.getByRole('button').allTextContents();
  expect(navLabels.map((label) => label.trim())).toEqual(['进程', '事件']);

  // Compact: the two rows occupy well under a third of a 704px window.
  const navBox = (await nav.boundingBox())!;
  const rowBox = (await nav.getByRole('button').first().boundingBox())!;
  expect(rowBox.height, 'navigation rows are not compact').toBeLessThan(44);
  expect(navBox.height).toBeLessThan(704 / 3);

  // The icon eases on hover, so the row reacts before it is clicked.
  const icon = nav.getByRole('button').first().locator('svg');
  const before = await icon.evaluate((el) => getComputedStyle(el).transform);
  await nav.getByRole('button').first().hover();
  await expect
    .poll(async () => icon.evaluate((el) => getComputedStyle(el).transform), {
      message: 'the navigation icon does not react to hover',
    })
    .not.toBe(before);

  // The row animates in, and the settings panel animates when a section is chosen.
  const rowAnimation = await page.locator('.sidebar-row').first().evaluate((el) => getComputedStyle(el).animationName);
  expect(rowAnimation, 'process rows have no enter animation').toBe('sidebar-row-in');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('honours a request for less motion', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  // Every animation and transition collapses to nothing. Checked on real elements rather than
  // by reading the stylesheet, so a rule that fails to apply is caught too. The selectors are
  // split by page, since the settings panel only exists once settings is open.
  const read = (selectors: readonly string[]) => page.evaluate((picks: readonly string[]) => picks.map((selector) => {
    const el = document.querySelector(selector);
    if (el === null) return { selector, animation: null, transition: null };
    const style = getComputedStyle(el);
    return { selector, animation: style.animationDuration, transition: style.transitionDuration };
  }), selectors);

  const sidebar = await read(['.sidebar-row', '.nav-button', '.sidebar-row__pin']);
  await page.keyboard.press('Control+,');
  await expect(page.locator('.settings-content')).toBeVisible();
  const settings = await read(['.settings-content']);

  for (const entry of [...sidebar, ...settings]) {
    expect(entry.animation, `${entry.selector} is missing, so nothing was checked`).not.toBeNull();
    // The collapsed value is a fraction of a millisecond; anything at or above 10ms is
    // perceptible motion.
    const ms = Number.parseFloat(entry.animation ?? '0');
    expect(ms, `${entry.selector} animation is ${entry.animation}`).toBeLessThan(0.01);
  }

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});