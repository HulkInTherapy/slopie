import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { serveMcp, callTool } from '../packages/core/src/records/mcp.js';
import { MCP_INSTRUCTIONS, MCP_TOOLS, NOTE_B_TEMPLATE } from '../packages/core/src/records/spec.js';
import { agentNote, CLI_LINE, GUIDANCE } from '../packages/core/src/records/note.js';
import { continuationPointer, isContinuation, parseHookInput } from '../packages/core/src/records/hook.js';
import { IDS, makeFixture, NEEDLE, syncOptions, type Fixture } from './records-fixture.js';

let f: Fixture;
beforeAll(async () => { f = makeFixture(); await syncRecords(syncOptions(f)); });
afterAll(() => fs.rmSync(f.root, {recursive: true, force: true}));

const cli = () => new Engine(f.recordsDir, 'cli');
const mcp = () => new Engine(f.recordsDir, 'mcp');

describe('search', () => {
  it('finds a passage and ends each hit with the read call for it', () => {
    const e = mcp();
    try {
      const out = e.search({query: 'pgbouncer pool'});
      expect(out).toContain(`claude ${IDS.claude}`);
      expect(out).toMatch(new RegExp(`→ read\\(session="${IDS.claude}", from_turn=\\d+, to_turn=\\d+\\)`));
      expect(out).toContain('For every occurrence of an exact string in one thread use grep(session=..., pattern=...).');
    } finally { e.close(); }
  });

  it('prints CLI follow-ups in the CLI', () => {
    const e = cli();
    try {
      expect(e.search({query: 'pgbouncer'})).toMatch(/→ slopie read \S+ --from \d+ --to \d+/);
    } finally { e.close(); }
  });

  it('prints "subagent of <parent-id>" on every subagent hit', () => {
    const e = cli();
    try {
      const out = e.search({query: 'SameSite cookie redirect'});
      const hit = out.split('\n').find(l => l.includes(IDS.agent))!;
      expect(hit).toContain(`subagent of ${IDS.claude}`);
      expect(hit).toContain('"Fix the login redirect"');
      expect(out).toContain('PROMPT-FROM-PARENT-AGENT');
    } finally { e.close(); }
  });

  it('filters by project, harness, time and session', () => {
    const e = cli();
    try {
      expect(e.search({query: 'pool', harness: 'codex'})).not.toContain(`claude ${IDS.claude}`);
      expect(e.search({query: 'pool', project: 'nowhere'})).toContain('No threads match those filters');
      expect(e.search({query: 'pool', session: IDS.codex.slice(0, 12)})).toContain(`codex ${IDS.codex}`);
      expect(e.search({query: 'deploys', since: '2026-10-03', until: '2026-10-04'})).toContain(IDS.codexZst);
    } finally { e.close(); }
  });

  it('finds prompt-only sessions by the user\'s own words', () => {
    const e = cli();
    try {
      expect(e.search({query: 'every feature', k: 3}).split('\n')[0]).toContain(IDS.promptOnly);
    } finally { e.close(); }
  });
});

describe('read', () => {
  it('reads a turn range and says how to continue', () => {
    const e = mcp();
    try {
      const out = e.read({session: IDS.claude, from_turn: 1, to_turn: 2});
      expect(out).toContain('t1 USER 2026-10-01 09:12');
      expect(out).toContain('t2 ASSISTANT');
      expect(out).toContain(`[turns 1-2 of 5. Continue: read(session="${IDS.claude}", from_turn=3)]`);
      expect(out).toContain(`children: ${IDS.agent} (subagent)`);
    } finally { e.close(); }
  });

  it('negative from reads the end; the CLI continue line is a command', () => {
    const e = cli();
    try {
      const out = e.read({session: IDS.claude.slice(0, 8), from_turn: -2});
      expect(out).toContain('t4 SYSTEM');
      expect(out).toContain('[turns 4-5 of 5; end of thread.]');
      expect(e.read({session: IDS.claude, from_turn: 1, to_turn: 1})).toContain(`Continue: slopie read ${IDS.claude} --from 2]`);
    } finally { e.close(); }
  });

  it('says what to do with an unknown id', () => {
    const e = cli();
    try { expect(e.read({session: 'nope'})).toContain("no session matches 'nope'"); } finally { e.close(); }
  });
});

describe('threads', () => {
  it('lists newest first with the opening ask and last words, subagents hidden', () => {
    const e = cli();
    try {
      const out = e.threads({});
      expect(out).toMatch(/^5 threads \(newest first; showing 1-5\):/);
      expect(out).not.toContain(IDS.agent);
      expect(out.indexOf(IDS.pi)).toBeLessThan(out.indexOf(IDS.claude));
      expect(out).toContain('    ask: the login page loops back to /signin after OAuth');
      expect(out).toContain(`| 1 child threads`);
    } finally { e.close(); }
  });

  it('text= lists EVERY thread containing all the words; include_subagents and parent', () => {
    const e = mcp();
    try {
      const out = e.threads({text: 'pool', include_subagents: true});
      expect(out).toContain('threads containing all of: pool');
      expect(out).toContain(IDS.claude);
      expect(out).toContain(IDS.codex);
      expect(out).toMatch(/first match t\d+/);
      expect(e.threads({parent: IDS.claude})).toContain(`${IDS.agent} | claude`);
      expect(e.threads({parent: IDS.claude})).toContain(`subagent of ${IDS.claude}`);
    } finally { e.close(); }
  });
});

describe('grep', () => {
  it('finds text the record cut, from the full tool output', () => {
    const e = mcp();
    try {
      expect(fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8')).not.toContain(NEEDLE);
      const out = e.grep({session: IDS.claude, pattern: NEEDLE.toLowerCase()});
      expect(out).toMatch(/^1 matches for '.*' in claude/);
      expect(out).toContain('t3 TOOL Bash (output) 2026-10-01 09:13:');
      expect(out).toContain(NEEDLE);
    } finally { e.close(); }
  });

  it('falls back to the record text when the source is gone, and supports regex', () => {
    const g = makeFixture();
    return syncRecords(syncOptions(g)).then(() => {
      fs.rmSync(g.claudeFile);
      const e = new Engine(g.recordsDir, 'cli');
      try {
        expect(e.grep({session: IDS.claude, pattern: 'pgbouncer'})).toContain('t5 USER');
        expect(e.grep({session: IDS.claude, pattern: 'pool at \\d+', regex: true})).toContain('pool at 40');
        expect(e.grep({session: IDS.claude, pattern: 'absent-string'})).toContain('No match. This clears only this spelling');
      } finally { e.close(); fs.rmSync(g.root, {recursive: true, force: true}); }
    });
  });

  it('a subagent grep header names its parent', () => {
    const e = cli();
    try { expect(e.grep({session: IDS.agent, pattern: 'SameSite'})).toContain(`subagent of ${IDS.claude}`); } finally { e.close(); }
  });
});

describe('MCP: exactly the R5 §11.2 surface', () => {
  const r5 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'records', 'r5-spec.json'), 'utf8')) as {tools: unknown[]; instructions: string};

  it('lists the four tools with R5\'s names, descriptions and schemas verbatim', () => {
    expect(JSON.parse(JSON.stringify(MCP_TOOLS))).toEqual(r5.tools);
    expect(MCP_TOOLS.map(t => t.name)).toEqual(['search', 'read', 'threads', 'grep']);
    expect(MCP_INSTRUCTIONS).toBe(r5.instructions);
  });

  it('speaks newline-delimited JSON-RPC over stdio', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', d => chunks.push(String(d)));
    const done = serveMcp({version: '1.9.0', recordsDir: f.recordsDir, input, output});
    input.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'read', arguments: {session: IDS.pi}}}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'potsherd_recall', arguments: {}}}) + '\n');
    input.end();
    await done;
    const msgs = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as {id: number; result: Record<string, unknown>});
    expect(msgs.map(m => m.id)).toEqual([1, 2, 3, 4]);
    expect(msgs[0]!.result['instructions']).toBe(r5.instructions);
    expect((msgs[1]!.result['tools'] as unknown[])).toEqual(r5.tools);
    expect(JSON.stringify(msgs[2]!.result)).toContain('rename the env var to DEMO_TOKEN');
    expect(msgs[3]!.result['isError']).toBe(true);
  });

  it('a missing index is a tool error that names slopie sync', () => {
    const r = callTool('search', {query: 'x'}, path.join(f.root, 'nowhere'));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('slopie sync');
  });
});

describe('the agent note', () => {
  it('is R5 NOTE_B with the R7 INDEX and delegation lines and the records path filled in, then one CLI line', () => {
    const r5 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'records', 'r5-note.json'), 'utf8')) as {NOTE_B_template: string};
    // R7: the INDEX line names `end` as last activity and documents the `active` dates column; nothing else changed.
    const R5_INDEX = '- INDEX.tsv: one line per session: harness, id, project (working dir), start, end, turns, parent, title, first user message, file.';
    const R7_INDEX = "- INDEX.tsv: one line per session: harness, id, project (working dir), start, end (last activity), turns, parent, title, first user message, file, active (every UTC date with a turn, so rg '2026-07-14' INDEX.tsv lists every thread active that day, including long threads that started earlier).";
    const R5_SUB = '- Subagent sessions have "parent: subagent of <id>"; their files are named <date>_<parent-id>__agent-*.txt.';
    const R7_SUB = R5_SUB + ' Tasks another thread dispatched have "parent: delegated by <id>" (that thread briefed, tracked and applied the work, and lists them under children).';
    expect(NOTE_B_TEMPLATE).toContain(R7_INDEX);
    expect(NOTE_B_TEMPLATE).toContain(R7_SUB);
    const R5_END = "Search with rg (e.g. rg -n -i 'term' {RECORDS}, rg -l, rg 'pattern' INDEX.tsv) and read ranges with sed -n 'a,bp' file. Times are UTC.";
    const R7_END = R5_END + " A record's modification time is its last activity, so rg -l --sortr modified 'term' {RECORDS} lists the most recently active threads first: decisions often change in a later thread or the other harness.";
    expect(NOTE_B_TEMPLATE).toContain(R7_END);
    const r5Now = NOTE_B_TEMPLATE.split(R7_INDEX).join(R5_INDEX).split(R7_SUB).join(R5_SUB).split(R7_END).join(R5_END);
    expect(r5Now.split('{RECORDS}').join('{DATA}/records')).toBe(r5.NOTE_B_template);
    const note = agentNote('/records-root');
    expect(note).toBe(NOTE_B_TEMPLATE.split('{RECORDS}').join('/records-root') + '\n' + CLI_LINE);
    expect(agentNote('/r', {cli: false})).not.toContain('slopie search');
    expect(agentNote('/r', {guidance: true})).toContain(GUIDANCE);
  });
});

describe('continuation pointer', () => {
  it('prints at most 10 lines: the id, the record path and the exact commands', () => {
    const lines = continuationPointer(IDS.claude, 'claude', f.recordsDir);
    expect(lines.length).toBeLessThanOrEqual(10);
    const text = lines.join('\n');
    expect(text).toContain(IDS.claude);
    expect(text).toContain(path.join(f.recordsDir, 'claude', 'work-demo-app', `2026-10-01_${IDS.claude}.txt`));
    expect(text).toContain(`slopie read ${IDS.claude} --from -30`);
    expect(text).toContain(`slopie search "<words>" --session ${IDS.claude}`);
  });

  it('only on resume and after compaction', () => {
    expect(isContinuation('compact')).toBe(true);
    expect(isContinuation('resume')).toBe(true);
    expect(isContinuation('startup')).toBe(false);
    expect(parseHookInput('{"session_id":"x","source":"compact"}').session_id).toBe('x');
    expect(parseHookInput('not json')).toEqual({});
  });
});
