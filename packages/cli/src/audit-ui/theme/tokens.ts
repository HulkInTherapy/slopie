/**
 * Design tokens for the audit UI: the palette (gfx/color.ts) plus how display type is drawn.
 * One look; see docs/design/tui-redesign.md.
 */
import { C, mix, type Rgb } from '../gfx/color.js';

export type DisplayFace = 'heavy' | 'solid';

export interface Tokens {
  bg: Rgb;
  text: Rgb;
  text2: Rgb;
  text3: Rgb;
  rule: Rgb;
  bar: Rgb;
  barSoft: Rgb;
  accent: Rgb;
  ghost: Rgb;
  /** Display face for hero numbers and titles; the heavy stroke face is the narrow fallback. */
  face: DisplayFace;
}

export const TK: Tokens = { ...C, face: 'solid' };

/** Fade a colour in from the background. */
export const fadeIn = (tk: Tokens, color: Rgb, alpha: number): Rgb => (alpha >= 1 ? color : mix(tk.bg, color, Math.max(0, alpha)));
