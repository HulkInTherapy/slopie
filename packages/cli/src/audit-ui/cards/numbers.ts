/** The scale (display counters on a column grid) and the legacy bill (a ledger, no spend data). */
import { compact, count, money, shortDate } from '../format.js';
import { textWidth, type Rect } from '../gfx/draw.js';
import { countUp } from '../gfx/motion.js';
import type { Counter, DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay, type DisplayOptions } from '../theme/display.js';
import { facts, fade, heroScale, label, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

function counterText(counter: Counter, value: number): string {
  if (counter.style === 'compact') return compact(value).replace('—', '0');
  return count(Math.round(value));
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

export function scaleBody(k: K, data: Data<'scale'>, r: Rect): void {
  const { tk, L, s } = k;
  const counters = data.counters;
  const finals = counters.map(c => counterText(c, c.value));
  const factRows = data.facts.length && r.h >= 14 ? 3 : 0;
  const area = { ...r, h: r.h - factRows };
  // A 2×2 grid of display numbers that fills the box; one row when only two counters.
  const cols = counters.length <= 2 ? counters.length : 2;
  const rows = Math.ceil(counters.length / cols);
  const colW = Math.floor(r.w / cols);
  const fits = (o: DisplayOptions) => finals.every(f => displayWidth(f.replace(/[KMBT]$/, ''), o) + (/[KMBT]$/.test(f) ? 2 : 0) <= colW - 6);
  const tall = L && area.h >= rows * 9;
  let opts: DisplayOptions | null = null;
  if (k.uni) for (const o of [{ face: 'solid' as const, tall, scale: heroScale(k) }, { face: 'solid' as const, tall }, { face: 'solid' as const }, { face: 'heavy' as const }]) if (fits(o)) { opts = o; break; }
  const numH = opts ? displayHeight(opts) : 1;
  const blockH = numH + 2;
  const gap = Math.max(1, Math.floor((area.h - rows * blockH) / (rows + 1)));
  const y0 = area.y + Math.max(0, Math.floor((area.h - rows * blockH - (rows - 1) * gap) / 2));
  counters.forEach((counter, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * colW + (col ? 4 : 0);
    const y = y0 + row * (blockH + gap);
    const start = i * 150;
    const a = fade(k, start, 260);
    const ink = fadeIn(tk, i === 0 ? tk.accentHi : tk.text, a);
    const value = s.caps.motion ? countUp(counter.value, s.t, start, 950) : counter.value;
    if (s.caps.motion && s.t < start + 950) k.busy = true;
    const text = counterText(counter, value);
    if (opts) {
      // A compact suffix (8.4B) is set small beside the numerals, in the accent.
      const [, digits, unit] = /^(.*?)([KMBT]?)$/.exec(text)!;
      const dw = drawDisplay(k.c, x, y, digits!, ink, tk.bg, opts);
      if (unit) txt(k, x + dw + 1, y + displayHeight(opts) - 1, unit, tk.accentHi, { bold: true, a });
    }
    else txt(k, x, y, text, ink, { bold: true, a });
    label(k, x, y + numH + 1, counter.label, a, colW - 4);
  });
  if (factRows) {
    const fy = r.y + r.h - 2;
    rule(k, r.x, fy - 1, r.w, tk.rule, fade(k, 900));
    facts(k, r.x, fy, r.w, data.facts, fade(k, 900));
  }
}

/* ── the legacy bill: a ledger (snapshots without spend data) ────────────── */

export function billBody(k: K, data: Data<'bill'>, r: Rect): void {
  const { tk, L, s } = k;
  const side = r.w >= 80;
  const lw = side ? Math.min(52, Math.floor(r.w * 0.5)) : r.w;
  const a = fade(k, 100, 400);
  let y = r.y;
  txt(k, r.x, y, 'At API list prices · not a bill', tk.text3, { a });
  y += 2;
  const rows = data.lines.map(l => [l.name, money(l.value)] as const);
  if (data.more > 0) rows.push(['everything else', money(data.more)] as const);
  const room = Math.max(1, r.y + r.h - y - (L ? 8 : 5));
  rows.slice(0, room).forEach(([name, value], i) => {
    const ra = fade(k, 150 + i * 60, 260);
    const nw = txt(k, r.x, y, name, tk.text2, { a: ra }, lw - textWidth(value) - 2);
    void nw;
    txtRight(k, r.x + lw, y, value, tk.text, { a: ra });
    y++;
  });
  y++;
  rule(k, r.x, y, lw);
  y += 1;
  const total = money(s.caps.motion ? countUp(data.total, s.t, 400, 800) : data.total);
  if (s.caps.motion && s.t < 1200) k.busy = true;
  const fit = k.uni ? fitDisplay(money(data.total), lw - 8, { face: tk.face, tall: L && r.h >= 18 }) : null;
  txt(k, r.x, y + (fit ? 1 : 0), 'Total', tk.text2, { a });
  if (fit) {
    drawDisplay(k.c, r.x + lw - displayWidth(total, fit), y, total, tk.text, tk.bg, fit);
    y += displayHeight(fit) + 1;
  } else { txtRight(k, r.x + lw, y, total, tk.text, { bold: true }); y += 2; }
  if (data.priciest && y < r.y + r.h) {
    const pa = fade(k, 900);
    txt(k, r.x, y, 'Priciest sentence', tk.text2, { a: pa });
    txtRight(k, r.x + lw, y, `${shortDate(data.priciest.day)}  ${money(data.priciest.cost)}`, tk.text, { a: pa });
  }
  if (!side || !data.byAgent.length) return;
  const sx = r.x + lw + 6;
  const sw = r.x + r.w - sx;
  vrule(k, sx - 3, r.y, Math.min(r.h, 2 + data.byAgent.length * 2 + 1));
  txt(k, sx, r.y, 'By agent', tk.text3, { a });
  const nameW = Math.max(...data.byAgent.map(row => textWidth(row.name))) + 2;
  data.byAgent.slice(0, 4).forEach((row, i) => {
    const yy = r.y + 2 + i * 2;
    const pct = row.share < 0.01 ? '<1%' : `${Math.round(row.share * 100)}%`;
    txt(k, sx, yy, row.name, i === 0 ? tk.text : tk.text2, { a });
    const bw = Math.max(4, sw - nameW - 6);
    meter(k, sx + nameW, yy, bw, row.share, i === 0 ? tk.text : tk.bar, 500 + i * 120);
    txtRight(k, sx + sw, yy, pct, tk.text2, { a });
  });
}
