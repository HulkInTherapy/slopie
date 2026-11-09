/** Cold open (a typed quote), how you talk, the manners balance, then vs now. */
import { count, shortDate } from '../format.js';
import { textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { countUp } from '../gfx/motion.js';
import type { DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, label, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

/* ── cold open ── */

export function coldOpenBody(k: K, data: Data<'cold_open'>, r: Rect): void {
  const { tk, L, s } = k;
  const width = Math.min(r.w, L ? 64 : 56);
  const lines = wrapText(`“${data.quote}”`, width, 4);
  const chars = lines.reduce((n, l) => n + [...l].length, 0);
  const perChar = Math.min(32, 1500 / Math.max(1, chars));
  const typed = s.caps.motion ? Math.floor(Math.max(0, s.t - 350) / perChar) : Infinity;
  const caption = data.caption ? wrapText(data.caption, width) : [];
  const blockH = lines.length + 2 + (caption.length <= 2 ? caption.length + 1 : 0);
  const y0 = r.y + Math.max(0, Math.floor((r.h - blockH) / 3));
  let left = typed;
  let cursor: [number, number] | null = null;
  lines.forEach((line, i) => {
    const n = [...line].length;
    const shown = [...line].slice(0, Math.max(0, left)).join('');
    const w = txt(k, r.x, y0 + i, shown, tk.text, { bold: true });
    if (left < n && cursor === null) cursor = [r.x + w, y0 + i];
    left -= n;
  });
  const doneAt = 350 + chars * perChar;
  if (s.caps.motion && s.t < doneAt + 1100) k.busy = true;
  if (cursor && Math.floor(s.t / 280) % 2 === 0) k.c.put(cursor[0], cursor[1], k.uni ? '▌' : '_', tk.text2, tk.bg, 0);
  const sa = fade(k, doneAt + 150, 400);
  txt(k, r.x, y0 + lines.length + 1, data.stamp, tk.text3, { a: sa });
  if (caption.length && caption.length <= 2) {
    const ca = fade(k, doneAt + 550, 500);
    caption.forEach((line, i) => txt(k, r.x, y0 + lines.length + 3 + i, line, tk.text2, { a: ca }));
  }
}

/* ── how you talk ── */

export function talkBody(k: K, data: Data<'talk'>, r: Rect): void {
  const { tk, L, s } = k;
  const tiles = data.tiles;
  const cols = r.w >= 60 ? 2 : 1;
  const gap = 6;
  const colW = Math.floor((r.w - gap * (cols - 1)) / cols);
  const rows = Math.ceil(tiles.length / cols);
  const cellH = Math.max(3, Math.min(L ? 6 : 4, Math.floor((r.h + 1) / rows) - 1));
  tiles.forEach((tile, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * (colW + gap);
    const y = r.y + row * (cellH + 1);
    if (y + 2 > r.y + r.h) return;
    const start = 80 + i * 120;
    const a = fade(k, start, 360);
    if (row) rule(k, x, y - 1, colW, tk.rule, a);
    if (col) vrule(k, x - Math.ceil(gap / 2), y, cellH - 1, a);
    label(k, x, y, tile.label, a, colW);
    const countText = tile.count !== null ? `×${count(s.caps.motion ? Math.round(countUp(tile.count, s.t, start, 800)) : tile.count)}` : '';
    if (tile.count !== null && s.caps.motion && s.t < start + 800) k.busy = true;
    const finalCount = tile.count !== null ? `×${count(tile.count)}` : '';
    const phraseW = colW - (finalCount ? textWidth(finalCount) + 3 : 0);
    const phrase = tile.quoted ? `“${tile.text}”` : tile.text;
    const lines = wrapText(phrase, phraseW, cellH >= 5 ? 2 : 1);
    lines.forEach((line, li) => txt(k, x, y + 1 + li, line, tk.text, { bold: !tile.quoted, italic: tile.quoted, a }));
    if (countText) txtRight(k, x + colW, y + 1, countText, tk.text, { bold: true, a });
    if (tile.sub && cellH >= 4 && textWidth(tile.sub) <= colW) txt(k, x, y + 1 + lines.length, tile.sub, tk.text3, { a });
  });
  if (s.caps.motion && s.t < 1100) k.busy = true;
}

/* ── manners: two numbers and the balance between them ── */

export function mannersBody(k: K, data: Data<'manners'>, r: Rect): void {
  const { tk, L, s } = k;
  const total = data.kind + data.rude || 1;
  const colW = Math.floor((Math.min(r.w, L ? 96 : r.w) + 4) / 2);
  const opts = k.uni ? fitDisplay(count(Math.max(data.kind, data.rude)), colW - 6, { face: tk.face, tall: L && r.h >= 14 }) : null;
  const numH = opts ? displayHeight(opts) : 1;
  const y0 = r.y + Math.max(0, Math.floor((r.h - numH - 7) / 3));
  const side = (i: 0 | 1, value: number, word: string) => {
    const x = r.x + i * colW;
    const start = 150 + i * 150;
    const a = fade(k, start, 300);
    if (i) vrule(k, x - 3, y0, numH + 2, a);
    const shown = count(s.caps.motion ? Math.round(countUp(value, s.t, start, 900)) : value);
    if (s.caps.motion && s.t < start + 900) k.busy = true;
    if (opts) drawDisplay(k.c, x, y0, shown, fadeIn(tk, tk.text, a), tk.bg, opts);
    else txt(k, x, y0, shown, tk.text, { bold: true, a });
    txt(k, x, y0 + numH + 1, word, tk.text2, { a }, colW - 4);
  };
  side(0, data.kind, data.kindLabel);
  side(1, data.rude, data.rudeLabel);
  // The balance: one line split at the kind share.
  const by = y0 + numH + 4;
  const bw = Math.min(colW * 2 - 4, r.w);
  if (by < r.y + r.h) {
    const kindW = Math.max(data.kind > 0 ? 1 : 0, Math.round((bw * data.kind) / total));
    meter(k, r.x, by, kindW, 1, tk.text, 500);
    meter(k, r.x + kindW, by, bw - kindW, 1, tk.text3, 700);
  }
  const ratio = data.kind > 0 ? data.rude / data.kind : null;
  if (ratio !== null && by + 2 < r.y + r.h) {
    const a = fade(k, 1300, 400);
    const text = ratio >= 1 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)} swears for every kind word` : `${(1 / ratio).toFixed(1)} kind words for every swear`;
    txt(k, r.x, by + 2, text, tk.text, { bold: true, a });
  }
  if (s.caps.motion && s.t < 2300) k.busy = true;
}

/* ── then vs now ── */

export function thenNowBody(k: K, data: Data<'then_now'>, r: Rect): void {
  const { tk, L, s } = k;
  const gap = 6;
  const bw = Math.floor((r.w - gap) / 2);
  const maxWords = Math.max(data.then.words, data.now.words, 1);
  const column = (x: number, name: string, side: { day: string; words: number; quote: string | null }, shell: boolean, now: boolean, start: number) => {
    const a = fade(k, start, 400);
    const lw = label(k, x, r.y, name, a);
    txt(k, x + lw + 2, r.y, shortDate(side.day, true), tk.text3, { a });
    const text = side.quote ? `“${side.quote}”` : shell ? 'a terminal command, typed into a chat box' : `${count(side.words)} words`;
    const lines = wrapText(text, bw, L ? 4 : 3);
    lines.forEach((line, i) => txt(k, x, r.y + 2 + i, line, now ? tk.text : tk.text2, { italic: Boolean(side.quote), a }));
    const my = r.y + 2 + (L ? 5 : 4);
    if (my + 1 >= r.y + r.h) return;
    const ww = txt(k, x, my, count(side.words), tk.text, { bold: true, a });
    txt(k, x + ww + 1, my, 'words', tk.text2, { a });
    meter(k, x, my + 1, Math.max(4, bw - 2), side.words / maxWords, now ? tk.text : tk.bar, start + 200);
  };
  column(r.x, 'then', data.then, data.then.shell, false, 0);
  vrule(k, r.x + bw + Math.floor(gap / 2), r.y, Math.min(r.h, L ? 9 : 8), fade(k, 300));
  column(r.x + bw + gap, 'now', data.now, false, true, 500);
  const fy = r.y + (L ? 11 : 9);
  if (fy < r.y + r.h) {
    const ga = fade(k, 1200, 400);
    const line = `${count(data.spanDays)} days and ${count(data.prompts)} prompts apart · ${(data.now.words / Math.max(1, data.then.words)).toFixed(1)}× the words`;
    if (textWidth(line) <= r.w) txt(k, r.x, fy, line, tk.text2, { a: ga });
  }
  if (s.caps.motion && s.t < 1700) k.busy = true;
}
