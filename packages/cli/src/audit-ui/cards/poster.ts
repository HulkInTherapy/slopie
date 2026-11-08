/**
 * The final board: a personality poster, and the share image. One look, on the terminal's own
 * dark background with the 1.8 palette (near-black, orange accents, a cream→orange pixel title).
 *
 * Layout (a receipt by structure, not by paper colour):
 *   SLOPIE AUDIT  (dotted rule under it)                       range · #code
 *   kicker, the pixel title, badge + sub-role, tagline
 *   the BIG $ price over "at API prices"
 *   a box: prompts │ days │ catchphrase │ your day (24h strip, its hour axis, angriest / saint)
 *   six framed fact tiles with mini diagrams, two pixel trophies, barcode, a torn edge
 *
 * Fitting: a smaller screen drops whole elements (barcode, kicker, diagrams, the big type,
 * trophies, facts) and never cuts a line. Nothing uses an ellipsis.
 *
 * Motion: the receipt prints up out of the slot row by row, then the diagrams grow (the price
 * counts the last stretch up from 80%, bars fill, the sparkline draws, the subagent tree fans
 * out). With motion off the scene clock is Infinity, which is exactly the last animated frame.
 */
import type { Canvas } from '../gfx/canvas.js';
import { C, fade, hx, mix, type Rgb } from '../gfx/color.js';
import { spaced, textWidth } from '../gfx/draw.js';
import { bigHeight, bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { clamp01, easeOutCubic, seg } from '../gfx/motion.js';
import { count, hourLabel } from '../format.js';
import type { BoardSummary } from '../story/board-data.js';
import { factText, posterOrder, type FactPart, type FunFact } from '../story/fun-facts.js';
import type { Scene } from './scene.js';

export const INSTALL = 'npx slopie audit';
export const MEMORY_LINE = 'your agents forget. slopie remembers';
export const GOLD = hx('ffd27a');
export const SILVER = hx('c8ccd2');
export const BRONZE = hx('d08a4e');
const TIER_LABEL: Record<string, string> = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };

/** Entry timing (ms). The receipt prints first, then the diagrams grow one after another. */
export const PRINT_MS = 950;
export const DIAG_AT = 1050;
const DIAG_STEP = 130;
const DIAG_DUR = 650;
/** By this time every animation has landed (the reduced-motion frame equals this frame). */
export const SETTLED_MS = DIAG_AT + DIAG_STEP * 16 + DIAG_DUR;
/** The price counter starts at this fraction of the final value, so no frame ever says "$0". */
export const COUNT_FROM = 0.8;

export const tierColor = (tier: BoardSummary['tier']): Rgb => (tier === 'legendary' ? GOLD : tier === 'epic' ? C.orange : tier === 'rare' ? C.peach : C.gray);
export const metalColor = (tier: 'gold' | 'silver' | 'bronze'): Rgb => (tier === 'gold' ? GOLD : tier === 'silver' ? SILVER : BRONZE);

/** Glyph used for a trophy's metal in one-line lists (exported for the awards card). */
export function metalGlyph(tier: 'gold' | 'silver' | 'bronze', uni: boolean): string {
  return uni ? (tier === 'gold' ? '★' : tier === 'silver' ? '☆' : '✧') : tier === 'gold' ? '*' : tier === 'silver' ? '+' : '-';
}

/** "$6,413" mid-count: the value at progress k (0..1), counting up from COUNT_FROM of the total. */
export function countUp(value: string, k: number): string {
  if (k >= 1 || !/^\$[\d,]+$/.test(value)) return value;
  const target = Number(value.replace(/[^\d]/g, ''));
  const n = Math.max(1, Math.round(target * (COUNT_FROM + (1 - COUNT_FROM) * clamp01(k))));
  return `$${n.toLocaleString('en-US')}`;
}

/* ── palette (the 1.8 dark board) + context ───────────────────────────────── */

interface Theme {
  /** Panel background; undefined = the terminal's ink. */
  bg: Rgb | undefined;
  /** Hero values: prompts, days, trophy titles. */
  ink: Rgb;
  body: Rgb;
  faint: Rgb;
  /** Thin tile frames (1.8's grey panel border). */
  rule: Rgb;
  /** The stats box frame (1.8's dark-orange hero border). */
  boxRule: Rgb;
  label: Rgb;
  num: Rgb;
  name: Rgb;
  quote: Rgb;
  hot: Rgb;
  /** The kind half of a two-sided bar (thank-yous, the soft spot). */
  soft: Rgb;
  /** Bars that stand for "the ordinary" (the median prompt). */
  dim: Rgb;
  title: (px: number, py: number, w: number, legendary: boolean) => Rgb;
}

/** The pet name's speech bubble. */
const BUBBLE = hx('4a3022');

const THEME: Theme = {
  bg: undefined, ink: C.white, body: hx('d6d0c8'), faint: C.gray, rule: hx('3a3431'), boxRule: mix(C.rust, C.ink, 0.3),
  label: C.orange, num: C.orange, name: C.white, quote: C.orange, hot: C.ember, soft: C.peach, dim: hx('6e6660'),
  // 1.8's title: cream at the top of each glyph row, orange at the bottom (a gold sweep for legendary).
  title: (px, py, w, legendary) => (legendary ? mix(mix(C.cream, GOLD, px / Math.max(1, w)), C.orange, py / 8) : mix(C.cream, C.orange, py / 4)),
};

interface Ctx {
  s: Scene;
  c: Canvas;
  d: BoardSummary;
  th: Theme;
  uni: boolean;
  pixel: boolean;
  busy: boolean;
  /** 0..1 progress of diagram `i` (1 when motion is off). */
  grow: (i: number) => number;
}

function context(s: Scene, d: BoardSummary): Ctx {
  const ctx: Ctx = {
    s, c: s.c, d, th: THEME, uni: s.caps.unicode, pixel: s.caps.color === 'truecolor' || s.caps.color === '256', busy: false,
    grow: (i: number) => {
      const k = seg(s.t, DIAG_AT + i * DIAG_STEP, DIAG_DUR, easeOutCubic);
      if (k < 1) ctx.busy = true;
      return k;
    },
  };
  return ctx;
}

const T = (ctx: Ctx, x: number, y: number, text: string, style: { fg?: Rgb; bold?: boolean; italic?: boolean; bg?: Rgb } = {}) =>
  ctx.c.text(x, y, text, { fg: style.fg ?? ctx.th.body, bold: style.bold, italic: style.italic, bg: style.bg ?? ctx.th.bg });

const put = (ctx: Ctx, x: number, y: number, ch: string, fg: Rgb, bg?: Rgb) => ctx.c.put(x, y, ch, fg, bg ?? ctx.th.bg);

function drawParts(ctx: Ctx, x: number, y: number, parts: readonly FactPart[]): number {
  let cx = x;
  for (const p of parts) {
    const style = p.tone === 'num' ? { fg: ctx.th.num, bold: true } : p.tone === 'name' ? { fg: ctx.th.name, bold: true } : p.tone === 'quote' ? { fg: ctx.th.quote, italic: true } : { fg: ctx.th.body };
    cx += T(ctx, cx, y, p.text, style);
  }
  return cx - x;
}

const fitParts = (f: FunFact, w: number): FactPart[] | null =>
  textWidth(factText(f.parts)) <= w ? f.parts : f.short && textWidth(factText(f.short)) <= w ? f.short : null;

/** "1.95" → "2×", "2.4" → "2.4×" (same rule as the facts). */
const times = (ratio: number) => `${ratio >= 9.95 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, '')}×`;
const shortModel = (label: string) => label.replace(/^(Claude|Gemini)\s+/, '');

function wrapWords(text: string, width: number): string[] | null {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next) <= width) line = next;
    else { if (line) out.push(line); line = word; if (textWidth(word) > width) return null; }
  }
  if (line) out.push(line);
  return out;
}

function titleLines(title: string, width: number, maxLines: number): string[] | null {
  const words = title.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (bigWidth(next) <= width) line = next;
    else { if (line) lines.push(line); line = word; if (bigWidth(word) > width) return null; }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

function textTitle(title: string, width: number): string[] {
  const sp = (t: string) => spaced(t);
  for (const fmt of [sp, (t: string) => t.toUpperCase()]) {
    const words = title.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    let ok = true;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(fmt(next)) <= width) line = next;
      else { if (line) lines.push(line); line = word; if (textWidth(fmt(word)) > width) { ok = false; break; } }
    }
    if (line) lines.push(line);
    if (ok && lines.length <= 2) return lines.map(fmt);
  }
  return wrapWords(title.toUpperCase(), width) ?? [title.toUpperCase()];
}

/* ── components ───────────────────────────────────────────────────────────── */

interface Piece { h: number; draw: (x: number, y: number, w: number) => void }

/** Header: SLOPIE AUDIT on the left, range + order code on the right, a dashed rule under it. */
function header(ctx: Ctx, w: number): Piece {
  const { d } = ctx;
  const brand = w >= 70 ? 'S L O P I E   A U D I T' : 'SLOPIE AUDIT';
  const right = [d.range, d.code ? `#${d.code}` : null].filter(Boolean).join('  ·  ');
  return {
    h: 2, draw: (x, y, ww) => {
      T(ctx, x, y, brand, { fg: ctx.th.label, bold: true });
      const rx = x + ww;
      if (right && textWidth(brand) + 4 + textWidth(right) <= rx - x) T(ctx, rx - textWidth(right), y, right, { fg: ctx.th.faint });
      for (let i = x; i < x + ww; i++) put(ctx, i, y + 1, ctx.uni ? '┄' : '-', C.slate);
    },
  };
}

const badgeText = (ctx: Ctx) => (ctx.d.tier ? `${ctx.uni ? '★' : '*'} ${TIER_LABEL[ctx.d.tier]} ${ctx.uni ? '★' : '*'}` : null);

function taglineOf(ctx: Ctx): string | null {
  const t = ctx.d.tagline;
  if (!t || (ctx.s.share && !ctx.d.taglinePublic)) return null;
  return t;
}

interface IdentityPlan { kicker: boolean; big: boolean; subRole: boolean; tagline: boolean; badge: boolean }

/** Kicker, the title (pixel font when it fits), badge + sub-role, tagline. Centred in `w`. */
function identity(ctx: Ctx, w: number, p: IdentityPlan): Piece | null {
  const { d, th } = ctx;
  const title = d.archetype ?? 'your year with agents';
  const canBig = p.big && ctx.pixel && bigSupported(title);
  const big = canBig ? titleLines(title, w, 2) : null;
  const tLines = big ? null : textTitle(title, w);
  const titleH = big ? big.length * bigHeight() + (big.length - 1) : tLines!.length;
  const badge = p.badge ? badgeText(ctx) : null;
  const sub = p.subRole && d.subRole ? d.subRole : null;
  const badgeLineW = (badge ? textWidth(badge) + 2 : 0) + (badge && sub ? 3 : 0) + (sub ? textWidth(sub) : 0);
  const subFits = !!sub && badgeLineW <= w;
  const tag = p.tagline ? taglineOf(ctx) : null;
  const tagLines = tag ? wrapWords(tag, Math.min(w, 72)) : null;
  const tagOk = !!tagLines && tagLines.length <= 2;
  const hasBadgeLine = !!badge || subFits;
  const h = (p.kicker ? 2 : 0) + titleH + (hasBadgeLine ? 2 : 0) + (tagOk ? tagLines!.length + (hasBadgeLine ? 0 : 1) : 0);
  return {
    h, draw: (x, y0, ww) => {
      const cx = x + Math.floor(ww / 2);
      let y = y0;
      if (p.kicker) {
        const k = ww >= 60 ? spaced("this year you've been") : "THIS YEAR YOU'VE BEEN";
        T(ctx, cx - Math.floor(textWidth(k) / 2), y, k, { fg: th.faint });
        y += 2;
      }
      if (big) {
        for (const line of big) {
          const lw = bigWidth(line);
          drawBig(ctx.c, cx - Math.floor(lw / 2), y, line, { color: (px, py) => th.title(px, py, lw, d.tier === 'legendary') });
          y += bigHeight() + 1;
        }
        y -= 1;
      } else {
        for (const line of tLines!) { T(ctx, cx - Math.floor(textWidth(line) / 2), y, line, { fg: C.orange, bold: true }); y++; }
      }
      if (hasBadgeLine) {
        y += 1;
        const lw = subFits ? badgeLineW : badge ? textWidth(badge) + 2 : 0;
        let bx = cx - Math.floor(lw / 2);
        if (badge) {
          ctx.c.text(bx, y, ` ${badge} `, { fg: C.ink, bg: tierColor(d.tier), bold: true });
          bx += textWidth(badge) + 2 + 3;
        }
        if (subFits) T(ctx, bx, y, sub!, { fg: th.quote, italic: true });
        y += 1;
      } else y += tagOk ? 1 : 0;
      if (tagOk) for (const line of tagLines!) { T(ctx, cx - Math.floor(textWidth(line) / 2), y, line, { fg: th.faint, italic: true }); y++; }
    },
  };
}

/** The money hero: BIG pixel digits (counting up on entry) over "at API prices". */
function price(ctx: Ctx, w: number, big: boolean): Piece | null {
  const hero = ctx.d.heroes.find(h => h.label === 'at API prices');
  if (!hero) return null;
  const okBig = big && ctx.pixel && bigSupported(hero.value) && bigWidth(hero.value) <= w;
  // Counts the last 20% up once printed; while it prints, the rows already show the starting value.
  const shown = () => countUp(hero.value, ctx.grow(0));
  if (okBig) {
    return {
      h: bigHeight() + 1, draw: (x, y, ww) => {
        const cx = x + Math.floor(ww / 2);
        const fw = bigWidth(hero.value);
        const v = shown();
        const vw = bigWidth(v);
        // Right-aligned inside the final width so the counter does not jitter.
        drawBig(ctx.c, cx - Math.floor(fw / 2) + (fw - vw), y, v, { color: (_px, py) => mix(C.cream, C.orange, py / 5) });
        const label = 'at API prices';
        T(ctx, cx - Math.floor(textWidth(label) / 2), y + bigHeight(), label, { fg: ctx.th.faint });
      },
    };
  }
  const line = `${hero.value} at API prices`;
  if (textWidth(line) > w) return null;
  return {
    h: 1, draw: (x, y, ww) => {
      const lx = x + Math.floor((ww - textWidth(line)) / 2);
      const v = shown();
      T(ctx, lx + textWidth(hero.value) - textWidth(v), y, v, { fg: ctx.th.num, bold: true });
      T(ctx, lx + textWidth(hero.value) + 1, y, 'at API prices', { fg: ctx.th.faint });
    },
  };
}

/* ── the stats box: prompts · days · catchphrase · your day ───────────────── */

/** One box cell: its width and its rows, top to bottom (value, label, …). */
interface Cell { w: number; rows: ((x: number, y: number) => void)[] }

function statCells(ctx: Ctx, opts: { clock: boolean; catchphrase: boolean }): Cell[] {
  const { d, th } = ctx;
  const cells: Cell[] = [];
  for (const key of ['prompts', 'days'] as const) {
    const h = d.heroes.find(x => (key === 'days' ? x.label === 'days' || x.label === 'day' : x.label === 'prompts'));
    if (!h) continue;
    cells.push({ w: Math.max(textWidth(h.value), textWidth(h.label)), rows: [(x, y) => T(ctx, x, y, h.value, { fg: th.ink, bold: true }), (x, y) => T(ctx, x, y, h.label, { fg: th.faint })] });
  }
  // The share card keeps none of the user's phrases (the engine's public receipt hides it too).
  const cp = opts.catchphrase && !ctx.s.share ? d.catchphrase : null;
  if (cp) {
    const q = `“${cp.phrase}”`;
    const n = ` ×${count(cp.count)}`;
    const label = 'your catchphrase';
    cells.push({
      w: Math.max(textWidth(q + n), textWidth(label)),
      rows: [
        (x, y) => { const qw = T(ctx, x, y, q, { fg: th.quote, italic: true, bold: true }); T(ctx, x + qw, y, n, { fg: th.num, bold: true }); },
        (x, y) => T(ctx, x, y, label, { fg: th.faint }),
      ],
    });
  }
  const clock = opts.clock ? d.viz.clock : null;
  if (clock && ctx.uni) {
    const angry = `${ctx.uni ? '☠' : 'x'} ${hourLabel(clock.angry)} angriest`;
    const saint = `${ctx.uni ? '✿' : 'o'} ${hourLabel(clock.saint)} saint`;
    const legend = `${angry}  ${saint}`;
    const max = Math.max(...clock.hours);
    cells.push({
      w: Math.max(24, textWidth(legend)),
      rows: [(x, y) => {
        const k = ctx.grow(2);
        for (let h = 0; h < 24; h++) {
          const v = max > 0 ? clock.hours[h]! / max : 0;
          const shownH = clamp01(k * 24 - h); // sweeps left to right
          const lvl = Math.max(0, Math.min(7, Math.round(v * shownH * 7)));
          const ch = '▁▂▃▄▅▆▇█'[lvl]!;
          const fg = h === clock.angry ? th.hot : h === clock.saint ? C.cream : th.dim;
          put(ctx, x + h, y, shownH > 0 ? ch : ' ', fg);
        }
      },
      // The hour axis, inside the box: each label starts under its own hour column.
      (x, y) => { for (const [h, l] of [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']] as const) T(ctx, x + h, y, l, { fg: th.faint }); },
      (x, y) => {
        const aw = T(ctx, x, y, angry, { fg: th.hot, bold: true });
        T(ctx, x + aw + 2, y, saint, { fg: C.cream });
      }],
    });
  }
  return cells;
}

const CELL_PAD = 2;

function statBox(ctx: Ctx, w: number, opts: { clock: boolean; catchphrase: boolean }): Piece | null {
  let cells = statCells(ctx, opts);
  const natural = (cs: Cell[]) => cs.reduce((s, c) => s + c.w + CELL_PAD * 2, 0) + cs.length + 1;
  while (cells.length && natural(cells) > w) cells = cells.slice(0, -1);
  if (!cells.length) return null;
  const inner = Math.max(...cells.map(c => c.rows.length));
  const H = inner + 2;
  return {
    h: H, draw: (x, y, ww) => {
      const { th, uni } = ctx;
      // Share spare width out to the cells (keeps the box from looking cramped), centred.
      const spare = Math.max(0, Math.min(ww, Math.max(natural(cells), Math.floor(ww * 0.86))) - natural(cells));
      const widths = cells.map((c, i) => c.w + CELL_PAD * 2 + Math.floor(spare / cells.length) + (i < spare % cells.length ? 1 : 0));
      const total = widths.reduce((s, v) => s + v, 0) + cells.length + 1;
      let cx = x + Math.floor((ww - total) / 2);
      const hz = uni ? '─' : '-';
      const col = th.boxRule;
      const side = (sx: number) => { for (let j = 1; j <= inner; j++) put(ctx, sx, y + j, uni ? '│' : '|', col); };
      put(ctx, cx, y, uni ? '╭' : '+', col); put(ctx, cx, y + H - 1, uni ? '╰' : '+', col);
      side(cx);
      cells.forEach((cell, i) => {
        const cw = widths[i]!;
        for (let k = 1; k <= cw; k++) { put(ctx, cx + k, y, hz, col); put(ctx, cx + k, y + H - 1, hz, col); }
        const ix = cx + 1 + Math.floor((cw - cell.w) / 2);
        // Shorter cells sit centred in a taller box.
        const top = y + 1 + Math.floor((inner - cell.rows.length) / 2);
        cell.rows.forEach((row, j) => row(ix, top + j));
        cx += cw + 1;
        const last = i === cells.length - 1;
        put(ctx, cx, y, uni ? (last ? '╮' : '┬') : '+', col);
        put(ctx, cx, y + H - 1, uni ? (last ? '╯' : '┴') : '+', col);
        side(cx);
      });
    },
  };
}

/* ── fact tiles with mini diagrams ────────────────────────────────────────── */

type Diagram = { rows: 1 | 2; draw: (x: number, y: number, w: number, k: number) => void; replacesText?: boolean; label?: string } | null;

function hbarCells(ctx: Ctx, x: number, y: number, width: number, frac: number, color: Rgb): void {
  const eighths = Math.round(clamp01(frac) * width * 8);
  const full = Math.floor(eighths / 8), rest = eighths % 8;
  for (let i = 0; i < full; i++) put(ctx, x + i, y, ctx.uni ? '█' : '#', color);
  if (rest && full < width) put(ctx, x + full, y, ctx.uni ? ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][rest]! : '#', color);
}

/** The diagram that explains a fact, if its numbers are known and it fits `w`. */
function diagramFor(ctx: Ctx, fact: FunFact, w: number): Diagram {
  const { d, th, uni } = ctx;
  const v = d.viz;
  if (!uni) return null;
  switch (fact.id) {
    case 'manners': {
      const m = v.manners;
      if (!m) return null;
      const left = `♥ ${count(m.thanks)}`, right = `${count(m.rude)} ${m.word}`;
      const bw = w - textWidth(left) - textWidth(right) - 2;
      if (bw < 6) return null;
      return {
        rows: 1, draw: (x, y, _w, k) => {
          T(ctx, x, y, left, { fg: th.soft, bold: true });
          const bx = x + textWidth(left) + 1;
          const nice = Math.max(1, Math.round((bw * m.thanks) / (m.thanks + m.rude)));
          // The scale tips: the thank-you side fills first, then the f-bombs pour in.
          hbarCells(ctx, bx, y, nice, clamp01(k * 3), th.soft);
          hbarCells(ctx, bx + nice, y, bw - nice, clamp01(k * 1.25 - 0.2), th.hot);
          T(ctx, bx + bw + 1, y, right, { fg: th.hot, bold: true });
        },
      };
    }
    case 'mood_drift': {
      const a = v.arc;
      if (!a) return null;
      const per = Math.max(1, Math.min(3, Math.floor((w - textWidth(a.from) - textWidth(a.to) - 2) / a.pcts.length)));
      const sw = per * a.pcts.length;
      if (textWidth(a.from) + textWidth(a.to) + 2 + sw > w) return null;
      const max = Math.max(...a.pcts);
      return {
        rows: 1, draw: (x, y, _w, k) => {
          T(ctx, x, y, a.from, { fg: th.faint });
          const sx = x + textWidth(a.from) + 1;
          a.pcts.forEach((p, i) => {
            if (k * a.pcts.length < i + 0.5) return;
            const lvl = Math.max(0, Math.min(7, Math.round((p / max) * 7)));
            const fg = mix(th.dim, th.hot, p / max);
            for (let j = 0; j < per; j++) put(ctx, sx + i * per + j, y, '▁▂▃▄▅▆▇█'[lvl]!, fg);
          });
          T(ctx, sx + sw + 1, y, a.to, { fg: th.faint });
        },
      };
    }
    case 'priciest_sentence': {
      const p = v.priciest;
      if (!p) return null;
      // median ▎ priciest ██████████   each label sits in front of its own bar; the median
      // prompt is a sliver next to the priciest one.
      const lead = 'median ▎  priciest ';
      const bw = w - textWidth(lead);
      if (bw < 6) return null;
      return {
        rows: 1, draw: (x, y, _w, k) => {
          T(ctx, x, y, 'median', { fg: th.faint });
          put(ctx, x + 7, y, '▎', C.cream);
          T(ctx, x + 10, y, 'priciest', { fg: th.faint });
          hbarCells(ctx, x + textWidth(lead), y, bw, k, th.num);
        },
      };
    }
    case 'longest_sit': {
      const h = v.sit;
      if (!h) return null;
      const n = Math.ceil(h);
      const step = n * 2 + 6 <= w ? 2 : n + 6 <= w ? 1 : 0;
      if (!step) return null;
      return {
        rows: 1, draw: (x, y, _w, k) => {
          for (let i = 0; i < n; i++) {
            if (k * n < i + 0.3) break;
            const half = i === n - 1 && h - Math.floor(h) > 0 && h - Math.floor(h) < 0.75;
            put(ctx, x + i * step, y, half ? '▌' : '█', mix(th.num, th.hot, i / Math.max(1, n - 1)));
          }
          T(ctx, x + n * step + (step === 2 ? 0 : 1), y, 'hours', { fg: th.faint });
        },
      };
    }
    case 'pet_name': {
      //  ▐ buddy ▌ ×37        a speech bubble with the name in it,
      //   ◥ what you call your agent
      const name = fact.parts.find(p => p.tone === 'quote')?.text;
      const times = fact.parts.find(p => p.tone === 'num')?.text;
      if (!name || !times) return null;
      const said = ` ${name} `;
      const bubbleW = textWidth(said) + 2;
      if (bubbleW + 1 + textWidth(times) > w) return null;
      const cap = ['what you call your agent', 'what you call it', 'you call it'].find(t => 2 + textWidth(t) <= w) ?? '';
      return {
        rows: 2, replacesText: true, draw: (x, y, _w, k) => {
          // The bubble pops in, then the count.
          if (k <= 0) return;
          put(ctx, x, y, '▐', BUBBLE);
          ctx.c.text(x + 1, y, said, { fg: C.cream, bg: BUBBLE, bold: true, italic: true });
          put(ctx, x + bubbleW - 1, y, '▌', BUBBLE);
          put(ctx, x + 1, y + 1, '◥', BUBBLE);
          if (cap) T(ctx, x + 3, y + 1, cap, { fg: th.faint });
          if (k >= 0.5) T(ctx, x + bubbleW + 1, y, times, { fg: th.num, bold: true });
        },
      };
    }
    case 'nemesis': {
      const f = v.faceoff;
      if (!f.nemesis) return null;
      const rows = [
        { icon: '☠', name: shortModel(f.nemesis.label), ratio: f.nemesis.ratio, word: 'swears', fg: th.hot },
        f.fav ? { icon: '♥', name: shortModel(f.fav.label), ratio: f.fav.ratio, word: 'thanks', fg: th.soft }
          : { icon: ' ', name: 'the rest', ratio: 1, word: 'swears', fg: th.faint },
      ];
      const nw = Math.max(...rows.map(r => textWidth(r.name)));
      const room = (words: boolean) => w - 2 - nw - 1 - 1 - Math.max(...rows.map(r => textWidth(words ? `${times(r.ratio)} ${r.word}` : times(r.ratio))));
      // With the words when they fit; otherwise the tile label says what the two bars are.
      const words = room(true) >= 4;
      const bw = room(words);
      if (bw < 4) return null;
      const max = Math.max(...rows.map(r => r.ratio));
      return {
        rows: 2, replacesText: true, label: words ? undefined : f.fav ? 'NEMESIS vs SOFT SPOT' : 'NEMESIS · SWEARS',
        draw: (x, y, _w, k) => {
          rows.forEach((r, i) => {
            T(ctx, x, y + i, r.icon, { fg: r.fg, bold: true });
            T(ctx, x + 2, y + i, r.name, { fg: th.name, bold: true });
            hbarCells(ctx, x + 2 + nw + 1, y + i, bw, (r.ratio / max) * k, r.fg);
            const tx = x + 2 + nw + 1 + bw + 1;
            const n = T(ctx, tx, y + i, times(r.ratio), { fg: r.fg === th.faint ? th.faint : th.num, bold: true });
            if (words) T(ctx, tx + n + 1, y + i, r.word, { fg: th.body });
          });
        },
      };
    }
    case 'fuse': {
      const turn = Number(fact.parts.find(p => p.tone === 'num')?.text.replace(/[^\d]/g, '') ?? 0);
      if (!(turn >= 1) || turn * 2 + 2 > w) return null;
      return {
        rows: 1, draw: (x, y, _w, k) => {
          const lit = Math.round(turn * k);
          for (let i = 0; i < turn; i++) T(ctx, x + i * 2, y, i < turn - lit ? '━━' : '  ', { fg: th.faint });
          put(ctx, x + (turn - lit) * 2, y, '✸', th.hot);
        },
      };
    }
    default:
      return null;
  }
}

interface TilePick { fact: FunFact; parts: FactPart[]; diagram: Diagram; lines?: FactPart[][] }

/** Word-wrap styled runs into at most `max` lines of `width` (never cuts a word); null if it can't. */
function wrapParts(parts: readonly FactPart[], width: number, max: number): FactPart[][] | null {
  const words: FactPart[] = [];
  for (const p of parts) {
    const bits = p.text.split(/(\s+)/);
    for (const b of bits) if (b) words.push({ text: b, tone: p.tone });
  }
  const lines: FactPart[][] = [[]];
  let w = 0;
  for (const word of words) {
    const ww = textWidth(word.text);
    const blank = /^\s+$/.test(word.text);
    if (w + ww > width) {
      if (blank) continue;
      if (lines.length >= max || ww > width) return null;
      lines.push([]);
      w = 0;
    }
    if (blank && w === 0) continue;
    lines.at(-1)!.push(word);
    w += ww;
  }
  // Trim trailing spaces.
  for (const l of lines) while (l.length && /^\s+$/.test(l.at(-1)!.text)) l.pop();
  return lines;
}

/** Facts for the tiles: the core six first (whenever their guard passes), then the ranked rest. */
function pickTiles(ctx: Ctx, n: number, inner: number, exclude: string[], full: boolean): TilePick[] {
  const out: TilePick[] = [];
  const fam = new Map<string, number>();
  for (const fact of posterOrder(ctx.d.facts, exclude)) {
    if (out.length >= n) break;
    if ((fam.get(fact.family) ?? 0) >= 2) continue;
    if (textWidth(fact.label) + 4 > inner + 2) continue;
    let diagram = full ? diagramFor(ctx, fact, inner) : null;
    const parts = fitParts(fact, inner);
    let lines: FactPart[][] | undefined;
    if (!parts && !diagram?.replacesText) {
      // A two-row tile can wrap the full wording instead (and gives up its diagram for it).
      const wrapped = full ? wrapParts(fact.parts, inner, 2) : null;
      if (!wrapped) continue;
      lines = wrapped;
      diagram = null;
    }
    fam.set(fact.family, (fam.get(fact.family) ?? 0) + 1);
    out.push({ fact, parts: parts ?? fact.parts, diagram, lines });
  }
  return out;
}

const CORE = new Set(['manners', 'mood_drift', 'priciest_sentence', 'longest_sit', 'pet_name', 'nemesis']);

/** The grid that shows the most core facts (then the most facts, then the fewest rows). */
function bestGrid(ctx: Ctx, w: number, n: number, mode: 'full' | 'compact', maxCols: number, exclude: string[]): { grid: TileGrid; picks: TilePick[] } | null {
  let best: { grid: TileGrid; picks: TilePick[]; score: number } | null = null;
  for (let cols = maxCols; cols >= 1; cols--) {
    const grid = tileGrid(w, mode === 'full' ? 28 : 24, cols);
    if (!grid || grid.cols !== cols) continue;
    const picks = pickTiles(ctx, n, grid.tileW - 4, exclude, mode === 'full');
    if (!picks.length) continue;
    const score = picks.filter(p => CORE.has(p.fact.id)).length * 1000 + picks.length * 10 - Math.ceil(picks.length / cols);
    if (!best || score > best.score) best = { grid, picks, score };
  }
  return best;
}

function tile(ctx: Ctx, t: TilePick, x: number, y: number, w: number, bodyRows: 1 | 2, k: number): void {
  const { th, uni } = ctx;
  const col = th.rule;
  const hz = uni ? '─' : '-';
  const h = bodyRows + 2;
  put(ctx, x, y, uni ? '╭' : '+', col); put(ctx, x + w - 1, y, uni ? '╮' : '+', col);
  put(ctx, x, y + h - 1, uni ? '╰' : '+', col); put(ctx, x + w - 1, y + h - 1, uni ? '╯' : '+', col);
  for (let i = x + 1; i < x + w - 1; i++) { put(ctx, i, y, hz, col); put(ctx, i, y + h - 1, hz, col); }
  for (let j = y + 1; j < y + h - 1; j++) { put(ctx, x, j, uni ? '│' : '|', col); put(ctx, x + w - 1, j, uni ? '│' : '|', col); }
  // The label sits in the top border: ╭─ MANNERS ─────╮
  const label = t.diagram?.label && textWidth(t.diagram.label) + 4 <= w ? t.diagram.label : t.fact.label;
  T(ctx, x + 2, y, ` ${label} `, { fg: th.label, bold: true });
  const ix = x + 2, iw = w - 4;
  if (bodyRows === 2 && t.lines) t.lines.forEach((l, i) => drawParts(ctx, ix, y + 1 + i + (t.lines!.length === 1 ? 1 : 0), l));
  else if (bodyRows === 2 && t.diagram) {
    t.diagram.draw(ix, y + 1, iw, k);
    if (!t.diagram.replacesText) drawParts(ctx, ix, y + 2, t.parts);
  } else drawParts(ctx, ix, y + 1, t.parts);
}

interface TileGrid { cols: number; tileW: number; gap: number }

function tileGrid(w: number, minTile: number, maxCols: number): TileGrid | null {
  for (let cols = maxCols; cols >= 1; cols--) {
    const gap = cols > 1 ? 2 : 0;
    const tileW = Math.floor((w - gap * (cols - 1)) / cols);
    if (tileW >= minTile) return { cols, tileW: Math.min(tileW, 52), gap };
  }
  return null;
}

/** The tiles block: ≤ n tiles in a grid, or (lines mode) receipt lines "LABEL ..... fact". */
function factsBlock(ctx: Ctx, w: number, opts: { n: number; mode: 'full' | 'compact' | 'lines'; rowGap: number; maxCols: number; exclude: string[] }): Piece | null {
  const { th } = ctx;
  if (opts.mode === 'lines') {
    const picks = pickTiles(ctx, opts.n, w, opts.exclude, false).filter(t => textWidth(t.fact.label) + 3 + textWidth(factText(t.parts)) <= w);
    if (!picks.length) return null;
    return {
      h: picks.length, draw: (x, y) => picks.forEach((t, i) => {
        T(ctx, x, y + i, t.fact.label, { fg: th.label, bold: true });
        const vw = textWidth(factText(t.parts));
        for (let px = x + textWidth(t.fact.label) + 1; px < x + w - vw - 1; px++) put(ctx, px, y + i, '.', th.faint);
        drawParts(ctx, x + w - vw, y + i, t.parts);
      }),
    };
  }
  const best = bestGrid(ctx, w, opts.n, opts.mode, opts.maxCols, opts.exclude);
  if (!best) return null;
  const { grid, picks } = best;
  const bodyRows: 1 | 2 = opts.mode === 'full' ? 2 : 1;
  const rows = Math.ceil(picks.length / grid.cols);
  const th1 = bodyRows + 2;
  return {
    h: rows * th1 + (rows - 1) * opts.rowGap, draw: (x, y) => {
      const total = grid.cols * grid.tileW + (grid.cols - 1) * grid.gap;
      const x0 = x + Math.floor((w - total) / 2);
      picks.forEach((t, i) => {
        const r = Math.floor(i / grid.cols), cI = i % grid.cols;
        // A text-only fact in a two-row tile: centre it vertically.
        const pick = bodyRows === 2 && !t.diagram ? { ...t, diagram: { rows: 1 as const, draw: () => undefined } } : t;
        tile(ctx, pick, x0 + cI * (grid.tileW + grid.gap), y + r * (th1 + opts.rowGap), grid.tileW, bodyRows, ctx.grow(3 + i));
      });
    },
  };
}

/* ── trophies ─────────────────────────────────────────────────────────────── */

type Trophy = BoardSummary['awards'][number];

const CUP = ['#######', '#.###.#', '.#####.', '..###..', '...#...', '..###..'];

function drawCup(ctx: Ctx, x: number, y: number, metal: Rgb): void {
  const bg = ctx.th.bg ?? C.ink;
  // Paint the cup's cells with the panel colour first so half-blocks blend into it.
  for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 7; rx++) ctx.c.put(x + rx, y + ry, ' ', ctx.th.ink, bg);
  CUP.forEach((row, py) => {
    for (let px = 0; px < row.length; px++) {
      if (row[px] !== '#') continue;
      // One soft highlight down the bowl's left side; the rest is solid metal.
      const shade = (px === 2 && py >= 1 && py <= 2) || (px === 3 && py === 3) ? mix(metal, C.white, 0.45) : metal;
      ctx.c.px(x + px, y * 2 + py, shade);
    }
  });
}

/** Trophies that no shown fact or slot repeats, at most `n`. */
function pickTrophies(d: BoardSummary, shown: readonly FunFact[], extraCovered: readonly string[], n: number): Trophy[] {
  const covered = new Set([...shown.flatMap(f => f.awards), ...extraCovered]);
  return d.awards.filter(a => !a.id || !covered.has(a.id)).slice(0, n);
}

const tValue = (ctx: Ctx, t: Trophy) => (ctx.s.share ? t.publicValue : t.value);
const tSub = (ctx: Ctx, t: Trophy) => (ctx.s.share ? t.publicSub : t.sub) ?? null;

/**
 * A trophy's mini diagram, if its numbers are known:
 *   streak   a strip of days under the text (one row, `w` wide at most)
 *   subagents  a fan-out tree beside the text, three rows tall:
 *                  ╭──● ● ●
 *              you─┼──● ● ● ●     one branch per third of the active year,
 *                  ╰──● ●         more leaves where more subagents were spawned
 */
type TrophyDiagram = { side: boolean; w: number; draw: (x: number, y: number, k: number) => void };

const LEAVES = 5;

function trophyDiagram(ctx: Ctx, t: Trophy, w: number): TrophyDiagram | null {
  const { d, th, uni } = ctx;
  if (!uni) return null;
  if (t.id === 'streak' && d.viz.streak && d.viz.streak <= w) {
    const n = d.viz.streak;
    return { side: false, w: n, draw: (x, y, k) => { for (let i = 0; i < n; i++) if (k * n >= i + 0.5) put(ctx, x + i, y, '■', mix(th.num, th.hot, i / n)); } };
  }
  if (t.id === 'orchestrator' && d.viz.subagents) {
    const all = d.viz.subagents.months;
    if (all.filter(m => m > 0).length < 2) return null;
    const first = all.findIndex(m => m > 0), last = all.length - 1 - [...all].reverse().findIndex(m => m > 0);
    const months = all.slice(first, last + 1);
    // Three branches: the year in thirds.
    const third = Math.ceil(months.length / 3);
    const groups = [0, 1, 2].map(i => months.slice(i * third, (i + 1) * third).reduce((s, m) => s + m, 0));
    const max = Math.max(...groups);
    const leaves = groups.map(g => (g > 0 ? Math.max(1, Math.round((g / max) * LEAVES)) : 0));
    const treeW = 'you─┼──'.length + LEAVES * 2 - 1;
    return {
      side: true, w: treeW, draw: (x, y, k) => {
        if (k <= 0) return;
        T(ctx, x, y + 1, 'you', { fg: C.cream, bold: true });
        const jx = x + 4;
        put(ctx, x + 3, y + 1, '─', th.faint);
        put(ctx, jx, y, '╭', th.faint); put(ctx, jx, y + 1, '┼', th.faint); put(ctx, jx, y + 2, '╰', th.faint);
        leaves.forEach((n, row) => {
          put(ctx, jx + 1, y + row, '─', th.faint); put(ctx, jx + 2, y + row, '─', th.faint);
          // Leaves pop out along each branch as the tree fans out.
          const shown = Math.round(n * clamp01(k * 1.4 - row * 0.15));
          for (let i = 0; i < shown; i++) put(ctx, jx + 3 + i * 2, y + row, '●', mix(th.num, th.hot, i / LEAVES));
        });
      },
    };
  }
  return null;
}

function trophiesBlock(ctx: Ctx, w: number, list: Trophy[], mode: 'big' | 'line', leftAlign = false): Piece | null {
  if (!list.length) return null;
  const { th } = ctx;
  if (mode === 'line') {
    const items = list.map(t => ({ t, text: `${t.title}  ${tValue(ctx, t)}` }));
    const total = items.reduce((s, it) => s + 2 + textWidth(it.text), 0) + (items.length - 1) * 6;
    if (total > w) return items.length > 1 ? trophiesBlock(ctx, w, list.slice(0, 1), 'line') : null;
    return {
      h: 1, draw: (x, y, ww) => {
        let cx = x + Math.floor((ww - total) / 2);
        for (const { t } of items) {
          const metal = metalColor(t.tier);
          put(ctx, cx, y, ctx.uni ? '★' : '*', metal);
          cx += 2;
          cx += T(ctx, cx, y, t.title, { fg: th.ink, bold: true }) + 2;
          cx += T(ctx, cx, y, tValue(ctx, t), { fg: metal }) + 6;
        }
      },
    };
  }
  if (!ctx.pixel) return trophiesBlock(ctx, w, list, 'line');
  const colW = Math.floor((w - (list.length - 1) * 4) / list.length);
  const textW = colW - 9;
  const fits = (t: Trophy) => textWidth(t.title) <= textW && textWidth(tValue(ctx, t)) <= textW;
  const keep = list.filter(fits);
  if (!keep.length) return trophiesBlock(ctx, w, list, 'line');
  if (keep.length < list.length) return trophiesBlock(ctx, w, keep, 'big');
  return {
    h: 3, draw: (x, y, ww) => {
      const n = list.length;
      const natural = list.map(t => {
        const dg = trophyDiagram(ctx, t, textW);
        const sub = tSub(ctx, t);
        const line2 = sub && textWidth(`${tValue(ctx, t)}  ·  ${sub}`) <= textW ? `${tValue(ctx, t)}  ·  ${sub}` : tValue(ctx, t);
        const textCol = Math.max(textWidth(t.title), textWidth(line2));
        const fitDg = dg && (dg.side ? textCol + 3 + dg.w : dg.w) <= textW ? dg : null;
        return { t, dg: fitDg, line2, textCol, w: 9 + (fitDg?.side ? textCol + 3 + fitDg.w : Math.max(textCol, fitDg?.w ?? 0)) };
      });
      const gap = n > 1 ? Math.min(12, Math.floor((ww - natural.reduce((s, v) => s + v.w, 0)) / (n - 1))) : 0;
      const total = natural.reduce((s, v) => s + v.w, 0) + gap * (n - 1);
      let cx = leftAlign ? x : x + Math.floor((ww - total) / 2);
      natural.forEach(({ t, dg, line2, textCol, w: tw }, i) => {
        const metal = metalColor(t.tier);
        drawCup(ctx, cx, y, metal);
        const tx = cx + 9;
        T(ctx, tx, y, t.title, { fg: th.ink, bold: true });
        T(ctx, tx, y + 1, line2, { fg: metal });
        if (dg?.side) dg.draw(tx + textCol + 3, y, ctx.grow(10 + i));
        else if (dg) dg.draw(tx, y + 2, ctx.grow(10 + i));
        cx += tw + gap;
      });
    },
  };
}

/* ── footer, memory line, barcode ─────────────────────────────────────────── */

const memoryText = (uni: boolean) => `${MEMORY_LINE} ${uni ? '→' : '->'} slopie setup`;

function memoryLine(ctx: Ctx, y: number, cx: number, bg?: Rgb): void {
  const text = memoryText(ctx.uni);
  const x = cx - Math.floor(textWidth(text) / 2);
  const w = ctx.c.text(x, y, MEMORY_LINE + ' ', { fg: C.gray, italic: true, bg });
  ctx.c.text(x + w, y, (ctx.uni ? '→' : '->') + ' slopie setup', { fg: C.peach, bg });
}

function footer(ctx: Ctx, y: number, mx: number): void {
  const { c, s, d, uni } = ctx;
  const local = s.online ? 'online · Jev' : 'all local';
  const dot = uni ? '●' : '*';
  const right = `${INSTALL}  ·  ${dot} ${local}`;
  const rx = s.w - mx - textWidth(right);
  let x = mx;
  if (!s.share) {
    const keys: [string, string][] = [[uni ? '←' : '<', d.replay ? 'replay your story' : 'story'], ['s', 'share'], ['?', 'how'], ['q', 'quit']];
    for (const [k, label] of keys) {
      if (x + textWidth(k) + 1 + textWidth(label) + 3 > rx - 2) break;
      x += c.text(x, y, k, { fg: C.gray, bold: true });
      x += 1 + c.text(x + 1, y, label, { fg: C.slate }) + 3;
    }
  } else {
    c.text(mx, y, 'slopie audit', { fg: C.orange, bold: true });
    x = mx + 14;
  }
  if (rx > x) {
    c.text(rx, y, INSTALL, { fg: C.orange, bold: true });
    c.text(rx + textWidth(INSTALL) + 2, y, '·', { fg: C.slate });
    c.text(s.w - mx - textWidth(local) - 2, y, dot, { fg: s.online ? C.peach : fade(C.orange, 0.7) });
    c.text(s.w - mx - textWidth(local), y, local, { fg: C.slate });
  } else if (textWidth(INSTALL) <= s.w - mx * 2) {
    c.fill(mx, y, s.w - mx * 2, 1, ' ', { bg: C.ink });
    c.text(s.w - mx - textWidth(INSTALL), y, INSTALL, { fg: C.orange, bold: true });
  }
}

function barcode(ctx: Ctx, w: number): Piece {
  return {
    h: 3, draw: (x, y, ww) => {
      const seed = [...(ctx.d.code ?? 'SLOP')].map(ch => ch.charCodeAt(0));
      const bw = Math.min(w - 8, 40);
      const bx = x + Math.floor((ww - bw) / 2);
      for (let i = 0; i < bw; i++) {
        const v = (seed[i % seed.length]! * (i + 7)) % 5;
        const glyph = ctx.uni ? ['▌', '▍', '▎', '▊', '█'][v]! : '|';
        put(ctx, bx + i, y, glyph, ctx.th.ink);
      }
      const thanks = 'THANK YOU. COME AGAIN.';
      T(ctx, x + Math.floor((ww - textWidth(thanks)) / 2), y + 2, thanks, { fg: ctx.th.ink, bold: true });
    },
  };
}

/* ── layout ───────────────────────────────────────────────────────────────── */

interface Plan {
  kicker: boolean;
  bigTitle: boolean;
  subRole: boolean;
  tagline: boolean;
  bigPrice: boolean;
  clock: boolean;
  tiles: 'full' | 'compact' | 'lines';
  nFacts: number;
  tileGap: number;
  trophies: 'big' | 'line' | 'none';
  tail: boolean;
  memory: boolean;
  header: boolean;
  ticker: boolean;
}

const STEPS: ((p: Plan) => void)[] = [
  p => { p.tail = false; },
  p => { p.ticker = false; },
  p => { p.tileGap = 0; },
  p => { p.kicker = false; },
  p => { if (p.trophies === 'big') p.trophies = 'line'; },
  p => { p.memory = false; },
  p => { p.bigTitle = false; },
  p => { p.clock = false; },
  p => { if (p.tiles === 'full') p.tiles = 'compact'; },
  p => { p.subRole = false; },
  p => { p.tiles = 'lines'; },
  p => { p.tagline = false; },
  p => { p.trophies = 'none'; },
  p => { p.header = false; },
  p => { p.bigPrice = false; },
  p => { p.nFacts = 5; },
  p => { p.nFacts = 4; },
  p => { p.nFacts = 3; },
];

interface Built { pieces: { key: string; piece: Piece }[]; facts: FunFact[] }

function build(ctx: Ctx, p: Plan, iw: number): Built {
  const pieces: { key: string; piece: Piece }[] = [];
  const add = (key: string, piece: Piece | null) => { if (piece && piece.h > 0) pieces.push({ key, piece }); };
  if (p.header) add('header', header(ctx, iw));
  add('identity', identity(ctx, iw, { kicker: p.kicker, big: p.bigTitle, subRole: p.subRole, tagline: p.tagline, badge: true }));
  add('price', price(ctx, iw, p.bigPrice));
  const box = statBox(ctx, iw, { clock: p.clock, catchphrase: true });
  add('box', box);
  const exclude = [...(ctx.d.catchphrase ? ['catchphrase'] : []), ...(p.clock && ctx.d.viz.clock ? ['mood_hours'] : [])];
  const factsPiece = factsBlock(ctx, iw, { n: p.nFacts, mode: p.tiles, rowGap: p.tileGap, maxCols: 3, exclude });
  const shown = factsPiece ? shownFacts(ctx, iw, p, exclude) : [];
  add('facts', factsPiece);
  if (p.trophies !== 'none') {
    const covered = ctx.d.catchphrase ? ['verbal_tics', 'catchphrase'] : [];
    add('trophies', trophiesBlock(ctx, iw, pickTrophies(ctx.d, shown, covered, 2), p.trophies));
  }
  if (p.tail) add('tail', barcode(ctx, iw));
  return { pieces, facts: shown };
}

function shownFacts(ctx: Ctx, iw: number, p: Plan, exclude: string[]): FunFact[] {
  if (p.tiles === 'lines') return pickTiles(ctx, p.nFacts, iw, exclude, false).filter(t => textWidth(t.fact.label) + 3 + textWidth(factText(t.parts)) <= iw).map(t => t.fact);
  return bestGrid(ctx, iw, p.nFacts, p.tiles, 3, exclude)?.picks.map(t => t.fact) ?? [];
}

const heightOf = (b: Built) => b.pieces.reduce((s, x) => s + x.piece.h, 0) + Math.max(0, b.pieces.length - 1);

/** Stack pieces into [top, bottom): spare rows become extra air between pieces (capped). */
function stack(b: Built, x: number, w: number, top: number, bottom: number, maxGap: number): void {
  const n = b.pieces.length;
  const extra = new Array(n).fill(0);
  let spare = Math.max(0, bottom - top - heightOf(b));
  for (let pass = 0; spare > 0 && pass < maxGap; pass++) for (let i = 1; i < n && spare > 0; i++) { extra[i]++; spare--; }
  let y = top + Math.floor(spare / 2);
  b.pieces.forEach(({ piece }, i) => { if (i) y += 1 + extra[i]; piece.draw(x, y, w); y += piece.h; });
}

/**
 * The print effect: copy the panel's rows so that only the first `k` printed rows show, sliding
 * up from the slot at the panel's bottom edge. Rows not yet printed show the backdrop.
 */
function printReveal(c: Canvas, x0: number, w: number, top: number, bottom: number, k: number): void {
  const rows = bottom - top + 1;
  const shift = rows - k;
  if (shift <= 0) return;
  const W = c.w;
  for (let y = bottom; y >= top; y--) {
    const src = y - shift;
    for (let x = x0; x < x0 + w; x++) {
      const di = y * W + x;
      if (src >= top) {
        const si = src * W + x;
        c.ch[di] = c.ch[si]!; c.fg[di] = c.fg[si]!; c.bg[di] = c.bg[si]!; c.at[di] = c.at[si]!;
      } else { c.ch[di] = ' '; c.fg[di] = C.cream; c.bg[di] = C.ink; c.at[di] = 0; }
    }
  }
}

/** "SINCE LAST RUN  +412 prompts …" under the poster (re-runs only; never on the share card). */
function tickerLine(ctx: Ctx, y: number, W: number): void {
  const t = ctx.d.sinceLast;
  if (!t || ctx.s.share) return;
  const lead = 'SINCE LAST RUN  ';
  if (textWidth(lead + t) > W - 4) return;
  const x = Math.floor((W - textWidth(lead + t)) / 2);
  ctx.c.text(x, y, lead, { fg: C.orange, bold: true });
  ctx.c.text(x + textWidth(lead), y, t, { fg: C.gray });
}

/** Rows under the panel: ticker, memory line, footer. */
const underRows = (p: Plan) => 1 + (p.memory ? 1 : 0) + (p.ticker ? 1 : 0);

function drawUnder(ctx: Ctx, p: Plan): void {
  const { s } = ctx;
  let y = s.h - underRows(p);
  if (p.ticker) tickerLine(ctx, y++, s.w);
  if (p.memory) memoryLine(ctx, y++, Math.floor(s.w / 2));
  footer(ctx, s.h - 1, 2);
}

function basePlan(s: Scene, d: BoardSummary): Plan {
  return {
    kicker: true, bigTitle: true, subRole: true, tagline: true, bigPrice: true, clock: true, tiles: 'full', nFacts: 6, tileGap: 1,
    trophies: 'big', tail: true, memory: true, header: true,
    ticker: !!d.sinceLast && !s.share,
  };
}

/* ── the poster ───────────────────────────────────────────────────────────── */

/** The torn bottom edge of the receipt: a dim zig-zag on the dark background. */
const TORN = hx('4a3f39');

export function posterBody(s: Scene, d: BoardSummary): boolean {
  const ctx = context(s, d);
  const W = s.w, H = s.h;
  const pw = Math.min(W - (W >= 110 ? 8 : 4), 112);
  const x0 = Math.floor((W - pw) / 2);
  const pad = pw >= 100 ? 4 : 3;
  const ix = x0 + pad, iw = pw - pad * 2;
  const plan = basePlan(s, d);
  // Rows: top air (1), air above the torn edge (1), torn edge (1), then ticker / memory / footer.
  const avail = (p: Plan) => H - underRows(p) - 3;
  let built = build(ctx, plan, iw);
  for (const step of STEPS) { if (heightOf(built) <= avail(plan)) break; step(plan); built = build(ctx, plan, iw); }
  const bottom = H - 1 - underRows(plan); // torn edge row
  for (let x = x0; x < x0 + pw; x++) ctx.c.put(x, bottom, ctx.uni ? ((x - x0) % 2 ? '╲' : '╱') : (x - x0) % 2 ? '\\' : '/', TORN);
  stack(built, ix, iw, 1, bottom - 1, H >= 36 ? 2 : 1);
  // Print: the receipt slides up out of the slot, one row at a time.
  const k = Math.floor(clamp01(s.t / PRINT_MS) * (bottom + 1));
  if (k < bottom + 1) { ctx.busy = true; printReveal(ctx.c, x0, pw, 0, bottom, k); }
  drawUnder(ctx, plan);
  return ctx.busy;
}
