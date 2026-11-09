/**
 * Secrets never reach an agent: every string that enters a record, the index, a card, a sidecar or a raw
 * re-read passes through `scrub` first. Binary bulk (base64 images, data URIs) is elided, then the shared
 * redaction rules mask credentials. Records show the mask as `[REDACTED:<type>]` (the variable name stays:
 * `TAVILY_API_KEY=[REDACTED:tavily]`).
 *
 * Idempotent: existing record masks are turned back into the redaction module's protected form before the
 * rules run, so `scrub(scrub(x)) === scrub(x)`.
 */
import {elideBinary} from '../redact-elide.js';
import {redactText} from '../redact.js';
import type {RecSession, RecTurn} from './format.js';

/** Bump when the rules change: the next sync re-redacts every record (retained ones included) and rebuilds the index. */
export const REDACT_VERSION = 1;

const REC_MASK = /\[REDACTED:([a-z-]+)\]/g;
const MOD_MASK = /‹redacted:([a-z-]+):[0-9a-f]{8}›/g;

export function scrub(s: string): string;
export function scrub(s: string | null): string | null;
export function scrub(s: string | null | undefined): string | null | undefined;
export function scrub(s: string | null | undefined): string | null | undefined {
  if (!s) return s;
  const pre = s.includes('[REDACTED:') ? s.replace(REC_MASK, '‹redacted:$1:00000000›') : s;
  const out = redactText(elideBinary(pre));
  return out.includes('‹redacted:') ? out.replace(MOD_MASK, '[REDACTED:$1]') : out;
}

export function scrubTurn<T extends {text: string; out?: string | null; full?: string; output?: string | null}>(t: T): T {
  const r = {...t, text: scrub(t.text)};
  if (t.out) r.out = scrub(t.out);
  if (t.full) r.full = scrub(t.full);
  if (t.output) r.output = scrub(t.output);
  return r;
}

/** The record with every string scrubbed; turn order and count unchanged. */
export function scrubRec(s: RecSession): RecSession {
  return {...s, title: scrub(s.title), project: s.project, turns: s.turns.map(t => scrubTurn<RecTurn>(t))};
}
