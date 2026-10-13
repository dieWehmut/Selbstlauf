import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { levels, parseColour } from './paint';

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
 *
 * The second half compares the two sides of the same coin: the *literals* each `:root` block
 * ships are what the window paints before the bundle runs, so each one has to equal the colour the
 * renderer resolves for that theme. They did not: the move to a pure-black dark page left the
 * block's blue-greys (`#141b20` …) describing a palette that no longer existed, a flash of the
 * wrong colour on every launch. And since a literal is only a *default*, the last test sets a
 * custom palette and requires every one of the tokens — including the opaque line — to move with
 * it.
 */

const CSS = readFileSync(fileURLToPath(new URL('../../src/styles/index.css', import.meta.url)), 'utf8');

/** The colour tokens the palette effect writes, and therefore every literal that must match it. */
const APPLIED_TOKENS = [
  '--bg',
  '--text',
  '--panel',
  '--panel-soft',
  '--panel-raised',
  '--line',
  '--line-strong',
  '--accent',
  '--accent-strong',
] as const;

/** 4/255: below the 5-level step the dark theme's selected row already uses. */
const MINIMUM_STEP = 4;

/**
 * The semantic colours. They are not derived from the palette — they mean something — but the effect
 * does solve them against it, so they are compared with the literals separately from the tokens above.
 */
const STATUS_TOKENS = ['--green', '--red', '--blue'] as const;

/** The custom properties a block in index.css declares. */
function literals(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`index.css has no ${selector} block`);
  const body = CSS.slice(start, CSS.indexOf('}', start));
  const declared: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[a-z-]+):\s*([^;]+);/gu)) declared[name!] = value!.trim();
  return declared;
}

async function openTheme(theme: 'dark' | 'light', page: Page, palette?: Record<string, unknown>): Promise<void> {
  if (palette !== undefined) {
    // How a saved custom palette arrives: before the bundle runs.
    await page.addInitScript((value) => localStorage.setItem('watchdog-palette', JSON.stringify(value)), palette);
  }
  if (theme === 'light') {
    // Set before the bundle runs, which is how a saved preference arrives.
    await page.addInitScript(() => localStorage.setItem('watchdog-theme', 'light'));
  }
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** The largest per-channel difference between two resolved colours, i.e. how far the paint moved. */
function step(from: string, to: string): number {
  return levels(parseColour(from), parseColour(to));
}

async function measure(theme: 'dark' | 'light', page: Page, palette?: Record<string, unknown>): Promise<void> {
  await openTheme(theme, page, palette);

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

test('a light background chosen on the dark theme is treated as a light page', async ({ page }) => {
  /**
   * The surfaces' direction is the palette's, not the theme's.
   *
   * This used to branch on `theme === 'dark'`, which is only equivalent while the two built-in
   * palettes are the only ones in use. The appearance section accepts any background, so with
   * `#eef2f1` chosen on the dark theme every surface collapsed back to `#eff3f2` — measured rail
   * against page 1.007:1, and a selected row identical to the rail it sits on — which is the defect
   * round 1 fixed, re-entered through the custom-palette door.
   */
  const LIGHT_ON_DARK = {
    dark: { accent: '#e6b65b', background: '#eef2f1', foreground: '#1c262b', contrast: 68 },
  } as const;

  await measure('dark', page, LIGHT_ON_DARK);
});

/** The colours every token resolves to on the document root, i.e. what the renderer paints with. */
async function readAppliedTokens(page: Page, tokens: readonly string[] = APPLIED_TOKENS): Promise<Record<string, string>> {
  return page.evaluate(
    (names) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((token) => [token, style.getPropertyValue(token).trim().toLowerCase()]));
    },
    tokens as unknown as string[],
  );
}

test('the built-in palettes keep the status colours the stylesheet ships', async ({ page }) => {
  /**
   * The status colours are solved against the palette now, but the solving is a no-op when the colour
   * already clears AA — which is why no built-in colour moved. Without this, a change that quietly
   * darkened the built-in green would still pass every contrast assertion, because "legible" is all
   * they ask for.
   */
  for (const theme of ['dark', 'light'] as const) {
    await openTheme(theme, page);
    const applied = await readAppliedTokens(page, STATUS_TOKENS);
    const declared = literals(theme === 'dark' ? ':root' : ":root[data-theme='light']");
    for (const token of STATUS_TOKENS) {
      expect(applied[token], `${theme} ${token} moved off the shipped value`).toBe(declared[token]?.toLowerCase());
    }
  }
});

test('every first-paint literal is the colour the renderer paints, in both themes', async ({ page }) => {
  const mismatches: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await openTheme(theme, page);
    const applied = await readAppliedTokens(page);
    const declared = literals(theme === 'dark' ? ':root' : ":root[data-theme='light']");

    console.log(
      [`${theme}: stylesheet literal vs renderer`]
        .concat(APPLIED_TOKENS.map((token) => `  ${token.padEnd(15)} ${declared[token] ?? '(missing)'}  ${applied[token]}`))
        .join('\n'),
    );

    for (const token of APPLIED_TOKENS) {
      if (declared[token]?.toLowerCase() !== applied[token]) {
        mismatches.push(`${theme} ${token}: stylesheet ${declared[token] ?? '(missing)'} vs renderer ${applied[token]}`);
      }
    }
  }
  expect(
    mismatches,
    'a literal in index.css disagrees with the colour the renderer resolves, so the first paint is wrong',
  ).toEqual([]);
});

test('a custom palette moves every colour token, including the opaque line', async ({ page }) => {
  /**
   * A literal in a `:root` block is a *default*, not a decision: the appearance section lets the
   * user set a background, a foreground, an accent and a contrast, and every colour has to follow
   * them. `--line-strong` was the one that did not — the palette effect never wrote it — so a
   * custom palette moved the other eight tokens and left this one at the built-in dark palette's
   * blue-grey `#39464d`, which is where an icon button's hover border and the scrollbar thumb get
   * their colour from.
   */
  await openTheme('dark', page);
  const builtIn = await readAppliedTokens(page);

  await page.addInitScript(() => {
    localStorage.setItem(
      'watchdog-palette',
      JSON.stringify({ dark: { accent: '#4c9cd4', background: '#101820', foreground: '#e8f0f8', contrast: 90 } }),
    );
  });
  await page.reload();
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  const custom = await readAppliedTokens(page);

  console.log(
    ['custom palette vs built-in dark:']
      .concat(APPLIED_TOKENS.map((token) => `  ${token.padEnd(15)} ${builtIn[token]}  ${custom[token]}`))
      .join('\n'),
  );

  const stuck = APPLIED_TOKENS.filter((token) => custom[token] === builtIn[token]);
  expect(stuck, 'these tokens ignored the custom palette and stayed at the built-in value').toEqual([]);
});