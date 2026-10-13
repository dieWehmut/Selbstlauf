/**
 * Colour decisions that belong to the *palette*, not to the theme.
 *
 * The palette effect derives a dozen colours from the background and foreground the user chose. Two
 * of those decisions are directional — which way a recessed surface steps, and which way a stronger
 * accent is pushed — and the direction is a property of the palette: the appearance section lets
 * anyone put a light background on the dark theme, which is enough to invert every assumption a
 * theme name carries.
 */

/** True for `#rrggbb`; anything else is rejected rather than partially read. */
const HEX = /^#[0-9a-f]{6}$/iu;

function channels(colour: string): readonly [number, number, number] {
  if (!HEX.test(colour)) throw new TypeError(`not a #rrggbb colour: ${colour}`);
  return [
    Number.parseInt(colour.slice(1, 3), 16),
    Number.parseInt(colour.slice(3, 5), 16),
    Number.parseInt(colour.slice(5, 7), 16),
  ];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(colour: string): number {
  const linear = channels(colour).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG contrast ratio between two opaque colours, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/**
 * True when the colour sits on the light half of the scale.
 *
 * This is the question the palette effect has to ask instead of "which theme is selected": a
 * `#eef2f1` background chosen on the dark theme is a light page, and every surface on it has to be
 * derived the way a light page's surfaces are.
 */
export function isLight(colour: string): boolean {
  return relativeLuminance(colour) > 0.5;
}