/** The 1.9 spend card (lifetime · monthly bars · daily heat strip) and the model-eras strip. */
import { C, fade, heat, mix, type Rgb } from '../gfx/color.js';
import { spaced, textRight, textWidth, type Rect } from '../gfx/draw.js';
import { bigWidth, drawBig } from '../gfx/font.js';
import { countUp, easeOutCubic, seg } from '../gfx/motion.js';
import { count, money, shortDate } from '../format.js';
import { monthLabel, type SpendView } from '../story/deck.js';
import type { Scene } from './scene.js';

export function spendBody(s: Scene, sp: SpendView, r: Rect): boolean {
  const { c, t, tier } = s;
  let busy = t < 1800;
  const pixel = s.caps.color !== 'none' && s.caps.unicode;
  const side = r.w >= 90;
  const leftW = side ? Math.min(44, Math.floor(r.w * 0.4)) : r.w;
  let y = r.y;
  // Lifetime, counting up.
  const value = '$' + count(Math.round(countUp(sp.measured, t, 100, 1100)));
  const final = '$' + count(Math.round(sp.measured));
  const scale = tier.id === 'L' && bigWidth(final, 2) <= leftW && r.h >= 18 ? 2 : 1;
  if (pixel && bigWidth(final, scale) <= leftW) {
    drawBig(c, r.x, y, value, { scale, color: (_x, py) => mix(C.cream, C.orange, py / (5 * scale - 1)) });
    y += scale === 2 ? 6 : 4;
  } else { c.text(r.x, y, final, { fg: C.orange, bold: true }); y += 2; }
  const a = seg(t, 600, 400);
  c.text(r.x, y++, 'lifetime, measured · API list prices', { fg: C.gray, alpha: a }, leftW);
  y++;
  const line = (label: string, v: string, extra = '', color: Rgb = C.cream) => {
    if (y >= r.y + r.h) return;
    c.text(r.x, y, label, { fg: C.gray, alpha: a });
    const w = c.text(r.x + 16, y, v, { fg: color, bold: true, alpha: a });
    if (extra) c.text(r.x + 17 + w, y, extra, { fg: C.slate, alpha: a }, leftW - 17 - w);
    y++;
  };
  if (sp.recovered) line('+ recovered', money(sp.recovered), 'from usage counters', C.peach);
  if (sp.estimated) line('≈ older prompts', `${money(sp.estimated.low)}–${money(sp.estimated.high).slice(1)}`, `est., ${count(sp.estimated.prompts)} prompts`, C.peach);
  if (sp.recovered || sp.estimated) y++;
  if (sp.thisMonth !== null) line('this month', money(sp.thisMonth));
  if (sp.perDay !== null) line('per active day', money(sp.perDay));
  if (sp.priciestDay) line('priciest day', money(sp.priciestDay.usd), shortDate(sp.priciestDay.day, true));
  const hundred = sp.days.filter(d => d.usd >= 100).length;
  if (hundred) line('$100+ days', count(hundred));

  // Charts: to the right (wide) or below.
  const cx = side ? r.x + leftW + 4 : r.x;
  const cw = side ? r.x + r.w - cx : r.w;
  let cy = side ? r.y : y + 1;
  const room = r.y + r.h - cy;
  if (sp.months.length >= 2 && room >= 6) {
    const barH = Math.max(3, Math.min(side ? 12 : 6, room - (sp.days.length ? 8 : 3)));
    busy = monthBars(s, sp, { x: cx, y: cy, w: cw, h: barH + 2 }) || busy;
    cy += barH + 3;
  }
  if (sp.days.length && r.y + r.h - cy >= 6) busy = heatStrip(s, sp.days, { x: cx, y: cy, w: cw, h: r.y + r.h - cy }) || busy;
  return busy;
}

function monthBars(s: Scene, sp: SpendView, r: Rect): boolean {
  const { c, t } = s;
  const months = sp.months.slice(-12);
  const n = months.length;
  const colW = Math.max(2, Math.min(7, Math.floor(r.w / n)));
  const barW = Math.max(1, colW - 1);
  const h = r.h - 2;
  const bottom = r.y + 1 + h;
  const max = Math.max(...months.map(m => m.measured + m.extra), 1e-9);
  const pixel = s.caps.color === 'truecolor' || s.caps.color === '256';
  c.text(r.x, r.y, s.tier.id === 'L' ? spaced('by month') : 'BY MONTH', { fg: C.gray });
  const legend = months.some(m => m.extra > 0) ? (s.caps.unicode ? '█ measured  ░ recovered / est.' : '# measured  : recovered / est.') : '';
  if (legend) textRight(c, r.x + Math.min(r.w, n * colW), r.y, legend, { fg: C.slate });
  const peak = months.reduce((a, m, i) => (m.measured > months[a]!.measured ? i : a), 0);
  let busy = false;
  months.forEach((m, i) => {
    const k = seg(t, 400 + i * 60, 500, easeOutCubic);
    busy ||= k < 1;
    const x = r.x + i * colW;
    const total = ((m.measured + m.extra) / max) * h * 2 * k;
    const solid = (m.measured / max) * h * 2 * k;
    const color = i === peak ? C.cream : C.orange;
    if (pixel) {
      for (let py = 0; py < Math.round(total); py++) for (let b = 0; b < barW; b++) c.px(x + b, (bottom + 1) * 2 - 1 - py, py < Math.max(1, Math.round(solid)) ? color : mix(C.ink, C.peach, 0.35));
    } else {
      const cells = Math.round(total / 2), solidCells = Math.max(m.measured > 0 ? 1 : 0, Math.round(solid / 2));
      for (let cy = 0; cy < cells; cy++) for (let b = 0; b < barW; b++) c.put(x + b, bottom - cy, cy < solidCells ? (s.caps.unicode ? '█' : '#') : (s.caps.unicode ? '░' : ':'), cy < solidCells ? color : C.peach);
    }
    if (colW >= 4 || i % 2 === 0 || i === n - 1) c.text(x, bottom + 1, monthLabel(m.month), { fg: i === peak ? C.orange : C.slate }, colW);
  });
  const pk = months[peak]!;
  const la = seg(t, 1200, 300);
  const label = money(pk.measured);
  const px = Math.min(r.x + peak * colW, r.x + n * colW - textWidth(label));
  const ty = bottom - Math.ceil(((pk.measured + pk.extra) / max) * h) - 1;
  if (ty > r.y) c.text(px, ty, label, { fg: C.cream, bold: true, alpha: la });
  return busy || la < 1;
}

/** GitHub-style daily grid: weeks across, weekdays down, brightness = $ that day. */
function heatStrip(s: Scene, days: SpendView['days'], r: Rect): boolean {
  const { c, t } = s;
  const byDay = new Map(days.map(d => [d.day, d.usd]));
  const last = new Date(days.at(-1)!.day + 'T12:00:00Z');
  const weeks = Math.min(53, Math.max(4, r.w - 4));
  const start = new Date(last);
  start.setUTCDate(start.getUTCDate() - ((last.getUTCDay() + 6) % 7) - (weeks - 1) * 7);
  const max = Math.max(...days.map(d => d.usd), 1e-9);
  c.text(r.x, r.y, s.tier.id === 'L' ? spaced('every day') : 'EVERY DAY', { fg: C.gray });
  const pixel = s.caps.color === 'truecolor' || s.caps.color === '256';
  const gy = r.y + 1;
  const k = seg(t, 700, 900, easeOutCubic);
  for (let w = 0; w < weeks; w++) {
    if (w / weeks > k) break;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + w * 7 + d);
      if (day > last) continue;
      const iso = day.toISOString().slice(0, 10);
      const usd = byDay.get(iso) ?? 0;
      const v = usd > 0 ? Math.sqrt(usd / max) : 0;
      if (pixel) c.px(r.x + 4 + w, gy * 2 + d, usd > 0 ? heat(0.2 + v * 0.8) : mix(C.ink, C.coal, 0.6));
      else if (d % 2 === 0) {
        const ch = usd <= 0 ? '·' : v > 0.66 ? '█' : v > 0.33 ? '▓' : '░';
        c.put(r.x + 4 + w, gy + d / 2, s.caps.unicode ? ch : usd <= 0 ? '.' : v > 0.5 ? '#' : '+', C.orange);
      }
    }
  }
  c.text(r.x, gy, 'Mon', { fg: C.slate });
  c.text(r.x, gy + 3, 'Sun', { fg: C.slate });
  const busiest = [...days].sort((a, b) => b.usd - a.usd)[0]!;
  const la = seg(t, 1500, 300);
  if (r.h >= 6) c.text(r.x + 4, gy + 4, `brightest: ${shortDate(busiest.day, true)} · ${money(busiest.usd)}`, { fg: C.slate, alpha: la }, r.w - 4);
  return k < 1 || la < 1;
}

const ERA_COLORS = [C.orange, C.peach, C.cream, C.ember, C.gray];

/** Model eras: one cell block per month, coloured by the model that did most of the work. */
export function erasBody(s: Scene, eras: { month: string; label: string }[], r: Rect): boolean {
  const { c, t } = s;
  if (!eras.length) return false;
  const labels = [...new Set(eras.map(e => e.label))];
  const colW = Math.max(2, Math.min(8, Math.floor(r.w / eras.length)));
  const y = r.y + 1;
  const k = seg(t, 200, 900, easeOutCubic);
  eras.forEach((e, i) => {
    if (i / eras.length > k) return;
    const color = ERA_COLORS[labels.indexOf(e.label) % ERA_COLORS.length]!;
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < colW - 1; xx++) c.put(r.x + i * colW + xx, y + yy, s.caps.unicode ? '█' : '#', color);
    if (colW >= 4 || i % 2 === 0) c.text(r.x + i * colW, y + 3, monthLabel(e.month), { fg: C.slate }, colW);
  });
  let lx = r.x;
  const la = seg(t, 1100, 300);
  labels.forEach((label, i) => {
    lx += c.text(lx, y + 5, s.caps.unicode ? '■ ' : '# ', { fg: ERA_COLORS[i % ERA_COLORS.length]!, alpha: la });
    lx += c.text(lx, y + 5, label, { fg: C.cream, alpha: la }) + 3;
  });
  void fade;
  return k < 1 || la < 1;
}
