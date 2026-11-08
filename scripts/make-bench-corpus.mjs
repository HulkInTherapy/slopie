#!/usr/bin/env node
/**
 * Large synthetic corpus for audit latency measurements (slopie 1.9).
 *
 *   node scripts/make-bench-corpus.mjs <dest> [scale=1]
 *
 * Writes <dest>/claude (projects/**, history.jsonl, stats-cache.json),
 * <dest>/codex (sessions/** incl. .jsonl.zst, archived_sessions/),
 * <dest>/potsherd/archive/evidence (archive copies) and <dest>/pi.
 * scale=1 is roughly 3 GB in ~2,000 files. Everything is synthetic and
 * deterministic (seeded PRNG, fixed anchor instant); bulk bytes are filler
 * tool output, as in real transcripts, which the audit skips unread.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dest = path.resolve(process.argv[2] ?? '.tmp/bench');
const scale = Number(process.argv[3] ?? 1);
let seed = 0x5eed;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = xs => xs[Math.floor(rnd() * xs.length)];
const ANCHOR = Date.parse('2026-06-01T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const hex = n => Array.from({length: n}, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
const WORDS = 'add fix the a to router test endpoint please make it work refactor this module config build cache page layout and then check why failing again'.split(' ');
const sentence = n => Array.from({length: n}, () => pick(WORDS)).join(' ');
const FILLER = 'x'.repeat(64 * 1024);
const filler = n => FILLER.slice(0, n);
const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const CODEX_MODELS = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol'];
const PROJECTS = Array.from({length: 24}, (_, i) => `/home/dev/work/bench-project-${i}`);
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, lines.join('\n') + '\n'); return file; };
let bytes = 0, files = 0;
const done = file => { bytes += fs.statSync(file).size; files++; };

fs.rmSync(dest, {recursive: true, force: true});
const claude = path.join(dest, 'claude'), codex = path.join(dest, 'codex'), evidence = path.join(dest, 'potsherd', 'archive', 'evidence');
const history = [];

// ---- Claude: top-level sessions with subagents
const claudeSessions = Math.round(500 * scale);
for (let s = 0; s < claudeSessions; s++) {
  const sid = uuid(), project = pick(PROJECTS), slug = project.replace(/\//g, '-');
  let t = ANCHOR + int(0, 150) * 86_400_000 + int(0, 86_399) * 1000;
  const model = pick(CLAUDE_MODELS);
  const lines = [], turns = int(2, 12);
  for (let i = 0; i < turns; i++) {
    const uid = uuid(), text = sentence(int(4, 30));
    lines.push(JSON.stringify({type: 'user', uuid: uid, sessionId: sid, cwd: project, timestamp: iso(t), entrypoint: 'cli', origin: {kind: 'human'}, message: {role: 'user', content: text}}));
    history.push({display: text, timestamp: t + 300, project, sessionId: sid});
    for (let k = int(4, 22); k > 0; k--) {
      t += int(2, 40) * 1000;
      const mid = `msg_${hex(24)}`;
      lines.push(JSON.stringify({type: 'assistant', uuid: uuid(), sessionId: sid, cwd: project, timestamp: iso(t), requestId: `req_${hex(24)}`,
        message: {id: mid, role: 'assistant', model, content: [{type: 'tool_use', id: `toolu_${hex(20)}`, name: pick(['Read', 'Edit', 'Bash', 'Task']), input: {}}],
          usage: {input_tokens: int(1, 50), output_tokens: int(50, 3000), cache_read_input_tokens: int(10_000, 200_000), cache_creation_input_tokens: int(0, 20_000)}}}));
      lines.push(JSON.stringify({type: 'user', uuid: uuid(), sessionId: sid, cwd: project, timestamp: iso(t + 500), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'x', content: filler(int(1_000, 40_000))}]}}));
    }
    t += int(30, 1800) * 1000;
  }
  done(write(path.join(claude, 'projects', slug, `${sid}.jsonl`), lines));
  for (let a = int(0, 2); a > 0; a--) {
    const sub = [], agent = hex(16);
    for (let k = int(5, 30); k > 0; k--) {
      t += 5000;
      sub.push(JSON.stringify({type: 'assistant', uuid: uuid(), sessionId: sid, isSidechain: true, agentId: agent, cwd: project, timestamp: iso(t), requestId: `req_${hex(24)}`,
        message: {id: `msg_${hex(24)}`, role: 'assistant', model: 'claude-haiku-5-5', content: [], usage: {input_tokens: 5, output_tokens: int(50, 900), cache_read_input_tokens: int(5_000, 60_000), cache_creation_input_tokens: 1000}}}));
      sub.push(JSON.stringify({type: 'user', uuid: uuid(), sessionId: sid, isSidechain: true, agentId: agent, timestamp: iso(t + 100), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'x', content: filler(int(1_000, 30_000))}]}}));
    }
    done(write(path.join(claude, 'projects', slug, sid, 'subagents', `agent-${agent}.jsonl`), sub));
  }
}
// History-only sessions (transcripts gone)
for (let s = 0; s < 150 * scale; s++) {
  const sid = uuid(), project = pick(PROJECTS);
  let t = ANCHOR - int(1, 180) * 86_400_000;
  for (let i = int(3, 20); i > 0; i--) { history.push({display: sentence(int(3, 25)), timestamp: t, project, sessionId: sid}); t += int(60, 900) * 1000; }
}
history.sort((a, b) => a.timestamp - b.timestamp);
done(write(path.join(claude, 'history.jsonl'), history.map(h => JSON.stringify(h))));
fs.writeFileSync(path.join(claude, 'stats-cache.json'), JSON.stringify({version: 2, lastComputedDate: '2026-04-18', firstSessionDate: '2025-12-01T00:00:00Z',
  dailyModelTokens: Array.from({length: 60}, (_, i) => ({date: iso(ANCHOR - (170 - i * 2) * 86_400_000).slice(0, 10), tokensByModel: {'claude-opus-4-6': 100000 + i}})),
  modelUsage: {'claude-opus-4-6': {inputTokens: 2_000_000, outputTokens: 3_000_000, cacheReadInputTokens: 900_000_000, cacheCreationInputTokens: 40_000_000}}}));

// ---- Codex rollouts (some compressed, some archived copies in potsherd evidence)
const codexSessions = Math.round(700 * scale);
for (let s = 0; s < codexSessions; s++) {
  const id = uuid(), project = pick(PROJECTS), exec = rnd() < 0.5;
  let t = ANCHOR + int(60, 160) * 86_400_000 + int(0, 86_399) * 1000;
  const lines = [JSON.stringify({timestamp: iso(t), type: 'session_meta', payload: {id, timestamp: iso(t), cwd: project, originator: exec ? 'codex_exec' : 'codex_work_desktop', source: exec ? 'exec' : 'vscode', base_instructions: {text: filler(8000)}}})];
  let total = [0, 0, 0, 0, 0];
  const model = pick(CODEX_MODELS);
  for (let i = int(1, 5); i > 0; i--) {
    t += int(60, 900) * 1000;
    lines.push(JSON.stringify({timestamp: iso(t), type: 'event_msg', payload: {type: 'task_started', turn_id: `turn-${hex(8)}`}}));
    lines.push(JSON.stringify({timestamp: iso(t), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: sentence(int(4, 30))}]}}));
    lines.push(JSON.stringify({timestamp: iso(t + 10), type: 'turn_context', payload: {model, cwd: project}}));
    for (let k = int(5, 30); k > 0; k--) {
      t += int(3, 30) * 1000;
      lines.push(JSON.stringify({timestamp: iso(t), type: 'response_item', payload: {type: 'function_call', name: 'exec_command', arguments: '{}', call_id: hex(10)}}));
      lines.push(JSON.stringify({timestamp: iso(t + 200), type: 'response_item', payload: {type: 'function_call_output', call_id: 'x', output: filler(int(2_000, 60_000))}}));
      const last = [int(1000, 30000), int(10000, 200000), int(50, 3000), int(0, 500), 0];
      last[1] = Math.min(last[1], last[0] + last[1]); last[0] += last[1]; last[4] = last[0] + last[2];
      total = total.map((v, j) => v + last[j]);
      const u = a => ({input_tokens: a[0], cached_input_tokens: a[1], output_tokens: a[2], reasoning_output_tokens: a[3], total_tokens: a[4]});
      lines.push(JSON.stringify({timestamp: iso(t + 300), type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: u(last), total_token_usage: u(total)}}}));
    }
  }
  const day = iso(t).slice(0, 10).split('-');
  const rel = path.join(...day, `rollout-${iso(t).slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  const body = lines.join('\n') + '\n';
  const r = rnd();
  if (r < 0.2) { const f = path.join(codex, 'sessions', rel + '.zst'); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from(body))); done(f); }
  else { const f = path.join(codex, 'sessions', rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, body); done(f); }
  if (r > 0.7) { const f = path.join(evidence, `${hex(64)}.jsonl`); fs.mkdirSync(evidence, {recursive: true}); fs.writeFileSync(f, body); done(f); }
}
fs.mkdirSync(path.join(dest, 'pi'), {recursive: true});
fs.mkdirSync(path.join(dest, 'opencode'), {recursive: true});
console.log(JSON.stringify({dest, files, gb: +(bytes / 1e9).toFixed(2)}));
