/**
 * Delegation edges (R7): a thread that dispatches work to another thread through a `delegate_task` tool (T3 Code
 * orchestration) and the thread that did the work are separate sessions with no parent link in the harness files.
 * The dispatched thread's first prompt is "Act as the <role> sub-agent for this task." followed by the exact `task`
 * text of the call, so both sides hash that text and sync links them: the worker gets `parent: delegated by <id>`
 * and the dispatcher lists it under its children. Hashes are computed from the full parsed session (the record
 * caps tool inputs at 600 characters).
 */
import {createHash} from 'node:crypto';
import type {Session} from '../sources/sessions.js';

const PREFIX = /^\s*Act as the [\w -]{1,40}? sub-agent for this task\.\s*/i;
/** How many leading USER turns may carry the dispatched prompt (Codex puts AGENTS.md first). */
const FIRST_USERS = 3;

export interface Deleg {
  /** Hash of the task text this session was dispatched with. */
  task?: string;
  /** Hash, timestamp and title of every task this session dispatched. */
  calls?: [string, string | null, string | null][];
}

export function delegKey(task: string): string {
  return createHash('sha1').update(task.replace(/\s+/g, ' ').trim().slice(0, 400)).digest('hex').slice(0, 16);
}

function field(input: string, name: 'task' | 'title'): string | null {
  try {
    const j = JSON.parse(input) as unknown;
    if (j && typeof j === 'object' && typeof (j as Record<string, unknown>)[name] === 'string') return (j as Record<string, string>)[name]!;
  } catch { /* fall through: a truncated input still starts with its fields */ }
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
}

export function delegOf(s: Pick<Session, 'turns'>): Deleg | undefined {
  const d: Deleg = {};
  let users = 0;
  for (const t of s.turns) {
    if (t.role === 'USER' && users < FIRST_USERS) {
      users++;
      if (!d.task && PREFIX.test(t.text)) d.task = delegKey(t.text.replace(PREFIX, ''));
    } else if (t.role === 'TOOL' && /delegate_task$/.test(t.tool ?? '')) {
      const task = field(t.text, 'task');
      if (task) (d.calls ??= []).push([delegKey(task), t.ts, field(t.text, 'title')]);
    }
  }
  return d.task || d.calls ? d : undefined;
}

/**
 * Picks the dispatcher of each dispatched session: among the calls with its task hash (other sessions only), the
 * latest one at or before its start, else the earliest. Returns child id -> dispatcher id.
 */
export function delegEdges(sessions: readonly {id: string; start: string | null; parent: string | null; deleg?: Deleg}[]): Map<string, string> {
  const calls = new Map<string, {id: string; ts: string}[]>();
  for (const s of sessions) for (const [k, ts] of s.deleg?.calls ?? []) {
    const l = calls.get(k) ?? [];
    l.push({id: s.id, ts: ts ?? s.start ?? ''});
    calls.set(k, l);
  }
  const out = new Map<string, string>();
  for (const s of sessions) {
    if (s.parent || !s.deleg?.task) continue;
    const c = (calls.get(s.deleg.task) ?? []).filter(x => x.id !== s.id);
    if (!c.length) continue;
    const st = s.start ?? '';
    const cmp = (a: {id: string; ts: string}, b: {id: string; ts: string}) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const before = c.filter(x => x.ts <= st).sort(cmp);
    out.set(s.id, (before.length ? before[before.length - 1]! : c.sort(cmp)[0]!).id);
  }
  return out;
}

/** A dispatched thread as its dispatcher's relay turns name it: "Delegated task <node> (<title>) [completed]: …". */
export interface Relay { title: string; child: string; harness: string; start: string }

/** dispatcher id -> the titled tasks it dispatched and the thread that did each (from the edges). */
export function relayLinks(sessions: readonly {id: string; harness: string; start: string | null; deleg?: Deleg}[], edges: ReadonlyMap<string, string>): Map<string, Relay[]> {
  const byHash = new Map<string, {id: string; harness: string; start: string}[]>();
  for (const s of sessions) if (s.deleg?.task && edges.has(s.id)) {
    const l = byHash.get(s.deleg.task) ?? [];
    l.push({id: s.id, harness: s.harness, start: s.start ?? ''});
    byHash.set(s.deleg.task, l);
  }
  const out = new Map<string, Relay[]>();
  for (const s of sessions) for (const [k, , title] of s.deleg?.calls ?? []) {
    if (!title) continue;
    for (const c of byHash.get(k) ?? []) {
      if (edges.get(c.id) !== s.id) continue;
      const l = out.get(s.id) ?? [];
      if (!l.some(x => x.child === c.id && x.title === title)) l.push({title, child: c.id, harness: c.harness, start: c.start});
      out.set(s.id, l);
    }
  }
  return out;
}

const RELAY = /^Delegated task \S+ \((.*)\) \[[a-z_ -]+\]/;

/** The relay turn's first line, with the thread that did the work appended (latest such thread started by then). */
export function annotateRelay(text: string, ts: string | null, relays: readonly Relay[]): string {
  const m = RELAY.exec(text);
  if (!m) return text;
  const c = relays.filter(r => r.title === m[1] && (!ts || r.start <= ts)).sort((a, b) => (a.start < b.start ? 1 : -1))[0];
  if (!c) return text;
  const nl = text.indexOf('\n');
  const tag = ` [from delegated thread ${c.child} (${c.harness})]`;
  return nl < 0 ? text + tag : text.slice(0, nl) + tag + text.slice(nl);
}
