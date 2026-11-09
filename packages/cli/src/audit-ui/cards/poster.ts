/**
 * The final board (and the share card): one page on one grid.
 *
 *   slopie audit                                         Dec 2, 2025 → Oct 8, 2026  ·  NSRH
 *   ───────────────────────────────────────────────────────────────────────────────────────
 *   THIS YEAR YOU'VE BEEN
 *   [ THE ARCHETYPE, display face ]
 *   Epic  with a streak of …                                           “tagline”
 *   ───────────────────────────────────────────────────────────────────────────────────────
 *   At API prices          Prompts      Days        Catchphrase
 *   [ $6,413 ]             2,904        176         “real quick” ×212
 *                          Your day ▁▁▂▃▅█▇…  11 PM angriest · 9 AM calmest
 *   ───────────────────────────────────────────────────────────────────────────────────────
 *   MANNERS                CHARACTER ARC              PRICIEST SENTENCE
 *   6 f-bombs per …        swearing went 2.6% → 23%   $412, 330× your median prompt
 *   ───────────────────────────────────────────────────────────────────────────────────────
 *   Didn't Miss a Day      Middle Management          …
 *
 * Fitting drops whole pieces (never cuts a line), then wins back what still fits.
 * Motion: the page prints in top to bottom, then the diagrams grow and the price counts the last
 * stretch up from 80%. With motion off the clock is Infinity, which is exactly the last frame.
 */
import { count, hourLabel } from '../format.js';
import { mix } from '../gfx/color.js';
import { clamp01, easeOutCubic, seg } from '../gfx/motion.js';
import type { BoardSummary } from '../story/board-data.js';
import { factText, posterOrder, type FactPart, type FunFact } from '../story/fun-facts.js';
import type { Scene } from './scene.js';
import { meter, spark } from '../theme/charts.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from '../theme/display.js';
import { begin, chip, footer, header, heroScale, label, rule, strokeNum, textWidth, txt, txtRight, type K } from '../theme/kit.js';
import { vbar } from '../gfx/draw.js';
import { drawTitle, planTitle } from '../theme/title.js';

export const INSTALL = 'npx slopie audit';
export const MEMORY_LINE = 'your agents forget. slopie remembers';

/** Entry timing (ms): the page prints in top to bottom, then the diagrams grow one after another. */
export const PRINT_MS = 900;
export const DIAG_AT = 950;
const DIAG_STEP = 110;
const DIAG_DUR = 650;
/** By this time every animation has landed (the reduced-motion frame equals this frame). */
export const SETTLED_MS = DIAG_AT + DIAG_STEP * 8 + DIAG_DUR;
/** The price counter starts at this fraction of the final value, so no frame ever says "$0". */
export const COUNT_FROM = 0.8;

/** "$6,413" mid-count: the value at progress k (0..1), counting up from COUNT_FROM of the total. */
export function countUp(value: string, k: number): string {
  if (k >= 1 || !/^\$[\d,]+$/.test(value)) return value;
  const target = Number(value.replace(/[^\d]/g, ''));
  if (!(target > 0)) return value;
  const n = Math.max(1, Math.round(target * (COUNT_FROM + (1 - COUNT_FROM) * clamp01(k))));
  return `$${n.toLocaleString('en-US')}`;
}

const TIER: Record<string, string> = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

interface Piece { h: number; draw: (y: number) => void; rule?: boolean; /** Wants a blank row above it. */ air?: boolean }

interface Plan { label: boolean; bigTitle: boolean; tagline: boolean; bigPrice: boolean; day: boolean; diagrams: boolean; nFacts: number; factGap: boolean; awards: boolean; memory: boolean; ticker: boolean }

const STEPS: ((p: Plan) => void)[] = [
  p => { p.factGap = false; },
  p => { p.memory = false; },
  p => { p.label = false; },
  p => { p.diagrams = false; },
  p => { p.day = false; },
  p => { p.tagline = false; },
  p => { p.awards = false; },
  p => { p.ticker = false; },
  p => { p.bigPrice = false; },
  p => { p.bigTitle = false; },
  // The six core facts are the poster: they go last, two at a time.
  p => { p.nFacts = 4; },
  p => { p.nFacts = 2; },
];

export function posterBody(s: Scene, d: BoardSummary): boolean {
  const k = begin(s);
  const meta = [d.range, d.code].filter(Boolean).join('  ·  ');
  const top = header(k, textWidth(meta) + 14 <= k.iw ? meta : d.code ?? '');
  const footY = boardFooter(k, d);
  // One quiet row above the footer.
  const avail = footY - 2 - top;
  const plan: Plan = { label: true, bigTitle: true, tagline: true, bigPrice: true, day: true, diagrams: true, nFacts: 6, factGap: true, awards: true, memory: true, ticker: !!d.sinceLast && !s.share };
  let pieces = build(k, d, plan);
  for (const step of STEPS) { if (height(pieces, k.L) <= avail) break; step(plan); pieces = build(k, d, plan); }
  // Then win back what still fits, most important first.
  const RESTORE: (keyof Plan)[] = ['bigTitle', 'ticker', 'bigPrice', 'tagline', 'awards', 'day', 'diagrams', 'factGap', 'label', 'memory'];
  for (const key of RESTORE) {
    if (plan[key] === true || (key === 'ticker' && (!d.sinceLast || s.share))) continue;
    const next = { ...plan, [key]: true } as Plan;
    const tried = build(k, d, next);
    if (height(tried, k.L) <= avail) { Object.assign(plan, next); pieces = tried; }
  }
  // Spare rows become air around the hairlines (at most 2 extra each), then the rest goes on top.
  let spare = Math.max(0, avail - height(pieces, k.L));
  const extra = new Array<number>(pieces.length).fill(0);
  for (let pass = 0; pass < 2 && spare > 0; pass++) for (let i = 1; i < pieces.length && spare > 0; i++) if (pieces[i]!.rule || pieces[i - 1]!.rule) { extra[i]!++; spare--; }
  let y = top + 1 + Math.floor(spare / 3);
  pieces.forEach((p, i) => { if (i) y += (k.L ? 1 : gapOf(p, pieces[i - 1]!)) + extra[i]!; p.draw(y); y += p.h; });
  printIn(k);
  return k.busy;
}

/** The print-in: each row fades up from the background, top to bottom, over PRINT_MS. */
function printIn(k: K): void {
  if (!k.s.caps.motion || k.s.t >= PRINT_MS + 220) return;
  k.busy = true;
  const { c } = k;
  for (let y = 0; y < c.h; y++) {
    const a = seg(k.s.t, (y / c.h) * PRINT_MS, 220, easeOutCubic);
    if (a >= 1) continue;
    for (let x = 0; x < c.w; x++) {
      const i = y * c.w + x;
      if (a <= 0) { c.ch[i] = ' '; c.fg[i] = k.tk.text; c.bg[i] = k.tk.bg; c.at[i] = 0; continue; }
      if (c.fg[i]! >= 0) c.fg[i] = mix(k.tk.bg, c.fg[i]!, a);
      if (c.bg[i]! >= 0 && c.bg[i] !== k.tk.bg) c.bg[i] = mix(k.tk.bg, c.bg[i]!, a);
    }
  }
}

/** Growth of diagram `i` (0..1; 1 with motion off). */
function grow(k: K, i: number): number {
  if (!k.s.caps.motion) return 1;
  const g = seg(k.s.t, DIAG_AT + i * DIAG_STEP, DIAG_DUR, easeOutCubic);
  if (g < 1) k.busy = true;
  return g;
}

const gapOf = (p: Piece, prev: Piece) => (p.rule || prev.rule || p.air ? 1 : 0);
function height(ps: Piece[], L: boolean): number {
  return ps.reduce((a, p, i) => a + p.h + (i ? (L ? 1 : gapOf(p, ps[i - 1]!)) : 0), 0);
}

function build(k: K, d: BoardSummary, p: Plan): Piece[] {
  const out: Piece[] = [];
  const hr = (): Piece => ({ h: 1, rule: true, draw: y => rule(k, k.mx, y, k.iw) });
  out.push(...identity(k, d, p));
  out.push(hr());
  out.push(heroBand(k, d, p));
  const facts = factsPiece(k, d, p);
  if (facts) { out.push(hr()); out.push(facts); }
  const awards = p.awards ? awardsPiece(k, d, facts?.shown ?? []) : null;
  if (awards) { out.push(hr()); out.push(awards); }
  if (p.ticker && d.sinceLast) {
    const line = tickerPiece(k, d.sinceLast);
    if (line) out.push({ ...line, air: true });
  }
  if (p.memory) out.push({ ...memoryPiece(k), air: !(p.ticker && d.sinceLast) });
  return out;
}

/* ── identity: label, title, tier, tagline ───────────────────────────────── */

function identity(k: K, d: BoardSummary, p: Plan): Piece[] {
  const { tk, mx, iw } = k;
  const out: Piece[] = [];
  const title = d.archetype ?? 'Your year with agents';
  if (p.label) out.push({ h: 1, draw: y => label(k, mx, y, 'this year you’ve been', 1, Infinity, tk.accentHi) });
  const plan = p.bigTitle ? planTitle(k, title, iw, 1) : { lines: [title], big: false, h: 1, w: textWidth(title), face: tk.face };
  out.push({ h: plan.h, draw: y => drawTitle(k, mx, y, plan, tk.text) });
  const tag = p.tagline && d.tagline && (!k.s.share || d.taglinePublic) ? `“${d.tagline}”` : null;
  const tier = d.tier ? TIER[d.tier]! : null;
  const sub = d.subRole;
  const lineW = (tier ? textWidth(tier) + 4 : 0) + (sub ? textWidth(sub) : 0);
  const tagRight = !!tag && lineW + 4 + textWidth(tag) <= iw;
  out.push({
    air: plan.big,
    h: tag && !tagRight && textWidth(tag) <= iw ? 2 : 1,
    draw: y => {
      let x = mx;
      if (tier) x += chip(k, x, y, tier.toUpperCase(), tk.accent) + 2;
      if (sub && x + textWidth(sub) <= mx + iw) txt(k, x, y, sub, tk.text);
      if (tag && tagRight) txtRight(k, mx + iw, y, tag, tk.accentHi, { italic: true });
      else if (tag && textWidth(tag) <= iw) txt(k, mx, y + 1, tag, tk.accentHi, { italic: true });
    },
  });
  return out;
}

/* ── hero band: the price, three small stats, your day ───────────────────── */

function heroBand(k: K, d: BoardSummary, p: Plan): Piece {
  const { tk, mx, iw, L } = k;
  const price = d.heroes.find(h => h.label === 'at API prices');
  const half = Math.floor(iw / 2);
  const fit = price && k.uni ? fitDisplay(price.value, (L ? (k.s.big ? 60 : 40) : half) - 2, { face: tk.face, tall: L, currency: tk.accentHi, scale: heroScale(k) }) : null;
  const opts = fit ?? { face: tk.face };
  const leftW = L ? Math.max(40, (fit ? displayWidth(price!.value, fit) : 0) + 6) : Math.max(30, Math.min(half, (fit ? displayWidth(price!.value, fit) : 26) + 4));
  const big = p.bigPrice && !!fit;
  const priceH = big ? 1 + displayHeight(opts) : 2;
  // Small stats to the right of the price.
  const stats: { label: string; value: string; quote?: boolean }[] = [];
  for (const key of ['prompts', 'days'] as const) {
    const h = d.heroes.find(x => (key === 'days' ? x.label === 'days' || x.label === 'day' : x.label === 'prompts'));
    if (h) stats.push({ label: key === 'days' ? 'DAYS' : 'PROMPTS', value: h.value });
  }
  // The share card keeps none of the user's phrases.
  if (d.catchphrase && !k.s.share) stats.push({ label: 'CATCHPHRASE', value: `“${d.catchphrase.phrase}” ×${count(d.catchphrase.count)}`, quote: true });
  const rx = mx + leftW;
  const rw = iw - leftW;
  // Stats sit on their own content widths, spread across the room they have.
  // The two numbers one size up, in the stroke face, when they fit.
  const rw0 = iw - leftW;
  const widthsOf = (stroke: boolean) => stats.map(st => Math.max(stroke && !st.quote ? displayWidth(st.value, { face: 'heavy' }) : textWidth(st.value), textWidth(st.label)));
  // Only when every stat (the catchphrase too) still fits beside the price.
  const strokeOk = k.uni && L && widthsOf(true).reduce((a, b) => a + b, 0) + 4 * (stats.length - 1) <= rw0;
  const widths = widthsOf(strokeOk);
  let fits = stats;
  while (fits.length && widths.slice(0, fits.length).reduce((a, b) => a + b, 0) + 4 * (fits.length - 1) > rw) fits = fits.slice(0, -1);
  const used = widths.slice(0, fits.length).reduce((a, b) => a + b, 0);
  const gapW = fits.length > 1 ? Math.min(12, Math.floor((rw - used) / (fits.length - 1))) : 0;
  const xs = fits.map((_, i) => rx + widths.slice(0, i).reduce((a, b) => a + b, 0) + gapW * i);
  const clock = d.viz.clock;
  const dayOk = p.day && !!clock && k.uni && rw >= 30;
  const statH = strokeOk ? 4 : 2;
  const rightH = statH + (dayOk ? 5 : 0);
  return {
    h: Math.max(priceH, rightH),
    draw: y => {
      if (price) {
        txt(k, mx, y, 'AT API PRICES', tk.text3);
        // Counts the last 20% up once printed (never "$0"); right-aligned so it never jitters.
        const shown = countUp(price.value, grow(k, 0));
        if (big) drawDisplay(k.c, mx + displayWidth(price.value, opts) - displayWidth(shown, opts), y + 1, shown, tk.text, tk.bg, opts);
        else txt(k, mx + textWidth(price.value) - textWidth(shown), y + 1, shown, tk.text, { bold: true });
      }
      fits.forEach((st, i) => {
        const x = xs[i]!;
        txt(k, x, y, st.label, tk.text3);
        if (strokeOk && !st.quote) strokeNum(k, x, y + 1, st.value, tk.text);
        else txt(k, x, y + 1, st.value, tk.text, { bold: !st.quote, italic: st.quote });
      });
      if (dayOk && clock) {
        const yy = y + statH + 2;
        const per = rw >= 70 ? 2 : 1;
        txt(k, rx, yy - 1, 'YOUR DAY', tk.text3);
        // A 2-row strip: hours in the low tint, the angriest in the accent, the calmest in primary.
        const max = Math.max(1e-9, ...clock.hours);
        const g = grow(k, 1);
        clock.hours.forEach((v, h) => {
          const ink = h === clock.angry ? tk.accent : h === clock.saint ? tk.text : tk.accentLo;
          vbar(k.c, rx + h * per, yy + 1, 2, Math.max(0.12, (v / max) * g), ink, per, !k.uni);
        });
        const w = clock.hours.length * per;
        for (const [h, l] of [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']] as const) txt(k, rx + h * per, yy + 2, l, tk.text3);
        const lx = rx + w + 3;
        if (lx + 18 <= mx + iw) {
          const aw = txt(k, lx, yy, hourLabel(clock.angry), tk.accentHi, { bold: true });
          txt(k, lx + aw + 1, yy, 'angriest', tk.text2);
          const sw = txt(k, lx, yy + 1, hourLabel(clock.saint), tk.text, { bold: true });
          txt(k, lx + sw + 1, yy + 1, 'calmest', tk.text2);
        }
      }
    },
  };
}

/* ── facts: a grid of label + statement (+ a quiet diagram) ──────────────── */

function partsFit(f: FunFact, w: number): FactPart[] | null {
  return textWidth(factText(f.parts)) <= w ? f.parts : f.short && textWidth(factText(f.short)) <= w ? f.short : null;
}

function drawParts(k: K, x: number, y: number, parts: readonly FactPart[]): void {
  let cx = x;
  for (const part of parts) cx += txt(k, cx, y, part.text, k.tk.text, { bold: part.tone === 'num', italic: part.tone === 'quote' });
}

function factsPiece(k: K, d: BoardSummary, p: Plan): (Piece & { shown: FunFact[] }) | null {
  const { mx, iw } = k;
  if (p.nFacts <= 0) return null;
  const cols = iw >= 100 ? 3 : iw >= 60 ? 2 : 1;
  const gap = 3;
  const colW = Math.floor((iw - gap * (cols - 1)) / cols);
  const exclude = [...(d.catchphrase ? ['catchphrase'] : []), ...(d.viz.clock ? ['mood_hours'] : [])];
  const picks: { f: FunFact; parts: FactPart[] }[] = [];
  const fam = new Map<string, number>();
  for (const f of posterOrder(d.facts, exclude)) {
    if (picks.length >= p.nFacts) break;
    if ((fam.get(f.family) ?? 0) >= 2) continue;
    const parts = partsFit(f, colW);
    if (!parts || textWidth(f.label) > colW) continue;
    fam.set(f.family, (fam.get(f.family) ?? 0) + 1);
    picks.push({ f, parts });
  }
  if (!picks.length) return null;
  const rows = Math.ceil(picks.length / cols);
  // Spaced: label, blank, sentence, blank, bar; two blank rows between rows of facts.
  const air = p.factGap ? 1 : 0;
  const cellH = 2 + air + (p.diagrams ? 1 + air : 0);
  const rowGap = p.factGap ? 2 : 0;
  return {
    shown: picks.map(x => x.f),
    h: rows * cellH + (rows - 1) * rowGap,
    draw: y0 => picks.forEach(({ f, parts }, i) => {
      const x = mx + (i % cols) * (colW + gap);
      const y = y0 + Math.floor(i / cols) * (cellH + rowGap);
      txt(k, x, y, f.label.toUpperCase(), k.tk.accentHi, { bold: true });
      drawParts(k, x, y + 1 + air, parts);
      if (p.diagrams) diagram(k, d, f, x, y + 2 + air * 2, colW, 2 + i);
    }),
  };
}

/** A one-row diagram under a fact, when its numbers are known. */
function diagram(k: K, d: BoardSummary, f: FunFact, x: number, y: number, w: number, i: number): void {
  const { tk } = k;
  const v = d.viz;
  if (!k.uni) return;
  const start = DIAG_AT + i * DIAG_STEP;
  switch (f.id) {
    case 'manners': {
      const m = v.manners;
      if (!m) return;
      const l = count(m.thanks), r = count(m.rude);
      const bw = Math.min(w - textWidth(l) - textWidth(r) - 2, 28);
      if (bw < 6) return;
      txt(k, x, y, l, tk.text2);
      const nice = Math.max(1, Math.round((bw * m.thanks) / (m.thanks + m.rude)));
      meter(k, x + textWidth(l) + 1, y, nice, 1, tk.accentLo, start);
      meter(k, x + textWidth(l) + 1 + nice, y, bw - nice, 1, tk.accent, start + 150);
      txt(k, x + textWidth(l) + 1 + bw + 1, y, r, tk.text2);
      return;
    }
    case 'mood_drift': {
      const a = v.arc;
      if (!a) return;
      const per = Math.max(1, Math.min(2, Math.floor((w - textWidth(a.from) - textWidth(a.to) - 2) / a.pcts.length)));
      if (textWidth(a.from) + textWidth(a.to) + 2 + per * a.pcts.length > w) return;
      txt(k, x, y, a.from, tk.text3);
      const max = a.pcts.indexOf(Math.max(...a.pcts));
      const sw = spark(k, x + textWidth(a.from) + 1, y, a.pcts, per, tk.accentLo, max, start, tk.accent);
      txt(k, x + textWidth(a.from) + 1 + sw + 1, y, a.to, tk.text3);
      return;
    }
    case 'longest_sit': {
      const h = v.sit;
      if (!h) return;
      const bw = Math.min(w - 4, 24);
      meter(k, x, y, bw, Math.min(1, h / 12), tk.accent, start);
      txt(k, x + bw + 1, y, '12h', tk.text3);
      return;
    }
    default:
      return;
  }
}

/* ── awards, ticker, memory line, footer ─────────────────────────────────── */

function awardsPiece(k: K, d: BoardSummary, shown: FunFact[]): Piece | null {
  const { tk, mx, iw } = k;
  const covered = new Set([...shown.flatMap(f => f.awards), ...(d.catchphrase ? ['verbal_tics', 'catchphrase'] : [])]);
  const cols = iw >= 100 ? 3 : 2;
  const gap = 3;
  const colW = Math.floor((iw - gap * (cols - 1)) / cols);
  const list = d.awards.filter(a => !a.id || !covered.has(a.id)).filter(a => textWidth(a.title) + textWidth(a.tier) + 3 <= colW).slice(0, cols);
  if (!list.length) return null;
  return {
    h: 2,
    draw: y => list.forEach((aw, i) => {
      const x = mx + i * (colW + gap);
      const value = k.s.share ? aw.publicValue : aw.value;
      const sub = (k.s.share ? aw.publicSub : aw.sub) ?? '';
      const cw = chip(k, x, y, aw.tier.toUpperCase(), aw.tier === 'gold' ? tk.accent : aw.tier === 'silver' ? tk.bar : tk.barSoft, aw.tier === 'gold' ? tk.bg : tk.text) + 1;
      txt(k, x + cw, y, aw.title, tk.text, { bold: true }, colW - cw);
      const line = sub && textWidth(`${value}  ·  ${sub}`) <= colW - cw ? `${value}  ·  ${sub}` : value;
      if (textWidth(line) <= colW - cw) txt(k, x + cw, y + 1, line, tk.text2);
    }),
  };
}

/** "SINCE LAST RUN  +412 prompts …" (re-runs only; never on the share card). */
function tickerPiece(k: K, since: string): Piece | null {
  const lead = 'SINCE LAST RUN  ';
  if (textWidth(lead + since) > k.iw) return null;
  return {
    h: 1,
    draw: y => {
      let x = k.mx + txt(k, k.mx, y, lead, k.tk.text3);
      // Deltas (+41, +$117, 3.6% → 4.8%) in the light accent.
      for (const w of since.split(/(\s+)/).filter(Boolean)) x += txt(k, x, y, w, /\d/.test(w) ? k.tk.accentHi : k.tk.text2, { bold: /\d/.test(w) });
    },
  };
}

function memoryPiece(k: K): Piece {
  const { tk, mx } = k;
  return {
    h: 1,
    draw: y => {
      const w = txt(k, mx, y, `${MEMORY_LINE}. `, tk.text3);
      txt(k, mx + w, y, `${k.uni ? '→' : '->'} slopie setup`, tk.text2);
    },
  };
}

function boardFooter(k: K, d: BoardSummary): number {
  const { tk, s } = k;
  const local = s.online ? 'online · Jev' : 'all local';
  const right: [string, number][] = [[INSTALL, tk.text], ['   ', tk.text3], [k.uni ? '●' : '*', tk.accent], [' ' + local, tk.text3]];
  if (s.share) return footer(k, { keys: [['slopie', 'audit']], right });
  return footer(k, { keys: [[k.uni ? '←' : '<', d.replay ? 'replay your story' : 'story'], ['s', 'share'], ['?', 'how'], ['q', 'quit']], right });
}
