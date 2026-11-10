/**
 * Antigravity: synthetic data only (hand-built protobuf, brain dir, a temporary state.vscdb).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readProto, extractConversations, readBrain, loadAntigravity, STATE_KEY} from '../packages/core/src/adapters/antigravity.js';
import {antigravityStateDb} from '../packages/core/src/paths.js';
import {openDatabase} from '../packages/core/src/sqlite-driver.js';
import {syncRecords} from '../packages/core/src/records/sync.js';
import {Engine} from '../packages/core/src/records/engine.js';
import {createAuditSession} from '../packages/core/src/analytics/index.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => fs.rmSync(r, {recursive: true, force: true})); vi.unstubAllEnvs(); });
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'slopie-ag-test-')); roots.push(r); return r; };

/* ---- a tiny protobuf encoder ---- */
const vint = (n: number | bigint) => { let v = BigInt(n); const out: number[] = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const key = (f: number, w: number) => vint((f << 3) | w);
const V = (f: number, n: number | bigint) => Buffer.concat([key(f, 0), vint(n)]);
const L = (f: number, b: Buffer | string) => { const x = typeof b === 'string' ? Buffer.from(b) : b; return Buffer.concat([key(f, 2), vint(x.length), x]); };
const M = (...parts: Buffer[]) => Buffer.concat(parts);
const TS = (f: number, iso: string) => { const ms = Date.parse(iso); return L(f, M(V(1, Math.floor(ms / 1000)), V(2, (ms % 1000) * 1e6))); };

const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const TOKEN = 'ya29.synthetic-token-never-shown';

function conversation(id: string, title: string, workspace: string, day: string, brainDir: string): Buffer {
  const step = (tool: string, json: unknown, at: string) => L(5, M(TS(1, at), V(3, 2), L(4, M(L(1, '00000000-0000-4000-8000-000000000001'), L(2, tool), L(3, JSON.stringify(json)))), L(5, 'Message')));
  return L(1, M(L(1, id), L(2, M(
    L(1, title), V(2, 12), TS(3, `${day}T10:00:00Z`), L(4, '00000000-0000-4000-8000-000000000002'), V(5, 1), TS(7, `${day}T09:00:00Z`),
    L(9, M(L(1, workspace), L(2, 'file:///'), L(3, ''))), TS(10, `${day}T09:30:00Z`),
    L(12, M(L(1, M(V(1, 3), step('notify_user', {BlockedOnUser: false, Message: `Finished the ${title.toLowerCase()} pass`}, `${day}T09:40:00Z`),
      L(94, M(L(1, `file://${brainDir}/${id}/task.md`))))))),
    L(14, M(L(1, M(V(1, 4), step('task_boundary', {Mode: 'VERIFICATION', TaskName: 'Verify synthetic build', TaskStatus: 'done'}, `${day}T09:50:00Z`))))),
  ))));
}

function stateBlob(brainDir: string): Buffer {
  return M(L(1, M(conversation(ID1, 'Synthetic Glacier Fix', 'file:///work/synthetic-app', '2026-09-01', brainDir),
    conversation(ID2, 'Orchard Layout Pass', 'file:///work/other%20app', '2026-09-03', brainDir))), L(6, M(L(1, TOKEN), L(2, 'Bearer'))));
}

function writeBrain(root: string, id: string) {
  const d = path.join(root, 'brain', id);
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, 'task.md'), '# Task\n- [ ] old');
  fs.writeFileSync(path.join(d, 'task.md.resolved'), '# Task\n- [x] calibrate the periwinkle sensor');
  fs.writeFileSync(path.join(d, 'task.md.metadata.json'), JSON.stringify({artifactType: 'ARTIFACT_TYPE_TASK', summary: 'Checklist for the sensor', updatedAt: '2026-09-02T08:00:00Z', version: '2'}));
  fs.writeFileSync(path.join(d, 'walkthrough.md'), 'Walkthrough without metadata');
}

function writeState(file: string, blob: Buffer) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const db = openDatabase(file, {});
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(STATE_KEY, blob.toString('base64'));
  db.close();
}

/** A full synthetic Antigravity install under `root`; returns its dirs. */
function install(root: string, stateDb = path.join(root, 'state', 'state.vscdb')) {
  const dir = path.join(root, '.gemini', 'antigravity');
  fs.mkdirSync(path.join(dir, 'conversations'), {recursive: true});
  for (const [id, day] of [[ID1, '2026-09-01'], [ID2, '2026-09-03']] as const) {
    const pb = path.join(dir, 'conversations', `${id}.pb`);
    fs.writeFileSync(pb, Buffer.from([0x9f, 0x3c, 0xe1, 0x07, 0x55]));
    const t = new Date(`${day}T11:00:00Z`);
    fs.utimesSync(pb, t, t);
  }
  writeBrain(dir, ID1);
  writeState(stateDb, stateBlob(path.join(dir, 'brain')));
  return {dir, stateDb};
}

describe('protobuf wire reader', () => {
  it('reads varint, fixed64, length-delimited and fixed32 fields', () => {
    const b = Buffer.concat([Buffer.from([0x08, 0x96, 0x01]), key(2, 1), Buffer.alloc(8, 1), L(3, 'hi'), key(4, 5), Buffer.from([1, 2, 3, 4])]);
    const f = readProto(b);
    expect(f.map(x => [x.field, x.wire])).toEqual([[1, 0], [2, 1], [3, 2], [4, 5]]);
    expect(f[0]!.value).toBe(150n);
    expect(Buffer.from(f[2]!.value as Uint8Array).toString()).toBe('hi');
  });
  it('throws on truncated or unsupported input', () => {
    expect(() => readProto(Buffer.from([0x0a, 0x05, 0x61]))).toThrow();
    expect(() => readProto(Buffer.from([0x0b]))).toThrow();
    expect(() => readProto(Buffer.from([0x08, 0xff]))).toThrow();
  });
});

describe('agentManagerInitState extractor', () => {
  it('groups titles, workspaces, timestamps and steps by conversation, and never surfaces the top-level tokens', () => {
    const gaps: string[] = [];
    const convs = extractConversations(stateBlob('/home/u/.gemini/antigravity/brain'), gaps);
    expect(gaps).toEqual([]);
    expect(convs.map(c => c.id)).toEqual([ID1, ID2]);
    const [a, b] = convs as [typeof convs[0], typeof convs[0]];
    expect(a.title).toBe('Synthetic Glacier Fix');
    expect(a.workspace).toBe('/work/synthetic-app');
    expect(b.workspace).toBe('/work/other app');
    expect(new Date(a.times[0]!).toISOString()).toBe('2026-09-01T09:00:00.000Z');
    expect(a.steps.map(s => s.tool)).toEqual(['notify_user', 'task_boundary']);
    expect(a.steps[0]!.message).toBe('Finished the synthetic glacier fix pass');
    expect(a.steps[0]!.at).toBe(Date.parse('2026-09-01T09:40:00Z'));
    expect(a.steps[1]).toMatchObject({taskName: 'Verify synthetic build', taskStatus: 'done', mode: 'VERIFICATION'});
    expect(a.artifacts).toEqual([`/home/u/.gemini/antigravity/brain/${ID1}/task.md`]);
    expect(JSON.stringify(convs)).not.toContain(TOKEN);
  });
  it('skips a malformed blob or a malformed conversation with a gap, keeping the rest', () => {
    const gaps: string[] = [];
    expect(extractConversations(Buffer.from([0xff, 0xff, 0xff]), gaps)).toEqual([]);
    expect(gaps).toContain('antigravity_state_unreadable');
    const g2: string[] = [];
    const bad = L(1, M(L(1, '99999999-9999-4999-8999-999999999999'), L(2, M(V(7, 1)))));
    const blob = M(L(1, M(bad, conversation(ID1, 'Synthetic Glacier Fix', 'file:///work/x', '2026-09-01', '/b'))));
    expect(extractConversations(blob, g2).map(c => c.id)).toEqual([ID1]);
    expect(g2).toContain('antigravity_conversation_unreadable');
  });
});

describe('brain artifacts', () => {
  it('reads the latest .resolved content, else the .md, with metadata', () => {
    const root = tmp();
    writeBrain(root, ID1);
    const arts = readBrain(path.join(root, 'brain', ID1));
    expect(arts.map(a => a.name)).toEqual(['task.md', 'walkthrough.md']);
    expect(arts[0]).toMatchObject({summary: 'Checklist for the sensor', artifactType: 'ARTIFACT_TYPE_TASK', updatedAt: Date.parse('2026-09-02T08:00:00Z')});
    expect(arts[0]!.text).toContain('periwinkle');
    expect(arts[0]!.file.endsWith('task.md.resolved')).toBe(true);
    expect(arts[1]).toMatchObject({summary: null, updatedAt: null, text: 'Walkthrough without metadata'});
  });
  it('loads sessions from .pb names, brain dirs and the state database', () => {
    const root = tmp();
    const {dir, stateDb} = install(root);
    const d = loadAntigravity({dir, stateDb});
    expect(d.gaps).toEqual([]);
    expect(d.sessions.map(s => s.id).sort()).toEqual([ID1, ID2]);
    const s = d.sessions.find(x => x.id === ID1)!;
    expect(s).toMatchObject({title: 'Synthetic Glacier Fix', project: '/work/synthetic-app'});
    expect(s.pb && s.brain && s.state).toBeTruthy();
  });
});

describe('audit with only Antigravity data', () => {
  it('finishes and shows chats and days, no prompts and no $0', async () => {
    const home = tmp();
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('XDG_CONFIG_HOME', ''); vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', ''); vi.stubEnv('CODEX_HOME', ''); vi.stubEnv('POTSHERD_OFFLINE', '1');
    install(home, antigravityStateDb());
    const session = createAuditSession({launch: true, timezone: 'UTC', derivedCacheDir: path.join(home, 'cache'), potsherdDir: path.join(home, '.potsherd')});
    let s;
    try { s = await session.run(); } finally { session.dispose(); }
    expect(s.status === 'ready' || s.status === 'partial').toBe(true);
    const row = s.sources.find(x => x.harness === 'antigravity')!;
    expect(row).toMatchObject({state: 'available', conversations: 2, humanPrompts: null, usage: 'unavailable', promptsReadable: false, projects: 2, firstDay: '2026-09-01', lastDay: '2026-09-03'});
    expect(row.activeDays).toBe(3);
    expect(row.gapCodes).toEqual(expect.arrayContaining(['prompts_encrypted', 'usage_not_recorded']));
    expect('costUsd' in row).toBe(false);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });
});

describe('records', () => {
  const base = (root: string) => {
    for (const d of ['claude', 'codex', 'pi', 'potsherd', 'slopie']) fs.mkdirSync(path.join(root, d), {recursive: true});
    return {recordsDir: path.join(root, 'slopie', 'records'), claudeDir: path.join(root, 'claude'), codexDir: path.join(root, 'codex'), piDir: path.join(root, 'pi'),
      potsherdDir: path.join(root, 'potsherd'), slopieDir: path.join(root, 'slopie'), workerUrl: null};
  };
  it('sync writes one record per conversation, indexed and searchable by title and artifact text', async () => {
    const root = tmp();
    const {dir, stateDb} = install(root);
    const o = {...base(root), antigravityDir: dir, antigravityStateDb: stateDb};
    const r = await syncRecords(o);
    expect(r.byHarness['antigravity']).toBe(2);
    const files = fs.readdirSync(path.join(o.recordsDir, 'antigravity'), {recursive: true}).map(String).filter(f => f.endsWith('.txt'));
    expect(files).toHaveLength(2);
    expect(files.some(f => f.includes('work-synthetic-app') && f.endsWith(`2026-09-01_${ID1}.txt`))).toBe(true);
    const text = fs.readFileSync(path.join(o.recordsDir, 'antigravity', files.find(f => f.includes(ID1))!), 'utf8');
    expect(text).toContain(`## session antigravity:${ID1}`);
    expect(text).toContain('## title: Synthetic Glacier Fix');
    expect(text).toMatch(/ASSISTANT 2026-09-01 09:40 \| Finished the synthetic glacier fix pass/);
    expect(text).toContain('SYSTEM 2026-09-01 09:50 | task: Verify synthetic build · done (VERIFICATION)');
    expect(text).toContain('TOOL artifact');
    expect(text).toContain('periwinkle');
    expect(text).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(o.recordsDir, 'INDEX.tsv'), 'utf8').split('\n').filter(l => l.startsWith('antigravity\t'))).toHaveLength(2);
    const e = new Engine(o.recordsDir, 'cli');
    try {
      expect(e.search({query: 'Glacier', harness: 'antigravity'})).toContain(ID1.slice(0, 8));
      expect(e.search({query: 'periwinkle', harness: 'antigravity'})).toContain(ID1.slice(0, 8));
      expect(e.search({query: 'Orchard', harness: 'antigravity'})).toContain(ID2.slice(0, 8));
    } finally { e.close(); }
    // Unchanged inputs: nothing is rewritten.
    const r2 = await syncRecords(o);
    expect(r2.written).toBe(0);
    expect(r2.byHarness['antigravity']).toBe(2);
    expect(r2.kept).toBe(0);
  });
  it('without Antigravity data, nothing changes', async () => {
    const root = tmp();
    const o = {...base(root), antigravityDir: path.join(root, 'none'), antigravityStateDb: path.join(root, 'none', 'state.vscdb')};
    const r = await syncRecords(o);
    expect(r.byHarness['antigravity']).toBeUndefined();
    expect(fs.existsSync(path.join(o.recordsDir, 'antigravity'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(o.recordsDir, '.slopie', 'state.json'), 'utf8')).ag).toBeUndefined();
  });
});
