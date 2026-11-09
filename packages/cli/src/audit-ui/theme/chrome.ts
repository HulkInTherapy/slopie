/**
 * Card chrome: header (wordmark, page counter, the progress hairline), the section label, the
 * two-tone headline, callouts, the "next →" bridge and the key footer. Returns the free body
 * rectangle for the card's own visual.
 */
import type { Rect } from '../gfx/draw.js';
import { wrapText } from '../gfx/draw.js';
import type { DeckCard } from '../story/deck.js';
import type { Scene } from '../cards/scene.js';
import { begin, fade, footer, header, headline, label, textWidth, txt, type K } from './kit.js';

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

export function chrome(s: Scene, card: DeckCard, o: ChromeOptions = {}): { k: K; body: Rect } {
  const k = begin(s);
  const top = header(k);
  const { mx, iw, L } = k;
  const keys: [string, string][] = [];
  if (o.hint) keys.push(o.hint);
  const arrows = k.uni ? '← →' : '< >';
  keys.push([arrows, 'move'], ['b', 'board'], ['s', 'share'], ['?', 'how'], ['q', 'quit']);
  let bottom = footer(k, { keys }) - (L ? 2 : 1);
  let y = top + (L ? 2 : 1);
  label(k, mx, y, card.kicker, fade(k, 0));
  y += L ? 2 : 1;
  if (o.headline !== false) {
    const support = o.support ?? card.support ?? '';
    const rows = headline(k, mx, y, Math.min(iw, L ? 88 : iw), card.headline, support, o.maxLines ?? (L ? 3 : 2), fade(k, 60));
    y += rows + (L ? 2 : 1);
  }
  // Bridge to the next card: tertiary, right-aligned, once the card has settled.
  if (card.bridge && !s.share && (card.kind !== 'guess' || s.state.guess !== undefined)) {
    const since = card.kind === 'guess' ? (s.state.guessAt ?? 0) : 0;
    const a = s.caps.motion ? fade(k, since + 900, 400) : 1;
    const text = `next ${k.uni ? '→' : '->'} ${card.bridge}`;
    if (textWidth(text) <= iw) txt(k, mx + iw - textWidth(text), bottom, text, k.tk.text3, { a });
    bottom -= 2;
  }
  // Callouts: plain secondary lines under the visual, kept only while the visual has room.
  const callouts = (card.callouts ?? []).filter(Boolean);
  if (callouts.length && bottom - y >= 10) {
    const room = Math.min(callouts.length, Math.max(1, Math.floor((bottom - y - 8) / 2)));
    const lines = callouts.slice(0, room).map(t => wrapText(t, iw, 99)).filter(l => l.length === 1).map(l => l[0]!);
    const a = fade(k, 1100, 400);
    lines.forEach((line, i) => txt(k, mx, bottom - lines.length + 1 + i, line, k.tk.text2, { a }));
    if (lines.length) bottom -= lines.length + 1;
  }
  return { k, body: { x: mx, y, w: iw, h: Math.max(0, bottom - y + 1) } };
}
