import { expect, test, type Page } from '@playwright/test';

import { composite, contrast, describeColour, parseColour, round2 } from './paint';

/**
 * A semantic status colour is a literal rather than a derived token — it means something, so a
 * user's background must not move it — and that makes its contrast a function of the surface it is
 * painted on.
 *
 * The light theme's `--green`, `--red` and `--blue` were solved against its panel (`#eff3f2`).
 * Round 1 then made the rail darker than the panel (`--panel-soft`: `#eff3f2` -> `#e3e7e7`) so that
 * the rail and its selection would stop collapsing into one colour, and the app's chips, pills and
 * inputs paint *themselves* with `--panel-soft`. A ready chip's green text went from 4.58:1 to
 * **4.11:1** — below AA, at 10px.
 *
 * So the invariant is checked twice: as a matrix of every status colour against every surface the
 * theme can put behind it, and against the elements the static demo actually paints. A colour may
 * be text on any of those surfaces, so it has to clear AA on all of them.
 *
 * Two measurement traps are handled here, because both produced a wrong number first:
 *
 *   - `sidebar-row-in` animates opacity from 0 for .18s, and a row read mid-animation reported a
 *     blended background (`rgb(185, 188, 188)`) that no rule declares. Measured after the rows
 *     settle to opacity 1.
 *   - A translucent fill (a chip's own `--panel-soft`, a badge's 9% tint) is composited over what
 *     is behind it before any ratio is taken.
 */

/** Text needs AA; a ring, border or dot needs the 3:1 non-text bar. */
const TEXT_RATIO = 4.5;
const NON_TEXT_RATIO = 3;

/** The status colours are read as tokens so the matrix does not depend on the demo's states. */
const STATUS_TOKENS = ['--green', '--red', '--blue'] as const;
const SURFACE_TOKENS = ['--bg', '--panel', '--panel-soft', '--panel-raised'] as const;

/** Elements the demo paints with a status colour, and whether the colour is text or the mark. */
const PAINTED: readonly { readonly selector: string; readonly label: string; readonly kind: 'text' | 'non-text' }[] = [
  { selector: '.state-chip--ready', label: 'a ready state chip', kind: 'text' },
  { selector: '.capability--ready', label: 'a ready capability chip', kind: 'text' },
  { selector: '.button--stop', label: 'the emergency stop button', kind: 'text' },
  /**
   * A green mark rather than text.
   *
   * This was `.status-light.is-online`, which the static demo no longer paints: it says 离线预览 now, because a
   * page with no service behind it should not report a live connection. The sidebar's writable dot is the same
   * `--green` in the same non-text role, so the matrix still covers a filled indicator.
   */
  { selector: '.sidebar-row .process-dot--writable', label: 'a writable process dot', kind: 'non-text' },
  /**
   * The monitor dot, which is the app's third status colour — and the only one whose value is written as a
   * literal fallback rather than a token (`var(--amber, #e6b65b)`), so nothing had ever measured it.
   */
  { selector: '.sidebar-row .process-dot--monitor', label: 'a monitor process dot', kind: 'non-text' },
];

async function openTheme(theme: 'dark' | 'light', page: Page, palette?: Record<string, unknown>): Promise<void> {
  if (palette !== undefined) {
    await page.addInitScript((value) => localStorage.setItem('watchdog-palette', JSON.stringify(value)), palette);
  }
  if (theme === 'light') {
    await page.addInitScript(() => localStorage.setItem('watchdog-theme', 'light'));
  }
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  // `sidebar-row-in` eases opacity from 0; a row read mid-animation reports a blended background.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('.sidebar-row')]
      .every((row) => getComputedStyle(row).opacity === '1')))
    .toBe(true);
}

interface Reading {
  readonly label: string;
  readonly kind: 'text' | 'non-text';
  readonly missing: boolean;
  readonly colour: string;
  readonly layers: string[];
  readonly ratio: number;
}

interface RawReading {
  readonly label: string;
  readonly kind: 'text' | 'non-text';
  readonly missing: boolean;
  readonly colour: string;
  /** The element's own fill, when it has one. */
  readonly own: string | null;
  /** Everything behind the element, outermost composited first. */
  readonly behind: string[];
}

/** One read of every tracked element, as resolved strings. */
async function readPainted(page: Page): Promise<RawReading[]> {
  return page.evaluate((targets) => targets.map(({ selector, label, kind }) => {
    const element = document.querySelector(selector);
    if (element === null) return { label, kind, missing: true, colour: '', own: null, behind: [] };
    const own: string[] = [];
    const behind: string[] = [];
    let node: Element | null = element;
    while (node !== null && own.length + behind.length < 8) {
      const background = getComputedStyle(node).backgroundColor;
      const visible = background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent';
      if (visible) (node === element ? own : behind).push(background);
      // Stop once what is *behind* the element is opaque. The element's own fill is never a reason
      // to stop, or a filled indicator would have nothing behind it to be measured against.
      const parsed = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(background);
      const opaque = parsed !== null && (parsed[4] === undefined || Number(parsed[4]) === 1);
      if (node !== element && visible && opaque) break;
      node = node.parentElement;
    }
    return {
      label,
      kind,
      missing: false,
      colour: getComputedStyle(element).color,
      own: own[0] ?? null,
      behind,
    };
  }), PAINTED.map(({ selector, label, kind }) => ({ selector, label, kind: kind ?? 'text' })));
}

/**
 * Read until two consecutive reads agree.
 *
 * `.button` eases its background over .18s and Chromium reports an interpolated `oklab(…)` while it
 * runs; a mid-transition read is not a colour any rule declares, and compositing it would be
 * compositing a value that never appears on screen.
 */
async function readSettled(page: Page): Promise<RawReading[]> {
  let previous = JSON.stringify(await readPainted(page));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(80);
    const current = JSON.stringify(await readPainted(page));
    if (current === previous) return JSON.parse(current) as RawReading[];
    previous = current;
  }
  return JSON.parse(previous) as RawReading[];
}

function toReading(entry: RawReading): Reading {
  if (entry.missing) {
    return { label: entry.label, kind: entry.kind, missing: true, colour: '', layers: [], ratio: 0 };
  }
  const stack = (values: readonly string[]) => values
    .map((value) => parseColour(value))
    .reduceRight((behind, front) => composite(front, behind));

  // A text colour sits on the element's own fill and everything behind it; a filled indicator is
  // itself the mark, so it is measured against what is behind it.
  const foreground = entry.kind === 'text' ? parseColour(entry.colour) : parseColour(entry.own!);
  const backdrop = stack(entry.kind === 'text' && entry.own !== null ? [entry.own, ...entry.behind] : entry.behind);
  return {
    label: entry.label,
    kind: entry.kind,
    missing: false,
    colour: entry.kind === 'text' ? entry.colour : entry.own!,
    layers: entry.kind === 'text' ? [entry.own ?? '', ...entry.behind].filter(Boolean) : entry.behind,
    ratio: round2(contrast(foreground, backdrop)),
  };
}

async function measure(theme: 'dark' | 'light', page: Page, palette?: Record<string, unknown>): Promise<void> {
  await openTheme(theme, page, palette);

  const tokens = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, [...STATUS_TOKENS, ...SURFACE_TOKENS] as unknown as string[]);

  const painted = (await readSettled(page)).map(toReading);

  console.log(
    [
      `${theme}: status colours against every surface (text needs ${TEXT_RATIO}:1)`,
      ...STATUS_TOKENS.map((status) => `  ${status.padEnd(8)} ${tokens[status]}  ${SURFACE_TOKENS.map((surface) => `${surface.replace('--', '')} ${round2(contrast(parseColour(tokens[status]!), parseColour(tokens[surface]!)))}`).join('   ')}`),
      `${theme}: painted`,
      ...painted.map((entry) => `  ${entry.label.padEnd(26)} ${entry.missing ? '(absent)' : `${entry.colour} on ${entry.layers[0] ?? '?'} -> ${entry.ratio}:1`}`),
    ].join('\n'),
  );

  // 1. A status colour may be used as text on any surface the theme can put behind it.
  const failures: string[] = [];
  for (const status of STATUS_TOKENS) {
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrast(parseColour(tokens[status]!), parseColour(tokens[surface]!));
      if (ratio < TEXT_RATIO) {
        failures.push(`${status} on ${surface}: ${round2(ratio)}:1`);
      }
    }
  }
  expect(failures, `these ${theme} status colours are below AA as text`).toEqual([]);

  // 2. And the elements the demo paints have to agree with that, after compositing.
  for (const entry of painted) {
    expect(entry.missing, `${entry.label} is not rendered, so it was not measured`).toBe(false);
    const bar = entry.kind === 'text' ? TEXT_RATIO : NON_TEXT_RATIO;
    expect(
      entry.ratio,
      `${entry.label} (${describeColour(parseColour(entry.colour))} on ${entry.layers[0] ?? '?'}) is ${entry.ratio}:1 against a ${bar}:1 bar`,
    ).toBeGreaterThanOrEqual(bar);
  }
}

test('the dark theme keeps its status colours readable on every surface', async ({ page }) => {
  await measure('dark', page);
});

test('the light theme keeps its status colours readable on every surface', async ({ page }) => {
  await measure('light', page);
});

test('a custom palette cannot push the status colours or the accent text below AA', async ({ page }) => {
  /**
   * The colours the app owns have to survive a background it did not choose, which is why they are
   * solved against the palette rather than trusted as literals. Measured before that: `#eef2f1`
   * chosen on the dark theme left the dark theme's green status text at **1.81:1** on its own
   * near-white chip and `--accent-strong` at **1.36:1** — both of them text.
   */
  const LIGHT_ON_DARK = {
    dark: { accent: '#e6b65b', background: '#eef2f1', foreground: '#1c262b', contrast: 68 },
  } as const;

  await measure('dark', page, LIGHT_ON_DARK);

  const accent = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      strong: style.getPropertyValue('--accent-strong').trim(),
      panel: style.getPropertyValue('--panel').trim(),
      rail: style.getPropertyValue('--panel-soft').trim(),
    };
  });
  for (const [surface, value] of [['panel', accent.panel], ['rail', accent.rail]] as const) {
    const ratio = round2(contrast(parseColour(accent.strong), parseColour(value)));
    console.log(`  accent-strong ${accent.strong} on the ${surface} ${value} -> ${ratio}:1`);
    expect(
      ratio,
      `--accent-strong (${accent.strong}) is not readable on the ${surface} (${value})`,
    ).toBeGreaterThanOrEqual(TEXT_RATIO);
  }
});