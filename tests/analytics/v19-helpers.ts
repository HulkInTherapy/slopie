import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {vi} from 'vitest';
import {createAuditSession} from '../../packages/core/src/analytics/index.js';
import type {AuditEvent, AuditOverviewOptions, AuditSnapshot} from '../../packages/core/src/analytics/contracts.js';

// Synthetic fixtures only: no real project names, paths or prompt text.
export const roots: string[] = [];
export const cleanup = () => { roots.splice(0).forEach(root => fs.rmSync(root, {recursive: true, force: true})); vi.unstubAllEnvs(); };
export const jsonl = (rows: unknown[]) => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
export const at = (minute: number, base = '2026-10-01T10:00:00Z') => new Date(Date.parse(base) + minute * 60_000).toISOString();

export function home(timezone = 'UTC') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v19-engine-'));
  roots.push(root);
  const dirs = {root, claude: path.join(root, 'claude'), codex: path.join(root, 'codex'), pi: path.join(root, 'pi'), opencode: path.join(root, 'opencode'), potsherd: path.join(root, 'potsherd'), cache: path.join(root, 'cache')};
  for (const d of Object.values(dirs)) fs.mkdirSync(d, {recursive: true});
  const options: AuditOverviewOptions = {launch: true, claudeDir: dirs.claude, codexDir: dirs.codex, piDir: dirs.pi, opencodeDir: dirs.opencode, potsherdDir: dirs.potsherd, derivedCacheDir: dirs.cache, timezone};
  const write = (file: string, rows: unknown[]) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, jsonl(rows)); return file; };
  return {dirs, options, write};
}

export async function run(options: AuditOverviewOptions, events?: AuditEvent[]): Promise<AuditSnapshot> {
  vi.stubEnv('POTSHERD_OFFLINE', '1');
  const session = createAuditSession(options);
  try { return await session.run(e => events?.push(e)); } finally { session.dispose(); }
}

export const claudeUser = (uuid: string, text: string, minute: number, sessionId = 's1', extra: Record<string, unknown> = {}) => ({type: 'user', uuid, sessionId, cwd: '/work/synthetic-app', timestamp: at(minute), entrypoint: 'cli', origin: {kind: 'human'}, message: {role: 'user', content: text}, ...extra});
export const claudeAssistant = (id: string, minute: number, sessionId = 's1', model = 'claude-sonnet-4-6', usage: Record<string, unknown> = {input_tokens: 1000, output_tokens: 100}) => ({type: 'assistant', uuid: `a-${id}`, sessionId, cwd: '/work/synthetic-app', timestamp: at(minute), requestId: `r-${id}`,
  message: {id, role: 'assistant', model, content: [{type: 'text', text: 'ok'}], usage}});

/** A Codex rollout. `prompts` = 'items' (UserMessage), 'events' (user_message), 'responses' (response_item role=user only). */
export function codexRollout(o: {id: string; turns: number; from?: number; base?: string; model?: string; prompts?: 'items' | 'events' | 'responses'; originator?: string; source?: unknown; forkedFrom?: string; parent?: string; input?: number; output?: number; startTotal?: number}) {
  const rows: unknown[] = [];
  const base = o.base ?? '2026-10-01T10:00:00Z', from = o.from ?? 0, input = o.input ?? 1000, output = o.output ?? 100, start = o.startTotal ?? 0;
  if (from === 0) {
    rows.push({timestamp: at(0, base), type: 'session_meta', payload: {id: o.id, timestamp: at(0, base), cwd: '/work/synthetic-api', originator: o.originator ?? 'codex_work_desktop', source: o.source ?? 'vscode',
      ...(o.forkedFrom ? {forked_from_id: o.forkedFrom} : {})}});
    if (o.prompts === 'responses') rows.push({timestamp: at(0, base), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '<environment_context>\n  <cwd>/work/synthetic-api</cwd>\n</environment_context>'}]}});
  }
  for (let i = from; i < from + o.turns; i++) {
    rows.push({timestamp: at(i * 10 + 1, base), type: 'event_msg', payload: {type: 'task_started', turn_id: `turn-${o.id}-${i}`}});
    const text = `please add synthetic feature number ${i}`;
    if (o.prompts === 'events') rows.push({timestamp: at(i * 10 + 1, base), type: 'event_msg', payload: {type: 'user_message', message: text}});
    else if (o.prompts === 'responses') rows.push({timestamp: at(i * 10 + 1, base), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}});
    else rows.push({timestamp: at(i * 10 + 1, base), type: 'event_msg', payload: {type: 'item_completed', turn_id: `turn-${o.id}-${i}`, item: {type: 'UserMessage', id: `item-${o.id}-${i}`, content: [{type: 'input_text', text}]}}});
    rows.push({timestamp: at(i * 10 + 2, base), type: 'turn_context', payload: {model: o.model ?? 'gpt-6-sol', cwd: '/work/synthetic-api'}});
    const n = start + i + 1;
    rows.push({timestamp: at(i * 10 + 3, base), type: 'event_msg', payload: {type: 'token_count', info: {
      last_token_usage: {input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output},
      total_token_usage: {input_tokens: input * n, cached_input_tokens: 0, output_tokens: output * n, reasoning_output_tokens: 0, total_tokens: (input + output) * n}}}});
  }
  return rows;
}
