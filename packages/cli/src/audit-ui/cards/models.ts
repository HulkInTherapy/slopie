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
  return k.c.text(x, y, ` ${text} `, { fg: fadeIn(k.tk, k.tk.accentHi, a), bg: fadeIn(k.tk, k.tk.barSoft, a), bold: true });
}

export function guessBody(k: K, data: Data<'guess'>, r: Rect): void {
  const { tk, s } = k;
  const n = data.options.length;
  if (s.state.guess === undefined) {
    const cols = 1;
    const gap = 6;
    const colW = r.w;
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
  const tagW = 18;
  const barW = Math.max(6, r.w - nameW - 7 - tagW);
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
    txt(k, r.x, y, option.name, correct ? tk.text : tk.text2, { bold: true }, nameW - 1);
    meter(k, r.x + nameW, y, barW, (option.share / max) * g, correct ? tk.accent : tk.accentLo);
    const done = s.caps.motion ? seg(tg, 700, 300) : 1;
    const pct = `${Math.round(option.share * 100)}%`;
    const px = r.x + nameW + barW + 2;
    const pw = txt(k, px, y, pct.padStart(4), tk.text, { bold: true, a: done });
    const tag = correct ? 'correct' : mine ? 'your pick' : '';
    if (tag) txt(k, px + pw + 2, y, tag, correct ? tk.accentHi : tk.text3, { bold: correct, a: done });
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
  const { tk, L } = k;
  const a = fade(k, delay, 350);
  const unit = side === 'best' ? 'thank-yous' : 'swears';
  label(k, r.x, r.y, side === 'best' ? 'favourite' : 'nemesis', a);
  txt(k, r.x, r.y + 1, g.label, tk.text, { bold: true, a }, r.w);
  const ra = fade(k, delay + 400, 350);
  const ink = side === 'best' ? tk.text : tk.accentHi;
  const ratio = g.ratio !== null ? `${g.ratio.toFixed(1)}×` : g.per100.toFixed(1);
  const opts = k.uni ? fitDisplay(ratio, r.w, { face: tk.face, tall: L && r.h >= 12, currency: tk.accentHi }) : null;
  const ry = r.y + 3;
  if (opts) drawDisplay(k.c, r.x, ry, ratio, fadeIn(tk, ink, ra), tk.bg, opts);
  else txt(k, r.x, ry, ratio, ink, { bold: true, a: ra });
  const cy = ry + (opts ? displayHeight(opts) : 1) + 1;
  const caption = g.ratio !== null
    ? `${side === 'best' ? 'nicer' : 'harsher'} than to the others · ${g.per100.toFixed(1)} ${unit} / 100`
    : `${unit} per 100 prompts`;
  if (cy < r.y + r.h + 1) txt(k, r.x, cy, caption, tk.text2, { a: ra }, r.w);
}

/** The eras as one full-width segmented bar, 2 rows tall: indigo tints by recency, the current model in the accent. */
function erasStrip(k: K, eras: { month: string; label: string }[], r: Rect): number {
  const { tk } = k;
  const segs: { label: string; n: number }[] = [];
  for (const e of eras) { const last = segs.at(-1); if (last && last.label === e.label) last.n++; else segs.push({ label: e.label, n: 1 }); }
  const latest = segs.at(-1)!.label;
  const older = [...new Set(segs.map(x => x.label).filter(l => l !== latest))];
  const tints = [tk.accentLo, tk.accentMid, tk.accentHi];
  const inkOf = (lab: string) => (lab === latest ? tk.accent : tints[Math.max(0, tints.length - older.length + older.indexOf(lab))] ?? tk.accentLo);
  const g = k.s.caps.motion ? seg(k.s.t, 200, 900, easeOutCubic) : 1;
  if (g < 1) k.busy = true;
  let x = r.x;
  const total = eras.length;
  segs.forEach((sg, i) => {
    const w = i === segs.length - 1 ? r.x + r.w - x : Math.max(1, Math.round((sg.n / total) * r.w));
    const shown = Math.max(0, Math.min(w, Math.round(r.x + r.w * g - x)));
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < shown - (i < segs.length - 1 ? 1 : 0); xx++) k.c.put(x + xx, r.y + yy, k.uni ? '█' : '#', inkOf(sg.label), tk.bg, 0);
    const cur = sg.label === latest && i === segs.length - 1;
    if (textWidth(sg.label) <= w - 1) txt(k, x, r.y + 3, sg.label, cur ? tk.text : tk.text2, { bold: cur, a: fade(k, 1000, 300) });
    x += w;
  });
  return 5;
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
    meter(k, r.x + nameW, y, barW, m.observed / max, m.highlight ? tk.accent : tk.accentLo, 500 + i * 90);
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
  const stripH = data.eras.length >= 2 && r.h >= 18 ? erasStrip(k, data.eras, { x: r.x, y: r.y + 1, w: r.w, h: 2 }) + 2 : 0;
  const y = r.y + stripH + Math.max(0, Math.floor((r.h - stripH - 10) / 3));
  const ph = Math.min(r.h - (y - r.y), 13);
  if (data.best) panel(k, data.best, 'best', { x: r.x, y, w: pw, h: ph }, 80);
  if (data.worst) panel(k, data.worst, 'worst', { x: r.x + (both ? pw + gap : 0), y, w: pw, h: ph }, both ? 260 : 80);
  if (compare) compareChart(k, data, { x: r.x + pw + gap, y, w: r.w - pw - gap, h: ph });
  if (both || compare) vrule(k, r.x + pw + Math.floor(gap / 2), y, Math.min(ph, 9), fade(k, 450, 400));
  if (s.caps.motion && s.t < 1900) k.busy = true;
}
