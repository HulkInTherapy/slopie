import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '@potsherd/core';
import { makeFixture, IDS, type Fixture } from './records-fixture.js';

/**
 * The shipped binary, every verb: `--ascii` output is pure ASCII, no line is wider than the width it was given,
 * and the version a user reads is the version in every manifest.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'slopie.js');
const ASCII_ONLY = /^[\x00-\x7F]*$/;

interface RunResult { code: number; stdout: string; stderr: string }
let f: Fixture;
const dirs = () => ['--claude-dir', f.claudeDir, '--codex-dir', f.codexDir, '--pi-dir', f.piDir, '--potsherd-dir', f.potsherdDir];

function run(args: string[], input?: string): RunResult {
  try {
    const stdout = execFileSync('node', [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...(f ? { SLOPIE_DIR: f.slopieDir, SLOPIE_RECORDS_DIR: f.recordsDir, CLAUDE_CONFIG_DIR: f.claudeDir, CODEX_HOME: f.codexDir, POTSHERD_PI_DIR: f.piDir, POTSHERD_DIR: f.potsherdDir } : {}) },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(() => {
  f = makeFixture();
  const r = run(['sync', ...dirs()]);
  expect(r.code, r.stderr).toBe(0);
});
afterAll(() => fs.rmSync(f.root, { recursive: true, force: true }));

const VERBS: string[][] = [
  [],
  ['--help'],
  ['sync', '--help'],
  ['search', 'pgbouncer pool'],
  ['search', '--session', IDS.claude, '--turns', '-3'],
  ['search', '--project', 'demo'],
  ['read', IDS.claude, '--from', '-3'],
  ['threads', '--text', 'pool'],
  ['grep', IDS.claude, 'pgbouncer'],
  ['ignore'],
  ['forget'],
  ['setup', '--status'],
  ['doctor'],
];

describe('--ascii and width, every verb', () => {
  for (const args of VERBS) {
    for (const width of [80, 60]) {
      it(`slopie ${args.join(' ') || '(tour)'} at ${width}`, () => {
        const r = run([...args, '--ascii', '--width', String(width)]);
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
        if (!['search', 'read', 'threads', 'grep'].includes(args[0] ?? '')) {
          // Verbs that print the user's own text (search hits, turns) wrap nothing; the rest fit.
          for (const line of r.stdout.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(Math.max(width, 80));
        }
        if (!['search', 'read', 'threads', 'grep'].includes(args[0] ?? '')) expect(ASCII_ONLY.test(r.stdout), r.stdout).toBe(true);
      });
    }
  }
});

describe('the version a user reads', () => {
  const manifest = (rel: string): { version: string } =>
    JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf-8')) as { version: string };

  it('is the same string in core, in both manifests, and out of the binary', () => {
    // The manifest npm publishes is the one a user installs, so it is the
    // authority the other three are checked against.
    const cli = manifest('packages/cli/package.json').version;
    expect(manifest('packages/core/package.json').version).toBe(cli);
    expect(VERSION).toBe(cli);

    expect(run(['--version']).stdout.trim()).toBe(cli);

    const doc = run(['doctor', '--no-color', '--width', '80']);
    expect(doc.stdout).toContain(`slopie ${cli}`);
  });

  it('is valid semver, including local prerelease candidates', () => {
    // `0.2.0` was still being printed at tag `v0.4.0`. Nothing in the suite can
    // reach the tag list of the repository a user cloned, but it can insist the
    // string is the shape a tag is made from, so that comparing the two is a
    // one-line check rather than a parse.
    expect(manifest('packages/cli/package.json').version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  });

  /**
   * The four-way check above was still not wide enough. At tag `v0.7.0` the
   * binary printed `0.4.0`: the four things it names agreed with each other
   * perfectly, and all four were three releases stale, because nothing joined
   * them to the tag. Two more surfaces were never in it at all — the plugin
   * manifest a marketplace listing shows, and the marketplace entry itself,
   * which said `0.5.0` for two phases after phase 5.
   *
   * So: every manifest in the repository that carries a potsherd version is
   * enumerated here rather than listed, and the git tag is checked when a git
   * checkout is what the test is running inside. A published tarball has no
   * `.git`, and a shallow clone reaches no tag from HEAD; both skip loudly —
   * visibly, as a skip and not as a pass — rather than assert something the
   * environment, not the test, established (`09 §7.2`).
   */
  it('is the same string in every manifest that carries one', () => {
    const cli = manifest('packages/cli/package.json').version;
    const carriers: [string, (o: Record<string, unknown>) => unknown][] = [
      ['packages/core/package.json', (o) => o['version']],
      ['packages/cli/package.json', (o) => o['version']],
      ['plugins/claude-code/.claude-plugin/plugin.json', (o) => o['version']],
      ['plugins/claude-code/package.json', (o) => o['version']],
      ['plugins/codex/.codex-plugin/plugin.json', (o) => o['version']],
      ['plugins/codex/package.json', (o) => o['version']],
      [
        '.claude-plugin/marketplace.json',
        (o) => (o['plugins'] as { version: string }[])[0]?.version,
      ],
    ];
    for (const [rel, pick] of carriers) {
      const json = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(pick(json), `${rel} carries a stale version`).toBe(cli);
    }
  });

  /**
   * **The premise is the tags this repository actually released** — `09` rule 7,
   * and this one was a landmine on the tag rather than a flake.
   *
   * This used to read `git tag --list 'v[0-9]*'`, which counts every tag the
   * checkout happens to hold. potsherd has a second remote by design —
   * `upstream-episodic` → `github.com/obra/episodic-memory`, kept for the
   * NOTICE — and a fetch of it landed **that** project's tags under plain `v*`
   * names beside the `upstream-v*` copies that were the intended form. So
   * `v1.0.1` … `v1.4.2` sat in the checkout, none of them potsherd's, and this
   * assertion read `VERSION is 1.2.0 but this checkout already has tag v1.4.2`
   * and went red on a release that had not happened.
   *
   * Deleting them fixed that afternoon. The remote is still there and will be
   * fetched again, so the premise is scoped instead: **`--merged HEAD`**, which
   * is every tag whose commit is an ancestor of what is checked out. A foreign
   * project's release is not in potsherd's history and cannot be, so it cannot
   * be counted here however it got into `.git`. It needs no network, which
   * `git ls-remote origin --tags` would have.
   *
   * (The worse half of the same story is why this is worth a paragraph:
   * `v1.2.0` — the version in every manifest above — was one of the names
   * taken, so `git tag v1.2.0` would have failed at release time, and forcing
   * it would have pointed the publish workflow's tag/manifest agreement check
   * at another project's `packages/cli/package.json`.)
   *
   * The three escapes it already had are kept and are now what they claimed to
   * be. A published tarball has no `.git`, a machine may have no `git`, and a
   * shallow clone reaches no tag from HEAD; none of the three is a finding
   * about potsherd, so none of them asserts anything. What changed is that they
   * **skip** instead of returning — vitest reports a bare `return` as a pass —
   * and that on CI, where the checkout is the workflow's own choice rather than
   * the environment's, a missing premise fails. See the block inside the test.
   */
  it('is not behind the newest git tag this repository released', (ctx) => {
    // **VERIFICATION-5 C-10.** The three escapes below were bare `return`s, and
    // vitest reports a bare `return` as a **pass**. Simulated with a `git` shim
    // that answers `git tag` with nothing:
    //
    //   ✓ the version a user reads > is not behind the newest git tag …
    //    Tests  1 passed | 69 skipped (70)
    //
    // — a green tick on an assertion that was never evaluated, which is rule 4
    // ("a benchmark that cannot fail is worse than no benchmark") on the one
    // assertion that exists because at tag `v0.7.0` the binary printed `0.4.0`.
    //
    // And it was **CI's state on every run**: `actions/checkout@v4` at
    // `.github/workflows/ci.yml:24` had no `fetch-depth` and no `fetch-tags`.
    // Measured against this repository over `file://`, which is the same fetch
    // machinery a runner uses:
    //
    //   fetch-depth  fetch-tags   v-tags   --merged HEAD   .git    fetch
    //   1 (default)  false            0               0   3.5M    0.52s
    //   1            true             0               0   3.5M    0.50s
    //   0            false            0               0   5.9M    2.07s
    //   0            true             9               9   5.9M    1.48s
    //
    // So `fetch-tags: true` alone buys **nothing**: `--depth 1` fetches only
    // tags that point into the history it fetched, and this test asks
    // `--merged HEAD`, which a depth-1 HEAD can never answer. Both knobs are
    // needed, and the workflow now sets both.
    //
    // Which is why the escape is not symmetric. Off CI a missing premise really
    // is the environment — a packed tarball has no `.git`, a contributor's
    // shallow clone has no reachable tag — and the honest report is a visible
    // **skip** with the reason printed. On CI the premise is not the
    // environment's to withhold: the workflow decides what it checks out, so a
    // missing premise there is a workflow regression and fails as one. That is
    // what stops this from silently going back to a green tick meaning
    // "not run".
    const absent = ((): string | null => {
      if (!fs.existsSync(path.join(repo, '.git'))) {
        return 'no .git here — this is a packed tarball, which has no tags to be behind';
      }
      try {
        execFileSync('git', ['--version'], { cwd: repo, encoding: 'utf8' });
      } catch {
        return 'no git binary on PATH';
      }
      return null;
    })();
    let tags: string[] = [];
    if (absent === null) {
      tags = execFileSync('git', ['tag', '--list', 'v[0-9]*', '--merged', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      })
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    const missing =
      absent ??
      (tags.length === 0
        ? 'no v* tag is reachable from HEAD — a shallow clone, or a commit older than every release'
        : null);
    if (missing !== null) {
      if (process.env['CI']) {
        expect.fail(
          `${missing}. On CI that is a workflow regression, not an environment: ` +
            '.github/workflows/ci.yml must check out with BOTH fetch-depth: 0 and ' +
            'fetch-tags: true. A depth-1 checkout reaches no tag from HEAD even with ' +
            'fetch-tags, so `git tag --merged HEAD` comes back empty and this assertion ' +
            'is never evaluated — which is exactly the green-that-means-not-run this ' +
            'test was found guilty of.',
        );
      }
      // Printed before the skip, not instead of it: `09 §7.2` asks for a loud
      // skip, and a skip nobody can see the reason for is half a report.
      console.log(`  SKIPPED — ${missing}`);
      ctx.skip();
      return;
    }

    type Semver={core:[number,number,number];pre:string[]};
    const parse=(text:string):Semver=>{const m=/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);if(!m)throw new Error(`invalid version ${text}`);return {core:[Number(m[1]),Number(m[2]),Number(m[3])],pre:m[4]?.split('.')??[]};};
    const cmp=(a:Semver,b:Semver):number=>{
     const core=a.core[0]-b.core[0]||a.core[1]-b.core[1]||a.core[2]-b.core[2];if(core)return core;
     if(!a.pre.length||!b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1;
     for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){const x=a.pre[i],y=b.pre[i];if(x===y)continue;if(x===undefined)return -1;if(y===undefined)return 1;const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return Number(x)-Number(y);if(xn!==yn)return xn?-1:1;return x<y?-1:1;}return 0;
    };
    // Stable package numbering can differ from a higher experimental release
    // line. Stable releases must not regress behind a stable tag; candidates
    // retain the stricter comparison against every reachable release tag.
    const newestFor=(current:Semver,available:Semver[]):Semver=>available
      .filter(tag=>current.pre.length>0||tag.pre.length===0).sort(cmp).at(-1)!;
    expect(cmp(parse('1.5.0'),newestFor(parse('1.5.0'),['v1.2.1','v2.0.0-rc.3'].map(parse)))).toBeGreaterThanOrEqual(0);
    expect(cmp(parse('1.5.0'),newestFor(parse('1.5.0'),['v1.2.1','v2.0.0'].map(parse)))).toBeLessThan(0);
    expect(cmp(parse('2.0.0-rc.2'),newestFor(parse('2.0.0-rc.2'),['v1.2.1','v2.0.0-rc.3'].map(parse)))).toBeLessThan(0);
    const current=parse(VERSION),newest=newestFor(current,tags.map(parse));
    expect(cmp(current,newest),`VERSION is ${VERSION} but this repository has a newer released tag in its release channel`).toBeGreaterThanOrEqual(0);

  });
});

