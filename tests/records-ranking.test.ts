/**
 * 1.9.1 P1: main threads first (session and family grouping, priors, coverage tiers), filters before LIMIT,
 * --latest over every eligible match, structured results. Synthetic history only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { callTool } from '../packages/core/src/records/mcp.js';
import { makeFixture, syncOptions, type Fixture } from './records-fixture.js';

let f: Fixture;
const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAIN = id(1), FLOOD = id(2), SCOPED = id(3), ORPHAN = id(4), BOTH = id(5), ONE = id(6), OLD = id(7), NEW = id(8);

function session(sid: string, cwd: string, when: string, turns: {role: 'user' | 'assistant'; text: string}[], extra: {file?: string; agent?: string; parent?: string} = {}): void {
  const slug = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const dir = path.join(f.claudeDir, 'projects', slug);
  const file = extra.file ?? path.join(dir, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const t0 = Date.parse(when);
  const rows = turns.map((t, i) => ({
    sessionId: extra.parent ?? sid, cwd, uuid: `${sid}-${i}`, timestamp: new Date(t0 + i * 60_000).toISOString(),
    ...(extra.agent ? {isSidechain: true, agentId: extra.agent} : {}),
    type: t.role, message: t.role === 'user' ? {role: 'user', content: t.text} : {id: `${sid}-m${i}`, role: 'assistant', content: [{type: 'text', text: t.text}]},
  }));
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
}
const chat = (n: number, text: (i: number) => string) => Array.from({length: n}, (_, i) => ({role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: text(i)}));
function subagent(parent: string, cwd: string, agent: string, when: string, text: string): void {
  const slug = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const file = path.join(f.claudeDir, 'projects', slug, parent, 'subagents', `agent-${agent}.jsonl`);
  session(`agent-${agent}`, cwd, when, chat(4, i => (i === 1 ? text : `step ${i}`)), {file, agent, parent});
}

beforeAll(async () => {
  f = makeFixture();
  // A long main thread that mentions the orbit term once, with three subagents that mention it a lot.
  session(MAIN, '/work/fam', '2026-10-10T10:00:00Z', chat(40, i => (i === 7 ? 'we decided the quasarflux cache stays on' : `routine turn ${i}`)));
  for (const a of ['a1111111111111111', 'a2222222222222222', 'a3333333333333333']) subagent(MAIN, '/work/fam', a, '2026-10-10T11:00:00Z', 'quasarflux quasarflux quasarflux cache dump');
  // A subagent whose parent never says the word.
  session(ORPHAN, '/work/orph', '2026-10-11T10:00:00Z', chat(12, i => `nothing relevant ${i}`));
  subagent(ORPHAN, '/work/orph', 'a4444444444444444', '2026-10-11T11:00:00Z', 'the glimmerwort setting lives in config');
  // Filter before LIMIT: 450 stronger out-of-scope matches, one weak in-scope match.
  session(FLOOD, '/work/flood', '2026-10-12T10:00:00Z', chat(450, i => `zephyrine zephyrine zephyrine row ${i}`));
  session(SCOPED, '/work/scoped', '2026-10-13T10:00:00Z', chat(6, i => (i === 4 ? 'a long sentence that mentions zephyrine only once among many other words here' : `filler ${i}`)));
  // Coverage: all words (in different turns) beats one word repeated.
  session(BOTH, '/work/cov', '2026-10-14T10:00:00Z', chat(10, i => (i === 2 ? 'the marmalade decision' : i === 6 ? 'about the trellis layout' : `other ${i}`)));
  session(ONE, '/work/cov', '2026-10-14T12:00:00Z', chat(10, i => `marmalade marmalade marmalade ${i}`));
  // --latest: an old strong thread and a newer weak one.
  session(OLD, '/work/lat', '2026-09-01T10:00:00Z', chat(20, i => `vortexium release vortexium release ${i}`));
  session(NEW, '/work/lat', '2026-10-20T10:00:00Z', chat(20, i => (i === 3 ? 'vortexium release shipped as 2.0' : i === 9 ? 'final: vortexium release notes posted' : `misc ${i}`)));
  await syncRecords(syncOptions(f));
});
afterAll(() => fs.rmSync(f.root, {recursive: true, force: true}));

const withEngine = <T>(fn: (e: Engine) => T): T => { const e = new Engine(f.recordsDir, 'cli'); try { return fn(e); } finally { e.close(); } };
const rows = (out: string) => out.split('\n').filter(l => /^\[\d+\]/.test(l));

describe('main threads first', () => {
  it('one passage per session; a family shows its parent first and at most one child under it', () => {
    const out = withEngine(e => e.find({query: 'quasarflux'}));
    const r = rows(out);
    expect(r[0]).toContain(MAIN);
    expect(out.split('\n').filter(l => l.startsWith('    ↳ subagent: ')).length).toBe(1);
    expect(out).toContain('+2 more child threads matched: slopie search --parent ' + MAIN);
    expect(r.length).toBe(1);
  });

  it('collapses the other hits of a session into "+N more in this thread"', () => {
    const out = withEngine(e => e.find({query: 'zephyrine'}));
    expect(rows(out).filter(l => l.includes(FLOOD)).length).toBe(1);
    expect(out).toMatch(/\+\d+ more in this thread: slopie search zephyrine --session /);
  });

  it('a child that alone holds the words ranks on its own, labelled with its parent', () => {
    const out = withEngine(e => e.find({query: 'glimmerwort'}));
    expect(rows(out)[0]).toContain(`subagent of ${ORPHAN}`);
  });

  it('--include-subagents lists children as their own rows; --parent lists a thread\'s children', () => {
    const out = withEngine(e => e.find({query: 'quasarflux', includeSubagents: true}));
    expect(rows(out).length).toBe(4);
    const kids = withEngine(e => e.find({parent: MAIN}));
    expect(kids.match(/agent-a\d{16}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('sessions holding every word rank above partial ones, which are labelled', () => {
    const out = withEngine(e => e.find({query: 'marmalade trellis', project: 'cov'}));
    const r = rows(out);
    expect(r[0]).toContain(BOTH);
    expect(r[1]).toContain(ONE);
    expect(r[1]).toContain('(partial match)');
  });
});

describe('filters before LIMIT', () => {
  it('a scoped search keeps its match behind more than 400 stronger out-of-scope ones', () => {
    for (const o of [{project: 'scoped'}, {project: 'work/scoped'}, {since: '2026-10-13'}]) {
      const out = withEngine(e => e.find({query: 'zephyrine', ...o}));
      expect(rows(out)[0], JSON.stringify(o)).toContain(SCOPED);
    }
  });
});

describe('--latest', () => {
  it('sorts every matching thread by last activity and shows its last matching passage', () => {
    const out = withEngine(e => e.find({query: 'vortexium release', latest: true}));
    const r = rows(out);
    expect(r[0]).toContain(NEW);
    expect(r[1]).toContain(OLD);
    expect(out).toContain('last match t10 ASSISTANT');
    expect(out).toContain('final: vortexium release notes posted');
  });
});

describe('structured results and footers', () => {
  it('--json / MCP structuredContent carry hits with provenance', () => {
    const r = withEngine(e => e.findResult({query: 'quasarflux'}));
    expect(r.mode).toBe('search');
    expect(r.indexed_at).toMatch(/^\d{4}-/);
    expect(r.hits[0]).toMatchObject({session: MAIN, harness: 'claude', role: expect.any(String), turn: expect.any(Number)});
    expect(r.hits[1]!.root).toBe(MAIN);
    expect(r.next.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/^\(index: \d+ s old\)/);
    const m = callTool('search', {query: 'vortexium', latest: true}, f.recordsDir);
    expect(m.structured?.mode).toBe('latest');
  });

  it('no match: an executable relaxed query and the closest projects', () => {
    const none = withEngine(e => e.find({query: 'qqqqzzzz vortexiumz', project: 'lat'}));
    expect(none).toContain('slopie search qqqqzzzz --project lat');
    expect(withEngine(e => e.find({query: 'vortexium', project: 'latt'}))).toMatch(/--project lat\b/);
  });
});
