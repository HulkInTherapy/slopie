/** Your clock (weekday × hour grid), the mood line, and the fuse. */
import { heat, mix } from '../gfx/color.js';
import { textWidth, vbar, type Rect } from '../gfx/draw.js';
import { clamp01, easeOutCubic, seg } from '../gfx/motion.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import { count } from '../format.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { facts, fade, heroScale, label, rule, strokeNum, txt, txtRight, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The 7×24 grid on the indigo ramp (the busiest hour in accentHi). `rowStep` 2 leaves a blank row between days. Returns the drawn width. */
export function drawHeatmap(k: K, grid: number[][], x: number, y: number, cellW: number, peak: [number, number] | null, start = 0, rowStep = 1): number {
  const { tk, s } = k;
  const max = Math.max(1, ...grid.flat());
  const labelW = 5;
  const none = s.caps.color === 'none';
  for (let d = 0; d < 7; d++) {
    const yy = y + d * rowStep;
    txt(k, x, yy, DAYS[d]!, d >= 5 ? tk.text3 : tk.text2);
    for (let h = 0; h < 24; h++) {
      const a = s.caps.motion ? seg(s.t, start + 120 + h * 30, 260) : 1;
      if (a < 1) k.busy = true;
      const raw = grid[d]?.[h] ?? 0;
      const v = Math.sqrt(raw / max);
      const isPeak = !!peak && peak[0] === d && peak[1] === h;
      const color = raw <= 0 ? mix(tk.bg, tk.text, 0.06) : isPeak ? tk.accentHi : heat(0.1 + v * 0.7);
      const cx = x + labelW + h * cellW;
      for (let j = 0; j < Math.max(1, cellW - 1); j++) {
        if (none) k.c.put(cx + j, yy, v > 0.75 ? '█' : v > 0.5 ? '▓' : v > 0.25 ? '▒' : v > 0 ? '░' : '·', tk.text, tk.bg, 0);
        else if (!k.uni) k.c.put(cx + j, yy, v > 0.5 ? '#' : v > 0 ? '+' : '.', fadeIn(tk, color, a), tk.bg, 0);
        else k.c.put(cx + j, yy, rowStep > 1 ? '█' : '▀', fadeIn(tk, color, a), tk.bg, 0);
      }
    }
  }
  const ticks = cellW >= 3 ? [0, 3, 6, 9, 12, 15, 18, 21] : [0, 6, 12, 18];
  const ty = y + 6 * rowStep + 2;
  for (const h of ticks) txt(k, x + labelW + h * cellW, ty, h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`, tk.text3);
  return labelW + 24 * cellW;
}

export function clockBody(k: K, data: Data<'clock'>, r: Rect): void {
  const { tk } = k;
  // The heatmap is the hero: full content width, a blank row between days when there is room.
  const cellW = Math.max(2, Math.min(6, Math.floor((r.w - 5) / 24)));
  const tiles = data.callouts.slice(0, 4);
  const tileH = r.h >= 22 ? 6 : r.h >= 16 ? 3 : 0;
  const rowStep = r.h - tileH - 3 >= 15 ? 2 : 1;
  const mapH = 6 * rowStep + 3;
  const free = r.h - mapH - (tileH ? tileH + 2 : 0);
  const y0 = r.y + Math.max(0, Math.floor(free / 3));
  const peak: [number, number] | null = data.peakWeekday !== null && data.peakHour !== null ? [data.peakWeekday, data.peakHour] : null;
  drawHeatmap(k, data.grid, r.x, y0, cellW, peak, 0, rowStep);
  if (!tileH || !tiles.length) return;
  const ty = Math.min(r.y + r.h - tileH, y0 + mapH + 2 + Math.floor(free / 3));
  rule(k, r.x, ty - 2 + (tileH < 6 ? 1 : 0), r.w, tk.rule, fade(k, 900));
  const colW = Math.floor(r.w / tiles.length);
  tiles.forEach((call, i) => {
    const a = fade(k, 1000 + i * 140, 350);
    const x = r.x + i * colW;
    const hot = /ANGR/i.test(call.label);
    label(k, x, ty, call.label, a, colW - 3);
    const big = tileH >= 6 ? strokeNum(k, x, ty + 1, call.value, hot ? tk.accentHi : tk.text, a, colW - 3) : { w: txt(k, x, ty + 1, call.value, hot ? tk.accentHi : tk.text, { bold: true, a }, colW - 3), h: 1 };
    if (textWidth(call.sub) <= colW - 3 && ty + 1 + big.h < r.y + r.h) txt(k, x, ty + 1 + big.h, call.sub, tk.text2, { a });
  });
}

/* ── mood: swearing by month, one line of eighth-block columns ── */

export function moodBody(k: K, data: Data<'mood'>, r: Rect): void {
  const { tk, L, s } = k;
  const months = data.months;
  const max = Math.max(1, ...months.map(m => m.pct));
  const axisW = 6;
  const factRows = data.facts.length && r.h >= 14 ? 3 : 0;
  const plotW = r.w - axisW - 6;
  const plotH = Math.max(3, Math.min(r.h - 5 - factRows, L ? 18 : 10));
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
    const after = plotW - tipX > 0 ? (x - tipX) / (plotW - tipX) : 1;
    vbar(k.c, x0 + x, base - 1, plotH, Math.max(0.02, v), x >= tipX ? mix(tk.accentLo, tk.accent, after) : tk.barSoft, 1, !k.uni);
  }
  let lastEnd = -10;
  months.forEach((m, i) => {
    const x = x0 + Math.round(i * step);
    const lab = monthLabel(m.month);
    if (x - lastEnd < 2 || x + textWidth(lab) > r.x + r.w) return;
    txt(k, x - (i === months.length - 1 ? textWidth(lab) - 1 : 0), base + 1, lab, i === data.tip ? tk.accentHi : tk.text3, { bold: i === data.tip, a: fade(k, 100 + (i / months.length) * 1100, 200) });
    lastEnd = x + textWidth(lab);
  });
  // The tip: a hairline up to its value, and the words, once the line has passed it.
  const ta = fade(k, 1250, 500);
  if (ta > 0) {
    const v = months[data.tip]!.pct;
    const vy = base - 1 - Math.ceil((v / max) * plotH);
    const mx = x0 + tipX;
    for (let y = yTop - 1; y < vy; y++) k.c.put(mx, y, k.uni ? '│' : '|', fadeIn(tk, tk.accentHi, ta), tk.bg, 0);
    const text = `tipped in ${monthLabel(months[data.tip]!.month)}`;
    const lx = mx + 2 + textWidth(text) <= r.x + r.w ? mx + 2 : mx - 1 - textWidth(text);
    txt(k, lx, yTop - 1, text, tk.text, { bold: true, a: ta });
  }
  const ea = fade(k, 1200, 300);
  const first = months[0]!, last = months.at(-1)!;
  const fy = base - 2 - Math.ceil((first.pct / max) * plotH);
  if (fy > yTop) txt(k, x0, fy, `${first.pct.toFixed(1)}%`, tk.text, { bold: true, a: ea });
  const lastLabel = `${last.pct.toFixed(0)}%`;
  txt(k, x0 + plotW + 2, Math.max(yTop, base - 1 - Math.ceil((last.pct / max) * plotH)), lastLabel, tk.accentHi, { bold: true, a: ea });
  if (factRows) {
    const fy2 = r.y + r.h - 2;
    rule(k, r.x, fy2 - 1, r.w, tk.rule, fade(k, 1300));
    facts(k, r.x, fy2, r.w, data.facts, fade(k, 1300));
  }
  if (s.caps.motion && s.t < 1900) k.busy = true;
}

/* ── fuse: where the first swear lands ── */

export function fuseBody(k: K, data: Data<'fuse'>, r: Rect): void {
  const { tk, L, s } = k;
  const factRows = r.h >= 14 ? 3 : 0;
  // Hero at the left: the median prompt number in the display face, "prompts" in the accent.
  const num = String(data.median);
  const a0 = fade(k, 100, 400);
  const opts = k.uni ? fitDisplay(num, 24, { face: tk.face, tall: L, scale: heroScale(k) }) : null;
  const heroW = Math.max(opts ? displayWidth(num, opts) : textWidth(num), 12) + 6;
  const plotH = Math.max(3, Math.min(r.h - factRows - 3, L ? 16 : 9));
  const y0 = r.y + Math.max(0, Math.floor((r.h - factRows - plotH - 2) / 2));
  label(k, r.x, y0, 'your fuse', a0, heroW - 2);
  if (opts) drawDisplay(k.c, r.x, y0 + 2, num, fadeIn(tk, tk.text, a0), tk.bg, opts);
  else txt(k, r.x, y0 + 2, `#${num}`, tk.text, { bold: true, a: a0 });
  txt(k, r.x, y0 + 3 + (opts ? displayHeight(opts) : 1), 'prompts', tk.accentHi, { bold: true, a: a0 });

  // Histogram of sessions by the prompt of their first swear.
  const n = Math.max(data.median + 4, Math.min(20, Math.max(10, data.hist.length)));
  const gx = r.x + heroW;
  const gw = r.x + r.w - gx;
  const colW = Math.max(2, Math.floor(gw / n));
  const barW = Math.max(1, colW - (colW >= 4 ? 2 : 1));
  const base = y0 + plotH;
  const max = Math.max(1, ...data.hist);
  rule(k, gx, base, n * colW - (colW - barW));
  for (let i = 0; i < n; i++) {
    const v = data.hist[i] ?? 0;
    const x = gx + i * colW;
    const g = s.caps.motion ? seg(s.t, 200 + i * 30, 500, easeOutCubic) : 1;
    if (g < 1) k.busy = true;
    const hot = i + 1 === data.median;
    if (v > 0) vbar(k.c, x, base - 1, plotH - 1, (v / max) * g, hot ? tk.accent : tk.accentLo, barW, !k.uni);
    const turn = i + 1;
    if (hot || turn === 1 || turn === n || colW >= 4 || turn % 5 === 0) txt(k, x, base + 1, `#${turn}`, hot ? tk.accentHi : tk.text3, { bold: hot }, colW >= 4 ? colW : 4);
  }
  if (factRows) {
    const fy = r.y + r.h - 2;
    const fa = fade(k, 1300, 400);
    rule(k, r.x, fy - 1, r.w, tk.rule, fa);
    facts(k, r.x, fy, r.w, [
      { label: 'sessions with a snap', value: `${count(data.sessions)} of ${count(data.of)}` },
      { label: 'came in swinging', value: `${count(data.firstPrompt)}×`, hot: true },
      { label: 'come back after', value: data.backMin !== null ? `${data.backMin} min` : '' },
    ], fa);
  }
  if (s.caps.motion && s.t < 1700) k.busy = true;
}
