/**
 * Antigravity records: one per conversation, built from what can be read (adapters/antigravity.ts). The
 * prompts are encrypted on disk, so a record holds the agent's messages (`notify_user` → ASSISTANT), task
 * boundaries (SYSTEM "task: <name> · <status>") and one TOOL `artifact` turn per brain artifact (its latest
 * `.resolved` content, capped like tool output). Every string goes through the record scrub (redaction).
 */
import {isoTs, type Turn} from '../sources/sessions.js';
import {cpLen} from '../sources/text.js';
import {loadAntigravity, type AgSession, type AntigravityOptions} from '../adapters/antigravity.js';
import {recTurn, type RecSession} from './format.js';
import {scrub} from './scrub.js';

export interface AgRecord {
  rec: RecSession;
  sources: string[];
}

export function agRecord(s: AgSession, sidecar = false): AgRecord {
  const ref = s.state ?? s.brain ?? s.pb ?? 'antigravity';
  const rows: {at: number | null; turn: Turn}[] = [];
  for (const st of s.steps) {
    const ts = st.at === null ? null : isoTs(st.at);
    if (st.tool === 'notify_user' && st.message) rows.push({at: st.at, turn: {role: 'ASSISTANT', ts, text: st.message, textLen: cpLen(st.message), ref}});
    else if (st.tool === 'task_boundary') {
      const text = `task: ${st.taskName ?? '?'} · ${st.taskStatus ?? '?'}${st.mode ? ` (${st.mode})` : ''}`;
      rows.push({at: st.at, turn: {role: 'SYSTEM', ts, text, ref}});
    }
  }
  for (const a of s.artifacts) {
    const head = [a.name, a.summary ? `summary: ${a.summary}` : null, a.updatedAt !== null ? `updated ${isoTs(a.updatedAt)}` : null, `file: ${a.file}`].filter(Boolean).join(' · ');
    rows.push({at: a.updatedAt, turn: {role: 'TOOL', tool: 'artifact', ts: a.updatedAt === null ? null : isoTs(a.updatedAt), text: head, output: a.text || null, outputLen: a.text ? cpLen(a.text) : 0, ref: a.file, outRef: a.file}});
  }
  // Time order; undated turns keep their place after the dated ones.
  const order = rows.map((r, i) => ({r, i})).sort((x, y) => (x.r.at ?? Infinity) - (y.r.at ?? Infinity) || x.i - y.i);
  const start = s.times.length ? isoTs(s.times[0]!) : null;
  const end = s.times.length ? isoTs(s.times[s.times.length - 1]!) : null;
  const rec: RecSession = {harness: 'antigravity', id: s.id, project: s.project, title: scrub(s.title), start, end, parent: null, parentKind: null,
    turns: order.map(x => recTurn(x.r.turn, sidecar))};
  return {rec, sources: [s.pb, s.brain, s.state].filter((x): x is string => !!x)};
}

/** Every Antigravity conversation as a record (gaps are reported by the caller). */
export function agRecords(o: AntigravityOptions = {}, sidecar = false): {records: AgRecord[]; gaps: string[]} {
  const data = loadAntigravity({...o, artifactText: true});
  return {records: data.sessions.filter(s => s.times.length || s.steps.length || s.artifacts.length).map(s => agRecord(s, sidecar)), gaps: data.gaps};
}
