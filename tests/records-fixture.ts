/**
 * A synthetic agent history for the records tests: no real transcript content anywhere.
 *
 *   claude   one session (title, tool call with a long output), one subagent of it, a prefix copy of the
 *            session in the rescue archive, a history.jsonl with one prompt-only session (also in the archive copy)
 *   codex    one rollout (.jsonl), a compressed copy of a second rollout in archived_sessions (.jsonl.zst), and a
 *            third rollout that Codex imported from Claude (dropped)
 *   pi       one session
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const IDS = {
  claude: '11111111-2222-4333-8444-555555555555',
  agent: 'agent-a0123456789abcdef',
  promptOnly: '99999999-8888-4777-8666-555555555555',
  codex: '019a0000-0000-7000-8000-000000000001',
  codexZst: '019a0000-0000-7000-8000-000000000002',
  codexImported: '019a0000-0000-7000-8000-000000000003',
  pi: 'pi-session-0001',
} as const;

export const PROJECT = '/work/demo-app';
/** A string that sits in the middle of a long tool output: beyond the record's 500 + 300 character cap. */
export const NEEDLE = 'ZEBRA_MIDDLE_NEEDLE_42';

const line = (o: unknown) => JSON.stringify(o) + '\n';

export interface Fixture {
  root: string;
  claudeDir: string;
  codexDir: string;
  piDir: string;
  potsherdDir: string;
  slopieDir: string;
  recordsDir: string;
  claudeFile: string;
  agentFile: string;
}

export function claudeSession(turns: 'full' | 'prefix' = 'full'): string {
  const base = {sessionId: IDS.claude, cwd: PROJECT};
  const longOutput = 'head-of-output ' + 'x'.repeat(900) + ` ${NEEDLE} ` + 'y'.repeat(900) + ' tail-of-output';
  const rows = [
    {type: 'custom-title', customTitle: 'Fix the login redirect', sessionId: IDS.claude},
    {...base, type: 'user', uuid: 'u1', timestamp: '2026-10-01T09:12:00.000Z', message: {role: 'user', content: 'the login page loops back to /signin after OAuth'}},
    {...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T09:13:00.000Z', message: {id: 'm1', role: 'assistant', content: [{type: 'text', text: 'Looking at the callback handler first.'}]}},
    {...base, type: 'assistant', uuid: 'a2', timestamp: '2026-10-01T09:13:30.000Z', message: {id: 'm2', role: 'assistant', content: [{type: 'tool_use', id: 'tu1', name: 'Bash', input: {command: 'rg -n "redirect_uri" src/'}}]}},
    {...base, type: 'user', uuid: 'u2', timestamp: '2026-10-01T09:13:40.000Z', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu1', content: longOutput}]}},
  ];
  if (turns === 'full') {
    rows.push(
      {...base, type: 'user', uuid: 'u3', timestamp: '2026-10-01T11:40:00.000Z', message: {role: 'user', content: '<system-reminder>injected</system-reminder>'}},
      {...base, type: 'user', uuid: 'u4', timestamp: '2026-10-01T11:40:10.000Z', message: {role: 'user', content: 'ship it\nwith the pgbouncer pool at 40'}},
    );
  }
  return rows.map(line).join('');
}

function agentSession(): string {
  const base = {sessionId: IDS.claude, cwd: PROJECT, isSidechain: true, agentId: IDS.agent.slice(6)};
  return [
    {...base, type: 'user', uuid: 's1', timestamp: '2026-10-01T09:20:00.000Z', message: {role: 'user', content: 'review the OAuth callback for a redirect loop'}},
    {...base, type: 'assistant', uuid: 's2', timestamp: '2026-10-01T09:21:00.000Z', message: {id: 'sm1', role: 'assistant', content: [{type: 'text', text: 'The state cookie is SameSite=Strict, which drops it on the provider redirect.'}]}},
  ].map(line).join('');
}

function codexRollout(id: string, text: string, when: string): string {
  return [
    {timestamp: when, type: 'session_meta', payload: {id, cwd: PROJECT, originator: 'codex_cli'}},
    {timestamp: when, type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}},
    {timestamp: when.replace(':00.', ':05.'), type: 'response_item', payload: {type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({cmd: 'cat config/pool.toml'})}},
    {timestamp: when.replace(':00.', ':06.'), type: 'response_item', payload: {type: 'function_call_output', call_id: 'c1', output: 'max_connections = 40'}},
    {timestamp: when.replace(':00.', ':09.'), type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'The pool is capped at 40 connections.'}]}},
  ].map(line).join('');
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slopie-records-'));
  const claudeDir = path.join(root, '.claude'), codexDir = path.join(root, '.codex'), piDir = path.join(root, '.pi');
  const potsherdDir = path.join(root, '.potsherd'), slopieDir = path.join(root, '.slopie'), recordsDir = path.join(slopieDir, 'records');
  const proj = path.join(claudeDir, 'projects', '-work-demo-app');
  fs.mkdirSync(path.join(proj, IDS.claude, 'subagents'), {recursive: true});
  const claudeFile = path.join(proj, `${IDS.claude}.jsonl`);
  fs.writeFileSync(claudeFile, claudeSession('full'));
  const agentFile = path.join(proj, IDS.claude, 'subagents', `${IDS.agent}.jsonl`);
  fs.writeFileSync(agentFile, agentSession());
  const history = [
    {display: 'make every feature available over an API', timestamp: Date.parse('2026-09-20T08:00:00Z'), project: '/work/printer', sessionId: IDS.promptOnly},
    {display: 'and document it', timestamp: Date.parse('2026-09-20T08:05:00Z'), project: '/work/printer', sessionId: IDS.promptOnly},
    {display: 'the login page loops back to /signin after OAuth', timestamp: Date.parse('2026-10-01T09:12:00Z'), project: PROJECT, sessionId: IDS.claude},
  ].map(line).join('');
  fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), history);
  // The 1.x rescue archive: a prefix copy of the live session, and a copy of history.jsonl.
  const ev = path.join(potsherdDir, 'archive', 'evidence');
  fs.mkdirSync(ev, {recursive: true});
  fs.writeFileSync(path.join(ev, 'aaaa1111.jsonl'), claudeSession('prefix'));
  fs.mkdirSync(path.join(potsherdDir, 'archive', 'claude'), {recursive: true});
  fs.writeFileSync(path.join(potsherdDir, 'archive', 'claude', 'history.jsonl'), history);
  // Codex
  const day = path.join(codexDir, 'sessions', '2026', '10', '02');
  fs.mkdirSync(day, {recursive: true});
  fs.writeFileSync(path.join(day, `rollout-2026-10-02T10-00-00-${IDS.codex}.jsonl`), codexRollout(IDS.codex, 'what is the pgbouncer pool size?', '2026-10-02T10:00:00.000Z'));
  fs.writeFileSync(path.join(day, `rollout-2026-10-02T12-00-00-${IDS.codexImported}.jsonl`), codexRollout(IDS.codexImported, 'imported from claude', '2026-10-02T12:00:00.000Z'));
  const archived = path.join(codexDir, 'archived_sessions');
  fs.mkdirSync(archived, {recursive: true});
  const zst = (zlib as unknown as {zstdCompressSync?: (b: Buffer) => Buffer}).zstdCompressSync;
  const rollout = Buffer.from(codexRollout(IDS.codexZst, 'compressed rollout about vercel deploys', '2026-10-03T10:00:00.000Z'));
  if (zst) fs.writeFileSync(path.join(archived, `rollout-2026-10-03T10-00-00-${IDS.codexZst}.jsonl.zst`), zst(rollout));
  else fs.writeFileSync(path.join(archived, `rollout-2026-10-03T10-00-00-${IDS.codexZst}.jsonl`), rollout);
  fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), line({id: IDS.codex, thread_name: 'Check the pool size', updated_at: '2026-10-02T10:01:00Z'}));
  fs.writeFileSync(path.join(codexDir, 'external_agent_session_imports.json'), JSON.stringify({records: [{imported_thread_id: IDS.codexImported}]}));
  // pi
  const piSessions = path.join(piDir, 'agent', 'sessions', '--work-demo-app--');
  fs.mkdirSync(piSessions, {recursive: true});
  fs.writeFileSync(path.join(piSessions, `2026-10-04T10-00-00_${IDS.pi}.jsonl`), [
    {type: 'session', id: IDS.pi, cwd: PROJECT, timestamp: '2026-10-04T10:00:00.000Z'},
    {type: 'message', id: 'p1', timestamp: '2026-10-04T10:00:01.000Z', message: {role: 'user', content: 'rename the env var to DEMO_TOKEN'}},
    {type: 'message', id: 'p2', parentId: 'p1', timestamp: '2026-10-04T10:00:02.000Z', message: {role: 'assistant', content: [{type: 'text', text: 'Renamed in three files.'}]}},
  ].map(line).join(''));
  return {root, claudeDir, codexDir, piDir, potsherdDir, slopieDir, recordsDir, claudeFile, agentFile};
}

export function syncOptions(f: Fixture, extra: Record<string, unknown> = {}) {
  return {recordsDir: f.recordsDir, claudeDir: f.claudeDir, codexDir: f.codexDir, piDir: f.piDir,
    potsherdDir: f.potsherdDir, slopieDir: f.slopieDir, workerUrl: null, ...extra};
}
