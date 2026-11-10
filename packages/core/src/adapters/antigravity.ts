/**
 * Antigravity (Google's agent IDE, a VS Code fork): what can be read honestly.
 *
 *   ~/.gemini/antigravity/conversations/<uuid>.pb   ENCRYPTED. Only the uuid and the file times are used;
 *                                                    the content is never read or decrypted.
 *   ~/.gemini/antigravity/brain/<uuid>/              plain markdown the agent wrote (task.md,
 *                                                    implementation_plan.md, walkthrough.md, their
 *                                                    `.resolved` versions) + `<name>.md.metadata.json`.
 *   <app data>/Antigravity/User/globalStorage/state.vscdb
 *       ItemTable key `jetskiStateSync.agentManagerInitState`: base64 protobuf with no published schema.
 *       Per conversation: uuid, title, workspace `file://` URI, google.protobuf.Timestamp submessages and
 *       recent steps (`notify_user` / `task_boundary` with JSON payloads).
 *
 * The typed prompts are only in the encrypted .pb files, so Antigravity contributes chats, days and
 * projects, never prompts or usage. The state blob is read with a small generic wire-format reader and a
 * heuristic walk: unknown fields are ignored, and a conversation that cannot be read is skipped with a gap
 * code (never failing the caller). Only data inside a conversation's own message is used (the blob also
 * holds account tokens at its top level, which are never visited).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as paths from '../paths.js';
import {openDatabase} from '../sqlite-driver.js';

export const STATE_KEY = 'jetskiStateSync.agentManagerInitState';

/* ------------------------------------------------------ protobuf wire format --- */

export type PbField =
  | {field: number; wire: 0; value: bigint}
  | {field: number; wire: 1; value: Uint8Array}
  | {field: number; wire: 2; value: Uint8Array}
  | {field: number; wire: 5; value: Uint8Array};

function varint(b: Uint8Array, i: number): [bigint, number] {
  let r = 0n, shift = 0n;
  for (let n = 0; n < 10; n++) {
    if (i >= b.length) throw new Error('truncated varint');
    const c = b[i++]!;
    r |= BigInt(c & 0x7f) << shift;
    if (c < 0x80) return [r, i];
    shift += 7n;
  }
  throw new Error('varint too long');
}

/** Every field of one message, in order. Throws on anything that is not well-formed wire format. */
export function readProto(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < b.length) {
    const [key, j] = varint(b, i);
    i = j;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (field < 1 || field > 536870911) throw new Error('bad field number');
    if (wire === 0) { const [v, k] = varint(b, i); i = k; out.push({field, wire, value: v}); }
    else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > b.length) throw new Error('truncated fixed');
      out.push({field, wire, value: b.subarray(i, i + n)}); i += n;
    } else if (wire === 2) {
      const [n0, k] = varint(b, i);
      const n = Number(n0);
      if (k + n > b.length) throw new Error('truncated bytes');
      out.push({field, wire, value: b.subarray(k, k + n)}); i = k + n;
    } else throw new Error('unsupported wire type');
  }
  return out;
}

/** {@link readProto}, or null when the bytes are not a (non-empty) message. */
export function tryProto(b: Uint8Array): PbField[] | null {
  if (!b.length) return null;
  try { return readProto(b); } catch { return null; }
}

const DEC = new TextDecoder('utf-8', {fatal: true});
/** The bytes as text when they are valid UTF-8 without control characters (newlines and tabs allowed). */
export function asText(b: Uint8Array): string | null {
  let s: string;
  try { s = DEC.decode(b); } catch { return null; }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) ? null : s;
}

/* -------------------------------------------------------------- extraction --- */

export interface AgStep {
  tool: 'notify_user' | 'task_boundary';
  /** Epoch ms of the step, when its message carries a timestamp. */
  at: number | null;
  message?: string;
  taskName?: string;
  taskStatus?: string;
  mode?: string;
}

export interface AgConversation {
  id: string;
  title: string | null;
  /** Workspace folder (decoded from its file:// URI). */
  workspace: string | null;
  /** Every plausible timestamp in the conversation, epoch ms, ascending, unique. */
  times: number[];
  steps: AgStep[];
  /** Artifact file paths the conversation names. */
  artifacts: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_S = 1577836800n; // 2020-01-01
const STEP_TOOLS = new Set(['notify_user', 'task_boundary']);

/** A google.protobuf.Timestamp: field 1 seconds (plausible), optional field 2 nanos, nothing else. */
function timestampOf(fields: PbField[]): number | null {
  let s: bigint | null = null, ns = 0n;
  for (const f of fields) {
    if (f.wire !== 0) return null;
    if (f.field === 1 && s === null) s = f.value;
    else if (f.field === 2) ns = f.value;
    else return null;
  }
  const max = BigInt(Math.floor(Date.now() / 1000) + 2 * 86400);
  if (s === null || s < MIN_S || s > max || ns >= 1000000000n) return null;
  return Number(s) * 1000 + Math.floor(Number(ns) / 1e6);
}

function workspacePath(uri: string): string | null {
  try { return fileURLToPath(uri); } catch { /* not a local file URI */ }
  try { return decodeURIComponent(new URL(uri).pathname) || null; } catch { return null; }
}

const isTitle = (s: string) => s.length > 0 && s.length <= 200 && !/[\n\r]/.test(s) && !UUID.test(s) && !/^[a-z]+:\/\//i.test(s) && !s.startsWith('{');

function jsonObject(s: string): Record<string, unknown> | null {
  if (!s.startsWith('{')) return null;
  try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** One conversation from its message (`[uuid, payload…]`). Throws when it holds nothing usable. */
function buildConversation(id: string, fields: PbField[]): AgConversation {
  const conv: AgConversation = {id: id.toLowerCase(), title: null, workspace: null, times: [], steps: [], artifacts: []};
  const times = new Set<number>();
  const seenSteps = new Set<string>();
  const visit = (fs0: PbField[], ctxTs: number | null, depth: number) => {
    if (depth > 24) return;
    // Children: parsed once (as text and, when well-formed, as a message).
    const kids = fs0.filter((f): f is Extract<PbField, {wire: 2}> => f.wire === 2).map(f => {
      const msg = tryProto(f.value);
      return {text: asText(f.value), msg, ts: msg ? timestampOf(msg) : null};
    });
    let local = ctxTs;
    for (const k of kids) if (k.ts !== null) { times.add(k.ts); if (local === ctxTs) local = k.ts; }
    const texts = kids.map(k => k.text).filter((t): t is string => t !== null);
    for (const t of texts) {
      if (/^file:\/\//i.test(t)) {
        if (/[\\/]brain[\\/]/.test(t)) { const p = workspacePath(t); if (p && !conv.artifacts.includes(p)) conv.artifacts.push(p); }
        else if (!conv.workspace && t.replace(/^file:\/+/i, '').length > 0) conv.workspace = workspacePath(t);
      }
    }
    const tool = texts.find(t => STEP_TOOLS.has(t));
    if (tool) {
      for (const t of texts) {
        const j = jsonObject(t);
        if (!j) continue;
        const key = tool + '\u0000' + t;
        if (seenSteps.has(key)) break;
        seenSteps.add(key);
        const step: AgStep = {tool: tool as AgStep['tool'], at: local};
        if (tool === 'notify_user') { const m = str(j['Message']); if (!m) break; step.message = m; }
        else { step.taskName = str(j['TaskName']); step.taskStatus = str(j['TaskStatus']); step.mode = str(j['Mode']); if (!step.taskName && !step.taskStatus) break; }
        conv.steps.push(step);
        break;
      }
    }
    for (const k of kids) if (k.msg && k.ts === null) visit(k.msg, local, depth + 1);
  };
  // The title is the payload's first title-like direct string.
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const m = tryProto(f.value);
    if (!m) continue;
    for (const g of m) {
      if (g.wire !== 2) continue;
      const t = asText(g.value);
      if (t !== null && isTitle(t)) { conv.title = t; break; }
    }
    if (conv.title) break;
  }
  visit(fields, null, 0);
  conv.times = [...times].sort((a, b) => a - b);
  conv.steps.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!conv.title && !conv.workspace && !conv.times.length && !conv.steps.length) throw new Error('empty conversation');
  return conv;
}

/** A conversation message: a direct uuid string plus a direct submessage (its payload). */
function conversationId(fields: PbField[]): string | null {
  let id: string | null = null, payload = false;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const t = asText(f.value);
    if (t !== null && UUID.test(t)) { id ??= t; continue; }
    if (tryProto(f.value)) payload = true;
  }
  return id && payload ? id : null;
}

/**
 * Conversations in an `agentManagerInitState` blob (raw protobuf bytes). Conversations that cannot be read
 * are skipped and add `antigravity_conversation_unreadable` to `gaps`; an unreadable blob adds
 * `antigravity_state_unreadable`. Several messages for one uuid are merged.
 */
export function extractConversations(blob: Uint8Array, gaps: string[] = []): AgConversation[] {
  const top = tryProto(blob);
  if (!top) { gaps.push('antigravity_state_unreadable'); return []; }
  const byId = new Map<string, AgConversation>();
  const walk = (fields: PbField[], depth: number) => {
    if (depth > 6) return;
    for (const f of fields) {
      if (f.wire !== 2) continue;
      const m = tryProto(f.value);
      if (!m) continue;
      const id = conversationId(m);
      if (!id) { walk(m, depth + 1); continue; }
      try {
        const c = buildConversation(id, m);
        const old = byId.get(c.id);
        if (!old) { byId.set(c.id, c); continue; }
        old.title ??= c.title; old.workspace ??= c.workspace;
        old.times = [...new Set([...old.times, ...c.times])].sort((a, b) => a - b);
        old.steps.push(...c.steps); old.artifacts.push(...c.artifacts.filter(a => !old.artifacts.includes(a)));
      } catch { gaps.push('antigravity_conversation_unreadable'); }
    }
  };
  walk(top, 0);
  return [...byId.values()];
}

/* ------------------------------------------------------------- brain dir --- */

export interface AgArtifact {
  /** Artifact name (`task.md`). */
  name: string;
  /** File the content was read from (the latest `.resolved`, else the `.md`). */
  file: string;
  artifactType: string | null;
  summary: string | null;
  updatedAt: number | null;
  /** Content; empty when it was not read. */
  text: string;
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

/** The artifacts of one `brain/<uuid>/` directory, by name. */
export function readBrain(dir: string, withText = true): AgArtifact[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: AgArtifact[] = [];
  for (const name of names.filter(n => /\.md$/i.test(n)).sort()) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.metadata.json`), 'utf8')) as Record<string, unknown>; } catch { /* no metadata */ }
    const resolved = path.join(dir, `${name}.resolved`);
    const file = fs.existsSync(resolved) ? resolved : path.join(dir, name);
    let text = '';
    if (withText) {
      try { const st = fs.statSync(file); if (st.size <= MAX_ARTIFACT_BYTES) text = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }
    }
    const at = typeof meta['updatedAt'] === 'string' ? Date.parse(meta['updatedAt']) : NaN;
    out.push({name, file, artifactType: str(meta['artifactType']) ?? null, summary: str(meta['summary']) ?? null, updatedAt: Number.isFinite(at) ? at : null, text});
  }
  return out;
}

/* ------------------------------------------------------------- discovery --- */

export interface AntigravityOptions {
  /** `~/.gemini/antigravity` (or SLOPIE_ANTIGRAVITY_DIR). */
  dir?: string;
  /** The app's state.vscdb (or SLOPIE_ANTIGRAVITY_STATE). */
  stateDb?: string;
  /** Read artifact content (records); the audit needs only metadata. */
  artifactText?: boolean;
}

export interface AgSession {
  id: string;
  title: string | null;
  project: string | null;
  /** Conversation timestamps + artifact updatedAt + .pb file times, epoch ms ascending. */
  times: number[];
  steps: AgStep[];
  artifacts: AgArtifact[];
  /** The encrypted transcript (never read), if present. */
  pb: string | null;
  brain: string | null;
  /** state.vscdb, when the conversation was found in it. */
  state: string | null;
}

export interface AntigravityData {
  sessions: AgSession[];
  gaps: string[];
  /** Files whose size/mtime decide whether anything changed. */
  inputs: {file: string; size: number; mtimeMs: number}[];
}

function stat(file: string): fs.Stats | null {
  try { return fs.statSync(file); } catch { return null; }
}

/** The state blob from a temporary copy of the database (the app keeps it open). */
export function readStateBlob(db: string, gaps: string[]): Uint8Array | null {
  if (!stat(db)?.isFile()) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slopie-ag-'));
  try {
    const copy = path.join(tmp, 'state.vscdb');
    fs.copyFileSync(db, copy);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, copy + ext);
    const d = openDatabase(copy, {readonly: true, fileMustExist: true});
    try {
      const row = d.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STATE_KEY) as {value?: unknown} | undefined;
      const v = row?.value;
      if (v === undefined || v === null) return null;
      const s = typeof v === 'string' ? v : Buffer.from(v as Uint8Array).toString('utf8');
      const b = Buffer.from(s.trim(), 'base64');
      return b.length ? b : null;
    } finally { d.close(); }
  } catch {
    gaps.push('antigravity_state_unreadable');
    return null;
  } finally {
    try { fs.rmSync(tmp, {recursive: true, force: true}); } catch { /* best effort */ }
  }
}

/** Is any Antigravity data present (cheap: stats only)? */
export function antigravityPresent(o: AntigravityOptions = {}): boolean {
  const dir = paths.antigravityDir(o.dir);
  return !!stat(path.join(dir, 'conversations'))?.isDirectory() || !!stat(path.join(dir, 'brain'))?.isDirectory() || !!stat(paths.antigravityStateDb(o.stateDb))?.isFile();
}

/** Every Antigravity conversation on this machine. Never throws. */
export function loadAntigravity(o: AntigravityOptions = {}): AntigravityData {
  const gaps: string[] = [];
  const inputs: AntigravityData['inputs'] = [];
  const dir = paths.antigravityDir(o.dir);
  const dbFile = paths.antigravityStateDb(o.stateDb);
  const sessions = new Map<string, AgSession>();
  const get = (id: string) => {
    let s = sessions.get(id);
    if (!s) { s = {id, title: null, project: null, times: [], steps: [], artifacts: [], pb: null, brain: null, state: null}; sessions.set(id, s); }
    return s;
  };
  const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const name of list(path.join(dir, 'conversations'))) {
    const m = /^([0-9a-f-]{36})\.pb$/i.exec(name);
    if (!m || !UUID.test(m[1]!)) continue;
    const file = path.join(dir, 'conversations', name);
    const st = stat(file);
    if (!st?.isFile()) continue;
    const s = get(m[1]!.toLowerCase());
    s.pb = file;
    inputs.push({file, size: st.size, mtimeMs: st.mtimeMs});
    for (const t of [st.birthtimeMs, st.mtimeMs]) if (t > 0) s.times.push(Math.round(t));
  }
  for (const name of list(path.join(dir, 'brain'))) {
    if (!UUID.test(name)) continue;
    const bdir = path.join(dir, 'brain', name);
    const st = stat(bdir);
    if (!st?.isDirectory()) continue;
    const artifacts = readBrain(bdir, o.artifactText ?? false);
    const known = sessions.has(name.toLowerCase());
    if (!artifacts.length && !known) continue;
    const s = get(name.toLowerCase());
    s.brain = bdir;
    s.artifacts = artifacts;
    let newest = st.mtimeMs;
    for (const a of artifacts) { if (a.updatedAt !== null) s.times.push(a.updatedAt); const f = stat(a.file); if (f && f.mtimeMs > newest) newest = f.mtimeMs; }
    inputs.push({file: bdir, size: artifacts.length, mtimeMs: newest});
  }
  const dbStat = stat(dbFile);
  if (dbStat?.isFile()) {
    inputs.push({file: dbFile, size: dbStat.size, mtimeMs: dbStat.mtimeMs});
    const blob = readStateBlob(dbFile, gaps);
    if (blob) {
      for (const c of extractConversations(blob, gaps)) {
        const s = get(c.id);
        s.state = dbFile;
        s.title = c.title;
        s.project = c.workspace;
        s.times.push(...c.times);
        s.steps = c.steps;
      }
    }
  }
  const out = [...sessions.values()];
  for (const s of out) s.times = [...new Set(s.times)].sort((a, b) => a - b);
  out.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0) || (a.id < b.id ? -1 : 1));
  return {sessions: out, gaps: [...new Set(gaps)], inputs};
}
