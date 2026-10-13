import { describe, expect, it } from 'vitest';

import { contrastRatio, isLight, mix, readableText, relativeLuminance } from '../src/theme/palette';

/**
 * The palette's own direction, which the palette effect needs and the theme name cannot answer.
 *
 * The appearance section lets the user choose any background, so a background's lightness is a
 * property of the palette rather than of the theme it was chosen in. These helpers are what the
 * effect now asks instead of `theme === 'dark'`.
 */
describe('palette colour maths', () => {
  it('measures relative luminance the WCAG way', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    // The built-in light page, and a mid grey, which is *not* on the light half despite looking it.
    expect(relativeLuminance('#eef2f1')).toBeCloseTo(0.88, 2);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.216, 3);
  });

  it('measures contrast between two colours, symmetrically', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#e3e7e7', '#e3e7e7')).toBe(1);
    // The value the light rail's --faint was solved against, quoted in the stylesheet.
    expect(contrastRatio('#5f686a', '#e3e7e7')).toBeCloseTo(4.59, 2);
  });

  it('calls the two built-in backgrounds what their themes are', () => {
    expect(isLight('#000000'), 'the dark theme background').toBe(false);
    expect(isLight('#eef2f1'), 'the light theme background').toBe(true);
  });

  it('answers for the colour, not for the theme it was chosen in', () => {
    // The defect this exists for: #eef2f1 is a light page even when the dark theme is selected, and
    // the surfaces on it have to be derived the way a light page's surfaces are.
    expect(isLight('#eef2f1')).toBe(true);
    expect(isLight('#101820')).toBe(false);
    expect(isLight('#0f0f0f')).toBe(false);
  });

  it('refuses a colour it cannot read rather than guessing at one', () => {
    expect(() => relativeLuminance('rgb(1, 2, 3)')).toThrow(/not a #rrggbb/u);
    expect(() => isLight('')).toThrow(/not a #rrggbb/u);
  });
});

/**
 * The colours the app owns have to survive a background it did not choose.
 *
 * The built-in values are solved for the built-in surfaces, and the appearance section accepts any
 * background: measured, a light page chosen on the dark theme left the dark theme's green status
 * text at 1.81:1 on a near-white chip and `--accent-strong` at 1.36:1 — both used as text.
 */
describe('readable text colours', () => {
  const DARK_SURFACES = ['#000000', '#0d0d0d', '#0f0f0f', '#121212'];
  const LIGHT_SURFACES = ['#eef2f1', '#e3e7e7', '#eff3f2'];

  it('leaves a colour that already clears the bar exactly as it is', () => {
    // Every built-in status colour, so nothing about the built-in palettes moves.
    for (const colour of ['#74c69d', '#e98b81', '#83b9d4']) {
      expect(readableText(colour, DARK_SURFACES), colour).toBe(colour);
    }
    for (const colour of ['#206f50', '#a74339', '#2b6983']) {
      expect(readableText(colour, LIGHT_SURFACES), colour).toBe(colour);
    }
  });

  it('darkens a light-page colour that cannot be read, until it can', () => {
    // The dark theme's green on a light page: 1.81:1 as painted.
    const fixed = readableText('#74c69d', LIGHT_SURFACES);
    expect(fixed).not.toBe('#74c69d');
    expect(fixed, `${fixed} is still unreadable`).toMatch(/^#[0-9a-f]{6}$/u);
    for (const surface of LIGHT_SURFACES) {
      expect(contrastRatio(fixed, surface), `${fixed} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('brightens a dark-page colour that cannot be read', () => {
    const fixed = readableText('#206f50', DARK_SURFACES);
    expect(fixed).not.toBe('#206f50');
    for (const surface of DARK_SURFACES) {
      expect(contrastRatio(fixed, surface), `${fixed} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks the end that can actually reach the bar on a mid-grey page', () => {
    // White cannot clear 4.5:1 against a mid grey (3.95:1 at best), so the direction has to be black.
    const midGrey = ['#808080', '#8a8a8a'];
    const fixed = readableText('#74c69d', midGrey);
    for (const surface of midGrey) {
      expect(contrastRatio(fixed, surface), `${fixed} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(relativeLuminance(fixed), 'the fixed colour should have gone darker').toBeLessThan(relativeLuminance('#74c69d'));
  });

  it('honours the target it is given', () => {
    // The status colours ask for 4.8 so a 9% wash of themselves behind them cannot eat the margin.
    const fixed = readableText('#74c69d', LIGHT_SURFACES, 4.8);
    for (const surface of LIGHT_SURFACES) {
      expect(contrastRatio(fixed, surface)).toBeGreaterThanOrEqual(4.8);
    }
  });

  it('blends the way the palette effect does', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#eef2f1', '#1c262b', 0)).toBe('#eef2f1');
    expect(mix('#eef2f1', '#1c262b', 1)).toBe('#1c262b');
  });
});