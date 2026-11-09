import {describe, expect, it} from 'vitest';
import {featurize, safeQuote, FLAG, has} from '../../packages/core/src/analytics/story-lexicon.js';
import {runDetectors, type DetectorContext} from '../../packages/core/src/analytics/story-detectors.js';
import {ARCHETYPES, archetypeCode, archetypeMetrics, assignArchetype, storyAwards} from '../../packages/core/src/analytics/story-archetype.js';
import {localClock} from '../../packages/core/src/analytics/story-time.js';
import type {StoryRow, StoryTable} from '../../packages/core/src/analytics/story-table.js';

// SYNTHETIC rows only: generated text, placeholder projects, made-up models.
const clock = localClock('UTC');
const DAY = 86_400_000;
interface Spec {ts: number; text?: string; conv?: string; project?: string; model?: string | null; subs?: number; gap?: number | null; intr?: boolean | null; cost?: number}
function row(spec: Spec, i: number): StoryRow {
  const f = featurize({text: spec.text ?? 'update the synthetic parser', typed: true});
  const local = clock(spec.ts);
  return {
    id: `p${i}`, conv: spec.conv ?? `c${Math.floor(i / 10)}`, harness: 'codex', ts: spec.ts, project: spec.project ?? '/work/synthetic-app',
    model: spec.model === undefined ? 'synthetic-model-a' : spec.model, modelSrc: spec.model === null ? 'none' : 'observed', turn: (i % 10) + 1,
    gapReplyS: spec.gap === undefined ? 300 : spec.gap, gapPromptS: null, intr: spec.intr === undefined ? false : spec.intr, prevIntr: false,
    costUsd: spec.cost ?? 0.5, costTotalUsd: spec.cost ?? 0.5, outTokens: 100, durS: 30, tools: 1, subs: spec.subs ?? 0,
    day: local.day, month: local.month, hour: local.hour, minute: local.minute, dow: local.dow,
    f, q: safeQuote(spec.text ?? 'update the synthetic parser'), typed: true, angry: f.sw > 0 || f.ins > 0, polite: has(f, FLAG.polite),
  };
}
const rows = (specs: Spec[]) => specs.map(row).sort((a, b) => a.ts - b.ts);
const T0 = Date.UTC(2026, 0, 5, 14);
const many = (n: number, f: (i: number) => Partial<Spec>) => Array.from({length: n}, (_, i) => ({ts: T0 + (i % 120) * DAY + i * 60_000, ...f(i)}));

describe('archetypes 1.9', () => {
  it('has 22 archetypes with unique ids, each with a tagline quoting a real number or word', () => {
    expect(ARCHETYPES).toHaveLength(22);
    expect(new Set(ARCHETYPES.map(a => a.id)).size).toBe(22);
    const m = archetypeMetrics(rows(many(400, i => ({text: i % 3 ? 'continue' : 'why is the synthetic parser slow?', subs: i % 5}))));
    for (const a of ARCHETYPES) for (const t of a.taglines) expect(t(m), a.id).toMatch(/\d|'[a-z]/i);
  });

  it('K/H compares please+thanks with swears, not "polite" words like "perfect"', () => {
    // 8 swearing prompts for every thank-you, and lots of "perfect"/"awesome" (which count as polite).
    const specs = many(450, i => ({text: i % 9 === 0 ? 'thanks for the synthetic fix' : i % 9 <= 8 && i % 9 > 0 && i % 2 ? 'this damn synthetic parser broke' : 'perfect awesome synthetic result'}));
    const m = archetypeMetrics(rows(specs));
    expect(m.polite).toBeGreaterThan(m.swear);
    expect(archetypeCode(m)[3]).toBe('H');
    expect(assignArchetype(rows(specs)).code[3]).toBe('H');
  });

  it('crowns Middle Management from subagents and The Esc Artist from interrupts', () => {
    const boss = assignArchetype(rows(many(400, i => ({subs: i % 2 ? 3 : 0, text: 'synthetic review pass number ' + (i % 7)}))));
    expect(boss.scores.find(s => s.id === 'conductor')!.score).toBeGreaterThan(0.8);
    const esc = archetypeMetrics(rows(many(400, i => ({intr: i % 5 === 0}))));
    expect(esc.intrRate).toBeCloseTo(20, 0);
    const gated = archetypeMetrics(rows(many(250, i => ({intr: i < 60 ? i % 5 === 0 : null}))));
    expect(gated.intrTurns).toBe(60);
  });

  it('only the runner-up above 0.5 becomes a sub-role; a strong pair becomes a legendary combo', () => {
    // Long structured specs (architect) and hundreds of subagents (conductor), both at the top of their scales.
    const spec = '- step one of the synthetic plan\n- step two\n- step three\n- step four\n' + Array.from({length: 100}, (_, k) => `word${k}`).join(' ');
    const cto = assignArchetype(rows(many(400, i => ({text: spec, subs: 6, conv: `c${i % 50}`, model: `synthetic-model-${i % 3}`, project: `/work/synthetic-${i % 3}`}))));
    expect(cto.title).toBe('The CTO');
    expect(cto.rarity).toBe('legendary');
    expect(cto.subRole).toBeNull();
    // A weak runner-up is not a sub-role.
    const plain = assignArchetype(rows(many(300, () => ({text: 'why is the synthetic parser slow?'}))));
    if (plain.scores[1]!.score < 0.5) expect(plain.subRole).toBeNull();
  });

  it('is deterministic for the same rows', () => {
    const specs = many(300, i => ({text: i % 2 ? 'continue' : 'why is the synthetic test red?'}));
    expect(assignArchetype(rows(specs))).toEqual(assignArchetype(rows(specs)));
  });
});

describe('awards 1.9', () => {
  const ctx = (rs: StoryRow[]): DetectorContext => ({table: {rows: rs, vocab: new Map(), topics: new Map(), sessions: []} as StoryTable, rows: rs, dictionary: null, alias: () => 'Project A', home: '/home/synthetic'});

  it('ranks at most six, two gold, every receipt carrying a number', () => {
    const specs = many(600, i => ({text: i % 4 ? 'damn this synthetic thing' : 'continue', subs: i % 3, cost: i === 77 ? 400 : 0.4, intr: i % 7 === 0}));
    const rs = rows(specs);
    const {drafts} = runDetectors(ctx(rs), ts => clock(ts - 6 * 3_600_000).day);
    const shelf = storyAwards(rs, drafts);
    expect(shelf.length).toBeGreaterThanOrEqual(3);
    expect(shelf.length).toBeLessThanOrEqual(6);
    expect(shelf.filter(a => a.tier === 'gold')).toHaveLength(2);
    for (const a of shelf) { expect(a.receipt).toMatch(/\d/); expect(a.publicReceipt).not.toContain('synthetic-app'); }
    const scores = shelf.map(a => a.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('awards Character Development when the latest month is under half the peak', () => {
    const specs = [
      ...Array.from({length: 100}, (_, i) => ({ts: Date.UTC(2026, 2, 1 + (i % 28), 12), text: i % 4 ? 'this damn synthetic parser' : 'ok synthetic'})),
      ...Array.from({length: 100}, (_, i) => ({ts: Date.UTC(2026, 3, 1 + (i % 28), 12), text: i % 20 ? 'ok synthetic step' : 'damn synthetic'})),
      ...Array.from({length: 100}, (_, i) => ({ts: Date.UTC(2026, 1, 1 + (i % 27), 12), text: 'ok synthetic start'})),
    ];
    const rs = rows(specs);
    const shelf = storyAwards(rs, new Map());
    expect(shelf.map(a => a.id)).toContain('redemption');
  });
});
