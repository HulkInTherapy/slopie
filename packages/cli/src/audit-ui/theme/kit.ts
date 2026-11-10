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
import { displaySupported, displayWidth, drawDisplay } from './display.js';

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
export function label(k: K, x: number, y: number, text: string, a = 1, maxW = Infinity, color: Rgb = k.tk.text3): number {
  return txt(k, x, y, text.toUpperCase().replace(/…$/, ''), color, { a }, maxW);
}

/** The eyebrow over every card ("THE BILL"): uppercase, in the light accent. */
export function kicker(k: K, x: number, y: number, text: string, a = 1, maxW = Infinity, color: Rgb = k.tk.accentHi): number {
  return txt(k, x, y, text.toUpperCase().replace(/…$/, ''), color, { a, bold: true }, maxW);
}

/** A label/value pair: dim small-caps label above, the value bold below (accent when `hot`). Returns rows used. */
export function stat(k: K, x: number, y: number, name: string, value: string, o: { hot?: boolean; a?: number; maxW?: number; sub?: string } = {}): number {
  const a = o.a ?? 1;
  label(k, x, y, name, a, o.maxW);
  txt(k, x, y + 1, value, o.hot ? k.tk.accentHi : k.tk.text, { bold: true, a }, o.maxW);
  if (o.sub) { txt(k, x, y + 2, o.sub, k.tk.text2, { a }, o.maxW); return 3; }
  return 2;
}

const NUMBERISH = /^[(\[]?[~<>≈]?[$£€#×]?\d[\d,.]*(?:[%×xKMBkh]|st|nd|rd|th|am|pm)?[)\].,!:;?]*$|^×\d+[.,]?$/i;

/** Supporting copy: secondary tone, numbers lifted to primary (no colour, no weight). */
export function supportSpans(k: K, text: string, base: Rgb = k.tk.text2): Span[] {
  return text.split(/(\s+)/).filter(Boolean).map(word => ({ text: word, style: { fg: NUMBERISH.test(word) ? k.tk.accentHi : base, bg: k.tk.bg, bold: NUMBERISH.test(word) } }));
}

/** At most ~9 words: a long statement is cut back to its first clause; two short sentences (≤ 12 words) stay. */
export function shortHead(head: string): string {
  const n = (t: string) => t.split(/\s+/).length;
  // "X: 266 subagents launched." keeps X; a short tail ("The one that got away: paper-boats.") stays.
  const m = head.match(/^(.*?)[:;—]\s(.*)$/);
  if (m && n(m[1]!.trim()) >= 3 && n(m[2]!.trim()) > 2) return m[1]!.trim().replace(/[,]$/, '') + '.';
  if (n(head) <= 9) return head;
  if (n(head) <= 12) return head;
  const first = head.match(/^(.*?[.!?])(?=\s)/)?.[1]?.trim();
  return first && n(first) >= 2 ? first : head;
}

/**
 * The headline: ONE statement in bold primary (its figures in the light accent), a blank row,
 * then at most one line of support in secondary: its first sentence, only if it fits one line of
 * ~90 columns. Returns the rows used.
 */
export function headline(k: K, x: number, y: number, w: number, head: string, support: string, maxLines = 3, a = 1): number {
  const headSpans: Span[] = shortHead(head).split(/(\s+)/).filter(Boolean).map(t => ({ text: t, style: { fg: NUMBERISH.test(t) ? k.tk.accentHi : k.tk.text, bg: k.tk.bg, bold: true } }));
  const lines = wrapSpans(headSpans, w);
  if (support && maxLines - lines.length >= 2) {
    const first = (support.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? support).trim();
    const sl = wrapSpans(supportSpans(k, first), Math.min(w, 90));
    if (sl.length === 1) lines.push([], sl[0]!);
  }
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
  for (let i = 0; i < iw; i++) k.c.put(mx + i, y + 1, k.uni ? '─' : '-', i < done ? tk.accent : tk.rule, tk.bg, 0);
  return y + 2;
}

/** Footer: key hints left (key secondary, word tertiary), "● all local" right. */
export function footer(k: K, opts: { keys?: [string, string, Rgb?][]; right?: [string, Rgb][] } = {}): number {
  const { s, tk, mx, iw } = k;
  const y = k.L ? k.H - 2 : k.H - 1;
  const arrows = k.uni ? '← →' : '< >';
  const keys: [string, string, Rgb?][] = opts.keys ?? [[arrows, k.L || k.W >= 80 ? 'move' : ''], ['b', 'board'], ['s', 'share'], ['?', 'how'], ['q', 'quit']];
  const local = s.online ? 'online · Jev' : 'all local';
  const right: [string, Rgb][] = opts.right ?? [[k.uni ? '●' : '*', tk.accent], [' ' + local, tk.text3]];
  const rw = right.reduce((a, [t]) => a + textWidth(t), 0);
  let rx = mx + iw - rw;
  for (const [t, col] of right) rx += txt(k, rx, y, t, col);
  let x = mx;
  for (const [key, word, keyColor] of keys) {
    const need = textWidth(key) + (word ? 1 + textWidth(word) : 0);
    if (x + need > mx + iw - rw - 3) break;
    x += txt(k, x, y, key, keyColor ?? tk.text2);
    if (word) x += 1 + txt(k, x + 1, y, word, tk.faint);
    x += 3;
  }
  return y;
}

export { textWidth };

export interface Fact { label: string; value: string; hot?: boolean }

/** A bottom row of label/value tiles spread across `w` (label text3 above, value bold). Returns rows used. */
export function facts(k: K, x: number, y: number, w: number, items: readonly Fact[], a = 1): number {
  const list = items.filter(f => f.value);
  if (!list.length) return 0;
  const colW = Math.floor(w / list.length);
  list.forEach((f, i) => stat(k, x + i * colW, y, f.label, f.value, { hot: f.hot, a, maxW: colW - 3 }));
  return 2;
}

/** A secondary number in the thin stroke display face (3 rows) when it can be set, else bold text. */
export function strokeNum(k: K, x: number, y: number, text: string, color: Rgb, a = 1, maxW = Infinity): { w: number; h: number } {
  const o = { face: 'heavy' as const };
  if (k.uni && displaySupported(text) && displayWidth(text, o) <= maxW) {
    return { w: drawDisplay(k.c, x, y, text, fadeIn(k.tk, color, a), k.tk.bg, { ...o, currency: fadeIn(k.tk, k.tk.accentHi, a) }), h: 3 };
  }
  return { w: txt(k, x, y, text, color, { bold: true, a }, maxW), h: 1 };
}

/** Hero display scale: twice the size on big terminals. */
export const heroScale = (k: K) => (k.s.big ? 2 : 1);

/** A small filled chip (" EPIC "): bold text on a solid fill. Returns its width. */
export function chip(k: K, x: number, y: number, text: string, bg: Rgb, fg: Rgb = k.tk.bg, a = 1): number {
  if (a <= 0.02) return textWidth(text) + 2;
  if (k.s.caps.color === 'none') return txt(k, x, y, `[${text}]`, k.tk.text, { bold: true, a });
  return k.c.text(x, y, ` ${text} `, { fg: fadeIn(k.tk, fg, a), bg: fadeIn(k.tk, bg, a), bold: true });
}
