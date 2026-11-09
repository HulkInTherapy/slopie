/** Cold open (a typed quote), how you talk, the manners balance, then vs now. */
import { count, shortDate } from '../format.js';
import { textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { countUp } from '../gfx/motion.js';
import type { DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, heroScale, label, rule, strokeNum, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

/* ── cold open ── */

export function coldOpenBody(k: K, data: Data<'cold_open'>, r: Rect): void {
  const { tk, s } = k;
  // The quote centred, bold, at most two lines, its quotation marks in the accent.
  const width = Math.min(r.w, 96);
  let lines = wrapText(data.quote, width - 2, 2);
  if (lines.length === 2 && wrapText(data.quote, width - 2).length > 2) lines = [lines[0]!, lines[1]!.replace(/\s*\S*$/, '') + '…'];
  const chars = lines.reduce((n, l) => n + [...l].length, 0);
  const perChar = Math.min(32, 1500 / Math.max(1, chars));
  const typed = s.caps.motion ? Math.floor(Math.max(0, s.t - 350) / perChar) : Infinity;
  const blockH = lines.length * 2 + 2;
  const y0 = r.y + Math.max(0, Math.floor((r.h - blockH) / 2) - 2);
  const cx = r.x + Math.floor(r.w / 2);
  let left = typed;
  let cursor: [number, number] | null = null;
  lines.forEach((line, i) => {
    const n = [...line].length;
    const x = cx - Math.floor((n + (i === 0 ? 1 : 0) + (i === lines.length - 1 ? 1 : 0)) / 2);
    const y = y0 + i * 2;
    let lx = x;
    if (i === 0) lx += txt(k, lx, y, '“', tk.accent, { bold: true });
    const shown = [...line].slice(0, Math.max(0, left)).join('');
    lx += txt(k, lx, y, shown, tk.text, { bold: true });
    if (left < n && cursor === null) cursor = [lx, y];
    if (i === lines.length - 1 && left >= n) txt(k, lx, y, '”', tk.accent, { bold: true });
    left -= n;
  });
  const doneAt = 350 + chars * perChar;
  if (s.caps.motion && s.t < doneAt + 1100) k.busy = true;
  if (cursor && Math.floor(s.t / 280) % 2 === 0) k.c.put(cursor[0], cursor[1], k.uni ? '▌' : '_', tk.accent, tk.bg, 0);
  const sa = fade(k, doneAt + 150, 400);
  txt(k, cx - Math.floor(textWidth(data.stamp) / 2), y0 + lines.length * 2 + 1, data.stamp, tk.text3, { a: sa });
}

/* ── how you talk ── */

export function talkBody(k: K, data: Data<'talk'>, r: Rect): void {
  const { tk, s } = k;
  const tiles = data.tiles.slice(0, 4);
  const cols = r.w >= 60 ? 2 : 1;
  const gap = 8;
  const colW = Math.floor((r.w - gap * (cols - 1)) / cols);
  const rows = Math.ceil(tiles.length / cols);
  const cellH = Math.max(3, Math.min(9, Math.floor((r.h + 2) / rows) - 2));
  const y0 = r.y + Math.max(0, Math.floor((r.h - rows * (cellH + 2) + 2) / 2));
  tiles.forEach((tile, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * (colW + gap);
    const y = y0 + row * (cellH + 2);
    if (y + 2 > r.y + r.h) return;
    const start = 80 + i * 120;
    const a = fade(k, start, 360);
    if (row) rule(k, x, y - 1, colW, tk.rule, a);
    label(k, x, y, tile.label, a, colW);
    const shownCount = tile.count !== null ? `×${count(s.caps.motion ? Math.round(countUp(tile.count, s.t, start, 800)) : tile.count)}` : '';
    if (tile.count !== null && s.caps.motion && s.t < start + 800) k.busy = true;
    const finalCount = tile.count !== null ? `×${count(tile.count)}` : '';
    const stroke = cellH >= 5 && k.uni ? displayWidth(finalCount, { face: 'heavy' }) : textWidth(finalCount);
    const phraseW = colW - (finalCount ? stroke + 3 : 0) - 2;
    const lines = wrapText(tile.text, phraseW, cellH >= 6 ? 2 : 1);
    const py = y + 2;
    lines.forEach((line, li) => {
      let lx = x;
      if (tile.quoted && li === 0) lx += txt(k, lx, py + li, '“', tk.accent, { bold: true, a });
      lx += txt(k, lx, py + li, line, tk.text, { bold: true, a });
      if (tile.quoted && li === lines.length - 1) txt(k, lx, py + li, '”', tk.accent, { bold: true, a });
    });
    if (shownCount) {
      if (cellH >= 5) strokeNum(k, x + colW - stroke, py - 1, shownCount, tk.accentHi, a);
      else txtRight(k, x + colW, py, shownCount, tk.accentHi, { bold: true, a });
    }
    if (tile.sub && cellH >= 5 && textWidth(tile.sub) <= colW) txt(k, x, py + lines.length + 1, tile.sub, tk.text3, { a });
  });
  if (s.caps.motion && s.t < 1100) k.busy = true;
}

/* ── manners: the ratio as the hero, then two bars ── */

export function mannersBody(k: K, data: Data<'manners'>, r: Rect): void {
  const { tk, L, s } = k;
  const ratio = data.kind > 0 ? data.rude / data.kind : null;
  const hero = ratio !== null ? `${ratio >= 1 ? ratio.toFixed(ratio >= 10 ? 0 : 1).replace(/\.0$/, '') : (1 / ratio).toFixed(1).replace(/\.0$/, '')}×` : count(data.rude);
  const opts = k.uni ? fitDisplay(hero, r.w, { face: tk.face, tall: L, scale: heroScale(k), currency: tk.accentHi }) : null;
  const numH = opts ? displayHeight(opts) : 1;
  const y0 = r.y + Math.max(0, Math.floor((r.h - numH - 9) / 2));
  const a = fade(k, 100, 400);
  if (opts) drawDisplay(k.c, r.x, y0, hero, fadeIn(tk, tk.accentHi, a), tk.bg, opts);
  else txt(k, r.x, y0, hero, tk.accentHi, { bold: true, a });
  if (ratio !== null) txt(k, r.x, y0 + numH + 1, ratio >= 1 ? 'swears for every kind word' : 'kind words for every swear', tk.text2, { a });
  const max = Math.max(1, data.kind, data.rude);
  const bw = Math.min(r.w - 30, 90);
  const bar = (i: number, value: number, word: string, ink: number) => {
    const y = y0 + numH + 4 + i * 3;
    if (y >= r.y + r.h) return;
    const ba = fade(k, 500 + i * 150, 300);
    label(k, r.x, y, word, ba, 22);
    meter(k, r.x + 24, y, bw, value / max, ink, 500 + i * 150);
    const shown = count(s.caps.motion ? Math.round(countUp(value, s.t, 500, 900)) : value);
    txt(k, r.x + 26 + bw, y, shown, tk.text, { bold: true, a: ba });
  };
  bar(0, data.kind, data.kindLabel, tk.text2);
  bar(1, data.rude, data.rudeLabel, tk.accent);
  if (s.caps.motion && s.t < 2300) k.busy = true;
}

/* ── then vs now ── */

export function thenNowBody(k: K, data: Data<'then_now'>, r: Rect): void {
  const { tk, L, s } = k;
  const gap = 8;
  const bw = Math.floor((r.w - gap) / 2);
  const maxWords = Math.max(data.then.words, data.now.words, 1);
  const y0 = r.y + Math.max(0, Math.floor((r.h - 16) / 3));
  const column = (x: number, name: string, side: { day: string; words: number; quote: string | null }, shell: boolean, now: boolean, start: number) => {
    const a = fade(k, start, 400);
    const lw = label(k, x, y0, name, a, Infinity, now ? tk.accentHi : tk.text3);
    txt(k, x + lw + 2, y0, shortDate(side.day, true), tk.text2, { a });
    const text = side.quote ? `“${side.quote}”` : shell ? 'a terminal command, typed into a chat box' : `${count(side.words)} words`;
    const lines = wrapText(text, bw, 3);
    lines.forEach((line, i) => txt(k, x, y0 + 2 + i, line, tk.text, { italic: Boolean(side.quote), a }));
    const my = y0 + 7;
    if (my + 4 >= r.y + r.h) return;
    const big = strokeNum(k, x, my, count(side.words), now ? tk.accentHi : tk.text2, a);
    txt(k, x + big.w + 2, my + big.h - 1, 'words', tk.text2, { a });
    meter(k, x, my + big.h + 1, Math.max(4, bw - 2), side.words / maxWords, now ? tk.accent : tk.bar, start + 200);
  };
  column(r.x, 'then', data.then, data.then.shell, false, 0);
  vrule(k, r.x + bw + Math.floor(gap / 2), y0, Math.min(r.h, 12), fade(k, 300));
  column(r.x + bw + gap, 'now', data.now, false, true, 500);
  const fy = y0 + 14 + (L ? 1 : 0);
  if (fy < r.y + r.h) {
    const ga = fade(k, 1200, 400);
    const ratio = (data.now.words / Math.max(1, data.then.words)).toFixed(0);
    const line = `${ratio}× the words · ${count(data.spanDays)} days apart`;
    if (textWidth(line) <= r.w) txt(k, r.x + Math.floor((r.w - textWidth(line)) / 2), fy, line, tk.text, { bold: true, a: ga });
  }
  if (s.caps.motion && s.t < 1700) k.busy = true;
}
