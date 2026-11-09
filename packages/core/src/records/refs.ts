/**
 * Backlinks (R7): when a session's user or assistant names another session by id (a full UUID or its first 8 hex
 * characters, e.g. "continue Codex thread aaaa1111"), the earlier session's record says so ("## mentioned later in:"),
 * at its top and at its end, where agents look for the final word. Tool output is ignored (ids there are mostly noise).
 * Only prefixes that name exactly one session, and only mentions from sessions that started later, become links.
 */
import type {Session} from '../sources/sessions.js';

const ID = /(?<![0-9a-f])([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9a-f])/gi;
const MAX_REFS = 300;

/** The distinct 8-hex id prefixes named in USER/ASSISTANT text, lowercased. */
export function refsOf(s: Pick<Session, 'turns'>): string[] | undefined {
  const out = new Set<string>();
  for (const t of s.turns) {
    if (t.role !== 'USER' && t.role !== 'ASSISTANT') continue;
    for (const m of t.text.matchAll(ID)) {
      out.add(m[1]!.toLowerCase());
      if (out.size >= MAX_REFS) return [...out];
    }
  }
  return out.size ? [...out] : undefined;
}

export interface Later { id: string; harness: string; start: string }

/** target id -> the later sessions that name it, newest first (at most `cap`). */
export function backlinks(sessions: readonly {id: string; harness: string; start: string | null; parentKind: string | null; refs?: readonly string[]}[], cap = 10): Map<string, Later[]> {
  const byPrefix = new Map<string, {id: string; start: string | null} | null>();
  for (const s of sessions) {
    if (s.id.startsWith('agent-')) continue;
    const k = s.id.slice(0, 8).toLowerCase();
    byPrefix.set(k, byPrefix.has(k) ? null : {id: s.id, start: s.start});
  }
  const out = new Map<string, Later[]>();
  for (const s of sessions) {
    if (!s.refs || !s.start) continue;
    for (const r of s.refs) {
      const t = byPrefix.get(r);
      if (!t || t.id === s.id || !t.start || !(t.start < s.start)) continue;
      const l = out.get(t.id) ?? [];
      if (!l.some(x => x.id === s.id)) l.push({id: s.id, harness: s.harness, start: s.start});
      out.set(t.id, l);
    }
  }
  for (const [k, l] of out) out.set(k, l.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : a.id < b.id ? -1 : 1)).slice(0, cap));
  return out;
}

