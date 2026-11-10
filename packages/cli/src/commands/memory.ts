/**
 * The records verbs: sync, search, mcp, hook, forget (read, threads and grep remain as hidden aliases).
 */
import fs from 'node:fs';
import process from 'node:process';
import {spawn, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  Engine, NoIndexError, SyncBusyError, VERSION, continuationPointer, hasRecord, isContinuation, parseHookInput, paths, readForgetList, legacyForgotten,
  scrub, serveMcp, sourceId, syncRecords, writeForgetList, type ForgetEntry, type SyncResult,
} from '@potsherd/core';
import {print, printJson, UserError, type GlobalOptions} from '../output.js';

export interface RecordsOptions extends GlobalOptions {
  recordsDir?: string;
}

/** The worker bundle beside this one, when it exists (the built CLI); tests and source runs parse inline. */
export function workerUrl(): URL | null {
  try {
    const url = new URL('./records-worker.js', import.meta.url);
    return url.protocol === 'file:' && fs.existsSync(fileURLToPath(url)) ? url : null;
  } catch {
    return null;
  }
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export async function runSync(o: RecordsOptions & {full?: boolean; sidecar?: boolean; threads?: number; ifIdle?: boolean}): Promise<number> {
  let r: SyncResult;
  try {
    r = await syncRecords({
      ...(o.recordsDir ? {recordsDir: o.recordsDir} : {}), ...(o.claudeDir ? {claudeDir: o.claudeDir} : {}), ...(o.codexDir ? {codexDir: o.codexDir} : {}),
      ...(o.piDir ? {piDir: o.piDir} : {}), ...(o.potsherdDir ? {potsherdDir: o.potsherdDir} : {}), ...(o.sidecar !== undefined ? {sidecar: o.sidecar} : {}),
      ...(o.threads ? {threads: o.threads} : {}), full: !!o.full, workerUrl: workerUrl(),
      ...(!o.quiet && !o.json && process.stderr.isTTY ? {onProgress: (phase: string, done: number, total: number) => {
        if (done === total || done % 25 === 0) process.stderr.write(`\r  ${phase} ${done}/${total}${done === total ? '\n' : ''}`);
      }} : {}),
    });
  } catch (e) {
    if (e instanceof SyncBusyError && o.ifIdle) return 0;
    throw e;
  }
  if (o.json) { printJson(r); return r.errors.length && !r.sessions ? 1 : 0; }
  if (o.quiet) return 0;
  const h = r.byHarness;
  print(`slopie sync: ${r.sessions} sessions (${h['claude'] ?? 0} claude, ${h['codex'] ?? 0} codex, ${h['pi'] ?? 0} pi${h['antigravity'] ? `, ${h['antigravity']} antigravity` : ''}; ${r.subagents} subagents, ${r.promptOnly} prompt-only, ${r.kept} kept after their source was deleted)`);
  print(`  ${r.sources} source files, ${r.parsed} parsed this run, ${r.written} records written, ${r.removed} removed, ${r.seconds.toFixed(1)} s`);
  print(`  records: ${r.recordsDir}  (${mb(r.recordBytes)}; search index ${mb(r.indexBytes)})`);
  if (r.excludedByPolicy) print(`  ${r.excludedByPolicy} sessions left out by your ignore / forget lists`);
  if (r.errors.length) print(`  ${r.errors.length} files could not be read, e.g. ${r.errors[0]}`);
  return 0;
}

function engine(o: RecordsOptions): Engine {
  try {
    return new Engine(o.recordsDir, 'cli');
  } catch (e) {
    if (e instanceof NoIndexError) throw new UserError(`No records index yet. Run:  slopie sync`);
    throw e;
  }
}

function withEngine(o: RecordsOptions, fn: (e: Engine) => string): number {
  const e = engine(o);
  try {
    const text = scrub(fn(e));
    if (o.json) printJson({text}); else print(text);
    return 0;
  } finally {
    e.close();
  }
}

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** `slopie search`: the one lookup verb (passages, a thread's turns, matches inside a thread, or a thread list). */
/**
 * Before a search: an incremental sync with a hard budget (1.5 s), under the sync's own lock. The sync runs
 * detached, so it is never killed mid-write: when it does not finish in time the search reads the index as it
 * is and says so. Skipped when the index is under 60 s old, or with SLOPIE_NO_REFRESH=1.
 */
export async function refreshIndex(o: GlobalOptions & {recordsDir?: string}, budgetMs = 1500): Promise<string | null> {
  if (process.env['SLOPIE_NO_REFRESH'] === '1' || process.env['SLOPIE_NO_SYNC'] === '1') return null;
  const dir = paths.recordsDir(o.recordsDir);
  const idx = `${dir}/.slopie/index.sqlite`;
  try { if (Date.now() - fs.statSync(idx).mtimeMs < 60_000) return null; } catch { return null; }
  const child = spawnBackgroundSync(o);
  if (!child) return null;
  const finished = await new Promise<boolean>(resolve => {
    const t = setTimeout(() => resolve(false), budgetMs);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
    child.once('error', () => { clearTimeout(t); resolve(true); });
  });
  if (finished) return null;
  child.removeAllListeners();
  return `(refresh did not finish in ${(budgetMs / 1000).toFixed(1)} s; searched the existing index. It keeps running in the background.)`;
}

export async function runSearch(o: RecordsOptions & {query?: string; k?: unknown; project?: string; harness?: string; since?: string; until?: string; session?: string; turns?: string;
  latest?: boolean; includeSubagents?: boolean; parent?: string}): Promise<number> {
  const note = await refreshIndex(o);
  const e = engine(o);
  try {
    if (note) e.notes.push(note);
    const r = e.findResult({query: o.query, k: num(o.k), project: o.project, harness: o.harness, since: o.since, until: o.until, session: o.session, turns: o.turns,
      latest: o.latest, includeSubagents: o.includeSubagents, parent: o.parent});
    if (o.json) printJson(r); else print(r.text);
    return 0;
  } finally {
    e.close();
  }
}

export function runRead(o: RecordsOptions & {session: string; from?: unknown; to?: unknown; maxChars?: unknown; fromChar?: unknown}): number {
  return withEngine(o, e => e.read({session: o.session, from_turn: num(o.from) ?? null, to_turn: num(o.to) ?? null, max_chars: num(o.maxChars) ?? null, from_char: num(o.fromChar) ?? null}));
}

export function runThreads(o: RecordsOptions & {project?: string; harness?: string; since?: string; until?: string; text?: string; subagents?: boolean; parent?: string; limit?: unknown; offset?: unknown}): number {
  return withEngine(o, e => e.threads({project: o.project, harness: o.harness, since: o.since, until: o.until, text: o.text, include_subagents: !!o.subagents, parent: o.parent, limit: num(o.limit), offset: num(o.offset)}));
}

export function runGrep(o: RecordsOptions & {session: string; pattern: string; regex?: boolean; offset?: unknown}): number {
  return withEngine(o, e => e.grep({session: o.session, pattern: o.pattern, regex: !!o.regex, offset: num(o.offset)}));
}

export async function runMcp(o: RecordsOptions): Promise<number> {
  await serveMcp({version: VERSION, ...(o.recordsDir ? {recordsDir: o.recordsDir} : {}), refresh: () => refreshIndex(o)});
  return 0;
}

/** Re-runs this CLI detached: `slopie sync --quiet --if-idle` (never blocks the caller). */
export function spawnBackgroundSync(o: GlobalOptions & {recordsDir?: string} = {}): ChildProcess | null {
  if (process.env['SLOPIE_NO_SYNC'] === '1') return null;
  const entry = process.argv[1];
  if (!entry) return null;
  const args = [entry, 'sync', '--quiet', '--if-idle'];
  for (const [flag, v] of [['--claude-dir', o.claudeDir], ['--codex-dir', o.codexDir], ['--pi-dir', o.piDir], ['--potsherd-dir', o.potsherdDir], ['--records-dir', o.recordsDir]] as const) if (v) args.push(flag, v);
  try {
    const child = spawn(process.execPath, args, {detached: true, stdio: 'ignore', env: {...process.env, POTSHERD_CLI_PUBLIC_NAME: 'slopie'}});
    child.unref();
    return child;
  } catch { /* the audit never fails because of the records */ }
  return null;
}

async function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise(resolve => {
    let data = '';
    const done = () => { process.stdin.removeAllListeners(); process.stdin.pause(); resolve(data); };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { data += d; if (data.length > 1e6) { clearTimeout(timer); done(); } });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

/**
 * `slopie hook session-start --harness claude|codex|pi`: keep records current; on resume / compaction print
 * the continuation pointer (≤ 10 lines). Never fails the harness: every error is swallowed.
 *
 * The refresh always runs detached: the hook never awaits a sync (a large one could outlast the harness's
 * hook timeout, and a killed hook must not take a writer down with it). The pointer comes from the records
 * as they are; only when they do not hold this session yet does the hook wait, briefly, for the refresh.
 */
export async function runHook(o: RecordsOptions & {event: string; harness?: string}): Promise<number> {
  try {
    if (o.event !== 'session-start') throw new UserError(`unknown hook event ${o.event}; the one hook is session-start`);
    const input = parseHookInput(await readStdin());
    const id = input.session_id ?? input.sessionId ?? '';
    const harness = o.harness ?? 'claude';
    const dir = paths.recordsDir(o.recordsDir);
    const continuing = isContinuation(input.source);
    spawnBackgroundSync(o);
    if (!continuing || !id) return 0;
    const budget = Math.max(0, Math.min(Number(process.env['SLOPIE_HOOK_WAIT_MS'] ?? 3000) || 0, 10000));
    if (process.env['SLOPIE_NO_SYNC'] !== '1' && !hasRecord(id, dir)) {
      const until = Date.now() + budget;
      while (Date.now() < until && !hasRecord(id, dir)) await new Promise(r => setTimeout(r, 100));
    }
    print(continuationPointer(id, harness, dir).join('\n'));
  } catch {
    /* a hook never blocks a session */
  }
  return 0;
}

/** `slopie forget <session-id>` / `slopie unforget <session-id>`: removes a session from the records and the audit. */
export async function runForget(o: RecordsOptions & {session?: string; remove?: boolean}): Promise<number> {
  const root = paths.slopieDir();
  let list = readForgetList(root);
  if (list === null) {
    // First write: seed from the 1.8 store's tombstones (read-only).
    list = [...legacyForgotten(paths.potsherdDir(o.potsherdDir)).ids].map(sourceId => ({sourceId}));
  }
  if (!o.session) {
    if (o.json) printJson({forgotten: list});
    else print(list.length ? list.map(e => `${e.harness ?? '?'}:${e.id ?? e.sourceId}`).join('\n') : 'nothing is forgotten.');
    return 0;
  }
  const raw = o.session.trim();
  const [h, id] = raw.includes(':') && ['claude', 'codex', 'pi', 'antigravity'].includes(raw.split(':')[0]!) ? [raw.split(':')[0]!, raw.split(':').slice(1).join(':')] : [null, raw];
  let harnesses = h ? [h] : ['claude', 'codex', 'pi', 'antigravity'];
  let full = id;
  // Resolve a prefix against the records index when there is one.
  try {
    const e = new Engine(o.recordsDir, 'cli');
    try { const r = e.resolve(raw); if (r.s) { full = r.s.id; harnesses = [r.s.harness]; } } finally { e.close(); }
  } catch { /* no index: take the id as typed */ }
  if (!/^[A-Za-z0-9._:-]{6,}$/.test(full)) throw new UserError('Give a full session id (or an 8+ character prefix that the records know).');
  const entries: ForgetEntry[] = harnesses.map(x => ({sourceId: sourceId(x, full), harness: x, id: full, at: new Date().toISOString()}));
  const ids = new Set(entries.map(e => e.sourceId));
  const next = o.remove ? list.filter(e => !ids.has(e.sourceId)) : [...list.filter(e => !ids.has(e.sourceId)), ...entries];
  writeForgetList(next, root);
  if (!o.json) print(o.remove ? `unforgot ${full}; the next slopie sync writes its record again.` : `forgot ${full}: removed from the records now; the audit no longer counts it.`);
  if (!o.remove) {
    // Explicit: the record goes now, not at the next background sync.
    try { await syncRecords({...(o.recordsDir ? {recordsDir: o.recordsDir} : {}), workerUrl: workerUrl()}); } catch (e) {
      if (!(e instanceof SyncBusyError)) throw e;
      if (!o.json) print('(a sync is running; the record goes when it finishes and the next one starts)');
    }
  }
  if (o.json) printJson({forgotten: next.length, changed: entries.map(e => e.id)});
  return 0;
}
