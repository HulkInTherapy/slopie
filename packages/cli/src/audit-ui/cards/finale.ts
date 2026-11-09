/** Archetype reveal, the share board, and a generic chart card for other detectors. */
import { C, fade, mix } from '../gfx/color.js';
import { box, hbar, spaced, textCenter, textRight, textWidth, vbar, wrapText, type Rect } from '../gfx/draw.js';
import { bigHeight, bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { easeOutBack, easeOutCubic, seg, spring } from '../gfx/motion.js';
import { count, money } from '../format.js';
import type { DeckCard } from '../story/deck.js';
import { drawHeatmap } from './time.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

/* ── generic insight chart ── */

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

/** Vertical bars, or a dense sparkline when there are more points than room. */
function columns(s: Scene, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): boolean {
  const { c, t } = s;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const h = Math.max(3, Math.min(r.h - 3, s.tier.id === 'L' ? 14 : 9));
  const top = r.y + 1;
  const bottom = top + h - 1;
  const dense = points.length * 3 > r.w;
  let busy = false;
  if (dense) {
    const width = Math.min(r.w, points.length >= r.w ? r.w : points.length * 2);
    const per = points.length / width;
    for (let col = 0; col < width; col++) {
      const slice = points.slice(Math.floor(col * per), Math.max(Math.floor(col * per) + 1, Math.floor((col + 1) * per)));
      const v = Math.max(...slice.map(p => p.y));
      const hi = slice.some(p => highlight !== undefined && highlight !== null && String(p.x) === String(highlight));
      const k = seg(t, 100 + col * 12, 300, easeOutCubic);
      busy ||= k < 1;
      if (v <= 0) { c.put(r.x + col, bottom, s.caps.unicode ? '▁' : '_', C.coal); continue; }
      vbar(c, r.x + col, bottom, h, Math.max(0.06, v / max) * k, hi ? C.orange : v === max ? C.peach : fade(C.orange, 0.5), 1, !s.caps.unicode);
    }
    c.text(r.x, bottom + 1, axisLabel(points[0]!.x), { fg: C.slate });
    const last = axisLabel(points.at(-1)!.x);
    textRight(c, r.x + width, bottom + 1, last, { fg: C.slate });
    const peak = points.reduce((best, p) => (p.y > best.y ? p : best), points[0]!);
    const pi = points.indexOf(peak);
    const px = r.x + Math.floor(pi / per);
    const la = seg(t, 600, 300);
    const label = `${valueLabel(peak.y, unit)} · ${axisLabel(peak.x)}`;
    c.text(Math.min(px, r.x + r.w - textWidth(label)), Math.max(r.y, top - 1), label, { fg: C.cream, bold: true, alpha: la });
    return busy || la < 1;
  }
  const colW = Math.max(3, Math.min(9, Math.floor(r.w / points.length)));
  const barW = Math.max(1, colW - (colW >= 5 ? 2 : 1));
  const maxIndex = points.findIndex(p => p.y === max);
  points.forEach((p, i) => {
    const hi = highlight !== undefined && highlight !== null ? String(p.x) === String(highlight) : i === maxIndex;
    const k = s.caps.motion ? Math.min(1, spring((t - i * 50) / 1000, 2, 0.7)) : 1;
    busy ||= t < i * 50 + 900;
    const x = r.x + i * colW;
    vbar(c, x, bottom, h - 1, (p.y / max) * Math.max(0, k), hi ? C.orange : fade(C.orange, 0.45), barW, !s.caps.unicode);
    const label = axisLabel(p.x);
    if (colW >= 4 || i % 2 === 0) c.text(x, bottom + 1, label.slice(0, colW), { fg: hi ? C.orange : C.slate, bold: hi });
    const va = seg(t, 500 + i * 50, 250);
    const vy = bottom - Math.ceil((p.y / max) * (h - 1)) - 1;
    const text = valueLabel(p.y, unit);
    if (textWidth(text) <= colW) c.text(x, Math.max(r.y, vy), text, { fg: hi ? C.cream : C.gray, bold: hi, alpha: va });
  });
  return busy;
}

/** Monthly line as a soft area (same style as the mood card). */
function area(s: Scene, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): boolean {
  const { c, t } = s;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const plotH = Math.max(4, Math.min(r.h - 3, s.tier.id === 'L' ? 12 : 8));
  const x0 = r.x + 6;
  const plotW = Math.min(r.w - 8, points.length * (s.tier.id === 'L' ? 9 : 6));
  const yTop = r.y + 1;
  const pxH = plotH * 2;
  const step = plotW / Math.max(1, points.length - 1);
  const draw = s.caps.motion ? seg(t, 100, 1000, easeOutCubic) : 1;
  const at = (x: number) => {
    const f = x / step;
    const i = Math.min(points.length - 2, Math.max(0, Math.floor(f)));
    const k = Math.max(0, Math.min(1, f - i));
    const a = points[i]!.y, b = points[Math.min(points.length - 1, i + 1)]!.y;
    return a + (b - a) * (k * k * (3 - 2 * k));
  };
  for (let x = 0; x <= Math.round(plotW * draw); x++) {
    const top = Math.round(pxH - (at(x) / max) * (pxH - 1)) - 1;
    for (let py = Math.max(0, top); py < pxH; py++) {
      const depth = (py - top) / Math.max(1, pxH - top);
      c.px(x0 + x, yTop * 2 + py, py === top ? C.orange : mix(mix(C.ember, C.ink, 0.35), C.ink, Math.min(0.92, depth * 1.1)));
    }
  }
  textRight(c, x0 - 1, yTop, valueLabel(max, unit), { fg: C.slate });
  textRight(c, x0 - 1, yTop + plotH - 1, unit === 'pct' ? '0%' : '0', { fg: C.slate });
  let lastEnd = -10;
  points.forEach((p, i) => {
    const x = x0 + Math.round(i * step);
    const label = axisLabel(p.x);
    if (x - lastEnd < 2 || x + textWidth(label) > r.x + r.w) return;
    const hi = highlight !== undefined && highlight !== null && String(p.x) === String(highlight);
    c.text(x, yTop + plotH, label, { fg: hi ? C.orange : C.slate });
    lastEnd = x + textWidth(label);
  });
  const ea = seg(t, 1000, 300);
  const first = points[0]!, last = points.at(-1)!;
  c.text(x0 + 1, Math.max(r.y, yTop + Math.floor((pxH - (first.y / max) * (pxH - 1)) / 2) - 1), valueLabel(first.y, unit), { fg: C.gray, alpha: ea });
  const lastText = valueLabel(last.y, unit);
  c.text(x0 + plotW - textWidth(lastText), Math.max(r.y, yTop + Math.floor((pxH - (last.y / max) * (pxH - 1)) / 2) - 2), lastText, { fg: C.orange, bold: true, alpha: ea });
  return t < 1400;
}

/** Ranked horizontal list (phrases, typos, projects, first words). */
function list(s: Scene, points: readonly Point[], r: Rect, unit?: string): boolean {
  const { c, t } = s;
  const rows = points.slice(0, Math.min(8, Math.max(1, Math.floor(r.h / (r.h >= 12 ? 2 : 1)))));
  const step = rows.length * 2 <= r.h ? 2 : 1;
  const max = Math.max(1e-9, ...rows.map(p => p.y));
  const nameW = Math.min(26, Math.max(...rows.map(p => textWidth(String(p.x)))) + 2);
  const barW = Math.max(6, Math.min(50, r.w - nameW - 30));
  rows.forEach((p, i) => {
    const y = r.y + i * step;
    const k = seg(t, i * 80, 600, easeOutCubic);
    c.text(r.x, y, String(p.x), { fg: i === 0 ? C.cream : C.gray, bold: i === 0 }, nameW - 1);
    hbar(c, r.x + nameW, y, barW, (p.y / max) * k, i === 0 ? C.orange : fade(C.orange, 0.5), !s.caps.unicode);
    const value = valueLabel(p.y, unit);
    const vw = c.text(r.x + nameW + barW + 2, y, value, { fg: C.cream, alpha: k });
    if (p.label) c.text(r.x + nameW + barW + 3 + vw, y, `· ${p.label}`, { fg: C.slate, alpha: k }, r.x + r.w - (r.x + nameW + barW + 3 + vw));
  });
  return t < rows.length * 80 + 600;
}

/** Weekly stacked columns (one colour per agent). */
function stacked(s: Scene, series: readonly { name: string; points: readonly Point[] }[], r: Rect, highlight: string | number | null | undefined): boolean {
  const { c, t } = s;
  const n = series[0]?.points.length ?? 0;
  const colW = Math.max(1, Math.min(3, Math.floor(r.w / Math.max(1, n))));
  const h = Math.max(3, Math.min(r.h - 4, s.tier.id === 'L' ? 12 : 8));
  const bottom = r.y + h;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((sum, sr) => sum + (sr.points[i]?.y ?? 0), 0));
  const max = Math.max(1, ...totals);
  const palette = [C.slate, C.orange, C.peach, C.cream];
  for (let i = 0; i < n; i++) {
    const k = seg(t, i * 15, 300);
    let acc = 0;
    series.forEach((sr, si) => {
      const v = sr.points[i]?.y ?? 0;
      const from = Math.round((acc / max) * h * 2 * k), to = Math.round(((acc + v) / max) * h * 2 * k);
      for (let py = from; py < to; py++) for (let k2 = 0; k2 < Math.max(1, colW - (colW > 1 ? 1 : 0)); k2++) c.px(r.x + i * colW + k2, bottom * 2 + 1 - py, palette[si % palette.length]!);
      acc += v;
    });
    if (highlight !== undefined && highlight !== null && String(series[0]!.points[i]?.x) === String(highlight)) {
      c.put(r.x + i * colW, r.y, s.caps.unicode ? '▼' : 'v', C.cream);
      c.text(r.x + i * colW + 2, r.y, axisLabel(series[0]!.points[i]!.x), { fg: C.cream, bold: true });
    }
  }
  let lx = r.x;
  series.forEach((sr, si) => {
    lx += c.text(lx, bottom + 2, s.caps.unicode ? '■ ' : '# ', { fg: palette[si % palette.length]! });
    lx += c.text(lx, bottom + 2, sr.name, { fg: C.gray }) + 3;
  });
  return t < n * 15 + 300;
}

export function insightBody(s: Scene, data: Data<'insight'>, r: Rect): boolean {
  const { c, t } = s;
  const chart = data.chart;
  const points = chart.series[0]?.points ?? [];
  if (chart.type === 'slope' && chart.series.length >= 1) {
    const ser = chart.series.slice(0, 2);
    const max = Math.max(1, ...ser.flatMap(sr => sr.points.map(p => p.y)));
    const x0 = r.x + 18, x1 = Math.min(r.x + r.w - 18, x0 + 56);
    const top = r.y + 1, bottom = r.y + Math.min(r.h - 2, s.tier.id === 'L' ? 12 : 8);
    const k = seg(t, 200, 900, easeOutCubic);
    ser.forEach((sr, i) => {
      const color = i === 0 ? C.peach : C.ember;
      const [a, b] = [sr.points[0]?.y ?? 0, sr.points[1]?.y ?? 0];
      const ya = bottom * 2 - Math.round((a / max) * (bottom - top) * 2), yb = bottom * 2 - Math.round((b / max) * (bottom - top) * 2);
      const steps = Math.round((x1 - x0) * k);
      for (let sx = 0; sx <= steps; sx++) c.px(x0 + sx, Math.round(ya + (yb - ya) * (sx / (x1 - x0))), color);
      const name = sr.name.replace(/\s*%$/, '');
      textRight(c, x0 - 2, Math.floor(ya / 2), `${name} ${valueLabel(a, chart.unit)}`, { fg: color });
      if (k >= 1) c.text(x1 + 2, Math.floor(yb / 2), `${valueLabel(b, chart.unit)} ${name}`, { fg: color, bold: true });
    });
    const labels = ser[0]!.points.map(p => String(p.x));
    c.text(x0 - 2, bottom + 1, labels[0] ?? '', { fg: C.slate });
    textRight(c, x1 + 2, bottom + 1, labels[1] ?? '', { fg: C.slate });
    return k < 1;
  }
  if (chart.type === 'big_number' && points[0]) {
    const a = seg(t, 0, 400);
    const text = valueLabel(points[0].y, chart.unit);
    const glyphs = text.replace(/[^0-9.,%$h×]/g, '');
    drawBig(c, r.x, r.y + 1, glyphs, { scale: s.tier.id === 'L' ? 2 : 1, color: (_x, py) => fade(mix(C.cream, C.orange, py / (s.tier.id === 'L' ? 9 : 4)), a) });
    c.text(r.x, r.y + (s.tier.id === 'L' ? 7 : 5), chart.series[0]!.name, { fg: C.gray, alpha: a });
    return a < 1;
  }
  if (chart.type === 'stacked_area' && chart.series.length > 1) return stacked(s, chart.series, r, chart.highlight);
  if (!points.length) return false;
  if (['hbar', 'words', 'autocomplete', 'keyboard', 'tally', 'bubbles', 'grid'].includes(chart.type)) return list(s, points, r, chart.unit);
  if (chart.type === 'line' && points.length >= 3 && typeof points[0]!.x === 'string' && /^\d{4}-\d{2}$/.test(points[0]!.x)) return area(s, points, r, chart.highlight, chart.unit);
  return columns(s, points, r, chart.highlight, chart.unit);
}
