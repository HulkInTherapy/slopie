/** Guess your #1 model (key chips → ranked meters) and the favourite-vs-nemesis face-off. */
import { textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { easeOutCubic, seg, spring } from '../gfx/motion.js';
import type { DeckCard, Gauge } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { fade, label, rule, txt, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

type Data<T extends DeckCard['kind']> = Extract<DeckCard, { kind: T }>['data'];

/** A key cap: the key in primary on a hairline-grey chip (" 1 "). */
function key(k: K, x: number, y: number, text: string, a: number): number {
  return k.c.text(x, y, ` ${text} `, { fg: fadeIn(k.tk, k.tk.text, a), bg: fadeIn(k.tk, k.tk.rule, a), bold: true });
}

export function guessBody(k: K, data: Data<'guess'>, r: Rect): void {
  const { tk, s } = k;
  const n = data.options.length;
  if (s.state.guess === undefined) {
    const cols = r.w >= 70 && n > 2 ? 2 : 1;
    const gap = 6;
    const colW = Math.min(44, Math.floor((r.w - gap * (cols - 1)) / cols));
    const rowH = r.h >= 12 ? 3 : 2;
    const rows = Math.ceil(n / cols);
    data.options.forEach((option, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = r.x + col * (colW + gap);
      const y = r.y + row * rowH;
      const a = fade(k, 80 + i * 90, 300);
      if (row) rule(k, x, y - 1, colW, tk.rule, a);
      const kw = key(k, x, y, String(i + 1), a);
      txt(k, x + kw + 2, y, option.name, tk.text, { bold: true, a }, colW - kw - 2);
    });
    const hy = r.y + rows * rowH + 1;
    if (hy < r.y + r.h) {
      const a = fade(k, 600, 400);
      txt(k, r.x, hy, k.uni ? 'or → to just tell me' : 'or > to just tell me', tk.text3, { a });
    }
    if (s.caps.motion && s.t < 1000) k.busy = true;
    return;
  }
  // Reveal: meters race to their share, then the rows settle into share order.
  const tg = Math.max(0, s.t - (s.state.guessAt ?? 0));
  const max = Math.max(...data.options.map(o => o.share));
  const nameW = Math.min(22, Math.max(...data.options.map(o => textWidth(o.name))) + 2);
  const tagW = 12;
  const barW = Math.max(6, Math.min(48, r.w - nameW - 7 - tagW));
  const rowGap = r.h >= 12 ? 2 : 1;
  if (s.caps.motion && tg < 1600) k.busy = true;
  const order = data.options.map((o, i) => [o.share, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
  const rank = data.options.map((_, i) => order.indexOf(i));
  const sortK = s.caps.motion ? seg(tg, 950, 450, easeOutCubic) : 1;
  if (sortK < 1) k.busy = true;
  data.options.forEach((option, i) => {
    const y = r.y + Math.round((i + (rank[i]! - i) * sortK) * rowGap);
    const correct = i === data.answer;
    const mine = i === s.state.guess;
    const g = s.caps.motion ? Math.max(0, Math.min(1, spring((tg - i * 60) / 1000, 2.2, 0.7))) : 1;
    txt(k, r.x, y, option.name, correct ? tk.text : tk.text2, { bold: correct }, nameW - 1);
    meter(k, r.x + nameW, y, barW, (option.share / max) * g, correct ? tk.accent : mine ? tk.text2 : tk.bar);
    const done = s.caps.motion ? seg(tg, 700, 300) : 1;
    const pct = `${Math.round(option.share * 100)}%`;
    const px = r.x + nameW + barW + 2;
    const pw = txt(k, px, y, pct, correct ? tk.text : tk.text2, { bold: correct, a: done });
    const tag = correct ? '#1' : mine ? 'your pick' : '';
    if (tag) txt(k, px + pw + 2, y, tag, correct ? tk.text : tk.text3, { a: done });
  });
  const qy = r.y + n * rowGap + 1;
  const right = s.state.guess === data.answer;
  const winner = data.options[data.answer]!;
  const quip = s.state.guess === -1 ? `It was ${winner.name}.` : right ? 'Nailed it. You know yourself.' : `Not quite. It was ${winner.name}.`;
  const qa = s.caps.motion ? seg(tg, 800, 300) : 1;
  if (qy < r.y + r.h) txt(k, r.x, qy, quip, tk.text, { bold: true, a: qa });
  if (data.after && qy + 2 < r.y + r.h) {
    const aa = s.caps.motion ? seg(tg, 1100, 400) : 1;
    if (aa < 1) k.busy = true;
    const lines = wrapText(data.after, r.w);
    if (lines.length <= Math.min(2, r.y + r.h - qy - 2)) lines.forEach((line, i) => txt(k, r.x, qy + 2 + i, line, tk.text2, { a: aa }));
  }
}

/* ── face-off ── */

function panel(k: K, g: Gauge, side: 'best' | 'worst', r: Rect, delay: number): void {
  const { tk, L, s } = k;
  const a = fade(k, delay, 350);
  const unit = side === 'best' ? 'thank-yous / 100 prompts' : 'swears / 100 prompts';
  label(k, r.x, r.y, side === 'best' ? 'favourite' : 'nemesis', a);
  txt(k, r.x, r.y + 1, g.label, tk.text, { bold: true, a }, r.w);
  const vw = txt(k, r.x, r.y + 3, g.per100.toFixed(1), tk.text, { bold: true, a });
  txt(k, r.x + vw + 1, r.y + 3, unit, tk.text2, { a }, r.w - vw - 1);
  const max = Math.max(g.per100, g.expected ?? 0) * 1.25 || 1;
  const bw = Math.max(8, Math.min(r.w - 2, 40));
  meter(k, r.x, r.y + 4, bw, g.per100 / max, tk.text, delay + 250);
  if (g.expected !== null) {
    const ex = r.x + Math.min(bw - 1, Math.round((g.expected / max) * bw));
    const done = s.caps.motion ? (s.t > delay + 900 ? 1 : 0) : 1;
    if (done) {
      k.c.put(ex, r.y + 4, k.uni ? '┃' : '|', tk.text2, tk.bg, 0);
      const t = `others ${g.expected.toFixed(1)}`;
      txt(k, Math.min(ex, r.x + r.w - textWidth(t)), r.y + 5, t, tk.text3);
    } else k.busy = true;
  }
  if (g.ratio === null || r.h < 8) return;
  const ra = fade(k, delay + 700, 350);
  const ratio = `${g.ratio.toFixed(1)}×`;
  const opts = k.uni ? fitDisplay(ratio, Math.floor(r.w / 2), { face: tk.face, tall: L && r.h >= 13 }) : null;
  const ry = r.y + 7;
  if (opts && ry + displayHeight(opts) <= r.y + r.h + 1) {
    drawDisplay(k.c, r.x, ry, ratio, fadeIn(tk, tk.text, ra), tk.bg, opts);
    const tx = r.x + displayWidth(ratio, opts) + 3;
    txt(k, tx, ry, side === 'best' ? 'nicer than' : 'harsher than', tk.text2, { a: ra }, r.x + r.w - tx);
    txt(k, tx, ry + 1, 'to the others', tk.text2, { a: ra }, r.x + r.w - tx);
  } else txt(k, r.x, ry, `${ratio} vs the others`, tk.text, { bold: true, a: ra });
}

/** Every model's observed rate next to what the others got in the same months. */
function compareChart(k: K, data: Data<'faceoff'>, r: Rect): void {
  const { tk } = k;
  const a = fade(k, 400, 350);
  label(k, r.x, r.y, data.compareUnit, a, r.w);
  const max = Math.max(1e-9, ...data.compare.flatMap(m => [m.observed, m.expected ?? 0]));
  const nameW = Math.min(16, Math.max(...data.compare.map(m => textWidth(m.label))) + 2);
  const barW = Math.max(8, r.w - nameW - 7);
  data.compare.forEach((m, i) => {
    const y = r.y + 2 + i * 2;
    if (y >= r.y + r.h) return;
    txt(k, r.x, y, m.label, m.highlight ? tk.text : tk.text2, { bold: m.highlight, a }, nameW - 1);
    meter(k, r.x + nameW, y, barW, m.observed / max, m.highlight ? tk.text : tk.bar, 500 + i * 90);
    if (m.expected !== null) k.c.put(r.x + nameW + Math.min(barW - 1, Math.round(barW * (m.expected / max))), y, k.uni ? '┃' : '|', tk.text2, tk.bg, 0);
    txt(k, r.x + nameW + barW + 1, y, m.observed.toFixed(1), m.highlight ? tk.text : tk.text2, { a });
  });
  const ly = r.y + 3 + data.compare.length * 2;
  if (ly < r.y + r.h) txt(k, r.x, ly, `${k.uni ? '┃' : '|'} what the other models got in the same months`, tk.text3, { a: fade(k, 1000, 300) }, r.w);
}

export function faceoffBody(k: K, data: Data<'faceoff'>, r: Rect): void {
  const { L, s } = k;
  const both = data.best && data.worst;
  const compare = !both && data.compare.length >= 2 && r.w >= 90;
  const gap = both || compare ? (L ? 10 : 6) : 0;
  const pw = both || compare ? Math.floor((r.w - gap) / 2) : r.w;
  const y = r.y + Math.max(0, Math.floor((r.h - 12) / 3));
  const ph = Math.min(r.h - (y - r.y), 13);
  if (data.best) panel(k, data.best, 'best', { x: r.x, y, w: pw, h: ph }, 80);
  if (data.worst) panel(k, data.worst, 'worst', { x: r.x + (both ? pw + gap : 0), y, w: pw, h: ph }, both ? 260 : 80);
  if (compare) compareChart(k, data, { x: r.x + pw + gap, y, w: r.w - pw - gap, h: ph });
  if (both || compare) vrule(k, r.x + pw + Math.floor(gap / 2), y, Math.min(ph, 10), fade(k, 450, 400));
  if (s.caps.motion && s.t < 1900) k.busy = true;
}
