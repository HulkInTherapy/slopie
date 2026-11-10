/**
 * Cursor, Gemini CLI and Copilot CLI in the audit, through their L0 adapters.
 *
 * What can be read honestly: typed prompts (with the adapter's timestamps) and
 * conversations. None of these local formats records per-request token usage
 * the audit can price, so they contribute no usage at all: their cost is
 * unknown (source `usage: 'unavailable'`, gap `usage_not_recorded`), never $0.
 */
import fs from 'node:fs';
import * as cursor from '../adapters/cursor.js';
import * as gemini from '../adapters/gemini.js';
import * as copilot from '../adapters/copilot.js';
import type {SessionSource} from '../adapters/types.js';
import {classifyText, FACTS_VERSION, finishExternalFacts, stripText, time, type SourceFacts} from './extract.js';
import type {AuditOverviewOptions} from './contracts.js';
import type {FactsCache} from './facts-cache.js';
import {antigravityPresent, loadAntigravity} from '../adapters/antigravity.js';
import * as paths from '../paths.js';

export type AdapterHarness = 'cursor' | 'gemini' | 'copilot';
export const ADAPTER_HARNESSES: readonly AdapterHarness[] = ['cursor', 'gemini', 'copilot'];

const ADAPTERS = {cursor, gemini, copilot} as const;
const OPTION: Record<AdapterHarness, 'cursorDir' | 'geminiDir' | 'copilotDir'> = {cursor: 'cursorDir', gemini: 'geminiDir', copilot: 'copilotDir'};

/**
 * Sources of one adapter harness. Explicit inputs never fall through into
 * personal roots: when any native source directory is given explicitly and
 * this one is not, the harness is treated as absent.
 */
export function discoverAdapter(harness: AdapterHarness, options: AuditOverviewOptions): SessionSource[] {
  const override = options[OPTION[harness]];
  const explicit = options.claudeDir ?? options.codexDir ?? options.piDir ?? options.opencodeDir;
  if (!override && explicit) return [];
  try { return ADAPTERS[harness].discover(override); } catch { return []; }
}

/** Parses one adapter source into audit facts (prompts only; no usage). */
export async function adapterFacts(harness: AdapterHarness, source: SessionSource, timezone: string): Promise<SourceFacts> {
  const parsed = await ADAPTERS[harness].parse(source);
  const s = parsed.session;
  const facts: SourceFacts = {
    v: FACTS_VERSION, harness, file: source.path, size: source.bytes, mtimeMs: source.mtimeMs,
    sessionId: s.id || source.sessionId, parentId: source.isSidechain ? source.parentSessionId ?? null : null, child: source.isSidechain,
    project: s.project || null, title: s.title ?? null, automated: false, excluded: false, startedAt: s.startedAt || null,
    firstAt: null, lastAt: null, usage: [], prompts: [], malformed: 0,
  };
  const touch = (at: number | null) => { if (at === null) return; if (facts.firstAt === null || at < facts.firstAt) facts.firstAt = at; if (facts.lastAt === null || at > facts.lastAt) facts.lastAt = at; };
  for (const e of parsed.exchanges) {
    const at = time(e.ts);
    const c = classifyText(e.userText ?? '');
    const kind = source.isSidechain || e.isSidechain ? 'excluded' : c.kind;
    facts.prompts.push({key: `${harness}:${e.id}`, at, project: facts.project, kind, reason: kind === 'excluded' && c.kind === 'human' ? 'subagent_parent_written' : c.reason,
      text: kind === 'human' ? c.text : '', before: s.model ?? null, beforeProvider: null, after: s.model ?? null, afterProvider: null});
    touch(at);
  }
  return stripText(finishExternalFacts(facts, {timezone}));
}

/** Facts-cache key of an adapter source: several sessions can live in one file (Cursor's databases). */
export const adapterKey = (source: SessionSource): string => `adapter:${source.harness}:${source.path}#${source.sessionId}`;

/**
 * All sources of the requested adapter harnesses; unreadable files become failure codes. With a
 * cache, a source is parsed again only when its size or mtime changed.
 */
export async function readAdapterSources(harnesses: readonly AdapterHarness[], discovered: ReadonlyMap<AdapterHarness, SessionSource[]>, timezone: string, failures: string[], cache?: FactsCache, stats = {parsed: 0}): Promise<SourceFacts[]> {
  const out: SourceFacts[] = [];
  const parse = (h: AdapterHarness, source: SessionSource) => { stats.parsed++; return adapterFacts(h, source, timezone); };
  for (const h of harnesses) for (const source of discovered.get(h) ?? []) {
    try {
      if (!fs.existsSync(source.path)) continue;
      out.push(await (cache ? cache.external(adapterKey(source), source.bytes, source.mtimeMs, timezone, () => parse(h, source)) : parse(h, source)));
    } catch { failures.push(`${h}_source_unreadable`); }
  }
  return out;
}

/* ------------------------------------------------------------ Antigravity --- */

/** Antigravity is read only when its directory was given or no native source directory was given explicitly. */
export function antigravityWanted(options: AuditOverviewOptions): boolean {
  const explicit = options.claudeDir ?? options.codexDir ?? options.piDir ?? options.opencodeDir ?? options.cursorDir ?? options.geminiDir ?? options.copilotDir;
  if (!options.antigravityDir && explicit) return false;
  return antigravityPresent({dir: options.antigravityDir, stateDb: options.antigravityStateDb});
}

/** Census of Antigravity's inputs (stats only). */
export function antigravityCensus(options: AuditOverviewOptions): {files: number; bytes: number} {
  if (!antigravityWanted(options)) return {files: 0, bytes: 0};
  let files = 0, bytes = 0;
  const dir = paths.antigravityDir(options.antigravityDir);
  try {
    for (const n of fs.readdirSync(`${dir}/conversations`)) if (n.endsWith('.pb')) { files++; try { bytes += fs.statSync(`${dir}/conversations/${n}`).size; } catch { /* raced */ } }
  } catch { /* none */ }
  try { const st = fs.statSync(paths.antigravityStateDb(options.antigravityStateDb)); files++; bytes += st.size; } catch { /* none */ }
  return {files, bytes};
}

/**
 * One facts row per Antigravity conversation: no prompts (they are encrypted on disk) and no usage, only
 * the conversation's times (state timestamps, artifact updatedAt, transcript file times), title and project.
 */
export function antigravityFacts(options: AuditOverviewOptions, timezone: string, failures: string[]): SourceFacts[] {
  if (!antigravityWanted(options)) return [];
  const data = loadAntigravity({dir: options.antigravityDir, stateDb: options.antigravityStateDb});
  failures.push(...data.gaps);
  return data.sessions.filter(s => s.times.length).map(s => {
    const file = s.pb ?? s.brain ?? `${s.state ?? 'antigravity'}#${s.id}`;
    const facts: SourceFacts = {
      v: FACTS_VERSION, harness: 'antigravity', file, size: 0, mtimeMs: s.times[s.times.length - 1]!, sessionId: s.id, parentId: null, child: false,
      project: s.project, title: s.title, automated: false, excluded: false, startedAt: new Date(s.times[0]!).toISOString(),
      firstAt: s.times[0]!, lastAt: s.times[s.times.length - 1]!, activity: [...s.times], usage: [], prompts: [], malformed: 0,
    };
    return finishExternalFacts(facts, {timezone});
  });
}
