/**
 * search / read / threads / grep: regressions from the 1.9.0 review (D7 session-level threads text, D8 grep
 * over full raw output, D11 read budgets, D12 regex paging). Synthetic history only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { Engine } from '../packages/core/src/records/engine.js';
import { makeFixture, syncOptions, type Fixture } from './records-fixture.js';

const SPLIT = 'bbbbbbbb-0000-4000-8000-000000000001';
const TOGETHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const BIG = 'bbbbbbbb-0000-4000-8000-000000000003';
const LONG = 'bbbbbbbb-0000-4000-8000-000000000004';
const MARK = 'HIDDEN_OUTPUT_MARKER';

let f: Fixture;
let bigFile: string;

function write(id: string, rows: Record<string, unknown>[]): string {
  const dir = path.join(f.claudeDir, 'projects', '-work-review');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `${id}.jsonl`);
  const base = {sessionId: id, cwd: '/work/review', timestamp: '2026-10-06T00:00:00.000Z'};
  fs.writeFileSync(file, rows.map((r, i) => JSON.stringify({...base, uuid: `${id}-${i}`, ...r}) + '\n').join(''));
  return file;
}
const user = (content: unknown) => ({type: 'user', message: {role: 'user', content}});

beforeAll(async () => {
  f = makeFixture();
  write(SPLIT, [user('alpha unique'), user('beta elsewhere')]);
  write(TOGETHER, [user('nothing here'), user('gamma first'), user('alpha and beta together')]);
  bigFile = write(BIG, [
    user('large tool'),
    {type: 'assistant', message: {id: 'm1', role: 'assistant', content: [{type: 'tool_use', id: 'tool1', name: 'Bash', input: {command: 'demo'}}]}},
    user([{type: 'tool_result', tool_use_id: 'tool1', content: 'x'.repeat(180000) + MARK + 'y'.repeat(220000)}]),
  ]);
  write(LONG, [user('short opener'), user('second'), user('long ' + 'Z'.repeat(5600) + ' TAIL_MARKER'), user('after the long one')]);
  await syncRecords(syncOptions(f));
});
afterAll(() => fs.rmSync(f.root, {recursive: true, force: true}));

const withEngine = <T>(style: 'cli' | 'mcp', fn: (e: Engine) => T): T => { const e = new Engine(f.recordsDir, style); try { return fn(e); } finally { e.close(); } };

describe('D7: threads(text=…) is session-level', () => {
  it('lists a thread whose words are in different turns, with a useful first match', () => {
    const out = withEngine('cli', e => e.threads({text: 'alpha beta'}));
    expect(out).toMatch(/^2 threads containing all of: alpha beta/);
    expect(out).toMatch(new RegExp(`${SPLIT} .*first match t1`));
    // Words together in one turn: that turn is the first match.
    expect(out).toMatch(new RegExp(`${TOGETHER} .*first match t3`));
    expect(withEngine('cli', e => e.threads({text: 'alpha gamma'}))).toMatch(/^1 threads/);
    expect(withEngine('cli', e => e.threads({text: 'alpha nonexistentword'}))).toMatch(/^0 threads/);
  });
});

describe('D8: grep reads the full raw output and says when it could not', () => {
  it('finds text in the middle of a 400 kB tool output', () => {
    const out = withEngine('cli', e => e.grep({session: BIG, pattern: MARK}));
    expect(out).toMatch(/^1 matches/);
    expect(out).not.toContain('partial scan');
  });

  it('a scan of the record alone is partial, and its no-match clears nothing', async () => {
    const g = makeFixture();
    try {
      const dir = path.join(g.claudeDir, 'projects', '-work-review');
      fs.mkdirSync(dir, {recursive: true});
      fs.copyFileSync(bigFile, path.join(dir, path.basename(bigFile)));
      await syncRecords(syncOptions(g));
      fs.rmSync(path.join(dir, path.basename(bigFile)));
      const e = new Engine(g.recordsDir, 'cli');
      try {
        const out = e.grep({session: BIG, pattern: MARK});
        expect(out).toContain('partial scan: searched the record only');
        expect(out).toContain('does not clear');
        expect(out).not.toContain('This clears only this spelling');
      } finally { e.close(); }
    } finally { fs.rmSync(g.root, {recursive: true, force: true}); }
  });
});

describe('D11: read budgets', () => {
  it('cuts a long first turn without losing the rest of it, and stays within max_chars', () => {
    for (const style of ['cli', 'mcp'] as const) {
      const first = withEngine(style, e => e.read({session: LONG, from_turn: 3, max_chars: 2000}));
      expect(first.length).toBeLessThanOrEqual(2000);
      expect(first).toContain('…[turn continues]');
      expect(first).not.toContain('end of thread');
      let text = first, guard = 0, seen = first;
      // Follow the continuation lines until the thread ends.
      while (!text.includes('end of thread') && guard++ < 10) {
        const m = /Continue: (?:read\(session="[^"]+", from_turn=(\d+)(?:, from_char=(\d+))?\)|slopie read \S+ --from (\d+)(?: --from-char (\d+))?)/.exec(text)!;
        expect(m, text).toBeTruthy();
        const from = Number(m[1] ?? m[3]), ch = Number(m[2] ?? m[4] ?? 0);
        text = withEngine(style, e => e.read({session: LONG, from_turn: from, from_char: ch, max_chars: 2000}));
        expect(text.length).toBeLessThanOrEqual(2000);
        seen += text;
      }
      expect(seen).toContain('TAIL_MARKER');
      expect(seen).toContain('after the long one');
      // Every Z of the long turn arrives exactly once.
      expect(seen.split('').filter(c => c === 'Z').length).toBe(5600);
    }
  });

  it('counts the header and footer within max_chars for whole turns too', () => {
    const out = withEngine('cli', e => e.read({session: LONG, from_turn: 1, to_turn: 2, max_chars: 2000}));
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain('t2 USER');
  });
});

describe('D12: regex grep paging keeps regex mode', () => {
  it('in the CLI and MCP continuation calls', () => {
    const cli = withEngine('cli', e => e.grep({session: TOGETHER, pattern: 'alpha|gamma', regex: true, max_hits: 1}));
    expect(cli).toMatch(/^2 matches/);
    expect(cli).toContain(`[more: slopie grep ${TOGETHER} 'alpha|gamma' --regex --offset 1]`);
    const mcp = withEngine('mcp', e => e.grep({session: TOGETHER, pattern: 'alpha|gamma', regex: true, max_hits: 1}));
    expect(mcp).toContain(`[more: grep(session="${TOGETHER}", pattern="alpha|gamma", regex=true, offset=1)]`);
    // Following it gives the second regex hit, not a literal search for the pipe.
    expect(withEngine('cli', e => e.grep({session: TOGETHER, pattern: 'alpha|gamma', regex: true, offset: 1}))).toContain('alpha and beta together');
    // A literal grep's continuation stays literal.
    const lit = withEngine('cli', e => e.grep({session: SPLIT, pattern: 'e', max_hits: 1}));
    expect(lit).toContain('[more: ');
    expect(lit).not.toContain('--regex');
  });
});
