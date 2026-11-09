/**
 * doctor fits the terminal (1.9.0 review D14): long paths and lists wrap to --width; --json keeps them whole.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixture, type Fixture } from './records-fixture.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'slopie.js');
let f: Fixture;
let records: string;
const env = () => ({...process.env, NO_COLOR: '1', HOME: f.root, SLOPIE_DIR: f.slopieDir, SLOPIE_RECORDS_DIR: records, CLAUDE_CONFIG_DIR: f.claudeDir,
  POTSHERD_CODEX_DIR: f.codexDir, POTSHERD_PI_DIR: f.piDir, POTSHERD_DIR: f.potsherdDir, PATH: path.dirname(process.execPath)});
const run = (args: string[]) => execFileSync(process.execPath, [bin, ...args], {encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe']});

beforeAll(() => {
  f = makeFixture();
  records = path.join(f.root, 'a-very-long-directory-name-for-the-records'.repeat(4), 'records');
  run(['sync', '--claude-dir', f.claudeDir, '--codex-dir', f.codexDir, '--pi-dir', f.piDir, '--potsherd-dir', f.potsherdDir]);
  fs.mkdirSync(f.slopieDir, {recursive: true});
  fs.writeFileSync(path.join(f.slopieDir, 'config.json'), JSON.stringify({ignore: Array.from({length: 12}, (_, i) => `/work/some-quite-long-project-name-${i}`)}));
});
afterAll(() => fs.rmSync(f.root, {recursive: true, force: true}));

describe('D14: doctor output fits the terminal', () => {
  for (const width of [80, 60, 40]) {
    it(`at ${width} columns`, () => {
      const out = run(['doctor', '--width', String(width), '--ascii']);
      for (const line of out.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(width);
      expect(out.replace(/\s+/g, '')).toContain(records.replace(f.root, '').replace(/\s+/g, ''));
    });
  }

  it('--json keeps the full values', () => {
    const j = JSON.parse(run(['doctor', '--json'])) as {records: {dir: string}; privacy: {ignored: string[]}};
    expect(j.records.dir).toBe(records);
    expect(j.privacy.ignored).toHaveLength(12);
  });
});
