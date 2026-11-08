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
  const c = new Canvas(w, h, C.ink);
  const busy = renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color: opts.color ?? 'truecolor', motion: opts.motion ?? true, unicode: !opts.ascii }, blink: false, state: {}, index: 0, total: deck.length }, card);
  return { text: c.toText(), busy };
}

describe('archetype ceremony', () => {
  it('builds suspense: evidence first, then the runner-up roll, then the slam', () => {
    const early = reveal(120, 40, 900).text;
    expect(early).toContain('the evidence');
    expect(early).not.toContain('╔');
    const roll = reveal(120, 40, T.roll + 500).text;
    expect(roll).toMatch(/so close…|maybe…/); // the slot spins through real runners-up, no raw scores
    expect(roll).not.toMatch(/0\.\d\d/);
    const slam = reveal(120, 40, T.shimmer + 200).text;
    expect(slam).toContain('╔');
    const done = reveal(120, 40, T.settle);
    expect(done.busy).toBe(false);
    expect(done.text).toContain('★ EPIC ★');
    expect(done.text).toContain('also close: The Model Sommelier'); // the sub-role already names The Architect
    expect(done.text).not.toMatch(/\b0\.\d\d\b/);
    expect(done.text).toContain('your code');
    expect(done.text).toContain('night · spec · roaming · hot-headed');
  });

  it('with motion off draws only the final frame', () => {
    const { text, busy } = reveal(120, 40, Infinity, { motion: false });
    expect(text).toContain('★ EPIC ★');
    expect(text).toContain('very high');
    expect(busy).toBe(false);
  });

  it('never clips an evidence label (the "top project only 23% of promp" bug)', () => {
    const label = 'top project only 23% of prompts';
    for (const [w, h] of [[60, 20], [80, 24], [100, 30], [120, 40], [140, 40]] as const) {
      expect(reveal(w, h, Infinity, { display: label }).text, `${w}×${h}`).toContain(label);
    }
  });

  it('scales the frame with rarity: none for common, single for rare, double for epic/legendary', () => {
    expect(reveal(120, 40, Infinity, { tier: 'common' }).text).not.toMatch(/[╔┌]/);
    expect(reveal(120, 40, Infinity, { tier: 'rare' }).text).toContain('┌');
    expect(reveal(120, 40, Infinity, { tier: 'legendary' }).text).toContain('★ LEGENDARY ★');
  });

  it('falls back to a spaced text title in ASCII / colourless terminals', () => {
    const { text } = reveal(100, 30, Infinity, { ascii: true, color: 'none' });
    expect(text).toContain('T H E   N I G H T');
    expect(text).toContain('* EPIC *');
    for (const ch of text) if (ch !== '\n') expect(ch.charCodeAt(0) < 128 || '…’“”'.includes(ch)).toBe(true);
  });
});
