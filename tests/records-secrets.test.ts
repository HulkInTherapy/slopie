/**
 * 1.9.1 P0: no secret reaches an agent. Synthetic keys of every family are seeded into a live session (text,
 * escaped JSON, tool input and output, title, first ask, last answer) and into a retained record whose source
 * is gone; after sync, no unmasked value is on disk under the records root or in any search output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { callTool } from '../packages/core/src/records/mcp.js';
import { scrub } from '../packages/core/src/records/scrub.js';
import { listFiles } from '../packages/core/src/sources/discover.js';
import { makeFixture, syncOptions, type Fixture } from './records-fixture.js';

// Built at runtime so no key-shaped literal sits in the repo.
const K = {
  tavily: 'tvly-' + 'dev-' + 'aaaabbbbccccdddd1234',          // low entropy: the vendor rule, not entropy, must catch it
  tavily2: 'tvly-' + 'Zq81mVx0Lr4TbN7wKc2Yp9Hd',
  telegram: '7123456789' + ':AA' + 'Hk3jQ9mZx2Lp0Vb7Rt5Wn8Cy1Fs4Gd6Ue',
  openai: 's' + 'k-proj-' + 'Q7f2Lm9Xv4Rb8Tz1Kc6Wp3Yn5Hd0Js2Ga8Ue4Mi7Ob',
  anthropic: 's' + 'k-ant-api03-' + 'x8Kq2Lm7Rv4Tz9Wb1Yc6Hp3Nd5Jf0Gs2Ua8Ei4Mo7Qk1Lt3Rv9Zx6Cb2Np5Hd8Jf0Gs4Ua7Ei1Mo3Qk6Lt9Rv2Zx5Cb8Np-AA',
  github: 'gh' + 'p_' + 'R7k2Lm9Xv4Qb8Tz1Kc6Wp3Yn5Hd0Js2Ga8Ue4',
  aws: 'AK' + 'IA' + 'Q7F2LM9XV4RB8TZ1',
} as const;
const VALUES = Object.values(K);

const SID = 'cccccccc-0000-4000-8000-000000000001';
const RETAINED = 'cccccccc-0000-4000-8000-000000000002';
let f: Fixture;

const leaks = (text: string) => VALUES.filter(v => text.includes(v) || text.includes(v.slice(0, 18)));

beforeAll(async () => {
  f = makeFixture();
  const dir = path.join(f.claudeDir, 'projects', '-work-keys');
  fs.mkdirSync(dir, {recursive: true});
  const base = {sessionId: SID, cwd: '/work/keys', timestamp: '2026-10-07T00:00:00.000Z'};
  const env = JSON.stringify({env: {TAVILY_API_KEY: K.tavily, TELEGRAM_BOT_TOKEN: K.telegram}});
  const rows = [
    {type: 'custom-title', customTitle: `rotate ${K.tavily2} today`, sessionId: SID},
    {type: 'user', message: {role: 'user', content: `my keys: TAVILY_API_KEY=${K.tavily} and OPENAI_API_KEY=${K.openai}`}},
    {type: 'assistant', message: {id: 'm1', role: 'assistant', content: [{type: 'tool_use', id: 'tu1', name: 'Bash', input: {command: `echo '${env}' > .env && export GITHUB_TOKEN=${K.github}`}}]}},
    {type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu1', content: `wrote ${env}\nAWS_ACCESS_KEY_ID=${K.aws}\nANTHROPIC_API_KEY=${K.anthropic}\n` + 'filler '.repeat(900) + `tail ${K.tavily}`}]}},
    {type: 'assistant', message: {id: 'm2', role: 'assistant', content: [{type: 'text', text: `done, the bot token ${K.telegram} works and ${K.tavily2} is set`}]}},
  ];
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.map((r, i) => JSON.stringify({...base, uuid: `k${i}`, ...r}) + '\n').join(''));
  await syncRecords(syncOptions(f));
  // A pre-1.9.1 retained record (its source deleted long ago), written raw, and a state from before the migration.
  const rel = path.join('claude', 'work-keys', `2026-10-08_${RETAINED}.txt`);
  fs.mkdirSync(path.dirname(path.join(f.recordsDir, rel)), {recursive: true});
  fs.writeFileSync(path.join(f.recordsDir, rel), [
    `## session claude:${RETAINED}`, '## project: /work/keys', `## title: old keys ${K.github}`,
    '## time: 2026-10-08T10:00:00Z -> 2026-10-08T10:05:00Z   turns: 2', '## parent: none', '## children: none', '## raw: /gone/source.jsonl',
    `t1 USER 2026-10-08 10:00 | set TAVILY_API_KEY=${K.tavily} please`,
    `t2 TOOL Bash 10:01 | export TELEGRAM_BOT_TOKEN=${K.telegram}`, `t2 > ok ${K.aws}`,
  ].join('\n') + '\n');
  const stateFile = path.join(f.recordsDir, '.slopie', 'state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete st.redact;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  await syncRecords(syncOptions(f));
});
afterAll(() => fs.rmSync(f.root, {recursive: true, force: true}));

describe('scrub', () => {
  it('masks every family, keeps the variable name, and is idempotent', () => {
    const s = scrub(`TAVILY_API_KEY=${K.tavily} bot ${K.telegram}`);
    expect(s).toContain('TAVILY_API_KEY=[REDACTED:tavily]');
    expect(s).toContain('[REDACTED:telegram]');
    for (const v of VALUES) expect(scrub(`x ${v} y`)).not.toContain(v);
    expect(scrub(s)).toBe(s);
    expect(scrub(`"{\\"TAVILY_API_KEY\\":\\"${K.tavily}\\"}"`)).not.toContain(K.tavily);
  });
});

describe('P0: no secret on disk or in any output', () => {
  it('records, sidecars, INDEX.tsv, state and the SQLite index hold no unmasked value', () => {
    const files = listFiles(f.recordsDir, () => true).filter(x => fs.statSync(x).isFile());
    expect(files.some(x => x.endsWith(`${RETAINED}.txt`))).toBe(true);
    for (const file of files) {
      const bytes = fs.readFileSync(file).toString('latin1');
      expect(leaks(bytes), file).toEqual([]);
    }
    const retained = fs.readFileSync(files.find(x => x.endsWith(`${RETAINED}.txt`))!, 'utf8');
    expect(retained).toContain('TAVILY_API_KEY=[REDACTED:tavily]');
    expect(retained).toMatch(/^t2 > ok \[REDACTED:aws\]$/m);
  });

  it('every read path is clean: search, --session, inside, list, json and MCP', () => {
    const e = new Engine(f.recordsDir, 'cli');
    const outs: string[] = [];
    try {
      for (const q of ['tvly', 'TAVILY_API_KEY', 'TELEGRAM_BOT_TOKEN', 'AWS_ACCESS_KEY_ID', 'keys', 'rotate today', 'bot token']) outs.push(e.find({query: q}));
      for (const id of [SID, RETAINED]) {
        outs.push(e.find({session: id}), e.find({session: id, turns: '-30'}));
        for (const q of ['tvly', 'TOKEN', 'API_KEY', 'AA', 'export']) outs.push(e.find({session: id, query: q}));
        outs.push(e.grep({session: id, pattern: 'tvly-[a-z0-9-]+', regex: true}));
      }
      outs.push(e.find({}), e.threads({}), e.threads({text: 'keys'}));
    } finally { e.close(); }
    for (const q of ['tvly', 'TAVILY_API_KEY']) outs.push(JSON.stringify(callTool('search', {query: q}, f.recordsDir)));
    outs.push(JSON.stringify(callTool('search', {session: SID, query: 'tvly'}, f.recordsDir)));
    const all = outs.join('\n');
    expect(all).toContain('[REDACTED:');
    expect(leaks(all)).toEqual([]);
  });

  it('the full-text index holds no token of a secret (rebuilt, not patched)', () => {
    const e = new Engine(f.recordsDir, 'cli');
    try {
      for (const v of VALUES) {
        const tail = v.split(/[^A-Za-z0-9]/).filter(x => x.length >= 12).pop()!;
        expect((e.db.prepare('select count(*) as n from ctx where ctx match ?').get(`"${tail}"`) as {n: number}).n, v.slice(0, 4)).toBe(0);
        expect((e.db.prepare('select count(*) as n from cards where cards match ?').get(`"${tail}"`) as {n: number}).n).toBe(0);
      }
    } finally { e.close(); }
  });

  it('turn numbering is unchanged by redaction', () => {
    const e = new Engine(f.recordsDir, 'cli');
    try { expect(e.find({session: SID})).toMatch(/· 3 turns ·/); } finally { e.close(); }
  });
});
