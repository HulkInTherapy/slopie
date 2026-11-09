/**
 * The audit UI kit: background, header (wordmark + progress hairline), section labels, the
 * two-tone headline, hairlines and the key footer. Every colour is a token (theme/tokens.ts).
 */
import type { Canvas } from '../gfx/canvas.js';
import { textWidth } from '../gfx/canvas.js';
import type { Rgb } from '../gfx/color.js';
import { wrapSpans, type Span } from '../gfx/draw.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import type { Scene } from '../cards/scene.js';
import { fadeIn, TK, type Tokens } from './tokens.js';

export interface K {
  s: Scene;
  c: Canvas;
  tk: Tokens;
  W: number;
  H: number;
  /** Left/right margin. */
  mx: number;
  /** Inner width. */
  iw: number;
  /** Large tier (≥ 100×30). */
  L: boolean;
  uni: boolean;
  busy: boolean;
  /** Half-block pixels painted this frame: cell index → [top, bottom] colour. */
  px: Map<number, [number, number]>;
}

export interface TextStyle { bold?: boolean; italic?: boolean; a?: number }

export function begin(s: Scene, tk: Tokens = TK): K {
  const L = s.tier.id === 'L';
  const mx = L ? 6 : 3;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) s.c.put(x, y, ' ', tk.text, tk.bg, 0);
  return { s, c: s.c, tk, W: s.w, H: s.h, mx, iw: s.w - mx * 2, L, uni: s.caps.unicode, busy: false, px: new Map() };
}

/** Entry fade for an element starting at `start` ms (1 with motion off). */
export function fade(k: K, start: number, dur = 320): number {
  if (!k.s.caps.motion) return 1;
  const a = seg(k.s.t, start, dur, easeOutCubic);
  if (a < 1) k.busy = true;
  return a;
}

export function txt(k: K, x: number, y: number, text: string, fg: Rgb, st: TextStyle = {}, maxW = Infinity): number {
  const a = st.a ?? 1;
  if (a <= 0.02) return Math.min(maxW, textWidth(text));
  return k.c.text(x, y, text, { fg: fadeIn(k.tk, fg, a), bg: k.tk.bg, bold: st.bold, italic: st.italic }, maxW);
}

export function txtRight(k: K, right: number, y: number, text: string, fg: Rgb, st: TextStyle = {}): number {
  return txt(k, right - textWidth(text), y, text, fg, st);
}

export function rule(k: K, x: number, y: number, w: number, color: Rgb = k.tk.rule, a = 1): void {
  for (let i = 0; i < w; i++) k.c.put(x + i, y, k.uni ? '─' : '-', fadeIn(k.tk, color, a), k.tk.bg, 0);
}

export function vrule(k: K, x: number, y: number, h: number, a = 1): void {
  for (let i = 0; i < h; i++) k.c.put(x, y + i, k.uni ? '│' : '|', fadeIn(k.tk, k.tk.rule, a), k.tk.bg, 0);
}

/** Section label: small, uppercase, tertiary ("THE BILL"). */
export function label(k: K, x: number, y: number, text: string, a = 1, maxW = Infinity): number {
  return txt(k, x, y, text.toUpperCase().replace(/…$/, ''), k.tk.text3, { a }, maxW);
}

const NUMBERISH = /^[(\[]?[~<>≈]?[$£€#×]?\d[\d,.]*(?:[%×xKMBkh]|st|nd|rd|th|am|pm)?[)\].,!:;?]*$|^×\d+[.,]?$/i;

/** Supporting copy: secondary tone, numbers lifted to primary (no colour, no weight). */
export function supportSpans(k: K, text: string, base: Rgb = k.tk.text2): Span[] {
  return text.split(/(\s+)/).filter(Boolean).map(word => ({ text: word, style: { fg: NUMBERISH.test(word) ? k.tk.text : base, bg: k.tk.bg } }));
}

/**
 * The two-tone headline: the statement in bold primary, the support continuing in secondary.
 * Returns the rows used (never more than `maxLines`; the support is dropped before anything is cut).
 */
export function headline(k: K, x: number, y: number, w: number, head: string, support: string, maxLines = 3, a = 1): number {
  const headSpans: Span[] = head.split(/(\s+)/).filter(Boolean).map(t => ({ text: t, style: { fg: k.tk.text, bg: k.tk.bg, bold: true } }));
  const both = support ? [...headSpans, { text: ' ', style: { fg: k.tk.text2, bg: k.tk.bg } }, ...supportSpans(k, support)] : headSpans;
  // The support is dropped before the statement; the statement itself is never cut.
  let lines = wrapSpans(both, w);
  if (lines.length > maxLines) lines = wrapSpans(headSpans, w);
  lines.forEach((line, i) => {
    let cx = x;
    for (const sp of line) cx += txt(k, cx, y + i, sp.text, sp.style.fg!, { bold: sp.style.bold, italic: sp.style.italic, a });
  });
  return lines.length;
}

/** Header: wordmark left, `right` (or the page counter) right, a progress hairline under it. */
export function header(k: K, right?: string): number {
  const { s, tk, mx, iw } = k;
  const y = k.L ? 1 : 0;
  const wx = mx + txt(k, mx, y, 'slopie', tk.text, { bold: true });
  txt(k, wx + 1, y, 'audit', tk.text3);
  const meta = right ?? (s.share ? '' : `${s.index + 1} / ${s.total}`);
  if (meta) txtRight(k, mx + iw, y, meta, tk.text3);
  // The rule under the header doubles as the story's progress: done part one tone up.
  const done = s.share || right !== undefined ? 0 : Math.round(iw * ((s.index + (s.caps.motion ? seg(s.t, 0, 500, easeOutCubic) : 1)) / s.total));
  if (s.caps.motion && s.t < 500) k.busy = true;
  for (let i = 0; i < iw; i++) k.c.put(mx + i, y + 1, k.uni ? '─' : '-', i < done ? tk.text3 : tk.rule, tk.bg, 0);
  return y + 2;
}

/** Footer: key hints left (key secondary, word tertiary), "● all local" right. */
export function footer(k: K, opts: { keys?: [string, string][]; right?: [string, Rgb][] } = {}): number {
  const { s, tk, mx, iw } = k;
  const y = k.L ? k.H - 2 : k.H - 1;
  const arrows = k.uni ? '← →' : '< >';
  const keys = opts.keys ?? [[arrows, k.L || k.W >= 80 ? 'move' : ''], ['b', 'board'], ['s', 'share'], ['?', 'how'], ['q', 'quit']];
  const local = s.online ? 'online · Jev' : 'all local';
  const right: [string, Rgb][] = opts.right ?? [[k.uni ? '●' : '*', tk.accent], [' ' + local, tk.text3]];
  const rw = right.reduce((a, [t]) => a + textWidth(t), 0);
  let rx = mx + iw - rw;
  for (const [t, col] of right) rx += txt(k, rx, y, t, col);
  let x = mx;
  for (const [key, word] of keys) {
    const need = textWidth(key) + (word ? 1 + textWidth(word) : 0);
    if (x + need > mx + iw - rw - 3) break;
    x += txt(k, x, y, key, tk.text2);
    if (word) x += 1 + txt(k, x + 1, y, word, tk.text3);
    x += 3;
  }
  return y;
}

export { textWidth };
