/**
 * Card chrome: header (wordmark, page counter, the progress hairline), the section label, the
 * two-tone headline, callouts, the "next →" bridge and the key footer. Returns the free body
 * rectangle for the card's own visual.
 */
import type { Rect } from '../gfx/draw.js';
import { wrapText } from '../gfx/draw.js';
import type { DeckCard } from '../story/deck.js';
import type { Scene } from '../cards/scene.js';
import { begin, fade, footer, header, headline, kicker, textWidth, txt, type K } from './kit.js';

export interface ChromeOptions {
  /** Draw the headline (cold open and the reveal set their own). */
  headline?: boolean;
  /** Extra hint shown first in the footer, e.g. ["1–4", "guess"]. */
  hint?: [string, string];
  /** Max headline rows. */
  maxLines?: number;
  /** Replace the support line (the guess card after a guess). */
  support?: string;
}

export function chrome(s: Scene, card: DeckCard, o: ChromeOptions = {}): { k: K; body: Rect; area: { y0: number; y1: number } } {
  const k = begin(s);
  const top = header(k);
  const { mx, iw, L } = k;
  const keys: [string, string][] = [];
  if (o.hint) keys.push(o.hint);
  const arrows = k.uni ? '← →' : '< >';
  keys.push([arrows, 'move'], ['b', 'board'], ['s', 'share'], ['?', 'how'], ['q', 'quit']);
  let bottom = footer(k, { keys }) - (L ? 2 : 1);
  let y = top + (L ? 2 : 1);
  const y0 = y;
  kicker(k, mx, y, card.kicker, fade(k, 0), iw);
  y += L ? 2 : 1;
  if (o.headline !== false) {
    const support = o.support ?? card.support ?? '';
    const rows = headline(k, mx, y, Math.min(iw, 96), card.headline, support, o.maxLines ?? (L ? 4 : 3), fade(k, 60));
    y += rows + (L ? 2 : 1);
  }
  // Bridge to the next card: tertiary, right-aligned, once the card has settled.
  if (card.bridge && !s.share && (card.kind !== 'guess' || s.state.guess !== undefined)) {
    const since = card.kind === 'guess' ? (s.state.guessAt ?? 0) : 0;
    const a = s.caps.motion ? fade(k, since + 900, 400) : 1;
    const arrow = k.uni ? '→' : '->';
    const text = `next ${arrow} ${card.bridge}`;
    if (textWidth(text) <= iw) {
      let bx = mx + iw - textWidth(text);
      bx += txt(k, bx, bottom, 'next ', k.tk.text2, { a });
      bx += txt(k, bx, bottom, arrow, k.tk.accent, { a });
      txt(k, bx, bottom, ' ' + card.bridge, k.tk.text2, { a });
    }
    bottom -= 2;
  }
  // Callouts: one plain secondary line under the visual (projects and the lineup only).
  const callouts = card.kind === 'projects' || card.kind === 'faceoff' ? (card.callouts ?? []).filter(Boolean) : [];
  if (callouts.length && bottom - y >= 14) {
    const room = 1;
    const lines = callouts.slice(0, room).map(t => wrapText(t, iw, 99)).filter(l => l.length === 1).map(l => l[0]!);
    const a = fade(k, 1100, 400);
    lines.forEach((line, i) => txt(k, mx, bottom - lines.length + 1 + i, line, k.tk.text2, { a }));
    if (lines.length) bottom -= lines.length + 1;
  }
  return { k, body: { x: mx, y, w: iw, h: Math.max(0, bottom - y + 1) }, area: { y0, y1: bottom } };
}
