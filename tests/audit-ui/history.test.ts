import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AuditSession, AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import { baseline, digestOf, readHistory, sinceLast, writeDigest } from '../../packages/cli/src/audit-ui/history.js';
import { runWallboard } from '../../packages/cli/src/audit-ui/terminal.js';
import { startingSnapshot } from './fixture.js';
import { storySnapshot } from './story-fixture.js';
import { Screen } from './screen.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slopie-history-'));

describe('run history', () => {
  it('stores numbers only: no prompt text, no project names', () => {
    const dir = tmp();
    const snapshot = storySnapshot();
    const digest = digestOf(snapshot, new Date('2026-10-01T00:00:00Z'))!;
    expect(writeDigest(snapshot, digest, dir)).toBe(true);
    const file = fs.readdirSync(dir);
    expect(file).toHaveLength(1);
    expect(file[0]).toMatch(/^[0-9a-f]{16}\.jsonl$/);
    const text = fs.readFileSync(path.join(dir, file[0]!), 'utf8');
    for (const secret of ['lantern-api', 'tidepool', 'paper-boats', 'real quick', 'buddy', 'sync layer', 'keep going']) expect(text).not.toContain(secret);
    expect((fs.statSync(path.join(dir, file[0]!)).mode & 0o777).toString(8)).toBe('600');
    expect(readHistory(snapshot, dir)).toHaveLength(1);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('reports deltas, records and archetype drift against the newest run ≥20h old', () => {
    const now = digestOf(storySnapshot(), new Date('2026-10-10T00:00:00Z'))!;
    const old = { ...now, at: '2026-10-02T00:00:00Z', prompts: now.prompts - 214, costUsd: now.costUsd! - 312, swearPct: 30, archetypeId: 'sailor', archetypeTitle: 'The Sailor', records: { ...now.records, busiestDayPrompts: 20 } };
    const recent = { ...old, at: '2026-10-09T20:00:00Z', prompts: now.prompts - 3 };
    expect(baseline([old, recent], new Date('2026-10-10T00:00:00Z'))).toBe(old);
    const since = sinceLast(old, now, [old]);
    expect(since.line).toContain('+214 prompts');
    expect(since.line).toContain('+$312');
    expect(since.line).toMatch(/swearing 30\.0% → 24\.3% ↓/);
    expect(since.line).toContain('new record: busiest day');
    expect(since.archetypeChanged).toBe('The Sailor');
  });

  it('a re-run opens on the board with the ticker lit; ← replays the story', async () => {
    const dir = tmp();
    const snapshot = storySnapshot();
    writeDigest(snapshot, { ...digestOf(snapshot, new Date('2026-09-01T00:00:00Z'))!, prompts: 2700 }, dir);
    class In extends EventEmitter { isTTY = true; setRawMode() { return this; } setEncoding() { return this; } resume() { return this; } pause() { return this; } }
    class Out extends EventEmitter { isTTY = true; columns = 120; rows = 40; chunks: string[] = []; write(c: string, cb?: () => void) { this.chunks.push(c); setImmediate(() => cb?.()); return true; } }
    const stdin = new In(), stdout = new Out();
    let finish: (s: AuditSnapshot) => void = () => {};
    const session = { snapshot: () => startingSnapshot(), run: () => new Promise<AuditSnapshot>(r => { finish = r; }), cancel: vi.fn(), prompts: vi.fn(), evidence: vi.fn(), classify: vi.fn(), dispose: vi.fn() } as unknown as AuditSession;
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false, historyDir: dir });
    await new Promise(r => setTimeout(r, 5));
    finish({ ...snapshot, sequence: 20 });
    await new Promise(r => setTimeout(r, 40));
    const screen = () => new Screen(120, 40).feed(stdout.chunks.join('')).text();
    expect(screen()).toContain('SINCE LAST RUN');
    expect(screen()).toContain('+204 prompts');
    expect(screen()).toContain('replay your story');
    stdin.emit('data', '\x1b[D');
    await new Promise(r => setTimeout(r, 60));
    expect(screen()).toContain('You were someone this year.');
    stdin.emit('data', 'q');
    await result;
    expect(readHistory(snapshot, dir)).toHaveLength(2);
  });
});
