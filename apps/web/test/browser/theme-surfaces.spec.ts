import { expect, test, type Page } from '@playwright/test';

/**
 * Where the design changes a surface, the paint has to change with it.
 *
 * Every surface in this app is derived rather than written down: the palette effect mixes
 * `--panel`, `--panel-soft` and `--panel-raised` out of the background. On the dark theme that
 * works — a black page, a `#0d0d0d` rail and a `#121212` raised row are all a step apart. On the
 * light theme it did not: `--panel-soft` was lifted toward white like everything else, and a
 * `#eef2f1` page has only 13 levels of headroom below white, so all three tokens resolved to
 * `#eff3f2` — the rail sat 1.007:1 against the page behind it, and a selected row's fill was
 * *identical* to the rail it sat on. Hover and selection changed nothing but the inset ring.
 *
 * So this measures the two places the stylesheet expresses a change as a fill — the rail against
 * the page, and a selected row against the rail — and requires a step of at least 4 levels
 * (~1.5%), which is smaller than the 5 the dark theme's own selection already uses.
 *
 * A card is different: it carries a border and a shadow, so it is allowed to be delineated that
 * way rather than by fill (the dark theme happens to use fill as well; the light one does not).
 */

/** 4/255: below the 5-level step the dark theme's selected row already uses. */
const MINIMUM_STEP = 4;

function channels(colour: string): [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(colour);
  if (match === null) throw new Error(`not a colour: ${colour}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The largest per-channel difference, i.e. how many levels of 255 the paint moved. */
function step(from: string, to: string): number {
  const a = channels(from);
  const b = channels(to);
  return Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
}

async function measure(theme: 'dark' | 'light', page: Page): Promise<void> {
  if (theme === 'light') {
    // Set before the bundle runs, which is how a saved preference arrives.
    await page.addInitScript(() => localStorage.setItem('watchdog-theme', 'light'));
  }
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

  const below = await page.evaluate(() => {
    const paint = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow };
    };
    return { page: paint('.app-shell'), rail: paint('.sidebar'), card: paint('.process-table-wrap') };
  });

  // A raised surface is only painted by a selected row, so select one. The row eases its
  // background over .16s, and Chromium reports an interpolated colour (as `oklab(...)`) while
  // that runs, so wait for the transition to settle before reading it.
  await page.locator('.sidebar-row__open').first().click();
  const selected = await page.locator('.sidebar-row.is-selected').evaluate(async (row) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = getComputedStyle(row).backgroundColor;
      if (value.startsWith('rgb')) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return getComputedStyle(row).backgroundColor;
  });

  console.log(
    [
      `${theme}: page ${below.page.background}`,
      `  rail    ${below.rail.background}  (step from page ${step(below.page.background, below.rail.background)})`,
      `  selected row ${selected}  (step from rail ${step(below.rail.background, selected)})`,
      `  card    ${below.card.background}  border ${below.card.border}  shadow ${below.card.shadow === 'none' ? 'none' : 'set'}`,
    ].join('\n'),
  );

  expect(
    step(below.page.background, below.rail.background),
    `the ${theme} rail (${below.rail.background}) is not a visible step from the page (${below.page.background})`,
  ).toBeGreaterThanOrEqual(MINIMUM_STEP);

  expect(
    step(below.rail.background, selected),
    `a selected ${theme} row (${selected}) is the same paint as the rail it sits on (${below.rail.background})`,
  ).toBeGreaterThanOrEqual(MINIMUM_STEP);

  const cardDelineated = step(below.page.background, below.card.background) >= MINIMUM_STEP
    || (below.card.border !== below.page.background && below.card.shadow !== 'none');
  expect(
    cardDelineated,
    `a ${theme} card (${below.card.background}) is neither a step from the page nor bordered and shadowed`,
  ).toBe(true);
}

test('the dark theme paints the page, its rail and a selected row apart', async ({ page }) => {
  await measure('dark', page);
});

test('the light theme paints the page, its rail and a selected row apart', async ({ page }) => {
  await measure('light', page);
});