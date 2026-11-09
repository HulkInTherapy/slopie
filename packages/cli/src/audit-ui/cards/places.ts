/** Projects (ranked meters + the one that got away), delegation (monthly bars), the awards. */
import { count, shortDate } from '../format.js';
import { textWidth, vbar, wrapText, type Rect } from '../gfx/draw.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { chip, fade, heroScale, label, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

function gotAway(k: K, away: NonNullable<Data<'projects'>['gotAway']>, r: Rect, delay: number): void {
  const { tk, s } = k;
  const a = fade(k, delay, 400);
  let y = r.y;
  label(k, r.x, y++, 'the one that got away', a, r.w, tk.accentHi);
  y++;
  txt(k, r.x, y++, s.share ? 'a project' : away.name, tk.text, { bold: true, a }, r.w);
  y++;
  txt(k, r.x, y++, `${count(away.prompts)} prompts in ${away.days} days`, tk.text, { a }, r.w);
  txt(k, r.x, y++, `silence for ${away.idle} days`, tk.accentHi, { bold: true, a }, r.w);
  if (away.lastWords && !s.share && y + 3 <= r.y + r.h) {
    y++;
    label(k, r.x, y++, 'your last words to it', a, r.w);
    const lines = wrapText(`“${away.lastWords}”`, r.w);
    if (lines.length <= Math.max(1, r.y + r.h - y - 2)) for (const line of lines) txt(k, r.x, y++, line, tk.text2, { italic: true, a });
  }
  if (y + 1 < r.y + r.h) txt(k, r.x, y + 1, shortDate(away.lastDay, true), tk.text3, { a });
}

export function projectsBody(k: K, data: Data<'projects'>, r: Rect): void {
  const { tk, L, s } = k;
  const cardW = L ? 36 : 30;
  const side = !!data.gotAway && r.w - cardW - 6 >= 34;
  const barsW = side ? r.w - cardW - 6 : r.w;
  const rows = data.rows.slice(0, Math.min(6, Math.max(1, Math.floor(r.h / (r.h >= 12 ? 2 : 1)))));
  const step = rows.length * 3 <= r.h ? 3 : rows.length * 2 <= r.h ? 2 : 1;
  const max = Math.max(...rows.map(p => p.prompts));
  const nameW = Math.min(20, Math.max(...rows.map(p => textWidth(s.share ? 'Project A' : p.name))) + 2);
  const valW = 7;
  const costW = rows.some(p => p.cost !== null) && barsW >= 50 ? 8 : 0;
  const barW = Math.max(6, barsW - nameW - valW - costW - 2);
  rows.forEach((p, i) => {
    const y = r.y + Math.max(0, Math.floor((r.h - rows.length * step) / 3)) + i * step;
    const start = 100 + i * 90;
    const a = fade(k, start, 260);
    const name = s.share ? `Project ${String.fromCharCode(65 + i)}` : p.name;
    const away = !!data.gotAway && p.name === data.gotAway.name;
    txt(k, r.x, y, name, away ? tk.accentHi : tk.text, { bold: i === 0 || away, a }, nameW - 2);
    meter(k, r.x + nameW, y, barW, p.prompts / max, i === 0 ? tk.accent : tk.accentLo, start);
    const g = s.caps.motion ? seg(s.t, start, 600, easeOutCubic) : 1;
    txtRight(k, r.x + nameW + barW + valW, y, count(Math.round(p.prompts * g)), tk.text, { bold: true, a });
    if (costW && p.cost !== null) txtRight(k, r.x + nameW + barW + valW + costW, y, '$' + count(Math.round(p.cost)), tk.text2, { a });
  });
  if (data.gotAway && side) {
    const gx = r.x + barsW + 6;
    vrule(k, gx - 3, r.y, Math.min(r.h, 12), fade(k, 500));
    gotAway(k, data.gotAway, { x: gx, y: r.y, w: cardW, h: r.h }, 500);
  } else if (data.gotAway && r.h - rows.length * step >= 8) {
    const gy = r.y + rows.length * step + 1;
    rule(k, r.x, gy, Math.min(r.w, 56), tk.rule, fade(k, 500));
    gotAway(k, data.gotAway, { x: r.x, y: gy + 2, w: Math.min(r.w, 56), h: r.y + r.h - gy - 2 }, 500);
  }
  if (s.caps.motion && s.t < 1600) k.busy = true;
}

/* ── delegation: the total, then subagents by month ── */

export function delegationBody(k: K, data: Data<'delegation'>, r: Rect): void {
  const { tk, L, s } = k;
  const total = count(data.total);
  const a = fade(k, 0, 300);
  const gh = Math.max(4, Math.min(L ? 18 : 10, r.h - 3));
  const opts = k.uni ? fitDisplay(total, 40, { face: tk.face, tall: L, scale: heroScale(k) }) : null;
  const numH = opts ? displayHeight(opts) : 1;
  const gy = r.y + Math.max(0, Math.floor((r.h - gh - 3) / 2));
  const hy = gy + Math.max(0, Math.floor((gh - numH - 2) / 2));
  if (opts) drawDisplay(k.c, r.x, hy, total, fadeIn(tk, tk.text, a), tk.bg, opts);
  else txt(k, r.x, hy, total, tk.text, { bold: true, a });
  txt(k, r.x, hy + numH + 1, 'subagents launched', tk.text2, { a });
  if (!data.months.length) return;
  let months = data.months;
  const firstUsed = months.findIndex(m => m.n > 0);
  if (firstUsed > 1) months = months.slice(firstUsed - 1);
  const leftW = Math.max(opts ? displayWidth(total, opts) : textWidth(total), 20) + 8;
  const sideBySide = r.w - leftW >= Math.min(months.length, 5) * 5;
  const gx = sideBySide ? r.x + leftW : r.x;
  const avail = sideBySide ? r.x + r.w - gx : r.w;
  const colW = Math.max(4, Math.min(14, Math.floor(avail / Math.max(1, months.length))));
  const fit = Math.floor(avail / colW);
  if (months.length > fit) months = months.slice(months.length - fit);
  const barW = colW - 2;
  const max = Math.max(1, ...months.map(m => m.n));
  if (sideBySide) vrule(k, gx - 4, gy, gh + 2, fade(k, 200));
  const peak = months.reduce((b, m, i) => (m.n > months[b]!.n ? i : b), 0);
  rule(k, gx, gy + gh, months.length * colW - 2);
  months.forEach((m, i) => {
    const x = gx + i * colW;
    const g = s.caps.motion ? seg(s.t, 250 + i * 60, 600, easeOutCubic) : 1;
    if (g < 1) k.busy = true;
    if (m.n > 0) vbar(k.c, x, gy + gh - 1, gh - 2, Math.max(0.04, (m.n / max) * g), i === peak ? tk.accent : tk.accentLo, barW, !k.uni);
    const first = data.firstMonth === m.month;
    txt(k, x, gy + gh + 1, monthLabel(m.month), first || i === peak ? tk.accentHi : tk.text3, { bold: first || i === peak });
  });
  const pk = months[peak]!;
  const la = fade(k, 300 + months.length * 60 + 400);
  const ty = gy + gh - 2 - Math.ceil((pk.n / max) * (gh - 2));
  if (ty >= r.y) txt(k, gx + peak * colW, ty, count(pk.n), tk.text, { bold: true, a: la });
}

/* ── the awards: a grid of titles, values and their metal ── */

type Metal = 'gold' | 'silver' | 'bronze';
/** A trophy's metal: the engine's tier when it gives one, else rank (1 gold, 2–3 silver, rest bronze). */
export function metalOf(tier: 'gold' | 'silver' | undefined, rank: number): Metal {
  return tier ?? (rank === 0 ? 'gold' : rank < 3 ? 'silver' : 'bronze');
}

const RANK_INK = (k: K, i: number) => [k.tk.accentHi, k.tk.text, k.tk.text2][i] ?? k.tk.text2;

function metalChip(k: K, x: number, y: number, metal: Metal, a: number): number {
  const { tk } = k;
  if (metal === 'gold') return chip(k, x, y, 'GOLD', tk.accent, tk.bg, a);
  if (metal === 'silver') return chip(k, x, y, 'SILVER', tk.bar, tk.text, a);
  return chip(k, x, y, 'BRONZE', tk.barSoft, tk.text, a);
}

export function awardsBody(k: K, data: Data<'awards'>, r: Rect): void {
  const { tk, L, s } = k;
  const top = data.trophies.slice(0, 3);
  const rest = data.trophies.slice(3, 6);
  const gap = 6;
  const cols = Math.max(1, top.length);
  const colW = Math.floor((r.w - gap * (cols - 1)) / cols);
  const restH = rest.length && r.h >= 18 ? 4 : 0;
  const numOpts = k.uni ? fitDisplay('1', colW, { face: tk.face, tall: L && r.h >= 22, scale: heroScale(k) }) : null;
  const numH = numOpts ? displayHeight(numOpts) : 1;
  const colH = numH + 9;
  const lift = r.h - restH >= colH + 4 ? 2 : 0;
  const y0 = r.y + lift + Math.max(0, Math.floor((r.h - restH - colH - lift - 2) / 2));
  // Podium order: silver, gold, bronze (gold in the middle, lifted).
  const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i);
  order.forEach((rank, slot) => {
    const award = top[rank]!;
    const x = r.x + slot * (colW + gap);
    const gold = rank === 0;
    const y = y0 - (gold ? lift : 0);
    const a = fade(k, 150 + rank * 220, 400);
    // The chip follows the displayed rank: 1 gold, 2 silver, 3 bronze.
    const metal: Metal = rank === 0 ? 'gold' : rank === 1 ? 'silver' : 'bronze';
    if (gold) rule(k, x, y - 1, colW, tk.accent, a);
    let cy = y + 1;
    const n = String(rank + 1);
    if (numOpts) drawDisplay(k.c, x, cy, n, fadeIn(tk, RANK_INK(k, rank), a), tk.bg, numOpts);
    else txt(k, x, cy, `#${n}`, RANK_INK(k, rank), { bold: true, a });
    metalChip(k, x + (numOpts ? displayWidth(n, numOpts) + 3 : 4), cy + numH - 1, metal, a);
    cy += numH + 1;
    const title = wrapText(award.title, colW, 2);
    title.forEach((line, li) => txt(k, x, cy + li, line, tk.text, { bold: true, a }));
    cy += 3;
    const value = s.share && award.publicValue ? award.publicValue : award.value;
    txt(k, x, cy, value, gold ? tk.accentHi : tk.text, { bold: true, a }, colW);
    const sub = s.share && award.publicSub !== undefined ? award.publicSub : award.sub;
    if (sub) txt(k, x, cy + 1, sub, tk.text2, { a }, colW);
    if (gold) rule(k, x, y0 + colH - 1, colW, tk.accent, a);
  });
  if (restH) {
    const ry = r.y + r.h - 3;
    const ra = fade(k, 900, 400);
    rule(k, r.x, ry - 1, r.w, tk.rule, ra);
    const rw = Math.floor((r.w - gap * 2) / 3);
    rest.forEach((award, i) => {
      const x = r.x + i * (rw + gap);
      // Ranks 4–6: a small numeral, no tier chip.
      const cw = txt(k, x, ry + 1, String(i + 4), tk.text3, { bold: true, a: ra }) + 1;
      txt(k, x + cw + 1, ry + 1, award.title, tk.text, { bold: true, a: ra }, rw - cw - 1);
      const value = s.share && award.publicValue ? award.publicValue : award.value;
      txt(k, x + cw + 1, ry + 2, value, tk.text2, { a: ra }, rw - cw - 1);
    });
  }
  if (s.caps.motion && s.t < 1800) k.busy = true;
}
