import { describe, expect, it } from 'vitest';
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { T } from '../../packages/cli/src/audit-ui/cards/reveal.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { buildDeck } from '../../packages/cli/src/audit-ui/story/deck.js';
import { storyOfFixture, storySnapshot } from './story-fixture.js';

type Color = 'truecolor' | '256' | '16' | 'none';

function reveal(w: number, h: number, t: number, opts: { color?: Color; ascii?: boolean; motion?: boolean; tier?: string; display?: string } = {}) {
  const snapshot = storySnapshot();
  const story = (snapshot.launch as unknown as { story: ReturnType<typeof storyOfFixture> }).story;
  if (opts.tier) story.archetype!.rarity = opts.tier as 'rare';
  if (opts.display) story.archetype!.deciding = [{ ...story.archetype!.deciding[0]!, display: opts.display }, ...story.archetype!.deciding.slice(1)];
  const deck = buildDeck(snapshot);
  const card = deck.find(c => c.kind === 'archetype')!;
  const c = new Canvas(w, h, C.bg);
  const busy = renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color: opts.color ?? 'truecolor', motion: opts.motion ?? true, unicode: !opts.ascii }, blink: false, state: {}, index: 0, total: deck.length }, card);
  return { text: c.toText(), busy };
}

describe('archetype reveal', () => {
  it('builds quietly: evidence first, then the redacted title resolves in place, then the tier and copy', () => {
    const early = reveal(120, 40, 900).text;
    expect(early).toContain('THE EVIDENCE');
    expect(early).toContain('41% after 10pm');
    expect(early).not.toContain('EPIC'); // the tier lands after the title
    expect(early).toContain('███'); // the title is still the cover's redacted bars
    const title = reveal(120, 40, T.title + 900).text;
    expect(title.split('THE EVIDENCE')[0]).not.toMatch(/█{8,}/); // resolved into the set title
    const done = reveal(120, 40, T.settle);
    expect(done.busy).toBe(false);
    expect(done.text).toMatch(/EPIC {3}with a streak of The Spec Writer/);
    expect(done.text).toContain('Also close:  The Model Sommelier'); // the sub-role already names the runner-up
    expect(done.text).not.toMatch(/\b0\.\d\d\b/); // words, never raw scores
    expect(done.text).toContain('YOUR CODE');
    expect(done.text).toContain('night · spec · roaming · hot-headed');
    // No slot roll, no frame, no sparkles.
    expect(done.text).not.toMatch(/\bso close…|maybe…|[╔┌✦★]/);
  });

  it('with motion off draws only the final frame', () => {
    const { text, busy } = reveal(120, 40, Infinity, { motion: false });
    expect(text).toMatch(/EPIC {3}with a streak/);
    expect(text).toContain('very high');
    expect(busy).toBe(false);
  });

  it('never clips an evidence label (the "top project only 23% of promp" bug)', () => {
    const label = 'top project only 23% of prompts';
    for (const [w, h] of [[60, 20], [80, 24], [100, 30], [120, 40], [140, 40]] as const) {
      const { text } = reveal(w, h, Infinity, { display: label });
      expect(text, `${w}×${h}`).toContain(label);
      expect(text, `${w}×${h}`).toContain('notable'); // the last meter still has its word
      expect(text, `${w}×${h}`).not.toContain('…');
    }
  });

  it('names the rarity in words, one accent, no frame for any tier', () => {
    for (const tier of ['common', 'rare', 'epic', 'legendary']) {
      const text = reveal(120, 40, Infinity, { tier }).text;
      expect(text).toContain(tier.toUpperCase());
      expect(text).not.toMatch(/[╔╗┌┐★]/);
    }
  });

  it('falls back to a bold text title in ASCII / colourless terminals', () => {
    const { text } = reveal(100, 30, Infinity, { ascii: true, color: 'none' });
    expect(text).toContain('The 2AM Deployer');
    expect(text).toContain('EPIC');
    for (const ch of text) if (ch !== '\n') expect(ch.charCodeAt(0) < 128 || '…’“”·'.includes(ch), ch).toBe(true);
  });
});
