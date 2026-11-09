/**
 * Copies of one session are common: potsherd's rescue archive keeps content-addressed
 * snapshots of live transcripts, Codex moves rollouts to archived_sessions/, and two
 * Claude roots can hold the same file. Parsing every copy costs the cold run most of its
 * time and adds nothing: aggregation de-duplicates their events anyway.
 *
 * So before a file is parsed it is probed (bounded reads, no JSON parsing):
 *
 *   harness   from its first records (or bounded record headers further in, see `classify`)
 *   identity  the native session id from its first records, when there is one
 *   head      sha1 of its first HEAD bytes
 *   tail      sha1 of its last TAIL bytes
 *
 * and a file C is skipped when another file F of the same harness and head is at
 * least as long and holds C's last TAIL bytes at the same offset: C is then a prefix snapshot
 * of F (append-only JSONL), so every event of C is also in F. Anything else - divergent
 * tails, compressed rollouts, files too small to compare - is parsed in full. Probes and
 * verified prefix relations are cached by (path, size, mtime), so a warm run does no I/O
 * for unchanged files.
 */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {NativeHarness} from './extract.js';

const HEAD = 4096;
const TAIL = 4096;
/** First block read for classification and identity. */
const SNIFF = 64 * 1024;
/** Record headers are scanned this far into a file whose first block does not classify it. */
export const CLASSIFY_MAX_BYTES = 512 * 1024 * 1024;
/** Bytes of each record's start and end looked at while scanning record headers. */
const RECORD_EDGE = 2048;
const ZSTD_MAGIC = 0xfd2fb528;

export interface Probe {
  size: number;
  mtimeMs: number;
  /** null: no native harness recognised (within CLASSIFY_MAX_BYTES). */
  harness: NativeHarness | 'auto' | null;
  /** Native session id from the first records ('' when none was found). */
  identity: string;
  head: string;
  tail: string;
  /** The harness was only found beyond the first block. */
  deep?: boolean;
  /** Not a transcript: a copy of Claude's typed-prompt log (history.jsonl lines), read through history instead. */
  history?: boolean;
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('base64');

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) { const n = fs.readSync(fd, buffer, read, length - read, position + read); if (!n) break; read += n; }
  return buffer.subarray(0, read);
}

/** Harness from a block of whole records (first line decides Codex / pi; Claude records carry sessionId). */
export function sniffBlock(head: Buffer): NativeHarness | null {
  const firstEnd = head.indexOf(10);
  const first = head.toString('utf8', 0, Math.min(firstEnd < 0 ? head.length : firstEnd, 4096));
  if (first.includes('"session_meta"')) return 'codex';
  if (/"type"\s*:\s*"session"/.test(first) && !first.includes('"sessionId"')) return 'pi';
  const text = head.toString('latin1');
  if (text.includes('"sessionId"') && CLAUDE_TYPE.test(text)) return 'claude';
  return null;
}
/** A history.jsonl record: {"display": ..., ..., "timestamp": ...} with no session record type. */
const HISTORY_LINE = /^\{"display"\s*:/;
const CLAUDE_TYPE = /"type"\s*:\s*"(?:user|assistant|summary|system)"/;

/**
 * Claude transcripts can open with large metadata records (file-history snapshots, titles), so a
 * fixed-size head may hold no conversation record at all. Scans the start and end of each record
 * (records are newline-delimited; their bodies are never decoded) up to CLASSIFY_MAX_BYTES.
 */
function classifyDeep(fd: number, size: number): NativeHarness | null {
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  let position = 0, lineStart = 0, headPart: Buffer | null = null;
  const limit = Math.min(size, CLASSIFY_MAX_BYTES);
  while (position < limit) {
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - position), position);
    if (!n) break;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0 || nl >= n) break;
      // One record: [lineStart, position + nl). Look at its first and last RECORD_EDGE bytes.
      const recordStart = lineStart, recordEnd = position + nl;
      const head = headPart ?? chunk.subarray(start, Math.min(nl, start + RECORD_EDGE));
      const tail = recordEnd - recordStart > RECORD_EDGE ? chunk.subarray(Math.max(start, nl - RECORD_EDGE), nl) : Buffer.alloc(0);
      const edges = Buffer.concat([head, tail]).toString('latin1');
      if (edges.includes('"sessionId"') && CLAUDE_TYPE.test(edges)) return 'claude';
      headPart = null;
      lineStart = position + nl + 1;
      start = nl + 1;
    }
    if (headPart === null && start < n) headPart = Buffer.from(chunk.subarray(start, Math.min(n, start + RECORD_EDGE)));
    position += n;
  }
  return null;
}

/** Codex rollout file names end in the session id. */
const ROLLOUT_ID = /rollout-[^/\\]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl\.zst$/i;
const UUIDISH = /"(?:sessionId|session_id|id)"\s*:\s*"([0-9A-Za-z_.:-]{8,80})"/;
/** Native session id from the first records: Codex session_meta id, pi session id, Claude sessionId (+ agentId for subagents). */
function identityOf(harness: NativeHarness | 'auto' | null, head: Buffer): string {
  if (!harness || harness === 'auto') return '';
  const text = head.toString('utf8'), nl = text.indexOf('\n'), first = nl < 0 ? text : text.slice(0, nl);
  if (harness === 'codex') return /"payload"\s*:\s*\{[^]*?"id"\s*:\s*"([^"]{8,80})"/.exec(first)?.[1] ?? '';
  if (harness === 'pi') return UUIDISH.exec(first)?.[1] ?? '';
  const sid = /"sessionId"\s*:\s*"([^"]{1,80})"/.exec(text)?.[1] ?? '';
  const agent = /"agentId"\s*:\s*"([^"]{1,80})"/.exec(text)?.[1];
  return agent ? `${sid}:${agent}` : sid;
}

/** Bounded probe of one file. `known`: the harness of a live root (archive copies are classified from content). */
export function probeFile(file: string, known: NativeHarness | null): Probe | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    // A live file's harness is known: its head is all that is needed. Archive copies are classified from content.
    const head = readAt(fd, Math.min(known ? HEAD * 2 : SNIFF, stat.size), 0);
    const compressed = head.length >= 4 && head.readUInt32LE(0) === ZSTD_MAGIC;
    let harness: Probe['harness'] = compressed ? 'auto' : known ?? sniffBlock(head);
    let deep = false;
    const history = !harness && HISTORY_LINE.test(head.toString('utf8', 0, Math.min(head.length, 4096)));
    if (!harness && !history && stat.size > SNIFF) { harness = classifyDeep(fd, stat.size); deep = harness !== null; }
    const probe: Probe = {
      size: stat.size, mtimeMs: stat.mtimeMs, harness, identity: compressed ? ROLLOUT_ID.exec(file)?.[1] ?? '' : identityOf(harness, head),
      head: sha1(head.subarray(0, HEAD)), tail: sha1(readAt(fd, Math.min(TAIL, stat.size), Math.max(0, stat.size - TAIL))),
    };
    if (deep) probe.deep = true;
    if (history) probe.history = true;
    return probe;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Hashes of a decompressed rollout as a probe would have them, computed while its bytes stream
 * past (it is never held whole): head, and the TAIL bytes before each offset (offsets past the
 * end are omitted).
 */
export class StreamHashes {
  private headParts: Buffer[] = [];
  private headLength = 0;
  /** The last TAIL bytes seen. */
  private window = Buffer.alloc(0);
  private produced = 0;
  private readonly offsets: number[];
  private readonly at: [number, string][] = [];
  constructor(offsets: readonly number[]) { this.offsets = [...offsets].sort((a, b) => a - b); }
  push(chunk: Buffer): void {
    if (!chunk.length) return;
    if (this.headLength < HEAD) { const part = chunk.subarray(0, HEAD - this.headLength); this.headParts.push(Buffer.from(part)); this.headLength += part.length; }
    const from = this.produced, to = from + chunk.length;
    let joined: Buffer | null = null;
    while (this.offsets.length && this.offsets[0]! <= to) {
      const end = this.offsets.shift()!;
      if (end <= from) continue;
      joined ??= Buffer.concat([this.window, chunk]);
      // joined starts at stream position from - window.length
      const stop = end - (from - this.window.length);
      this.at.push([end, sha1(joined.subarray(Math.max(0, stop - TAIL), stop))]);
    }
    this.window = chunk.length >= TAIL ? Buffer.from(chunk.subarray(chunk.length - TAIL)) : Buffer.concat([this.window, chunk]).subarray(-TAIL);
    this.produced = to;
  }
  result(): {head: string; at: [number, string][]} { return {head: sha1(Buffer.concat(this.headParts)), at: this.at}; }
}

/** sha1 of `file`'s bytes [end - TAIL, end): does it hold a shorter copy's tail at the same offset? */
function tailAt(file: string, end: number): string | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try { const b = readAt(fd, Math.min(TAIL, end), Math.max(0, end - TAIL)); return b.length === Math.min(TAIL, end) ? sha1(b) : null; } catch { return null; } finally { fs.closeSync(fd); }
}

export interface PruneCandidate {
  file: string;
  probe: Probe;
  /** potsherd archive copy (a live copy wins a tie). */
  archive: boolean;
}

/** A verified prefix relation: `file` (at size/mtime) is a prefix of `by` (at bySize/byMtime). */
export interface PrefixRelation {file: string; size: number; mtimeMs: number; by: string; bySize: number; byMtimeMs: number}

export interface PruneResult {
  /** Files to skip -> the file whose copy covers them. */
  skipped: Map<string, string>;
  /**
   * Copies of a compressed rollout (same session id): whether they are prefixes is only known once the
   * rollout is decompressed, so they wait for its parse (`checks`) and are read only if the check fails.
   */
  deferred: Map<string, {by: string; probe: Probe}>;
  /** Relations verified or reused this run (to cache). */
  relations: PrefixRelation[];
  /** Tail reads done to verify relations (diagnostics). */
  verifiedReads: number;
}

/**
 * Chooses which copies to parse. `cached` holds relations from earlier runs; one is reused only
 * when both files still have the same size and mtime.
 */
export function pruneCopies(candidates: readonly PruneCandidate[], cached: ReadonlyMap<string, PrefixRelation>): PruneResult {
  const groups = new Map<string, PruneCandidate[]>();
  const compressed = new Map<string, PruneCandidate>();
  for (const c of candidates) if (c.probe.harness === 'auto' && c.probe.identity) compressed.set(c.probe.identity, c);
  for (const c of candidates) {
    const p = c.probe;
    // Compressed rollouts cannot be compared without decompressing; tiny files cost nothing to read.
    if (!p.harness || p.harness === 'auto' || p.size <= HEAD + TAIL) continue;
    // Copies of one session share their first HEAD bytes (the session header and first records carry its
    // native id, timestamps and record uuids); the tail check below proves the prefix relation.
    const key = `${p.harness}\0${p.head}`;
    const list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  }
  const skipped = new Map<string, string>(), relations: PrefixRelation[] = [], deferred: PruneResult['deferred'] = new Map();
  let verifiedReads = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // Longest first; a live copy before an archived one of the same length; then by path (deterministic).
    list.sort((a, b) => b.probe.size - a.probe.size || Number(a.archive) - Number(b.archive) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (let i = 1; i < list.length; i++) {
      const c = list[i]!;
      for (let j = 0; j < i; j++) {
        const f = list[j]!;
        const old = cached.get(c.file);
        let ok = false;
        if (old && old.by === f.file && old.size === c.probe.size && old.mtimeMs === c.probe.mtimeMs && old.bySize === f.probe.size && old.byMtimeMs === f.probe.mtimeMs) ok = true;
        else if (f.probe.size === c.probe.size) ok = f.probe.tail === c.probe.tail;
        else { verifiedReads++; ok = tailAt(f.file, c.probe.size) === c.probe.tail; }
        if (!ok) continue;
        skipped.set(c.file, f.file);
        relations.push({file: c.file, size: c.probe.size, mtimeMs: c.probe.mtimeMs, by: f.file, bySize: f.probe.size, byMtimeMs: f.probe.mtimeMs});
        break;
      }
    }
  }
  // Archive copies of compressed rollouts (uncompressed Codex copies whose session id names a .zst rollout).
  for (const c of candidates) {
    if (!c.archive || skipped.has(c.file) || c.probe.harness !== 'codex' || !c.probe.identity) continue;
    const f = compressed.get(c.probe.identity);
    if (!f) continue;
    const old = cached.get(c.file);
    if (old && old.by === f.file && old.size === c.probe.size && old.mtimeMs === c.probe.mtimeMs && old.bySize === f.probe.size && old.byMtimeMs === f.probe.mtimeMs) {
      skipped.set(c.file, f.file);
      relations.push(old);
    } else deferred.set(c.file, {by: f.file, probe: c.probe});
  }
  return {skipped, relations, deferred, verifiedReads};
}
