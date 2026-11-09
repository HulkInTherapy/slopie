/**
 * Charts for the redesign directions: monthly bars on a hairline baseline, a single-hue daily
 * grid, horizontal meters and eighth-block sparklines. One ink for ordinary marks; the accent
 * marks the single point the chart is about.
 */
import { heat, mix, type Rgb } from '../gfx/color.js';
import type { Rect } from '../gfx/draw.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import { money, shortDate } from '../format.js';
import { monthLabel } from '../story/deck.js';
import { fade, rule, txt, txtRight, textWidth, type K } from './kit.js';

const V8 = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function grow(k: K, start: number, dur = 600): number {
  if (!k.s.caps.motion) return 1;
  const g = seg(k.s.t, start, dur, easeOutCubic);
  if (g < 1) k.busy = true;
  return g;
}

/** Horizontal meter, `w` cells, value 0..1: a 1-row solid bar on a solid track (track barSoft). */
export function meter(k: K, x: number, y: number, w: number, frac: number, color: Rgb, start = 0, track: Rgb = k.tk.barSoft): void {
  const f = Math.max(0, Math.min(1, frac)) * grow(k, start);
  const { tk } = k;
  if (!k.uni) {
    const n = Math.round(f * w);
    for (let i = 0; i < w; i++) k.c.put(x + i, y, i < n ? '#' : '-', i < n ? color : tk.rule, tk.bg, 0);
    return;
  }
  // Half-cell precision: █ per full cell, ▌ (fill over track) for the last half.
  const halves = Math.round(f * w * 2);
  for (let i = 0; i < w; i++) {
    const on = halves - i * 2;
    if (on >= 2) k.c.put(x + i, y, '█', color, tk.bg, 0);
    else if (on === 1) k.c.put(x + i, y, '▌', color, track, 0);
    else k.c.put(x + i, y, '█', track, tk.bg, 0);
  }
}

/** Eighth-block sparkline; `hi` (index) is drawn in the accent. Returns the width. */
export function spark(k: K, x: number, y: number, values: readonly number[], per: number, ink: Rgb, hi: number | null, start = 0, hiInk: Rgb = k.tk.accent): number {
  const max = Math.max(...values, 1e-9);
  const g = grow(k, start, 700);
  values.forEach((v, i) => {
    const shown = Math.max(0, Math.min(1, g * values.length - i));
    const lvl = v > 0 ? Math.max(1, Math.round((v / max) * 8 * shown)) : 0;
    const ch = k.uni ? (lvl ? V8[lvl]! : '▁') : lvl > 4 ? '#' : lvl ? '+' : '.';
    const col = lvl ? (i === hi ? hiInk : ink) : k.tk.rule;
    for (let j = 0; j < per; j++) k.c.put(x + i * per + j, y, ch, col, k.tk.bg, 0);
  });
  return values.length * per;
}

export interface MonthBar { month: string; measured: number; extra: number }

/** Monthly bars on a hairline baseline, month labels under it, the peak labelled in the accent. */
export function monthBars(k: K, r: Rect, months: readonly MonthBar[], start = 300): void {
  const { tk } = k;
  const list = months.slice(-12);
  const n = list.length;
  const colW = Math.max(2, Math.min(6, Math.floor((r.w + 1) / n)));
  const barW = Math.max(1, colW - (colW >= 4 ? 2 : 1));
  const h = r.h - 3; // the peak's value, bars, then baseline, then labels
  const base = r.y + 1 + h; // baseline row
  const max = Math.max(...list.map(m => m.measured + m.extra), 1e-9);
  const peak = list.reduce((a, m, i) => (m.measured > list[a]!.measured ? i : a), 0);
  rule(k, r.x, base, n * colW - (colW - barW), tk.rule);
  list.forEach((m, i) => {
    const g = grow(k, start + i * 50, 520);
    const x = r.x + i * colW;
    const solid = (m.measured / max) * h * g;
    const total = ((m.measured + m.extra) / max) * h * g;
    const ink = i === peak ? tk.accent : tk.accentLo;
    const cells = Math.ceil(total);
    for (let row = 0; row < cells; row++) {
      const y = base - 1 - row;
      const inSolid = row < solid;
      const part = Math.min(1, total - row);
      const color = inSolid ? ink : tk.barSoft;
      let ch: string;
      if (!k.uni) ch = inSolid ? '#' : ':';
      else ch = part >= 1 ? '█' : V8[Math.max(1, Math.round(part * 8))]!;
      // A bar's measured/extra split inside one cell: show the measured ink.
      for (let b = 0; b < barW; b++) k.c.put(x + b, y, ch, color, tk.bg, 0);
    }
    const lab = monthLabel(m.month);
    if (colW >= 4 || i % 2 === 0 || i === n - 1) txt(k, x, base + 1, colW >= 4 ? lab : lab.slice(0, colW - 0), i === peak ? tk.accentHi : tk.text3, { bold: i === peak }, colW >= 4 ? colW : colW * 2 - 1);
  });
  // Peak value above its bar.
  const pk = list[peak]!;
  const la = fade(k, start + n * 50 + 400);
  const label = money(pk.measured);
  const top = base - 1 - Math.ceil(((pk.measured + pk.extra) / max) * h);
  const lx = Math.min(r.x + peak * colW, r.x + n * colW - textWidth(label));
  if (top >= r.y) txt(k, lx, top, label, tk.text, { bold: true, a: la });
}

/** GitHub-style daily grid on the indigo ramp: weeks across, Mon–Sun down (one row per day when `r.h` ≥ 8, else half-block pixels). */
export function dayGrid(k: K, r: Rect, days: readonly { day: string; usd: number }[], start = 600): { w: number } {
  const { tk } = k;
  if (!days.length) return { w: 0 };
  const byDay = new Map(days.map(d => [d.day, d.usd]));
  const last = new Date(days.at(-1)!.day + 'T12:00:00Z');
  const lx = 4;
  const weeks = Math.min(53, Math.max(4, r.w - lx));
  const first = new Date(last);
  first.setUTCDate(first.getUTCDate() - ((last.getUTCDay() + 6) % 7) - (weeks - 1) * 7);
  const max = Math.max(...days.map(d => d.usd), 1e-9);
  const brightest = [...days].sort((a, b) => b.usd - a.usd)[0]!;
  const pixel = k.s.caps.color === 'truecolor' || k.s.caps.color === '256';
  const tall = r.h >= 8 && k.uni;
  const g = grow(k, start, 900);
  const empty = mix(tk.bg, tk.text, 0.06);
  txt(k, r.x, r.y, 'Mon', tk.text3);
  txt(k, r.x, r.y + (tall ? 6 : 3), 'Sun', tk.text3);
  for (let w = 0; w < weeks; w++) {
    if (w / weeks > g) break;
    for (let d = 0; d < 7; d++) {
      const day = new Date(first);
      day.setUTCDate(first.getUTCDate() + w * 7 + d);
      if (day > last) continue;
      const iso = day.toISOString().slice(0, 10);
      const usd = byDay.get(iso) ?? 0;
      const v = usd > 0 ? Math.sqrt(usd / max) : 0;
      const color = usd <= 0 ? empty : iso === brightest.day ? tk.accentHi : heat(0.1 + v * 0.75);
      if (tall) k.c.put(r.x + lx + w, r.y + d, '▀', color, tk.bg, 0);
      else if (pixel) setPx(k, r.x + lx + w, r.y * 2 + d, color);
      else if (d % 2 === 0) k.c.put(r.x + lx + w, r.y + d / 2, usd <= 0 ? '·' : v > 0.5 ? '#' : '+', usd <= 0 ? tk.rule : tk.text2, tk.bg, 0);
    }
  }
  const ca = fade(k, start + 900);
  const fy = r.y + (tall ? 7 : 4);
  txt(k, r.x + lx, fy, `Brightest ${shortDate(brightest.day, true)}`, tk.text3, { a: ca });
  txtRight(k, r.x + lx + weeks, fy, money(brightest.usd), tk.accentHi, { bold: true, a: ca });
  return { w: lx + weeks };
}

/** Half-block pixel on the theme background (two per cell, top and bottom). */
export function setPx(k: K, x: number, py: number, color: Rgb): void {
  const m = k.px;
  const y = py >> 1;
  const key = y * k.c.w + x;
  const cur = m.get(key) ?? [k.tk.bg, k.tk.bg];
  if (py & 1) cur[1] = color; else cur[0] = color;
  m.set(key, cur);
  const [top, bot] = cur;
  if (top === bot) k.c.put(x, y, top === k.tk.bg ? ' ' : '█', top, k.tk.bg, 0);
  else k.c.put(x, y, '▀', top, bot, 0);
}

