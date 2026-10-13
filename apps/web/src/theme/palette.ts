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

/** Blend `from` toward `to` by `amount`, the same arithmetic the palette effect uses. */
export function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((value, index) => Math.round(value + (b[index]! - value) * amount).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The nearest colour to `colour` that clears `target` against every surface it can be painted on.
 *
 * This is for the colours the *app* owns rather than the ones the user chose: a status colour that
 * means "writable" has to be readable on whatever background it lands on, and `--accent-strong` is
 * text (the active rail entry, the prompt chips). A literal cannot promise that — the built-in
 * values are solved for the built-in surfaces, and the appearance section accepts any background —
 * so the colour is solved here instead.
 *
 * The colour is returned **unchanged** when it already clears the bar, which is the case for both
 * built-in palettes and all six of their status colours. Otherwise it is pushed toward whichever end
 * of the scale the surfaces are not, by the smallest 5% step that works.
 */
export function readableText(colour: string, surfaces: readonly string[], target = 4.5): string {
  if (surfaces.length === 0) return colour;
  const worst = (candidate: string) => Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)));
  if (worst(colour) >= target) return colour;

  // Which end can reach the bar at all: a mid-grey background rules white out, a near-black one
  // rules black out, and asking first is cheaper than discovering it at the end of the search.
  const reach = (end: string) => Math.min(...surfaces.map((surface) => contrastRatio(end, surface)));
  const toward = reach('#000000') >= reach('#ffffff') ? '#000000' : '#ffffff';

  for (let amount = 0.05; amount <= 1; amount += 0.05) {
    const candidate = mix(colour, toward, amount);
    if (worst(candidate) >= target) return candidate;
  }
  return toward;
}