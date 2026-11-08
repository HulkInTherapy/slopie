/**
 * The archetype reveal: a trophy ceremony (~3.2 s of real time, any key skips to the end).
 *
 *   evidence  the three deciding numbers fill their bars, values count up, a band word lands
 *   roll      the title slot rolls through the archetypes you nearly got (real runner-up scores)
 *   slam      the winner drops in all at once; one impact frame; the frame draws clockwise
 *   shimmer   a diagonal glint sweeps the pixel title (1 pass rare, 2 epic, 3 legendary), sparkles
 *   stamp     the rarity badge springs in, then the sub-role, "almost:", tagline, profile, code
 *
 * Times are card-clock units (the terminal runs cards at 1.5× real time). With motion off the
 * final frame is drawn directly. Fallbacks: truecolor → 256 → 16 colours → ASCII text title.
 */
import { C, fade, hx, mix, type Rgb } from '../gfx/color.js';
import { bar8, textRight, textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { bigHeight, bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { clamp01, countUp, easeOutBack, easeOutCubic, hash01, seg, spring } from '../gfx/motion.js';
import type { DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data = Extract<DeckCard, { kind: 'archetype' }>['data'];

const GOLD = hx('ffd27a');
const TIER_LABEL: Record<string, string> = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };

/** Ceremony timeline (card-clock ms). */
export const T = {
  evidence: 300,
  roll: 1950,
  slam: 2850,
  shimmer: 3250,
  stamp: 4450,
  profile: 4800,
  settle: 5800,
} as const;

export function revealDone(t: number): boolean {
  return t >= T.settle;
}

/** Mascot face for this moment of the ceremony (drumroll → shocked → proud). */
export function revealExpression(t: number): 'blink' | 'idle' | 'shocked' | 'proud' {
  if (t < T.slam) return Math.floor(t / 180) % 2 === 0 ? 'blink' : 'idle';
  if (t < T.slam + 600) return 'shocked';
  return 'proud';
}

const passes = (tier: Data['tier']) => (tier === 'legendary' ? 3 : tier === 'epic' ? 2 : tier === 'rare' ? 1 : 0);
const sparkleCount = (tier: Data['tier']) => (tier === 'legendary' ? 16 : tier === 'epic' ? 10 : tier === 'rare' ? 6 : 0);

function bandWord(band: number): string {
  return band >= 0.95 ? 'off the chart' : band >= 0.8 ? 'very high' : band >= 0.6 ? 'high' : 'notable';
}

/** Split an uppercase title into block-font lines that fit `width`. */
function titleLines(title: string, width: number): string[] | null {
  const words = title.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (bigWidth(next) <= width) line = next;
    else { if (line) lines.push(line); line = word; if (bigWidth(word) > width) return null; }
  }
  if (line) lines.push(line);
  return lines;
}

export function archetypeBody(s: Scene, data: Data, r: Rect, mascot: Rect): boolean {
  const { c, tier } = s;
  const t = s.t;
  const L = tier.id === 'L';
  const uni = s.caps.unicode;
  const pixel = s.caps.color !== 'none' && s.caps.unicode;
  let busy = t < T.settle;
  const end = r.y + r.h;
  let y = r.y;

  /* ── evidence ── */
  const ev = data.deciding;
  if (ev.length) {
    const head = seg(t, 0, 250);
    c.text(r.x, y, 'the evidence', { fg: C.gray, italic: true, alpha: head });
    y += 1;
    // Labels are never clipped: the column grows to the longest label (≤ 45% of the width), and a
    // longer label wraps onto its own line above the bar.
    const maxCol = Math.floor(r.w * 0.45);
    const labelW = Math.min(maxCol, Math.max(...ev.map(m => textWidth(m.display))) + 2);
    const rightLimit = Math.min(r.x + r.w, mascot.y + mascot.h > y ? mascot.x - 2 : r.x + r.w);
    const barW = Math.max(8, Math.min(32, rightLimit - r.x - labelW - 16));
    const step = L && r.h >= 24 ? 2 : 1;
    ev.forEach((m, i) => {
      if (y >= end) return;
      const start = T.evidence + i * 450;
      const k = seg(t, start, 450, easeOutCubic);
      const la = seg(t, start - 100, 200);
      const wraps = textWidth(m.display) > labelW - 2;
      if (wraps) {
        c.text(r.x, y, m.display, { fg: C.cream, alpha: la }, r.w);
        y += 1;
        if (y >= end) return;
      } else c.text(r.x, y, m.display, { fg: C.cream, alpha: la });
      const bx = r.x + (wraps ? 2 : labelW);
      const color = i === 0 ? C.orange : fade(C.orange, 0.7);
      bar8(c, bx, y, barW, m.band * k, s.caps.color === 'none' ? C.cream : color, !uni, la > 0 ? fade(C.coal, la) : undefined);
      const wa = seg(t, start + 380, 200);
      const pct = `${Math.round(countUp(m.band * 100, t, start, 450))}`;
      if (wa > 0) c.text(bx + barW + 2, y, bandWord(m.band), { fg: m.band >= 0.8 ? C.peach : C.gray, bold: m.band >= 0.95, alpha: wa });
      else if (k > 0 && k < 1) c.text(bx + barW + 2, y, pct, { fg: C.slate });
      y += step;
    });
    if (step === 1) y += 1;
  }

  /* ── title slot: roll, slam, frame, shimmer, sparkles ── */
  const frameStyle: 'none' | 'single' | 'double' = data.tier === 'epic' || data.tier === 'legendary' ? 'double' : data.tier === 'rare' ? 'single' : 'none';
  const padX = 3;
  const avoidMascot = (yy: number) => (mascot.w > 0 && yy < mascot.y + mascot.h ? mascot.x - 2 : r.x + r.w);
  const slotW = avoidMascot(y) - r.x - padX * 2 - 2;
  const lines = pixel && bigSupported(data.title) ? titleLines(data.title, Math.min(slotW, r.w - padX * 2 - 2)) : null;
  const useBig = !!lines && lines.length <= 2 && lines.length * (bigHeight() + 1) + 1 + 2 <= end - y - 4;
  const titleRows = useBig ? lines!.length * (bigHeight() + 1) - 1 : 1;
  const padY = L && end - y >= 26 ? 1 : 0;
  const innerW = useBig ? Math.max(...lines!.map(l => bigWidth(l))) : textWidth(spacedTitle(data.title, uni));
  const frame: Rect = { x: r.x, y: y + 1, w: Math.min(r.w, innerW + padX * 2 + 2), h: titleRows + 2 + padY * 2 };
  const ty = frame.y + 1 + padY;
  const tx = frame.x + 1 + padX;
  const rollT = t - T.roll;
  const runners = data.runners;

  if (t < T.slam && runners.length && s.caps.motion) {
    // Slot roll: 4th best → 3rd → 2nd, the last one lingering. Honest suspense: you nearly got these.
    const steps = runners.slice(0, 3).reverse();
    const durs = steps.map((_, i) => (i === steps.length - 1 ? 350 : 220));
    let acc = 0, idx = -1, local = 0;
    for (let i = 0; i < steps.length; i++) { if (rollT >= acc && rollT < acc + durs[i]!) { idx = i; local = (rollT - acc) / durs[i]!; } acc += durs[i]!; }
    if (rollT >= 0 && idx < 0) { idx = steps.length - 1; local = 1; }
    if (idx >= 0) {
      const name = steps[idx]!.title;
      const lift = Math.round((1 - easeOutCubic(local)) * 2);
      const alpha = 0.35 + 0.25 * Math.sin(Math.PI * local);
      drawTitle(s, tx, ty, name, useBig, slotW, (_px, py) => fade(mix(C.slate, C.gray, py / 4), alpha), lift);
      c.text(tx, frame.y + frame.h, `${steps[idx]!.score.toFixed(2)}?`, { fg: C.slate, alpha: alpha });
    }
  } else if (t >= T.slam || !s.caps.motion) {
    const slam = s.caps.motion ? seg(t, T.slam, 380, easeOutBack) : 1;
    const drop = Math.round((1 - Math.min(1, slam)) * -6);
    const impact = s.caps.motion && t >= T.slam + 80 && t < T.slam + 150;
    if (impact && (s.caps.color === 'truecolor' || s.caps.color === '256')) {
      for (let yy = frame.y; yy < frame.y + frame.h; yy++) for (let xx = frame.x; xx < frame.x + frame.w; xx++) c.put(xx, yy, ' ', C.cream, mix(C.ink, C.cream, 0.14));
    }
    // Shimmer passes: a diagonal band crossing the pixel title.
    const n = passes(data.tier);
    const passDur = 400;
    let sweep = -1;
    for (let p = 0; p < n; p++) {
      const k = (t - T.shimmer - p * passDur) / passDur;
      if (k >= 0 && k < 1) sweep = k;
    }
    const w = innerW;
    const goldShift = data.tier === 'legendary' ? clamp01((t - T.shimmer) / (n * passDur)) : 0;
    drawTitle(s, tx, ty, data.title, useBig, slotW, (px, py) => {
      let base = mix(C.cream, C.orange, py / 4);
      if (data.tier === 'legendary') base = mix(base, mix(GOLD, C.cream, py / 8), s.caps.motion ? goldShift : 1);
      if (sweep >= 0 && s.caps.color !== '16') {
        const band = Math.abs(px + py * 2 - sweep * (w * 2 + 20) + 10);
        if (band < 4) return mix(base, C.white, 0.72 * (1 - band / 4));
      }
      return base;
    }, drop, sweep >= 0 && s.caps.color === '16' ? sweep * (w + 10) : null);
    // Trophy frame draws clockwise from the top-left.
    if (frameStyle !== 'none') {
      const fk = s.caps.motion ? seg(t, T.slam + 60, 300, k => k) : 1;
      const color = data.tier === 'legendary' ? GOLD : data.tier === 'epic' ? C.orange : C.peach;
      drawFrame(s, frame, frameStyle, color, fk);
    }
    // Sparkles around the frame.
    sparkles(s, frame, data.tier, t, r);
  }

  y = frame.y + frame.h + 1;

  /* ── stamp: badge, sub-role, almost ── */
  if (y < end && data.tier) {
    const k = s.caps.motion ? spring((t - T.stamp) / 1000, 7, 0.5) : 1;
    if (t >= T.stamp || !s.caps.motion) {
      const label = `${uni ? '★' : '*'} ${TIER_LABEL[data.tier]} ${uni ? '★' : '*'}`;
      const pad = Math.max(1, Math.round(3 - 2 * Math.min(1, k)));
      const flash = s.caps.motion && t - T.stamp < 60;
      const bg = flash ? C.cream : data.tier === 'legendary' ? GOLD : data.tier === 'epic' ? C.orange : data.tier === 'rare' ? C.peach : C.slate;
      const text = ' '.repeat(pad) + label + ' '.repeat(pad);
      const bw = c.text(r.x, y, text, { fg: C.ink, bg, bold: true });
      const sa = seg(t, T.stamp + 150, 300);
      let x = r.x + bw + 3;
      if (data.subRole) x += c.text(x, y, data.subRole, { fg: C.peach, italic: true, alpha: sa }, r.x + r.w - x) + 3;
      const almost = data.runners.slice(0, 2).map(a => `${a.title} ${a.score.toFixed(2)}`).join(' · ');
      if (almost && x + 10 < r.x + r.w) {
        const text2 = `almost: ${almost}`;
        if (x + textWidth(text2) <= r.x + r.w) textRight(c, r.x + r.w, y, text2, { fg: C.slate, alpha: sa });
      }
    }
    y += 2;
  }

  /* ── tagline, profile, code ── */
  const lineAt = (i: number) => seg(t, T.profile + i * 120, 260);
  let li = 0;
  if (data.tagline && y < end) {
    c.text(r.x, y, `“${data.tagline}”`, { fg: C.peach, italic: true, alpha: lineAt(li++) }, r.w);
    y += 2;
  }
  if (y < end) {
    const room = Math.max(1, Math.min(L ? 3 : 2, end - y - 2));
    for (const line of wrapText(data.profile, Math.min(r.w, 96), room)) { if (y >= end) break; c.text(r.x, y++, line, { fg: C.cream, alpha: lineAt(li++) }); }
    y += 1;
  }
  if (data.code && y < end) {
    const ca = seg(t, T.profile + 450, 300);
    const letters = [...data.code];
    const shown = s.caps.motion ? Math.min(letters.length, Math.max(0, Math.floor((t - T.profile - 450) / 110) + 1)) : letters.length;
    let x = r.x + c.text(r.x, y, 'your code  ', { fg: C.slate, alpha: ca });
    const dot = uni ? ' · ' : ' ';
    x += c.text(x, y, letters.slice(0, shown).join(dot), { fg: C.orange, bold: true, alpha: ca }) + 3;
    if (data.codeWords.length && shown === letters.length) x += c.text(x, y, data.codeWords.join(uni ? ' · ' : ', '), { fg: C.gray, alpha: ca }, r.x + r.w - x) + 4;
    const note = data.tier ? `${data.tier} = ${data.tier === 'common' ? 'your deciding numbers sit mid-scale' : 'your deciding numbers sit near the top of their fixed scales'}` : '';
    if (note && L && x + textWidth(note) <= r.x + r.w) c.text(x, y, note, { fg: C.slate, alpha: ca });
  }
  return busy;
}

function spacedTitle(title: string, uni: boolean): string {
  void uni;
  return title.toUpperCase().split(' ').map(w => [...w].join(' ')).join('   ');
}

/** Pixel title (or a bold letter-spaced text title). `glint16` highlights a column band in 16 colours. */
function drawTitle(s: Scene, x: number, y: number, title: string, big: boolean, width: number, color: (px: number, py: number) => Rgb, dyPx: number, glint16: number | null = null): void {
  const { c } = s;
  if (big) {
    const lines = titleLines(title, width) ?? [title.toUpperCase()];
    lines.forEach((line, i) => drawBig(c, x, y + i * (bigHeight() + 1), line, { color, dy: () => dyPx }));
    if (glint16 !== null) {
      // 16 colours: shimmer as bold reverse on the swept columns.
      const col = Math.round(x + glint16 - 5);
      for (let yy = y; yy < y + lines.length * (bigHeight() + 1) - 1; yy++) for (let xx = col; xx < col + 2; xx++) {
        if (!c.inside(xx, yy)) continue;
        const i = yy * c.w + xx;
        if (c.ch[i] === ' ') continue;
        c.fg[i] = C.white;
      }
    }
    return;
  }
  const text = spacedTitle(title, s.caps.unicode);
  c.text(x, y, text, { fg: color(0, 0), bold: true }, width + 8);
}

function drawFrame(s: Scene, r: Rect, style: 'single' | 'double', color: Rgb, k: number): void {
  const { c } = s;
  const uni = s.caps.unicode;
  const [tl, tr, bl, br, hz, vt] = !uni ? ['+', '+', '+', '+', style === 'double' ? '=' : '-', '|']
    : style === 'double' ? ['╔', '╗', '╚', '╝', '═', '║'] : ['┌', '┐', '└', '┘', '─', '│'];
  // Perimeter cells in clockwise order from the top-left.
  const cells: [number, number, string][] = [[r.x, r.y, tl]];
  for (let x = r.x + 1; x < r.x + r.w - 1; x++) cells.push([x, r.y, hz]);
  cells.push([r.x + r.w - 1, r.y, tr]);
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) cells.push([r.x + r.w - 1, y, vt]);
  cells.push([r.x + r.w - 1, r.y + r.h - 1, br]);
  for (let x = r.x + r.w - 2; x > r.x; x--) cells.push([x, r.y + r.h - 1, hz]);
  cells.push([r.x, r.y + r.h - 1, bl]);
  for (let y = r.y + r.h - 2; y > r.y; y--) cells.push([r.x, y, vt]);
  const n = Math.round(cells.length * clamp01(k));
  for (let i = 0; i < n; i++) {
    const [x, y, ch] = cells[i]!;
    const head = n < cells.length && i >= n - 3;
    c.put(x, y, ch, head ? C.white : color);
  }
}

const TWINKLE_UNI = ['·', '*', '✦', '*', '·'];
const TWINKLE_ASCII = ['.', '+', '*', '+', '.'];

function sparkles(s: Scene, frame: Rect, tier: Data['tier'], t: number, area: Rect): void {
  const n = sparkleCount(tier);
  if (!n) return;
  const { c } = s;
  const glyphs = s.caps.unicode ? TWINKLE_UNI : TWINKLE_ASCII;
  const color = tier === 'legendary' ? GOLD : C.peach;
  for (let i = 0; i < n; i++) {
    // Around the frame, within 4 cells of it, never inside it.
    const side = Math.floor(hash01(i * 7 + 3) * 4);
    let x: number, y: number;
    if (side < 2) {
      x = frame.x - 2 + Math.floor(hash01(i * 13 + 1) * (frame.w + 4));
      y = side === 0 ? frame.y - 1 - Math.floor(hash01(i * 5 + 2) * 2) : frame.y + frame.h + Math.floor(hash01(i * 5 + 2) * 1);
    } else {
      y = frame.y + Math.floor(hash01(i * 11 + 4) * frame.h);
      x = side === 2 ? frame.x - 2 - Math.floor(hash01(i * 3 + 5) * 3) : frame.x + frame.w + 1 + Math.floor(hash01(i * 3 + 5) * 3);
    }
    if (x < area.x || x >= area.x + area.w || y < area.y - 1) continue;
    if (c.ch[y * c.w + x] !== ' ') continue;
    let glyph: string | null;
    if (!s.caps.motion || t >= T.settle) {
      // Resting: a third of them stay lit.
      glyph = i % 3 === 0 ? glyphs[2]! : null;
    } else {
      const born = T.shimmer + i * 90;
      const life = (t - born) / 400;
      glyph = life >= 0 && life < 1 ? glyphs[Math.min(4, Math.floor(life * 5))]! : null;
      if (life >= 1 && i % 3 === 0 && t > T.stamp) glyph = glyphs[2]!;
    }
    if (glyph) c.put(x, y, glyph, s.caps.color === '16' ? C.cream : color);
  }
}
