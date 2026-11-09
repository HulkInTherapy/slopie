import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * The two SQLite drivers (open item A).
 *
 * A Claude Code plugin install is a git clone: nothing runs `pnpm install`,
 * nothing runs a build, and `better-sqlite3` is a native addon that cannot be
 * vendored into one file. For seven phases that meant a marketplace install
 * produced a plugin whose CLI would not start and whose MCP server died before
 * it spoke a word.
 *
 * Node has shipped its own SQLite since 22.5, so potsherd falls back to it.
 * The thing that makes that claim worth anything is not this file — it is that
 * **the whole suite runs green under `POTSHERD_SQLITE=node`**, which CI does as
 * a separate job. A driver nobody exercises is the phantom-flag failure this
 * project has recorded six times: a path that looks supported, succeeds, and
 * does nothing.
 *
 * What this file adds is the part the rest of the suite cannot see, because
 * the rest of the suite runs inside a checkout with a full `node_modules`:
 * that the shipped bundle **starts and works with no `node_modules` at all**.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(repo, 'packages', 'cli', 'dist', 'potsherd.js');
const FIXTURE = path.join(repo, 'tests', 'fixtures', 'claude');

let sandbox = '';
let lone = '';
const dirs: string[] = [];

/**
 * Run the bundle from a directory that has no `node_modules` above it.
 *
 * **`NODE_PATH` has to go, and finding that out is the point of this comment.**
 * Vitest sets it to three directories inside the repository's own
 * `node_modules/.pnpm`, and a child process inherits it — so the first version
 * of these tests copied the bundle into `os.tmpdir()`, ran it, and watched it
 * resolve `better-sqlite3` anyway. The test would have reported "the fallback
 * works" while never once loading the fallback.
 *
 * That is `09 §7.2` exactly: a test's premise must be something the test
 * establishes, not something the machine happens to provide. The premise here
 * is "no `better-sqlite3` is reachable", so the test has to make that true.
 */
function run(args: string[], env: Record<string, string> = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const childEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', ...env };
  delete childEnv['NODE_PATH'];
  delete childEnv['POTSHERD_SQLITE'];
  // `spawnSync`, not `execFileSync`: the pattern the rest of the suite uses
  // discards stderr on success (it only reads it out of the thrown error), and
  // two of the things checked here — that nothing is written to stderr, and
  // that the escape hatch puts it back — are assertions *about* stderr on a
  // successful run.
  const r = spawnSync(process.execPath, [lone, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Does `better-sqlite3` resolve from `dir`, in a child with a clean env? */
function addonReachable(dir: string): boolean {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['NODE_PATH'];
  const r = spawnSync(
    process.execPath,
    ['-e', "require('node:module').createRequire(process.argv[1]).resolve('better-sqlite3')", path.join(dir, 'potsherd.js')],
    { encoding: 'utf8', env: env as NodeJS.ProcessEnv },
  );
  return r.status === 0;
}

beforeAll(() => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  // `/tmp`, not a temp dir inside the repo: a directory under the checkout has
  // the repo's own `node_modules` on its resolution path, and the whole point
  // here is a machine that has none. `os.tmpdir()` is outside it.
  sandbox = tempDir('potsherd-lonely-');
  dirs.push(sandbox);
  lone = path.join(sandbox, 'potsherd.js');
  fs.copyFileSync(bundle, lone);
}, 180_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

describe('the shipped bundle, with no node_modules anywhere', () => {
  it('is one file — nothing beside it, and nothing reachable from it', () => {
    expect(fs.readdirSync(sandbox)).toEqual(['potsherd.js']);
    // The premise, established rather than assumed: from where this bundle
    // sits, and in the environment these tests give a child, `better-sqlite3`
    // does not resolve.
    expect(addonReachable(sandbox), 'better-sqlite3 is reachable from the sandbox').toBe(false);
  });

  it('starts, and knows its own version', () => {
    const r = run(['--version']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it('audits — the first command anyone runs, and it needs no database', () => {
    const r = run(['audit', '--json', '--claude-dir', FIXTURE], { SLOPIE_NO_SYNC: '1' });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty('metrics');
  });

  /** Records built with the lone bundle (parsed inline: no worker file beside it), in their own directory. */
  function records(): string {
    const dir = tempDir('slopie-lonely-records-');
    dirs.push(dir);
    const r = run(['sync', '--claude-dir', FIXTURE, '--json'], { SLOPIE_RECORDS_DIR: dir, SLOPIE_DIR: dir + '-home' });
    expect(r.code, r.stderr).toBe(0);
    return dir;
  }

  it('syncs records and searches them on Node’s own sqlite, finding a prompt from a deleted session', () => {
    const dir = records();
    expect(fs.readFileSync(path.join(dir, 'INDEX.tsv'), 'utf8')).toContain('(prompt history only; transcript not kept)');
    const r = run(['search', 'pgbouncer'], { SLOPIE_RECORDS_DIR: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/→ slopie read \S+ --from \d+ --to \d+|→ potsherd read|→ slopie read/);
    expect(r.stdout).toContain('pgbouncer');
  });

  it('reports which sqlite it used, in --json', () => {
    const r = run(['doctor', '--json', '--claude-dir', FIXTURE]);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { sqlite: string }).sqlite).toBe('node:sqlite');
  });

  it('prints no experimental warning on the way past', () => {
    const dir = records();
    const r = run(['threads'], { SLOPIE_RECORDS_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('puts the warning back when asked — if this Node emits one at all', (ctx) => {
    // Whether there is a warning to put back is a fact about the Node running this: ask it, and skip loudly if not.
    const probe = spawnSync(process.execPath, ['-e', "require('node:sqlite')"], {
      encoding: 'utf8',
    });
    if (!probe.stderr.includes('ExperimentalWarning')) {
      console.log(
        `  SKIPPED: ${process.version} does not warn about node:sqlite, so there is ` +
          'nothing for POTSHERD_SQLITE_WARN to put back',
      );
      ctx.skip();
      return;
    }
    const dir = records();
    const loud = run(['threads'], { SLOPIE_RECORDS_DIR: dir, POTSHERD_SQLITE_WARN: '1' });
    expect(loud.stderr).toContain('ExperimentalWarning');
  });
});

describe('POTSHERD_SQLITE selects a driver, and is not a flag that does nothing', () => {
  const driver = (env: NodeJS.ProcessEnv) =>
    (JSON.parse(execFileSync(process.execPath, [bundle, 'doctor', '--json', '--claude-dir', FIXTURE], { encoding: 'utf8', env })) as { sqlite: string }).sqlite;

  it('forces the addon when asked, inside the checkout', () => {
    expect(driver({ ...process.env, POTSHERD_SQLITE: 'better-sqlite3' })).toBe('better-sqlite3');
  });

  it('forces the built-in when asked, inside the same checkout', () => {
    expect(driver({ ...process.env, POTSHERD_SQLITE: 'node' })).toBe('node:sqlite');
  });

  it('prefers the addon when nothing is forced', () => {
    const env = { ...process.env };
    delete env['POTSHERD_SQLITE'];
    expect(driver(env)).toBe('better-sqlite3');
  });
});
