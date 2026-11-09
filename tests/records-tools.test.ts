import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { Engine, parseTurns } from '../packages/core/src/records/engine.js';
import { serveMcp, callTool } from '../packages/core/src/records/mcp.js';
import { MCP_INSTRUCTIONS, MCP_TOOLS, NOTE_B_TEMPLATE } from '../packages/core/src/records/spec.js';
import { agentNote, CLI_LINE, GUIDANCE, PROTOCOL } from '../packages/core/src/records/note.js';
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
      expect(out).toMatch(new RegExp(`→ search\\(session="${IDS.claude}", turns="\\d+-\\d+"\\)`));
      expect(out.trimEnd().split('\n').at(-1)).toMatch(/^Next: search\(session="[^"]+", turns="\d+-\d+"\) reads around hit 1; search\(query="pgbouncer pool", session="[^"]+"\) lists every match inside that thread\.$/);
    } finally { e.close(); }
  });

  it('prints CLI follow-ups in the CLI', () => {
    const e = cli();
    try {
      expect(e.search({query: 'pgbouncer'})).toMatch(/→ slopie search --session \S+ --turns \d+-\d+/);
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
      expect(out).toContain(`[turns 1-2 of 5. Continue: search(session="${IDS.claude}", turns="3-5")]`);
      expect(out).toContain(`children: ${IDS.agent} (subagent)`);
    } finally { e.close(); }
  });

  it('negative from reads the end; the CLI continue line is a command', () => {
    const e = cli();
    try {
      const out = e.read({session: IDS.claude.slice(0, 8), from_turn: -2});
      expect(out).toContain('t4 SYSTEM');
      expect(out).toContain('[turns 4-5 of 5; end of thread. Later threads in this project: slopie search --project /work/demo-app --since 2026-10-01]');
      expect(e.read({session: IDS.claude, from_turn: 1, to_turn: 1})).toContain(`Continue: slopie search --session ${IDS.claude} --turns 2-5]`);
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
        const none = e.grep({session: IDS.claude, pattern: 'absent-string'});
        expect(none).toContain('partial scan: searched the record only');
        expect(none).toContain('This does not clear the spelling');
      } finally { e.close(); fs.rmSync(g.root, {recursive: true, force: true}); }
    });
  });

  it('a subagent grep header names its parent', () => {
    const e = cli();
    try { expect(e.grep({session: IDS.agent, pattern: 'SameSite'})).toContain(`subagent of ${IDS.claude}`); } finally { e.close(); }
  });
});

describe('search: the one tool', () => {
  it('query finds passages; session + turns reads; query + session searches inside; filters alone list threads', () => {
    const e = mcp();
    try {
      expect(e.find({query: 'pgbouncer pool'})).toContain(`claude ${IDS.claude}`);
      const tail = e.find({session: IDS.claude, turns: '-2'});
      expect(tail).toContain('t4 SYSTEM');
      expect(tail).toContain('[turns 4-5 of 5; end of thread. Later threads in this project: search(project="/work/demo-app", since="2026-10-01")]');
      expect(e.find({session: IDS.claude, turns: '1-2'})).toContain(`Continue: search(session="${IDS.claude}", turns="3-5")]`);
      const inside = e.find({query: 'ZEBRA_MIDDLE_NEEDLE_42', session: IDS.claude});
      expect(inside).toMatch(/^1 exact matches for 'ZEBRA_MIDDLE_NEEDLE_42' in claude/);
      expect(inside).toContain('t3 TOOL Bash (output)');
      expect(inside.trimEnd().split('\n').at(-1)).toBe(`Next: search(session="${IDS.claude}", turns="1-5") reads around t3.`);
      const words = e.find({query: 'pool login redirect', session: IDS.claude});
      expect(words).toContain('Passages with these words (no exact match):');
      expect(words.trimEnd().split('\n').at(-1)).toMatch(/^Next: search\(session="[^"]+", turns="\d+-\d+"\) reads around t\d+\.$/);
      const list = e.find({project: 'demo-app'});
      expect(list).toMatch(/^4 threads \(newest first/);
      expect(list).not.toContain('    last: ');
      expect(list.trimEnd().split('\n').at(-1)).toBe(`Next: search(session="${IDS.pi}", turns="-30") reads the end of the newest thread.`);
      expect(e.find({project: 'demo-app', until: '2026-10-01T23:59'})).toMatch(/^1 threads/);
      expect(e.find({project: 'nowhere'})).toContain('No threads match those filters.');
      expect(e.find({turns: '-30'})).toContain('turns needs a session');
      expect(e.find({session: IDS.claude, turns: 'soon'})).toContain('turns must look like');
    } finally { e.close(); }
  });

  it('at the end of a thread names the later threads that mention it, and reads the first one next', async () => {
    const g = makeFixture();
    try {
      await syncRecords(syncOptions(g));
      const idx = path.join(g.recordsDir, 'INDEX.tsv');
      fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').split('\n').map(l => {
        const c = l.split('\t');
        if (c[1] === IDS.claude) c[11] = `agent-0123456789abcdef0 (claude, 2026-10-02), ${IDS.codex} (codex, 2026-10-02)`;
        return c.join('\t');
      }).join('\n'));
      const e = new Engine(g.recordsDir, 'mcp');
      try {
        expect(e.find({session: IDS.claude, turns: '-1'}).trimEnd().split('\n').at(-1)).toBe(
          `[turns 5-5 of 5; end of thread. Mentioned later in: agent-0123456789abcdef0 (claude, 2026-10-02), ${IDS.codex} (codex, 2026-10-02); the work or a decision often continued there. Next: search(session="${IDS.codex}", turns="-30")]`);
      } finally { e.close(); }
    } finally { fs.rmSync(g.root, {recursive: true, force: true}); }
  });

  it('parses turn ranges', () => {
    expect(parseTurns('120-160')).toEqual({from: 120, to: 160, char: null});
    expect(parseTurns('-30')).toEqual({from: -30, to: null, char: null});
    expect(parseTurns('120')).toEqual({from: 120, to: null, char: null});
    expect(parseTurns('t120-t160')).toEqual({from: 120, to: 160, char: null});
    expect(parseTurns('12@4000')).toEqual({from: 12, to: null, char: 4000});
    expect(parseTurns(null)).toEqual({from: null, to: null, char: null});
    expect(parseTurns('later')).toBeNull();
  });
});

describe('MCP: one tool, search', () => {
  it('lists exactly one tool with a short description and one example per parameter', () => {
    expect(MCP_TOOLS.map(t => t.name)).toEqual(['search']);
    const [tool] = MCP_TOOLS;
    expect(tool.description.split('. ').length).toBeLessThanOrEqual(3);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['query', 'session', 'turns', 'project', 'since', 'until']);
    for (const p of Object.values(tool.inputSchema.properties)) expect(p.description).toMatch(/e\.g\. "/);
    expect(MCP_INSTRUCTIONS).toMatch(/^slopie: search the user's past coding-agent sessions/);
  });

  it('speaks newline-delimited JSON-RPC over stdio', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', d => chunks.push(String(d)));
    const done = serveMcp({version: '1.9.0', recordsDir: f.recordsDir, input, output});
    input.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'search', arguments: {session: IDS.pi}}}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'potsherd_recall', arguments: {}}}) + '\n');
    input.write(JSON.stringify({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'read', arguments: {session: IDS.pi}}}) + '\n');
    input.end();
    await done;
    const msgs = chunks.join('').trim().split('\n').map(l => JSON.parse(l) as {id: number; result: Record<string, unknown>});
    expect(msgs.map(m => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(msgs[0]!.result['instructions']).toBe(MCP_INSTRUCTIONS);
    expect((msgs[1]!.result['tools'] as unknown[])).toEqual(JSON.parse(JSON.stringify(MCP_TOOLS)));
    expect(JSON.stringify(msgs[2]!.result)).toContain('rename the env var to DEMO_TOKEN');
    expect(msgs[3]!.result['isError']).toBe(true);
    // The R5 names still answer (hidden aliases).
    expect(JSON.stringify(msgs[4]!.result)).toContain('rename the env var to DEMO_TOKEN');
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
    const R7_INDEX = "- INDEX.tsv: one line per session: harness, id, project (working dir), start, end (last activity), turns, parent, title, first user message, file, active (every UTC date with a turn, so rg '2026-07-14' INDEX.tsv lists every thread active that day, including long threads that started earlier), later (later threads that name this one, where the work or a decision often continued).";
    const R5_SUB = '- Subagent sessions have "parent: subagent of <id>"; their files are named <date>_<parent-id>__agent-*.txt.';
    const R7_SUB = R5_SUB + ' Tasks another thread dispatched have "parent: delegated by <id>" (that thread briefed, tracked and applied the work, and lists them under children).';
    expect(NOTE_B_TEMPLATE).toContain(R7_INDEX);
    expect(NOTE_B_TEMPLATE).toContain(R7_SUB);
    const R5_END = "Search with rg (e.g. rg -n -i 'term' {RECORDS}, rg -l, rg 'pattern' INDEX.tsv) and read ranges with sed -n 'a,bp' file. Times are UTC.";
    const R7_END = R5_END + " A record's modification time is its last activity, so rg -l --sortr modified 'term' {RECORDS} lists the most recently active threads first: decisions often change in a later thread or the other harness.";
    expect(NOTE_B_TEMPLATE).toContain(R7_END);
    const R5_HDR = 'Header lines start with "## " (session, project, title, time, parent, children, raw source paths).';
    const R7_HDR = 'Header lines start with "## " (session, project, title, time, parent, children, later threads that mention it, raw source paths).';
    expect(NOTE_B_TEMPLATE).toContain(R7_HDR);
    const r5Now = NOTE_B_TEMPLATE.split(R7_INDEX).join(R5_INDEX).split(R7_SUB).join(R5_SUB).split(R7_END).join(R5_END).split(R7_HDR).join(R5_HDR);
    expect(r5Now.split('{RECORDS}').join('{DATA}/records')).toBe(r5.NOTE_B_template);
    const note = agentNote('/records-root');
    expect(note).toBe(NOTE_B_TEMPLATE.split('{RECORDS}').join('/records-root') + '\n' + PROTOCOL + '\n' + CLI_LINE);
    expect(agentNote('/r', {protocol: false})).not.toContain(PROTOCOL);
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
    expect(text).toContain(`slopie search --session ${IDS.claude} --turns -30`);
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
