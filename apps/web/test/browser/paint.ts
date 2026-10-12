/**
 * Colour arithmetic for the theme specs.
 *
 * Everything these specs compare is a colour the browser resolved, and that arrives in one of
 * three forms: `rgb(r, g, b)`, `color(srgb r g b / a)` for anything built with `color-mix()`, and
 * a bare `#rrggbb` when the value is read out of a custom property rather than computed. All three
 * are normalized here so a translucent hairline can be composited over the surface behind it
 * before its contrast is measured. Comparing the raw strings would treat a 26%-opacity hairline as
 * if it were as strong as an opaque border, which is exactly the mistake this helper exists to
 * prevent.
 */

export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export function parseColour(value: string): Colour {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(trimmed);
  if (hex !== null) {
    return { r: Number.parseInt(hex[1]!, 16), g: Number.parseInt(hex[2]!, 16), b: Number.parseInt(hex[3]!, 16), a: 1 };
  }
  const mixed = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/u.exec(trimmed);
  if (mixed !== null) {
    return {
      r: Number(mixed[1]) * 255,
      g: Number(mixed[2]) * 255,
      b: Number(mixed[3]) * 255,
      a: mixed[4] === undefined ? 1 : Number(mixed[4]),
    };
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(trimmed);
  if (rgb === null) throw new Error(`not a colour: ${value}`);
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

/** `top` at its own alpha over `backdrop`. */
export function composite(top: Colour, backdrop: Colour): Colour {
  const blend = (a: number, b: number) => Math.round(a * top.a + b * (1 - top.a));
  return { r: blend(top.r, backdrop.r), g: blend(top.g, backdrop.g), b: blend(top.b, backdrop.b), a: 1 };
}

export function luminance(colour: Colour): number {
  const linear = [colour.r, colour.g, colour.b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrast(a: Colour, b: Colour): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** The largest per-channel difference: how many levels of 255 the paint moved. */
export function levels(a: Colour, b: Colour): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function describeColour(colour: Colour): string {
  const alpha = colour.a === 1 ? '' : ` / ${round2(colour.a)}`;
  return `rgb(${Math.round(colour.r)}, ${Math.round(colour.g)}, ${Math.round(colour.b)}${alpha})`;
}