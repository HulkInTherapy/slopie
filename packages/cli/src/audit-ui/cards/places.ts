/** Projects (ranked meters + the one that got away), delegation (monthly bars), the awards. */
import { count, shortDate } from '../format.js';
import { textWidth, vbar, wrapText, type Rect } from '../gfx/draw.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, label, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

function gotAway(k: K, away: NonNullable<Data<'projects'>['gotAway']>, r: Rect, delay: number): void {
  const { tk, s } = k;
  const a = fade(k, delay, 400);
  let y = r.y;
  label(k, r.x, y++, 'the one that got away', a, r.w);
  y++;
  txt(k, r.x, y++, s.share ? 'a project' : away.name, tk.text, { bold: true, a }, r.w);
  txt(k, r.x, y++, `${count(away.prompts)} prompts in ${away.days} days`, tk.text2, { a }, r.w);
  txt(k, r.x, y++, `then silence for ${away.idle} days`, tk.text, { a }, r.w);
  if (away.lastWords && !s.share && y + 3 <= r.y + r.h) {
    y++;
    txt(k, r.x, y++, 'your last words to it', tk.text3, { a }, r.w);
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
  const step = rows.length * 2 <= r.h ? 2 : 1;
  const max = Math.max(...rows.map(p => p.prompts));
  const nameW = Math.min(20, Math.max(...rows.map(p => textWidth(s.share ? 'Project A' : p.name))) + 2);
  const valW = 7;
  const costW = rows.some(p => p.cost !== null) && barsW >= 50 ? 8 : 0;
  const barW = Math.max(6, barsW - nameW - valW - costW - 2);
  rows.forEach((p, i) => {
    const y = r.y + i * step;
    const start = 100 + i * 90;
    const a = fade(k, start, 260);
    const name = s.share ? `Project ${String.fromCharCode(65 + i)}` : p.name;
    const away = !!data.gotAway && p.name === data.gotAway.name;
    txt(k, r.x, y, name, i === 0 ? tk.text : tk.text2, { bold: i === 0, a }, nameW - 2);
    meter(k, r.x + nameW, y, barW, p.prompts / max, i === 0 ? tk.text : away ? tk.text3 : tk.bar, start);
    const g = s.caps.motion ? seg(s.t, start, 600, easeOutCubic) : 1;
    txtRight(k, r.x + nameW + barW + valW, y, count(Math.round(p.prompts * g)), tk.text, { a });
    if (costW && p.cost !== null) txtRight(k, r.x + nameW + barW + valW + costW, y, '$' + count(Math.round(p.cost)), tk.text3, { a });
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
  const opts = k.uni ? fitDisplay(total, 30, { face: tk.face, tall: L }) : null;
  const numH = opts ? displayHeight(opts) : 1;
  if (opts) drawDisplay(k.c, r.x, r.y, total, fadeIn(tk, tk.text, a), tk.bg, opts);
  else txt(k, r.x, r.y, total, tk.text, { bold: true, a });
  txt(k, r.x, r.y + numH + 1, 'subagents launched', tk.text2, { a });
  if (!data.months.length) return;
  let months = data.months;
  const firstUsed = months.findIndex(m => m.n > 0);
  if (firstUsed > 1) months = months.slice(firstUsed - 1);
  const leftW = Math.max(opts ? displayWidth(total, opts) : textWidth(total), 20) + 8;
  const colW = 5;
  const sideBySide = r.w - leftW >= Math.min(months.length, 5) * colW;
  const gx = sideBySide ? r.x + leftW : r.x;
  const fit = Math.floor((sideBySide ? r.w - leftW : r.w) / colW);
  if (months.length > fit) months = months.slice(months.length - fit);
  const gy = sideBySide ? r.y : r.y + numH + 3;
  const gh = Math.max(3, Math.min(L ? 12 : 8, r.y + r.h - gy - 2));
  const max = Math.max(1, ...months.map(m => m.n));
  if (sideBySide) vrule(k, gx - 4, r.y, gh + 2, fade(k, 200));
  const peak = months.reduce((b, m, i) => (m.n > months[b]!.n ? i : b), 0);
  rule(k, gx, gy + gh, months.length * colW - 2);
  months.forEach((m, i) => {
    const x = gx + i * colW;
    const g = s.caps.motion ? seg(s.t, 250 + i * 60, 600, easeOutCubic) : 1;
    if (g < 1) k.busy = true;
    if (m.n > 0) vbar(k.c, x, gy + gh - 1, gh - 1, Math.max(0.04, (m.n / max) * g), i === peak ? tk.text : tk.bar, 3, !k.uni);
    txt(k, x, gy + gh + 1, monthLabel(m.month), data.firstMonth === m.month ? tk.text : tk.text3);
  });
  const pk = months[peak]!;
  const la = fade(k, 300 + months.length * 60 + 400);
  const ty = gy + gh - 2 - Math.ceil((pk.n / max) * (gh - 1));
  if (ty >= r.y) txt(k, gx + peak * colW, ty, count(pk.n), tk.text, { bold: true, a: la });
}

/* ── the awards: a grid of titles, values and their metal ── */

type Metal = 'gold' | 'silver' | 'bronze';
/** A trophy's metal: the engine's tier when it gives one, else rank (1 gold, 2–3 silver, rest bronze). */
export function metalOf(tier: 'gold' | 'silver' | undefined, rank: number): Metal {
  return tier ?? (rank === 0 ? 'gold' : rank < 3 ? 'silver' : 'bronze');
}

export function awardsBody(k: K, data: Data<'awards'>, r: Rect): void {
  const { tk, L, s } = k;
  const cols = r.w >= 96 ? 3 : 2;
  const gap = 6;
  const colW = Math.floor((r.w - gap * (cols - 1)) / cols);
  const cellH = L ? 5 : 4;
  const rows = Math.min(Math.ceil(data.trophies.length / cols), Math.max(1, Math.floor((r.h + 1) / (cellH + 1))));
  data.trophies.slice(0, rows * cols).forEach((award, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * (colW + gap);
    const y = r.y + row * (cellH + 1);
    const a = fade(k, 150 + i * 140, 360);
    if (row) rule(k, x, y - 1, colW, tk.rule, a);
    const metal = metalOf(award.tier, i);
    // The first trophy is the one the year is about: its metal word in the accent.
    label(k, x, y, metal, a);
    if (i === 0) txt(k, x, y, metal.toUpperCase(), tk.accent, { a });
    const title = wrapText(award.title, colW);
    if (title.length > 2) return;
    title.forEach((line, li) => txt(k, x, y + 1 + li, line, tk.text, { bold: true, a }));
    const value = s.share && award.publicValue ? award.publicValue : award.value;
    const vy = y + 1 + title.length;
    if (textWidth(value) <= colW && vy < y + cellH) txt(k, x, vy, value, tk.text2, { a });
    if (award.sub && vy + 1 < y + cellH && textWidth(award.sub) <= colW) txt(k, x, vy + 1, award.sub, tk.text3, { a });
  });
  if (s.caps.motion && s.t < 150 + data.trophies.length * 140 + 360) k.busy = true;
}
