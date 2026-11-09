/** The scale (display counters on a column grid) and the legacy bill (a ledger, no spend data). */
import { compact, count, money, shortDate } from '../format.js';
import { textWidth, type Rect } from '../gfx/draw.js';
import { countUp } from '../gfx/motion.js';
import type { Counter, DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay, type DisplayOptions } from '../theme/display.js';
import { fade, rule, txt, txtRight, vrule, type K } from '../theme/kit.js';
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
  // One row of solid numerals when they all fit, else a 2×2 grid; the stroke face is the last resort.
  const tryLayout = (cols: number, tall: boolean, face: 'solid' | 'heavy'): DisplayOptions | null => {
    if (!k.uni) return null;
    const colW = Math.floor((r.w + 4) / cols) - 4;
    const o: DisplayOptions = { face, tall };
    return finals.every(f => displayWidth(f.replace(/[KMBT]$/, ''), o) + (/[KMBT]$/.test(f) ? 2 : 0) <= colW - 2) ? o : null;
  };
  let cols = counters.length;
  let opts = tryLayout(cols, L && r.h >= 12, 'solid') ?? tryLayout(cols, false, 'solid');
  if (!opts && counters.length > 2) { cols = 2; opts = tryLayout(2, L && r.h >= 16, 'solid') ?? tryLayout(2, false, 'solid'); }
  if (!opts) { cols = counters.length; opts = tryLayout(cols, false, 'heavy'); }
  if (!opts) cols = Math.min(counters.length, 2);
  const colW = Math.floor((r.w + 4) / cols);
  const numH = opts ? displayHeight(opts) : 1;
  const blockH = numH + 2;
  const rows = Math.ceil(counters.length / cols);
  const rowGap = L ? 2 : 1;
  const totalH = rows * blockH + (rows - 1) * rowGap;
  const y0 = r.y + Math.max(0, Math.floor((r.h - totalH) / 3));
  counters.forEach((counter, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * colW;
    const y = y0 + row * (blockH + rowGap);
    const start = i * 150;
    const a = fade(k, start, 260);
    if (col) vrule(k, x - 3, y, blockH, a);
    const value = s.caps.motion ? countUp(counter.value, s.t, start, 950) : counter.value;
    if (s.caps.motion && s.t < start + 950) k.busy = true;
    const text = counterText(counter, value);
    if (opts) {
      // A compact suffix (8.4B) is set small beside the numerals, not as a display letter.
      const [, digits, unit] = /^(.*?)([KMBT]?)$/.exec(text)!;
      const dw = drawDisplay(k.c, x, y, digits!, fadeIn(tk, tk.text, a), tk.bg, opts);
      if (unit) txt(k, x + dw + 1, y + displayHeight(opts) - 1, unit, tk.text2, { bold: true, a });
    }
    else txt(k, x, y, text, tk.text, { bold: true, a });
    txt(k, x, y + numH + 1, cap(counter.label), tk.text2, { a }, colW - 4);
  });
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
