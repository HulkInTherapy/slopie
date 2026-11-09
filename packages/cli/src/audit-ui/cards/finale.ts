/** A generic chart card for the other detectors: columns, a line, a ranked list, stacks, a slope. */
import { count, money } from '../format.js';
import { mix } from '../gfx/color.js';
import { pxLine, textWidth, vbar, type Rect } from '../gfx/draw.js';
import { easeOutCubic, seg, spring } from '../gfx/motion.js';
import type { DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, rule, txt, txtRight, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short axis label: '2026-05-01' → 'May 1', '2026-05' → 'May', 13 → '1p'. */
export function axisLabel(x: string | number): string {
  if (typeof x === 'number') return x >= 0 && x <= 23 && Number.isInteger(x) ? (x === 0 ? '12a' : x === 12 ? '12p' : x < 12 ? `${x}a` : `${x - 12}p`) : String(x);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  if (day) return `${MONTHS[Number(day[2]) - 1]} ${Number(day[3])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(x);
  if (month) return MONTHS[Number(month[2]) - 1]!;
  const week = /^(\d{4})-W(\d{2})$/.exec(x);
  if (week) return `w${Number(week[2])}`;
  return x;
}

function valueLabel(y: number, unit?: string): string {
  const v = Math.abs(y) >= 100 ? count(Math.round(y)) : Number.isInteger(y) ? String(y) : y.toFixed(1);
  if (unit === 'pct') return `${v}%`;
  if (unit === 'usd') return money(y);
  if (unit === 'hours') return `${v}h`;
  return v;
}

type Point = { x: string | number; y: number; label?: string };

const isHi = (p: Point, highlight: string | number | null | undefined) => highlight !== undefined && highlight !== null && String(p.x) === String(highlight);

/** Vertical bars on a hairline baseline, or a dense strip when there are more points than room. */
function columns(k: K, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): void {
  const { tk, L, s } = k;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const h = Math.max(3, Math.min(r.h - 3, L ? 13 : 9));
  const base = r.y + 1 + h; // baseline row
  const dense = points.length * 3 > r.w;
  if (dense) {
    const width = Math.min(r.w, points.length >= r.w ? r.w : points.length * 2);
    const per = points.length / width;
    rule(k, r.x, base, width);
    for (let col = 0; col < width; col++) {
      const slice = points.slice(Math.floor(col * per), Math.max(Math.floor(col * per) + 1, Math.floor((col + 1) * per)));
      const v = Math.max(...slice.map(p => p.y));
      const g = s.caps.motion ? seg(s.t, 100 + col * 12, 300, easeOutCubic) : 1;
      if (g < 1) k.busy = true;
      if (v > 0) vbar(k.c, r.x + col, base - 1, h, Math.max(0.06, v / max) * g, slice.some(p => isHi(p, highlight)) ? tk.accent : tk.accentLo, 1, !k.uni);
    }
    txt(k, r.x, base + 1, axisLabel(points[0]!.x), tk.text3);
    txtRight(k, r.x + width, base + 1, axisLabel(points.at(-1)!.x), tk.text3);
    const peak = points.reduce((best, p) => (p.y > best.y ? p : best), points[0]!);
    const px = r.x + Math.floor(points.indexOf(peak) / per);
    const lab = `${valueLabel(peak.y, unit)} · ${axisLabel(peak.x)}`;
    txt(k, Math.min(px, r.x + r.w - textWidth(lab)), Math.max(r.y, base - h - 1), lab, tk.text, { bold: true, a: fade(k, 600, 300) });
    return;
  }
  const colW = Math.max(3, Math.min(9, Math.floor(r.w / points.length)));
  const barW = Math.max(1, colW - (colW >= 5 ? 2 : 1));
  const maxIndex = points.findIndex(p => p.y === max);
  rule(k, r.x, base, points.length * colW - (colW - barW));
  points.forEach((p, i) => {
    const hi = highlight !== undefined && highlight !== null ? isHi(p, highlight) : i === maxIndex;
    const g = s.caps.motion ? Math.max(0, Math.min(1, spring((s.t - i * 50) / 1000, 2, 0.8))) : 1;
    if (s.caps.motion && s.t < i * 50 + 900) k.busy = true;
    const x = r.x + i * colW;
    vbar(k.c, x, base - 1, h, (p.y / max) * g, hi ? tk.accent : tk.accentLo, barW, !k.uni);
    const lab = axisLabel(p.x);
    if (colW >= 4 || i % 2 === 0) txt(k, x, base + 1, lab, hi ? tk.accentHi : tk.text3, { bold: hi }, colW);
    const text = valueLabel(p.y, unit);
    const vy = base - 2 - Math.ceil((p.y / max) * (h - 1));
    if (textWidth(text) <= colW) txt(k, x, Math.max(r.y, vy), text, hi ? tk.text : tk.text2, { bold: hi, a: fade(k, 500 + i * 50, 250) });
  });
}

/** A monthly line as eighth-block columns (the same style as the mood card). */
function line(k: K, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): void {
  const { tk, L, s } = k;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const plotH = Math.max(4, Math.min(r.h - 3, L ? 12 : 8));
  const x0 = r.x + 7;
  const plotW = Math.min(r.w - 9, points.length * (L ? 9 : 6));
  const base = r.y + 1 + plotH;
  const step = plotW / Math.max(1, points.length - 1);
  const draw = s.caps.motion ? seg(s.t, 100, 1000, easeOutCubic) : 1;
  if (draw < 1) k.busy = true;
  const at = (x: number) => {
    const f = x / step;
    const i = Math.min(points.length - 2, Math.max(0, Math.floor(f)));
    const t = Math.max(0, Math.min(1, f - i));
    const a = points[i]!.y, b = points[Math.min(points.length - 1, i + 1)]!.y;
    return a + (b - a) * (t * t * (3 - 2 * t));
  };
  rule(k, x0, base, plotW + 1);
  for (let x = 0; x <= Math.round(plotW * draw); x++) vbar(k.c, x0 + x, base - 1, plotH, Math.max(0.02, at(x) / max), mix(tk.accentLo, tk.accent, x / Math.max(1, plotW)), 1, !k.uni);
  txtRight(k, x0 - 2, r.y + 1, valueLabel(max, unit), tk.text3);
  txtRight(k, x0 - 2, base - 1, unit === 'pct' ? '0%' : '0', tk.text3);
  let lastEnd = -10;
  points.forEach((p, i) => {
    const x = x0 + Math.round(i * step);
    const lab = axisLabel(p.x);
    if (x - lastEnd < 2 || x + textWidth(lab) > r.x + r.w) return;
    txt(k, x, base + 1, lab, isHi(p, highlight) ? tk.accentHi : tk.text3, { bold: isHi(p, highlight) });
    lastEnd = x + textWidth(lab);
  });
  const last = points.at(-1)!;
  txt(k, x0 + plotW + 2, Math.max(r.y, base - 1 - Math.ceil((last.y / max) * plotH)), valueLabel(last.y, unit), tk.text, { bold: true, a: fade(k, 1000, 300) });
}

/** Ranked list with meters (phrases, typos, projects, first words). */
function list(k: K, points: readonly Point[], r: Rect, unit?: string): void {
  const { tk, s } = k;
  const rows = points.slice(0, Math.min(8, Math.max(1, Math.floor(r.h / (r.h >= 12 ? 2 : 1)))));
  const step = rows.length * 2 <= r.h ? 2 : 1;
  const max = Math.max(1e-9, ...rows.map(p => p.y));
  const nameW = Math.min(26, Math.max(...rows.map(p => textWidth(String(p.x)))) + 2);
  const barW = Math.max(6, Math.min(48, r.w - nameW - 30));
  rows.forEach((p, i) => {
    const y = r.y + i * step;
    const a = fade(k, i * 80, 300);
    txt(k, r.x, y, String(p.x), i === 0 ? tk.text : tk.text2, { bold: i === 0, a }, nameW - 2);
    meter(k, r.x + nameW, y, barW, p.y / max, i === 0 ? tk.accent : tk.accentLo, i * 80);
    const vx = r.x + nameW + barW + 2;
    const vw = txt(k, vx, y, valueLabel(p.y, unit), tk.text, { a });
    if (p.label && vx + vw + 3 + textWidth(p.label) <= r.x + r.w) txt(k, vx + vw + 3, y, p.label, tk.text3, { a });
  });
  if (s.caps.motion && s.t < rows.length * 80 + 600) k.busy = true;
}

/** Weekly stacked columns: one grey per agent, darkest at the bottom. */
function stacked(k: K, series: readonly { name: string; points: readonly Point[] }[], r: Rect, highlight: string | number | null | undefined): void {
  const { tk, L, s } = k;
  const n = series[0]?.points.length ?? 0;
  const colW = Math.max(1, Math.min(3, Math.floor(r.w / Math.max(1, n))));
  const h = Math.max(3, Math.min(r.h - 4, L ? 12 : 8));
  const bottom = r.y + h;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((sum, sr) => sum + (sr.points[i]?.y ?? 0), 0));
  const max = Math.max(1, ...totals);
  const inks = [tk.accentLo, tk.accentMid, tk.accent, tk.accentHi];
  for (let i = 0; i < n; i++) {
    const g = s.caps.motion ? seg(s.t, i * 15, 300) : 1;
    if (g < 1) k.busy = true;
    let acc = 0;
    series.forEach((sr, si) => {
      const v = sr.points[i]?.y ?? 0;
      const from = Math.round((acc / max) * h * 2 * g), to = Math.round(((acc + v) / max) * h * 2 * g);
      for (let py = from; py < to; py++) for (let j = 0; j < Math.max(1, colW - (colW > 1 ? 1 : 0)); j++) k.c.px(r.x + i * colW + j, bottom * 2 + 1 - py, inks[si % inks.length]!);
      acc += v;
    });
    const p0 = series[0]!.points[i];
    if (p0 && isHi(p0, highlight)) {
      k.c.put(r.x + i * colW, r.y, k.uni ? '│' : '|', tk.accent, tk.bg, 0);
      txt(k, r.x + i * colW + 2, r.y, axisLabel(p0.x), tk.text, { bold: true });
    }
  }
  let lx = r.x;
  series.forEach((sr, si) => {
    lx += txt(k, lx, bottom + 2, k.uni ? '■ ' : '# ', inks[si % inks.length]!);
    lx += txt(k, lx, bottom + 2, sr.name, tk.text2) + 3;
  });
}

export function insightBody(k: K, data: Data<'insight'>, r: Rect): void {
  const { tk, L, s } = k;
  const chart = data.chart;
  const points = chart.series[0]?.points ?? [];
  if (chart.type === 'slope' && chart.series.length >= 1) {
    const ser = chart.series.slice(0, 2);
    const max = Math.max(1, ...ser.flatMap(sr => sr.points.map(p => p.y)));
    const x0 = r.x + 20, x1 = Math.min(r.x + r.w - 20, x0 + 56);
    const top = r.y + 1, bottom = r.y + Math.min(r.h - 2, L ? 12 : 8);
    const g = s.caps.motion ? seg(s.t, 200, 900, easeOutCubic) : 1;
    if (g < 1) k.busy = true;
    ser.forEach((sr, i) => {
      const ink = i === 0 ? tk.accent : tk.accentLo;
      const [a, b] = [sr.points[0]?.y ?? 0, sr.points[1]?.y ?? 0];
      const ya = bottom * 2 - Math.round((a / max) * (bottom - top) * 2), yb = bottom * 2 - Math.round((b / max) * (bottom - top) * 2);
      pxLine(k.c, x0, ya, x0 + Math.round((x1 - x0) * g), Math.round(ya + (yb - ya) * g), ink);
      const name = sr.name.replace(/\s*%$/, '');
      txtRight(k, x0 - 2, Math.floor(ya / 2), `${name} ${valueLabel(a, chart.unit)}`, i === 0 ? tk.text : tk.text2);
      if (g >= 1) txt(k, x1 + 2, Math.floor(yb / 2), `${valueLabel(b, chart.unit)} ${name}`, i === 0 ? tk.text : tk.text2, { bold: i === 0 });
    });
    const labels = ser[0]!.points.map(p => String(p.x));
    txt(k, x0 - 2, bottom + 1, labels[0] ?? '', tk.text3);
    txtRight(k, x1 + 2, bottom + 1, labels[1] ?? '', tk.text3);
    return;
  }
  if (chart.type === 'big_number' && points[0]) {
    const a = fade(k, 0, 400);
    // The display face sets numerals; a unit letter (12h) stays in the label.
    const text = valueLabel(points[0].y, chart.unit).replace(/h$/, '');
    const opts = k.uni ? fitDisplay(text, r.w, { face: tk.face, tall: L }) : null;
    if (opts) drawDisplay(k.c, r.x, r.y + 1, text, fadeIn(tk, tk.text, a), tk.bg, opts);
    else txt(k, r.x, r.y + 1, text, tk.text, { bold: true, a });
    txt(k, r.x, r.y + 2 + (opts ? displayHeight(opts) : 1), chart.unit === 'hours' ? `hours · ${chart.series[0]!.name}` : chart.series[0]!.name, tk.text2, { a });
    return;
  }
  if (chart.type === 'stacked_area' && chart.series.length > 1) return stacked(k, chart.series, r, chart.highlight);
  if (!points.length) return;
  if (['hbar', 'words', 'autocomplete', 'keyboard', 'tally', 'bubbles', 'grid'].includes(chart.type)) return list(k, points, r, chart.unit);
  if (chart.type === 'line' && points.length >= 3 && typeof points[0]!.x === 'string' && /^\d{4}-\d{2}$/.test(points[0]!.x)) return line(k, points, r, chart.highlight, chart.unit);
  columns(k, points, r, chart.highlight, chart.unit);
}
