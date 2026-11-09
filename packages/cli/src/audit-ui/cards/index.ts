/** Dispatch: draw one deck card (chrome + its own visual). Returns true while still animating. */
import type { DeckCard } from '../story/deck.js';
import { drawChrome, type ChromeOptions } from './chrome.js';
import { faceoffBody, guessBody } from './models.js';
import { insightBody } from './finale.js';
import { coverBody } from './cover.js';
import { erasBody, spendBody } from './spend.js';
import { C } from '../gfx/color.js';
import { wrapText } from '../gfx/draw.js';
import { seg } from '../gfx/motion.js';
import { archetypeBody, revealExpression } from './reveal.js';
import { boardBody } from './board.js';
import { billBody, scaleBody } from './numbers.js';
import { awardsBody, delegationBody, projectsBody } from './places.js';
import type { Scene } from './scene.js';
import { clockBody, fuseBody, moodBody } from './time.js';
import { coldOpenBody, mannersBody, talkBody, thenNowBody } from './words.js';

export function renderCard(s: Scene, card: DeckCard): boolean {
  // The board is full-screen and draws its own chrome (it is also the share image).
  if (card.kind === 'board') return boardBody(s, card.data);
  const options: ChromeOptions = {};
  if (card.kind === 'cold_open' || card.kind === 'archetype') options.headline = false;
  if (card.kind === 'faceoff') options.mascot = false;
  if (card.kind === 'archetype') { options.bodyUnderKicker = true; options.expression = s.caps.motion ? revealExpression(s.t) : 'proud'; }
  if (card.kind === 'guess') {
    options.hint = s.state.guess === undefined ? `1–${card.data.options.length} guess` : undefined;
    if (s.state.guess !== undefined) options.expression = s.state.guess === card.data.answer ? 'proud' : 'shocked';
  }
  const shown = card.kind === 'guess' && s.state.guess !== undefined ? { ...card, support: `Ranked by ${card.data.basis}.` } : card;
  const { body, busy: chromeBusy, mascot } = drawChrome(s, shown, options);
  let busy = chromeBusy;
  if (body.h <= 0 || body.w <= 0) return busy;
  // Merged receipts sit under the card's own visual (kept only while the visual still has room).
  const callouts = (card.callouts ?? []).filter(Boolean);
  if (callouts.length && body.h >= 10) {
    const room = Math.min(callouts.length, Math.max(1, Math.floor((body.h - 8) / 2)));
    const lines = callouts.slice(0, room).map(text => wrapText(text, body.w - 2, 1)[0] ?? '');
    const top = body.y + body.h - lines.length;
    const ca = seg(s.t, 1100, 400);
    busy ||= ca < 1;
    lines.forEach((line, i) => {
      c2(s, body.x, top + i, line, ca);
    });
    body.h -= lines.length + 1;
  }
  let bodyBusy = false;
  switch (card.kind) {
    case 'cover': bodyBusy = coverBody(s, card.data, body); break;
    case 'cold_open': bodyBusy = coldOpenBody(s, card.data, body); break;
    case 'scale': bodyBusy = scaleBody(s, card.data, body); break;
    case 'bill': bodyBusy = card.data.spend ? spendBody(s, card.data.spend, body) : billBody(s, card.data, body); break;
    case 'clock': bodyBusy = clockBody(s, card.data, body); break;
    case 'guess': bodyBusy = guessBody(s, card.data, body); break;
    case 'faceoff': bodyBusy = card.data.best || card.data.worst ? faceoffBody(s, card.data, body) : erasBody(s, card.data.eras, body); break;
    case 'mood': bodyBusy = moodBody(s, card.data, body); break;
    case 'fuse': bodyBusy = fuseBody(s, card.data, body); break;
    case 'talk': bodyBusy = talkBody(s, card.data, body); break;
    case 'manners': bodyBusy = mannersBody(s, card.data, body); break;
    case 'projects': bodyBusy = projectsBody(s, card.data, body); break;
    case 'delegation': bodyBusy = delegationBody(s, card.data, body); break;
    case 'then_now': bodyBusy = thenNowBody(s, card.data, body); break;
    case 'archetype': bodyBusy = archetypeBody(s, card.data, body, mascot); break;
    case 'awards': bodyBusy = awardsBody(s, card.data, body); break;
    case 'insight': bodyBusy = insightBody(s, card.data, body); break;
  }
  return busy || bodyBusy;
}

function c2(s: Scene, x: number, y: number, text: string, alpha: number): void {
  s.c.text(x, y, s.caps.unicode ? '▸ ' : '> ', { fg: C.orange, alpha });
  s.c.text(x + 2, y, text, { fg: C.gray, alpha });
}
