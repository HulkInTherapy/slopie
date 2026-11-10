/**
 * Opt-outs that cannot be read stop sync and the audit (1.9.0 review D4): "you forgot nothing" and "your
 * forget list is unreadable" are different facts, and only the first may lead to writing a record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { loadPolicy, PolicyError, writeForgetList } from '../packages/core/src/sources/policy.js';
import { sourceId } from '../packages/core/src/sources/identity.js';
import { writeIgnoreList } from '../packages/core/src/ignore.js';
import { createAuditSession } from '../packages/core/src/analytics/index.js';
import { IDS, makeFixture, syncOptions, type Fixture } from './records-fixture.js';

const made: Fixture[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, {recursive: true, force: true}); });
const fixture = () => { const f = makeFixture(); made.push(f); return f; };

const rows = (f: Fixture) => fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8').trimEnd().split('\n').slice(1).map(l => l.split('\t'));
const rowOf = (f: Fixture, id: string) => rows(f).find(r => r[1] === id);
const recordFiles = (f: Fixture) => (fs.readdirSync(f.recordsDir, {recursive: true}) as string[]).filter(n => n.endsWith('.txt') && !n.startsWith('.slopie')).sort();

describe('D4: unreadable opt-outs stop sync and the audit', () => {
  it('a corrupt forget list does not bring a forgotten session back', async () => {
    const f = fixture();
    writeForgetList([{sourceId: sourceId('claude', IDS.claude)}], f.slopieDir);
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)).toBeUndefined();
    const files = recordFiles(f);
    fs.writeFileSync(path.join(f.slopieDir, 'forget.json'), '{corrupt');
    await expect(syncRecords(syncOptions(f))).rejects.toThrow(PolicyError);
    expect(rowOf(f, IDS.claude)).toBeUndefined();
    expect(recordFiles(f)).toEqual(files);
    // A forget list without its list is not "nothing forgotten" either.
    fs.writeFileSync(path.join(f.slopieDir, 'forget.json'), '{"version": 1}');
    await expect(syncRecords(syncOptions(f))).rejects.toThrow(/forget\.json/);
  });

  it('a corrupt ignore list does not bring an ignored project back', async () => {
    const f = fixture();
    writeIgnoreList(f.slopieDir, ['demo-app']);
    await syncRecords(syncOptions(f));
    expect(rowOf(f, IDS.claude)).toBeUndefined();
    fs.writeFileSync(path.join(f.slopieDir, 'config.json'), '{corrupt');
    await expect(syncRecords(syncOptions(f))).rejects.toThrow(/config\.json/);
    expect(rowOf(f, IDS.claude)).toBeUndefined();
  });

  it('an unreadable (not missing) opt-out file is an error, not an empty list', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.slopieDir, 'forget.json'), {recursive: true});
    const p = loadPolicy(f.potsherdDir, f.slopieDir);
    expect(p.error).toBe('forget_list_unreadable');
    expect(loadPolicy(f.potsherdDir, path.join(f.root, 'fresh')).error).toBeNull();
  });

  it('the audit stops before it reads anything', async () => {
    const f = fixture();
    const saved = process.env['SLOPIE_DIR'];
    process.env['SLOPIE_DIR'] = f.slopieDir;
    try {
      fs.mkdirSync(f.slopieDir, {recursive: true});
      fs.writeFileSync(path.join(f.slopieDir, 'forget.json'), '{corrupt');
      const s = createAuditSession({potsherdDir: f.potsherdDir, claudeDir: f.claudeDir, codexDir: f.codexDir, piDir: f.piDir, opencodeDir: path.join(f.root, 'absent')});
      try { await expect(s.run()).rejects.toThrow(PolicyError); } finally { s.dispose(); }
    } finally {
      if (saved === undefined) delete process.env['SLOPIE_DIR']; else process.env['SLOPIE_DIR'] = saved;
    }
  });
});

describe('an old potsherd store never blocks the audit', () => {
  const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'slopie-legacy-'));
  const make = (sql: string | null) => {
    const root = tmp();
    const db = path.join(root, 'potsherd.db');
    if (sql === null) fs.writeFileSync(db, 'not a database');
    else require('node:child_process').execFileSync('sqlite3', [db, sql]);
    return root;
  };
  it('a store from before the forget tables means nothing is forgotten, not an error', () => {
    const policy = loadPolicy(make('CREATE TABLE memory_sources(id INTEGER, path TEXT); CREATE TABLE exchanges(id INTEGER);'), tmp());
    expect(policy.error).toBeNull();
    expect(policy.warnings).toEqual([]);
    expect(policy.forgotten.size).toBe(0);
  });
  it('forget choices in a current-schema store still apply', () => {
    const policy = loadPolicy(make(`CREATE TABLE memory_sources(source_id TEXT, availability TEXT); INSERT INTO memory_sources VALUES ('claude:abc','forgotten'),('claude:def','live');
      CREATE TABLE forget_tombstones(source_id TEXT, state TEXT); INSERT INTO forget_tombstones VALUES ('codex:x','active'),('codex:y','reversed');`), tmp());
    expect(policy.error).toBeNull();
    expect([...policy.forgotten].sort()).toEqual(['claude:abc', 'codex:x']);
  });
  it('an unreadable old store is a warning, not a stop', () => {
    const policy = loadPolicy(make(null), tmp());
    expect(policy.error).toBeNull();
    expect(policy.warnings.length).toBe(1);
  });
});
