/**
 * The normalised session stream: one native transcript file -> one session with turns tagged
 * USER / ASSISTANT / TOOL / SYSTEM, each with its timestamp and raw `path:line`.
 *
 * A TypeScript port of the reference reader that produced the evaluated records
 * (memory-lab `lab/raw.py`, R5 §11.1). Rules:
 *   - Claude: user text = USER; injected wrappers / meta / compact summaries = SYSTEM; assistant text =
 *     ASSISTANT; tool_use + its tool_result = one TOOL turn. Thinking dropped.
 *   - Codex: response_item messages; developer and injected user preambles dropped or SYSTEM; function /
 *     custom tool calls + outputs = TOOL; reasoning dropped; event_msg copies ignored unless the file has no
 *     response_item user messages (older format).
 *   - Fork / subagent rollouts: the copied parent prefix (a leading timestamp burst) is skipped.
 *   - Fields are capped at parse time (bounded memory); the original length is kept beside them.
 */
import path from 'node:path';
import {forEachRecord, headOf} from './lines.js';
import {cpLen, cpSlice, pyDumps, pyStr, pyStrip} from './text.js';

export type Harness = 'claude' | 'codex' | 'pi';
export type Role = 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';

export interface Turn {
  role: Role;
  ts: string | null;
  text: string;
  textLen?: number;
  tool?: string;
  output?: string | null;
  outputLen?: number;
  /** `path:line` of the record the turn came from. */
  ref: string;
  /** `path:line` of the tool output record. */
  outRef?: string;
  mid?: string | null;
}

export interface Session {
  harness: Harness;
  id: string;
  project: string | null;
  title: string | null;
  start: string | null;
  end: string | null;
  parent: string | null;
  parentKind: string | null;
  sources: string[];
  turns: Turn[];
}

export interface ReadLimits {
  /** Text cap per turn (default 40000). */
  text?: number;
  /** Tool output cap per turn (default 6000). */
  output?: number;
}

export const TEXT_LIM = 40000;
export const OUT_LIM = 6000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Head 2/3 + tail 1/3 of an over-long field, original length remembered (Python `_put`). */
function put(t: Turn, key: 'text' | 'output', v: string | null | undefined, lim: number): Turn {
  const s = v ?? '';
  const n = cpLen(s);
  if (key === 'text') t.textLen = n; else t.outputLen = n;
  const capped = n <= lim ? s : cpSlice(s, 0, Math.floor(lim * 2 / 3)) + '\n[...]\n' + cpSlice(s, -Math.ceil(lim / 3));
  if (key === 'text') t.text = capped; else t.output = capped;
  return t;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Python `_ts`: epoch seconds/ms -> `YYYY-MM-DDTHH:MM:SSZ`; strings keep their first 19 characters + Z. */
export function isoTs(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    let x = v;
    if (x > 1e12) x = x / 1000;
    const d = new Date(Math.floor(x * 1000));
    if (Number.isNaN(d.getTime())) return null;
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  }
  if (typeof v === 'boolean') return isoTs(v ? 1 : 0);
  const s = String(v);
  return s.length >= 19 ? s.slice(0, 19) + 'Z' : s;
}

function epoch(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t / 1000 : null;
}

// ------------------------------------------------------------------ Claude
const INJECT_RE = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|command-args)/;

export function toolInputSummary(name: string, inp: unknown): string {
  if (!isRec(inp)) return pyStr(inp);
  if ((name === 'Bash' || name === 'bash') && 'command' in inp) return pyStr(inp['command']);
  if ((name === 'Read' || name === 'Write' || name === 'NotebookEdit') && 'file_path' in inp) {
    const extra = name === 'Write' ? '\n' + pyStr(inp['content'] ?? '') : '';
    return pyStr(inp['file_path']) + extra;
  }
  if ((name === 'Edit' || name === 'MultiEdit') && 'file_path' in inp) {
    if (name === 'Edit') return `${pyStr(inp['file_path'])}\n--- old\n${pyStr(inp['old_string'] ?? '')}\n+++ new\n${pyStr(inp['new_string'] ?? '')}`;
    return pyStr(inp['file_path']) + '\n' + pyDumps(inp['edits'] ?? []);
  }
  return pyDumps(inp);
}

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const out: string[] = [];
  for (const b of c) {
    if (isRec(b)) {
      const t = b['type'];
      if (t === 'text') out.push(str(b['text']) ?? '');
      else if (t === 'image') out.push('[image]');
      else if (t === 'tool_reference') out.push(`[tool_reference ${pyStr(b['tool_name'] ?? '')}]`);
    } else if (typeof b === 'string') out.push(b);
  }
  return out.join('\n');
}

const UUID_DIR = /^[0-9a-f-]{36}$/;

/** Parent session id of a Claude subagent transcript from its path (`<sid>/subagents/agent-x.jsonl`), else null. */
export function claudeSubagentParent(file: string): string | null | undefined {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('subagents');
  if (i < 0) return undefined;
  const parent = parts[i - 1] ?? '';
  return UUID_DIR.test(parent) ? parent : 'unknown-parent';
}

export function parseClaude(file: string, subParent: string | null = null, lim: ReadLimits = {}): Session {
  const TL = lim.text ?? TEXT_LIM, OL = lim.output ?? OUT_LIM;
  const s: Session = {harness: 'claude', id: '', project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: []};
  let aiTitle: string | null = null;
  let sub = subParent;
  if (sub) { s.parent = sub; s.parentKind = 'subagent'; s.id = path.basename(file, '.jsonl'); }
  const turns = s.turns;
  const pending = new Map<string, number>();
  const seen = new Set<string>();
  forEachRecord(file, (o, n) => {
    if (!isRec(o)) return;
    const typ = o['type'];
    if (typ === 'custom-title' && o['customTitle'] !== null && o['customTitle'] !== undefined) { s.title = str(o['customTitle']) || null; return; }
    if (typ === 'ai-title' && o['aiTitle']) { aiTitle = pyStr(o['aiTitle']); return; }
    if (typ === 'summary' && o['summary'] && !aiTitle) aiTitle = pyStr(o['summary']);
    if (typ !== 'user' && typ !== 'assistant') return;
    const u = str(o['uuid']);
    if (u) { if (seen.has(u)) return; seen.add(u); }
    if (!sub && !s.id && o['isSidechain'] && o['agentId'] && o['sessionId']) {
      sub = pyStr(o['sessionId']);
      s.parent = sub; s.parentKind = 'subagent'; s.id = 'agent-' + pyStr(o['agentId']);
    }
    if (!sub && o['sessionId'] && !s.id) s.id = pyStr(o['sessionId']);
    if (o['cwd'] && !s.project) s.project = pyStr(o['cwd']);
    const ts = isoTs(o['timestamp']);
    if (ts) { s.start = s.start || ts; s.end = ts; }
    const ref = `${file}:${n}`;
    const msg = isRec(o['message']) ? o['message'] : {};
    const content = msg['content'];
    if (typ === 'user') {
      if (Array.isArray(content) && content.some(b => isRec(b) && b['type'] === 'tool_result')) {
        for (const b of content) {
          if (!isRec(b) || b['type'] !== 'tool_result') continue;
          let out = blockText(b['content']);
          if (b['is_error']) out = '[error] ' + out;
          const key = str(b['tool_use_id']) ?? '';
          const i = pending.get(key);
          if (i !== undefined) {
            pending.delete(key);
            put(turns[i]!, 'output', out, OL);
            turns[i]!.outRef = ref;
          } else {
            turns.push(put({role: 'TOOL', ts, tool: 'result', text: '', ref}, 'output', out, OL));
          }
        }
        return;
      }
      let text = blockText(content);
      if (!pyStrip(text)) return;
      let role: Role = 'USER';
      const origin = o['origin'];
      const originKind = isRec(origin) ? origin['kind'] : origin === undefined || origin === null ? undefined : null;
      if (o['isMeta'] || o['isCompactSummary'] || INJECT_RE.test(text) || text.startsWith('[Request interrupted') || (originKind !== undefined && originKind !== null && originKind !== 'human')) role = 'SYSTEM';
      if (o['isCompactSummary']) text = '[compaction summary] ' + text;
      turns.push(put({role, ts, text: '', ref}, 'text', text, TL));
    } else {
      if (msg['model'] === '<synthetic>' && !content) return;
      const mid = str(msg['id']);
      const blocks = Array.isArray(content) ? content : [{type: 'text', text: content || ''}];
      for (const b of blocks) {
        if (!isRec(b)) continue;
        const t = b['type'];
        const bt = typeof b['text'] === 'string' ? (b['text'] as string) : '';
        if (t === 'text' && pyStrip(bt)) {
          const last = turns[turns.length - 1];
          if (last && last.role === 'ASSISTANT' && mid && last.mid === mid) {
            const n0 = last.textLen ?? cpLen(last.text);
            put(last, 'text', last.text + '\n' + bt, TL);
            last.textLen = n0 + 1 + cpLen(bt);
          } else {
            turns.push(put({role: 'ASSISTANT', ts, ref, mid, text: ''}, 'text', bt, TL));
          }
        } else if (t === 'tool_use' || t === 'server_tool_use') {
          const name = str(b['name']) ?? 'tool';
          turns.push(put({role: 'TOOL', ts, tool: name, output: null, ref, text: ''}, 'text', toolInputSummary(name, b['input']), TL));
          if (b['id']) pending.set(pyStr(b['id']), turns.length - 1);
        }
      }
    }
  });
  if (!s.id) s.id = path.basename(file, '.jsonl');
  s.title = s.title || aiTitle;
  for (const t of turns) delete t.mid;
  return s;
}

// ------------------------------------------------------------------ Codex
const CODEX_INJECT = /^\s*(<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|turn_aborted|user_shell_command|skill|subagent_notification|permissions)|# AGENTS\.md instructions|## My request for Codex:)/;
const DATA_URL = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{100,}/g;

function codexContentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const out: string[] = [];
  for (const b of c) {
    if (!isRec(b)) continue;
    const t = b['type'];
    if (t === 'input_text' || t === 'output_text' || t === 'text') out.push(str(b['text']) ?? '');
    else if (t === 'input_image' || t === 'image') out.push('[image]');
  }
  return out.join('\n');
}

function outText(o: unknown): string {
  if (typeof o === 'string') {
    try {
      const j = JSON.parse(o) as unknown;
      if (isRec(j) && 'output' in j) return pyStr(j['output']);
      if (Array.isArray(j)) return codexContentText(j);
    } catch { /* plain text */ }
    return o;
  }
  if (Array.isArray(o)) return codexContentText(o);
  if (isRec(o)) return pyStr(o['output'] ?? o['content'] ?? pyDumps(o).slice(0, 4000));
  return pyStr(o);
}

export function parseCodex(file: string, lim: ReadLimits = {}): Session | null {
  const TL = lim.text ?? TEXT_LIM, OL = lim.output ?? OUT_LIM;
  const s: Session = {harness: 'codex', id: '', project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: []};
  let hasRespUser = false;
  let ri = 0, prev: number | null = null, startI = 0, burstDone = false;
  forEachRecord(file, o => {
    if (!isRec(o)) return;
    const typ = o['type'];
    const p = isRec(o['payload']) ? o['payload'] : {};
    if (typ === 'session_meta') {
      if (!s.id) {
        s.id = str(p['id']) || str(p['session_id']) || '';
        s.project = str(p['cwd']);
        const src = p['source'];
        if (p['forked_from_id']) { s.parent = pyStr(p['forked_from_id']); s.parentKind = 'fork'; }
        else if (isRec(src) && isRec(src['subagent'])) {
          const sp = src['subagent']['thread_spawn'];
          if (isRec(sp) && sp['parent_thread_id']) { s.parent = pyStr(sp['parent_thread_id']); s.parentKind = 'subagent'; }
          else s.parentKind = 'subagent:' + Object.entries(src['subagent']).map(([k, v]) => `${k}=${pyStr(v)}`).join(',');
        }
        if (p['parent_thread_id'] && !s.parent) { s.parent = pyStr(p['parent_thread_id']); s.parentKind = 'subagent'; }
        if (isRec(p['history_base']) && !s.parent) {
          const tid = p['history_base']['thread_id'];
          s.parent = tid === undefined || tid === null ? null : pyStr(tid);
          s.parentKind = 'rewind';
        }
      }
      return;
    }
    if (typ === 'response_item' && p['type'] === 'message' && p['role'] === 'user') hasRespUser = true;
    if (!burstDone) {
      const e = epoch(isoTs(o['timestamp']) || '');
      if (prev !== null && e !== null && e - prev > 1.0) { startI = ri > 3 ? ri : 0; burstDone = true; }
      if (e !== null) prev = e;
    }
    ri++;
  });
  if (!s.id) return null;
  if (!(s.parent && (s.parentKind === 'fork' || s.parentKind === 'subagent'))) startI = 0;
  const turns = s.turns;
  const pending = new Map<string, number>();
  ri = -1;
  forEachRecord(file, (o, n) => {
    if (!isRec(o) || o['type'] === 'session_meta') return;
    ri++;
    if (ri < startI) return;
    const typ = o['type'];
    const p = isRec(o['payload']) ? o['payload'] : {};
    const ts = isoTs(o['timestamp']);
    const ref = `${file}:${n}`;
    if (ts && (typ === 'response_item' || typ === 'event_msg')) { s.start = s.start || ts; s.end = ts; }
    if (typ === 'response_item') {
      const pt = p['type'];
      if (pt === 'message') {
        const role = p['role'];
        const text = codexContentText(p['content']).replace(DATA_URL, '[image]');
        if (!pyStrip(text)) return;
        if (role === 'assistant') turns.push(put({role: 'ASSISTANT', ts, ref, text: ''}, 'text', text, TL));
        else if (role === 'user') {
          let meta: unknown = p['internal_chat_message_metadata_passthrough'] ?? {};
          if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
          const kinds = isRec(meta) ? meta['content_item_kinds'] : undefined;
          const known = kinds !== undefined && kinds !== null;
          const injected = (known && !(Array.isArray(kinds) ? kinds.includes('user.text') : typeof kinds === 'string' ? kinds.includes('user.text') : isRec(kinds) && 'user.text' in kinds)) || (!known && CODEX_INJECT.test(text));
          turns.push(put({role: injected ? 'SYSTEM' : 'USER', ts, ref, text: ''}, 'text', text, TL));
        }
      } else if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'local_shell_call' || pt === 'web_search_call' || pt === 'tool_search_call') {
        const name = str(p['name']) || pyStr(pt);
        let arg: unknown = pt === 'function_call' ? p['arguments'] : (p['input'] || p['action']);
        if (typeof arg === 'string') {
          try {
            const j = JSON.parse(arg) as unknown;
            if (isRec(j)) arg = j['cmd'] || j['command'] || j;
          } catch { /* keep the raw string */ }
        }
        if (Array.isArray(arg)) arg = arg.map(pyStr).join(' ');
        if (typeof arg !== 'string') arg = pyDumps(arg);
        turns.push(put({role: 'TOOL', ts, tool: name, output: null, ref, text: ''}, 'text', (arg as string).replace(DATA_URL, '[image]'), TL));
        if (p['call_id']) pending.set(pyStr(p['call_id']), turns.length - 1);
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output' || pt === 'tool_search_output') {
        const key = pyStr(p['call_id']);
        const i = pending.get(key);
        if (i !== undefined) {
          pending.delete(key);
          put(turns[i]!, 'output', outText(p['output']).replace(DATA_URL, '[image]'), OL);
          turns[i]!.outRef = ref;
        }
      }
    } else if (typ === 'event_msg' && !hasRespUser) {
      const pt = p['type'];
      if (pt === 'user_message' && p['message']) turns.push(put({role: 'USER', ts, ref, text: ''}, 'text', pyStr(p['message']), TL));
      else if (pt === 'agent_message' && p['message']) turns.push(put({role: 'ASSISTANT', ts, ref, text: ''}, 'text', pyStr(p['message']), TL));
    }
  });
  return s;
}

// ------------------------------------------------------------------ pi
export function parsePi(file: string): Session {
  const s: Session = {harness: 'pi', id: '', project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: []};
  const entries: Rec[] = [];
  const byId = new Map<string, Rec>();
  forEachRecord(file, (o, n) => {
    if (!isRec(o)) return;
    if (o['type'] === 'session') {
      s.id = str(o['id']) ?? '';
      s.project = str(o['cwd']);
      if (o['parentSession']) { s.parent = pyStr(o['parentSession']); s.parentKind = 'fork'; }
      return;
    }
    if (o['type'] === 'session_info' && 'name' in o) s.title = str(o['name']) || null;
    o['_n'] = n;
    entries.push(o);
    if (o['id']) byId.set(pyStr(o['id']), o);
  });
  if (!s.id) { const parts = path.basename(file, '.jsonl').split('_'); s.id = parts[parts.length - 1] ?? ''; }
  let chain = entries;
  if (entries.length && entries.some(e => 'parentId' in e)) {
    chain = [];
    let cur: Rec | undefined = entries[entries.length - 1];
    let guard = 0;
    while (cur !== undefined && guard < 1e6) {
      chain.push(cur);
      const pid: unknown = cur['parentId'];
      cur = pid === undefined || pid === null ? undefined : byId.get(pyStr(pid));
      guard++;
    }
    chain.reverse();
  }
  const pending = new Map<string, number>();
  for (const e of chain) {
    if (e['type'] !== 'message') continue;
    const m = isRec(e['message']) ? e['message'] : {};
    const ts = isoTs(e['timestamp'] ?? m['timestamp']);
    if (ts) { s.start = s.start || ts; s.end = ts; }
    const ref = `${file}:${String(e['_n'])}`;
    const role = m['role'];
    const content = m['content'];
    if (role === 'user') {
      const t = typeof content === 'string' ? content : blockText(content);
      if (pyStrip(t)) s.turns.push({role: INJECT_RE.test(t) ? 'SYSTEM' : 'USER', ts, text: t, ref});
    } else if (role === 'assistant') {
      const blocks = Array.isArray(content) ? content : [{type: 'text', text: content || ''}];
      for (const b of blocks) {
        if (!isRec(b)) continue;
        const bt = typeof b['text'] === 'string' ? (b['text'] as string) : '';
        if (b['type'] === 'text' && pyStrip(bt)) s.turns.push({role: 'ASSISTANT', ts, text: bt, ref});
        else if (b['type'] === 'toolCall' || b['type'] === 'tool_use') {
          const name = str(b['name']) ?? 'tool';
          s.turns.push({role: 'TOOL', ts, tool: name, text: toolInputSummary(name, b['arguments'] || b['input']), output: null, ref});
          pending.set(pyStr(b['id']), s.turns.length - 1);
        }
      }
    } else if (role === 'toolResult' || role === 'tool') {
      const out = typeof content === 'string' ? content : blockText(content);
      const key = pyStr(m['toolCallId']);
      const i = pending.get(key);
      if (i !== undefined) {
        pending.delete(key);
        s.turns[i]!.output = out;
        s.turns[i]!.outRef = ref;
      }
    }
  }
  return s;
}

/** The reference exporter's backstop for readers that do not cap at parse time (pi): lengths kept, long fields capped. */
function shrink(s: Session, lim: ReadLimits): Session {
  for (const t of s.turns) {
    for (const [k, l] of [['text', lim.text ?? TEXT_LIM], ['output', lim.output ?? OUT_LIM]] as const) {
      const v = k === 'text' ? t.text : t.output;
      if (typeof v !== 'string') continue;
      const n = cpLen(v);
      if (k === 'text') t.textLen ??= n; else t.outputLen ??= n;
      if (n > l + 16) {
        const capped = cpSlice(v, 0, Math.floor(l * 2 / 3)) + '\n[...]\n' + cpSlice(v, -Math.ceil(l / 3));
        if (k === 'text') t.text = capped; else t.output = capped;
      }
    }
  }
  return s;
}

/** Harness of an unlabelled transcript (archive copies), from its first records. */
export function sniff(file: string): Harness | 'unknown' {
  const head = headOf(file, 256 * 1024);
  const lines = head.toString('utf8').split('\n');
  let i = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isRec(o)) { i++; continue; }
    const t = o['type'];
    if (t === 'session_meta' || t === 'response_item' || t === 'turn_context' || t === 'event_msg') return 'codex';
    if (t === 'session' && 'cwd' in o) return 'pi';
    if ((t === 'user' || t === 'assistant') && 'sessionId' in o) return 'claude';
    if (++i > 50) break;
  }
  return 'unknown';
}

/** Reads one native file as a normalised session (null when it holds none). */
export function readSession(file: string, harness: Harness, subParent: string | null, lim: ReadLimits = {}): Session | null {
  if (harness === 'claude') return parseClaude(file, subParent, lim);
  if (harness === 'codex') return parseCodex(file, lim);
  return shrink(parsePi(file), lim);
}
