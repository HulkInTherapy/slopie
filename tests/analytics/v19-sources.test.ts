import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {cleanup, claudeAssistant, claudeUser, codexRollout, home, jsonl, run, at} from './v19-helpers.js';

afterEach(cleanup);
const rollout = (dir: string, name: string) => path.join(dir, 'sessions', '2026', '10', '01', name);
type Z = typeof zlib & {zstdCompressSync?: (b: Buffer) => Buffer};
const zstd = (rows: unknown[]) => (zlib as Z).zstdCompressSync!(Buffer.from(jsonl(rows)));

describe('A#1 Codex counters are scoped to the session lineage', () => {
  it('two independent sessions with identical first-turn counters both count', async () => {
    const {dirs, options, write} = home();
    write(rollout(dirs.codex, 'rollout-a.jsonl'), codexRollout({id: '11111111-0000-4000-8000-000000000001', turns: 1}));
    write(rollout(dirs.codex, 'rollout-b.jsonl'), codexRollout({id: '11111111-0000-4000-8000-000000000002', turns: 1}));
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(2);
    expect(s.usage.inputTokens).toBe(2000);
    expect(s.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(2);
  });
  it('a Codex fork replaying its parent counts the copied requests once and its own tail', async () => {
    const {dirs, options, write} = home();
    const parent = '11111111-0000-4000-8000-0000000000a1', fork = '11111111-0000-4000-8000-0000000000a2';
    write(rollout(dirs.codex, 'rollout-p.jsonl'), codexRollout({id: parent, turns: 2}));
    const copied = codexRollout({id: parent, turns: 2}).slice(1);
    const forkRows = [codexRollout({id: fork, turns: 1, forkedFrom: parent})[0], ...copied, ...codexRollout({id: fork, turns: 1, from: 5, startTotal: 2 - 5 + 0, base: '2026-10-01T10:00:00Z'}).slice(0)];
    write(rollout(dirs.codex, 'rollout-f.jsonl'), forkRows);
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(3);
    expect(s.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(3);
  });
});

describe('A#2 copies of one Codex session: most complete wins, divergent tails merge', () => {
  it('a longer archived copy is not hidden by a shorter live copy with the same relative path', async () => {
    const {dirs, options, write} = home();
    const id = '22222222-0000-4000-8000-000000000001';
    write(rollout(dirs.codex, 'rollout-x.jsonl'), codexRollout({id, turns: 1}));
    write(path.join(dirs.codex, 'archived_sessions', '2026', '10', '01', 'rollout-x.jsonl'), codexRollout({id, turns: 2}));
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(2);
    expect(s.metrics.conversations.value).toBe(1);
    expect(s.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(2);
  });
  it('divergent tails of one session merge by event identity', async () => {
    const {dirs, options, write} = home();
    const id = '22222222-0000-4000-8000-000000000002';
    const all = codexRollout({id, turns: 3});
    // copy A has turns 0,1; copy B has turns 0,2 (5 rows per turn after 1 header row)
    write(rollout(dirs.codex, 'rollout-y.jsonl'), all.slice(0, 1 + 10));
    write(path.join(dirs.codex, 'archived_sessions', 'rollout-y.jsonl'), [...all.slice(0, 1 + 5), ...all.slice(1 + 10)]);
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(3);
    expect(s.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(3);
  });
});

describe('compressed rollouts and the potsherd archive', () => {
  it('reads .jsonl.zst rollouts and counts a session once across live, compressed and archived copies', async () => {
    const {dirs, options, write} = home();
    const id = '33333333-0000-4000-8000-000000000001', onlyArchived = '33333333-0000-4000-8000-000000000002';
    fs.mkdirSync(path.dirname(rollout(dirs.codex, 'x')), {recursive: true});
    fs.writeFileSync(rollout(dirs.codex, 'rollout-z.jsonl.zst'), zstd(codexRollout({id, turns: 2})));
    write(rollout(dirs.codex, 'rollout-z.jsonl'), codexRollout({id, turns: 1}));
    const evidence = path.join(dirs.potsherd, 'archive', 'evidence');
    write(path.join(evidence, 'aaaa.jsonl'), codexRollout({id, turns: 2}));
    fs.writeFileSync(path.join(evidence, 'bbbb.jsonl'), zstd(codexRollout({id: onlyArchived, turns: 3, base: '2026-09-10T10:00:00Z'})));
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(5);
    expect(s.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(5);
    expect(s.metrics.conversations.value).toBe(2);
    expect(s.coverage.gapCodes).not.toContain('zstd_unsupported');
  });
  it('adds Claude sessions that survive only in the archive, without double counting live ones', async () => {
    const {dirs, options, write} = home();
    const live = [claudeUser('u1', 'synthetic live prompt', 0, 'live'), claudeAssistant('m1', 1, 'live')];
    write(path.join(dirs.claude, 'projects', 'p', 'live.jsonl'), live);
    const evidence = path.join(dirs.potsherd, 'archive', 'evidence');
    write(path.join(evidence, 'c1.jsonl'), live);
    write(path.join(evidence, 'c2.jsonl'), [claudeUser('u2', 'synthetic rescued prompt', 30, 'gone'), claudeAssistant('m2', 31, 'gone')]);
    // An archived subagent transcript lost its subagents/ path.
    write(path.join(evidence, 'c3.jsonl'), [{...claudeUser('su', 'parent-written task', 32, 'gone'), isSidechain: true, agentId: 'agent1'}, {...claudeAssistant('m3', 33, 'gone'), isSidechain: true, agentId: 'agent1'}]);
    const s = await run(options);
    expect(s.metrics.humanPrompts.value).toBe(2);
    expect(s.launch!.facts!.recordedResponses).toBe(3);
    expect(s.sources.find(x => x.harness === 'claude')!.conversations).toBe(2);
    expect(s.metrics.linkedChildren.value).toBe(1);
  });
  it('never revives a forgotten source from the archive', async () => {
    const {dirs, options, write} = home();
    const evidence = path.join(dirs.potsherd, 'archive', 'evidence');
    write(path.join(evidence, 'c2.jsonl'), [claudeUser('u2', 'synthetic rescued prompt', 30, 'gone'), claudeAssistant('m2', 31, 'gone')]);
    const off = await run({...options, potsherdDir: path.join(dirs.root, 'elsewhere')});
    expect(off.metrics.humanPrompts.value).toBe(0);
  });
});

describe('Codex prompt sources', () => {
  it('reads human prompts from response_item role=user when no user_message events exist, skipping injected context', async () => {
    const {dirs, options, write} = home();
    write(rollout(dirs.codex, 'rollout-r.jsonl'), codexRollout({id: '44444444-0000-4000-8000-000000000001', turns: 3, prompts: 'responses'}));
    const s = await run(options);
    const codex = s.sources.find(x => x.harness === 'codex')!;
    expect(codex.humanPrompts).toBe(3);
    expect(codex.excluded?.environment_context).toBe(1);
  });
  it('excludes prompts replayed into a thread imported from Claude Code', async () => {
    const {dirs, options, write} = home();
    const id = '44444444-0000-4000-8000-000000000002';
    const rows = codexRollout({id, turns: 1, from: 3});
    const header = codexRollout({id, turns: 0})[0];
    const replay = [0, 1, 2].map(i => ({timestamp: at(i), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: `replayed synthetic prompt ${i}`}]}}));
    write(rollout(dirs.codex, 'rollout-i.jsonl'), [header, ...replay, ...rows.map(r => r)].map(r => (r as {type?: string}).type === 'event_msg' && JSON.stringify(r).includes('item_completed') ? {...(r as object), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'fresh synthetic prompt after import'}]}} : r));
    const before = await run(options);
    expect(before.sources.find(x => x.harness === 'codex')!.humanPrompts).toBe(4);
    fs.writeFileSync(path.join(dirs.codex, 'external_agent_session_imports.json'), JSON.stringify({imports: [{thread_id: id, source: 'claude_code', source_session_id: '55555555-0000-4000-8000-000000000009'}]}));
    const after = await run({...options, derivedCacheDir: path.join(dirs.cache, 'b')});
    const codex = after.sources.find(x => x.harness === 'codex')!;
    expect(codex.humanPrompts).toBe(1);
    expect(codex.excluded?.imported_from_claude_transcript).toBe(3);
  });
  it('counts codex exec runs as automated runs, not chats, while keeping their cost', async () => {
    const {dirs, options, write} = home();
    write(rollout(dirs.codex, 'rollout-e.jsonl'), codexRollout({id: '66666666-0000-4000-8000-000000000001', turns: 2, originator: 'codex_exec', source: 'exec'}));
    write(rollout(dirs.codex, 'rollout-h.jsonl'), codexRollout({id: '66666666-0000-4000-8000-000000000002', turns: 1, input: 7}));
    const s = await run(options);
    expect(s.metrics.conversations.value).toBe(1);
    expect(s.launch!.story!.totals.automatedRuns).toBe(1);
    expect(s.launch!.story!.totals.sessions).toBe(1);
    expect(s.launch!.facts!.recordedResponses).toBe(3);
  });
});

describe('A#3 pi forks', () => {
  it('counts copied fork entries once and keeps the fork tail', async () => {
    const {dirs, options, write} = home();
    const sessions = path.join(dirs.pi, 'agent', 'sessions', '--work-synthetic--');
    const msg = (id: string, minute: number, role: string, extra: Record<string, unknown> = {}) => ({type: 'message', id, timestamp: at(minute), message: {role, ...extra}});
    const a1 = msg('aa01', 1, 'assistant', {model: 'claude-sonnet-4-6', provider: 'anthropic', usage: {input: 1_000_000, output: 100_000}});
    const u1 = msg('uu01', 0, 'user', {content: 'synthetic pi question'});
    write(path.join(sessions, '2026-10-01T10-00-00-000Z_77777777-0000-4000-8000-000000000001.jsonl'), [{type: 'session', id: '77777777-0000-4000-8000-000000000001', cwd: '/work/synthetic', timestamp: at(0)}, u1, a1]);
    write(path.join(sessions, '2026-10-01T11-00-00-000Z_77777777-0000-4000-8000-000000000002.jsonl'), [
      {type: 'session', id: '77777777-0000-4000-8000-000000000002', cwd: '/work/synthetic', timestamp: at(60), parentSession: `${sessions}/2026-10-01T10-00-00-000Z_77777777-0000-4000-8000-000000000001.jsonl`},
      u1, a1, msg('uu02', 61, 'user', {content: 'synthetic fork follow-up'}), msg('aa02', 62, 'assistant', {model: 'claude-sonnet-4-6', provider: 'anthropic', usage: {input: 10, output: 1}})]);
    const s = await run(options);
    expect(s.launch!.facts!.recordedResponses).toBe(2);
    expect(s.metrics.humanPrompts.value).toBe(2);
  });
});

describe('A#8 every Claude root contributes history', () => {
  it('reads history-only prompts from two roots', async () => {
    const {dirs, options, write} = home();
    const a = path.join(dirs.root, 'rootA'), b = path.join(dirs.root, 'rootB');
    write(path.join(a, 'history.jsonl'), [{display: 'synthetic prompt from root A', timestamp: Date.parse(at(0)), project: '/work/a', sessionId: 'ha'}]);
    write(path.join(b, 'history.jsonl'), [{display: 'synthetic prompt from root B', timestamp: Date.parse(at(5)), project: '/work/b', sessionId: 'hb'}]);
    fs.mkdirSync(path.join(a, 'projects')); fs.mkdirSync(path.join(b, 'projects'));
    const s = await run({...options, claudeDir: `${a},${b}`});
    expect(s.metrics.humanPrompts.value).toBe(2);
    expect(s.metrics.conversations.value).toBe(2);
  });
  it('an identical history copy in two roots counts once', async () => {
    const {dirs, options, write} = home();
    const a = path.join(dirs.root, 'rootA'), b = path.join(dirs.root, 'rootB');
    const rows = [{display: 'synthetic prompt shared', timestamp: Date.parse(at(0)), project: '/work/a', sessionId: 'ha'}];
    write(path.join(a, 'history.jsonl'), rows); write(path.join(b, 'history.jsonl'), rows);
    const s = await run({...options, claudeDir: `${a},${b}`});
    expect(s.metrics.humanPrompts.value).toBe(1);
  });
});
