import { expect, test, type Page } from '@playwright/test';

/**
 * The saved theme has to be known before the bundle runs.
 *
 * The preference and palette live in localStorage and were read only by the app, so the stylesheet's
 * own `:root` literals — the dark ones — painted the first frame. Measured against the built app with
 * the bundle blocked and a light palette saved: html and body `rgb(0, 0, 0)`, `color-scheme: dark`,
 * `--bg #000000`, `data-theme` unset. Every launch of a light-theme user opened black and corrected
 * itself, and the desktop shell reveals its window on first paint, so that frame is what is seen.
 *
 * `public/theme-boot.js` fixes it, in the head and before the bundle. It is a file rather than an
 * inline `<script>` because the service sends `script-src 'self'`; an inline block is blocked in the
 * packaged app.
 *
 * These cases hold the bundle back so the assertion is about the pre-bundle state itself, and the
 * last one lets it run to check the script and the app agree.
 */

interface BootState {
  readonly theme: string;
  readonly bg: string;
  readonly text: string;
  readonly accent: string;
}

const LIGHT_PALETTE = {
  light: { accent: '#e05c93', background: '#fdf6e3', foreground: '#2b2b2b', contrast: 68 },
};

/** Loads with the bundle blocked, so what is read is exactly what paints before the app starts. */
async function readBeforeTheBundle(
  page: Page,
  saved: { readonly theme?: string; readonly palette?: string },
): Promise<BootState> {
  await page.addInitScript((value) => {
    if (value.theme !== undefined) localStorage.setItem('watchdog-theme', value.theme);
    if (value.palette !== undefined) localStorage.setItem('watchdog-palette', value.palette);
  }, saved);
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''), {
      message: 'the theme is not set before the bundle: nothing paints it but the stylesheet',
    })
    .not.toBe('');
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.dataset.theme ?? '',
      bg: style.getPropertyValue('--bg').trim(),
      text: style.getPropertyValue('--text').trim(),
      accent: style.getPropertyValue('--accent').trim(),
    };
  });
}

test('a saved light theme and palette are applied before the bundle runs', async ({ page }) => {
  const state = await readBeforeTheBundle(page, { theme: 'light', palette: JSON.stringify(LIGHT_PALETTE) });
  expect(state.theme).toBe('light');
  expect(state.bg, 'the saved background is not the first paint').toBe('#fdf6e3');
  expect(state.text).toBe('#2b2b2b');
  expect(state.accent).toBe('#e05c93');
});

test('a saved dark theme is applied before the bundle runs', async ({ page }) => {
  const state = await readBeforeTheBundle(page, { theme: 'dark' });
  expect(state.theme).toBe('dark');
  expect(state.bg).toBe('');
});

test('the system preference decides what the first frame paints', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await readBeforeTheBundle(page, { theme: 'system' });
  expect(light.theme, 'a light system with the system preference selected').toBe('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await readBeforeTheBundle(page, { theme: 'system' });
  expect(dark.theme, 'a dark system with the system preference selected').toBe('dark');
});

test('an unreadable saved preference resolves the way the app resolves it', async ({ page }) => {
  /**
   * The app sanitises `watchdog-theme` to `dark` for anything it does not recognise, rather than
   * falling back to the system preference. A boot script that fell back to the system would paint
   * one theme and be corrected to another on a light machine — so this pins the two together.
   */
  await page.emulateMedia({ colorScheme: 'light' });
  const state = await readBeforeTheBundle(page, { theme: 'banana', palette: '{not json' });
  expect(state.theme, 'an unknown preference must resolve to dark, as the app resolves it').toBe('dark');
  expect(state.bg, 'an unreadable palette must not be applied').toBe('');
});

test('the boot script and the app agree once the bundle has run', async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('watchdog-theme', 'light');
    localStorage.setItem('watchdog-palette', value);
  }, JSON.stringify(LIGHT_PALETTE));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();

  const after = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.dataset.theme ?? '',
      bg: style.getPropertyValue('--bg').trim(),
      painted: getComputedStyle(document.querySelector('.app-shell')!).backgroundColor,
    };
  });
  expect(after.theme, 'the app disagreed with the first frame about the theme').toBe('light');
  expect(after.bg, 'the app disagreed with the first frame about the background').toBe('#fdf6e3');
  // The custom background has to reach the paint, not just the token.
  expect(after.painted).toBe('rgb(253, 246, 227)');
});