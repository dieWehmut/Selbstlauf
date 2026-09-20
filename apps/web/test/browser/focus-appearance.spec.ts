import { expect, test } from '@playwright/test';

/**
 * Keyboard focus: reachable, revealed, and visible.
 *
 * axe does not test any of this. It validates names, roles and contrast, but "can I get here with Tab,
 * can I see where I am, and is the control actually shown" is a different question — and it is exactly
 * the question for the pin control, which is invisible until it is hovered or focused.
 *
 * Three things this file had to get right, all learned by getting them wrong first:
 *
 *  1. **Read the settled value, not the first frame.** The pin fades in over .16s, so reading
 *     `opacity` immediately after pressing Tab reports 0 and looks like an invisible control. It was
 *     not: the settled value is 1. Measuring during a transition is how a probe invents a defect.
 *  2. **Do not click before tabbing.** `:focus-visible` deliberately does not match after a mouse
 *     click, so a sequence that clicks first then tabs measures a different state from the one a
 *     keyboard-only user experiences.
 *  3. **Each test gets a fresh browser context, so a pin does not leak between tests.** Playwright gives
 *     every test its own context, and this was confirmed rather than assumed: a test that pins a row
 *     followed by a test that reads `localStorage` before load shows `null`. The contamination that
 *     appeared once was *within* a single test that navigated twice, not across tests, so no per-spec
 *     cleanup is needed. An earlier version of this file added some, and it was removed once the
 *     isolation had actually been measured.
 */
test('the pin is reachable by keyboard, shown, and usable', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();

  // Tab from a fresh load, never touching the mouse.
  let stops = 0;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    stops += 1;
    if (await page.evaluate(() => document.activeElement?.classList.contains('sidebar-row__pin') ?? false)) break;
  }
  const reached = await page.evaluate(() => document.activeElement?.classList.contains('sidebar-row__pin') ?? false);
  expect(reached, `the pin was not reachable by keyboard within ${stops} tab stops`).toBe(true);

  // Let the fade finish before reading, or the measurement describes a transition frame.
  await page.waitForTimeout(600);
  const shown = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { opacity: Number(s.opacity), width: Math.round(el.getBoundingClientRect().width) };
  });
  expect(shown.opacity, 'a focused pin is invisible to a keyboard user').toBeGreaterThan(0.9);
  expect(shown.width, 'a focused pin has no size').toBeGreaterThan(0);

  // And the keyboard can actually use it.
  await page.keyboard.press('Enter');
  await expect(page.locator('.sidebar-processes__heading', { hasText: '置顶' })).toHaveCount(1);
  const stillFocused = await page.evaluate(() => document.activeElement?.classList.contains('sidebar-row__pin') ?? false);
  expect(stillFocused, 'focus was lost after activating the pin').toBe(true);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the focus ring is visible against the surface it is drawn on, in both themes', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  /**
   * WCAG 2.2 "Focus Appearance" asks for 3:1 between the focused and unfocused states.
   *
   * This is the check that found a real defect: the browser's default ring is `auto 1px rgb(16,16,16)`,
   * and against the dark sidebar (#1a1e22) that is **1.14:1** — present, and effectively invisible. The
   * light theme was fine at 17:01, so only the dark one was broken and only for keyboard users.
   */
  const measurements: { theme: string; ratio: number; ring: string }[] = [];

  for (const theme of ['dark', 'light'] as const) {
    await page.goto('/');
    await page.evaluate((value) => localStorage.setItem('watchdog-theme', value), theme);
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();

    // Focus a control in the sidebar by keyboard, which is where a low-contrast ring is least visible.
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('sidebar-row__pin') ?? false)) break;
    }
    await page.waitForTimeout(300);

    const measured = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      const ring = (s.outlineColor.match(/\d+/gu) ?? []).slice(0, 3).map(Number);
      let node: Element | null = el;
      let bg: number[] | null = null;
      while (node) {
        const parts = (getComputedStyle(node).backgroundColor.match(/[\d.]+/gu) ?? []).map(Number);
        if (parts.length >= 3 && (parts[3] ?? 1) >= 0.99) { bg = parts.slice(0, 3); break; }
        node = node.parentElement;
      }
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      if (bg === null) return null;
      const [hi, lo] = [lum(ring), lum(bg)].sort((x, y) => y - x);
      return { ratio: (hi + 0.05) / (lo + 0.05), ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    });

    expect(measured, `no focus ring could be measured in the ${theme} theme`).not.toBeNull();
    measurements.push({ theme, ratio: Math.round(measured!.ratio * 100) / 100, ring: measured!.ring });
  }

  for (const m of measurements) {
    expect(
      m.ratio,
      `the ${m.theme} focus ring is ${m.ring} at ${m.ratio}:1 against its surface — under the 3:1 minimum, so a keyboard user cannot see where focus is`,
    ).toBeGreaterThanOrEqual(3);
  }

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});