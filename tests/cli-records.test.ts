import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFixture, IDS, type Fixture } from './records-fixture.js';

/** The records verbs through the shipped binary (built bundle), on a synthetic history. */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'slopie.js');
const made: Fixture[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, { recursive: true, force: true }); });

function setup(): Fixture {
  const f = makeFixture();
  made.push(f);
  return f;
}

function run(f: Fixture, args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, NO_COLOR: '1', HOME: f.root, SLOPIE_DIR: f.slopieDir, SLOPIE_RECORDS_DIR: f.recordsDir, CLAUDE_CONFIG_DIR: f.claudeDir,
    POTSHERD_CODEX_DIR: f.codexDir, POTSHERD_PI_DIR: f.piDir, POTSHERD_DIR: f.potsherdDir, PATH: path.dirname(process.execPath) };
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('slopie sync / search (and the hidden read / threads / grep aliases)', () => {
  it('sync writes the records and the verbs read them', () => {
    const f = setup();
    const s = run(f, ['sync', '--json']);
    expect(s.code, s.stderr).toBe(0);
    const r = JSON.parse(s.stdout) as { sessions: number; promptOnly: number; subagents: number };
    expect(r).toMatchObject({ sessions: 6, promptOnly: 1, subagents: 1 });
    expect(run(f, ['search', 'pgbouncer', 'pool']).stdout).toMatch(/→ slopie search --session \S+ --turns \d+-\d+/);
    expect(run(f, ['search', '--session', IDS.claude, '--turns', '-2']).stdout).toContain('[turns 4-5 of 5; end of thread.');
    expect(run(f, ['search', 'ZEBRA_MIDDLE_NEEDLE_42', '--session', IDS.claude]).stdout).toContain('(output)');
    expect(run(f, ['search', '--project', 'demo-app']).stdout).toContain(IDS.claude);
    expect(run(f, ['read', IDS.claude, '--from', '-2']).stdout).toContain('[turns 4-5 of 5; end of thread.');
    expect(run(f, ['threads', '--text', 'pool']).stdout).toContain('threads containing all of: pool');
    expect(run(f, ['grep', IDS.claude, 'ZEBRA_MIDDLE_NEEDLE_42']).stdout).toContain('(output)');
    const j = JSON.parse(run(f, ['search', 'pgbouncer', '--json']).stdout) as { mode: string; indexed_at: string; partial: boolean; hits: { session: string; read_cmd: string }[]; next: string[] };
    expect(j).toMatchObject({ mode: 'search', partial: false });
    expect(j.hits[0]!.read_cmd).toMatch(/^slopie search --session /);
    expect(j.next.length).toBeGreaterThan(0);
  });

  it('search refreshes a stale index first, within its budget, and says how old the index is', () => {
    const f = setup();
    expect(run(f, ['sync', '--quiet']).code).toBe(0);
    const idx = path.join(f.recordsDir, '.slopie', 'index.sqlite');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(idx, old, old);
    const env = process.env['SLOPIE_NO_SYNC'];
    delete process.env['SLOPIE_NO_SYNC'];
    try {
      const t0 = Date.now();
      const out = run(f, ['search', 'pgbouncer']).stdout;
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(out).toMatch(/^\(index: [^)]+ old\)/);
    } finally { process.env['SLOPIE_NO_SYNC'] = env; }
  });

  it('a verb before sync says how to build the records', () => {
    const f = setup();
    const r = run(f, ['search', 'anything']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('slopie sync');
  });

  it('the old memory verbs are gone; read/threads/grep are hidden; MCP lists one tool, search', () => {
    const f = setup();
    for (const verb of ['ask', 'find', 'graft', 'rescue', 'index', 'ls', 'note']) expect(run(f, [verb]).code, verb).not.toBe(0);
    const out = run(f, ['mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n').stdout;
    expect((JSON.parse(out) as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(['search']);
    const help = run(f, ['--help']).stdout;
    expect(help).toMatch(/^\s+search\b/m);
    for (const verb of ['read', 'threads', 'grep']) expect(help, verb).not.toMatch(new RegExp(`^\\s+${verb}\\b`, 'm'));
  });
});

describe('slopie forget / ignore', () => {
  it('forget removes a session from the records now; unforget brings it back on sync', () => {
    const f = setup();
    run(f, ['sync']);
    const rel = fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8').split('\n').find(l => l.split('\t')[1] === IDS.codex)!.split('\t')[9]!;
    const r = run(f, ['forget', IDS.codex.slice(0, 13)]);
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(f.recordsDir, rel))).toBe(false);
    expect(fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8')).not.toContain(IDS.codex);
    expect(run(f, ['forget']).stdout).toContain(`codex:${IDS.codex}`);
    run(f, ['unforget', IDS.codex]);
    run(f, ['sync']);
    expect(fs.existsSync(path.join(f.recordsDir, rel))).toBe(true);
  });

  it('ignore is stored in ~/.slopie/config.json and applied by the next sync', () => {
    const f = setup();
    run(f, ['sync']);
    expect(run(f, ['ignore', 'printer']).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.slopieDir, 'config.json'), 'utf8'))).toEqual({ ignore: ['printer'] });
    run(f, ['sync']);
    expect(fs.readFileSync(path.join(f.recordsDir, 'INDEX.tsv'), 'utf8')).not.toContain(IDS.promptOnly);
    expect(fs.existsSync(path.join(f.potsherdDir, 'config.json'))).toBe(false);
  });
});

describe('slopie setup', () => {
  it('installs the skill and the SessionStart hook for Claude Code, and removes exactly that', () => {
    const f = setup();
    const settings = path.join(f.claudeDir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2));
    const dry = run(f, ['setup', '--claude', '--dry-run']);
    expect(dry.stdout).toContain('dry run: nothing written.');
    expect(fs.existsSync(path.join(f.claudeDir, 'skills', 'slopie', 'SKILL.md'))).toBe(false);
    // A pre-release slopie-memory skill is replaced by the one slopie skill.
    fs.mkdirSync(path.join(f.claudeDir, 'skills', 'slopie-memory'), { recursive: true });
    fs.writeFileSync(path.join(f.claudeDir, 'skills', 'slopie-memory', 'SKILL.md'), '---\nname: slopie-memory\ndescription: "old"\n---\n\nold note\n');
    expect(run(f, ['setup', '--claude', '--yes']).code).toBe(0);
    expect(fs.existsSync(path.join(f.claudeDir, 'skills', 'slopie-memory'))).toBe(false);
    expect(fs.readdirSync(path.join(f.claudeDir, 'skills'))).toEqual(['slopie']);
    const skill = fs.readFileSync(path.join(f.claudeDir, 'skills', 'slopie', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: slopie\ndescription: "Search everything you and the user did in past coding sessions/);
    expect(skill).toContain(`exported as plain text records under ${f.recordsDir}:`);
    const s = JSON.parse(fs.readFileSync(settings, 'utf8')) as { model: string; hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(s.model).toBe('opus');
    expect(s.hooks['Stop']).toHaveLength(1);
    expect(s.hooks['SessionStart']![0]!.matcher).toBe('startup|resume|compact');
    expect(s.hooks['SessionStart']![0]!.hooks[0]!.command).toContain('hook session-start --harness claude');
    expect(fs.readdirSync(f.claudeDir).some(n => n.startsWith('settings.json.slopie-bak-'))).toBe(true);
    expect(run(f, ['setup', '--claude', '--yes']).stdout).toContain('already set up');
    expect(run(f, ['setup', '--claude', '--remove', '--yes']).code).toBe(0);
    expect(fs.existsSync(path.join(f.claudeDir, 'skills', 'slopie'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } });
  });

  it('writes a marked AGENTS.md block for Codex and the pi skill + extension', () => {
    const f = setup();
    // A pre-release block (old markers) is replaced, not duplicated.
    fs.writeFileSync(path.join(f.codexDir, 'AGENTS.md'), '# mine\nkeep this\n\n<!-- slopie:memory:begin -->\nold\n<!-- slopie:memory:end -->\n');
    expect(run(f, ['setup', '--codex', '--pi', '--yes']).code).toBe(0);
    const agents = fs.readFileSync(path.join(f.codexDir, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/^# mine\nkeep this\n\n<!-- slopie:begin -->\n## slopie\nSearch everything you and the user did in past coding sessions[^\n]*\n\nThe user's agent history/);
    expect(agents).not.toContain('slopie:memory');
    expect(agents.trimEnd().endsWith('<!-- slopie:end -->')).toBe(true);
    expect(fs.readdirSync(path.join(f.piDir, 'agent', 'skills'))).toEqual(['slopie']);
    expect(fs.readFileSync(path.join(f.piDir, 'agent', 'skills', 'slopie', 'SKILL.md'), 'utf8')).toContain('slopie search');
    expect(fs.readFileSync(path.join(f.piDir, 'agent', 'extensions', 'slopie.ts'), 'utf8')).toContain("pi.on('session_start'");
    run(f, ['setup', '--codex', '--pi', '--remove', '--yes']);
    expect(fs.readFileSync(path.join(f.codexDir, 'AGENTS.md'), 'utf8')).toBe('# mine\nkeep this\n');
  });

  it('--note prints the note that setup installs', () => {
    const f = setup();
    const note = run(f, ['setup', '--note']).stdout;
    expect(note).toContain(`rg -n -i 'term' ${f.recordsDir}`);
    expect(note.trimEnd().split('\n').at(-1)).toMatch(/^If the slopie command is on PATH, start with it/);
  });
});

describe('slopie hook session-start', () => {
  it('prints the continuation pointer after compaction, nothing on a fresh start', () => {
    const f = setup();
    run(f, ['sync']);
    const out = run(f, ['hook', 'session-start', '--harness', 'claude'], JSON.stringify({ session_id: IDS.claude, source: 'compact' })).stdout;
    const lines = out.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(out).toContain(`record: ${path.join(f.recordsDir, 'claude', 'work-demo-app', `2026-10-01_${IDS.claude}.txt`)}`);
    expect(out).toContain(`slopie search --session ${IDS.claude} --turns -30`);
    expect(run(f, ['hook', 'session-start'], JSON.stringify({ session_id: IDS.claude, source: 'startup' })).stdout).toBe('');
    // A hook never fails the session, even on garbage.
    expect(run(f, ['hook', 'session-start'], 'not json').code).toBe(0);
  });
});

describe('slopie doctor', () => {
  it('reports sources, records, privacy lists and the unused 1.x store', () => {
    const f = setup();
    run(f, ['sync']);
    fs.writeFileSync(path.join(f.potsherdDir, 'potsherd.db'), '');
    const d = JSON.parse(run(f, ['doctor', '--json']).stdout) as { records: { built: boolean; sessions: number; mode: string }; legacy: { present: string[]; unused: boolean } };
    expect(d.records).toMatchObject({ built: true, sessions: 6, mode: '700' });
    expect(d.legacy.unused).toBe(true);
    expect(d.legacy.present).toContain('potsherd.db');
    const text = run(f, ['doctor']).stdout;
    expect(text).toContain('remove by hand');
    // doctor never deletes anything there
    expect(fs.existsSync(path.join(f.potsherdDir, 'potsherd.db'))).toBe(true);
  });
});
