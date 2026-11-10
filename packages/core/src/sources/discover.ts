/**
 * Source discovery shared by `slopie audit` and `slopie sync`: one list of native history files per
 * harness (Claude Code roots and Desktop agent-mode homes, Codex sessions/archived_sessions including
 * `.jsonl.zst`, pi, the potsherd rescue archive), plus each Claude root's history.jsonl and the Codex
 * import list. The audit reads facts from these files; the records exporter reads turns from the same files.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../paths.js';
import {zstdSupport, type NativeHarness} from '../analytics/extract.js';
import {probeFile, type Probe} from '../analytics/copy-prune.js';
import type {ScanJob} from '../analytics/scan-pool.js';
import {claudeDesktopRoots, nativeAuditRoots} from '../analytics/native-census.js';
import {ADAPTER_HARNESSES, antigravityCensus, discoverAdapter, type AdapterHarness} from '../analytics/adapter-facts.js';
import type {SessionSource} from '../adapters/types.js';
import type {AuditHarness, AuditOverviewOptions} from '../analytics/contracts.js';


export interface Discovered {
  jobs: ScanJob[];
  opencodeDatabases: string[];
  opencodeJson: string[];
  /** Every Claude root's history.jsonl (first = primary for text rehydration). */
  historyFiles: string[];
  /** Codex thread ids imported from another agent. */
  codexImported: Set<string>;
  /** Every Claude root's stats-cache.json (Claude Code's own per-model token totals). */
  statsFiles: string[];
  census: Map<AuditHarness, {files: number; bytes: number; roots: number}>;
  /** Compressed sources that cannot be read on this machine (no zstd). */
  zstdUnsupported: number;
  /** Cursor / Gemini / Copilot sources (prompt-only, read through their adapters). */
  adapters: Map<AdapterHarness, SessionSource[]>;
  /** Archive files no native harness was recognised in (bounded record-header scan): an explicit gap, never silently dropped. */
  unclassified: number;
}

export function listFiles(root: string, accept: (file: string) => boolean): string[] {
  let names: string[];
  try { names = fs.readdirSync(root, {recursive: true}) as string[]; } catch { return []; }
  const out: string[] = [];
  for (const name of names) { const file = path.join(root, name); if (accept(file)) out.push(file); }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * `~/.codex/external_agent_session_imports.json`: threads Codex imported from another agent (Claude Code).
 * The exact shape is not documented, so every UUID in it is collected; only Codex sessions with that id
 * are affected (their replayed prompts are not new human prompts).
 */
export function readCodexImports(file: string): Set<string> {
  const out = new Set<string>();
  try { for (const m of fs.readFileSync(file, 'utf8').matchAll(UUID)) out.add(m[0].toLowerCase()); } catch { /* absent */ }
  return out;
}

/** potsherd's rescue archive: content-addressed raw copies of sessions (archive/evidence/<sha256>.jsonl). */
export function archiveEvidenceDir(options: AuditOverviewOptions): string | null {
  if (process.env['SLOPIE_AUDIT_ARCHIVE'] === '0') return null;
  const dir = path.join(paths.potsherdDir(options.potsherdDir), 'archive', 'evidence');
  return fs.existsSync(dir) ? dir : null;
}

export const isZstdName = (f: string) => f.endsWith('.jsonl.zst');
/** Probes a file (cached by path, size and mtime); `known` is the harness of a live root. */
export type ProbeOf = (file: string, size: number, mtimeMs: number, known: NativeHarness | null) => Probe | null;
const directProbe: ProbeOf = (file, _size, _mtime, known) => probeFile(file, known);

export function discover(harnesses: readonly AuditHarness[], options: AuditOverviewOptions, onHarness?: (harness: AuditHarness, row: {files: number; bytes: number}) => void, probeOf: ProbeOf = directProbe): Discovered {
  const result: Discovered = {jobs: [], opencodeDatabases: [], opencodeJson: [], historyFiles: [], codexImported: new Set(), statsFiles: [], census: new Map(), zstdUnsupported: 0, adapters: new Map(), unclassified: 0};
  const seen = new Set<string>();
  const zstd = zstdSupport() !== null;
  // Archive copies are classified first so each harness row's census includes them.
  const archive: {file: string; harness: NativeHarness | 'auto'; size: number; mtimeMs: number}[] = [];
  const evidence = archiveEvidenceDir(options);
  if (evidence) {
    for (const file of listFiles(evidence, f => f.endsWith('.jsonl') || isZstdName(f))) {
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      const probe = probeOf(file, stat.size, stat.mtimeMs, null);
      if (probe?.harness) archive.push({file, harness: probe.harness, size: stat.size, mtimeMs: stat.mtimeMs});
      // Archived typed-prompt log lines are not transcripts (Claude's history.jsonl is read as such); anything else is a visible gap.
      else if (!probe?.history) result.unclassified++;
    }
  }
  for (const harness of harnesses) {
    if (harness === 'antigravity') {
      // Read after discovery (adapter-facts.ts antigravityFacts): only stats here.
      const row = {...antigravityCensus(options), roots: 1};
      result.census.set(harness, row);
      onHarness?.(harness, row);
      continue;
    }
    if ((ADAPTER_HARNESSES as readonly string[]).includes(harness)) {
      const list = discoverAdapter(harness as AdapterHarness, options);
      result.adapters.set(harness as AdapterHarness, list);
      const row = {files: list.length, bytes: list.reduce((n, x) => n + x.bytes, 0), roots: 1};
      result.census.set(harness, row);
      onHarness?.(harness, row);
      continue;
    }
    const desktop = harness === 'claude' ? claudeDesktopRoots(options) : [];
    const roots = [...nativeAuditRoots(harness, options), ...desktop];
    const row = {files: 0, bytes: 0, roots: roots.length + (evidence ? 1 : 0)};
    result.census.set(harness, row);
    for (const root of roots) {
      if (harness === 'opencode') {
        for (const file of listFiles(root, f => /\.(?:db|sqlite|sqlite3)$/i.test(f) || (f.endsWith('.json') && /[\\/]storage[\\/](?:session|message|part)[\\/]/.test(f)))) {
          let size = 0;
          try { size = fs.statSync(file).size; } catch { continue; }
          row.files++; row.bytes += size;
          (file.endsWith('.json') ? result.opencodeJson : result.opencodeDatabases).push(file);
        }
        continue;
      }
      if (harness === 'claude' && !desktop.includes(root)) {
        // Every Claude root keeps its own typed-prompt log.
        const history = path.join(path.dirname(root), 'history.jsonl');
        if (fs.existsSync(history) && !result.historyFiles.includes(history)) result.historyFiles.push(history);
        const stats = path.join(path.dirname(root), 'stats-cache.json');
        if (fs.existsSync(stats) && !result.statsFiles.includes(stats)) result.statsFiles.push(stats);
      }
      if (harness === 'codex') for (const f of readCodexImports(path.join(path.dirname(root), 'external_agent_session_imports.json'))) result.codexImported.add(f);
      // Codex: sessions/ and archived_sessions/ copies (and compressed .jsonl.zst rollouts) are all read;
      // aggregation counts each session once by its native identity, keeping the most complete copy.
      for (const file of listFiles(root, f => harness === 'codex' ? path.basename(f).startsWith('rollout-') && (f.endsWith('.jsonl') || isZstdName(f)) : f.endsWith('.jsonl'))) {
        if (seen.has(file)) continue;
        seen.add(file);
        let stat: fs.Stats;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.isFile()) continue;
        if (isZstdName(file) && !zstd) { result.zstdUnsupported++; continue; }
        row.files++; row.bytes += stat.size;
        result.jobs.push({file, harness: harness as NativeHarness, size: stat.size, mtimeMs: stat.mtimeMs} as ScanJob & {mtimeMs: number});
      }
    }
    for (const a of archive) {
      // Compressed archive copies can only be Codex rollouts; extraction verifies from the content.
      if ((a.harness === 'auto' ? 'codex' : a.harness) !== harness || seen.has(a.file)) continue;
      seen.add(a.file);
      if (a.harness === 'auto' && !zstd) { result.zstdUnsupported++; continue; }
      row.files++; row.bytes += a.size;
      result.jobs.push({file: a.file, harness: a.harness, size: a.size, mtimeMs: a.mtimeMs, archive: true} as ScanJob & {mtimeMs: number});
    }
    onHarness?.(harness, row);
  }
  return result;
}

