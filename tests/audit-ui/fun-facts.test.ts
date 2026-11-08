import { describe, expect, it } from 'vitest';
import { CATALOGUE, factText, pickFunFacts, rankFunFacts } from '../../packages/cli/src/audit-ui/story/fun-facts.js';
import type { AuditStory } from '../../packages/cli/src/audit-ui/story/types.js';
import { storyOfFixture, storySnapshot } from './story-fixture.js';

/** The SYNTHETIC rich story, with best/worst models filled in as the snapshot does. */
function story(): AuditStory {
  const s = (storySnapshot().launch as unknown as { story: AuditStory }).story;
  return JSON.parse(JSON.stringify(s)) as AuditStory;
}
const ids = (s: AuditStory | null) => rankFunFacts(s).map(f => f.id);
const card = (s: AuditStory, id: string) => (s.cards as { id: string; numbers: Record<string, unknown> }[]).find(c => c.id === id)!;

describe('fun facts picker', () => {
  it('ranks the rich fixture by surprise, deterministically', () => {
    const ranked = rankFunFacts(story());
    expect(ranked.map(f => [f.id, f.score])).toEqual([
      ['manners', 100],
      ['mood_drift', 87.4],
      ['priciest_sentence', 80.4],
      ['longest_sit', 80],
      ['pet_name', 78.9],
      ['nemesis', 78.7],
      ['soft_spot', 77.9],
      ['late_nights', 77],
      ['catchphrase', 75.8],
      ['mood_hours', 68],
      ['agent_split', 55],
      ['subagents', 54.1],
      ['streak', 48],
      ['fuse', 44],
    ]);
    expect(ids(story())).toEqual(ids(story()));
  });

  it('every line quotes a real number or word from the snapshot', () => {
    const s = story();
    const byId = Object.fromEntries(rankFunFacts(s).map(f => [f.id, factText(f.parts)]));
    expect(byId['manners']).toBe('6 f-bombs per thank-you'); // 131 / 22
    expect(byId['nemesis']).toBe('GPT-6 Sol gets 1.9× your swearing'); // swearRatio 1.95
    expect(byId['soft_spot']).toBe('Claude Fable 5 gets 2.4× your thank-yous');
    expect(byId['catchphrase']).toBe('“real quick” ×212');
    expect(byId['pet_name']).toBe('you call it “buddy” ×37');
    expect(byId['mood_hours']).toBe('angriest at 11 PM, a saint at 9 AM');
    expect(byId['late_nights']).toBe('38% of your days end past 1am');
    expect(byId['priciest_sentence']).toBe('$412, 330× your median prompt');
    expect(byId['longest_sit']).toBe('7.5h without a real break');
    expect(byId['mood_drift']).toBe('swearing went 2.6% → 23%');
    expect(byId['agent_split']).toBe('left Claude Code for Codex in Aug 2026');
    for (const f of rankFunFacts(s)) {
      expect(factText(f.parts), f.id).toMatch(/\d|“[^”]+”/);
      expect(factText(f.parts)).not.toMatch(/(^|\D)0(\.0+)?(%|×|\b)(?!\.\d)/);
    }
  });

  it('every guard hides its fact when the number is missing, zero or ordinary', () => {
    const s = story();
    const thanks = card(s, 'thanks_vs_swears');
    thanks.numbers['thanks'] = 0;
    s.models.worst = { ...s.models.worst!, swearRatio: 1.1 };
    s.models.best = { ...s.models.best!, matchedMonths: 1 };
    s.highlights.petName = { ...s.highlights.petName!, count: 3 };
    s.highlights.catchphrase = { ...s.highlights.catchphrase!, phrase: 'see https://example.com/x' };
    s.rhythm.lateNightDaysPct = 10;
    s.highlights.mostExpensivePrompt = { ...s.highlights.mostExpensivePrompt!, timesMedian: 4 };
    s.totals.longestStretchHours = 0;
    card(s, 'mood_drift').numbers['earlyPct'] = 0;
    card(s, 'night_owl').numbers['angriestPct'] = 2;
    s.highlights.fuse = null;
    s.models.defection = null;
    s.totals.subagents = 0;
    s.totals.longestStreakDays = 3;
    const left = ids(s);
    for (const gone of ['manners', 'nemesis', 'soft_spot', 'pet_name', 'catchphrase', 'late_nights', 'priciest_sentence', 'longest_sit', 'mood_drift', 'mood_hours', 'fuse', 'subagents', 'streak']) expect(left).not.toContain(gone);
    // Without a switch, the agent line needs a real second agent (Codex 480 of 2,907 = 16.5%).
    expect(left).toEqual(['agent_split']);
    expect(factText(rankFunFacts(s)[0]!.parts)).toBe('Claude Code 83% · Codex 17%');
    expect(rankFunFacts(null)).toEqual([]);
  });

  it('breaks score ties by catalogue order', () => {
    const s = story();
    // 20 + 8 × 7.55 = 80.4, the same as the priciest sentence (30 + 20·log10 330).
    s.totals.longestStretchHours = 7.55;
    const ranked = rankFunFacts(s);
    const a = ranked.findIndex(f => f.id === 'priciest_sentence'), b = ranked.findIndex(f => f.id === 'longest_sit');
    expect(ranked[a]!.score).toBe(ranked[b]!.score);
    expect(a).toBeLessThan(b);
    expect(CATALOGUE.findIndex(c => c.id === 'priciest_sentence')).toBeLessThan(CATALOGUE.findIndex(c => c.id === 'longest_sit'));
  });

  it('gives a different person a different poster', () => {
    const saint = story();
    card(saint, 'thanks_vs_swears').numbers = { thanks: 300, pleases: 200, fbombs: 6 };
    saint.models.worst = null;
    saint.cards = saint.cards.filter(c => c.id !== 'mood_drift' && c.id !== 'night_owl');
    saint.highlights.mostExpensivePrompt = null;
    saint.totals.longestStretchHours = 2;
    const picks = pickFunFacts(saint).map(f => f.id);
    expect(picks[0]).toBe('manners');
    expect(factText(rankFunFacts(saint)[0]!.parts)).toBe('50 thank-yous per f-bomb');
    expect(picks).not.toEqual(pickFunFacts(story()).map(f => f.id));
  });

  it('picks at most two facts per family and at most the limit', () => {
    const picks = pickFunFacts(story(), 6);
    expect(picks).toHaveLength(6);
    const families = new Map<string, number>();
    for (const f of picks) families.set(f.family, (families.get(f.family) ?? 0) + 1);
    for (const n of families.values()) expect(n).toBeLessThanOrEqual(2);
    expect(pickFunFacts(story(), 3)).toHaveLength(3);
  });

  it('documents a guard and a score formula for every catalogue entry', () => {
    for (const entry of CATALOGUE) {
      expect(entry.guard.length, entry.id).toBeGreaterThan(5);
      expect(entry.score.length, entry.id).toBeGreaterThan(1);
    }
    expect(new Set(CATALOGUE.map(c => c.id)).size).toBe(CATALOGUE.length);
    void storyOfFixture;
  });
});
