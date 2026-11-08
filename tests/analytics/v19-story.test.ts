import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {cleanup, claudeAssistant, claudeUser, home, run, at, codexRollout} from './v19-helpers.js';
import {PriceBook} from '../../packages/core/src/analytics/pricing.js';
import {aggregate} from '../../packages/core/src/analytics/aggregate.js';
import {buildStoryTable} from '../../packages/core/src/analytics/story-table.js';
import {extractFile} from '../../packages/core/src/analytics/extract.js';

afterEach(cleanup);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('model share is observed only (no cross-day imputation)', () => {
  it('history-only prompts next to an Opus day stay unknown; quiz and modelShare count observed prompts only', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [claudeUser('u1', 'synthetic live prompt', 0), claudeAssistant('m1', 1, 's1', 'claude-opus-5-5', {input_tokens: 100, output_tokens: 900})]);
    // 30 history-only prompts on the next days (old code imputed the neighbouring day's model to them).
    write(path.join(dirs.claude, 'history.jsonl'), Array.from({length: 30}, (_, i) => ({display: `synthetic typed prompt number ${i}`, timestamp: Date.parse(at(60 * 24 + i)), project: '/work/x', sessionId: 'gone'})));
    fs.writeFileSync(path.join(dirs.claude, 'stats-cache.json'), JSON.stringify({lastComputedDate: '2026-09-01', dailyModelTokens: [{date: '2026-10-02', tokensByModel: {'claude-opus-4-6': 999999}}], modelUsage: {}}));
    const s = await run(options);
    const story = s.launch!.story!;
    expect(story.models.top.map(t => t.model)).toEqual(['claude-opus-5-5']);
    expect(story.models.top[0]!.prompts).toBe(1);
    expect(story.modelShare.basis).toBe('output_tokens');
    expect(story.modelShare.rows.map(r => r.model)).toEqual(['claude-opus-5-5']);
    expect(story.modelShare.unknownModelPrompts).toBe(30);
  });
  it('aliases of one model are one row with 100% (A#10) and shares sum to 100 (A#18)', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [
      claudeUser('u1', 'synthetic one', 0), claudeAssistant('m1', 1, 's1', 'claude-opus-4-6'),
      claudeUser('u2', 'synthetic two', 5), claudeAssistant('m2', 6, 's1', 'claude-opus-4-6-20260101'),
      claudeUser('u3', 'synthetic three', 10), claudeAssistant('m3', 11, 's1', 'anthropic/claude-opus-4-6'),
    ]);
    write(path.join(dirs.codex, 'sessions', 'rollout-a.jsonl'), codexRollout({id: '88888888-0000-4000-8000-000000000001', turns: 1, output: 150}));
    write(path.join(dirs.codex, 'sessions', 'rollout-b.jsonl'), codexRollout({id: '88888888-0000-4000-8000-000000000002', turns: 1, model: 'gpt-6.1-sol', output: 150}));
    const snap = await run(options);
    const story = snap.launch!.story!;
    expect(snap.launch!.facts!.models.filter(m => m.model === 'claude-opus-4-6')).toHaveLength(1);
    expect(snap.launch!.facts!.models.find(m => m.model === 'claude-opus-4-6')!.provider).toBe('anthropic');
    const rows = story.modelShare.rows;
    expect(rows.filter(r => r.label === 'Opus 4.6')).toHaveLength(1);
    expect(rows[0]!.model).toBe('claude-opus-4-6');
    expect(rows[0]!.outputTokens).toBe(300);
    expect(sum(rows.map(r => r.tokenSharePct))).toBe(100);
    expect(sum(rows.map(r => r.promptSharePct))).toBe(100);
    expect(sum(rows.map(r => r.spendSharePct))).toBe(100);
    expect(sum(story.spend.byHarness.map(h => h.sharePct))).toBe(100);
    expect(story.models.top.filter(t => t.label === 'Opus 4.6')).toHaveLength(1);
  });
});

describe('A#9 undated prompts count in the headline', () => {
  it('a human prompt without a timestamp is in totals.prompts', async () => {
    const {dirs, options, write} = home();
    const u = claudeUser('u1', 'synthetic undated prompt', 0) as Record<string, unknown>;
    delete u.timestamp;
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [u]);
    const s = await run(options);
    expect(s.metrics.humanPrompts.value).toBe(1);
    expect(s.launch!.story!.totals.prompts).toBe(1);
    expect(s.launch!.story!.totals.undatedPrompts).toBe(1);
    expect(s.launch!.story!.totals.sessions).toBe(1);
  });
});

describe('A#12 scoped stories only see their own words', () => {
  it('a since-October story drops January vocabulary of the same pi file', () => {
    const {dirs, write} = home();
    const file = write(path.join(dirs.pi, 's.jsonl'), [
      {type: 'session', id: 'pi-scope', cwd: '/work/synthetic', timestamp: '2026-01-05T10:00:00Z'},
      {type: 'message', id: 'u1', timestamp: '2026-01-05T10:01:00Z', message: {role: 'user', content: 'legacyword legacyword legacyword'}},
      {type: 'message', id: 'u2', timestamp: '2026-10-05T10:01:00Z', message: {role: 'user', content: 'freshword'}},
    ]);
    const facts = extractFile(file, 'pi', {timezone: 'UTC'});
    const a = aggregate({sources: [facts], history: [], historyFile: null, scope: {harnesses: ['pi'], project: null, eventFrom: Date.parse('2026-10-01T00:00:00Z'), asOf: null, timezone: 'UTC'},
      policy: {ignored: () => false, forgotten: new Set()}, book: new PriceBook(), codexFastDefault: false, snapshotId: 'x'});
    const table = buildStoryTable({aggregate: a, history: [], historyCounters: new Map(), historyFile: null, timezone: 'UTC', allowed: () => true,
      dateAllowed: d => d >= '2026-10-01', undatedAllowed: false});
    expect(table.rows).toHaveLength(1);
    expect(table.vocab.get('legacyword')).toBeUndefined();
    expect(table.vocab.get('freshword')).toBe(1);
  });
});

describe('spend: measured, recovered, estimated', () => {
  it('prices the stats-cache residual as recovered, never as measured', async () => {
    const {dirs, options, write} = home();
    // One logged Opus 4.6 request inside the stats-cache era: it must be subtracted from the cache totals.
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [claudeUser('u1', 'synthetic', 0), claudeAssistant('m1', 1, 's1', 'claude-opus-4-6', {input_tokens: 200_000, output_tokens: 20_000})]);
    fs.writeFileSync(path.join(dirs.claude, 'stats-cache.json'), JSON.stringify({
      version: 2, lastComputedDate: '2026-10-15', firstSessionDate: '2026-08-01T00:00:00Z',
      dailyModelTokens: [{date: '2026-08-10', tokensByModel: {'claude-opus-4-6': 300}}, {date: '2026-09-10', tokensByModel: {'claude-opus-4-6': 100}}],
      modelUsage: {'claude-opus-4-6': {inputTokens: 1_200_000, outputTokens: 120_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 400_000, costUSD: 0}},
    }));
    const s = await run(options);
    const spend = s.launch!.story!.spend;
    const r = new PriceBook().lookup('claude-opus-4-6')!.rates;
    const measured = (200_000 * r.input + 20_000 * r.output) / 1e6;
    const recovered = (1_000_000 * r.input + 100_000 * r.output + 2_000_000 * r.cacheRead + 400_000 * r.cacheWrite) / 1e6;
    expect(spend.measuredUsd).toBeCloseTo(measured, 2);
    expect(spend.recoveredUsd).toBeCloseTo(recovered, 2);
    const aug = spend.monthly.find(m => m.month === '2026-08')!, sep = spend.monthly.find(m => m.month === '2026-09')!;
    expect(aug.recoveredUsd).toBeCloseTo(recovered * 0.75, 1);
    expect(sep.recoveredUsd).toBeCloseTo(recovered * 0.25, 1);
    expect(sum(spend.monthly.map(m => m.measuredUsd))).toBeCloseTo(measured, 2);
    expect(spend.monthly.map(m => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(s.usage.costUsd).toBeCloseTo(measured, 4);
  });
  it('estimates history-only prompts from the nearest months with token logs, as a labelled range', async () => {
    const {dirs, options, write} = home();
    const rows: unknown[] = [];
    for (let i = 0; i < 25; i++) rows.push(claudeUser(`u${i}`, `synthetic logged prompt ${i}`, i * 10), claudeAssistant(`m${i}`, i * 10 + 1, 's1', 'claude-sonnet-4-6', {input_tokens: 100_000, output_tokens: 10_000}));
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), rows);
    write(path.join(dirs.claude, 'history.jsonl'), Array.from({length: 10}, (_, i) => ({display: `synthetic history-only prompt ${i}`, timestamp: Date.parse('2026-12-03T10:00:00Z') + i * 60_000, project: '/work/x', sessionId: 'gone'})));
    const s = await run(options);
    const spend = s.launch!.story!.spend;
    const perPrompt = spend.measuredUsd / 25;
    expect(spend.estimated).not.toBeNull();
    expect(spend.estimated!.prompts).toBe(10);
    expect(spend.estimated!.lowUsd).toBeCloseTo(perPrompt * 10, 1);
    expect(spend.estimated!.highUsd).toBeCloseTo(perPrompt * 10, 1);
    expect(spend.estimated!.basis).toContain('2026-10');
    expect(spend.monthly.find(m => m.month === '2026-12')!.estimatedUsd).toBeCloseTo(perPrompt * 10, 1);
    expect(spend.monthly.find(m => m.month === '2026-11')!.prompts).toBe(0);
    expect(spend.measuredUsd).toBeCloseTo(s.usage.costUsd!, 2);
  });
  it('buckets the daily series in local time and finds the priciest day', async () => {
    const {dirs, options, write} = home('Asia/Kolkata');
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [
      {...claudeUser('u1', 'synthetic late', 0), timestamp: '2026-10-01T18:10:00Z'}, {...claudeAssistant('m1', 0, 's1', 'claude-sonnet-4-6', {input_tokens: 1_000_000, output_tokens: 0}), timestamp: '2026-10-01T18:11:00Z'},
      {...claudeUser('u2', 'synthetic past midnight', 0), timestamp: '2026-10-01T18:40:00Z'}, {...claudeAssistant('m2', 0, 's1', 'claude-sonnet-4-6', {input_tokens: 2_000_000, output_tokens: 0}), timestamp: '2026-10-01T18:41:00Z'},
    ]);
    const spend = (await run(options)).launch!.story!.spend;
    expect(spend.daily.map(d => [d.day, d.prompts])).toEqual([['2026-10-01', 1], ['2026-10-02', 1]]);
    expect(spend.priciestDay!.day).toBe('2026-10-02');
    expect(spend.perActiveDayUsd).toBeCloseTo(spend.measuredUsd / 2, 2);
  });
  it('codex exec cost is measured even though the run is not a chat', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.codex, 'sessions', 'rollout-e.jsonl'), codexRollout({id: '99999999-0000-4000-8000-000000000001', turns: 1, originator: 'codex_exec', source: 'exec', model: 'gpt-5.4', input: 1_000_000}));
    const story = (await run(options)).launch!.story!;
    expect(story.spend.measuredUsd).toBeGreaterThan(0);
    expect(story.spend.byHarness[0]!.harness).toBe('codex');
    expect(story.totals.sessions).toBe(0);
    expect(story.totals.automatedRuns).toBe(1);
  });
});
