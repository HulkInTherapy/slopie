/**
 * Session-start hook (Claude Code SessionStart, Codex SessionStart, pi session_start):
 *   - keeps the records current (an incremental `slopie sync`; the first full build runs detached), and
 *   - on resume / after compaction, prints a continuation pointer of at most 10 lines: this session's id,
 *     its record path, and the exact read / search commands. No summary and no model call.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../paths.js';
import {stateDir} from './sync.js';

export interface HookInput {
  session_id?: string;
  sessionId?: string;
  source?: string;
  cwd?: string;
}

export function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as HookInput) : {};
  } catch {
    return {};
  }
}

/** True when this start continues earlier work (the pointer is printed only then). */
export function isContinuation(source: string | undefined): boolean {
  return source === 'compact' || source === 'resume';
}

interface Found {rel: string; project: string | null; harness: string; id: string}

function findRecord(recordsDir: string, id: string): Found | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir(recordsDir), 'state.json'), 'utf8')) as {sessions: Record<string, Found>};
    for (const s of Object.values(state.sessions)) if (s.id === id) return s;
  } catch { /* no records yet */ }
  return null;
}

/** True when the records already hold this session. */
export function hasRecord(sessionId: string, recordsDir = paths.recordsDir()): boolean {
  return findRecord(recordsDir, sessionId) !== null;
}

/** The continuation pointer (≤ 10 lines). */
export function continuationPointer(sessionId: string, harness: string, recordsDir = paths.recordsDir()): string[] {
  const rec = findRecord(recordsDir, sessionId);
  const file = rec ? path.join(recordsDir, rec.rel) : null;
  const lines = [
    `slopie: this ${harness} session (${sessionId}) continues earlier work; its full transcript is a plain-text record.`,
    file ? `record: ${file}` : `record: not written yet (run: slopie sync); index: ${path.join(recordsDir, 'INDEX.tsv')}`,
    `latest turns:  slopie read ${sessionId} --from -30`,
    `inside it:     slopie search "<words>" --session ${sessionId}    exact text: slopie grep ${sessionId} "<text>"`,
  ];
  if (rec?.project) lines.push(`same project:  slopie threads --project ${JSON.stringify(rec.project)}`);
  if (file) lines.push(`or with the shell: rg -n -i '<term>' ${JSON.stringify(file)} ; sed -n 'a,bp' ${JSON.stringify(file)}`);
  lines.push('Retrieve exact lines as you need them; do not guess what happened earlier.');
  return lines.slice(0, 10);
}
