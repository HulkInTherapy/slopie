/**
 * The display face: one skeleton per glyph, written with heavy box-drawing strokes (3 rows), and
 * two ways to set it:
 *
 *   solid  filled half-block pixels in one tone (the face: a clean block face, no gradient)
 *   heavy  the strokes as written, ┏━┓ ┏━╸ (the narrow fallback when solid does not fit)
 *
 * `tall` stretches a glyph to 5 rows (hero numbers).
 */
import type { Canvas } from '../gfx/canvas.js';
import type { Rgb } from '../gfx/color.js';
import type { DisplayFace } from './tokens.js';

const G: Record<string, [string, string, string]> = {
  A: ['┏━┓', '┣━┫', '╹ ╹'], B: ['┏┓ ', '┣┻┓', '┗━┛'], C: ['┏━╸', '┃  ', '┗━╸'], D: ['┏━┓', '┃ ┃', '┗━┛'],
  E: ['┏━╸', '┣╸ ', '┗━╸'], F: ['┏━╸', '┣╸ ', '╹  '], G: ['┏━╸', '┃╺┓', '┗━┛'], H: ['╻ ╻', '┣━┫', '╹ ╹'],
  I: ['╻', '┃', '╹'], J: ['  ╻', '  ┃', '┗━┛'], K: ['╻┏ ', '┣┻┓', '╹ ╹'], L: ['╻  ', '┃  ', '┗━╸'],
  M: ['┏┳┓', '┃╹┃', '╹ ╹'], N: ['┏┓╻', '┃┗┫', '╹ ╹'], O: ['┏━┓', '┃ ┃', '┗━┛'], P: ['┏━┓', '┣━┛', '╹  '],
  Q: ['┏━┓', '┃┓┃', '┗┻┛'], R: ['┏━┓', '┣┳┛', '╹┗╸'], S: ['┏━╸', '┗━┓', '╺━┛'], T: ['╺┳╸', ' ┃ ', ' ╹ '],
  U: ['╻ ╻', '┃ ┃', '┗━┛'], V: ['╻ ╻', '┃┏┛', '┗┛ '], W: ['╻ ╻', '┃╻┃', '┗┻┛'], X: ['╻ ╻', '┏╋┛', '╹ ╹'],
  Y: ['╻ ╻', '┗┳┛', ' ╹ '], Z: ['╺━┓', '┏━┛', '┗━╸'],
  '0': ['┏━┓', '┃ ┃', '┗━┛'], '1': ['╺┓ ', ' ┃ ', '╺┻╸'], '2': ['╺━┓', '┏━┛', '┗━╸'], '3': ['╺━┓', '╺━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'], '5': ['┏━╸', '┗━┓', '╺━┛'], '6': ['┏━╸', '┣━┓', '┗━┛'], '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'], '9': ['┏━┓', '┗━┫', '╺━┛'],
  ',': [' ', ' ', '╻'], '.': [' ', ' ', '╸'], "'": ['╻', ' ', ' '], '’': ['╻', ' ', ' '], '-': ['  ', '╺╸', '  '],
  '&': ['┏┓ ', '┣╋╸', '┗┛ '], '%': ['╻ ╻', '┏━┛', '╹ ╹'], ':': [' ', '╹', '╹'],
  ' ': ['  ', '  ', '  '],
};

/** Arms of a stroke cell: up, down, left, right. */
type Arms = [boolean, boolean, boolean, boolean];
const ARMS: Record<string, Arms> = {
  '━': [false, false, true, true], '┃': [true, true, false, false], '┏': [false, true, false, true], '┓': [false, true, true, false],
  '┗': [true, false, false, true], '┛': [true, false, true, false], '┣': [true, true, false, true], '┫': [true, true, true, false],
  '┳': [false, true, true, true], '┻': [true, false, true, true], '╋': [true, true, true, true], '╸': [false, false, true, false],
  '╺': [false, false, false, true], '╹': [true, false, false, false], '╻': [false, true, false, false],
};
const key = (a: Arms) => a.map(v => (v ? 1 : 0)).join('');
const HEAVY = new Map(Object.entries(ARMS).map(([ch, a]) => [key(a), ch]));

const glyphOf = (ch: string) => G[ch] ?? G[ch.toUpperCase()] ?? null;
/** Set as small text beside the numerals, the way prices and ratios are typeset: $ on top, × at the baseline. */
const MARKS = new Set(['$', '×']);
export const displaySupported = (text: string) => [...text].every(ch => MARKS.has(ch) || glyphOf(ch) !== null);

type Grid = Arms[][]; // [row][col]

function parse(rows: readonly string[]): Grid {
  return rows.map(r => [...r].map(ch => ARMS[ch] ?? [false, false, false, false]));
}

/** Insert continuation rows so a 3-row glyph becomes 5 rows tall. */
function tallen(g: Grid): Grid {
  const cont = (row: Arms[]): Arms[] => row.map(a => [a[1], a[1], false, false]);
  return [g[0]!, cont(g[0]!), g[1]!, cont(g[1]!), g[2]!];
}

export interface DisplayOptions {
  face: DisplayFace;
  /** 5 rows instead of 3 (hero numbers). */
  tall?: boolean;
  /** Colour of the `$` and `×` marks (secondary tone). */
  currency?: Rgb;
}

type Mark = '$' | '×';
interface Laid { grids: (Grid | Mark)[] }

function layout(text: string, o: DisplayOptions): Laid {
  const grids: (Grid | Mark)[] = [];
  for (const ch of text) {
    if (ch === '$' || ch === '×') { grids.push(ch); continue; }
    const g = glyphOf(ch);
    if (!g) continue;
    let grid = parse(g);
    if (o.tall) grid = tallen(grid);
    grids.push(grid);
  }
  return { grids };
}

/** Cells per stroke column: solid glyphs use two columns per stroke cell (stroke + its right arm). */
const colsOf = (g: Grid, face: DisplayFace) => (face === 'solid' ? g[0]!.length * 2 - 1 : g[0]!.length);
export const gapOf = (face: DisplayFace) => (face === 'solid' ? 2 : 1);

export function displayWidth(text: string, o: DisplayOptions): number {
  const { grids } = layout(text, o);
  let w = 0;
  grids.forEach((g, i) => {
    if (i) w += typeof g === 'string' || typeof grids[i - 1] === 'string' ? 1 : gapOf(o.face);
    w += typeof g === 'string' ? 1 : colsOf(g, o.face);
  });
  return w;
}

/** Height in cell rows. */
export function displayHeight(o: { tall?: boolean; face?: DisplayFace }): number {
  return o.tall ? 5 : 3;
}

/** Draw `text` with its top-left at (x, y) in one colour on background `bg`. Returns the width. */
export function drawDisplay(c: Canvas, x: number, y: number, text: string, fg: Rgb, bg: Rgb, o: DisplayOptions): number {
  const { grids } = layout(text, o);
  let cx = x;
  grids.forEach((g, i) => {
    if (i) cx += typeof g === 'string' || typeof grids[i - 1] === 'string' ? 1 : gapOf(o.face);
    if (typeof g === 'string') {
      c.put(cx, g === '$' ? y : y + displayHeight(o) - 1, g, o.currency ?? fg, bg, 0);
      cx += 1;
      return;
    }
    if (o.face === 'solid') drawSolid(c, cx, y, g, fg, bg);
    else {
      g.forEach((row, ry) => row.forEach((a, rx) => {
        const ch = HEAVY.get(key(a));
        if (ch) c.put(cx + rx, y + ry, ch, fg, bg, 0);
      }));
    }
    cx += colsOf(g, o.face);
  });
  return cx - x;
}

/**
 * Solid face: each stroke cell is a 2-column × `ky`-pixel block (pixel = half a row): the stroke
 * pixel at its top-left, its right arm in the second column, its down arm below. Pixels are
 * folded into ▀ ▄ █ cells in the one ink colour.
 */
function drawSolid(c: Canvas, x: number, y: number, g: Grid, fg: Rgb, bg: Rgb): void {
  // 3-row glyphs: 2 px per stroke row → 5 px (3 cell rows). Tall (5-row) glyphs: 2 px → 9 px (5 rows).
  const ky = 2;
  const W = g[0]!.length * 2 - 1;
  // One spare pixel row at the bottom carries descenders (the comma).
  const H = g.length * ky;
  const on = new Set<string>();
  const set = (px: number, py: number) => { if (px >= 0 && px < W && py >= 0 && py < H) on.add(`${px},${py}`); };
  g.forEach((row, ry) => row.forEach((a, rx) => {
    if (!a.some(Boolean)) return;
    const px = rx * 2, py = ry * ky;
    set(px, py);
    if (a[3]) set(px + 1, py);
    if (a[1]) for (let k = 1; k < ky; k++) set(px, py + k);
  }));
  const rows = Math.ceil(H / 2);
  for (let r = 0; r < rows; r++) for (let col = 0; col < W; col++) {
    const top = on.has(`${col},${r * 2}`), bot = on.has(`${col},${r * 2 + 1}`);
    if (!top && !bot) continue;
    c.put(x + col, y + r, top && bot ? '█' : top ? '▀' : '▄', fg, bg, 0);
  }
}

/** The face's setting of `text` if it fits `maxW`, else the narrower heavy stroke face, else null. */
export function fitDisplay(text: string, maxW: number, base: DisplayOptions): DisplayOptions | null {
  if (!displaySupported(text)) return null;
  for (const face of base.face === 'solid' ? (['solid', 'heavy'] as const) : (['heavy'] as const)) {
    const o = { ...base, face };
    if (displayWidth(text, o) <= maxW) return o;
  }
  return null;
}
