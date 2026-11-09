/**
 * The bill (spend data): a ledger on the left (the hero number, then right-aligned figures), a
 * hairline, and the charts on the right (monthly bars, the daily grid). Also the model-eras strip.
 */
import { count, money, shortDate } from '../format.js';
import type { Rect } from '../gfx/draw.js';
import { countUp, easeOutCubic, seg } from '../gfx/motion.js';
import { monthLabel, type SpendView } from '../story/deck.js';
import { dayGrid, monthBars } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, heroScale, label, stat, textWidth, txt, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

export function spendBody(k: K, sp: SpendView, r: Rect): void {
  const { tk, L, s } = k;
  const bottom = r.y + r.h - 1;
  let y = r.y;
  // Columns: the ledger (40%), a hairline, the charts (60%).
  const side = r.w >= 70;
  const lw = side ? Math.floor(r.w * 0.4) - 3 : r.w;
  const cx = r.x + lw + (L ? 6 : 4);
  const cw = r.x + r.w - cx;

  // Hero number, counting up (right-aligned inside its final width, so it never jitters).
  const final = '$' + count(Math.round(sp.measured));
  const shown = '$' + count(Math.round(countUp(sp.measured, s.caps.motion ? s.t : Infinity, 100, 1000)));
  if (s.caps.motion && s.t < 1100) k.busy = true;
  const a0 = fade(k, 100, 400);
  const fit = k.uni ? fitDisplay(final, lw, { face: tk.face, tall: L && r.h >= 20, currency: fadeIn(tk, tk.accentHi, a0), scale: heroScale(k) }) : null;
  if (fit) {
    drawDisplay(k.c, r.x + displayWidth(final, fit) - displayWidth(shown, fit), y, shown, fadeIn(tk, tk.text, a0), tk.bg, fit);
    y += displayHeight(fit) + 1;
  } else {
    txt(k, r.x + textWidth(final) - textWidth(shown), y, shown, tk.text, { bold: true, a: a0 });
    y += 2;
  }
  const a1 = fade(k, 500);
  txt(k, r.x, y, 'lifetime at API prices', tk.text2, { a: a1 }, lw);
  y += 2;

  // Label/value pairs, stacked with a blank row between them.
  const pairs: [string, string, boolean][] = [];
  if (sp.thisMonth !== null) pairs.push(['this month', money(sp.thisMonth), false]);
  if (sp.perDay !== null) pairs.push(['per active day', money(sp.perDay), false]);
  if (sp.priciestDay) pairs.push(['priciest day', `${money(sp.priciestDay.usd)}  ${shortDate(sp.priciestDay.day)}`, true]);
  const hundred = sp.days.filter(d => d.usd >= 100).length;
  if (hundred) pairs.push(['$100+ days', count(hundred), false]);
  const notes: string[] = [];
  if (sp.recovered) notes.push(`+${money(sp.recovered)} recovered`);
  if (sp.estimated) notes.push(`older prompts est. ${money(sp.estimated.low)}–${money(sp.estimated.high).slice(1)}`);
  const note = notes.join(' · ');
  const noteRows = note && textWidth(note) <= lw ? 2 : 0;
  const step = bottom - y - noteRows >= pairs.length * 3 ? 3 : 2;
  for (const [name, value, hot] of pairs) {
    if (y + 1 > bottom - noteRows) break;
    stat(k, r.x, y, name, value, { hot, a: a1, maxW: lw });
    y += step;
  }
  if (noteRows) txt(k, r.x, bottom, note, tk.text3, { a: a1 });

  if (!side) return;
  vrule(k, cx - (L ? 3 : 2), r.y, r.h);
  let cy = r.y;
  const room = bottom - cy + 1;
  const gridH = room >= 22 ? 8 : 5;
  const wantGrid = sp.days.length > 0 && room >= 16;
  const barsH = Math.max(4, Math.min(L ? 16 : 10, room - (wantGrid ? gridH + 4 : 2)));
  if (sp.months.length >= 2 && room >= 7) {
    label(k, cx, cy, 'by month');
    if (sp.months.some(m => m.extra > 0)) {
      const legend: [string, number][] = [[k.uni ? '■' : '#', tk.accentLo], [' measured   ', tk.text3], [k.uni ? '■' : ':', tk.barSoft], [' recovered, est.', tk.text3]];
      let lx = r.x + r.w - legend.reduce((a, [t]) => a + textWidth(t), 0);
      if (lx >= cx + textWidth('BY MONTH') + 4) for (const [t, col] of legend) lx += txt(k, lx, cy, t, col);
    }
    cy += 1;
    monthBars(k, { x: cx, y: cy, w: cw, h: barsH }, sp.months);
    cy += barsH + 1;
  }
  if (wantGrid && bottom - cy >= 5) {
    label(k, cx, cy, 'every day');
    dayGrid(k, { x: cx, y: cy + 1, w: cw, h: Math.min(gridH, bottom - cy) }, sp.days);
  }
}

/** Model eras: one block per month, a grey per model (the latest model in primary), a legend. */
export function erasBody(k: K, eras: { month: string; label: string }[], r: Rect): void {
  const { tk } = k;
  if (!eras.length) return;
  const labels = [...new Set(eras.map(e => e.label))];
  const latest = eras.at(-1)!.label;
  // Indigo tints by recency: the oldest in accentLo up to accentHi, the current model in the accent.
  const older = labels.filter(l => l !== latest);
  const tints = [tk.accentLo, tk.accentMid, tk.accentHi];
  const inkOf = (lab: string) => (lab === latest ? tk.accent : tints[Math.max(0, tints.length - older.length + older.indexOf(lab))] ?? tk.accentLo);
  const colW = Math.max(2, Math.min(8, Math.floor(r.w / eras.length)));
  const y = r.y + 1;
  const g = k.s.caps.motion ? seg(k.s.t, 200, 900, easeOutCubic) : 1;
  if (g < 1) k.busy = true;
  eras.forEach((e, i) => {
    if (i / eras.length > g) return;
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < colW - 1; xx++) k.c.put(r.x + i * colW + xx, y + yy, k.uni ? '█' : '#', inkOf(e.label), tk.bg, 0);
    if (colW >= 4 || i % 2 === 0) txt(k, r.x + i * colW, y + 3, monthLabel(e.month), tk.text3, {}, colW * 2);
  });
  let lx = r.x;
  const la = fade(k, 1100, 300);
  for (const lab of labels) {
    if (lx + textWidth(lab) + 2 > r.x + r.w) break;
    lx += txt(k, lx, y + 5, k.uni ? '■ ' : '# ', inkOf(lab), { a: la });
    lx += txt(k, lx, y + 5, lab, lab === latest ? tk.text : tk.text2, { a: la }) + 3;
  }
}
