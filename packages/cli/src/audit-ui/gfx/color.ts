/**
 * The slopie palette and colour maths. Colours are 0xRRGGBB integers; -1 means "terminal default".
 * Four greys, two chart inks and one indigo accent with its tints (see
 * docs/design/tui-redesign.md). Every colour in the audit UI is one of these tokens.
 */
export type Rgb = number;
export const DEFAULT: Rgb = -1;
/** Colours are written as hex strings so the bundle keeps them recognisable (not as 8-digit decimals). */
export const hx = (rrggbb: string): Rgb => parseInt(rrggbb, 16);

export const C = {
  /** Card background, painted edge to edge (fades start from it). */
  bg: hx('08090a'),
  /** Primary text: headlines, values, display type. */
  text: hx('f7f8f8'),
  /** Secondary: supporting copy. */
  text2: hx('b4b8c1'),
  /** Tertiary: labels, axes, hints. */
  text3: hx('7d828c'),
  /** Hairlines and empty tracks. */
  rule: hx('2e3138'),
  /** Chart ink for ordinary marks, and a softer one for estimates. */
  bar: hx('565b66'),
  barSoft: hx('30333a'),
  /** The one accent: the single point a screen is about. */
  accent: hx('7c7cff'),
  /** Placeholder ink (the locked title). */
  ghost: hx('16181b'),
  /** Accent tints: hero numbers and labels on dark (hi), chart fills and tracks (mid, lo). */
  accentHi: hx('a5a5ff'),
  accentMid: hx('5b5bd6'),
  accentLo: hx('34347a'),
  /** Footer key hints and track backgrounds only. */
  faint: hx('4a4e57'),
} as const;

const r = (c: Rgb) => (c >> 16) & 255;
const g = (c: Rgb) => (c >> 8) & 255;
const b = (c: Rgb) => c & 255;
export const rgb = (red: number, green: number, blue: number): Rgb =>
  ((Math.max(0, Math.min(255, Math.round(red))) << 16) | (Math.max(0, Math.min(255, Math.round(green))) << 8) | Math.max(0, Math.min(255, Math.round(blue))));

/** Linear mix a→b, t in 0..1. */
export function mix(a: Rgb, bColor: Rgb, t: number): Rgb {
  if (a < 0) return t < 0.5 ? a : bColor;
  if (bColor < 0) return t < 0.5 ? a : bColor;
  const k = Math.max(0, Math.min(1, t));
  return rgb(r(a) + (r(bColor) - r(a)) * k, g(a) + (g(bColor) - g(a)) * k, b(a) + (b(bColor) - b(a)) * k);
}

/** Fade a colour in from the card background. */
export const fade = (color: Rgb, alpha: number): Rgb => (alpha >= 1 ? color : mix(C.bg, color, Math.max(0, alpha)));

const HEAT: readonly Rgb[] = [hx('1a1b22'), C.accentLo, C.accentMid, C.accent, C.accentHi];
/** Single-hue ramp for heatmaps (near-black → indigo → lilac white), t in 0..1. */
export function heat(t: number): Rgb {
  const k = Math.max(0, Math.min(1, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(k));
  return mix(HEAT[i]!, HEAT[i + 1]!, k - i);
}

/* ── quantisation ─────────────────────────────────────────────────────────── */

/** Hand-tuned: the greys stay on the neutral grey ramp, the accent keeps its indigo. */
const TUNED_256 = new Map<Rgb, number>([
  [C.bg, 232], [C.text, 255], [C.text2, 250], [C.text3, 244], [C.rule, 236], [C.bar, 240], [C.barSoft, 236],
  [C.accent, 105], [C.ghost, 233], [C.accentHi, 147], [C.accentMid, 62], [C.accentLo, 60], [C.faint, 239],
]);
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCube(v: number): number {
  let best = 0;
  for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
  return best;
}

export function to256(color: Rgb): number {
  const tuned = TUNED_256.get(color);
  if (tuned !== undefined) return tuned;
  const ri = nearestCube(r(color)), gi = nearestCube(g(color)), bi = nearestCube(b(color));
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeErr = (CUBE[ri]! - r(color)) ** 2 + (CUBE[gi]! - g(color)) ** 2 + (CUBE[bi]! - b(color)) ** 2;
  const avg = (r(color) + g(color) + b(color)) / 3;
  const grayIndex = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const level = 8 + grayIndex * 10;
  const grayErr = (level - r(color)) ** 2 + (level - g(color)) ** 2 + (level - b(color)) ** 2;
  return grayErr < cubeErr ? 232 + grayIndex : cube;
}

/** 16-colour SGR foreground code (30–37, 90–97): greys by lightness, the indigo accent as bright blue. */
export function to16(color: Rgb): number {
  const red = r(color), green = g(color), blue = b(color);
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
  if (max - min < 40) {
    if (lum > 200) return 97;
    if (lum > 120) return 37;
    // Hairlines and chart inks stay visible as dark grey; only the background itself is black.
    if (lum > 25) return 90;
    return 30;
  }
  if (blue > red && blue > green) return lum > 90 ? 94 : 34;
  if (red > green && red > blue) return lum > 90 ? 91 : 31;
  return lum > 128 ? 97 : 37;
}

export const luminance = (color: Rgb) => (color < 0 ? 0 : (0.299 * r(color) + 0.587 * g(color) + 0.114 * b(color)) / 255);
export const channels = (color: Rgb): [number, number, number] => [r(color), g(color), b(color)];
export const hex = (color: Rgb) => '#' + (color & hx('ffffff')).toString(16).padStart(6, '0').toUpperCase();
