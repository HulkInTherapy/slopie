/**
 * Per-file cache of extracted facts, keyed by (path, size, mtime). A warm run
 * only re-reads files that changed. The cache lives in the audit derived-cache
 * directory (mode 0700/0600) and never holds sources the user has forgotten or
 * ignored: they are dropped every time it is written.
 *
 * Layout (v19): one small index plus one shard per source,
 *
 *   facts-v<N>/index.bin        file -> {shard, size, mtime, tz, harness, ids, project};
 *                               file probes and verified prefix relations (copy-prune.ts)
 *   facts-v<N>/<sha1>.bin       SourceFacts of one file
 *   facts-v<N>/h-<sha1>.bin     parsed history.jsonl of one Claude root
 *   facts-v<N>/dictionary.bin   typo-fingerprint dictionary memo
 *
 * so an appended session rewrites one shard and the index instead of the whole
 * cache (the old single blob was ~35 MB on a large machine), and a shard is
 * only deserialized when its file is asked for. Shard names are hashes: no
 * path appears in a file name. Every write is temp-file + rename.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {serialize, deserialize} from 'node:v8';
import {FACTS_VERSION, type HistoryData, type HistoryEntry, type SourceFacts} from './extract.js';
import type {AuditHarness} from './contracts.js';
import type {PrefixRelation, Probe} from './copy-prune.js';

const DIR = `facts-v${FACTS_VERSION}`;
const INDEX = 'index.bin';
const DICTIONARY = 'dictionary.bin';

/** What the cache knows about a file without opening its shard (also what pruning needs). */
export interface FactsMeta {file: string; /** Adapter sources: the facts' own file when `file` is a cache key. */ source?: string; shard: string; size: number; mtimeMs: number; tz?: string; harness: AuditHarness; sessionId: string; parentId: string | null; project: string | null}
interface HistoryMeta {file: string; shard: string; size: number; mtimeMs: number; tz: string}
interface HistoryRecord extends HistoryMeta {data: HistoryData}

const shardOf = (file: string, prefix = '') => `${prefix}${createHash('sha1').update(file).digest('hex')}.bin`;
const metaOf = (f: SourceFacts): FactsMeta => ({file: f.file, shard: shardOf(f.file), size: f.size, mtimeMs: f.mtimeMs, ...(f.tz ? {tz: f.tz} : {}),
  harness: f.harness, sessionId: f.sessionId, parentId: f.parentId, project: f.project});

function writeAtomic(file: string, data: Buffer): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, {mode: 0o600});
  fs.renameSync(temp, file);
}

export class FactsCache {
  private metas = new Map<string, FactsMeta>();
  private loaded = new Map<string, SourceFacts>();
  private dirtyShards = new Set<string>();
  private historyMetas = new Map<string, HistoryMeta>();
  private historyLoaded = new Map<string, HistoryRecord>();
  private dirtyHistory = new Set<string>();
  /** Bounded probes of native files (harness, identity, head/tail hashes), by path. */
  private probes = new Map<string, Probe>();
  /** Verified "is a prefix copy of" relations, by the shorter file. */
  relations = new Map<string, PrefixRelation>();
  private probesDirty = false;
  /** Dictionary lookups of the typo fingerprint (word -> in dictionary). */
  dictionary = new Map<string, boolean>();
  private dictionarySize = 0;
  private indexDirty = false;
  /** Shards read in this run (diagnostics). */
  shardsRead = 0;

  constructor(private readonly dir: string | null) {}

  private get root(): string { return path.join(this.dir!, DIR); }

  load(): void {
    if (!this.dir) return;
    try {
      const value = deserialize(fs.readFileSync(path.join(this.root, INDEX))) as {version: number; entries: FactsMeta[]; history: HistoryMeta[]; probes?: [string, Probe][]; relations?: PrefixRelation[]};
      if (value?.version !== FACTS_VERSION || !Array.isArray(value.entries)) return;
      for (const m of value.entries) this.metas.set(m.file, m);
      for (const h of Array.isArray(value.history) ? value.history : []) this.historyMetas.set(h.file, h);
      for (const [file, p] of Array.isArray(value.probes) ? value.probes : []) this.probes.set(file, p);
      for (const r of Array.isArray(value.relations) ? value.relations : []) this.relations.set(r.file, r);
    } catch {
      // Missing or unreadable cache: everything is simply read again.
    }
    try {
      const d = deserialize(fs.readFileSync(path.join(this.root, DICTIONARY)));
      if (d instanceof Map) { this.dictionary = d as Map<string, boolean>; this.dictionarySize = d.size; }
    } catch { /* no memo yet */ }
  }

  private shard(meta: FactsMeta): SourceFacts | null {
    const hit = this.loaded.get(meta.file);
    if (hit) return hit;
    try {
      const facts = deserialize(fs.readFileSync(path.join(this.root, meta.shard))) as SourceFacts;
      if (!facts || facts.v !== FACTS_VERSION || facts.file !== (meta.source ?? meta.file)) return null;
      this.shardsRead++;
      this.loaded.set(meta.file, facts);
      return facts;
    } catch {
      return null;
    }
  }

  /** Probe of an unchanged file, else a fresh one from `probe` (null: unreadable). */
  probe(file: string, size: number, mtimeMs: number, probe: () => Probe | null): Probe | null {
    const old = this.probes.get(file);
    if (old && old.size === size && old.mtimeMs === mtimeMs) return old;
    const fresh = probe();
    if (fresh) { this.probes.set(file, fresh); this.probesDirty = true; }
    return fresh;
  }

  /** Replaces the cached prefix relations with this run's (only relations between unchanged files are ever reused). */
  setRelations(relations: readonly PrefixRelation[]): void {
    const same = relations.length === this.relations.size && relations.every(r => { const o = this.relations.get(r.file); return o && o.by === r.by && o.size === r.size && o.bySize === r.bySize && o.mtimeMs === r.mtimeMs && o.byMtimeMs === r.byMtimeMs; });
    if (same) return;
    this.relations = new Map(relations.map(r => [r.file, r]));
    this.probesDirty = true;
  }

  /**
   * Facts of a non-file-backed or adapter source (Cursor, Gemini, Copilot), keyed by an identity
   * plus size and mtime; parsed again only when that changes.
   */
  external(key: string, size: number, mtimeMs: number, tz: string, read: () => Promise<SourceFacts>): Promise<SourceFacts> {
    const m = this.metas.get(key);
    if (m && m.size === size && m.mtimeMs === mtimeMs && m.tz === tz) { const hit = this.shard(m); if (hit) return Promise.resolve(hit); }
    return read().then(facts => {
      const stored = {...facts, size, mtimeMs, tz};
      this.loaded.set(key, stored);
      this.metas.set(key, {...metaOf(stored), file: key, shard: shardOf(key), source: facts.file});
      this.dirtyShards.add(key);
      this.indexDirty = true;
      return facts;
    });
  }

  /** Cached facts when the file still has the same size and mtime (and story time zone). */
  get(file: string, size: number, mtimeMs: number, tz?: string): SourceFacts | null {
    const m = this.metas.get(file);
    if (!m || m.size !== size || m.mtimeMs !== mtimeMs || (tz && m.tz && m.tz !== tz)) return null;
    return this.shard(m);
  }

  /** Previous facts of a file regardless of freshness (for append-only resume). */
  previous(file: string): SourceFacts | null {
    const m = this.metas.get(file);
    return m ? this.shard(m) : null;
  }

  set(facts: SourceFacts): void {
    this.loaded.set(facts.file, facts);
    this.metas.set(facts.file, metaOf(facts));
    this.dirtyShards.add(facts.file);
    this.indexDirty = true;
  }

  /**
   * Parsed ~/.claude/history.jsonl (text stripped), re-read only when it
   * changes. `read` gets the previous data and its byte length so an
   * append-only log can be extended instead of re-read.
   */
  history(file: string, tz: string, read: (file: string, previous: {data: HistoryData; size: number} | null) => HistoryData): HistoryData {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return {entries: [], counters: new Map()}; }
    const h = this.loadHistory(file);
    if (h && h.tz === tz && h.size === stat.size && h.mtimeMs === stat.mtimeMs) return h.data;
    const data = read(file, h && h.tz === tz && h.size > 0 && h.size < stat.size ? {data: h.data, size: h.data.bytes ?? h.size} : null);
    for (const e of data.entries) e.text = '';
    const record = {file, shard: shardOf(file, 'h-'), size: stat.size, mtimeMs: stat.mtimeMs, tz, data};
    this.historyLoaded.set(file, record);
    this.historyMetas.set(file, {file, shard: record.shard, size: stat.size, mtimeMs: stat.mtimeMs, tz});
    this.dirtyHistory.add(file);
    this.indexDirty = true;
    return data;
  }

  private loadHistory(file: string): HistoryRecord | null {
    const hit = this.historyLoaded.get(file);
    if (hit) return hit;
    const meta = this.historyMetas.get(file);
    if (!meta || !this.dir) return null;
    try {
      const data = deserialize(fs.readFileSync(path.join(this.root, meta.shard))) as HistoryData;
      if (!data || !Array.isArray(data.entries)) return null;
      const record = {...meta, data};
      this.historyLoaded.set(file, record);
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Writes what changed, keeping only files that are allowed (`keep` sees the
   * index metadata, so files not read this run are pruned without opening them).
   */
  save(keep: (meta: Pick<FactsMeta, 'file' | 'harness' | 'sessionId' | 'parentId' | 'project'>) => boolean, keepHistory: (entry: HistoryEntry) => boolean = () => true, keepProbe: (file: string) => boolean = () => true): void {
    if (!this.dir) return;
    const removedShards: string[] = [];
    for (const [file, meta] of this.metas) if (!keep(meta)) { this.metas.delete(file); this.loaded.delete(file); this.dirtyShards.delete(file); removedShards.push(meta.shard); }
    for (const file of this.probes.keys()) if (!keepProbe(file)) { this.probes.delete(file); this.relations.delete(file); this.probesDirty = true; }
    for (const [file, meta] of this.historyMetas) {
      if (!fs.existsSync(file)) { this.historyMetas.delete(file); this.historyLoaded.delete(file); removedShards.push(meta.shard); continue; }
      const record = this.historyLoaded.get(file);
      if (!record) continue;
      const {data} = record;
      const kept = data.entries.filter(keepHistory);
      if (kept.length !== data.entries.length) {
        const counters = new Map([...data.counters].filter(([session, c]) => keepHistory({sessionId: session || null, at: null, project: c.project, kind: 'human', text: ''})));
        // size -1: the next run re-reads (and re-filters) the log instead of trusting a pruned prefix.
        this.historyLoaded.set(file, {...record, size: -1, data: {entries: kept, counters}});
        this.historyMetas.set(file, {...meta, size: -1});
        this.dirtyHistory.add(file);
      }
    }
    const dictionaryChanged = this.dictionary.size !== this.dictionarySize;
    if (!this.dirtyShards.size && !this.dirtyHistory.size && !removedShards.length && !this.indexDirty && !this.probesDirty && !dictionaryChanged) return;
    try {
      fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
      for (const file of this.dirtyShards) {
        const facts = this.loaded.get(file), meta = this.metas.get(file);
        if (facts && meta) writeAtomic(path.join(this.root, meta.shard), serialize(facts));
      }
      for (const file of this.dirtyHistory) {
        const record = this.historyLoaded.get(file);
        if (record) writeAtomic(path.join(this.root, record.shard), serialize(record.data));
      }
      for (const shard of removedShards) fs.rmSync(path.join(this.root, shard), {force: true});
      if (dictionaryChanged) writeAtomic(path.join(this.root, DICTIONARY), serialize(this.dictionary));
      writeAtomic(path.join(this.root, INDEX), serialize({version: FACTS_VERSION, entries: [...this.metas.values()], history: [...this.historyMetas.values()], probes: [...this.probes], relations: [...this.relations.values()]}));
      // Older layouts (single facts-v<N>.bin blobs, other versions' directories) are dropped.
      for (const old of fs.readdirSync(this.dir)) {
        if (/^facts-v\d+\.bin$/.test(old) || (/^facts-v\d+$/.test(old) && old !== DIR)) fs.rmSync(path.join(this.dir, old), {recursive: true, force: true});
      }
      this.dirtyShards.clear();
      this.dirtyHistory.clear();
      this.indexDirty = false;
      this.probesDirty = false;
      this.dictionarySize = this.dictionary.size;
    } catch {
      // The cache is an optimisation; failing to write it never fails a report.
    }
  }
}
