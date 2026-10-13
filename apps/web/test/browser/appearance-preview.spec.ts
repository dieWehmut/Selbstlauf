import { expect, test, type Page } from '@playwright/test';

/**
 * The theme swatch has to be the theme.
 *
 * `ThemePreviewCard` used to derive its own rail and sheet — `mix(background, foreground, 0.1 | 0.05)`
 * and `0.16 | 0.04`, fixed and ignoring `contrast` — while the app derived `--panel-soft` and
 * `--panel` from the background with `weight + contrast / 1400`. Measured on the built-in dark
 * palette, with the dark card the only one that can be compared directly while dark is active:
 *
 *     preview rail  rgb(23, 24, 24)   against a painted #0d0d0d
 *     preview sheet rgb(37, 38, 38)   against a painted #0f0f0f
 *     contrast 68 -> 100 moved the app to #131313 / #151515 and did not move the swatches at all
 *
 * A swatch that does not show the theme it is chosen by is worse than no swatch, and the contrast
 * slider sitting on the same panel made the mismatch visible in one gesture. Both now call
 * `paletteSurfaces`, so this compares what is painted with what is chosen.
 */

/** `#rrggbb` to the form `getComputedStyle` reports, so the two can be compared as strings. */
function toRgb(hex: string): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

async function openAppearance(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: '外观' }).click();
  await expect(page.getByRole('radiogroup', { name: '外观主题' })).toBeVisible();
}

/** What a card shows, and what the app paints for the same palette. */
async function readSwatches(page: Page, card: string): Promise<{
  rail: string;
  sheet: string;
  appRail: string;
  appPanel: string;
  contrast: string;
}> {
  return page.evaluate((label) => {
    const element = document.querySelector(`.theme-preview[aria-label="${label}"]`);
    const paint = (selector: string) => {
      const found = element?.querySelector(selector);
      if (found === null || found === undefined) throw new Error(`no ${selector} in the ${label} card`);
      return getComputedStyle(found).backgroundColor;
    };
    const root = getComputedStyle(document.documentElement);
    const toRgbLocal = (hex: string) => {
      const value = Number.parseInt(hex.replace('#', ''), 16);
      return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
    };
    return {
      rail: paint('.theme-preview__rail'),
      sheet: paint('.theme-preview__sheet'),
      appRail: toRgbLocal(root.getPropertyValue('--panel-soft').trim()),
      appPanel: toRgbLocal(root.getPropertyValue('--panel').trim()),
      contrast: document.querySelector<HTMLInputElement>('.appearance-slider input[type=range]')?.value ?? '',
    };
  }, card);
}

test('the active theme card shows the colours the app paints', async ({ page }) => {
  await openAppearance(page);

  const dark = await readSwatches(page, '深色');
  console.log(`dark card  rail ${dark.rail} vs rail ${dark.appRail}   sheet ${dark.sheet} vs panel ${dark.appPanel}`);
  expect(dark.rail, 'the dark swatch is not the rail the app paints').toBe(dark.appRail);
  expect(dark.sheet, 'the dark swatch is not the panel the app paints').toBe(dark.appPanel);

  // The other theme's card is a preview of a palette that is not on screen, so it is compared with
  // the values that palette resolves to rather than with the current paint.
  const light = await readSwatches(page, '浅色');
  console.log(`light card rail ${light.rail} sheet ${light.sheet}`);
  expect(light.rail, 'the light swatch is not the light palette rail').toBe(toRgb('#e3e7e7'));
  expect(light.sheet, 'the light swatch is not the light palette panel').toBe(toRgb('#eff3f2'));
});

test('the diff follows every choice the list above it offers', async ({ page }) => {
  /**
   * The pane's own docstring says it shows "what the theme ships with against what the current
   * choices resolve to", and it shipped with rows for `surface` (a token *name*), `accent` and
   * `contrast` only — while the list above offers colour pickers for 背景 and 前景. Measured: setting
   * the background to `#fdf6e3` repainted the app (`--bg #fdf6e3`) and left the pane byte-identical.
   */
  await openAppearance(page);

  const panes = () => page.evaluate(() => {
    const text = (selector: string) => (document.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim();
    return { before: text('.theme-diff__pane:not(.theme-diff__pane--after)'), after: text('.theme-diff__pane--after') };
  });

  /** React tracks the last value it saw, so a colour input needs the prototype setter to look edited. */
  const setColour = async (label: string, value: string) => {
    await page.locator(`input[type=color][aria-label="${label}"]`).evaluate((element, next) => {
      const input = element as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(200);
  };

  const initial = await panes();
  // The left pane is the theme's stock palette and must not move when the user customises.
  expect(initial.before, 'the stock pane is not the built-in dark palette').toContain('background: "#000000"');
  expect(initial.before).toContain('foreground: "#e9eef0"');
  expect(initial.after, 'an untouched palette should read the same in both panes').toContain('background: "#000000"');

  await setColour('背景', '#fdf6e3');
  await setColour('前景', '#2b2b2b');
  await page.locator('.appearance-slider input[type=range]').fill('100');
  await page.waitForTimeout(200);

  const changed = await panes();
  console.log(`after: ${changed.after.slice(0, 200)}`);
  expect(changed.after, 'a background choice is missing from the diff').toContain('background: "#fdf6e3"');
  expect(changed.after, 'a foreground choice is missing from the diff').toContain('foreground: "#2b2b2b"');
  expect(changed.after, 'the contrast choice is missing from the diff').toContain('contrast: 100');
  // And the stock pane still shows the stock values, which is what makes it a diff.
  expect(changed.before, 'the stock pane followed the user instead of staying stock').toContain('background: "#000000"');
  expect(changed.before).toContain('foreground: "#e9eef0"');
  expect(changed.before).toContain('contrast: 68');
});

test('both the app and the swatches follow the contrast slider', async ({ page }) => {
  await openAppearance(page);
  const before = await readSwatches(page, '深色');

  await page.locator('.appearance-slider input[type=range]').fill('100');
  await page.waitForTimeout(300);
  const after = await readSwatches(page, '深色');
  console.log(`contrast ${before.contrast} -> ${after.contrast}: rail ${before.appRail} -> ${after.appRail}, swatch ${before.rail} -> ${after.rail}`);

  expect(after.contrast, 'the slider did not move').toBe('100');
  expect(after.appRail, 'the app did not repaint for the new contrast').not.toBe(before.appRail);
  expect(after.rail, 'the swatch did not move with the contrast slider').not.toBe(before.rail);
  // And they still agree, which is the point: the swatch is the paint, at any slider position.
  expect(after.rail).toBe(after.appRail);
  expect(after.sheet).toBe(after.appPanel);
});