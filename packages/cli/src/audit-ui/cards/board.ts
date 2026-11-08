/**
 * The final board: the screenshot. Dense, full-screen, every share row has a bar.
 *
 *   full    ≥116×36  identity band, hero strip, 3×2 panels, awards strip, since-last, memory line
 *   mid     ≥96×28   same grid, fewer lines per panel, awards on one line
 *   compact ≥76×22   text title, 2 columns (spend+agents | models+rhythm), voice/work as one line each
 *   tiny    smaller   stacked essentials
 *
 * The board draws its own chrome (no story rail): it is the last card and the share image.
 */
import { C, fade, hx, mix, type Rgb } from '../gfx/color.js';
import { bar8, box, panel, spaced, textRight, textWidth, type Rect } from '../gfx/draw.js';
import { bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { countUp, easeOutCubic, seg } from '../gfx/motion.js';
import { count, money, shortDate } from '../format.js';
import { drawMascot, mascotLine } from '../mascot.js';
import type { BarRow, BoardSummary, SpendPanel } from '../story/board-data.js';
import { monthLabel } from '../story/deck.js';
import { drawHeatmap } from './time.js';
import type { Scene } from './scene.js';

type Mode = 'full' | 'mid' | 'compact' | 'tiny';

export function boardMode(w: number, h: number): Mode {
  if (w >= 116 && h >= 36) return 'full';
  if (w >= 96 && h >= 28) return 'mid';
  if (w >= 76 && h >= 22) return 'compact';
  return 'tiny';
}

const TIER_LABEL: Record<string, string> = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };
export const INSTALL = 'npx slopie audit';
export const MEMORY_LINE = 'your agents forget. slopie remembers';

interface Item { h: number; p: number; draw: (y: number) => void }

/** Keep the highest-priority items that fit `rows`, drawn in their original order. */
function stack(items: Item[], y: number, rows: number): number {
  const keep = new Set<Item>();
  let used = 0;
  // Highest priority first; anything that does not fit is skipped (a smaller one may still fit).
  for (const it of [...items].sort((a, b) => b.p - a.p)) if (used + it.h <= rows) { keep.add(it); used += it.h; }
  let yy = y;
  for (const it of items) if (keep.has(it)) { it.draw(yy); yy += it.h; }
  return yy - y;
}

/** First candidate that fits `width` (the last one is clipped if none does). */
function fit(options: string[], width: number): string {
  return options.find(o => textWidth(o) <= width) ?? options.at(-1)!;
}

/** Drop trailing " · " segments (then "Claude "/"Code" words) until the line fits. */
function fitLine(text: string, width: number): string | null {
  let t = text;
  if (textWidth(t) <= width) return t;
  t = t.replace(/Claude Code/g, 'Claude').replace(/Claude (?=[A-Z])/g, '');
  while (textWidth(t) > width && t.includes(' · ')) t = t.slice(0, t.lastIndexOf(' · '));
  return textWidth(t) <= width ? t : null;
}

/** "Claude Opus 5" → "Opus 5" when the column is narrow. */
function shorten(label: string, width: number): string {
  if (textWidth(label) <= width) return label;
  const short = label.replace(/^(Claude|Gemini)\s+/, '');
  return short;
}

export function boardBody(s: Scene, data: BoardSummary): boolean {
  const mode = boardMode(s.w, s.h);
  const ctx = new BoardCtx(s, data, mode);
  ctx.draw();
  return ctx.busy;
}

class BoardCtx {
  busy = false;
  readonly c;
  readonly mx: number;
  readonly uni: boolean;
  readonly pixel: boolean;
  constructor(readonly s: Scene, readonly d: BoardSummary, readonly mode: Mode) {
    this.c = s.c;
    this.mx = mode === 'full' ? 2 : 1;
    this.uni = s.caps.unicode;
    this.pixel = s.caps.color === 'truecolor' || s.caps.color === '256';
  }

  appear(i: number): number {
    const k = seg(this.s.t, 60 + i * 90, 320, easeOutCubic);
    if (k < 1) this.busy = true;
    return k;
  }

  grow(i: number): number {
    const k = seg(this.s.t, 250 + i * 60, 700, easeOutCubic);
    if (k < 1) this.busy = true;
    return k;
  }

  draw(): void {
    const { s, mode } = this;
    let y = mode === 'full' ? 1 : 0;
    y = this.identity(y);
    if (mode === 'full') { this.rule(y++); y = this.heroStrip(y); this.rule(y++); }
    else { y = this.heroStrip(y); }
    const bottom = this.bottom();
    const area = { x: this.mx, y, w: s.w - this.mx * 2, h: bottom - y };
    if (mode === 'full' || mode === 'mid') this.grid(area);
    else if (mode === 'compact') this.twoCol(area);
    else this.tinyBody(area);
  }

  /* ── identity band ── */

  identity(y0: number): number {
    const { c, s, d, mode, mx } = this;
    const a = this.appear(0);
    // Slopie, top right.
    let right = s.w - mx;
    if ((mode === 'full' || mode === 'mid') && s.caps.color !== 'none' && s.caps.color !== '16') {
      const expression = s.blink ? 'blink' : (s.t < 1200 ? 'waving' : 'proud');
      drawMascot(c, s.w - mx - 9, y0, expression, { size: 'compact' });
      right = s.w - mx - 11;
    } else {
      const line = mascotLine(s.t < 1200 ? 'waving' : 'proud', !this.uni);
      c.text(s.w - mx - textWidth(line), y0, line, { fg: C.orange, bold: true });
      right = s.w - mx - textWidth(line) - 2;
    }
    const kicker = mode === 'full' ? spaced('your year with agents') : 'YOUR YEAR WITH AGENTS';
    c.text(mx, y0, kicker, { fg: C.orange, bold: true, alpha: a });
    const when = [d.range, mode === 'full' || mode === 'mid' ? d.days : null].filter(Boolean).join(' · ');
    if (when && mx + textWidth(kicker) + 4 + textWidth(when) <= right) textRight(c, right, y0, when, { fg: C.slate, alpha: a });
    let y = y0 + 1;
    if (!d.archetype) return y + 1;
    const badge = d.tier ? `${this.uni ? '★' : '*'} ${TIER_LABEL[d.tier]} ${this.uni ? '★' : '*'}` : null;
    const big = (mode === 'full' || mode === 'mid') && s.caps.color !== 'none' && bigSupported(d.archetype);
    const title = d.archetype.toUpperCase();
    const titleRoom = right - mx;
    if (big && bigWidth(title) <= titleRoom) {
      c.text(mx, y, mode === 'full' ? spaced("this year you've been") : "THIS YEAR YOU'VE BEEN", { fg: C.gray, alpha: a });
      y += 1;
      const tw = drawBig(c, mx, y, title, { color: (px, py) => fade(this.titleColor(px, py, bigWidth(title)), a) });
      let badgeInline = false;
      if (badge && mx + tw + 3 + textWidth(badge) + 4 <= right) {
        const bx = mx + tw + 3;
        const bw = textWidth(badge) + 4;
        const frame = d.tier === 'legendary' ? C.cream : d.tier === 'epic' ? C.orange : d.tier === 'rare' ? C.peach : C.slate;
        box(c, { x: bx, y, w: bw, h: 3 }, fade(frame, a), { rounded: d.tier !== 'epic' && d.tier !== 'legendary', ascii: !this.uni });
        if (this.uni && (d.tier === 'epic' || d.tier === 'legendary')) this.doubleFrame({ x: bx, y, w: bw, h: 3 }, fade(frame, a));
        c.text(bx + 2, y + 1, badge, { fg: frame, bold: true, alpha: a });
        badgeInline = true;
      }
      y += 3;
      y = this.subLine(y, badgeInline ? null : badge, a);
      return y;
    }
    // Text title (compact/tiny, or a title too wide for the block font).
    const lead = mode === 'tiny' ? '' : "THIS YEAR YOU'VE BEEN ";
    let x = mx + c.text(mx, y, lead, { fg: C.gray, alpha: a });
    x += c.text(x, y, title, { fg: C.orange, bold: true, alpha: a }, right - x - (badge ? textWidth(badge) + 3 : 0));
    if (badge && x + textWidth(badge) + 3 <= right) c.text(x + 2, y, ` ${badge} `, { fg: C.ink, bg: fade(this.tierColor(), a), bold: true });
    y += 1;
    if (mode === 'compact' || mode === 'tiny') return y;
    return this.subLine(y, null, a);
  }

  tierColor(): Rgb {
    const t = this.d.tier;
    return t === 'legendary' ? C.cream : t === 'epic' ? C.orange : t === 'rare' ? C.peach : C.slate;
  }

  titleColor(px: number, py: number, width: number): Rgb {
    if (this.d.tier === 'legendary') return mix(mix(C.cream, GOLD, px / Math.max(1, width)), C.orange, py / 8);
    return mix(C.cream, C.orange, py / 4);
  }

  doubleFrame(r: Rect, color: Rgb): void {
    const { c } = this;
    c.put(r.x, r.y, '╔', color); c.put(r.x + r.w - 1, r.y, '╗', color);
    c.put(r.x, r.y + r.h - 1, '╚', color); c.put(r.x + r.w - 1, r.y + r.h - 1, '╝', color);
    for (let x = r.x + 1; x < r.x + r.w - 1; x++) { c.put(x, r.y, '═', color); c.put(x, r.y + r.h - 1, '═', color); }
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) { c.put(r.x, y, '║', color); c.put(r.x + r.w - 1, y, '║', color); }
  }

  subLine(y: number, badge: string | null, a: number): number {
    const { c, s, d, mx } = this;
    let x = mx;
    const end = s.w - mx;
    if (badge) x += c.text(x, y, ` ${badge} `, { fg: C.ink, bg: fade(this.tierColor(), a), bold: true }) + 2;
    if (d.subRole) x += c.text(x, y, d.subRole, { fg: C.peach, italic: true, alpha: a }, end - x) + 2;
    if (d.tagline && !s.share && x + 8 < end) {
      const text = `· “${d.tagline}”`;
      if (x + textWidth(text) + 2 <= end - (d.code ? 12 : 0)) x += c.text(x, y, text, { fg: C.gray, italic: true, alpha: a }) + 2;
    }
    if (d.code && x + 10 <= end) c.text(x, y, `code ${d.code}`, { fg: C.slate, alpha: a });
    return y + 1;
  }

  rule(y: number): void {
    const { c, s, mx } = this;
    for (let x = mx; x < s.w - mx; x++) c.put(x, y, this.uni ? '─' : '-', C.coal);
  }

  heroStrip(y: number): number {
    const { c, s, d, mode, mx } = this;
    const a = this.appear(1);
    const items = mode === 'full' ? d.hero : mode === 'mid' ? d.hero.slice(0, 5) : d.hero.slice(0, mode === 'compact' ? 4 : 3);
    const gap = mode === 'full' ? 4 : mode === 'mid' ? 3 : 3;
    let x = mx + (mode === 'full' ? 2 : 0);
    for (const item of items) {
      const sp = item.label.startsWith('-') ? 0 : 1;
      const need = textWidth(item.value) + sp + textWidth(item.label);
      if (x + need > s.w - mx) break;
      x += c.text(x, y, item.value, { fg: C.cream, bold: true, alpha: a });
      x += sp + c.text(x + sp, y, item.label, { fg: C.gray, alpha: a }) + gap;
    }
    return y + (mode === 'full' ? 1 : mode === 'tiny' ? 1 : 1);
  }

  /** First row used by the bottom block (awards, ticker, memory line, footer). */
  bottom(): number {
    const { s, mode } = this;
    const footer = mode === 'full' ? s.h - 2 : s.h - 1;
    let used = 1; // footer
    const awards = this.d.awards.length ? (mode === 'full' ? 2 : 1) : 0;
    if (mode === 'full') used += 1 /* memory */ + 1 /* ticker */ + 1 /* rule */ + awards;
    else if (mode === 'mid') used += 1 + 1 + awards;
    else if (mode === 'compact') used += 1 + (awards ? 1 : 0) + 2 /* voice + work */;
    else used += awards ? 1 : 0;
    this.footerY = footer;
    return footer - used + 1;
  }

  footerY = 0;

  /* ── bottom block ── */

  bottomBlock(top: number): void {
    const { s, mode } = this;
    let y = top;
    const a = this.appear(8);
    if (mode === 'compact') {
      y = this.voiceWorkLines(y, a);
    }
    if (this.d.awards.length && mode !== 'tiny') y = this.awardsStrip(y, mode === 'full' ? 2 : 1, a);
    else if (this.d.awards.length) y = this.awardsStrip(y, 1, a);
    if (mode === 'full') { this.rule(y++); }
    if (mode !== 'tiny') { this.ticker(y++, a); }
    if (mode === 'full' || mode === 'mid') this.memoryLine(y++, a);
    this.footer(this.footerY);
    void s;
  }

  awardsStrip(y: number, lines: number, a: number): number {
    const { c, s, d, mx, mode } = this;
    const labelW = mode === 'full' ? 8 : 0;
    if (labelW) c.text(mx + 1, y, 'AWARDS', { fg: C.gray, bold: true, alpha: a });
    const perLine = mode === 'full' ? 3 : mode === 'mid' ? 3 : 3;
    const colW = Math.floor((s.w - mx * 2 - labelW - 1) / perLine);
    for (let li = 0; li < lines; li++) {
      const row = d.awards.slice(li * perLine, (li + 1) * perLine);
      let x = mx + labelW + 1;
      for (const award of row) {
        const gold = award.tier === 'gold';
        const icon = this.uni ? (gold ? '★' : '☆') : gold ? '*' : '+';
        const value = s.share ? award.publicValue : award.value;
        let w = c.text(x, y + li, icon + ' ', { fg: gold ? C.orange : C.gray, alpha: a });
        w += c.text(x + w, y + li, award.title, { fg: gold ? C.cream : C.gray, bold: gold, alpha: a }, colW - w - 2);
        const room = colW - w - 3;
        if (room >= 4) c.text(x + w + 2, y + li, textWidth(value) <= room ? value : value.slice(0, Math.max(1, room - 1)).trimEnd() + '…', { fg: gold ? C.orange : C.slate, alpha: a });
        x += colW;
      }
    }
    return y + lines;
  }

  ticker(y: number, a: number): void {
    const { c, d, mx, s } = this;
    if (d.sinceLast) {
      const w = c.text(mx + 1, y, 'SINCE LAST RUN ', { fg: C.orange, bold: true, alpha: a });
      c.text(mx + 1 + w, y, d.sinceLast, { fg: C.cream, alpha: a }, s.w - mx * 2 - w - 2);
    } else {
      c.text(mx + 1, y, d.firstRun ? 'first run · run it again next week to see what changed' : 'no earlier run on record · run it again next week to see what changed', { fg: C.slate, alpha: a }, s.w - mx * 2 - 2);
    }
  }

  memoryLine(y: number, a: number): void {
    const { c, mx, s } = this;
    if (s.share) return;
    const w = c.text(mx + 1, y, MEMORY_LINE + ' ', { fg: C.gray, italic: true, alpha: a });
    const arrow = this.uni ? '→ ' : '-> ';
    c.text(mx + 1 + w, y, arrow + 'slopie setup', { fg: C.peach, alpha: a });
  }

  footer(y: number): void {
    const { c, s, mx } = this;
    const install = INSTALL;
    const local = s.online ? 'online · Jev' : 'all local';
    const dot = this.uni ? '●' : '*';
    const rightText = `${install}  ·  ${local}`;
    const rx = s.w - mx - textWidth(rightText) - 2;
    if (s.share) {
      c.text(mx, y, 'slopie audit', { fg: C.orange, bold: true });
      c.text(s.w - mx - textWidth(rightText), y, install, { fg: C.orange, bold: true });
      c.text(s.w - mx - textWidth(local), y, local, { fg: C.slate });
      return;
    }
    const arrows = this.uni ? '←' : '<';
    const keys: [string, string][] = [[arrows, 'story'], ['s', 'share'], ['?', 'how'], ['q', 'quit']];
    let x = mx;
    for (const [k, label] of keys) {
      if (x + textWidth(k) + 1 + textWidth(label) + 3 > rx) break;
      x += c.text(x, y, k, { fg: C.gray, bold: true });
      x += 1 + c.text(x + 1, y, label, { fg: C.slate }) + 3;
    }
    if (rx > x) {
      c.text(rx, y, install, { fg: C.orange, bold: true });
      c.text(rx + textWidth(install) + 2, y, '·', { fg: C.slate });
      c.text(s.w - mx - textWidth(local) - 2, y, dot, { fg: s.online ? C.peach : fade(C.orange, 0.7) });
      c.text(s.w - mx - textWidth(local), y, local, { fg: C.slate });
    }
  }

  /* ── panels ── */

  grid(area: Rect): void {
    const { mode } = this;
    const gap = mode === 'full' ? 2 : 1;
    const colW = Math.floor((area.w - gap * 2) / 3);
    const xs = [area.x, area.x + colW + gap, area.x + (colW + gap) * 2];
    const lastW = area.x + area.w - xs[2]!;
    const h2 = Math.max(5, Math.min(9, area.h - 12));
    const h1 = area.h - h2;
    const r1 = (i: number): Rect => ({ x: xs[i]!, y: area.y, w: i === 2 ? lastW : colW, h: h1 });
    const r2 = (i: number): Rect => ({ x: xs[i]!, y: area.y + h1, w: i === 2 ? lastW : colW, h: h2 });
    this.spendPanel(r1(0), 2);
    this.timePanel(r1(1), 3);
    this.modelsPanel(r1(2), 4);
    this.agentsPanel(r2(0), 5);
    this.voicePanel(r2(1), 6);
    this.workPanel(r2(2), 7);
    this.bottomBlock(area.y + area.h);
  }

  twoCol(area: Rect): void {
    const gap = 2;
    const colW = Math.floor((area.w - gap) / 2);
    const left = { x: area.x, w: colW }, right = { x: area.x + colW + gap, w: area.w - colW - gap };
    const h1 = Math.ceil(area.h * 0.56), h2 = area.h - h1;
    this.spendPanel({ ...left, y: area.y, h: h1 }, 2);
    this.agentsPanel({ ...left, y: area.y + h1, h: h2 }, 3);
    this.modelsPanel({ ...right, y: area.y, h: h1 }, 4);
    this.rhythmPanel({ ...right, y: area.y + h1, h: h2 }, 5);
    this.bottomBlock(area.y + area.h);
  }

  tinyBody(area: Rect): void {
    const { c, d, s } = this;
    let y = area.y;
    const a = this.appear(2);
    const end = area.y + area.h;
    if (d.spend && y < end) {
      const parts = [`${money(d.spend.lifetime)} at API prices`];
      if (d.spend.perDay) parts.push(`${money(d.spend.perDay)}/active day`);
      c.text(area.x, y++, parts.join(' · '), { fg: C.orange, bold: true, alpha: a }, area.w);
    }
    const bars = (title: string, rows: BarRow[], max: number, idx: number) => {
      if (y >= end) return;
      c.text(area.x, y++, title, { fg: C.gray, alpha: a }, area.w);
      this.bars({ x: area.x, y, w: area.w, h: Math.min(max, end - y) }, rows, idx, { nameW: 14, max });
      y += Math.min(max, rows.length, end - y);
    };
    if (d.models?.rows.length) bars(`MODELS · ${d.models.basis}`, d.models.rows, 3, 3);
    if (d.agents?.rows.length) bars(`AGENTS · ${d.agents.basis}`, d.agents.rows, 4, 4);
    const lines = [
      d.time?.peak ? `peak ${d.time.peak}${d.time.lines[1] ? ' · ' + d.time.lines[1] : ''}` : null,
      ...d.voice.filter(v => !(s.share && v.private)).slice(0, 2).map(v => `${v.label} ${v.quoted ? `“${v.value}”` : v.value}${v.count !== null ? ` ×${count(v.count)}` : ''}`),
      d.work?.lines[0] ?? null,
    ].filter((l): l is string => !!l);
    const limit = this.footerY - (d.awards.length ? 1 : 0) - 1;
    for (const line of lines) { if (y >= limit) break; y++; c.text(area.x, y, line, { fg: C.cream, alpha: a }, area.w); }
    this.bottomBlock(Math.max(y, this.footerY - (d.awards.length ? 1 : 0)));
    void s;
  }

  panelFrame(r: Rect, title: string, idx: number): { inner: Rect; a: number } {
    const a = this.appear(idx);
    panel(this.c, r, title, idx === 2 ? C.rust : C.coal, C.gray, !this.uni, a);
    return { inner: { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 }, a };
  }

  /** Ranked bars, one per line; every non-zero share draws at least a sliver. */
  bars(r: Rect, rows: BarRow[], idx: number, opts: { nameW?: number; max?: number; tags?: boolean } = {}): number {
    const { c, s } = this;
    const shown = rows.slice(0, Math.max(0, Math.min(opts.max ?? rows.length, r.h)));
    if (!shown.length) return 0;
    const k = this.grow(idx);
    const cap = opts.nameW ?? 16;
    const label = (row: BarRow) => shorten(s.share && row.publicLabel ? row.publicLabel : row.label, cap);
    const nameW = Math.min(cap, Math.max(...shown.map(row => textWidth(label(row)))));
    const valueW = Math.max(...shown.map(row => textWidth(row.value)));
    const tagW = opts.tags ? 2 : 0;
    const noteW = shown.some(row => row.note) && r.w >= nameW + valueW + 24 ? Math.min(7, Math.max(...shown.map(row => textWidth(row.note ?? '')))) + 1 : 0;
    const barW = Math.max(3, r.w - nameW - 1 - valueW - 1 - tagW - noteW);
    const max = Math.max(...shown.map(row => row.pct), 1e-9);
    shown.forEach((row, i) => {
      const y = r.y + i;
      c.text(r.x, y, label(row), { fg: i === 0 ? C.cream : C.gray, bold: i === 0 }, nameW);
      const color = i === 0 ? C.orange : fade(C.orange, 0.62);
      bar8(c, r.x + nameW + 1, y, barW, (row.pct / max) * k, s.caps.color === 'none' ? C.cream : color, !this.uni);
      textRight(c, r.x + nameW + 1 + barW + 1 + valueW, y, row.value, { fg: i === 0 ? C.cream : C.gray });
      if (noteW && row.note) c.text(r.x + nameW + 2 + barW + valueW + 1, y, row.note, { fg: C.slate }, noteW);
      if (tagW && row.tags?.length) {
        const t = row.tags[0]!;
        const glyph = this.uni ? (t === 'fav' ? '♥' : t === 'nemesis' ? '☠' : '$') : (t === 'fav' ? 'F' : t === 'nemesis' ? 'N' : '$');
        c.put(r.x + r.w - 1, y, glyph, t === 'fav' ? C.peach : t === 'nemesis' ? C.ember : C.cream);
      }
    });
    return shown.length;
  }

  spendPanel(r: Rect, idx: number): void {
    const { c, s, d, mode } = this;
    const sp = d.spend;
    const { inner, a } = this.panelFrame(r, mode === 'compact' ? 'SPEND · API prices' : 'SPEND · API list prices', idx);
    if (!sp) { c.text(inner.x, inner.y, 'no priced usage recorded', { fg: C.slate, alpha: a }, inner.w); return; }
    const items: Item[] = [];
    const total = countUp(sp.lifetime, s.t, 200, 900);
    if (s.t < 1100) this.busy = true;
    const text = '$' + count(Math.round(total));
    const finalText = '$' + count(Math.round(sp.lifetime));
    const bigFits = this.pixel && bigWidth(finalText) + 10 <= inner.w && inner.h >= 6;
    if (bigFits) {
      items.push({ h: 3, p: 100, draw: y => {
        const w = drawBig(c, inner.x, y, text, { color: (_x, py) => fade(mix(C.cream, C.orange, py / 4), a) });
        void w;
        const lx = inner.x + bigWidth(finalText) + 2;
        c.text(lx, y, 'lifetime', { fg: C.gray, alpha: a }, inner.x + inner.w - lx);
        c.text(lx, y + 1, sp.measured ? 'measured' : 'at API prices', { fg: C.slate, alpha: a }, inner.x + inner.w - lx);
      } });
    } else {
      items.push({ h: 1, p: 100, draw: y => {
        const w = c.text(inner.x, y, finalText, { fg: C.orange, bold: true, alpha: a });
        c.text(inner.x + w + 1, y, sp.measured ? 'lifetime, measured' : 'lifetime', { fg: C.gray, alpha: a }, inner.w - w - 1);
      } });
    }
    const kv = (label: string, value: string, p: number, extra?: string) => items.push({ h: 1, p, draw: y => {
      c.text(inner.x, y, label, { fg: C.gray, alpha: a }, inner.w);
      const vx = inner.x + Math.min(16, inner.w - textWidth(value) - 1);
      c.text(vx, y, value, { fg: C.cream, bold: true, alpha: a });
      if (extra && vx + textWidth(value) + 2 + textWidth(extra) <= inner.x + inner.w) c.text(vx + textWidth(value) + 2, y, extra, { fg: C.slate, alpha: a });
    } });
    if (sp.recovered) items.push({ h: 1, p: 70, draw: y => {
      const w = c.text(inner.x, y, `+ ${money(sp.recovered)}`, { fg: C.peach, bold: true, alpha: a });
      c.text(inner.x + w + 1, y, fit(['recovered from usage stats', 'recovered (usage stats)', 'recovered'], inner.w - w - 1), { fg: C.slate, alpha: a }, inner.w - w - 1);
    } });
    if (sp.estimated) items.push({ h: 1, p: 65, draw: y => {
      const w = c.text(inner.x, y, `≈ ${money(sp.estimated!.low)}–${money(sp.estimated!.high).slice(1)}`, { fg: C.peach, alpha: a });
      const n = count(sp.estimated!.prompts);
      c.text(inner.x + w + 1, y, fit([`est. · ${n} older prompts`, `est. (${n} older)`, 'est.'], inner.w - w - 1), { fg: C.slate, alpha: a }, inner.w - w - 1);
    } });
    if (sp.thisMonth !== null) kv('this month', money(sp.thisMonth), 90);
    if (sp.perDay !== null) kv('per active day', money(sp.perDay), 85);
    if (sp.priciestDay) kv('priciest day', money(sp.priciestDay.usd), 80, shortDate(sp.priciestDay.day));
    if (sp.priciestLine) kv('priciest line', money(sp.priciestLine.usd), 50, sp.priciestLine.times > 1 ? `${count(sp.priciestLine.times)}× median` : undefined);
    if (sp.hundredDays) kv('days over $100', count(sp.hundredDays), 30);
    if (sp.months.length >= 3) {
      const tall = inner.h >= 11 ? 2 : 1;
      items.push({ h: tall + 1, p: 75, draw: y => this.monthStrip({ x: inner.x, y, w: inner.w, h: tall }, sp, a, idx) });
    }
    stack(items, inner.y, inner.h);
  }

  monthStrip(r: Rect, sp: SpendPanel, a: number, idx: number): void {
    const { c, s } = this;
    const months = sp.months;
    const n = months.length;
    const colW = Math.max(1, Math.min(3, Math.floor(r.w / n)));
    const barW = colW >= 3 ? 2 : 1;
    const width = colW * n;
    const x0 = r.x + Math.max(0, r.w - width);
    const max = Math.max(...months.map(m => m.measured + m.extra), 1e-9);
    const k = this.grow(idx);
    const pxH = r.h * 2;
    const bottomPx = (r.y + r.h) * 2 - 1;
    months.forEach((m, i) => {
      const x = x0 + i * colW;
      const solid = Math.round((m.measured / max) * pxH * k);
      const light = Math.round(((m.measured + m.extra) / max) * pxH * k);
      if (this.pixel) {
        for (let py = 0; py < Math.max(light, m.measured > 0 ? 1 : 0); py++) {
          const color = py < Math.max(solid, m.measured > 0 ? 1 : 0) ? (i === n - 1 ? C.cream : C.orange) : mix(C.ink, C.peach, 0.38);
          for (let b = 0; b < barW; b++) c.px(x + b, bottomPx - py, color);
        }
      } else {
        const cells = Math.max(m.measured > 0 ? 1 : 0, Math.round(light / 2));
        const solidCells = Math.round(solid / 2);
        for (let cy = 0; cy < cells; cy++) for (let b = 0; b < barW; b++) {
          c.put(x + b, r.y + r.h - 1 - cy, cy < Math.max(1, solidCells) ? (this.uni ? '█' : '#') : (this.uni ? '░' : ':'), cy < solidCells || cy === 0 ? C.orange : C.peach);
        }
      }
    });
    const axisY = r.y + r.h;
    const first = monthLabel(months[0]!.month), last = monthLabel(months.at(-1)!.month);
    c.text(x0, axisY, first, { fg: C.slate, alpha: a });
    textRight(c, x0 + width, axisY, last, { fg: C.slate, alpha: a });
    // Legend, left of the strip, when there is room.
    if (x0 - r.x >= 12) {
      c.text(r.x, r.y, 'by month', { fg: C.gray, alpha: a });
      if (months.some(m => m.extra > 0) && r.h >= 2) c.text(r.x, r.y + 1, this.uni ? '█ meas. ░ est.' : '# meas. : est.', { fg: C.slate, alpha: a }, x0 - r.x - 1);
    }
    void s;
  }

  timePanel(r: Rect, idx: number): void {
    const { c, s, d } = this;
    const { inner, a } = this.panelFrame(r, 'WHEN YOU PROMPT', idx);
    const tm = d.time;
    if (!tm) { c.text(inner.x, inner.y, 'not enough timestamps yet', { fg: C.slate, alpha: a }, inner.w); return; }
    const items: Item[] = [];
    if (tm.grid && inner.w >= 26) {
      const axis = inner.h >= 11;
      items.push({ h: 7 + (axis ? 1 : 0), p: 90, draw: y => {
        const { busy } = drawHeatmap(s, tm.grid!, inner.x, y, 1, { t: s.t - 150, axis, short: inner.w < 28 });
        if (busy) this.busy = true;
      } });
    }
    if (tm.peak) items.push({ h: 1, p: 95, draw: y => {
      const w = c.text(inner.x, y, 'peak ', { fg: C.gray, alpha: a });
      c.text(inner.x + w, y, tm.peak!, { fg: C.orange, bold: true, alpha: a });
    } });
    tm.lines.forEach((line, i) => { const text = fitLine(line, inner.w); if (text) items.push({ h: 1, p: 60 - i * 10, draw: y => { c.text(inner.x, y, text, { fg: C.cream, alpha: a }); } }); });
    stack(items, inner.y, inner.h);
  }

  /** Compact tier: 24-bar hour sparkline instead of the 7×24 grid. */
  rhythmPanel(r: Rect, idx: number): void {
    const { c, d } = this;
    const { inner, a } = this.panelFrame(r, 'WHEN YOU PROMPT', idx);
    const tm = d.time;
    if (!tm) { c.text(inner.x, inner.y, 'not enough timestamps yet', { fg: C.slate, alpha: a }, inner.w); return; }
    const items: Item[] = [];
    if (tm.grid) items.push({ h: 2, p: 90, draw: y => {
      const hours = Array.from({ length: 24 }, (_, h) => tm.grid!.reduce((sum, row) => sum + (row[h] ?? 0), 0));
      const max = Math.max(1, ...hours);
      const k = this.grow(idx);
      const glyphs = this.uni ? ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] : ['.', '.', ':', ':', '|', '|', '#', '#'];
      hours.forEach((v, h) => {
        const level = Math.min(7, Math.round((v / max) * 7 * k));
        c.put(inner.x + h, y, v > 0 ? glyphs[level]! : ' ', v === max ? C.cream : C.orange);
      });
      c.text(inner.x, y + 1, '12a', { fg: C.slate, alpha: a });
      c.text(inner.x + 12, y + 1, '12p', { fg: C.slate, alpha: a });
    } });
    if (tm.peak) items.push({ h: 1, p: 95, draw: y => {
      const w = c.text(inner.x, y, 'peak ', { fg: C.gray, alpha: a });
      c.text(inner.x + w, y, tm.peak!, { fg: C.orange, bold: true, alpha: a });
    } });
    tm.lines.slice(0, 2).forEach((line, i) => items.push({ h: 1, p: 50 - i, draw: y => { c.text(inner.x, y, line, { fg: C.cream, alpha: a }, inner.w); } }));
    stack(items, inner.y, inner.h);
  }

  modelsPanel(r: Rect, idx: number): void {
    const { c, d, mode } = this;
    const m = d.models;
    const { inner, a } = this.panelFrame(r, m ? `MODELS · ${m.basis.replace('share of ', '')}` : 'MODELS', idx);
    if (!m) { c.text(inner.x, inner.y, 'no model names recorded', { fg: C.slate, alpha: a }, inner.w); return; }
    const factsRoom = mode === 'full' ? 3 : mode === 'mid' ? 1 : 0;
    const unknownRows = m.unknown ? 1 : 0;
    const legendRows = m.rows.some(row => row.tags?.length) && inner.h >= 8 ? 1 : 0;
    const barRoom = Math.max(1, inner.h - Math.min(factsRoom, m.facts.length) - unknownRows - legendRows);
    const overflow = m.rows.length > barRoom;
    const shownN = overflow ? Math.max(1, barRoom - 1) : m.rows.length;
    const shown = m.rows.slice(0, shownN);
    if (overflow) {
      const rest = m.rows.slice(shownN);
      const pct = Math.round(rest.reduce((s2, row) => s2 + row.pct, 0) * 10) / 10;
      shown.push({ label: `+${rest.length} more`, pct, value: `${pct.toFixed(1)}%` });
    }
    let y = inner.y + this.bars({ x: inner.x, y: inner.y, w: inner.w, h: inner.h }, shown, idx, { nameW: inner.w >= 32 ? 16 : 12, tags: true });
    const end = inner.y + inner.h;
    if (m.unknown && y < end) {
      const n = count(m.unknown);
      c.text(inner.x, y++, fit([`${n} older prompts have no recorded model`, `${n} older prompts: no model recorded`, `${n} older prompts: model unknown`, `${n} prompts: model unknown`], inner.w), { fg: C.slate, alpha: a }, inner.w);
    }
    if (legendRows && y < end) {
      const parts = this.uni ? ['♥ favourite', '☠ nemesis', '$ priciest'] : ['F favourite', 'N nemesis', '$ priciest'];
      const used = new Set(m.rows.flatMap(row => row.tags ?? []));
      const list = parts.filter((_, i) => used.has((['fav', 'nemesis', 'priciest'] as const)[i]!));
      const text = list.join('  ');
      if (textWidth(text) <= inner.w) c.text(inner.x, y++, text, { fg: C.slate, alpha: a });
    }
    let room = Math.max(factsRoom, end - y);
    for (const fact of m.facts) {
      if (y >= end || room <= 0) break;
      const text = fitLine(this.uni ? fact : fact.replace('☠', 'N').replace(/▸/g, '>'), inner.w);
      if (!text) continue;
      c.text(inner.x, y++, text, { fg: C.cream, alpha: a });
      room--;
    }
  }

  agentsPanel(r: Rect, idx: number): void {
    const { c, d } = this;
    const ag = d.agents;
    const { inner, a } = this.panelFrame(r, ag ? `AGENTS · ${ag.basis.replace('share of ', '')}` : 'AGENTS', idx);
    if (!ag) { c.text(inner.x, inner.y, 'no per-agent split recorded', { fg: C.slate, alpha: a }, inner.w); return; }
    const extra = (ag.money ? 1 : 0) + (ag.automated ? 1 : 0);
    const room = Math.max(1, inner.h - Math.min(extra, Math.max(0, inner.h - ag.rows.length)));
    // Never drop an agent silently: fold the remainder into one row.
    let rows = ag.rows;
    if (rows.length > room) {
      const rest = rows.slice(room - 1);
      const pct = Math.round(rest.reduce((s2, row) => s2 + row.pct, 0) * 10) / 10;
      rows = [...rows.slice(0, room - 1), { label: `+${rest.length} more`, pct, value: `${pct.toFixed(1)}%` }];
    }
    let y = inner.y + this.bars({ x: inner.x, y: inner.y, w: inner.w, h: inner.h }, rows, idx, { nameW: 12 });
    const end = inner.y + inner.h;
    const money = ag.money ? fitLine(ag.money, inner.w) : null;
    if (money && y < end) c.text(inner.x, y++, money, { fg: C.gray, alpha: a });
    if (ag.automated && y < end) c.text(inner.x, y++, fit([`+ ${count(ag.automated)} automated runs (not chats)`, `+ ${count(ag.automated)} automated runs`], inner.w), { fg: C.slate, alpha: a }, inner.w);
  }

  voicePanel(r: Rect, idx: number): void {
    const { c, s, d } = this;
    const { inner, a } = this.panelFrame(r, 'YOUR VOICE', idx);
    const lines = d.voice.filter(v => !(s.share && v.private));
    if (!lines.length) { c.text(inner.x, inner.y, s.share ? 'kept off the share card' : 'not enough typed prompts yet', { fg: C.slate, alpha: a }, inner.w); return; }
    const narrow = inner.w < 32;
    const lab = (v: (typeof lines)[number]) => (narrow ? v.short : v.label);
    const labelW = Math.min(13, Math.max(...lines.map(v => textWidth(lab(v)))) + 1);
    lines.slice(0, inner.h).forEach((v, i) => {
      const y = inner.y + i;
      c.text(inner.x, y, lab(v), { fg: C.gray, alpha: a }, labelW);
      const value = narrow && v.valueShort ? v.valueShort : v.value;
      const text = v.quoted ? `“${value}”` : value;
      const countText = v.count !== null ? `×${count(v.count)}` : '';
      const room = inner.w - labelW - (countText ? textWidth(countText) + 1 : 0);
      const w = c.text(inner.x + labelW, y, text, { fg: v.quoted ? C.peach : C.cream, italic: v.quoted, bold: v.quoted, alpha: a }, room);
      if (countText) c.text(inner.x + labelW + w + 1, y, countText, { fg: C.orange, bold: true, alpha: a });
    });
  }

  workPanel(r: Rect, idx: number): void {
    const { c, d } = this;
    const wk = d.work;
    const { inner, a } = this.panelFrame(r, 'YOUR WORK · by prompts', idx);
    if (!wk) { c.text(inner.x, inner.y, 'no project folders recorded', { fg: C.slate, alpha: a }, inner.w); return; }
    const lineRoom = Math.min(wk.lines.length, Math.max(0, inner.h - Math.min(3, wk.rows.length)));
    const barRows = Math.max(1, inner.h - lineRoom);
    let y = inner.y + this.bars({ x: inner.x, y: inner.y, w: inner.w, h: barRows }, wk.rows, idx, { nameW: 13 });
    for (const line of wk.lines.slice(0, lineRoom)) {
      if (y >= inner.y + inner.h) break;
      const text = fitLine(line, inner.w);
      if (text) c.text(inner.x, y++, text, { fg: C.cream, alpha: a });
    }
  }

  voiceWorkLines(y: number, a: number): number {
    const { c, s, d, mx } = this;
    const voice = d.voice.filter(v => !(s.share && v.private)).slice(0, 2).map(v => (v.quoted ? `“${v.value}”${v.count !== null ? ` ×${count(v.count)}` : ''}` : v.value)).join(' · ');
    if (voice) { const w = c.text(mx + 1, y, 'voice ', { fg: C.gray, alpha: a }); c.text(mx + 1 + w, y, voice, { fg: C.cream, alpha: a }, s.w - mx * 2 - w - 2); }
    y++;
    const work = d.work?.lines.slice(0, 2).join(' · ');
    if (work) { const w = c.text(mx + 1, y, 'work  ', { fg: C.gray, alpha: a }); c.text(mx + 1 + w, y, work, { fg: C.cream, alpha: a }, s.w - mx * 2 - w - 2); }
    return y + 1;
  }
}

const GOLD = hx('ffd27a');
