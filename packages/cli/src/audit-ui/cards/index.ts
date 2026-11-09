/** Dispatch: draw one deck card (chrome + its own visual). Returns true while still animating. */
import type { DeckCard } from '../story/deck.js';
import { chrome, type ChromeOptions } from '../theme/chrome.js';
import { boardBody } from './board.js';
import { coverBody } from './cover.js';
import { insightBody } from './finale.js';
import { faceoffBody, guessBody } from './models.js';
import { billBody, scaleBody } from './numbers.js';
import { awardsBody, delegationBody, projectsBody } from './places.js';
import { archetypeBody } from './reveal.js';
import { tierFor, type Scene } from './scene.js';
import { Canvas } from '../gfx/canvas.js';
import { TK } from '../theme/tokens.js';
import { erasBody, spendBody } from './spend.js';
import { clockBody, fuseBody, moodBody } from './time.js';
import { coldOpenBody, mannersBody, talkBody, thenNowBody } from './words.js';

/** The content box: up to 132×44 the terminal itself; bigger terminals get min(cols−8, 176) × min(rows−4, 52), centred. */
export const BOX_W = 132, BOX_H = 44, BIG_W = 176, BIG_H = 52;

export function boxFor(w: number, h: number): [number, number] {
  return [Math.max(Math.min(w, BOX_W), Math.min(w - 8, BIG_W)), Math.max(Math.min(h, BOX_H), Math.min(h - 4, BIG_H))];
}

export function renderCard(s: Scene, card: DeckCard): boolean {
  const [bw, bh] = boxFor(s.w, s.h);
  if (bw === s.w && bh === s.h) return drawCard(s, card);
  const sub = new Canvas(bw, bh, s.c.base);
  const busy = drawCard({ ...s, c: sub, w: bw, h: bh, tier: tierFor(bw, bh) ?? s.tier, big: s.w >= 170 && s.h >= 50 }, card);
  s.c.fill(0, 0, s.w, s.h, ' ', { bg: TK.bg });
  s.c.blit(sub, Math.floor((s.w - bw) / 2), Math.floor((s.h - bh) / 2), false);
  return busy;
}

function drawCard(s: Scene, card: DeckCard): boolean {
  // The board is full-screen and draws its own chrome (it is also the share image).
  if (card.kind === 'board') return boardBody(s, card.data);
  const o: ChromeOptions = {};
  if (card.kind === 'cold_open' || card.kind === 'archetype') o.headline = false;
  if (card.kind === 'guess') {
    if (s.state.guess === undefined) o.hint = [`1–${card.data.options.length}`, 'guess'];
    else o.support = `Ranked by ${card.data.basis}.`;
  }
  const { k, body } = chrome(s, card, o);
  if (body.h <= 0 || body.w <= 0) return k.busy;
  switch (card.kind) {
    case 'cover': coverBody(k, card.data, body); break;
    case 'cold_open': coldOpenBody(k, card.data, body); break;
    case 'scale': scaleBody(k, card.data, body); break;
    case 'bill': if (card.data.spend) spendBody(k, card.data.spend, body); else billBody(k, card.data, body); break;
    case 'clock': clockBody(k, card.data, body); break;
    case 'guess': guessBody(k, card.data, body); break;
    case 'faceoff': if (card.data.best || card.data.worst) faceoffBody(k, card.data, body); else erasBody(k, card.data.eras, body); break;
    case 'mood': moodBody(k, card.data, body); break;
    case 'fuse': fuseBody(k, card.data, body); break;
    case 'talk': talkBody(k, card.data, body); break;
    case 'manners': mannersBody(k, card.data, body); break;
    case 'projects': projectsBody(k, card.data, body); break;
    case 'delegation': delegationBody(k, card.data, body); break;
    case 'then_now': thenNowBody(k, card.data, body); break;
    case 'archetype': archetypeBody(k, card.data, body); break;
    case 'awards': awardsBody(k, card.data, body); break;
    case 'insight': insightBody(k, card.data, body); break;
  }
  return k.busy;
}
