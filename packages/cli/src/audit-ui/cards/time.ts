/** Your clock (weekday × hour grid), the mood line, and the fuse. */
import { heat, mix } from '../gfx/color.js';
import { textWidth, vbar, type Rect } from '../gfx/draw.js';
import { clamp01, easeOutCubic, seg } from '../gfx/motion.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, label, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The 7×24 grid in one hue (the busiest hour in the accent). Returns the drawn width. */
export function drawHeatmap(k: K, grid: number[][], x: number, y: number, cellW: number, peak: [number, number] | null, start = 0): number {
  const { tk, s } = k;
  const max = Math.max(1, ...grid.flat());
  const labelW = 4;
  const none = s.caps.color === 'none';
  for (let d = 0; d < 7; d++) {
    txt(k, x, y + d, DAYS[d]!, d >= 5 ? tk.text3 : tk.text2);
    for (let h = 0; h < 24; h++) {
      const a = s.caps.motion ? seg(s.t, start + 120 + h * 30, 260) : 1;
      if (a < 1) k.busy = true;
      const raw = grid[d]?.[h] ?? 0;
      const v = Math.sqrt(raw / max);
      const isPeak = !!peak && peak[0] === d && peak[1] === h;
      const color = raw <= 0 ? mix(tk.bg, tk.text, 0.06) : isPeak ? tk.accent : heat(0.15 + v * 0.85);
      const cx = x + labelW + h * cellW;
      for (let j = 0; j < Math.max(1, cellW - 1); j++) {
        if (none) k.c.put(cx + j, y + d, v > 0.75 ? '█' : v > 0.5 ? '▓' : v > 0.25 ? '▒' : v > 0 ? '░' : '·', tk.text, tk.bg, 0);
        else if (!k.uni) k.c.put(cx + j, y + d, v > 0.5 ? '#' : v > 0 ? '+' : '.', fadeIn(tk, color, a), tk.bg, 0);
        else k.c.put(cx + j, y + d, '▀', fadeIn(tk, color, a), tk.bg, 0);
      }
    }
  }
  const ticks = cellW >= 3 ? [0, 3, 6, 9, 12, 15, 18, 21] : [0, 6, 12, 18];
  for (const h of ticks) txt(k, x + labelW + h * cellW, y + 7, h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`, tk.text3);
  return labelW + 24 * cellW;
}

export function clockBody(k: K, data: Data<'clock'>, r: Rect): void {
  const { tk } = k;
  const cellW = r.w >= 4 + 72 + 32 ? 3 : 2;
  const gridW = 4 + 24 * cellW;
  const side = r.w - gridW - 6 >= 22;
  const y0 = r.y + Math.max(0, Math.min(Math.floor((r.h - 8 - (side ? 0 : 3)) / 3), r.h - 9));
  const peak: [number, number] | null = data.peakWeekday !== null && data.peakHour !== null ? [data.peakWeekday, data.peakHour] : null;
  drawHeatmap(k, data.grid, r.x, y0, cellW, peak);
  if (side) {
    const sx = r.x + gridW + 6;
    vrule(k, sx - 3, y0, Math.min(r.h - (y0 - r.y), data.callouts.length * (r.h >= 16 ? 4 : 3) - 1), fade(k, 900));
    data.callouts.forEach((call, i) => {
      const a = fade(k, 1000 + i * 140, 350);
      const cy = y0 + i * (r.h >= 16 ? 4 : 3);
      if (cy + 2 > r.y + r.h) return;
      label(k, sx, cy, call.label, a, r.x + r.w - sx);
      txt(k, sx, cy + 1, call.value, tk.text, { bold: true, a }, r.x + r.w - sx);
      if (textWidth(call.sub) <= r.x + r.w - sx) txt(k, sx, cy + 2, call.sub, tk.text2, { a });
    });
  } else if (y0 + 9 < r.y + r.h) {
    let x = r.x;
    const cy = y0 + 9;
    const a = fade(k, 1200, 400);
    for (const call of data.callouts.slice(0, 3)) {
      const text = `${call.label.toLowerCase()} `;
      if (x + textWidth(text) + textWidth(call.value) > r.x + r.w) break;
      x += txt(k, x, cy, text, tk.text2, { a });
      x += txt(k, x, cy, call.value, tk.text, { bold: true, a }) + 3;
    }
  }
}

/* ── mood: swearing by month, one line of eighth-block columns ── */

export function moodBody(k: K, data: Data<'mood'>, r: Rect): void {
  const { tk, L, s } = k;
  const months = data.months;
  const max = Math.max(1, ...months.map(m => m.pct));
  const axisW = 6;
  const plotW = Math.min(r.w - axisW - 2, months.length * (L ? 9 : 6));
  const plotH = Math.max(3, Math.min(r.h - 4, L ? 12 : 8));
  const x0 = r.x + axisW;
  const yTop = r.y + 2;
  const base = yTop + plotH; // baseline row
  const step = plotW / Math.max(1, months.length - 1);
  const draw = s.caps.motion ? seg(s.t, 100, 1100, easeOutCubic) : 1;
  if (draw < 1) k.busy = true;
  const valueAt = (x: number) => {
    const f = x / step;
    const i = Math.min(months.length - 2, Math.max(0, Math.floor(f)));
    const t = clamp01(f - i);
    const a = months[i]!.pct, b = months[Math.min(months.length - 1, i + 1)]!.pct;
    return a + (b - a) * (t * t * (3 - 2 * t));
  };
  txtRight(k, x0 - 2, yTop, `${Math.round(max)}%`, tk.text3);
  txtRight(k, x0 - 2, base - 1, '0%', tk.text3);
  rule(k, x0, base, plotW + 1);
  const tipX = Math.round(data.tip * step);
  for (let x = 0; x <= Math.round(plotW * draw); x++) {
    const v = valueAt(x) / max;
    vbar(k.c, x0 + x, base - 1, plotH, Math.max(0.02, v), x >= tipX ? tk.text3 : tk.bar, 1, !k.uni);
  }
  let lastEnd = -10;
  months.forEach((m, i) => {
    const x = x0 + Math.round(i * step);
    const lab = monthLabel(m.month);
    if (x - lastEnd < 2 || x + textWidth(lab) > r.x + r.w) return;
    txt(k, x - (i === months.length - 1 ? textWidth(lab) - 1 : 0), base + 1, lab, i === data.tip ? tk.text : tk.text3, { a: fade(k, 100 + (i / months.length) * 1100, 200) });
    lastEnd = x + textWidth(lab);
  });
  // The tip: a hairline up to its value, and the words, once the line has passed it.
  const ta = fade(k, 1250, 500);
  if (ta > 0) {
    const v = months[data.tip]!.pct;
    const vy = base - 1 - Math.ceil((v / max) * plotH);
    const mx = x0 + tipX;
    for (let y = yTop - 1; y < vy; y++) k.c.put(mx, y, k.uni ? '│' : '|', fadeIn(tk, tk.text3, ta), tk.bg, 0);
    const text = `it tipped in ${monthLabel(months[data.tip]!.month)}`;
    const lx = mx + 2 + textWidth(text) <= r.x + r.w ? mx + 2 : mx - 1 - textWidth(text);
    txt(k, lx, yTop - 1, text, tk.text, { bold: true, a: ta });
  }
  const ea = fade(k, 1200, 300);
  const first = months[0]!, last = months.at(-1)!;
  const fy = base - 2 - Math.ceil((first.pct / max) * plotH);
  if (fy > yTop) txt(k, x0, fy, `${first.pct.toFixed(1)}%`, tk.text2, { a: ea });
  const lastLabel = `${last.pct.toFixed(0)}%`;
  txt(k, x0 + plotW + 2, Math.max(yTop, base - 1 - Math.ceil((last.pct / max) * plotH)), lastLabel, tk.text, { bold: true, a: ea });
  if (s.caps.motion && s.t < 1900) k.busy = true;
}

/* ── fuse: where the first swear lands ── */

export function fuseBody(k: K, data: Data<'fuse'>, r: Rect): void {
  const { tk, L, s } = k;
  const n = Math.max(data.median + 4, Math.min(20, Math.max(10, data.hist.length)));
  const full = Math.min(r.w - 2, L ? 96 : 70);
  // Histogram columns are centred on their tick, so the axis starts half a column in.
  const colW0 = Math.max(1, Math.floor(full / n) - 1);
  const x0 = r.x + Math.floor(colW0 / 2);
  const len = full - Math.floor(colW0 / 2);
  const histH = data.hist.length && r.h >= 13 ? Math.min(L ? 7 : 4, r.h - 10) : 0;
  const axisY = r.y + histH + (histH ? 1 : 0);
  const posOf = (turn: number) => x0 + Math.round(((turn - 1) / (n - 1)) * (len - 1));
  const target = posOf(data.median);
  if (histH) {
    const max = Math.max(1, ...data.hist);
    const colW = Math.max(1, Math.floor(len / n) - 1);
    data.hist.slice(0, n).forEach((v, i) => {
      const x = posOf(i + 1) - Math.floor(colW / 2);
      const g = s.caps.motion ? seg(s.t, 200 + i * 30, 500, easeOutCubic) : 1;
      if (g < 1) k.busy = true;
      vbar(k.c, x, axisY - 1, histH, (v / max) * g, i + 1 === data.median ? tk.accent : tk.bar, colW, !k.uni);
    });
    const la = fade(k, 700, 300);
    txtRight(k, x0 + len, r.y, 'sessions by first swear', tk.text3, { a: la });
  }
  // The fuse: a hairline that burns (lights up) from prompt #1 to the median.
  const burn = s.caps.motion ? seg(s.t, 300, 1100, t => t * (2 - t)) : 1;
  if (burn < 1) k.busy = true;
  const lit = Math.round(x0 + (target - x0) * burn);
  for (let x = x0; x < x0 + len; x++) k.c.put(x, axisY, k.uni ? (x <= lit ? '━' : '─') : x <= lit ? '=' : '-', x <= lit ? tk.text2 : tk.rule, tk.bg, 0);
  if (burn >= 1) k.c.put(target, axisY, k.uni ? '┃' : '|', tk.text, tk.bg, 1);
  for (let turn = 1; turn <= n; turn++) {
    const x = posOf(turn);
    const show = turn === 1 || turn === data.median || turn === n || turn % (len / n >= 4 ? 1 : 5) === 0;
    if (!show) continue;
    txt(k, x - (turn >= 10 ? 1 : 0), axisY + 1, `#${turn}`, turn === data.median ? tk.text : tk.text3, { bold: turn === data.median });
  }
  // Readout.
  const by = axisY + 3;
  const a = fade(k, 1400, 400);
  const num = String(data.median);
  const opts = k.uni ? fitDisplay(num, 20, { face: tk.face, tall: L && r.h - (by - r.y) >= 7 }) : null;
  if (by + (opts ? displayHeight(opts) : 1) > r.y + r.h) return;
  txt(k, x0, by, 'Your first swear lands at prompt', tk.text3, { a });
  let nx = x0;
  if (opts) { drawDisplay(k.c, x0, by + 1, num, fadeIn(tk, tk.text, a), tk.bg, opts); nx = x0 + displayWidth(num, opts) + 4; }
  else { txt(k, x0, by + 1, `#${num}`, tk.text, { bold: true, a }); nx = x0 + num.length + 5; }
  const lines: [string, string][] = [[`${data.sessions} of ${data.of}`, ' sessions had a snap'], [`${data.firstPrompt}`, ' times you came in swinging on prompt #1']];
  lines.forEach(([strong, rest], i) => {
    const la = fade(k, 1600 + i * 150, 300);
    const ly = by + 1 + i * 2;
    if (nx + textWidth(strong + rest) > r.x + r.w || ly >= r.y + r.h) return;
    const w = txt(k, nx, ly, strong, tk.text, { bold: true, a: la });
    txt(k, nx + w, ly, rest, tk.text2, { a: la });
  });
  if (s.caps.motion && s.t < 2300) k.busy = true;
}
