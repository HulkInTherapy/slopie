/**
 * The final board as a personality poster: the one screen people screenshot.
 *
 * Few elements, big type, lots of air: the archetype title, the rarity badge, one tagline,
 * Slopie, at most three hero numbers, four to six fun facts (ranked by `fun-facts.ts`), at
 * most three trophies and a quiet footer. Everything else lives on the story cards.
 *
 * Three layouts share one fitting rule: a smaller screen drops whole elements (trophies,
 * facts, Slopie, the big type) and never cuts a line short. Nothing is drawn with an ellipsis.
 *
 *   A  poster   centred title, three big numbers, two columns of facts   (default)
 *   B  card     a framed trading card with stat chips and ability lines
 *   C  receipt  a paper receipt with dot leaders and a barcode
 *
 * The variant is an internal flag: SLOPIE_BOARD_VARIANT=A|B|C.
 */
import type { Canvas } from '../gfx/canvas.js';
import { C, fade, hx, mix, type Rgb } from '../gfx/color.js';
import { box, spaced, textWidth } from '../gfx/draw.js';
import { bigHeight, bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import { drawMascot } from '../mascot.js';
import type { BoardSummary } from '../story/board-data.js';
import { factText, type FactPart, type FunFact } from '../story/fun-facts.js';
import type { Scene } from './scene.js';

export type Variant = 'A' | 'B' | 'C';
export const DEFAULT_VARIANT: Variant = 'A';

export function boardVariant(): Variant {
  const v = (process.env['SLOPIE_BOARD_VARIANT'] ?? '').trim().toUpperCase();
  return v === 'B' || v === 'C' ? v : v === 'A' ? 'A' : DEFAULT_VARIANT;
}

export const INSTALL = 'npx slopie audit';
export const MEMORY_LINE = 'your agents forget. slopie remembers';

export const GOLD = hx('ffd27a');
export const SILVER = hx('c8ccd2');
export const BRONZE = hx('d08a4e');
const PAPER = hx('f6efe4');
const PAPER_INK = hx('2a1d14');
const PAPER_FAINT = hx('9a8a7a');

const TIER_LABEL: Record<string, string> = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };

export const tierColor = (tier: BoardSummary['tier']): Rgb =>
  tier === 'legendary' ? GOLD : tier === 'epic' ? C.orange : tier === 'rare' ? C.peach : C.gray;

export const metalColor = (tier: 'gold' | 'silver' | 'bronze'): Rgb => (tier === 'gold' ? GOLD : tier === 'silver' ? SILVER : BRONZE);

/* ── shared model ─────────────────────────────────────────────────────────── */

type Trophy = BoardSummary['awards'][number];

interface Ctx {
  s: Scene;
  c: Canvas;
  d: BoardSummary;
  uni: boolean;
  pixel: boolean;
  busy: boolean;
  alpha: (i: number) => number;
}

function context(s: Scene, d: BoardSummary): Ctx {
  const ctx: Ctx = {
    s, c: s.c, d, uni: s.caps.unicode, pixel: s.caps.color === 'truecolor' || s.caps.color === '256', busy: false,
    alpha: (i: number) => {
      const k = seg(s.t, 60 + i * 110, 360, easeOutCubic);
      if (k < 1) ctx.busy = true;
      return k;
    },
  };
  return ctx;
}

const badgeText = (ctx: Ctx) => (ctx.d.tier ? `${ctx.uni ? '★' : '*'} ${TIER_LABEL[ctx.d.tier]} ${ctx.uni ? '★' : '*'}` : null);

/** The tagline, unless it is the share card and the tagline quotes the user's words. */
function tagline(ctx: Ctx): string | null {
  const t = ctx.d.tagline;
  if (!t) return null;
  if (ctx.s.share && !ctx.d.taglinePublic) return null;
  return t;
}

/** Facts in rank order that fit `width` (full or short wording), ≤ 2 per family. */
function pickFacts(facts: readonly FunFact[], n: number, width: number, labelW = 0): { fact: FunFact; parts: FactPart[] }[] {
  const out: { fact: FunFact; parts: FactPart[] }[] = [];
  const fam = new Map<string, number>();
  for (const fact of facts) {
    if (out.length >= n) break;
    if ((fam.get(fact.family) ?? 0) >= 2) continue;
    const room = width - labelW;
    const parts = textWidth(factText(fact.parts)) <= room ? fact.parts : fact.short && textWidth(factText(fact.short)) <= room ? fact.short : null;
    if (!parts || (labelW === 0 && textWidth(fact.label) > width)) continue;
    fam.set(fact.family, (fam.get(fact.family) ?? 0) + 1);
    out.push({ fact, parts });
  }
  return out;
}

/** Trophies that do not repeat a shown fact, at most `n`. */
function pickTrophies(d: BoardSummary, shown: readonly FunFact[], n: number): Trophy[] {
  const covered = new Set(shown.flatMap(f => f.awards));
  return d.awards.filter(a => !a.id || !covered.has(a.id)).slice(0, n);
}

const trophyValue = (ctx: Ctx, t: Trophy) => (ctx.s.share ? t.publicValue : t.value);
const trophyIcon = (ctx: Ctx, tier: Trophy['tier']) => (ctx.uni ? (tier === 'gold' ? '★' : tier === 'silver' ? '☆' : '✧') : tier === 'gold' ? '*' : tier === 'silver' ? '+' : '-');

function drawParts(ctx: Ctx, x: number, y: number, parts: readonly FactPart[], a: number, paper = false): number {
  let cx = x;
  for (const p of parts) {
    const style = p.tone === 'num' ? { fg: paper ? C.rust : C.orange, bold: true }
      : p.tone === 'name' ? { fg: paper ? PAPER_INK : C.cream, bold: true }
        : p.tone === 'quote' ? { fg: paper ? C.deep : C.peach, italic: true }
          : { fg: paper ? PAPER_INK : mix(C.cream, C.gray, 0.3) };
    cx += ctx.c.text(cx, y, p.text, { ...style, alpha: a, bg: paper ? PAPER : undefined });
  }
  return cx - x;
}

/** The title as block-font lines that fit `width` (null if it cannot). */
function titleLines(title: string, width: number, maxLines: number): string[] | null {
  const words = title.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (bigWidth(next) <= width) line = next;
    else { if (line) lines.push(line); line = word; if (bigWidth(word) > width) return null; }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

/** Plain-text title lines (wrapped on words, never cut). */
function textTitle(title: string, width: number, spacedOut: boolean): string[] | null {
  const words = title.toUpperCase().split(/\s+/);
  const fmt = (s: string) => (spacedOut ? spaced(s) : s);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(fmt(next)) <= width) line = next;
    else { if (line) lines.push(line); line = word; if (textWidth(fmt(word)) > width) return null; }
  }
  if (line) lines.push(line);
  return lines.map(fmt);
}

function titleColor(ctx: Ctx, px: number, py: number, width: number): Rgb {
  if (ctx.d.tier === 'legendary') return mix(mix(C.cream, GOLD, px / Math.max(1, width)), C.orange, py / 8);
  return mix(C.cream, C.orange, py / 4);
}

/** Footer: keys on the left (not on the share card), install + local on the right. */
function footer(ctx: Ctx, y: number, mx: number, paper = false): void {
  const { c, s, d, uni } = ctx;
  const local = s.online ? 'online · Jev' : 'all local';
  const dot = uni ? '●' : '*';
  const right = `${INSTALL}  ·  ${dot} ${local}`;
  const rx = s.w - mx - textWidth(right);
  const faint = paper ? PAPER_FAINT : C.slate;
  let x = mx;
  if (!s.share) {
    const keys: [string, string][] = [[uni ? '←' : '<', d.replay ? 'replay your story' : 'story'], ['s', 'share'], ['?', 'how'], ['q', 'quit']];
    for (const [k, label] of keys) {
      if (x + textWidth(k) + 1 + textWidth(label) + 3 > rx - 2) break;
      x += c.text(x, y, k, { fg: C.gray, bold: true });
      x += 1 + c.text(x + 1, y, label, { fg: faint }) + 3;
    }
  } else {
    c.text(mx, y, 'slopie audit', { fg: C.orange, bold: true });
    x = mx + 14;
  }
  if (rx > x) {
    c.text(rx, y, INSTALL, { fg: C.orange, bold: true });
    c.text(rx + textWidth(INSTALL) + 2, y, '·', { fg: faint });
    c.text(s.w - mx - textWidth(local) - 2, y, dot, { fg: s.online ? C.peach : fade(C.orange, 0.7) });
    c.text(s.w - mx - textWidth(local), y, local, { fg: faint });
  } else if (textWidth(INSTALL) <= s.w - mx * 2) {
    // Too narrow for keys + install: the install line wins.
    c.fill(mx, y, s.w - mx * 2, 1, ' ', { bg: c.bg[y * c.w + mx] });
    c.text(s.w - mx - textWidth(INSTALL), y, INSTALL, { fg: C.orange, bold: true });
  }
}

const memoryText = (uni: boolean) => `${MEMORY_LINE} ${uni ? '→' : '->'} slopie setup`;

function memoryLine(ctx: Ctx, y: number, cx: number | null, x0: number, a: number): void {
  const { c, uni } = ctx;
  const text = memoryText(uni);
  const x = cx === null ? x0 : cx - Math.floor(textWidth(text) / 2);
  const w = c.text(x, y, MEMORY_LINE + ' ', { fg: C.gray, italic: true, alpha: a });
  c.text(x + w, y, (uni ? '→' : '->') + ' slopie setup', { fg: C.peach, alpha: a });
}

/* ── layout fitting ───────────────────────────────────────────────────────── */

interface Block { key: string; h: number; gapBefore: number; draw: (y: number) => void }

/**
 * Stack blocks top to bottom inside [top, bottom): leftover rows are shared out as extra
 * air between blocks (more above the big ones), so a tall screen breathes instead of
 * leaving a hole at the bottom.
 */
function stackBlocks(blocks: Block[], top: number, bottom: number, maxGap = 3): void {
  const need = blocks.reduce((s, b) => s + b.h + b.gapBefore, 0);
  let spare = Math.max(0, bottom - top - need);
  const extra = blocks.map(() => 0);
  // Round-robin one row at a time to every gap after the first block (capped).
  for (let pass = 0; spare > 0 && pass < maxGap; pass++) {
    for (let i = 1; i < blocks.length && spare > 0; i++) { extra[i]!++; spare--; }
  }
  let y = top + Math.floor(spare / 2);
  blocks.forEach((b, i) => { y += b.gapBefore + extra[i]!; b.draw(y); y += b.h; });
}

/* ── variant A: poster ────────────────────────────────────────────────────── */

interface PosterPlan {
  mascot: boolean;
  title: 'big1' | 'big2' | 'text';
  heroBig: boolean;
  factRows: 2 | 1;
  nFacts: number;
  trophyRows: 2 | 1 | 0;
  tagline: boolean;
  memory: boolean;
  ticker: boolean;
  kicker: boolean;
}

export function posterA(s: Scene, d: BoardSummary): boolean {
  const ctx = context(s, d);
  const { c } = ctx;
  const W = s.w, H = s.h;
  const mx = W >= 100 ? 4 : 2;
  const inner = W - mx * 2;
  const cx = Math.floor(W / 2);
  const title = d.archetype ?? 'your year with agents';
  const canBig = ctx.pixel && s.caps.color !== 'none' && bigSupported(title);
  const big1 = canBig ? titleLines(title, inner, 1) : null;
  const big2 = canBig ? titleLines(title, inner, 2) : null;
  const cols = inner >= 96 ? 2 : 1;
  const gutter = cols === 2 ? 10 : 0;
  const colW = cols === 2 ? Math.min(44, Math.floor((inner - gutter) / 2)) : Math.min(inner, 64);
  const factsW = cols * colW + gutter;
  const fx = cx - Math.floor(factsW / 2);
  const tag = tagline(ctx);
  const badge = badgeText(ctx);
  const taglineFits = (t: string | null) => !!t && textWidth(`“${t}”`) + (badge ? textWidth(badge) + 6 : 0) <= inner;
  const taglineOwnLine = (t: string | null) => !!t && textWidth(`“${t}”`) <= inner;
  const heroW = d.heroes.length ? d.heroes.reduce((sum, h) => sum + Math.max(bigWidth(h.value), textWidth(h.label)), 0) + (d.heroes.length - 1) * 8 : 0;
  const heroText = d.heroes.map(h => `${h.value} ${h.label}`).join('   ·   ');
  const heroTextFits = textWidth(heroText) <= inner;
  const heroBigOk = ctx.pixel && d.heroes.length > 0 && heroW <= inner && d.heroes.every(h => bigSupported(h.value));

  const plan: PosterPlan = {
    mascot: ctx.pixel && s.caps.color !== 'none', title: big1 ? 'big1' : big2 ? 'big2' : 'text', heroBig: heroBigOk,
    factRows: 2, nFacts: 6, trophyRows: 2, tagline: !!tag, memory: true, ticker: !!d.sinceLast && !s.share, kicker: true,
  };

  const titleTextLines = () => textTitle(title, inner, inner >= 70) ?? textTitle(title, inner, false) ?? [title.toUpperCase()];
  const titleH = (p: PosterPlan) => (p.title === 'big1' ? 3 : p.title === 'big2' ? bigHeight() * big2!.length + (big2!.length - 1) : titleTextLines().length);
  const identityH = (p: PosterPlan) => (p.kicker ? 2 : 0) + titleH(p) + ((badge || (p.tagline && tag)) ? 2 : 0) + (p.tagline && tag && badge && !taglineFits(tag) && taglineOwnLine(tag) ? 1 : 0);
  const facts = (p: PosterPlan) => pickFacts(d.facts, p.nFacts, colW, p.factRows === 1 ? labelColW + 2 : 0);
  const labelColW = Math.max(0, ...d.facts.map(f => textWidth(f.label)));
  const factsH = (p: PosterPlan) => {
    const n = facts(p).length;
    if (!n) return 0;
    const rows = Math.ceil(n / cols);
    return p.factRows === 2 ? rows * 3 - 1 : rows;
  };
  const trophies = (p: PosterPlan) => (p.trophyRows ? fitTrophies(ctx, pickTrophies(d, facts(p).map(f => f.fact), 3), inner, p.trophyRows) : []);
  const heights = (p: PosterPlan) => {
    const hs: number[] = [];
    if (p.mascot) hs.push(4);
    hs.push(identityH(p));
    if (d.heroes.length && (p.heroBig || heroTextFits)) hs.push(p.heroBig ? 4 : 1);
    const fh = factsH(p);
    if (fh) hs.push(fh);
    if (trophies(p).length) hs.push(p.trophyRows);
    // Bottom: ticker / memory line / footer, packed together.
    return { body: hs.reduce((a, b) => a + b, 0) + Math.max(0, hs.length - 1), blocks: hs.length };
  };
  const bottomH = (p: PosterPlan) => 1 + (p.memory ? 1 : 0) + (p.ticker ? 1 : 0);
  const fits = (p: PosterPlan) => (H >= 30 ? 1 : 0) + heights(p).body + 1 + bottomH(p) <= H;

  // Degrade one element at a time until the poster fits. Whole elements go; nothing is cut.
  const steps: ((p: PosterPlan) => void)[] = [
    p => { p.ticker = false; },
    p => { p.trophyRows = p.trophyRows === 2 ? 1 : p.trophyRows; },
    p => { p.mascot = false; },
    p => { p.factRows = 1; },
    p => { p.heroBig = false; },
    p => { if (p.title === 'big2') p.title = 'text'; },
    p => { p.trophyRows = 0; },
    p => { p.kicker = false; },
    p => { p.nFacts = 5; },
    p => { p.nFacts = 4; },
    p => { p.memory = false; },
    p => { p.tagline = false; },
    p => { p.title = 'text'; },
    p => { p.nFacts = 3; },
    p => { p.nFacts = 2; },
  ];
  for (const step of steps) { if (fits(plan)) break; step(plan); }

  const blocks: Block[] = [];
  let ai = 0;
  if (plan.mascot) {
    const a = ctx.alpha(ai++);
    blocks.push({ key: 'mascot', h: 4, gapBefore: 0, draw: y => { if (a > 0.05) drawMascot(c, cx - 5, y, s.blink ? 'blink' : s.t < 1200 ? 'waving' : 'proud', { size: 'compact' }); } });
  }
  {
    const a = ctx.alpha(ai++);
    blocks.push({
      key: 'identity', h: identityH(plan), gapBefore: blocks.length ? 1 : 0, draw: y0 => {
        let y = y0;
        if (plan.kicker) {
          const k = inner >= 60 ? spaced("this year you've been") : "THIS YEAR YOU'VE BEEN";
          c.text(cx - Math.floor(textWidth(k) / 2), y, k, { fg: C.gray, alpha: a });
          y += 2;
        }
        if (plan.title === 'big1' || plan.title === 'big2') {
          const lines = plan.title === 'big1' ? big1! : big2!;
          for (const line of lines) {
            const w = bigWidth(line);
            drawBig(c, cx - Math.floor(w / 2), y, line, { color: (px, py) => fade(titleColor(ctx, px, py, w), a) });
            y += bigHeight() + 1;
          }
          y -= 1;
        } else {
          for (const line of titleTextLines()) { c.text(cx - Math.floor(textWidth(line) / 2), y, line, { fg: C.orange, bold: true, alpha: a }); y++; }
        }
        const t = plan.tagline ? tag : null;
        if (badge || t) {
          y += 1;
          const quote = t ? `“${t}”` : '';
          const together = !!badge && !!t && taglineFits(t);
          const bw = badge ? textWidth(badge) + 2 : 0;
          const lineW = together ? bw + 3 + textWidth(quote) : badge ? bw : textWidth(quote);
          let x = cx - Math.floor(lineW / 2);
          if (badge) { c.text(x, y, ` ${badge} `, { fg: C.ink, bg: fade(tierColor(d.tier), a), bold: true }); x += bw + 3; }
          if (t && together) c.text(x, y, quote, { fg: C.peach, italic: true, alpha: a });
          else if (t && taglineOwnLine(t)) { y++; c.text(cx - Math.floor(textWidth(quote) / 2), y, quote, { fg: C.peach, italic: true, alpha: a }); }
        }
      },
    });
  }
  if (d.heroes.length && (plan.heroBig || heroTextFits)) {
    const a = ctx.alpha(ai++);
    blocks.push({
      key: 'heroes', h: plan.heroBig ? 4 : 1, gapBefore: 1, draw: y => {
        if (plan.heroBig) {
          const widths = d.heroes.map(h => Math.max(bigWidth(h.value), textWidth(h.label)));
          const total = widths.reduce((s2, w) => s2 + w, 0) + (d.heroes.length - 1) * 8;
          // Spread across the facts' width when there is room, so the numbers line up with the columns.
          const span = Math.max(total, Math.min(inner, factsW));
          const gap = d.heroes.length > 1 ? Math.floor((span - widths.reduce((s2, w) => s2 + w, 0)) / (d.heroes.length - 1)) : 0;
          let x = cx - Math.floor(span / 2);
          d.heroes.forEach((h, i) => {
            const w = widths[i]!;
            const vw = bigWidth(h.value);
            drawBig(c, x + Math.floor((w - vw) / 2), y, h.value, { color: (_px, py) => fade(mix(C.cream, C.orange, py / 5), a) });
            c.text(x + Math.floor((w - textWidth(h.label)) / 2), y + 3, h.label, { fg: C.gray, alpha: a });
            x += w + gap;
          });
        } else {
          let x = cx - Math.floor(textWidth(heroText) / 2);
          d.heroes.forEach((h, i) => {
            if (i) x += c.text(x, y, '   ·   ', { fg: C.slate, alpha: a });
            x += c.text(x, y, h.value, { fg: C.cream, bold: true, alpha: a });
            x += c.text(x, y, ' ' + h.label, { fg: C.gray, alpha: a });
          });
        }
      },
    });
  }
  const shown = facts(plan);
  if (shown.length) {
    const rows = Math.ceil(shown.length / cols);
    blocks.push({
      key: 'facts', h: factsH(plan), gapBefore: 1, draw: y0 => {
        shown.forEach(({ fact, parts }, i) => {
          // Fill down the first column, then the second (reads like a list, not a grid).
          const col = cols === 2 ? Math.floor(i / rows) : 0;
          const row = cols === 2 ? i % rows : i;
          const x = fx + col * (colW + gutter);
          const a = ctx.alpha(ai + 1 + i);
          if (plan.factRows === 2) {
            const y = y0 + row * 3;
            c.text(x, y, fact.label, { fg: C.rust, bold: true, alpha: a });
            drawParts(ctx, x, y + 1, parts, a);
          } else {
            const y = y0 + row;
            c.text(x, y, fact.label, { fg: C.rust, bold: true, alpha: a });
            drawParts(ctx, x + labelColW + 2, y, parts, a);
          }
        });
      },
    });
    ai += shown.length + 1;
  }
  const trophyList = trophies(plan);
  if (trophyList.length) {
    const a = ctx.alpha(ai++);
    blocks.push({ key: 'trophies', h: plan.trophyRows, gapBefore: 1, draw: y => drawTrophyRow(ctx, trophyList, cx, y, inner, plan.trophyRows as 1 | 2, a) });
  }

  const footerY = H - 1;
  const bottomTop = footerY - (plan.memory ? 1 : 0) - (plan.ticker ? 1 : 0);
  stackBlocks(blocks, H >= 30 ? 1 : 0, bottomTop - 1, H >= 36 ? 3 : 1);
  const fa = ctx.alpha(ai++);
  let y = bottomTop;
  if (plan.ticker && d.sinceLast) {
    const lead = 'SINCE LAST RUN  ';
    if (textWidth(lead + d.sinceLast) <= inner) {
      const x = cx - Math.floor(textWidth(lead + d.sinceLast) / 2);
      c.text(x, y, lead, { fg: C.orange, bold: true, alpha: fa });
      c.text(x + textWidth(lead), y, d.sinceLast, { fg: C.gray, alpha: fa });
    }
    y++;
  }
  if (plan.memory && textWidth(memoryText(ctx.uni)) <= inner) memoryLine(ctx, y, cx, mx, fa);
  footer(ctx, footerY, mx);
  return ctx.busy;
}

/** Trophies that fit their column whole (two rows: title / value, or one row: title value). */
function fitTrophies(ctx: Ctx, list: Trophy[], width: number, rows: 1 | 2): Trophy[] {
  for (let n = list.length; n > 0; n--) {
    const colW = Math.floor((width - (n - 1) * 4) / n);
    const ok = list.slice(0, n).every(t => {
      const head = 2 + textWidth(t.title);
      return rows === 2 ? head <= colW && textWidth(trophyValue(ctx, t)) + 2 <= colW : head + 2 + textWidth(trophyValue(ctx, t)) <= colW;
    });
    if (ok) return list.slice(0, n);
  }
  return [];
}

function drawTrophyRow(ctx: Ctx, list: Trophy[], cx: number, y: number, width: number, rows: 1 | 2, a: number): void {
  const { c } = ctx;
  const n = list.length;
  const widths = list.map(t => (rows === 2 ? Math.max(2 + textWidth(t.title), 2 + textWidth(trophyValue(ctx, t))) : 2 + textWidth(t.title) + 2 + textWidth(trophyValue(ctx, t))));
  const gap = n > 1 ? Math.min(10, Math.floor((width - widths.reduce((s, w) => s + w, 0)) / (n - 1))) : 0;
  const total = widths.reduce((s, w) => s + w, 0) + gap * (n - 1);
  let x = cx - Math.floor(total / 2);
  list.forEach((t, i) => {
    const metal = metalColor(t.tier);
    c.text(x, y, trophyIcon(ctx, t.tier), { fg: metal, bold: true, alpha: a });
    const tw = c.text(x + 2, y, t.title, { fg: t.tier === 'bronze' ? mix(C.cream, C.gray, 0.4) : C.cream, bold: t.tier === 'gold', alpha: a });
    const value = trophyValue(ctx, t);
    if (rows === 2) c.text(x + 2, y + 1, value, { fg: metal, alpha: a });
    else c.text(x + 2 + tw + 2, y, value, { fg: metal, alpha: a });
    x += widths[i]! + gap;
  });
}

/* ── variant B: trading card ──────────────────────────────────────────────── */

export function posterB(s: Scene, d: BoardSummary): boolean {
  const ctx = context(s, d);
  const { c, uni } = ctx;
  const W = s.w, H = s.h;
  const cardW = Math.min(W - 4, 88);
  const x0 = Math.floor((W - cardW) / 2);
  const top = H >= 30 ? 1 : 0;
  const cardH = H - 2 - top - (H >= 30 ? 1 : 0);
  const frame = tierColor(d.tier);
  const a0 = ctx.alpha(0);
  // Card body: a warm panel inside a heavy frame (double rule for epic and up).
  const fill = mix(C.ink, frame, 0.06);
  box(c, { x: x0, y: top, w: cardW, h: cardH }, fade(frame, a0), { fill, ascii: !uni, rounded: true });
  if (uni && (d.tier === 'epic' || d.tier === 'legendary')) box(c, { x: x0 + 1, y: top + 1, w: cardW - 2, h: cardH - 2 }, fade(mix(frame, C.ink, 0.45), a0), { ascii: false, rounded: false, fill });
  const ix = x0 + 3, iw = cardW - 6;
  let y = top + 2;
  const bg = fill;
  // Header: kind on the left, rarity on the right.
  const badge = badgeText(ctx);
  c.text(ix, y, 'SLOPIE AUDIT', { fg: C.gray, bold: true, bg });
  if (d.range && textWidth('SLOPIE AUDIT') + 4 + textWidth(d.range) + (badge ? textWidth(badge) + 4 : 0) <= iw) c.text(ix + 14, y, d.range, { fg: C.slate, bg });
  if (badge) c.text(ix + iw - textWidth(badge) - 2, y, ` ${badge} `, { fg: C.ink, bg: tierColor(d.tier), bold: true });
  y += 2;
  const end = top + cardH - 2;
  // Title.
  const title = d.archetype ?? 'your year with agents';
  const big = ctx.pixel && bigSupported(title) ? titleLines(title, iw, 2) : null;
  const room = end - y;
  if (big && room >= 22) {
    for (const line of big) {
      const w = bigWidth(line);
      drawBig(c, ix + Math.floor((iw - w) / 2), y, line, { color: (px, py) => titleColor(ctx, px, py, w) });
      y += bigHeight() + 1;
    }
  } else {
    for (const line of textTitle(title, iw, iw >= 60) ?? [title.toUpperCase()]) { c.text(ix + Math.floor((iw - textWidth(line)) / 2), y, line, { fg: C.orange, bold: true, bg }); y++; }
    y++;
  }
  // Art + flavour text: Slopie on the left, the tagline beside it in italics.
  const tag = tagline(ctx);
  const art = ctx.pixel && end - y >= 16;
  if (art) {
    const artBox = { x: ix, y, w: 14, h: 6 };
    box(c, artBox, mix(frame, C.ink, 0.5), { ascii: !uni, rounded: false, fill: mix(C.ink, frame, 0.12) });
    drawMascot(c, ix + 2, y + 1, s.blink ? 'blink' : 'proud', { size: 'compact' });
    const tx = ix + 17, tw = iw - 17;
    if (d.subRole && textWidth(d.subRole) <= tw) c.text(tx, y + 1, d.subRole, { fg: C.peach, italic: true, bg });
    if (tag) {
      const lines = wrapWords(`“${tag}”`, tw);
      if (lines.length <= 3) lines.forEach((l, i) => c.text(tx, y + 2 + i, l, { fg: C.gray, italic: true, bg }));
    }
    y += 7;
  } else if (tag && textWidth(`“${tag}”`) <= iw && end - y >= 12) {
    c.text(ix + Math.floor((iw - textWidth(`“${tag}”`)) / 2), y, `“${tag}”`, { fg: C.peach, italic: true, bg });
    y += 2;
  }
  // Stat chips.
  if (d.heroes.length && end - y >= 8) {
    const chipW = Math.floor((iw - (d.heroes.length - 1) * 2) / d.heroes.length);
    const ok = d.heroes.every(h => textWidth(h.value) + 2 <= chipW && textWidth(h.label.toUpperCase()) + 2 <= chipW);
    if (ok) {
      d.heroes.forEach((h, i) => {
        const x = ix + i * (chipW + 2);
        box(c, { x, y, w: chipW, h: 4 }, mix(frame, C.ink, 0.35), { ascii: !uni, rounded: true, fill: bg });
        const lab = h.label.toUpperCase();
        c.text(x + Math.floor((chipW - textWidth(lab)) / 2), y + 1, lab, { fg: C.gray, bg });
        c.text(x + Math.floor((chipW - textWidth(h.value)) / 2), y + 2, h.value, { fg: C.cream, bold: true, bg });
      });
      y += 5;
    }
  }
  // Abilities: one line each, label + dot leader + fact.
  const rule = (yy: number) => { for (let x = ix; x < ix + iw; x++) c.put(x, yy, uni ? '─' : '-', mix(frame, C.ink, 0.6), bg); };
  const trophySlots = 2;
  const left = end - y - 1 - trophySlots;
  const labelW = Math.max(...d.facts.map(f => textWidth(f.label)), 0) + 2;
  const facts = pickFacts(d.facts, Math.max(0, Math.min(6, left)), iw - 2, labelW + 2);
  if (facts.length) {
    rule(y); y += 1;
    for (const { fact, parts } of facts) {
      if (y >= end - trophySlots) break;
      const icon = fact.id === 'nemesis' ? (uni ? '☠' : 'x') : fact.id === 'soft_spot' ? (uni ? '♥' : '<3') : uni ? '◆' : '*';
      c.text(ix, y, icon, { fg: fact.id === 'nemesis' ? C.ember : C.orange, bg });
      c.text(ix + 2, y, fact.label, { fg: C.peach, bold: true, bg });
      for (let x = ix + 2 + textWidth(fact.label) + 1; x < ix + labelW + 1; x++) c.put(x, y, uni ? '·' : '.', C.slate, bg);
      drawParts(ctx, ix + labelW + 2, y, parts, 1);
      y++;
    }
  }
  const trophyList = fitTrophies(ctx, pickTrophies(d, facts.map(f => f.fact), 3), iw, 1);
  if (trophyList.length && y + 1 < end) { rule(end - 2); drawTrophyRow(ctx, trophyList, ix + Math.floor(iw / 2), end - 1, iw, 1, 1); }
  if (d.code) { const code = ` code ${d.code} `; c.text(x0 + cardW - 3 - textWidth(code), top + cardH - 1, code, { fg: C.gray, bg: C.ink }); }
  if (textWidth(memoryText(uni)) <= W - 4) memoryLine(ctx, H - 2, Math.floor(W / 2), 2, 1);
  footer(ctx, H - 1, 2);
  return ctx.busy;
}

function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next) <= width) line = next;
    else { if (line) out.push(line); line = word; if (textWidth(word) > width) return [text]; }
  }
  if (line) out.push(line);
  return out;
}

/* ── variant C: receipt ───────────────────────────────────────────────────── */

export function posterC(s: Scene, d: BoardSummary): boolean {
  const ctx = context(s, d);
  const { c, uni } = ctx;
  const W = s.w, H = s.h;
  const paper = ctx.pixel;
  const rw = Math.min(W - 4, 66);
  const x0 = Math.floor((W - rw) / 2);
  const ix = x0 + 3, iw = rw - 6;
  const top = 0;
  const bottom = H - 2;
  const bg = paper ? PAPER : undefined;
  const ink = paper ? PAPER_INK : C.cream;
  const faint = paper ? PAPER_FAINT : C.gray;
  if (paper) {
    c.fill(x0, top, rw, bottom - top, ' ', { bg: PAPER });
    // Torn bottom edge.
    for (let x = x0; x < x0 + rw; x++) c.put(x, bottom, (x - x0) % 2 ? '▀' : ' ', PAPER, C.ink);
  }
  const center = (y: number, text: string, style: { fg: Rgb; bold?: boolean; italic?: boolean }) => c.text(ix + Math.floor((iw - textWidth(text)) / 2), y, text, { ...style, bg });
  const dash = (y: number) => { for (let x = ix; x < ix + iw; x++) c.put(x, y, uni ? '┄' : '-', faint, bg); };
  const leader = (y: number, label: string, value: FactPart[] | string, boldValue = false) => {
    const vw = typeof value === 'string' ? textWidth(value) : textWidth(factText(value));
    c.text(ix, y, label, { fg: ink, bold: true, bg });
    for (let x = ix + textWidth(label) + 1; x < ix + iw - vw - 1; x++) c.put(x, y, '.', faint, bg);
    if (typeof value === 'string') c.text(ix + iw - vw, y, value, { fg: ink, bold: boldValue, bg });
    else drawParts(ctx, ix + iw - vw, y, value, 1, paper);
  };
  let y = top + 1;
  center(y++, 'S L O P I E   A U D I T', { fg: paper ? C.rust : C.orange, bold: true });
  if (d.range) center(y++, d.range, { fg: faint });
  if (d.code && H >= 30) center(y++, `order #${d.code}`, { fg: faint });
  y++;
  dash(y++);
  center(y++, "THIS YEAR YOU'VE BEEN", { fg: faint });
  const rTitle = d.archetype ?? 'your year with agents';
  const rBig = paper && H >= 36 && bigSupported(rTitle) ? titleLines(rTitle, iw, 2) : null;
  if (rBig) {
    y++;
    for (const line of rBig) {
      const w = bigWidth(line);
      drawBig(c, ix + Math.floor((iw - w) / 2), y, line, { color: (_px, py) => mix(PAPER_INK, C.rust, py / 5) });
      y += bigHeight() + 1;
    }
  } else for (const line of textTitle(rTitle, iw, false) ?? []) center(y++, line, { fg: ink, bold: true });
  const badge = badgeText(ctx);
  if (badge) { const t = ` ${badge} `; c.text(ix + Math.floor((iw - textWidth(t)) / 2), y++, t, { fg: paper ? PAPER : C.ink, bg: paper ? PAPER_INK : tierColor(d.tier), bold: true }); }
  const tag = tagline(ctx);
  if (tag && H >= 30) { const lines = wrapWords(`“${tag}”`, iw); if (lines.length <= 2) for (const l of lines) center(y++, l, { fg: faint, italic: true }); }
  dash(y++);
  // Items: the facts. Room is what is left above the totals, barcode and thank-you.
  const tail = 1 /*dash*/ + d.heroes.length + 1 /*dash*/ + (H >= 30 ? 3 : 0) /*barcode*/ + 2 /*thanks + memory*/;
  const room = bottom - 1 - y - tail;
  const labelW = 0;
  const facts = pickFacts(d.facts, 6, iw, labelW).map(f => {
    const fits = (p: FactPart[] | undefined) => !!p && textWidth(f.fact.label) + 3 + textWidth(factText(p)) <= iw;
    return { ...f, one: fits(f.fact.parts) ? f.fact.parts : fits(f.fact.short) ? f.fact.short! : null };
  });
  // One line each when it fits (label, dot leader, value); otherwise the label sits above.
  const kept: typeof facts = [];
  let used = 0;
  for (const f of facts) { const h = f.one ? 1 : 2; if (used + h > room) break; used += h; kept.push(f); }
  const air = kept.length > 1 && room - used >= kept.length - 1 ? 1 : 0;
  kept.forEach((f, i) => {
    if (i && air) y++;
    if (f.one) { leader(y, f.fact.label, f.one); y++; }
    else { c.text(ix, y, f.fact.label, { fg: ink, bold: true, bg }); drawParts(ctx, ix + iw - textWidth(factText(f.parts)), y + 1, f.parts, 1, paper); y += 2; }
  });
  dash(y++);
  d.heroes.forEach((h, i) => { leader(y++, (i === 0 ? 'TOTAL ' : '') + h.label.toUpperCase(), h.value, true); });
  dash(y++);
  if (H >= 30) {
    // Barcode from the code letters (decorative; it encodes nothing else).
    const seed = [...(d.code ?? 'SLOP')].map(ch => ch.charCodeAt(0));
    const bw = Math.min(iw - 8, 40);
    const bx = ix + Math.floor((iw - bw) / 2);
    for (let i = 0; i < bw; i++) {
      const v = (seed[i % seed.length]! * (i + 7)) % 5;
      const glyph = uni ? (['▌', '▍', '▎', '▊', '█'][v]!) : '|';
      c.put(bx + i, y, glyph, ink, bg);
      c.put(bx + i, y + 1, glyph, ink, bg);
    }
    y += 3;
  }
  center(y++, 'THANK YOU. COME AGAIN.', { fg: ink, bold: true });
  const mem = memoryText(uni);
  if (textWidth(mem) <= iw) center(y++, mem, { fg: faint, italic: true });
  footer(ctx, H - 1, 2);
  return ctx.busy;
}

/** Glyph used for a trophy's metal in one-line lists (exported for the awards card). */
export function metalGlyph(tier: 'gold' | 'silver' | 'bronze', uni: boolean): string {
  return uni ? (tier === 'gold' ? '★' : tier === 'silver' ? '☆' : '✧') : tier === 'gold' ? '*' : tier === 'silver' ? '+' : '-';
}

export function posterBody(s: Scene, d: BoardSummary, variant: Variant = boardVariant()): boolean {
  if (variant === 'B') return posterB(s, d);
  if (variant === 'C') return posterC(s, d);
  return posterA(s, d);
}

