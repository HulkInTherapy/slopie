import { describe, expect, it } from 'vitest';
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { COUNT_FROM, countUp, SETTLED_MS } from '../../packages/cli/src/audit-ui/cards/poster.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { posterViz } from '../../packages/cli/src/audit-ui/story/board-data.js';
import { buildDeck } from '../../packages/cli/src/audit-ui/story/deck.js';
import { CORE_FACTS, catchphraseSlot, posterOrder, rankFunFacts } from '../../packages/cli/src/audit-ui/story/fun-facts.js';
import type { AuditStory } from '../../packages/cli/src/audit-ui/story/types.js';
import { storySnapshot } from './story-fixture.js';

function frame(w: number, h: number, t: number, motion: boolean, color: 'truecolor' | '16' = 'truecolor', ascii = false) {
  const deck = buildDeck(storySnapshot());
  const c = new Canvas(w, h, C.bg);
  c.fill(0, 0, w, h, ' ', { bg: C.bg });
  const busy = renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color, motion, unicode: !ascii }, blink: false, state: {}, index: deck.length - 1, total: deck.length }, deck.at(-1)!);
  return { c, busy, text: c.toText() };
}

const story = (): AuditStory => JSON.parse(JSON.stringify((storySnapshot().launch as unknown as { story: AuditStory }).story)) as AuditStory;

describe('poster: entry animation', () => {
  for (const [w, h] of [[120, 40], [100, 30], [80, 24]] as const) {
    it(`${w}×${h}: the reduced-motion static frame is exactly the last animated frame`, () => {
      const still = frame(w, h, Infinity, false);
      const settled = frame(w, h, SETTLED_MS, true);
      expect(settled.text).toBe(still.text);
      expect([...settled.c.fg]).toEqual([...still.c.fg]);
      expect([...settled.c.bg]).toEqual([...still.c.bg]);
      expect(settled.busy).toBe(false);
      expect(still.busy).toBe(false);
    });
  }

  it('never shows "$0": the price counts up from 80% of the total', () => {
    expect(countUp('$6,413', 0)).toBe('$5,130');
    expect(countUp('$6,413', 1)).toBe('$6,413');
    expect(countUp('$3', 0)).toBe('$2');
    expect(countUp('$0', 0)).toBe('$0'); // a real zero is never counted (and the board hides it)
    expect(countUp('n/a', 0.5)).toBe('n/a');
    for (let k = 0; k <= 1; k += 0.01) {
      const n = Number(countUp('$6,413', k).replace(/[^\d]/g, ''));
      expect(n).toBeGreaterThanOrEqual(Math.round(6413 * COUNT_FROM));
      expect(n).toBeLessThanOrEqual(6413);
    }
    // Every animated frame (the text price, as ASCII terminals draw it) at every size.
    for (const [w, h] of [[120, 40], [100, 30], [80, 24]] as const) {
      for (let t = 0; t <= SETTLED_MS + 50; t += 25) {
        const f = frame(w, h, t, true, '16', true);
        expect(f.text, `${w}×${h} t=${t}`).not.toMatch(/\$0\b/);
        const rows = f.text.split('\n');
        const at = rows.findIndex(r => r.includes('At API prices'));
        const price = at >= 0 ? rows[at + 1]!.match(/\$([\d,]+)/) : null;
        if (price) expect(Number(price[1]!.replace(/,/g, ''))).toBeGreaterThanOrEqual(5130);
      }
    }
  });

  it('prints in top to bottom, then grows the diagrams', () => {
    const early = frame(120, 40, 300, true);
    expect(early.busy).toBe(true);
    expect(early.text).toContain('THIS YEAR YOU’VE BEEN'); // the top is in
    expect(early.text).not.toContain('MANNERS'); // the rest is still printing
    const mid = frame(120, 40, 1100, true);
    expect(mid.busy).toBe(true);
    expect(mid.text).toContain('MANNERS'); // printed
    const meter = (t: string) => (t.match(/22 (━+)/)?.[1] ?? '').length;
    const done = frame(120, 40, SETTLED_MS, true);
    expect(meter(mid.text)).toBeLessThan(meter(done.text)); // the manners split is still filling
    expect(done.text).toContain('At API prices');
  });
});

describe('poster: picker', () => {
  it('puts the six core facts first, in poster order, whenever their guard passes', () => {
    const ranked = rankFunFacts(story());
    expect(posterOrder(ranked).slice(0, 6).map(f => f.id)).toEqual([...CORE_FACTS]);
    // A core fact whose guard fails is simply absent; the ranked rest fills in after the core.
    const s = story();
    s.totals.longestStretchHours = 2;
    const order = posterOrder(rankFunFacts(s)).map(f => f.id);
    expect(order).not.toContain('longest_sit');
    expect(order.slice(0, 5)).toEqual(CORE_FACTS.filter(id => id !== 'longest_sit'));
    // Slots shown elsewhere are excluded.
    expect(posterOrder(ranked, ['catchphrase', 'mood_hours']).map(f => f.id)).not.toContain('catchphrase');
  });

  it('the catchphrase slot has the fact\'s guard', () => {
    expect(catchphraseSlot(story())).toEqual({ phrase: 'real quick', count: 212 });
    const few = story();
    few.highlights.catchphrase!.count = 9;
    expect(catchphraseSlot(few)).toBeNull();
    const url = story();
    url.highlights.catchphrase!.phrase = 'see https://x.io';
    expect(catchphraseSlot(url)).toBeNull();
    expect(catchphraseSlot(null)).toBeNull();
  });

  it('every diagram is guarded: a missing or zero value hides it', () => {
    const v = posterViz(story());
    expect(v.arc?.pcts.length).toBe(11);
    expect(v.clock).toMatchObject({ angry: 23, saint: 9 });
    expect(v.faceoff.nemesis).toMatchObject({ label: 'GPT-6 Sol' });
    expect(v.faceoff.fav).toMatchObject({ label: 'Claude Fable 5' });
    expect(v.manners).toEqual({ thanks: 22, rude: 131, word: 'f-bombs' });
    expect(v.subagents?.total).toBe(266);
    expect(v.streak).toBe(23);

    const s = story();
    s.totals.subagents = 0;
    s.totals.longestStreakDays = 0;
    s.totals.longestStretchHours = 0;
    s.highlights.mostExpensivePrompt = null as never;
    s.cards = s.cards.filter(c => !['night_owl', 'mood_drift', 'thanks_vs_swears'].includes(c.id));
    s.models.best = null;
    const z = posterViz(s);
    expect(z).toMatchObject({ arc: null, clock: null, manners: null, subagents: null, streak: null, sit: null, priciest: null });
    expect(z.faceoff.fav).toBeNull();
    expect(posterViz(null).faceoff).toEqual({ nemesis: null, fav: null });
  });

  it('hides diagrams and slots whose numbers are gone, without leaving zeros', () => {
    const snapshot = storySnapshot();
    const s = (snapshot.launch as unknown as { story: AuditStory }).story;
    s.highlights.catchphrase = null as never;
    s.totals.subagents = 0;
    s.cards = s.cards.filter(c => c.id !== 'night_owl');
    const deck = buildDeck(snapshot);
    const c = new Canvas(120, 40, C.bg);
    renderCard({ c, w: 120, h: 40, t: Infinity, tier: tierFor(120, 40)!, caps: { color: 'truecolor', motion: false, unicode: true }, blink: false, state: {}, index: deck.length - 1, total: deck.length }, deck.at(-1)!);
    const text = c.toText();
    expect(text).not.toContain('Catchphrase');
    expect(text).not.toContain('angriest');
    expect(text).not.toMatch(/(^|\s)0 (subagents|prompts|days)/);
    expect(text).not.toContain('…');
  });
});
