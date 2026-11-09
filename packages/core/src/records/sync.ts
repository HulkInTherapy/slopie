/**
 * `slopie sync`: native history -> plain-text records (+ INDEX.tsv) -> lexical search index.
 *
 *   discover (shared with the audit) -> parse changed files on a worker pool -> merge copies per session
 *   (most turns wins) -> drop Codex imports of Claude sessions -> prompt-only records from history.jsonl
 *   -> drop ignored / forgotten -> write changed records atomically -> INDEX.tsv -> FTS5 index.
 *
 * Incremental per source file (size + mtime). A session whose source files have all gone (deleted by the
 * harness) keeps its record: the records are the archive now. Forgetting or ignoring removes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as paths from '../paths.js';
import {discover, listFiles} from '../sources/discover.js';
import {assertPolicy, loadPolicy, type Policy} from '../sources/policy.js';
import {sourceId} from '../sources/identity.js';
import {forEachRecord} from '../sources/lines.js';
import {claudeSubagentParent, isoTs, type Harness} from '../sources/sessions.js';
import {cpLen} from '../sources/text.js';
import {nativeAuditRoots} from '../analytics/native-census.js';
import {probeFile} from '../analytics/copy-prune.js';
import {openAuditSqliteSnapshot} from '../audit-sqlite.js';
import type {AuditOverviewOptions} from '../analytics/contracts.js';
import {ARCHIVE_MARK, INDEX_HEADER, indexLine, recTurn, lastAssistant, firstUser, recordRelPath, render, renderSidecar, sidFile, type RecSession} from './format.js';
import {runJobs, type ParseJob, type ParseResult} from './worker.js';
import {RecordIndex, parseRecordText} from './index-db.js';

/** Bump when the rendered format changes: every record is rewritten once. */
export const FORMAT_VERSION = 1;
const STATE_VERSION = 1;

export interface SyncOptions {
  recordsDir?: string;
  claudeDir?: string;
  codexDir?: string;
  piDir?: string;
  potsherdDir?: string;
  slopieDir?: string;
  /** Worker entry (bundle); null parses inline. */
  workerUrl?: URL | null;
  threads?: number;
  /** Write `<record>.out.txt` with full tool outputs (up to 20 kB each). Default: SLOPIE_SIDECAR=1. */
  sidecar?: boolean;
  /** Rebuild every record and the index. */
  full?: boolean;
  /** Build the search index (default true). */
  index?: boolean;
  onProgress?: (phase: string, done: number, total: number) => void;
}

export interface SyncResult {
  recordsDir: string;
  sources: number;
  parsed: number;
  errors: string[];
  sessions: number;
  byHarness: Record<string, number>;
  subagents: number;
  promptOnly: number;
  kept: number;
  written: number;
  removed: number;
  droppedImports: number;
  excludedByPolicy: number;
  recordBytes: number;
  indexBytes: number;
  seconds: number;
  phases: Record<string, number>;
  /** Peak resident memory of the process (all parser threads included), MB. */
  maxRssMb: number;
}

interface SourceState {
  size: number;
  mtimeMs: number;
  harness: Harness | 'auto';
  sub: string | null;
  status: 'ok' | 'none' | 'err';
  err?: string;
  id?: string;
  parent?: string | null;
  parentKind?: string | null;
  nTurns?: number;
  start?: string | null;
  end?: string | null;
  project?: string | null;
}

interface SessionState {
  sig: string;
  rel: string;
  line: string;
  start: string;
  harness: string;
  id: string;
  parent: string | null;
  parentKind: string | null;
  project: string | null;
  /** Turns in the written record. */
  n?: number;
  /** History-only (prompt-only) record. */
  history?: boolean;
  /** Its sources are gone; the record is kept as written. */
  kept?: boolean;
  sidecar?: boolean;
}

interface State {
  v: number;
  format: number;
  sidecar: boolean;
  sources: Record<string, SourceState>;
  sessions: Record<string, SessionState>;
}

interface Src {
  file: string;
  harness: Harness | 'auto';
  sub: string | null;
  size: number;
  mtimeMs: number;
  archive: boolean;
}

interface Merged {
  key: string;
  harness: Harness;
  id: string;
  parent: string | null;
  parentKind: string | null;
  nTurns: number;
  size: number;
  start: string | null;
  end: string | null;
  project: string | null;
  best: string | null;
  paths: string[];
  archiveOnly: boolean;
  codexTitle?: string | null;
  history?: {ts: string | null; text: string; ref: string}[];
  sources: string[];
}

export function stateDir(recordsDir: string): string {
  return path.join(recordsDir, '.slopie');
}

export class SyncBusyError extends Error {
  constructor(readonly pid: number) { super(`another slopie sync is running (pid ${pid})`); }
}

/** One sync at a time per records directory; a lock left by a dead process is taken over. */
export function acquireSyncLock(recordsDir: string): () => void {
  const dir = stateDir(recordsDir);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch (k) { alive = (k as NodeJS.ErrnoException).code === 'EPERM'; }
      if (alive && pid !== process.pid) throw new SyncBusyError(pid);
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  throw new SyncBusyError(0);
}

function readState(dir: string): State | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'state.json'), 'utf8')) as State;
    return s.v === STATE_VERSION ? s : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, {mode: 0o600});
  fs.renameSync(tmp, file);
}

/** Directories created 0700 all the way down from the records root. */
function mkdirPrivate(dir: string, root: string): void {
  if (fs.existsSync(dir)) return;
  mkdirPrivate(path.dirname(dir), root);
  fs.mkdirSync(dir, {mode: 0o700});
}

const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 20);

/** Codex thread titles, imports, archived flags and spawn edges from each Codex home. */
function codexMeta(homes: readonly string[], imports: Set<string>): {titles: Map<string, string>; db: Map<string, {title?: string | null; spawnParent?: string}>; imported: Set<string>} {
  const titles = new Map<string, string>();
  const db = new Map<string, {title?: string | null; spawnParent?: string}>();
  const imported = new Set<string>();
  for (const home of homes) {
    const idx = path.join(home, 'session_index.jsonl');
    if (fs.existsSync(idx)) {
      forEachRecord(idx, o => {
        const r = o as Record<string, unknown>;
        if (r && typeof r === 'object' && typeof r['thread_name'] === 'string' && r['thread_name'] && typeof r['id'] === 'string') titles.set(r['id'], r['thread_name']);
      });
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(home, 'external_agent_session_imports.json'), 'utf8')) as {records?: {imported_thread_id?: string}[]};
      for (const r of raw.records ?? []) if (r.imported_thread_id) imported.add(r.imported_thread_id);
    } catch { /* absent */ }
    let states: string[] = [];
    try { states = fs.readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])); } catch { /* none */ }
    if (states.length) {
      try {
        const snap = openAuditSqliteSnapshot(path.join(home, states[0]!));
        try {
          for (const r of snap.db.prepare('select id, title from threads').all() as {id: string; title: string | null}[]) db.set(r.id, {...db.get(r.id), title: r.title});
          try {
            for (const r of snap.db.prepare('select parent_thread_id as p, child_thread_id as c from thread_spawn_edges').all() as {p: string; c: string}[]) db.set(r.c, {...db.get(r.c), spawnParent: r.p});
          } catch { /* older schema */ }
        } finally {
          snap.db.close();
        }
      } catch { /* unreadable state db: titles from the index only */ }
    }
  }
  // The audit's list is broader (every UUID in the imports file); both are honoured.
  for (const id of imports) imported.add(id);
  return {titles, db, imported};
}

/** Every native source the records read: the audit's discovery plus the 1.x rescue archive's per-project copies. */
function discoverSources(o: SyncOptions, state: State | null): {sources: Src[]; historyFiles: string[]; codexHomes: string[]; codexImported: Set<string>} {
  const opts: AuditOverviewOptions = {
    ...(o.claudeDir ? {claudeDir: o.claudeDir} : {}), ...(o.codexDir ? {codexDir: o.codexDir} : {}),
    ...(o.piDir ? {piDir: o.piDir} : {}), ...(o.potsherdDir ? {potsherdDir: o.potsherdDir} : {}),
  };
  const cached = (file: string, size: number, mtimeMs: number) => {
    const s = state?.sources[file];
    return s && s.size === size && s.mtimeMs === mtimeMs ? s : null;
  };
  const found = discover(['claude', 'codex', 'pi'], opts, undefined, (file, size, mtimeMs, known) => {
    const c = cached(file, size, mtimeMs);
    if (c) return {size, mtimeMs, harness: c.harness === 'auto' ? 'auto' : c.harness, identity: '', head: '', tail: ''};
    return probeFile(file, known);
  });
  const out: Src[] = [];
  const skip = (f: string) => {
    const parts = f.split(path.sep);
    return parts.includes('memory') || parts.includes('tool-results') || path.basename(f) === 'history.jsonl';
  };
  for (const job of found.jobs as (typeof found.jobs[number] & {mtimeMs: number})[]) {
    if (job.harness === 'claude' && skip(job.file)) continue;
    const sub = job.harness === 'claude' ? claudeSubagentParent(job.file) ?? null : null;
    out.push({file: job.file, harness: job.harness as Harness | 'auto', sub, size: job.size, mtimeMs: job.mtimeMs, archive: !!job.archive});
  }
  // potsherd 1.x kept per-project copies too (archive/claude/<slug>/...): read-only, records only.
  if (process.env['SLOPIE_AUDIT_ARCHIVE'] !== '0') {
    const legacy = path.join(paths.potsherdDir(o.potsherdDir), 'archive', 'claude');
    const seen = new Set(out.map(s => s.file));
    for (const file of listFiles(legacy, f => f.endsWith('.jsonl'))) {
      if (seen.has(file) || skip(file)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || !st.size) continue;
      out.push({file, harness: 'claude', sub: claudeSubagentParent(file) ?? null, size: st.size, mtimeMs: st.mtimeMs, archive: true});
    }
  }
  const codexHomes = [...new Set(nativeAuditRoots('codex', opts).map(r => path.dirname(r)))];
  const historyFiles = [...found.historyFiles];
  // The rescue archive's copy of history.jsonl can hold prompts the live file has since lost.
  const archived = path.join(paths.potsherdDir(o.potsherdDir), 'archive', 'claude', 'history.jsonl');
  if (process.env['SLOPIE_AUDIT_ARCHIVE'] !== '0' && fs.existsSync(archived) && !historyFiles.includes(archived)) historyFiles.push(archived);
  return {sources: out, historyFiles, codexHomes, codexImported: found.codexImported};
}

/** Exact copies (same size, same head and tail bytes) are parsed once. */
function copySig(file: string, size: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const h = createHash('sha1');
    const n = Math.min(size, 1 << 16);
    const b = Buffer.allocUnsafe(n);
    fs.readSync(fd, b, 0, n, 0);
    h.update(b);
    if (size > n) { fs.readSync(fd, b, 0, n, size - n); h.update(b); }
    return `${size}:${h.digest('hex')}`;
  } finally {
    fs.closeSync(fd);
  }
}

const isForgotten = (policy: Policy, h: string, id: string, parent: string | null) =>
  policy.forgotten.size > 0 && (policy.forgotten.has(sourceId(h, id)) || (!!parent && policy.forgotten.has(sourceId(h, parent))));

export async function syncRecords(o: SyncOptions = {}): Promise<SyncResult> {
  const dir0 = paths.recordsDir(o.recordsDir);
  if (!fs.existsSync(dir0)) fs.mkdirSync(dir0, {recursive: true, mode: 0o700});
  const release = acquireSyncLock(dir0);
  try {
    return await syncLocked(o);
  } finally {
    release();
  }
}

async function syncLocked(o: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const phases: Record<string, number> = {};
  let tp = t0;
  const mark = (name: string) => { const now = Date.now(); phases[name] = (now - tp) / 1000; tp = now; };
  const dir = paths.recordsDir(o.recordsDir);
  const sidecar = o.sidecar ?? process.env['SLOPIE_SIDECAR'] === '1';
  // The opt-outs first: when they cannot be read, nothing is written or removed (carrying on would undo them).
  const policy = loadPolicy(paths.potsherdDir(o.potsherdDir), paths.slopieDir(o.slopieDir));
  assertPolicy(policy);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  mkdirPrivate(stateDir(dir), dir);
  let state = o.full ? null : readState(dir);
  if (state && (state.format !== FORMAT_VERSION || state.sidecar !== sidecar)) {
    // Format change: keep the parse metadata, rewrite every record.
    state = {...state, sessions: Object.fromEntries(Object.entries(state.sessions).map(([k, v]) => [k, {...v, sig: ''}]))};
  }
  const prev: State = state ?? {v: STATE_VERSION, format: FORMAT_VERSION, sidecar, sources: {}, sessions: {}};
  const next: State = {v: STATE_VERSION, format: FORMAT_VERSION, sidecar, sources: {}, sessions: {}};

  // ---- 1. discover
  const {sources, historyFiles, codexHomes, codexImported} = discoverSources(o, state);
  mark('discover');

  // ---- 2. parse what changed (exact copies once)
  const result: SyncResult = {recordsDir: dir, sources: sources.length, parsed: 0, errors: [], sessions: 0, byHarness: {}, subagents: 0, promptOnly: 0, kept: 0,
    written: 0, removed: 0, droppedImports: 0, excludedByPolicy: 0, recordBytes: 0, indexBytes: 0, seconds: 0, phases, maxRssMb: 0};
  const todo: Src[] = [];
  for (const s of sources) {
    const p = prev.sources[s.file];
    if (p && p.size === s.size && p.mtimeMs === s.mtimeMs && p.sub === s.sub) next.sources[s.file] = p;
    else todo.push(s);
  }
  const todoSet = new Set(todo.map(s => s.file));
  const bySize = new Map<number, Src[]>();
  for (const s of sources) { const l = bySize.get(s.size); if (l) l.push(s); else bySize.set(s.size, [s]); }
  const copyOf = new Map<string, string>(); // file -> file whose parse it reuses
  const groups = new Map<string, Src[]>();
  for (const s of todo) {
    const same = bySize.get(s.size)!;
    if (same.length < 2) { groups.set(s.file, [s]); continue; }
    let sig: string;
    try { sig = `${copySig(s.file, s.size)}|${s.sub ?? ''}`; } catch { groups.set(s.file, [s]); continue; }
    const g = groups.get(sig);
    if (g) g.push(s); else groups.set(sig, [s]);
  }
  const jobs: ParseJob[] = [];
  const members = new Map<string, Src[]>();
  for (const g of groups.values()) {
    const lead = [...g].sort((a, b) => Number(a.archive) - Number(b.archive) || (a.harness === 'auto' ? 1 : 0) - (b.harness === 'auto' ? 1 : 0))[0]!;
    // An exact copy of a file parsed in an earlier run reuses that run's metadata.
    const twin = (bySize.get(lead.size) ?? []).find(x => x !== lead && !todoSet.has(x.file) && next.sources[x.file]?.status === 'ok' && x.sub === lead.sub
      && (() => { try { return copySig(x.file, x.size) === copySig(lead.file, lead.size); } catch { return false; } })());
    if (twin) {
      for (const m of g) { next.sources[m.file] = {...next.sources[twin.file]!, size: m.size, mtimeMs: m.mtimeMs, harness: m.harness, sub: m.sub}; copyOf.set(m.file, twin.file); }
      continue;
    }
    for (const m of g) if (m !== lead) copyOf.set(m.file, lead.file);
    members.set(lead.file, g);
    jobs.push({file: lead.file, harness: lead.harness, sub: lead.sub, size: lead.size, sidecar});
  }
  const live = new Map<string, RecSession>(); // file -> parsed session (kept while it may be needed)
  let done = 0;
  const keyOf = (h: string, id: string, parent: string | null | undefined, kind: string | null | undefined) => `${h}:${sidFile(h, id, parent ?? null, kind ?? null)}`;
  const bestLive = new Map<string, {file: string; n: number; size: number}>();
  const onResult = (r: ParseResult) => {
    done++;
    o.onProgress?.('parse', done, jobs.length);
    const g = members.get(r.file) ?? [];
    for (const m of g) {
      const base: SourceState = {size: m.size, mtimeMs: m.mtimeMs, harness: m.harness, sub: m.sub, status: r.status};
      if (r.status === 'err') { base.err = r.err; result.errors.push(r.err); }
      if (r.status === 'ok') {
        const s = r.session;
        Object.assign(base, {id: s.id, parent: s.parent, parentKind: s.parentKind, nTurns: s.turns.length, start: s.start, end: s.end, project: s.project});
      }
      next.sources[m.file] = base;
    }
    if (r.status === 'ok') {
      result.parsed++;
      const s = r.session;
      const key = keyOf(s.harness, s.id, s.parent, s.parentKind);
      const cur = bestLive.get(key);
      const size = g[0]?.size ?? 0;
      if (!cur || s.turns.length > cur.n || (s.turns.length === cur.n && size > cur.size)) {
        if (cur) live.delete(cur.file);
        bestLive.set(key, {file: r.file, n: s.turns.length, size});
        live.set(r.file, s);
      }
    }
  };
  await runJobs(jobs, onResult, o.workerUrl ?? null, o.threads);
  mark('parse');

  // ---- 3. merge copies per session
  const merged = new Map<string, Merged>();
  for (const s of sources) {
    const st = next.sources[s.file];
    if (!st || st.status !== 'ok' || !st.id) continue;
    const h = (st.harness === 'auto' ? 'codex' : st.harness) as Harness;
    const key = keyOf(h, st.id, st.parent, st.parentKind);
    const n = st.nTurns ?? 0;
    let b = merged.get(key);
    if (!b) {
      b = {key, harness: h, id: st.id, parent: st.parent ?? null, parentKind: st.parentKind ?? null, nTurns: n, size: s.size, start: st.start ?? null, end: st.end ?? null,
        project: st.project ?? null, best: s.file, paths: [], archiveOnly: false, sources: []};
      merged.set(key, b);
    } else if (n > b.nTurns || (n === b.nTurns && s.size > b.size)) {
      Object.assign(b, {parent: st.parent ?? null, parentKind: st.parentKind ?? null, nTurns: n, size: s.size, start: st.start ?? null, end: st.end ?? null, project: st.project ?? null, best: s.file});
    }
    b.paths.push(s.file);
  }
  const meta = codexMeta(codexHomes, codexImported);
  const sessions: Merged[] = [];
  for (const b of merged.values()) {
    if (b.harness === 'codex' && meta.imported.has(b.id)) { result.droppedImports++; continue; }
    if (!b.nTurns) continue;
    if (b.harness === 'codex') {
      const m = meta.db.get(b.id);
      b.codexTitle = meta.titles.get(b.id) || m?.title || null;
      if (!b.parent && m?.spawnParent) { b.parent = m.spawnParent; b.parentKind = 'subagent'; }
    }
    b.archiveOnly = b.paths.every(p => p.includes(ARCHIVE_MARK));
    b.sources = [...new Set(b.paths)].sort((x, y) => Number(x.includes(ARCHIVE_MARK)) - Number(y.includes(ARCHIVE_MARK)) || (x < y ? -1 : x > y ? 1 : 0));
    // A Codex spawn edge can name a parent only after parsing: re-key so the file name stays stable.
    b.key = keyOf(b.harness, b.id, b.parent, b.parentKind);
    sessions.push(b);
  }
  // Sessions whose sources have all gone keep their records (unless forgotten / ignored).
  const present = new Set(sessions.map(s => s.key));
  const kept: [string, SessionState][] = [];
  const presentIds = new Set(sessions.map(s => `${s.harness}:${s.id}`));
  for (const [key, ss] of Object.entries(prev.sessions)) {
    if (present.has(key) || ss.history || presentIds.has(`${ss.harness}:${ss.id}`)) continue;
    if (ss.harness === 'codex' && meta.imported.has(ss.id)) continue;
    if (!fs.existsSync(path.join(dir, ss.rel))) continue;
    kept.push([key, ss]);
  }
  const have = new Set([...sessions.map(s => s.id), ...kept.map(([, s]) => s.id)]);
  // Prompt-only records: sessions known only from history.jsonl.
  const hist = new Map<string, {at: number; display: string; project: string | null; ref: string}[]>();
  for (const hp of historyFiles) {
    forEachRecord(hp, (raw, n) => {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r !== 'object' || typeof r['sessionId'] !== 'string' || !r['sessionId'] || !r['display']) return;
      const sid = r['sessionId'];
      if (have.has(sid)) return;
      const rows = hist.get(sid) ?? [];
      rows.push({at: typeof r['timestamp'] === 'number' ? r['timestamp'] : 0, display: String(r['display']), project: typeof r['project'] === 'string' ? r['project'] : null, ref: `${hp}:${n}`});
      hist.set(sid, rows);
    });
  }
  for (const [sid, rows0] of hist) {
    // One turn per prompt: the same prompt (time, text, project) in two history files counts once.
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const sorted = [...rows0].sort((a, b) => a.at - b.at || cmp(a.display, b.display) || cmp(String(a.project), String(b.project)) || cmp(a.ref, b.ref));
    const seen = new Set<string>();
    const rows = sorted.filter(r => { const k = JSON.stringify([r.at, r.display, r.project]); if (seen.has(k)) return false; seen.add(k); return true; });
    const turns = rows.map(r => ({ts: isoTs(r.at), text: r.display, ref: r.ref}));
    sessions.push({key: `claude:${sid}`, harness: 'claude', id: sid, parent: null, parentKind: null, nTurns: turns.length, size: 0, start: turns[0]!.ts, end: turns[turns.length - 1]!.ts,
      project: rows[0]!.project, best: null, paths: [], archiveOnly: false, history: turns, sources: [...new Set(rows0.map(r => r.ref.slice(0, r.ref.lastIndexOf(':'))))].sort()});
  }
  // Opt-outs.
  const keep = (h: string, id: string, parent: string | null, project: string | null) => !policy.ignored(project) && !isForgotten(policy, h, id, parent);
  const final = sessions.filter(s => keep(s.harness, s.id, s.parent, s.project));
  const finalKept = kept.filter(([, s]) => keep(s.harness, s.id, s.parent, s.project));
  result.excludedByPolicy = sessions.length - final.length + kept.length - finalKept.length;
  const kids = new Map<string, {id: string; kind: string; start: string}[]>();
  const ids = new Set([...final.map(s => s.id), ...finalKept.map(([, s]) => s.id)]);
  for (const s of [...final.map(s => ({id: s.id, parent: s.parent, kind: s.parentKind, start: s.start ?? ''})), ...finalKept.map(([, s]) => ({id: s.id, parent: s.parent, kind: s.parentKind, start: s.start}))]) {
    if (s.parent && ids.has(s.parent)) { const l = kids.get(s.parent) ?? []; l.push({id: s.id, kind: s.kind ?? 'None', start: s.start}); kids.set(s.parent, l); }
  }
  for (const l of kids.values()) l.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
  mark('merge');

  // ---- 4. write changed records
  const index = o.index === false ? null : RecordIndex.open(stateDir(dir));
  if (index && o.full) index.clear();
  const indexed = index ? index.keys() : new Map<string, string>();
  const needParse: {s: Merged; sig: string}[] = [];
  const sigOf = (s: Merged) => hash([FORMAT_VERSION, sidecar, s.best, s.best ? next.sources[s.best]?.size : 0, s.best ? next.sources[s.best]?.mtimeMs : 0, s.nTurns, s.sources, s.codexTitle ?? null,
    s.parent, s.parentKind, (kids.get(s.id) ?? []).map(c => [c.id, c.kind]), s.archiveOnly, s.history ? s.history.length : -1]);
  const writeOne = (s: Merged, rec: RecSession, sig: string) => {
    rec.parent = s.parent; rec.parentKind = s.parentKind;
    if (s.harness === 'codex') rec.title = s.codexTitle || rec.title;
    const rel = recordRelPath(rec);
    const file = path.join(dir, rel);
    mkdirPrivate(path.dirname(file), dir);
    const text = render(rec, {children: kids.get(s.id) ?? [], sources: s.sources, archiveOnly: s.archiveOnly});
    writeAtomic(file, text);
    const side = file.slice(0, -4) + '.out.txt';
    const sideText = sidecar ? renderSidecar(rec, path.basename(file)) : null;
    if (sideText) writeAtomic(side, sideText); else if (fs.existsSync(side)) fs.unlinkSync(side);
    const old = prev.sessions[s.key];
    if (old && old.rel !== rel) { try { fs.unlinkSync(path.join(dir, old.rel)); } catch { /* gone */ } try { fs.unlinkSync(path.join(dir, old.rel.slice(0, -4) + '.out.txt')); } catch { /* none */ } }
    next.sessions[s.key] = {sig, rel, line: indexLine(rec, rel), start: rec.start ?? '', harness: rec.harness, id: rec.id, parent: rec.parent, parentKind: rec.parentKind, project: rec.project, n: rec.turns.length,
      ...(s.history ? {history: true} : {}), ...(sidecar && sideText ? {sidecar: true} : {})};
    index?.put(s.key, rec, {rel, children: kids.get(s.id) ?? [], sources: s.sources, archiveOnly: s.archiveOnly, best: s.best, firstUser: firstUser(rec), lastAssistant: lastAssistant(rec)}, sig);
    result.written++;
  };
  for (const s of final) {
    const sig = sigOf(s);
    const old = prev.sessions[s.key];
    const fileOk = old && fs.existsSync(path.join(dir, old.rel));
    if (old && old.sig === sig && fileOk && (!index || indexed.get(s.key) === sig)) { next.sessions[s.key] = old; continue; }
    // A record never loses turns: when the copy it was written from is gone and only a shorter one is left
    // (e.g. an older archive snapshot), the record is kept as written.
    if (old && fileOk && !old.history && !s.history && (old.n ?? 0) > s.nTurns) {
      next.sessions[s.key] = {...old, kept: true};
      if (index && !indexed.has(s.key)) {
        const rec = parseRecordText(fs.readFileSync(path.join(dir, old.rel), 'utf8'));
        if (rec) index.put(s.key, rec.session, {...rec.header, rel: old.rel, best: null, firstUser: firstUser(rec.session), lastAssistant: lastAssistant(rec.session)}, old.sig);
      }
      continue;
    }
    if (old && old.sig === sig && fileOk && index) {
      // Record unchanged, index row missing or stale: rebuild the row from the record text.
      const rec = parseRecordText(fs.readFileSync(path.join(dir, old.rel), 'utf8'));
      if (rec) { index.put(s.key, rec.session, {...rec.header, rel: old.rel, best: s.best, firstUser: firstUser(rec.session), lastAssistant: lastAssistant(rec.session)}, sig); next.sessions[s.key] = old; continue; }
    }
    if (s.history) {
      const rec: RecSession = {harness: 'claude', id: s.id, project: s.project, title: '(prompt history only; transcript not kept)', start: s.start, end: s.end, parent: null, parentKind: null,
        turns: s.history.map(t => recTurn({role: 'USER', ts: t.ts, text: t.text, textLen: cpLen(t.text), ref: t.ref}))};
      writeOne(s, rec, sig);
      continue;
    }
    const parsed = s.best ? live.get(s.best) ?? live.get(copyOf.get(s.best) ?? '') : undefined;
    if (parsed) writeOne(s, parsed, sig);
    else needParse.push({s, sig});
  }
  if (needParse.length) {
    const byFile = new Map(needParse.map(x => [x.s.best!, x]));
    const jobs2: ParseJob[] = needParse.map(x => { const st = next.sources[x.s.best!]!; return {file: x.s.best!, harness: st.harness, sub: st.sub, size: st.size, sidecar}; });
    await runJobs(jobs2, r => {
      const x = byFile.get(r.file);
      if (!x) return;
      if (r.status === 'ok') writeOne(x.s, r.session, x.sig);
      else if (prev.sessions[x.s.key]) next.sessions[x.s.key] = prev.sessions[x.s.key]!;
    }, o.workerUrl ?? null, o.threads);
  }
  for (const [key, ss] of finalKept) {
    next.sessions[key] = {...ss, kept: true};
    if (index && !indexed.has(key)) {
      const rec = parseRecordText(fs.readFileSync(path.join(dir, ss.rel), 'utf8'));
      if (rec) index.put(key, rec.session, {...rec.header, rel: ss.rel, best: null, firstUser: firstUser(rec.session), lastAssistant: lastAssistant(rec.session)}, ss.sig);
    }
  }
  live.clear();
  mark('write');

  // ---- 5. remove what is no longer kept (forgotten, ignored, superseded)
  for (const [key, ss] of Object.entries(prev.sessions)) {
    if (next.sessions[key]) continue;
    for (const f of [ss.rel, ss.rel.slice(0, -4) + '.out.txt']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
    result.removed++;
  }
  if (index) {
    for (const key of indexed.keys()) if (!next.sessions[key]) index.remove(key);
    index.finish(!!o.full || result.written > 200);
  }
  // Stray record files (e.g. written by an older layout) that no session claims are removed too.
  const claimed = new Set(Object.values(next.sessions).flatMap(s => [s.rel, s.rel.slice(0, -4) + '.out.txt']));
  for (const h of ['claude', 'codex', 'pi']) {
    for (const f of listFiles(path.join(dir, h), x => x.endsWith('.txt'))) {
      const rel = path.relative(dir, f).split(path.sep).join('/');
      if (!claimed.has(rel)) { try { fs.unlinkSync(f); result.removed++; } catch { /* gone */ } }
    }
  }

  // ---- 6. INDEX.tsv and state
  const rows = Object.entries(next.sessions).sort(([ka, a], [kb, b]) => (a.start < b.start ? -1 : a.start > b.start ? 1 : ka < kb ? -1 : 1));
  writeAtomic(path.join(dir, 'INDEX.tsv'), INDEX_HEADER + '\n' + rows.map(([, s]) => s.line).join('\n') + '\n');
  writeAtomic(path.join(stateDir(dir), 'state.json'), JSON.stringify(next));
  mark('index');
  for (const [, s] of rows) {
    result.byHarness[s.harness] = (result.byHarness[s.harness] ?? 0) + 1;
    if (s.parentKind === 'subagent') result.subagents++;
    if (s.history) result.promptOnly++;
    if (s.kept) result.kept++;
  }
  result.sessions = rows.length;
  for (const [, s] of rows) { try { result.recordBytes += fs.statSync(path.join(dir, s.rel)).size; } catch { /* raced */ } }
  if (index) result.indexBytes = index.bytes();
  result.seconds = (Date.now() - t0) / 1000;
  result.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  return result;
}
