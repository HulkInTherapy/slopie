import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {cleanup, claudeAssistant, claudeUser, home, jsonl, run} from './v19-helpers.js';

afterEach(cleanup);

describe('sharded facts cache', () => {
  it('an appended session rewrites its own shard and the index, not every cached source', async () => {
    const {dirs, options, write} = home();
    const files = [0, 1, 2, 3].map(i => write(path.join(dirs.claude, 'projects', 'p', `s${i}.jsonl`), [claudeUser(`u${i}`, `synthetic prompt ${i}`, i, `s${i}`), claudeAssistant(`m${i}`, i + 1, `s${i}`)]));
    await run(options);
    const dir = path.join(dirs.cache, fs.readdirSync(dirs.cache).find(f => f.startsWith('facts-'))!);
    const shards = () => new Map(fs.readdirSync(dir).filter(f => f !== 'index.bin').map(f => [f, fs.statSync(path.join(dir, f)).mtimeMs]));
    const before = shards();
    expect(before.size).toBe(4);
    await new Promise(r => setTimeout(r, 30));
    fs.appendFileSync(files[2]!, jsonl([claudeUser('u9', 'synthetic follow-up', 30, 's2'), claudeAssistant('m9', 31, 's2')]));
    const warm = await run(options);
    expect(warm.metrics.humanPrompts.value).toBe(5);
    expect(warm.timings).toMatchObject({filesCached: 3});
    const after = shards();
    const changed = [...after].filter(([f, t]) => before.get(f) !== t);
    expect(changed).toHaveLength(1);
    const untouched = await run(options);
    expect(untouched.timings).toMatchObject({filesRead: 0, filesCached: 4});
    expect(untouched.metrics.humanPrompts.value).toBe(5);
  });
  it('drops the shard of a deleted source and old single-blob caches', async () => {
    const {dirs, options, write} = home();
    const a = write(path.join(dirs.claude, 'projects', 'p', 'a.jsonl'), [claudeUser('ua', 'synthetic a', 0, 'a')]);
    write(path.join(dirs.claude, 'projects', 'p', 'b.jsonl'), [claudeUser('ub', 'synthetic b', 0, 'b')]);
    fs.writeFileSync(path.join(dirs.cache, 'facts-v5.bin'), 'old');
    await run(options);
    const dir = path.join(dirs.cache, fs.readdirSync(dirs.cache).find(f => /^facts-v\d+$/.test(f))!);
    expect(fs.readdirSync(dir).filter(f => f !== 'index.bin')).toHaveLength(2);
    expect(fs.existsSync(path.join(dirs.cache, 'facts-v5.bin'))).toBe(false);
    fs.rmSync(a);
    await run(options);
    expect(fs.readdirSync(dir).filter(f => f !== 'index.bin')).toHaveLength(1);
  });
});

describe('loading-screen progress detail (fields added, shape kept)', () => {
  it('reports cached and resumed files and automated runs', async () => {
    const {dirs, options, write} = home();
    for (let i = 0; i < 5; i++) write(path.join(dirs.claude, 'projects', 'p', `s${i}.jsonl`), [claudeUser(`u${i}`, `synthetic prompt ${i}`, i, `s${i}`), claudeAssistant(`m${i}`, i + 1, `s${i}`)]);
    await run(options);
    const events: import('../../packages/core/src/analytics/contracts.js').AuditEvent[] = [];
    await run(options, events);
    const details = events.flatMap(e => (e.type === 'progress' && e.progress.detail ? [e.progress.detail] : []));
    const last = details.at(-1)!;
    expect(last.stage).toBe('ready');
    expect(last.counts.filesCached).toBe(5);
    expect(last.counts.automatedRuns).toBe(0);
    expect(last.harnesses.find(h => h.harness === 'claude')!.filesCached).toBe(5);
    expect(Object.keys(last).sort()).toEqual(['counts', 'elapsedMs', 'harnesses', 'stage']);
  });
});
