import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { agentNote, antigravity, paths } from '@potsherd/core';
import { confirm, fold, print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { LEGACY_WHAT, legacyChanges, type LegacyTarget } from './setup-legacy.js';

/**
 * `slopie setup`: teach the user's agents the records.
 *
 *   claude   ~/.claude/skills/slopie/SKILL.md (the one skill) + a SessionStart hook in ~/.claude/settings.json
 *   codex    a marked `slopie` block in ~/.codex/AGENTS.md (the same text)
 *   pi       ~/.pi/agent/skills/slopie/SKILL.md (the one skill) + ~/.pi/agent/extensions/slopie.ts (sync on start;
 *            the continuation pointer after a resume or compaction, injected with pi.sendMessage)
 *
 * The skill body is the evaluated note (records format, answer protocol, `slopie search`). A pre-release
 * `slopie-memory` skill is removed. Every write
 * shows its diff first, asks (or takes --yes), keeps a backup of a file it changes, and never touches content it
 * did not write. `--remove` takes out exactly what it put in.
 *
 * It also removes the MCP server potsherd 1.x registered (setup-legacy.ts), whose program 1.9 no longer ships:
 * in the same reviewable plan, with the same backup, touching only the entry potsherd wrote.
 */
export const SETUP_CLIENTS = ['claude', 'codex', 'pi'] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];

export interface SetupOptions extends GlobalOptions {
  clients?: SetupClient[];
  all?: boolean;
  dryRun?: boolean;
  status?: boolean;
  remove?: boolean;
  /** Print the note setup installs (for any other harness), and nothing else. */
  note?: boolean;
}

const BEGIN = '<!-- slopie:begin -->';
const END = '<!-- slopie:end -->';
/** The 1.9.0 pre-release markers: a block between them is replaced too. */
const OLD_MARKERS = ['<!-- slopie:memory:begin -->', '<!-- slopie:memory:end -->'] as const;
export const SKILL = 'slopie';
/** The 1.9.0 pre-release skill name; setup removes a skill of this name that it wrote. */
const OLD_SKILL = 'slopie-memory';
export const SKILL_DESCRIPTION = "Search your past coding-agent sessions with the user (Claude Code, Codex, pi). Use it whenever the user mentions earlier work, asks what happened before, or you continue a session.";

interface Change {
  client: SetupClient | LegacyTarget;
  file: string;
  what: string;
  before: string | null;
  after: string | null;
  /** Recomputes `after` from the file as it is when written (a file its client may have changed meanwhile). */
  transform?: (text: string) => string | null;
}

export function skillText(recordsDir: string): string {
  return `---\nname: ${SKILL}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${agentNote(recordsDir)}\n`;
}

/** The Codex AGENTS.md block: the skill's name and description as a heading, then the same body. */
export function agentsBlock(recordsDir: string): string {
  return `## ${SKILL}\n${SKILL_DESCRIPTION}\n\n${agentNote(recordsDir)}`;
}

/** The argv that runs this slopie: `slopie` when it is on PATH, else this exact node + entry. */
export function slopieArgv(): string[] {
  const onPath = (process.env['PATH'] ?? '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, 'slopie')));
  const entry = process.argv[1] ?? '';
  return onPath || !entry ? ['slopie'] : [process.execPath, path.resolve(entry)];
}

const sh = (a: string) => (/^[A-Za-z0-9_./:@+-]+$/.test(a) ? a : JSON.stringify(a));

/** The command a hook runs. */
export function hookCommand(harness: SetupClient): string {
  return [...slopieArgv(), 'hook', 'session-start', '--harness', harness].map(sh).join(' ');
}

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function cutBlock(cur: string, begin: string, end: string): string {
  const a = cur.indexOf(begin), b = cur.indexOf(end);
  return a >= 0 && b > a ? (cur.slice(0, a).replace(/\n+$/, '') + cur.slice(b + end.length).replace(/^\n+/, '\n')).replace(/^\n+$/, '') : cur;
}

function withBlock(text: string | null, block: string | null): string | null {
  const cur = text ?? '';
  const without = cutBlock(cutBlock(cur, BEGIN, END), ...OLD_MARKERS);
  if (!block) return without.trim() ? without.replace(/\n*$/, '\n') : text === null ? null : '';
  return (without.trim() ? without.replace(/\n*$/, '\n\n') : '') + `${BEGIN}\n${block}\n${END}\n`;
}

/** A hook command potsherd 1.x installed (`potsherd rescue …`, `potsherd-mcp`): its program is gone. */
export const LEGACY_HOOK = /\bpotsherd(?:\.js)?["']?\s+rescue\b|\bpotsherd-mcp\b/;

type HookGroup = {matcher?: string; hooks?: {type?: string; command?: string; timeout?: number}[]};

/** True when a hooks object (Claude settings, Codex hooks.json) still runs a potsherd 1.x hook. */
export function hasLegacyHook(text: string | null): boolean {
  if (!text) return false;
  try {
    const hooks = (JSON.parse(text) as {hooks?: Record<string, HookGroup[]>}).hooks ?? {};
    return Object.values(hooks).some(l => Array.isArray(l) && l.some(g => (g.hooks ?? []).some(h => typeof h.command === 'string' && LEGACY_HOOK.test(h.command))));
  } catch { return false; }
}

/**
 * A `{hooks: {Event: [{matcher, hooks: [{command}]}]}}` file (Claude settings.json, Codex hooks.json) with this
 * harness's slopie SessionStart hook set (or removed: command null), and every potsherd 1.x hook taken out.
 */
function withHooks(text: string | null, file: string, harness: SetupClient, command: string | null, matcher?: string): string {
  let obj: Record<string, unknown> = {};
  if (text && text.trim()) {
    try { obj = JSON.parse(text) as Record<string, unknown>; } catch { throw new UserError(`${file} is not plain JSON; add the hook by hand: ${command}`); }
  }
  const hooks = {...(obj['hooks'] && typeof obj['hooks'] === 'object' ? obj['hooks'] : {})} as Record<string, unknown>;
  for (const [ev, l] of Object.entries(hooks)) {
    if (!Array.isArray(l)) continue;
    const kept = (l as HookGroup[]).map(g => (Array.isArray(g.hooks) && g.hooks.some(h => typeof h.command === 'string' && LEGACY_HOOK.test(h.command))
      ? {...g, hooks: g.hooks.filter(h => !(typeof h.command === 'string' && LEGACY_HOOK.test(h.command)))} : g)).filter(g => !Array.isArray(g.hooks) || g.hooks.length);
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  const list = (Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []) as HookGroup[];
  const kept = list.filter(e => !(e.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(`hook session-start --harness ${harness}`)));
  if (command) kept.push({...(matcher ? {matcher} : {}), hooks: [{type: 'command', command, timeout: 20}]});
  hooks['SessionStart'] = kept;
  if (!kept.length) delete hooks['SessionStart'];
  const next: Record<string, unknown> = {...obj, hooks};
  if (!Object.keys(hooks).length) delete next['hooks'];
  return JSON.stringify(next, null, 2) + '\n';
}

const claudeSettings = (text: string | null, command: string | null) => withHooks(text, paths.claudePaths().settings, 'claude', command, 'startup|resume|compact');

function piExtension(): string {
  const [cmd, ...args] = slopieArgv();
  return `// slopie (installed by \`slopie setup\`): keep the session records current when a pi session starts, and after
// a resume or a compaction give the agent this session's record path and the commands to read it (at most 10 lines).
import { spawn } from 'node:child_process';
const CMD = ${JSON.stringify(cmd)};
const ARGS = ${JSON.stringify([...args, 'hook', 'session-start', '--harness', 'pi'])};
function hook(source, sessionId) {
  return new Promise(resolve => {
    let out = '';
    try {
      const child = spawn(CMD, ARGS, { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', d => { if (out.length < 4000) out += d; });
      child.on('close', () => resolve(out));
      child.on('error', () => resolve(''));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ session_id: sessionId, source }));
    } catch { resolve(''); }
  });
}
export default function (pi) {
  const run = async (source, ctx) => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.() ?? '';
      const text = (await hook(source, id)).trim();
      if (text && source !== 'startup') pi.sendMessage({ customType: 'slopie', content: text.split('\\n').slice(0, 10).join('\\n'), display: true }, { deliverAs: 'nextTurn' });
    } catch {}
  };
  // Never awaited: a session start is not held up by slopie.
  pi.on('session_start', (event, ctx) => { void run(event?.reason === 'resume' ? 'resume' : 'startup', ctx); });
  pi.on('session_compact', (_event, ctx) => { void run('compact', ctx); });
}
`;
}

/** The other clients potsherd 1.x could register its server with; cleaned when no client is named (or --all). */
const LEGACY_ONLY: LegacyTarget[] = ['cursor', 'gemini', 'opencode', 'copilot'];

function plan(o: SetupOptions, clients: readonly SetupClient[], others = false): Change[] {
  const records = paths.recordsDir();
  const out: Change[] = [];
  const add = (client: SetupClient, file: string, what: string, after: string | null) => {
    const before = read(file);
    if (before !== after && !(before === null && after === null)) out.push({client, file, what, before, after});
  };
  const oldSkill = (client: SetupClient, skills: string) => {
    const file = path.join(skills, OLD_SKILL, 'SKILL.md');
    const before = read(file);
    if (before !== null && before.startsWith(`---\nname: ${OLD_SKILL}\n`)) out.push({client, file, what: `old ${OLD_SKILL} skill`, before, after: null});
  };
  for (const c of clients) {
    if (c === 'claude') {
      const dir = paths.claudeDir(o.claudeDir);
      add(c, path.join(dir, 'skills', SKILL, 'SKILL.md'), 'skill', o.remove ? null : skillText(records));
      oldSkill(c, path.join(dir, 'skills'));
      const settings = path.join(dir, 'settings.json');
      add(c, settings, 'SessionStart hook' + (hasLegacyHook(read(settings)) ? '; remove stale potsherd 1.x hooks' : ''), claudeSettings(read(settings), o.remove ? null : hookCommand('claude')));
    } else if (c === 'codex') {
      const home = paths.codexDir(o.codexDir);
      const file = path.join(home, 'AGENTS.md');
      add(c, file, 'AGENTS.md slopie block', withBlock(read(file), o.remove ? null : agentsBlock(records)));
      // The refresh hook, mirroring Claude, where this Codex has the hooks.json format.
      const hooksFile = path.join(home, 'hooks.json');
      const ht = read(hooksFile);
      if (ht !== null && isHooksJson(ht)) add(c, hooksFile, 'SessionStart hook' + (hasLegacyHook(ht) ? '; remove stale potsherd 1.x hooks' : ''), withHooks(ht, hooksFile, 'codex', o.remove ? null : hookCommand('codex')));
    } else {
      const root = path.join(paths.piDir(o.piDir), 'agent');
      add(c, path.join(root, 'skills', SKILL, 'SKILL.md'), 'skill', o.remove ? null : skillText(records));
      oldSkill(c, path.join(root, 'skills'));
      add(c, path.join(root, 'extensions', 'slopie.ts'), 'extension', o.remove ? null : piExtension());
    }
  }
  const legacyOpts = {...(o.claudeDir ? {claudeDir: o.claudeDir} : {}), ...(o.codexDir ? {codexDir: o.codexDir} : {}), ...(o.piDir ? {piDir: o.piDir} : {})};
  for (const l of legacyChanges([...clients, ...(others ? LEGACY_ONLY : [])], legacyOpts)) {
    const before = read(l.file);
    if (before === null) continue;
    const after = l.transform(before);
    // One file can carry both a slopie change and the legacy removal (never today; kept apart if it ever does).
    if (after !== before) out.push({client: l.client, file: l.file, what: l.what ?? LEGACY_WHAT, before, after, transform: l.transform});
  }
  return out;
}

function isHooksJson(text: string): boolean {
  try { const o = JSON.parse(text) as Record<string, unknown>; return !!o && typeof o === 'object' && !Array.isArray(o) && (o['hooks'] === undefined || (typeof o['hooks'] === 'object' && !Array.isArray(o['hooks']))); } catch { return false; }
}

/** How each harness keeps the index fresh: a refresh hook, or only the note (search then refreshes itself). */
function refreshOf(o: SetupOptions, c: SetupClient): string {
  if (c === 'claude') return (read(path.join(paths.claudeDir(o.claudeDir), 'settings.json')) ?? '').includes('hook session-start --harness claude') ? 'refresh hook' : 'note only';
  if (c === 'codex') return (read(path.join(paths.codexDir(o.codexDir), 'hooks.json')) ?? '').includes('hook session-start --harness codex') ? 'refresh hook' : 'note only';
  return fs.existsSync(path.join(paths.piDir(o.piDir), 'agent', 'extensions', 'slopie.ts')) ? 'refresh hook' : 'note only';
}

function indexAge(): string {
  try {
    const s = Math.round((Date.now() - fs.statSync(path.join(paths.recordsDir(), '.slopie', 'index.sqlite')).mtimeMs) / 1000);
    return s < 60 ? `${s} s old` : s < 3600 ? `${Math.round(s / 60)} min old` : s < 172800 ? `${Math.round(s / 3600)} h old` : `${Math.round(s / 86400)} days old`;
  } catch { return 'not built yet (slopie sync)'; }
}

function detected(o: SetupOptions): SetupClient[] {
  const found: SetupClient[] = [];
  if (fs.existsSync(paths.claudeDir(o.claudeDir))) found.push('claude');
  if (fs.existsSync(paths.codexDir(o.codexDir))) found.push('codex');
  if (fs.existsSync(paths.piDir(o.piDir))) found.push('pi');
  return found;
}

function diff(before: string | null, after: string | null): string[] {
  const a = (before ?? '').split('\n'), b = (after ?? '').split('\n');
  const setA = new Set(a), setB = new Set(b);
  return [...a.filter(l => !setB.has(l) && l.trim()).map(l => `- ${l}`), ...b.filter(l => !setA.has(l) && l.trim()).map(l => `+ ${l}`)].slice(0, 40);
}

export async function runSetup(o: SetupOptions): Promise<number> {
  const t = themeFrom(o);
  if (o.note) {
    // Evaluation seams (R6): the CLI line can be left out, and the R5 §7 sentences added.
    const note = agentNote(paths.recordsDir(), {cli: process.env['SLOPIE_NOTE_CLI'] !== '0', protocol: process.env['SLOPIE_NOTE_PROTOCOL'] !== '0', guidance: process.env['SLOPIE_NOTE_GUIDANCE'] === '1', sidecar: process.env['SLOPIE_NOTE_SIDECAR'] === '1'});
    if (o.json) printJson({note, records: paths.recordsDir()}); else process.stdout.write(note + '\n');
    return 0;
  }
  const clients = o.clients?.length ? o.clients : detected(o);
  if (o.status) {
    const rows = SETUP_CLIENTS.map(c => {
      const pending = plan({...o, remove: false}, [c]);
      return {client: c, detected: detected(o).includes(c), installed: pending.length === 0, missing: pending.map(p => p.what), refresh: refreshOf(o, c)};
    });
    // Read-only sources: synced from their files, no hook to install (Antigravity has no hook mechanism).
    const readOnly = [{client: 'antigravity', detected: antigravity.antigravityPresent(), mode: 'read only'}];
    if (o.json) printJson({records: paths.recordsDir(), index: indexAge(), clients: rows, readOnly});
    else {
      print(`  index   ${indexAge()}`);
    }
    if (!o.json) for (const r of rows) {
      const text = (r.installed ? 'installed' : r.detected ? `missing: ${r.missing.join(', ')} (slopie setup --${r.client})` : 'not found on this machine') + (r.detected ? ` · ${r.refresh}` : '');
      fold(text, Math.max(20, t.width - 12)).forEach((row, i) => print(`  ${i ? ''.padEnd(8) : r.client.padEnd(8)}${row}`));
    }
    if (!o.json && readOnly[0]!.detected) fold('read only: no hook; titles, agent messages and plans are synced, prompts are encrypted', Math.max(20, t.width - 16)).forEach((row, i) => print(`  ${i ? ''.padEnd(12) : 'antigravity '}${row}`));
    return 0;
  }
  if (!clients.length) {
    print('no Claude Code, Codex or pi directory found; name one: slopie setup --claude | --codex | --pi');
    return 1;
  }
  const changes = plan(o, clients, !o.clients?.length || !!o.all);
  if (!changes.length) {
    if (o.json) printJson({changes: []}); else print(o.remove ? 'nothing to remove.' : `already set up for ${clients.join(', ')}.`);
    return 0;
  }
  if (o.json && o.dryRun) { printJson({changes: changes.map(c => ({client: c.client, file: c.file, what: c.what, remove: c.after === null}))}); return 0; }
  if (!o.json) {
    for (const c of changes) {
      print(`${t.bold(c.client)}  ${paths.tildify(c.file)}  ${t.dim(c.what)}`);
      for (const l of diff(c.before, c.after)) print(t.dim(`    ${l.slice(0, Math.max(20, t.width - 6))}`));
    }
  }
  if (o.dryRun) { print(t.dim('dry run: nothing written.')); return 0; }
  if (!o.yes && !(await confirm(o.remove ? 'remove these?' : 'write these?', {default: true}))) { print('nothing written.'); return 1; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const c of changes) {
    if (c.transform) {
      // Recomputed from the file as it is now: its client may have written it while the plan was on screen.
      const now = read(c.file);
      if (now === null) continue;
      c.before = now;
      c.after = c.transform(now);
      if (c.after === now) continue;
    }
    const ours = [SKILL, OLD_SKILL].some(k => c.file.includes(`${path.sep}${k}${path.sep}`)) || c.file.endsWith(`${path.sep}slopie.ts`);
    if (c.before !== null && !ours) fs.copyFileSync(c.file, `${c.file}.slopie-bak-${stamp}`);
    if (c.after === null) {
      fs.rmSync(c.file, {force: true});
      const dir = path.dirname(c.file);
      if ([SKILL, OLD_SKILL].includes(path.basename(dir))) fs.rmSync(dir, {recursive: true, force: true});
    } else {
      fs.mkdirSync(path.dirname(c.file), {recursive: true});
      if (c.transform) {
        // A file another program keeps open (~/.claude.json): replaced whole, with its mode kept.
        const tmp = `${c.file}.slopie-tmp-${process.pid}`;
        fs.writeFileSync(tmp, c.after, {mode: fs.statSync(c.file).mode & 0o777});
        fs.renameSync(tmp, c.file);
      } else {
        fs.writeFileSync(c.file, c.after);
      }
    }
  }
  if (o.json) printJson({written: changes.map(c => c.file)});
  else {
    print(`${o.remove ? 'removed' : 'done'}: ${changes.length} file${changes.length === 1 ? '' : 's'}.`);
    if (!o.remove && !fs.existsSync(path.join(paths.recordsDir(), 'INDEX.tsv'))) print(`next:  slopie sync   ${t.dim('(writes the records the note points at)')}`);
  }
  void os;
  return 0;
}
