/**
 * The pi extension `slopie setup` installs (1.9.0 review D10): after a resume or a compaction it hands pi's
 * agent the continuation pointer through pi's extension API (pi.sendMessage), with this session's id;
 * on a plain start it only refreshes. Driven here with a stand-in for pi's ExtensionAPI (pi 0.74 types).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncRecords } from '../packages/core/src/records/sync.js';
import { IDS, makeFixture, syncOptions, type Fixture } from './records-fixture.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'slopie.js');
let f: Fixture;
const saved = {...process.env};

beforeAll(async () => {
  f = makeFixture();
  await syncRecords(syncOptions(f));
  // Not on PATH: the extension runs this exact node + bin.
  execFileSync(process.execPath, [bin, 'setup', '--pi', '--yes'], {env: {...process.env, HOME: f.root, SLOPIE_DIR: f.slopieDir, SLOPIE_RECORDS_DIR: f.recordsDir, POTSHERD_PI_DIR: f.piDir, PATH: path.dirname(process.execPath)}, stdio: 'ignore'});
  process.env['SLOPIE_RECORDS_DIR'] = f.recordsDir;
  process.env['SLOPIE_DIR'] = f.slopieDir;
});
afterAll(() => { process.env = saved; fs.rmSync(f.root, {recursive: true, force: true}); });

type Handler = (event: unknown, ctx: unknown) => unknown;
async function load(): Promise<{on: Map<string, Handler>; sent: {message: {content: string; customType: string}; options: unknown}[]}> {
  const file = path.join(f.piDir, 'agent', 'extensions', 'slopie.ts');
  const mod = await import(pathToFileURL(file).href) as {default: (pi: unknown) => void};
  const on = new Map<string, Handler>();
  const sent: {message: {content: string; customType: string}; options: unknown}[] = [];
  mod.default({on: (name: string, h: Handler) => on.set(name, h), sendMessage: (message: never, options: unknown) => sent.push({message, options})});
  return {on, sent};
}
const ctx = {sessionManager: {getSessionId: () => IDS.pi}};

describe('D10: the pi extension delivers the continuation pointer', () => {
  it('on resume: the pointer for this session, through pi.sendMessage, without holding up the start', async () => {
    const {on, sent} = await load();
    expect(on.get('session_start')!({type: 'session_start', reason: 'resume'}, ctx)).toBeUndefined();
    await vi.waitFor(() => expect(sent).toHaveLength(1), {timeout: 10000, interval: 50});
    const text = sent[0]!.message.content;
    expect(text).toContain(`this pi session (${IDS.pi})`);
    expect(text).toContain(`record: ${f.recordsDir}`);
    expect(text.split('\n').length).toBeLessThanOrEqual(10);
    expect(sent[0]!.options).toEqual({deliverAs: 'nextTurn'});
  });

  it('after a compaction too; nothing on a plain start', async () => {
    const {on, sent} = await load();
    on.get('session_compact')!({type: 'session_compact'}, ctx);
    await vi.waitFor(() => expect(sent).toHaveLength(1), {timeout: 10000, interval: 50});
    on.get('session_start')!({type: 'session_start', reason: 'startup'}, ctx);
    await new Promise(r => setTimeout(r, 1500));
    expect(sent).toHaveLength(1);
  });
});
