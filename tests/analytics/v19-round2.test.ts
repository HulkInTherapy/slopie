import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanup, claudeAssistant, claudeUser, codexRollout, home, run, at} from './v19-helpers.js';
import {PriceBook, usageCost} from '../../packages/core/src/analytics/pricing.js';
import {aggregate} from '../../packages/core/src/analytics/aggregate.js';
import {buildStoryTable} from '../../packages/core/src/analytics/story-table.js';
import {extractFile, type UsageFact} from '../../packages/core/src/analytics/extract.js';

// Synthetic fixtures only.
afterEach(cleanup);
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const rollout = (dir: string, name: string) => path.join(dir, 'sessions', '2026', '10', '01', name);
const usage = (input: number, output: number, cached = 0) => ({input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output});
const fact = (model: string, input: number, output: number): UsageFact => ({key: null, at: null, model, provider: null, input, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0});

/** A Claude session long enough to compare copies (each prompt has an answer). */
function claudeSession(sessionId: string, prompts: number, from = 0, word = 'synthetic') {
  const rows: unknown[] = [];
  for (let i = from; i < from + prompts; i++) {
    rows.push(claudeUser(`${sessionId}-u${i}`, `${word} request number ${i} ${'padding '.repeat(40)}`, i * 2, sessionId));
    rows.push(claudeAssistant(`${sessionId}-m${i}`, i * 2 + 1, sessionId));
  }
  return rows;
}

describe('cold run: prefix copies of a session are not parsed', () => {
  it('skips an archive snapshot that is a prefix of the live transcript, with identical numbers', async () => {
    const a = home(), b = home();
    for (const h of [a, b]) h.write(path.join(h.dirs.claude, 'projects', 'p', 's1.jsonl'), claudeSession('s1', 30));
    // Archive copy taken when the session had 20 prompts.
    a.write(path.join(a.dirs.potsherd, 'archive', 'evidence', 'snap.jsonl'), claudeSession('s1', 20));
    // A Codex rollout moved to archived_sessions while an older prefix copy stayed in sessions/.
    const id = '33333333-0000-4000-8000-000000000001';
    for (const h of [a, b]) h.write(path.join(h.dirs.codex, 'archived_sessions', 'rollout-z.jsonl'), codexRollout({id, turns: 40}));
    a.write(rollout(a.dirs.codex, 'rollout-z.jsonl'), codexRollout({id, turns: 25}));
    const withCopies = await run(a.options), alone = await run(b.options);
    expect(withCopies.timings!['copiesSkipped']).toBe(2);
    expect(alone.timings!['copiesSkipped']).toBe(0);
    for (const s of [withCopies, alone]) { expect(s.launch!.facts!.recordedResponses).toBe(70); expect(s.metrics.humanPrompts.value).toBe(70); }
    expect(withCopies.usage.costUsd).toBeCloseTo(alone.usage.costUsd!, 9);
    expect(withCopies.launch!.story!.totals.tokens).toBe(alone.launch!.story!.totals.tokens);
    // Warm: the prefix relation is reused without reading either file again.
    const warm = await run(a.options);
    expect(warm.timings!['copiesSkipped']).toBe(2);
    expect(warm.timings!['copyVerifyReads']).toBe(0);
    expect(warm.metrics.humanPrompts.value).toBe(70);
  });

  it('parses a divergent copy in full and merges its tail', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), claudeSession('s1', 30));
    // Same first 20 prompts, then a different continuation (a rewind / fork the live file no longer has).
    write(path.join(dirs.potsherd, 'archive', 'evidence', 'fork.jsonl'), [...claudeSession('s1', 20), ...claudeSession('s1', 5, 100, 'divergent')]);
    const s = await run(options);
    expect(s.timings!['copiesSkipped']).toBe(0);
    expect(s.metrics.humanPrompts.value).toBe(35);
    expect(s.launch!.facts!.recordedResponses).toBe(35);
  });
});

describe('archive classification beyond the first block', () => {
  it('reads a Claude archive copy that opens with >64 KB of metadata, and reports unclassifiable files', async () => {
    const {dirs, options, write} = home();
    const evidence = path.join(dirs.potsherd, 'archive', 'evidence');
    write(path.join(evidence, 'meta.jsonl'), [{type: 'file-history-snapshot', messageId: 'x', snapshot: {blob: 'z'.repeat(200 * 1024)}}, ...claudeSession('rescued', 3)]);
    write(path.join(evidence, 'junk.jsonl'), [{kind: 'not-a-transcript', n: 1}]);
    // An archived copy of typed-prompt log lines is not a transcript and not a gap.
    write(path.join(evidence, 'typed.jsonl'), [{display: 'synthetic typed line', pastedContents: {}, timestamp: 1, project: '/work/x'}]);
    const s = await run(options);
    expect(s.metrics.humanPrompts.value).toBe(3);
    expect(s.warnings).toContain('archive_unclassified:1');
    expect(s.coverage.gapCodes).toContain('archive_source_unclassified');
  });
});

describe('deferred Codex compactions are priced at request time', () => {
  it('uses the model and tier in force when token_usage_record was written, not the final ones', async () => {
    const {dirs, options, write} = home();
    const t = (m: number) => at(m);
    write(rollout(dirs.codex, 'rollout-c.jsonl'), [
      {timestamp: t(0), type: 'session_meta', payload: {id: '44444444-0000-4000-8000-000000000001', timestamp: t(0), cwd: '/work/synthetic', originator: 'codex_work_desktop', source: 'vscode'}},
      {timestamp: t(1), type: 'event_msg', payload: {type: 'task_started', turn_id: 'turn-1'}},
      {timestamp: t(1), type: 'event_msg', payload: {type: 'item_completed', turn_id: 'turn-1', item: {type: 'UserMessage', id: 'item-1', content: [{type: 'input_text', text: 'synthetic first request'}]}}},
      {timestamp: t(2), type: 'turn_context', payload: {model: 'gpt-5.6-sol', cwd: '/work/synthetic'}},
      {timestamp: t(2), type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: {service_tier: 'default'}}},
      {timestamp: t(3), type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: usage(1000, 100), total_token_usage: usage(1000, 100)}}},
      {timestamp: t(4), type: 'event_msg', payload: {type: 'token_usage_record', response_id: 'resp-compact', usage: usage(300_000, 5000)}},
      {timestamp: t(4), type: 'compacted', payload: {message: '', compaction_response_id: 'resp-compact'}},
      {timestamp: t(5), type: 'event_msg', payload: {type: 'task_started', turn_id: 'turn-2'}},
      {timestamp: t(5), type: 'event_msg', payload: {type: 'item_completed', turn_id: 'turn-2', item: {type: 'UserMessage', id: 'item-2', content: [{type: 'input_text', text: 'synthetic second request'}]}}},
      {timestamp: t(6), type: 'turn_context', payload: {model: 'gpt-6.1-sol', cwd: '/work/synthetic'}},
      {timestamp: t(6), type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: {service_tier: 'priority'}}},
      {timestamp: t(7), type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: usage(2000, 200), total_token_usage: usage(3000, 300)}}},
    ]);
    const s = await run(options);
    const facts = s.launch!.facts!;
    expect(facts.compactionResponses).toBe(1);
    const old = facts.models.find(m => m.model === 'gpt-5.6-sol')!;
    expect(old.responses).toBe(2);
    const book = new PriceBook();
    const expected = usageCost(fact('gpt-5.6-sol', 1000, 100), book.lookup('gpt-5.6-sol')!) + usageCost(fact('gpt-5.6-sol', 300_000, 5000), book.lookup('gpt-5.6-sol')!);
    expect(old.valueUsd).toBeCloseTo(expected, 9);
    expect(facts.models.find(m => m.model === 'gpt-6.1-sol')!.responses).toBe(1);
  });
});

describe('unknown Codex identities stay unknown', () => {
  it('codex-auto-review usage is unpriced, outside measured spend and model share', async () => {
    const {dirs, options, write} = home();
    write(rollout(dirs.codex, 'rollout-r.jsonl'), codexRollout({id: '55555555-0000-4000-8000-000000000001', turns: 2, model: 'codex-auto-review'}));
    write(rollout(dirs.codex, 'rollout-k.jsonl'), codexRollout({id: '55555555-0000-4000-8000-000000000002', turns: 1, model: 'gpt-6-sol'}));
    const s = await run(options);
    const facts = s.launch!.facts!, story = s.launch!.story!;
    expect(facts.unpricedResponses).toBe(2);
    expect(facts.unpricedTokens).toBe(2200);
    expect(story.spend.unpricedTokens).toBe(2200);
    expect(facts.models.map(m => m.model)).not.toContain('gpt-5.6-luna');
    expect(facts.models.map(m => m.model)).not.toContain('gpt-5');
    expect(story.modelShare.rows.map(r => r.model)).toEqual(['gpt-6-sol']);
    const known = usageCost(fact('gpt-6-sol', 1000, 100), new PriceBook().lookup('gpt-6-sol')!);
    expect(story.spend.measuredUsd).toBeCloseTo(known, 2);
  });
  it('a name that shares only a vendor word with the catalog is not given a family price', () => {
    const book = new PriceBook();
    expect(book.lookup('codex-auto-review')).toBeNull();
    expect(book.lookup('gpt-mystery-helper')).toBeNull();
  });
});

describe('estimate for history-only prompts', () => {
  it('values them at the median (p25–p75) Claude per-prompt turn cost of the nearest months with ≥50 priced prompts', async () => {
    const {dirs, options, write} = home();
    const rows: unknown[] = [];
    const costs: number[] = [];
    const book = new PriceBook();
    for (let i = 0; i < 60; i++) {
      const out = 100 * (i + 1);
      rows.push(claudeUser(`u${i}`, `synthetic logged prompt ${i}`, i * 10, 's1'), claudeAssistant(`m${i}`, i * 10 + 1, 's1', 'claude-sonnet-4-6', {input_tokens: 1000, output_tokens: out}));
      costs.push(usageCost(fact('claude-sonnet-4-6', 1000, out), book.lookup('claude-sonnet-4-6')!));
    }
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), rows);
    // A Codex month with plenty of prompts must not be used: history-only prompts are Claude prompts.
    write(rollout(dirs.codex, 'rollout-e.jsonl'), codexRollout({id: '66666666-0000-4000-8000-000000000001', turns: 60, base: '2026-08-01T10:00:00Z', output: 1_000_000}));
    write(path.join(dirs.claude, 'history.jsonl'), Array.from({length: 10}, (_, i) => ({display: `synthetic typed prompt number ${i}`, timestamp: Date.parse(at(i, '2026-06-10T10:00:00Z')), project: '/work/x', sessionId: 'gone'})));
    const s = await run(options);
    const est = s.launch!.story!.spend.estimated!;
    costs.sort((x, y) => x - y);
    const q = (p: number) => { const k = (costs.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k); return costs[lo]! + (costs[hi]! - costs[lo]!) * (k - lo); };
    expect(est.prompts).toBe(10);
    expect(est.midUsd).toBeCloseTo(10 * q(0.5), 2);
    expect(est.lowUsd).toBeCloseTo(10 * q(0.25), 2);
    expect(est.highUsd).toBeCloseTo(10 * q(0.75), 2);
    expect(est.basis).toContain('2026-10');
    expect(est.basis).not.toContain('2026-08');
    expect(est.basis).toMatch(/median/);
  });
});

describe('word counters come from deduplicated prompts', () => {
  it('a divergent tail of a non-primary copy contributes its words; shared prompts count once', () => {
    const {dirs, write} = home();
    const id = '77777777-0000-4000-8000-000000000001';
    const live = write(rollout(dirs.codex, 'rollout-w.jsonl'), codexRollout({id, turns: 3}));
    const tail = {timestamp: at(500), type: 'event_msg', payload: {type: 'item_completed', turn_id: 'turn-x', item: {type: 'UserMessage', id: 'item-divergent', content: [{type: 'input_text', text: 'quokka requested'}]}}};
    const copy = write(path.join(dirs.potsherd, 'archive', 'evidence', 'w.jsonl'), [...codexRollout({id, turns: 1}), {timestamp: at(499), type: 'event_msg', payload: {type: 'task_started', turn_id: 'turn-x'}}, tail]);
    const sources = [extractFile(live, 'codex', {timezone: 'UTC'}), extractFile(copy, 'codex', {timezone: 'UTC', archive: true})];
    const a = aggregate({sources, history: [], historyFile: null, scope: {harnesses: ['codex'], project: null, eventFrom: null, asOf: null, timezone: 'UTC'},
      policy: {ignored: () => false, forgotten: new Set()}, book: new PriceBook(), codexFastDefault: false, snapshotId: 'x'});
    const table = buildStoryTable({aggregate: a, history: [], historyCounters: new Map(), historyFile: null, timezone: 'UTC', allowed: () => true});
    expect(table.rows).toHaveLength(4);
    expect(table.vocab.get('quokka')).toBe(1);
    expect(table.vocab.get('synthetic')).toBe(3);
  });
});

describe('warm run: adapter sources are cached', () => {
  it('parses Cursor sources once and reuses their facts while size and mtime are unchanged', async () => {
    const {dirs, options} = home();
    const cursorDir = path.join(dirs.root, 'cursor');
    fs.cpSync(path.join(FIXTURES, 'cursor'), cursorDir, {recursive: true});
    const cold = await run({...options, cursorDir});
    expect(cold.timings!['adapterSourcesParsed']).toBeGreaterThan(0);
    const warm = await run({...options, cursorDir});
    expect(warm.timings!['adapterSourcesParsed']).toBe(0);
    expect(warm.sources.find(x => x.harness === 'cursor')!.humanPrompts).toBe(cold.sources.find(x => x.harness === 'cursor')!.humanPrompts);
    expect(warm.metrics.humanPrompts.value).toBe(cold.metrics.humanPrompts.value);
    // A changed source is parsed again.
    const file = path.join(cursorDir, 'projects', 'Users-example-demo-app', 'agent-transcripts', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
    fs.appendFileSync(file, '\n');
    const changed = await run({...options, cursorDir});
    expect(changed.timings!['adapterSourcesParsed']).toBeGreaterThan(0);
  });
});

describe('archive copies of compressed rollouts', () => {
  type Z = typeof import('node:zlib') & {zstdCompressSync?: (b: Buffer) => Buffer};
  const setup = async (copy: (rows: unknown[], id: string) => unknown[]) => {
    const zlib = (await import('node:zlib')) as Z;
    const h = home();
    const id = '99999999-0000-4000-8000-000000000001';
    const rows = codexRollout({id, turns: 40});
    const zfile = path.join(h.dirs.codex, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${id}.jsonl.zst`);
    fs.mkdirSync(path.dirname(zfile), {recursive: true});
    fs.writeFileSync(zfile, zlib.zstdCompressSync!(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n')));
    h.write(path.join(h.dirs.potsherd, 'archive', 'evidence', 'copy.jsonl'), copy(rows, id));
    return h;
  };
  it('skips an uncompressed archive copy proven a prefix while the .zst rollout is decompressed', async () => {
    const {options} = await setup(rows => rows.slice(0, 1 + 5 * 30));
    const s = await run(options);
    expect(s.timings!['copiesVerifiedInReader']).toBe(1);
    expect(s.timings!['copiesSkipped']).toBe(1);
    expect(s.launch!.facts!.recordedResponses).toBe(40);
    const warm = await run(options);
    expect(warm.timings!['copiesSkipped']).toBe(1);
    expect(warm.launch!.facts!.recordedResponses).toBe(40);
    expect(warm.metrics.humanPrompts.value).toBe(40);
  });
  it('reads a copy of the same session that diverges from the rollout', async () => {
    const {options} = await setup((rows, id) => [...rows.slice(0, 1 + 5 * 30), ...codexRollout({id, turns: 3, from: 30, startTotal: 1000})]);
    const s = await run(options);
    expect(s.timings!['copiesVerifiedInReader']).toBe(0);
    expect(s.timings!['copiesSkipped']).toBe(0);
    expect(s.launch!.facts!.recordedResponses).toBe(43);
  });
});

describe('compressed rollouts are decompressed as a stream', () => {
  it('a multi-megabyte .zst yields the same facts and copy hashes as its uncompressed bytes', async () => {
    const zlib = (await import('node:zlib')) as typeof import('node:zlib') & {zstdCompressSync?: (b: Buffer, o?: unknown) => Buffer};
    const {createHash} = await import('node:crypto');
    const {dirs, write} = home();
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    // Incompressible tool output keeps the compressed file above one 1 MB input step.
    const rows = codexRollout({id, turns: 60});
    const noise = (i: number) => createHash('sha512').update(String(i)).digest('base64').repeat(1);
    const big: unknown[] = [];
    for (const [i, r] of rows.entries()) { big.push(r); big.push({timestamp: at(i), type: 'response_item', payload: {type: 'function_call_output', call_id: `c${i}`, output: Array.from({length: 600}, (_, k) => noise(i * 1000 + k)).join('')}}); }
    const plain = write(rollout(dirs.codex, `rollout-plain-${id}.jsonl`), big);
    const bytes = fs.readFileSync(plain);
    const zfile = path.join(dirs.codex, 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-00-00-${id}.jsonl.zst`);
    fs.mkdirSync(path.dirname(zfile), {recursive: true});
    fs.writeFileSync(zfile, zlib.zstdCompressSync!(bytes));
    expect(fs.statSync(zfile).size).toBeGreaterThan(2 * 1024 * 1024);
    const checks = [5000, 1_500_000, bytes.length - 7, bytes.length, bytes.length + 10];
    const z = extractFile(zfile, 'auto', {timezone: 'UTC', checks});
    const p = extractFile(plain, 'codex', {timezone: 'UTC'});
    expect(z.usage).toEqual(p.usage);
    expect(z.prompts.map(x => x.key)).toEqual(p.prompts.map(x => x.key));
    const sha = (b: Buffer) => createHash('sha1').update(b).digest('base64');
    expect(z.copyHashes).toEqual({head: sha(bytes.subarray(0, 4096)), at: checks.filter(c => c <= bytes.length).map(c => [c, sha(bytes.subarray(c - 4096, c))])});
  });
});
