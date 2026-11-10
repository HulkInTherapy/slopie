import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditSession } from '../../packages/core/src/analytics/contracts.js';
import { createBackgroundAuditSession } from '../../packages/cli/src/audit-background.js';
import { runWallboard } from '../../packages/cli/src/audit-ui/terminal.js';
import { Screen } from './screen.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });

class In extends EventEmitter { isTTY = true; setRawMode() { return this; } setEncoding() { return this; } resume() { return this; } pause() { return this; } }
class Out extends EventEmitter { isTTY = true; columns = 80; rows = 24; chunks: string[] = []; write(c: string, cb?: () => void) { this.chunks.push(c); setImmediate(() => cb?.()); return true; } }

/** The real CLI entry forks the real worker; the test hooks make it fail. */
async function interactive(env: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'slf-'));
  roots.push(root);
  const logs = path.join(root, 'logs');
  vi.stubEnv('POTSHERD_OFFLINE', '1');
  vi.stubEnv('SLOPIE_LOG_DIR', logs);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const absent = path.join(root, 'absent');
  const options = { launch: true, potsherdDir: path.join(root, 'owned'), claudeDir: absent, codexDir: absent, piDir: absent, opencodeDir: absent, cursorDir: absent, geminiDir: absent, copilotDir: absent, derivedCacheDir: path.join(root, 'cache') };
  const background = createBackgroundAuditSession(options, path.resolve('packages/cli/bin/slopie.js'));
  let settled = false;
  const session: AuditSession = { ...background, run: callback => background.run(callback).finally(() => { settled = true; }) };
  const stdin = new In(), stdout = new Out();
  const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false, historyDir: false });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 20000, interval: 50 });
  await new Promise(r => setTimeout(r, 80));
  const screen = new Screen(80, 24).feed(stdout.chunks.join('')).text();
  stdin.emit('data', 'q');
  const done = await result;
  background.dispose();
  const files = fs.existsSync(logs) ? fs.readdirSync(logs) : [];
  return { done, screen, logs, files };
}

describe('the interactive audit never fails silently', () => {
  it('completes through the in-process fallback when the worker dies at startup, and logs it', async () => {
    const { done, files, logs } = await interactive({ SLOPIE_TEST_WORKER_FAIL: 'exit' });
    expect(done.snapshot.status).not.toBe('error');
    expect(done.error).toBeUndefined();
    expect(files).toHaveLength(1);
    const text = fs.readFileSync(path.join(logs, files[0]!), 'utf8');
    expect(text).toContain('exiting at startup');
    expect(text).toContain('re-running the audit in-process');
  }, 30000);

  it('shows the reason and the log path when the fallback fails too', async () => {
    const { done, files, screen, logs } = await interactive({ SLOPIE_TEST_WORKER_FAIL: 'throw', SLOPIE_TEST_INPROCESS_FAIL: '1' });
    expect(done.snapshot.status).toBe('error');
    expect(done.error).toBeInstanceOf(Error);
    expect(files).toHaveLength(1);
    expect(screen.replace(/\s+/g, ' ')).toContain('The audit hit an error: in-process audit failed (SLOPIE_TEST_INPROCESS_FAIL).');
    expect(screen).toContain(`Details: ${path.join(logs, files[0]!)}`);
    expect(screen).toContain('Try: npx slopie audit --plain   (or send that log to the author)');
    const text = fs.readFileSync(path.join(logs, files[0]!), 'utf8');
    expect(text).toContain('SLOPIE_TEST_WORKER_FAIL=throw');
    expect(text).toContain('in-process fallback failed too');
  }, 30000);
});
