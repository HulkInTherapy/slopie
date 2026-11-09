/**
 * The session-start hook never awaits a sync (1.9.0 review D9): the pointer comes from the records as they
 * are, and the refresh runs detached, so a slow sync can neither delay the session nor be killed mid-write.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncRecords as realSync } from '../packages/core/src/records/sync.js';
import { IDS, makeFixture, syncOptions, type Fixture } from './records-fixture.js';

const spawned: string[][] = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (_cmd: string, args: string[]) => { spawned.push(args); return {unref() {}}; },
}));
// A sync that never finishes: awaiting it would hang the hook.
vi.mock('@potsherd/core', async (orig) => ({...(await orig<typeof import('@potsherd/core')>()), syncRecords: () => new Promise(() => {})}));

const { runHook } = await import('../packages/cli/src/commands/memory.js');

let f: Fixture;
const saved = {...process.env};
beforeAll(async () => { f = makeFixture(); await realSync(syncOptions(f)); });
afterAll(() => { fs.rmSync(f.root, {recursive: true, force: true}); process.env = saved; });
beforeEach(() => {
  spawned.length = 0;
  delete process.env['SLOPIE_NO_SYNC'];
  process.env['SLOPIE_HOOK_WAIT_MS'] = '300';
});

/** The hook reads its input from stdin, as the harness gives it. */
function stdin(json: unknown): void {
  Object.defineProperty(process, 'stdin', {value: Readable.from([JSON.stringify(json)]), configurable: true});
}

function capture(): {out: () => string; restore: () => void} {
  let text = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { text += s; return true; }) as never);
  return {out: () => text, restore: () => spy.mockRestore()};
}

describe('D9: the resume / compact hook', () => {
  it('prints the pointer from the existing records and refreshes detached', async () => {
    const c = capture();
    const t0 = Date.now();
    try {
      stdin({session_id: IDS.claude, source: 'resume'});
      await runHook({recordsDir: f.recordsDir, event: 'session-start', harness: 'claude'});
    } finally { c.restore(); }
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(c.out()).toContain(`2026-10-01_${IDS.claude}.txt`);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(expect.arrayContaining(['sync', '--quiet', '--if-idle', '--records-dir', f.recordsDir]));
  });

  it('waits only its short budget for a record that is not written yet', async () => {
    const c = capture();
    const t0 = Date.now();
    try {
      stdin({session_id: 'not-in-the-records-yet', source: 'compact'});
      await runHook({recordsDir: f.recordsDir, event: 'session-start', harness: 'claude'});
    } finally { c.restore(); }
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(2000);
    expect(c.out()).toContain('record: not written yet');
  });
});
