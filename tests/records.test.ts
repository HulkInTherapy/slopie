import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { writeForgetList } from '../packages/core/src/sources/policy.js';
import { sourceId } from '../packages/core/src/sources/identity.js';
import { writeIgnoreList } from '../packages/core/src/ignore.js';
import { parseRecordText } from '../packages/core/src/records/index-db.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { activeDays } from '../packages/core/src/records/format.js';
import { annotateRelay, delegEdges, delegKey, delegOf, relayLinks } from '../packages/core/src/records/deleg.js';
import { backlinks, refsOf } from '../packages/core/src/records/refs.js';
import { render } from '../packages/core/src/records/format.js';
import { claudeSession, IDS, makeFixture, NEEDLE, PROJECT, syncOptions, type Fixture } from './records-fixture.js';

const made: Fixture[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, {recursive: true, force: true}); });
const fixture = () => { const f = makeFixture(); made.push(f); return f; };

const index = (f: Fixture) => fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8').trimEnd().split('\n').map(l => l.split('\t'));
const rowOf = (f: Fixture, id: string) => index(f).find(r => r[1] === id);
const record = (f: Fixture, id: string) => fs.readFileSync(path.join(f.recordsDir, rowOf(f, id)![9]!), 'utf8');

describe('records: the R5 §11.1 format', () => {
  it('writes the reference exporter\'s record, line for line (golden)', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const rel = rowOf(f, IDS.claude)![9]!;
    expect(rel).toBe(`claude/work-demo-app/2026-10-01_${IDS.claude}.txt`);
    const text = record(f, IDS.claude).replaceAll(f.root, '<root>');
    const cut = 'head-of-output ' + 'x'.repeat(1985);
    expect(text).toBe([
      `## session claude:${IDS.claude}`,
      `## project: ${PROJECT}`,
      '## title: Fix the login redirect',
      '## time: 2026-10-01T09:12:00Z -> 2026-10-01T11:40:10Z   turns: 5',
      '## parent: none',
      `## children: ${IDS.agent} (subagent)`,
      `## raw: <root>/.claude/projects/-work-demo-app/${IDS.claude}.jsonl | <root>/.potsherd/archive/evidence/aaaa1111.jsonl`,
      't1 USER 2026-10-01 09:12 | the login page loops back to /signin after OAuth',
      't2 ASSISTANT 2026-10-01 09:13 | Looking at the callback handler first.',
      't3 TOOL Bash 09:13 | rg -n "redirect_uri" src/',
      `t3 > ${cut}`,
      `t3 > …[1854 chars cut; full output: <root>/.claude/projects/-work-demo-app/${IDS.claude}.jsonl:5]…`,
      `t3 > ${'y'.repeat(985)} tail-of-output`,
      't4 SYSTEM 2026-10-01 11:40 | <system-reminder>injected</system-reminder>',
      't5 USER 2026-10-01 11:40 | ship it',
      't5 | with the pgbouncer pool at 40',
      '',
    ].join('\n'));
  });

  it('writes INDEX.tsv with one line per session and the eleven columns', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const rows = index(f);
    expect(rows[0]).toEqual(['harness', 'id', 'project', 'start', 'end', 'turns', 'parent', 'title', 'first_user_msg', 'file', 'active']);
    const ids = rows.slice(1).map(r => r[1]).sort();
    expect(ids).toEqual([IDS.agent, IDS.claude, IDS.codex, IDS.codexZst, IDS.pi, IDS.promptOnly].sort());
    const codex = rowOf(f, IDS.codex)!;
    expect(codex.slice(0, 8)).toEqual(['codex', IDS.codex, PROJECT, '2026-10-02T10:00:00Z', '2026-10-02T10:00:09Z', '3', '', 'Check the pool size']);
    expect(codex[8]).toBe('what is the pgbouncer pool size?');
    for (const r of rows.slice(1)) expect(fs.existsSync(path.join(f.recordsDir, r[9]!))).toBe(true);
    // active: every UTC date with a turn, so `rg <date> INDEX.tsv` finds threads by activity, not only by start date
    expect(codex[10]).toBe('2026-10-02');
    for (const r of rows.slice(1)) expect(r[10]).toMatch(/^\d{4}-\d\d-\d\d( \d{4}-\d\d-\d\d)*$/);
  });

  it('lists every active date of a long thread in INDEX.tsv', () => {
    const s = {start: '2026-06-28T10:00:00Z', end: '2026-07-15T09:00:00Z', turns: [
      {ts: '2026-06-28T10:00:00Z'}, {ts: '2026-06-28T23:59:00Z'}, {ts: null}, {ts: '2026-07-14T08:00:00Z'}, {ts: '2026-07-15T09:00:00Z'}]};
    expect(activeDays(s)).toBe('2026-06-28 2026-07-14 2026-07-15');
    expect(activeDays({start: '2026-01-02T00:00:00Z', end: null, turns: []})).toBe('2026-01-02');
  });

  it('reads compressed Codex rollouts and drops Codex threads imported from Claude', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    expect(record(f, IDS.codexZst)).toContain('t1 USER 2026-10-03 10:00 | compressed rollout about vercel deploys');
    expect(rowOf(f, IDS.codexImported)).toBeUndefined();
    expect(record(f, IDS.codex)).toContain('t2 TOOL exec_command 10:00 | cat config/pool.toml\nt2 > max_connections = 40');
  });

  it("sets each record's mtime to the session's last activity", async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const row = rowOf(f, IDS.codex)!;
    expect(fs.statSync(path.join(f.recordsDir, row[9]!)).mtimeMs).toBe(Date.parse(row[4]!));
  });

  it('records directories are private (0700) and files 0600', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    expect(fs.statSync(f.recordsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.recordsDir, 'claude')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.recordsDir, 'INDEX.tsv')).mode & 0o777).toBe(0o600);
  });
});

describe('records: copies, subagents, prompt-only', () => {
  it('merges live and archive copies of one session; the copy with the most turns wins', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    expect(index(f).filter(r => r[1] === IDS.claude)).toHaveLength(1);
    expect(rowOf(f, IDS.claude)![5]).toBe('5');
    // The live file is deleted by the harness and the archive copy has fewer turns: the record is kept as written.
    fs.rmSync(f.claudeFile);
    const r = await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)![5]).toBe('5');
    expect(record(f, IDS.claude)).toContain('t5 | with the pgbouncer pool at 40');
    expect(r.kept).toBe(1);
  });

  it('keeps a record after every source of it is deleted', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    fs.rmSync(f.claudeFile);
    fs.rmSync(path.join(f.potsherdDir, 'archive', 'evidence', 'aaaa1111.jsonl'));
    const r = await syncRecords(syncOptions(f));
    expect(r.kept).toBe(1);
    expect(record(f, IDS.claude)).toContain('t5 | with the pgbouncer pool at 40');
  });

  it('names subagent files after their parent and links both ways', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const row = rowOf(f, IDS.agent)!;
    expect(row[9]).toBe(`claude/work-demo-app/2026-10-01_${IDS.claude}__${IDS.agent}.txt`);
    expect(row[6]).toBe(`subagent:${IDS.claude}`);
    expect(record(f, IDS.agent)).toContain(`## parent: subagent of ${IDS.claude}`);
    expect(record(f, IDS.claude)).toContain(`## children: ${IDS.agent} (subagent)`);
  });

  it('writes a prompt-only record for a session known only from history.jsonl, one turn per prompt', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const text = record(f, IDS.promptOnly);
    expect(text).toContain('## title: (prompt history only; transcript not kept)');
    expect(text).toContain('t1 USER 2026-09-20 08:00 | make every feature available over an API');
    expect(text).toContain('t2 USER 2026-09-20 08:05 | and document it');
    // The same prompts in the archive's history copy are not doubled.
    expect(text).not.toContain('t3 ');
    expect(text).toContain('## raw: ' + path.join(f.claudeDir, 'history.jsonl') + ' | ' + path.join(f.potsherdDir, 'archive', 'claude', 'history.jsonl'));
  });
});

describe('records: incremental sync', () => {
  it('re-reads only files whose size or mtime changed', async () => {
    const f = fixture();
    const first = await syncRecords(syncOptions(f));
    expect(first.parsed).toBeGreaterThan(4);
    const again = await syncRecords(syncOptions(f));
    expect(again.parsed).toBe(0);
    expect(again.written).toBe(0);
    fs.appendFileSync(f.claudeFile, JSON.stringify({sessionId: IDS.claude, cwd: PROJECT, type: 'user', uuid: 'u9', timestamp: '2026-10-01T12:00:00.000Z', message: {role: 'user', content: 'one more thing'}}) + '\n');
    const third = await syncRecords(syncOptions(f));
    expect(third.parsed).toBe(1);
    expect(third.written).toBe(1);
    expect(record(f, IDS.claude)).toContain('t6 USER 2026-10-01 12:00 | one more thing');
  });

  it('updates the search index in place: appended turns found, unchanged turns kept once', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    fs.appendFileSync(f.claudeFile, JSON.stringify({sessionId: IDS.claude, cwd: PROJECT, type: 'user', uuid: 'u9', timestamp: '2026-10-01T12:00:00.000Z', message: {role: 'user', content: 'one more flamingo thing'}}) + '\n');
    await syncRecords(syncOptions(f));
    const e = new Engine(f.recordsDir, 'cli');
    try {
      expect(e.search({query: 'flamingo'})).toContain('t6 USER');
      const pool = e.search({query: 'pgbouncer pool', session: IDS.claude});
      expect(pool.match(/^\[\d+\]/gm)).toHaveLength(1);
      expect((e.db.prepare('select count(*) as n from turns where skey=?').get(`claude:${IDS.claude}`) as {n: number}).n).toBe(6);
    } finally { e.close(); }
    // A new title changes every turn's prefix: the rows are rebuilt, still once each.
    fs.appendFileSync(f.claudeFile, JSON.stringify({type: 'custom-title', customTitle: 'Renamed thread', sessionId: IDS.claude}) + '\n');
    await syncRecords(syncOptions(f));
    const e2 = new Engine(f.recordsDir, 'cli');
    try {
      expect(e2.search({query: 'Renamed thread'})).toContain(IDS.claude);
      expect(e2.search({query: 'flamingo'}).match(/^\[\d+\]/gm)).toHaveLength(1);
    } finally { e2.close(); }
  });

  it('rewrites the record when its path changes and removes the old file', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const before = rowOf(f, IDS.claude)![9]!;
    // Same session, earlier first turn: the file name carries the start date.
    fs.writeFileSync(f.claudeFile, claudeSession('full').replace('2026-10-01T09:12:00.000Z', '2026-09-30T23:00:00.000Z'));
    await syncRecords(syncOptions(f));
    const after = rowOf(f, IDS.claude)![9]!;
    expect(after).not.toBe(before);
    expect(fs.existsSync(path.join(f.recordsDir, before))).toBe(false);
    expect(fs.existsSync(path.join(f.recordsDir, after))).toBe(true);
  });
});

describe('records: privacy', () => {
  it('forget removes the session (and its subagents) from the records and the index', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const rel = rowOf(f, IDS.claude)![9]!;
    writeForgetList([{sourceId: sourceId('claude', IDS.claude), harness: 'claude', id: IDS.claude}], f.slopieDir);
    const r = await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)).toBeUndefined();
    expect(rowOf(f, IDS.agent)).toBeUndefined();
    expect(fs.existsSync(path.join(f.recordsDir, rel))).toBe(false);
    expect(r.excludedByPolicy).toBeGreaterThanOrEqual(2);
    // A forgotten session stays out even when its sources are gone and it would otherwise be kept.
    fs.rmSync(f.claudeFile);
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)).toBeUndefined();
  });

  it('ignore removes a project\'s sessions; unignore brings them back', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    writeIgnoreList(f.slopieDir, ['demo-app']);
    await syncRecords(syncOptions(f));
    expect(index(f).slice(1).map(r => r[1])).toEqual([IDS.promptOnly]);
    writeIgnoreList(f.slopieDir, []);
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)).toBeDefined();
  });
});

describe('records: optional full-output sidecar (R5 §7 i)', () => {
  it('writes <record>.out.txt with the cut outputs, tagged like the record', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f, {sidecar: true}));
    const rel = rowOf(f, IDS.claude)![9]!;
    const side = fs.readFileSync(path.join(f.recordsDir, rel.replace(/\.txt$/, '.out.txt')), 'utf8');
    expect(side).toContain(`t3 > head-of-output`);
    expect(side).toContain(NEEDLE);
    expect(record(f, IDS.claude)).not.toContain(NEEDLE);
    expect(index(f).some(r => r[9]!.endsWith('.out.txt'))).toBe(false);
  });
});

describe('records: read back', () => {
  it('parses a record into the same turns (used when a record outlives its sources)', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const back = parseRecordText(record(f, IDS.claude))!;
    expect(back.session.id).toBe(IDS.claude);
    expect(back.session.turns.map(t => t.role)).toEqual(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM', 'USER']);
    expect(back.session.turns[4]!.text).toBe('ship it\nwith the pgbouncer pool at 40');
    expect(back.header.children).toEqual([{id: IDS.agent, kind: 'subagent'}]);
  });
});

describe('delegation edges (R7)', () => {
  const task = 'You are fixing four bugs in the living room.\n\nDetails follow.';
  it('hashes the dispatched prompt and every delegate_task call', () => {
    const child = delegOf({turns: [
      {role: 'SYSTEM', ts: null, text: '# AGENTS.md', ref: 'x:1'},
      {role: 'USER', ts: '2026-10-29T14:24:15Z', text: `Act as the implementation sub-agent for this task.\n\n${task}`, ref: 'x:2'},
    ]});
    const orch = delegOf({turns: [
      {role: 'USER', ts: '2026-10-29T14:00:00Z', text: 'fix the room', ref: 'y:1'},
      {role: 'TOOL', ts: '2026-10-29T14:24:10.5Z', tool: 'mcp__t3-code__delegate_task', text: JSON.stringify({title: 'Room bugs', role: 'implementation', task}), ref: 'y:2'},
    ]});
    expect(child?.task).toBe(delegKey(task));
    expect(child?.calls).toBeUndefined();
    expect(orch?.calls).toEqual([[delegKey(task), '2026-10-29T14:24:10.5Z', 'Room bugs']]);
    expect(delegKey('a  b\n c')).toBe(delegKey('a b c'));
    expect(delegOf({turns: [{role: 'USER', ts: null, text: 'plain prompt', ref: 'z:1'}]})).toBeUndefined();
  });

  it('links each dispatched thread to the latest call at or before its start', () => {
    const k = delegKey(task);
    const edges = delegEdges([
      {id: 'orch-a', start: '2026-10-01T00:00:00Z', parent: null, deleg: {calls: [[k, '2026-10-29T10:00:00Z']]}},
      {id: 'orch-b', start: '2026-10-02T00:00:00Z', parent: null, deleg: {calls: [[k, '2026-10-29T14:24:10Z']]}},
      {id: 'child', start: '2026-10-29T14:24:15Z', parent: null, deleg: {task: k}},
      {id: 'sub', start: '2026-10-29T14:25:00Z', parent: 'child', deleg: {task: k}},
      {id: 'orphan', start: '2026-10-29T15:00:00Z', parent: null, deleg: {task: delegKey('other')}},
    ]);
    expect([...edges]).toEqual([['child', 'orch-b']]);
  });
});

describe('Codex imports of Claude sessions (R7)', () => {
  const CONT = '77777777-7777-7777-8777-777777777777';
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const rollout = [
    {timestamp: '2026-10-02T12:00:00.000Z', type: 'session_meta', payload: {id: CONT, cwd: PROJECT, originator: 'codex_cli'}},
    {timestamp: '2026-10-02T12:00:01.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'copied claude prompt'}]}},
    {timestamp: '2026-10-02T12:00:02.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'copied claude answer'}]}},
    {timestamp: '2026-10-04T09:00:00.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'new work in codex: pick a caption'}]}},
    {timestamp: '2026-10-04T09:00:30.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Use: missing sock found'}]}},
  ].map(line).join('');

  it('keeps an imported thread the user continued in Codex, from the import on, as an import of the Claude session', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.codexDir, 'sessions', '2026', '10', '02', `rollout-2026-10-02T12-00-00-${CONT}.jsonl`), rollout);
    fs.writeFileSync(path.join(f.codexDir, 'external_agent_session_imports.json'), JSON.stringify({records: [
      {imported_thread_id: IDS.codexImported},
      {imported_thread_id: CONT, imported_at: Date.parse('2026-10-02T12:00:00Z') / 1000, source_path: `/Users/me/.claude/projects/-work-demo-app/${IDS.claude}.jsonl`},
    ]}));
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.codexImported)).toBeUndefined();
    const row = rowOf(f, CONT)!;
    expect(row[6]).toBe(`import:${IDS.claude}`);
    expect(row[3]).toBe('2026-10-04T09:00:00Z');
    const text = record(f, CONT);
    expect(text).toContain(`## parent: import of ${IDS.claude}`);
    expect(text).toContain('Use: missing sock found');
    expect(text).not.toContain('copied claude answer');
  });
});

describe('backlinks (R7)', () => {
  it('links an earlier session to later sessions whose user or assistant names it', () => {
    const refs = refsOf({turns: [
      {role: 'USER', ts: null, text: 'continue Codex thread aaaa1111 and also bbbb2222-2222-2222-2222-222222222222', ref: 'x:1'},
      {role: 'TOOL', ts: null, tool: 'Bash', text: 'cat dddddddd.log', output: 'eeeeeeee', ref: 'x:2'},
    ]});
    expect(refs).toEqual(['aaaa1111', 'bbbb2222']);
    const l = backlinks([
      {id: 'aaaa1111-1111-1111-1111-111111111111', harness: 'codex', start: '2026-10-07T00:00:00Z', parentKind: null},
      {id: 'bbbb2222-2222-2222-2222-222222222222', harness: 'claude', start: '2026-11-09T00:00:00Z', parentKind: null},
      {id: 'cccc3333-3333-3333-3333-333333333333', harness: 'claude', start: '2026-10-08T19:00:00Z', parentKind: null, refs},
    ]);
    expect([...l.keys()]).toEqual(['aaaa1111-1111-1111-1111-111111111111']);  // bbbb2222 started later: not a backlink
    expect(l.get('aaaa1111-1111-1111-1111-111111111111')).toEqual([{id: 'cccc3333-3333-3333-3333-333333333333', harness: 'claude', start: '2026-10-08T19:00:00Z'}]);
  });

  it('renders the backlink at the top and the end, and the parser reads every relation form back', () => {
    for (const [kind, label] of [['delegated', 'delegated by p-1'], ['import', 'import of p-1'], ['subagent', 'subagent of p-1'], ['fork', 'fork of p-1']] as const) {
      const text = render({harness: 'codex', id: 'c-1', project: '/w', title: 't', start: '2026-10-07T00:00:00Z', end: '2026-10-07T01:00:00Z', parent: 'p-1', parentKind: kind,
        turns: [{role: 'USER', ts: '2026-10-07T00:00:00Z', text: 'hi'}]}, {children: [], sources: ['/raw'], archiveOnly: false, later: [{id: 'l-1', harness: 'claude', start: '2026-10-08T19:00:00Z'}]});
      expect(text).toContain(`## parent: ${label}`);
      expect(text.trimEnd().split('\n').at(-1)).toBe('## mentioned later in: l-1 (claude, 2026-10-08)');
      const back = parseRecordText(text)!;
      expect([back.session.parent, back.session.parentKind]).toEqual(['p-1', kind]);
      expect(back.session.turns.length).toBe(1);
    }
  });
});

describe('relayed results name the thread that did the work (R8)', () => {
  it('annotates the dispatcher\'s relay turn with the delegated thread', () => {
    const k = delegKey('review the branch');
    const sessions = [
      {id: 'orch', harness: 'claude', start: '2026-10-27T08:00:00Z', parent: null, deleg: {calls: [[k, '2026-10-27T09:00:00Z', 'review r1']] as [string, string | null, string | null][]}},
      {id: 'rev', harness: 'codex', start: '2026-10-27T09:00:05Z', parent: null, deleg: {task: k}},
    ];
    const edges = delegEdges(sessions);
    const relays = relayLinks(sessions, edges).get('orch')!;
    expect(relays).toEqual([{title: 'review r1', child: 'rev', harness: 'codex', start: '2026-10-27T09:00:05Z'}]);
    const text = 'Delegated task node:delegated-task:x%3Ar1 (review r1) [completed]:\nVERDICT: CHANGES';
    expect(annotateRelay(text, '2026-10-27T09:31:00Z', relays)).toBe('Delegated task node:delegated-task:x%3Ar1 (review r1) [completed]: [from delegated thread rev (codex)]\nVERDICT: CHANGES');
    expect(annotateRelay('Delegated task node:y (other) [completed]:', null, relays)).toBe('Delegated task node:y (other) [completed]:');
  });
});
