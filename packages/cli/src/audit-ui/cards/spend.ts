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
import { fade, rule, textWidth, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

export function spendBody(k: K, sp: SpendView, r: Rect): void {
  const { tk, L, s } = k;
  const bottom = r.y + r.h - 1;
  let y = r.y;
  // Columns: the ledger, a hairline, the charts.
  const side = r.w >= 70;
  const lw = side ? (L ? 40 : 32) : r.w;
  const cx = r.x + lw + (L ? 6 : 4);
  const cw = r.x + r.w - cx;

  // Hero number, counting up (right-aligned inside its final width, so it never jitters).
  const final = '$' + count(Math.round(sp.measured));
  const shown = '$' + count(Math.round(countUp(sp.measured, s.caps.motion ? s.t : Infinity, 100, 1000)));
  if (s.caps.motion && s.t < 1100) k.busy = true;
  const fit = k.uni ? fitDisplay(final, lw, { face: tk.face, tall: L && r.h >= 20, currency: tk.text2 }) : null;
  const a0 = fade(k, 100, 400);
  txt(k, r.x, y, 'Lifetime', tk.text3, { a: a0 });
  y += 1;
  if (fit) {
    drawDisplay(k.c, r.x + displayWidth(final, fit) - displayWidth(shown, fit), y, shown, fadeIn(tk, tk.text, a0), tk.bg, fit);
    y += displayHeight(fit) + 1;
  } else {
    txt(k, r.x + textWidth(final) - textWidth(shown), y, shown, tk.text, { bold: true, a: a0 });
    y += 2;
  }
  const a1 = fade(k, 500);
  txt(k, r.x, y, 'measured at API list prices', tk.text2, { a: a1 }, lw);
  y += L && r.h >= 20 ? 2 : 1;

  // The ledger: label · right-aligned figure · note. Whole lines only.
  const valX = r.x + (L ? 26 : 24);
  const lines: ([string, string, string] | null)[] = [];
  if (sp.recovered) lines.push(['Recovered', money(sp.recovered), 'usage counters']);
  if (sp.estimated) lines.push(['Older prompts', `${money(sp.estimated.low)}–${money(sp.estimated.high).slice(1)}`, 'est.']);
  if (lines.length) lines.push(null);
  if (sp.thisMonth !== null) lines.push(['This month', money(sp.thisMonth), '']);
  if (sp.perDay !== null) lines.push(['Per active day', money(sp.perDay), '']);
  if (sp.priciestDay) lines.push(['Priciest day', money(sp.priciestDay.usd), shortDate(sp.priciestDay.day)]);
  const hundred = sp.days.filter(d => d.usd >= 100).length;
  if (hundred) lines.push(['$100+ days', count(hundred), '']);
  for (const line of lines) {
    if (y > bottom) break;
    if (!line) { if (L && r.h >= 20) { rule(k, r.x, y, Math.min(lw, valX - r.x + 16), tk.rule, a1); y++; } continue; }
    const [name, value, note] = line;
    txt(k, r.x, y, name, tk.text2, { a: a1 });
    txtRight(k, valX, y, value, tk.text, { a: a1 });
    if (note && valX + 2 + textWidth(note) <= r.x + lw) txt(k, valX + 2, y, note, tk.text3, { a: a1 });
    y++;
  }

  if (!side) return;
  vrule(k, cx - (L ? 3 : 2), r.y, r.h);
  let cy = r.y;
  const room = bottom - cy + 1;
  const wantGrid = sp.days.length > 0 && room >= 16;
  const barsH = Math.max(4, Math.min(L ? 13 : 10, room - (wantGrid ? 8 : 2)));
  if (sp.months.length >= 2 && room >= 7) {
    txt(k, cx, cy, 'By month', tk.text3);
    if (sp.months.some(m => m.extra > 0)) {
      const legend: [string, number][] = [[k.uni ? '■' : '#', tk.bar], [' measured   ', tk.text3], [k.uni ? '■' : ':', tk.barSoft], [' recovered, est.', tk.text3]];
      let lx = r.x + r.w - legend.reduce((a, [t]) => a + textWidth(t), 0);
      // Only when it clears the chart label with room to spare.
      if (lx >= cx + textWidth('By month') + 4) for (const [t, col] of legend) lx += txt(k, lx, cy, t, col);
    }
    cy += 2;
    monthBars(k, { x: cx, y: cy, w: cw, h: barsH }, sp.months);
    cy += barsH + 1;
  }
  if (wantGrid && bottom - cy >= 5) {
    txt(k, cx, cy, 'Every day', tk.text3);
    dayGrid(k, { x: cx, y: cy + 1, w: cw, h: 5 }, sp.days);
  }
}

/** Model eras: one block per month, a grey per model (the latest model in primary), a legend. */
export function erasBody(k: K, eras: { month: string; label: string }[], r: Rect): void {
  const { tk } = k;
  if (!eras.length) return;
  const labels = [...new Set(eras.map(e => e.label))];
  const latest = eras.at(-1)!.label;
  const inks = [tk.text2, tk.text3, tk.bar, tk.barSoft];
  const inkOf = (lab: string) => (lab === latest ? tk.text : inks[labels.filter(l => l !== latest).indexOf(lab) % inks.length]!);
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
