/**
 * The archetype reveal, redesigned. Restrained motion: the evidence meters fill first, the title's
 * redacted bars (the cover's placeholder) resolve into the set title in place, then the tier,
 * tagline and profile settle in. No roll, no shimmer, no sparkles.
 *
 * Layout: the title band spans the page; below a hairline, a meta column (labels) and a content
 * column (evidence, code), as in Linear's changelog.
 */
import { textWidth, wrapText, type Rect } from '../gfx/draw.js';
import type { DeckCard } from '../story/deck.js';
import { meter } from '../theme/charts.js';
import { chip, fade, label, rule, strokeNum, txt, txtRight, type K } from '../theme/kit.js';
import { drawGhost, drawTitle, planTitle } from '../theme/title.js';

type Data = Extract<DeckCard, { kind: 'archetype' }>['data'];

const TIER: Record<string, string> = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const NOTE: Record<string, string> = {
  common: 'Common: your deciding numbers sit mid-scale.',
  rare: 'Rare: your deciding numbers sit high on their fixed scales.',
  epic: 'Epic: your deciding numbers sit near the top of their fixed scales.',
  legendary: 'Legendary: your deciding numbers sit at the very top of their fixed scales.',
};

/** Card-clock times (ms). `settle`: every animation has landed (any key skips to it). */
export const T = { evidence: 250, title: 1700, tier: 2300, copy: 2550, settle: 3300 } as const;

export function revealDone(t: number): boolean {
  return t >= T.settle;
}

function band(b: number): string {
  return b >= 0.95 ? 'off the chart' : b >= 0.8 ? 'very high' : b >= 0.6 ? 'high' : 'notable';
}

interface Fit { titleLines: number; bigTitle: boolean; tagline: boolean; profile: boolean; code: boolean; note: boolean; step: 1 | 2; air: 1 | 2 }

export function archetypeBody(k: K, d: Data, r: Rect): void {
  const { tk, s } = k;
  const mx = r.x, iw = r.w;
  const bottom = r.y + r.h - 1;
  const copyW = Math.min(iw, 92);
  const tag = d.tagline ? wrapText(`“${d.tagline}”`, copyW) : [];
  const prof = d.profile ? wrapText(d.profile, copyW) : [];
  const metaW = iw >= 80 ? 22 : 16;
  const cx = mx + metaW;
  const cw = iw - metaW;
  const labelW = Math.min(Math.floor(cw * 0.42), Math.max(...d.deciding.map(m => textWidth(m.display)), 0) + 3);
  const wordW = 13;
  const barW = Math.max(8, Math.min(44, cw - labelW - wordW - 2));
  // Labels are never clipped: a long one takes its own row above its meter.
  const own = (m: Data['deciding'][number]) => textWidth(m.display) > labelW - 2;

  const heights = (f: Fit) => {
    const plan = f.bigTitle ? planTitle(k, d.title, iw, f.titleLines) : { lines: [d.title], big: false, h: 1, w: textWidth(d.title), face: tk.face };
    let h = plan.h + 1 + f.air + (d.tier ? 2 : 0);
    if (f.tagline && tag.length <= 2 && tag.length) h += tag.length;
    if (f.profile && prof.length && prof.length <= 2) h += prof.length;
    h += f.air;
    if (d.deciding.length) h += 1 + f.air + d.deciding.reduce((a, m) => a + (own(m) ? 1 : 0) + f.step, 0) + (f.step === 1 ? 1 : 0);
    if (f.code && d.code) h += 1 + f.air + 3;
    return { h, plan };
  };
  // Fit: the evidence always shows; the note, profile, code, tagline and air go first.
  const fit: Fit = { titleLines: 2, bigTitle: true, tagline: true, profile: false, code: true, note: false, step: 2, air: 2 };
  const drops: ((f: Fit) => void)[] = [
    f => { f.titleLines = 1; }, f => { f.note = false; }, f => { f.step = 1; }, f => { f.air = 1; }, f => { f.profile = false; },
    f => { f.code = false; }, f => { f.tagline = false; }, f => { f.bigTitle = false; },
  ];
  let laid = heights(fit);
  for (const drop of drops) { if (laid.h <= r.h) break; drop(fit); laid = heights(fit); }
  const { plan } = laid;
  let y = r.y;

  // Title: the cover's redacted bars resolve into the set title in place.
  const ta = fade(k, T.title, 600);
  if (ta < 1) drawGhost(k, mx, y, plan, 1 - ta);
  drawTitle(k, mx, y, plan, tk.text, ta);
  // A 1-row accent underline that draws in under the title.
  const ul = s.caps.motion ? Math.max(0, Math.min(1, (s.t - T.title - 300) / 500)) : 1;
  const ulW = Math.round(Math.min(iw, plan.w) * ul);
  for (let i = 0; i < ulW; i++) k.c.put(mx + i, y + plan.h, k.uni ? '▀' : '=', tk.accent, tk.bg, 0);
  y += plan.h + 1 + fit.air;

  // Tier + sub-role, the runner-up on the right.
  const sa = fade(k, T.tier);
  if (d.tier) {
    let x = mx + chip(k, mx, y, TIER[d.tier]!.toUpperCase(), tk.accent, tk.bg, sa);
    if (d.subRole && x + 2 + textWidth(d.subRole) <= mx + iw) x += txt(k, x + 2, y, d.subRole, tk.text, { a: sa }) + 2;
    const [first, second] = d.runners;
    const named = !!first && !!d.subRole?.includes(first.title);
    const almost = named ? second?.title : first?.title;
    const lead = named ? 'Also close' : 'Runner-up';
    if (almost && x + 4 + textWidth(`${lead}  ${almost}`) <= mx + iw) {
      const w = txtRight(k, mx + iw, y, almost, tk.text2, { bold: true, a: sa });
      txtRight(k, mx + iw - w - 2, y, lead + ':', tk.text2, { a: sa });
    }
    y += 2;
  }

  // Tagline and profile: the two-tone pair, each whole or not at all.
  const ca = fade(k, T.copy);
  if (fit.tagline && tag.length && tag.length <= 2) for (const line of tag) txt(k, mx, y++, line, tk.accentHi, { italic: true, a: ca });
  if (fit.profile && prof.length && prof.length <= 2) for (const line of prof) txt(k, mx, y++, line, tk.text2, { a: ca });
  y += fit.air;

  // Meta | content: the evidence and the code.
  if (d.deciding.length) {
    rule(k, mx, y, iw);
    y += fit.air;
    label(k, mx, y, 'the evidence', fade(k, 0));
    d.deciding.forEach((m, i) => {
      if (y > bottom) return;
      const start = T.evidence + i * 380;
      const la = fade(k, start - 120, 240);
      const alone = own(m);
      txt(k, cx, y, m.display, tk.text, { bold: i === 0, a: la });
      if (alone) y += 1;
      const bx = cx + (alone ? 0 : labelW);
      const bw = alone ? Math.max(8, Math.min(44, cw - wordW - 2)) : barW;
      meter(k, bx, y, bw, m.band, tk.accent, start);
      txt(k, bx + bw + 2, y, band(m.band), tk.accentHi, { bold: true, a: fade(k, start + 420) });
      y += fit.step;
    });
    if (fit.step === 1) y++;
  }
  if (fit.code && d.code && y + 1 <= bottom) {
    rule(k, mx, y, iw);
    y += fit.air;
    const a = fade(k, T.copy + 200);
    label(k, mx, y, 'your code', a);
    const big = y + 3 <= bottom + 1 ? strokeNum(k, cx, y, d.code, tk.accentHi, a) : { w: txt(k, cx, y, d.code, tk.accentHi, { bold: true, a }), h: 1 };
    let x = cx + big.w;
    const words = d.codeWords.join(k.uni ? ' · ' : ', ');
    if (words && x + 3 + textWidth(words) <= mx + iw) x += txt(k, x + 3, y + big.h - 1, words, tk.text2, { a }) + 3;
    if (fit.note && d.tier && textWidth(NOTE[d.tier]!) <= cw) txt(k, cx, y + big.h + 1, NOTE[d.tier]!, tk.text3, { a });
  }
  if (s.caps.motion && s.t < T.settle) k.busy = true;
}
