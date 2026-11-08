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

/** All sources of the requested adapter harnesses; unreadable files become failure codes. */
export async function readAdapterSources(harnesses: readonly AdapterHarness[], discovered: ReadonlyMap<AdapterHarness, SessionSource[]>, timezone: string, failures: string[]): Promise<SourceFacts[]> {
  const out: SourceFacts[] = [];
  for (const h of harnesses) for (const source of discovered.get(h) ?? []) {
    try { if (fs.existsSync(source.path)) out.push(await adapterFacts(h, source, timezone)); } catch { failures.push(`${h}_source_unreadable`); }
  }
  return out;
}
