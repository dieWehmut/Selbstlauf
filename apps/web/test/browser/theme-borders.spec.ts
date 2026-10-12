import { expect, test, type Page } from '@playwright/test';

import { composite, contrast, levels, parseColour, round2 } from './paint';

/**
 * The line tokens have to be ordered the way they are named.
 *
 * `--line` is only ever used through its translucent children (`--line-soft`, `--line-whisper`),
 * so nothing paints it directly; `--line-strong` is the opaque one, and it paints exactly two
 * things: an icon button's hover border and the scrollbar thumb.
 *
 * It was a literal in each `:root` block, and in the light theme it was `#bac9c4` against a
 * `--line` of `#b7bdbd` — the "strong" line was the *lighter* of the two, i.e. the pair said the
 * opposite of what it meant. The inversion had no visible effect while `--line` fed only
 * translucent children, so this is measured, not assumed: a hover border drawn with the literal
 * still came out stronger than the rest state, and the fix is justified by how much stronger it
 * should be (and because the literal was the one colour a custom palette did not move).
 *
 * So two things are pinned here: the *painted* rest-vs-hover affordance on a real button, and the
 * token ordering that the affordance is built from.
 */

const REFRESH = '.icon-button[aria-label="刷新"]';

async function openTheme(theme: 'dark' | 'light', page: Page): Promise<void> {
  if (theme === 'light') {
    await page.addInitScript(() => localStorage.setItem('watchdog-theme', 'light'));
  }
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator(REFRESH)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** A button's border and everything under it, read while it is in the given state. */
async function readButton(page: Page): Promise<{ border: string; background: string; behind: string; panelRaised: string }> {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector)!;
    const style = getComputedStyle(button);
    return {
      border: style.borderTopColor,
      background: style.backgroundColor,
      // The topbar is `color-mix(in srgb, var(--bg) 88%, transparent)` over the workspace, so
      // what shows through the button's transparent background is the page itself.
      behind: getComputedStyle(document.querySelector('.topbar')!).backgroundColor,
      panelRaised: style.getPropertyValue('--panel-raised').trim()
        || getComputedStyle(document.documentElement).getPropertyValue('--panel-raised').trim(),
    };
  }, REFRESH);
}

/** Wait out the .16s border/background easing so the read colour is the settled one. */
async function settle(page: Page): Promise<void> {
  let previous = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = (await readButton(page)).border;
    if (current === previous) return;
    previous = current;
    await page.waitForTimeout(60);
  }
}

async function measure(theme: 'dark' | 'light', page: Page): Promise<void> {
  await openTheme(theme, page);

  const rest = await readButton(page);
  await page.locator(REFRESH).hover();
  await settle(page);
  const hover = await readButton(page);

  // What is behind the border: the topbar's own fill, itself translucent over the page.
  const pageColour = await page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!).backgroundColor);
  const behind = composite(parseColour(rest.behind), parseColour(pageColour));

  const restBorder = composite(parseColour(rest.border), behind);
  const hoverBackdrop = composite(parseColour(hover.background), behind);
  const hoverBorder = composite(parseColour(hover.border), hoverBackdrop);

  const root = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      line: style.getPropertyValue('--line').trim(),
      strong: style.getPropertyValue('--line-strong').trim(),
      panelRaised: style.getPropertyValue('--panel-raised').trim(),
    };
  });

  const restRatio = round2(contrast(restBorder, behind));
  const hoverRatio = round2(contrast(hoverBorder, hoverBackdrop));

  console.log(
    [
      `${theme}: icon button border`,
      `  rest   ${rest.border} over ${rest.behind}  -> ${restRatio}:1`,
      `  hover  ${hover.border} over ${hover.background}  -> ${hoverRatio}:1`,
      `  --line ${root.line}   --line-strong ${root.strong}   (levels from --panel-raised ${root.panelRaised}:`,
      `   ${levels(parseColour(root.line), parseColour(root.panelRaised))} vs`,
      `   ${levels(parseColour(root.strong), parseColour(root.panelRaised))})`,
    ].join('\n'),
  );

  // 1. Hovering strengthens the border rather than hiding it.
  expect(
    hoverRatio,
    `the ${theme} hover border (${hoverRatio}:1) is no stronger than the rest border (${restRatio}:1)`,
  ).toBeGreaterThan(restRatio);

  // 2. And the token it is drawn from is a further step than the base line, which is what "strong"
  //    means — this is the assertion the inverted light-theme literal failed.
  const raised = parseColour(root.panelRaised);
  expect(
    levels(parseColour(root.strong), raised),
    `the ${theme} --line-strong (${root.strong}) is not a further step from a raised surface than --line (${root.line})`,
  ).toBeGreaterThan(levels(parseColour(root.line), raised));
}

test('the dark theme strengthens an icon button border on hover', async ({ page }) => {
  await measure('dark', page);
});

test('the light theme strengthens an icon button border on hover', async ({ page }) => {
  await measure('light', page);
});