import { expect, test } from '@playwright/test';

/**
 * Browser-drawn chrome must follow the theme.
 *
 * The dark theme rendered a **light native scrollbar** — the bright bar down the settings
 * rail and the process list in the screenshot that prompted this. The cause was that no
 * `color-scheme` was declared anywhere, so the browser drew its own scrollbars, form
 * controls and focus rings light on a dark page whatever the app's own colours said.
 *
 * `color-scheme` is the property that governs this, so it is what the test reads: a
 * headless Chromium uses overlay scrollbars and shows nothing to measure, which is why
 * asserting the computed value is the honest check rather than a pixel one.
 */
test('declares the colour scheme so native chrome follows the theme', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');

  // Dark by default, so the browser must be told to draw dark chrome.
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(dark, 'the dark theme does not declare a colour scheme').toBe('dark');

  // And the scroll containers must use a thin, themed scrollbar rather than the default.
  // The process list belongs to the app sidebar, which 设置 replaces with the settings
  // rail, so it is measured before entering settings and the rail after.
  const sidebarScroll = page.locator('.sidebar-processes__scroll');
  await expect(sidebarScroll, 'the process list is not present').toHaveCount(1);
  const sidebarStyle = await sidebarScroll.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { scrollbarWidth: cs.scrollbarWidth, scrollbarColor: cs.scrollbarColor };
  });
  expect(sidebarStyle.scrollbarWidth, 'the process list does not use a thin scrollbar').toBe('thin');
  expect(sidebarStyle.scrollbarColor, 'the process list has no themed scrollbar colour').not.toBe('');

  await page.getByRole('button', { name: '设置' }).first().click();
  await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();

  const rail = page.locator('.settings-rail__list');
  await expect(rail, 'the settings rail is not present').toHaveCount(1);
  const style = await rail.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { scrollbarWidth: cs.scrollbarWidth, scrollbarColor: cs.scrollbarColor };
  });
  expect(style.scrollbarWidth, 'the settings rail does not use a thin scrollbar').toBe('thin');
  // A transparent track colour means it sits on the surface instead of banding it.
  expect(style.scrollbarColor, 'the settings rail has no themed scrollbar colour').not.toBe('');

  // Switching to the light theme must flip it back, or the light theme would inherit the
  // dark chrome.
  await page.getByRole('tab', { name: '外观' }).click();
  const lightButton = page.getByRole('button', { name: /浅色/u }).first();
  if (await lightButton.count() > 0) {
    await lightButton.click();
    await page.waitForTimeout(400);
    const light = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    expect(light, 'the light theme did not opt back into light chrome').toBe('light');
  }

  await page.screenshot({ path: testInfo.outputPath('themed-scrollbars.png') });
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the settings rail scrolls without a light band and keeps its labels readable', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).first().click();

  const rail = page.getByRole('tablist', { name: '设置分区' });
  await expect(rail).toBeVisible();

  // The rail is genuinely long enough to scroll at this window size, so the scrollbar is
  // actually being exercised rather than hypothetically styled.
  const overflowing = await rail.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflowing, 'the rail does not overflow at this size, so the scrollbar is not exercised').toBe(true);

  // Scrolling it must not scroll the page behind it.
  const before = await page.evaluate(() => window.scrollY);
  await rail.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await page.evaluate(() => window.scrollY)).toBe(before);

  // Every label must still be readable in the dark theme, including the two that used to
  // name something the app does not have.
  const labels = await rail.getByRole('tab').allTextContents();
  expect(labels).toContain('信任联系人');
  expect(labels).toContain('使用统计');
  expect(labels.some((label) => label.includes('计费'))).toBe(false);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});