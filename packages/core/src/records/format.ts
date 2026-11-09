/**
 * The record format (R5 §11.1), exactly as the evaluated exporter wrote it (memory-lab `lab/export.py`):
 *
 *   ## session claude:<id>
 *   ## project: /path
 *   ## title: ...
 *   ## time: <start> -> <end>   turns: N
 *   ## parent: subagent of <id> | fork of <id> | none
 *   ## children: <id> (<kind>), ... | none
 *   ## raw: <path> | <path>
 *   t1 USER 2026-10-01 09:12 | first line
 *   t1 | continuation line
 *   t3 TOOL Bash 09:13 | command
 *   t3 > output line
 *
 * Tool output is capped at 500 head + 300 tail characters with a `full output: <raw path>:<line>` pointer.
 */
import type {Role, Session, Turn} from '../sources/sessions.js';
import {cpLen, cpSlice, pySplitlines, pyStrip, squash} from '../sources/text.js';

export const CAP = {USER: 6000, ASSISTANT: 8000, SYSTEM: 300, TOOL_IN: 600, TOOL_OUT_HEAD: 500, TOOL_OUT_TAIL: 300} as const;
/** Per-output cap of the optional full-output sidecar (`<record>.out.txt`). */
export const SIDECAR_CAP = 20000;
export const ARCHIVE_MARK = '/.potsherd/archive/';
export const INDEX_HEADER = 'harness\tid\tproject\tstart\tend\tturns\tparent\ttitle\tfirst_user_msg\tfile';

/** One turn as the record shows it: every cap and pointer already applied. */
export interface RecTurn {
  role: Role;
  ts: string | null;
  tool?: string;
  /** USER/ASSISTANT/SYSTEM text, or the TOOL input. */
  text: string;
  /** TOOL output as shown (head + cut note + tail), or null. */
  out?: string | null;
  /** Sidecar text: the output up to SIDECAR_CAP, only when the record had to cut it. */
  full?: string;
}

export interface RecSession {
  harness: Session['harness'];
  id: string;
  project: string | null;
  title: string | null;
  start: string | null;
  end: string | null;
  parent: string | null;
  parentKind: string | null;
  turns: RecTurn[];
}

const capOf = (role: Role): number => (role === 'USER' ? CAP.USER : role === 'ASSISTANT' ? CAP.ASSISTANT : role === 'SYSTEM' ? CAP.SYSTEM : 6000);

/** Applies the record caps to one parsed turn. `sidecar` keeps up to SIDECAR_CAP of a cut output. */
export function recTurn(t: Turn, sidecar = false): RecTurn {
  if (t.role === 'TOOL') {
    let inp = pyStrip(t.text || '');
    const inLen = cpLen(inp);
    if (inLen > CAP.TOOL_IN) inp = cpSlice(inp, 0, CAP.TOOL_IN) + ` …[+${inLen - CAP.TOOL_IN} chars]`;
    const r: RecTurn = {role: 'TOOL', ts: t.ts, tool: t.tool ?? '', text: inp, out: null};
    if (t.output) {
      let o = pyStrip(t.output);
      const total = t.outputLen ?? cpLen(o);
      if (total > CAP.TOOL_OUT_HEAD + CAP.TOOL_OUT_TAIL) {
        if (sidecar) { const n = cpLen(o); r.full = n > SIDECAR_CAP ? cpSlice(o, 0, SIDECAR_CAP) + ` …[+${n - SIDECAR_CAP} chars]` : o; }
        o = cpSlice(o, 0, CAP.TOOL_OUT_HEAD) + `\n…[${total - CAP.TOOL_OUT_HEAD - CAP.TOOL_OUT_TAIL} chars cut; full output: ${t.outRef ?? t.ref}]…\n` + cpSlice(o, -CAP.TOOL_OUT_TAIL);
      }
      r.out = o;
    }
    return r;
  }
  let text = pyStrip(t.text || '');
  const cap = capOf(t.role);
  const n = cpLen(text);
  if (n > cap) text = cpSlice(text, 0, cap) + ` …[+${(t.textLen ?? n) - cap} chars; raw: ${t.ref}]`;
  return {role: t.role, ts: t.ts, text};
}

export function recSession(s: Session, sidecar = false): RecSession {
  return {harness: s.harness, id: s.id, project: s.project, title: s.title, start: s.start, end: s.end, parent: s.parent, parentKind: s.parentKind,
    turns: s.turns.map(t => recTurn(t, sidecar))};
}

export const fmtTs = (ts: string | null): string => (ts ? ts.replace('T', ' ').slice(0, 16) : '?');

/** Searchable / readable text of one turn (same caps as the record). */
export function turnBody(t: RecTurn): string {
  if (t.role === 'TOOL') return t.text + (t.out ? '\n→ ' + t.out : '');
  return t.text;
}

export interface Header {
  children: readonly {id: string; kind: string}[];
  sources: readonly string[];
  archiveOnly: boolean;
}

/** The record file's text. */
export function render(s: RecSession, h: Header): string {
  const out: string[] = [];
  let kids = h.children.slice(0, 50).map(c => `${c.id} (${c.kind})`).join(', ');
  if (h.children.length > 50) kids += `, … +${h.children.length - 50} more`;
  out.push(`## session ${s.harness}:${s.id}`);
  out.push(`## project: ${s.project || '?'}`);
  out.push(`## title: ${s.title || ''}`);
  out.push(`## time: ${s.start || '?'} -> ${s.end || '?'}   turns: ${s.turns.length}`);
  out.push(`## parent: ${s.parent ? `${s.parentKind ?? 'None'} of ${s.parent}` : 'none'}`);
  out.push(`## children: ${kids || 'none'}`);
  out.push(`## raw: ${h.sources.join(' | ')}` + (h.archiveOnly ? '   [deleted from harness; recovered from .potsherd archive]' : ''));
  s.turns.forEach((t, i) => {
    const tag = `t${i + 1}`;
    if (t.role === 'TOOL') {
      const lines = pySplitlines(t.text);
      if (!lines.length) lines.push('');
      out.push(`${tag} TOOL ${t.tool ?? ''} ${fmtTs(t.ts).slice(11)} | ${lines[0]}`);
      for (const l of lines.slice(1)) out.push(`${tag} | ${l}`);
      if (t.out) for (const l of pySplitlines(t.out)) out.push(`${tag} > ${l}`);
      return;
    }
    const lines = pySplitlines(t.text);
    if (!lines.length) lines.push('');
    out.push(`${tag} ${t.role} ${fmtTs(t.ts)} | ${lines[0]}`);
    for (const l of lines.slice(1)) out.push(`${tag} | ${l}`);
  });
  return out.join('\n') + '\n';
}

/** The optional sidecar: every cut tool output up to SIDECAR_CAP, tagged like the record. Null when nothing was cut. */
export function renderSidecar(s: RecSession, recordName: string): string | null {
  const out: string[] = [];
  s.turns.forEach((t, i) => {
    if (!t.full) return;
    out.push(`t${i + 1} TOOL ${t.tool ?? ''} ${fmtTs(t.ts)} | full output (record: ${recordName})`);
    for (const l of pySplitlines(t.full)) out.push(`t${i + 1} > ${l}`);
  });
  return out.length ? out.join('\n') + '\n' : null;
}

export function firstUser(s: RecSession | {turns: readonly {role: Role; text: string}[]}): string {
  for (const t of s.turns) if (t.role === 'USER') return cpSlice(squash(t.text), 0, 140);
  return '';
}

export function lastAssistant(s: {turns: readonly {role: Role; text: string}[]}): string {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const t = s.turns[i]!;
    if (t.role === 'ASSISTANT') return cpSlice(squash(t.text), -200);
  }
  return '';
}

/** Directory name for a project path. */
export function slug(project: string | null): string {
  if (!project) return '_unknown';
  return cpSlice(project.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, ''), 0, 120) || '_root';
}

/** File-name id: Claude subagents carry their parent (`<parent>__agent-<id>`). */
export function sidFile(harness: string, id: string, parent: string | null, parentKind: string | null): string {
  return harness === 'claude' && parentKind === 'subagent' ? `${parent ?? 'None'}__${id}` : id;
}

export function recordRelPath(s: {harness: string; project: string | null; start: string | null; id: string; parent: string | null; parentKind: string | null}): string {
  return `${s.harness}/${slug(s.project)}/${(s.start || '0000-00-00').slice(0, 10)}_${sidFile(s.harness, s.id, s.parent, s.parentKind)}.txt`;
}

export function indexLine(s: RecSession, rel: string): string {
  const par = s.parent ? `${s.parentKind ?? 'None'}:${s.parent}` : '';
  const title = cpSlice((s.title || '').replace(/\t/g, ' ').replace(/\n/g, ' '), 0, 100);
  return [s.harness, s.id, s.project || '', s.start || '', s.end || '', String(s.turns.length), par, title, firstUser(s).replace(/\t/g, ' '), rel].join('\t');
}
