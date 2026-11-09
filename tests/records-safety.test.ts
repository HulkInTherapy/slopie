/**
 * The records are an archive: nothing the user did not ask to remove may disappear from them.
 * Regression tests for the 1.9.0 review (D1 full rebuild, D2 case-insensitive volumes, D3 prompt-only
 * records). Synthetic history only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { writeForgetList } from '../packages/core/src/sources/policy.js';
import { sourceId } from '../packages/core/src/sources/identity.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { IDS, makeFixture, syncOptions, type Fixture } from './records-fixture.js';

const made: Fixture[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, {recursive: true, force: true}); });
const fixture = () => { const f = makeFixture(); made.push(f); return f; };

const rows = (f: Fixture) => fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8').trimEnd().split('\n').slice(1).map(l => l.split('\t'));
const rowOf = (f: Fixture, id: string) => rows(f).find(r => r[1] === id);
const recordOf = (f: Fixture, id: string) => fs.readFileSync(path.join(f.recordsDir, rowOf(f, id)![9]!), 'utf8');
const state = (f: Fixture) => JSON.parse(fs.readFileSync(path.join(f.recordsDir, '.slopie', 'state.json'), 'utf8')) as {sessions: Record<string, {id: string; rel: string}>};
const recordFiles = (f: Fixture) => (fs.readdirSync(f.recordsDir, {recursive: true}) as string[]).filter(n => n.endsWith('.txt') && !n.startsWith('.slopie')).sort();
const dropClaudeSources = (f: Fixture) => {
  fs.rmSync(f.claudeFile);
  fs.rmSync(path.join(f.potsherdDir, 'archive', 'evidence', 'aaaa1111.jsonl'));
};
const dropHistory = (f: Fixture) => {
  fs.rmSync(path.join(f.claudeDir, 'history.jsonl'));
  fs.rmSync(path.join(f.potsherdDir, 'archive', 'claude', 'history.jsonl'));
};
const threads = (f: Fixture, o: Parameters<Engine['threads']>[0]) => { const e = new Engine(f.recordsDir, 'cli'); try { return e.threads(o); } finally { e.close(); } };

describe('D1: sync --full keeps records whose sources are gone', () => {
  it('rebuilds the index and every record, and keeps (and re-indexes) the archived one', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const before = recordOf(f, IDS.claude);
    dropClaudeSources(f);
    expect((await syncRecords(syncOptions(f))).kept).toBe(1);
    const full = await syncRecords(syncOptions(f, {full: true}));
    expect(full.kept).toBeGreaterThanOrEqual(1);
    expect(recordOf(f, IDS.claude)).toBe(before);
    expect(threads(f, {text: 'pgbouncer'})).toContain(IDS.claude);
    // A second full rebuild changes nothing either.
    await syncRecords(syncOptions(f, {full: true}));
    expect(recordOf(f, IDS.claude)).toBe(before);
  });

  it('adopts record files when the state file is lost instead of deleting them', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const before = recordOf(f, IDS.claude);
    const files = recordFiles(f);
    dropClaudeSources(f);
    fs.rmSync(path.join(f.recordsDir, '.slopie', 'state.json'));
    await syncRecords(syncOptions(f, {full: true}));
    expect(recordFiles(f)).toEqual(files);
    expect(recordOf(f, IDS.claude)).toBe(before);
    expect(threads(f, {text: 'pgbouncer'})).toContain(IDS.claude);
  });
});

describe('D2: case-insensitive volumes (one directory, two spellings)', () => {
  /** Two projects whose record directories differ only in case; aliased the way APFS aliases them. */
  function aliased(f: Fixture): {upper: string; lower: string} {
    const claude = path.join(f.recordsDir, 'claude');
    fs.mkdirSync(path.join(claude, 'work-Demo'), {recursive: true, mode: 0o700});
    // On a case-insensitive volume the alias exists already; elsewhere a symlink makes the same aliasing.
    if (!fs.existsSync(path.join(claude, 'work-demo'))) fs.symlinkSync('work-Demo', path.join(claude, 'work-demo'));
    const upper = 'aaaaaaaa-0000-4000-8000-000000000001', lower = 'aaaaaaaa-0000-4000-8000-000000000002';
    const proj = path.join(f.claudeDir, 'projects', '-work-demo');
    fs.mkdirSync(proj, {recursive: true});
    const session = (id: string, cwd: string, text: string) => JSON.stringify({type: 'user', sessionId: id, cwd, uuid: `u-${id}`, timestamp: '2026-10-05T00:00:00.000Z', message: {role: 'user', content: text}}) + '\n';
    fs.writeFileSync(path.join(proj, `${upper}.jsonl`), session(upper, '/work/Demo', 'upper case project'));
    fs.writeFileSync(path.join(proj, `${lower}.jsonl`), session(lower, '/work/demo', 'lower case project'));
    return {upper, lower};
  }

  it('never deletes a record it reached through another spelling of its directory', async () => {
    const f = fixture();
    const {upper, lower} = aliased(f);
    const r = await syncRecords(syncOptions(f));
    expect(r.removed).toBe(0);
    for (const s of Object.values(state(f).sessions)) expect(fs.existsSync(path.join(f.recordsDir, s.rel)), s.rel).toBe(true);
    // The paths kept are the ones the directory really has.
    expect(rowOf(f, lower)![9]).toBe(`claude/work-Demo/2026-10-05_${lower}.txt`);
    expect(recordOf(f, upper)).toContain('upper case project');
    expect(recordOf(f, lower)).toContain('lower case project');
    const again = await syncRecords(syncOptions(f));
    expect(again.removed).toBe(0);
    expect(recordOf(f, lower)).toContain('lower case project');
  });

  it('keeps a record whose project changes only in case', async () => {
    const f = fixture();
    const {upper} = aliased(f);
    await syncRecords(syncOptions(f));
    const proj = path.join(f.claudeDir, 'projects', '-work-demo', `${upper}.jsonl`);
    fs.writeFileSync(proj, fs.readFileSync(proj, 'utf8').replace('/work/Demo', '/work/demo') + JSON.stringify({type: 'user', sessionId: upper, cwd: '/work/demo', uuid: 'u-more', timestamp: '2026-10-05T00:01:00.000Z', message: {role: 'user', content: 'one more'}}) + '\n');
    await syncRecords(syncOptions(f));
    expect(recordOf(f, upper)).toContain('one more');
  });

  it.runIf(process.platform === 'darwin')('on this Mac\'s volume: the real case-insensitive case', async () => {
    const f = fixture();
    const probe = path.join(f.root, 'CaseProbe');
    fs.mkdirSync(probe);
    if (!fs.existsSync(path.join(f.root, 'caseprobe'))) return; // a case-sensitive volume: covered above
    const {upper, lower} = aliased(f);
    expect(fs.lstatSync(path.join(f.recordsDir, 'claude', 'work-demo')).isSymbolicLink()).toBe(false);
    await syncRecords(syncOptions(f));
    await syncRecords(syncOptions(f));
    expect(recordOf(f, upper)).toContain('upper case project');
    expect(recordOf(f, lower)).toContain('lower case project');
  });
});

describe('D3: prompt-only records outlive history.jsonl', () => {
  it('keeps them when history.jsonl goes, and merges new prompts when it comes back shorter', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    const before = recordOf(f, IDS.promptOnly);
    dropHistory(f);
    const r = await syncRecords(syncOptions(f));
    expect(r.promptOnly).toBe(1);
    expect(recordOf(f, IDS.promptOnly)).toBe(before);
    // History is back, rotated: the first prompt is gone, a new one is there.
    fs.writeFileSync(path.join(f.claudeDir, 'history.jsonl'), [
      {display: 'and document it', timestamp: Date.parse('2026-09-20T08:05:00Z'), project: '/work/printer', sessionId: IDS.promptOnly},
      {display: 'now add rate limits', timestamp: Date.parse('2026-09-20T09:00:00Z'), project: '/work/printer', sessionId: IDS.promptOnly},
    ].map(x => JSON.stringify(x) + '\n').join(''));
    await syncRecords(syncOptions(f));
    const text = recordOf(f, IDS.promptOnly);
    expect(text).toContain('t1 USER 2026-09-20 08:00 | make every feature available over an API');
    expect(text).toContain('t2 USER 2026-09-20 08:05 | and document it');
    expect(text).toContain('t3 USER 2026-09-20 09:00 | now add rate limits');
    expect(text).not.toContain('t4 ');
    // Stable: the next sync rewrites nothing.
    expect((await syncRecords(syncOptions(f))).written).toBe(0);
    // Forgetting is still the way to remove it.
    writeForgetList([{sourceId: sourceId('claude', IDS.promptOnly)}], f.slopieDir);
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.promptOnly)).toBeUndefined();
  });

  it('a full rebuild keeps them too', async () => {
    const f = fixture();
    await syncRecords(syncOptions(f));
    dropHistory(f);
    await syncRecords(syncOptions(f, {full: true}));
    expect(recordOf(f, IDS.promptOnly)).toContain('make every feature available over an API');
  });
});
