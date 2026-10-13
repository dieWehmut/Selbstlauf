import { describe, expect, it } from 'vitest';

import { contrastRatio, isLight, relativeLuminance } from '../src/theme/palette';

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