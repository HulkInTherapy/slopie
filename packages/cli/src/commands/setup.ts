import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { agentNote, paths } from '@potsherd/core';
import { confirm, print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

/**
 * `slopie setup`: teach the user's agents the records.
 *
 *   claude   ~/.claude/skills/slopie-memory/SKILL.md (the note) + a SessionStart hook in ~/.claude/settings.json
 *   codex    a marked block in ~/.codex/AGENTS.md (the note)
 *   pi       ~/.pi/agent/skills/slopie-memory/SKILL.md (the note) + ~/.pi/agent/extensions/slopie.ts (sync on start;
 *            the continuation pointer after a resume or compaction, injected with pi.sendMessage)
 *
 * The note is R5's NOTE_B verbatim with the records path filled in, plus one line on the CLI tools. Every write
 * shows its diff first, asks (or takes --yes), keeps a backup of a file it changes, and never touches content it
 * did not write. `--remove` takes out exactly what it put in.
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

const BEGIN = '<!-- slopie:memory:begin -->';
const END = '<!-- slopie:memory:end -->';
const SKILL = 'slopie-memory';
const DESCRIPTION = "The user's past coding-agent sessions (Claude Code, Codex, pi; every project; including sessions the harness deleted) as plain-text records you can search with rg/sed or the slopie CLI. Use whenever the user refers to earlier work, a past session, decision, error or file, or when you continue a session.";

interface Change {
  client: SetupClient;
  file: string;
  what: string;
  before: string | null;
  after: string | null;
}

export function skillText(recordsDir: string): string {
  return `---\nname: ${SKILL}\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n\n${agentNote(recordsDir)}\n`;
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

function withBlock(text: string | null, block: string | null): string | null {
  const cur = text ?? '';
  const a = cur.indexOf(BEGIN), b = cur.indexOf(END);
  const without = a >= 0 && b > a ? (cur.slice(0, a).replace(/\n+$/, '') + cur.slice(b + END.length).replace(/^\n+/, '\n')).replace(/^\n+$/, '') : cur;
  if (!block) return without.trim() ? without.replace(/\n*$/, '\n') : text === null ? null : '';
  return (without.trim() ? without.replace(/\n*$/, '\n\n') : '') + `${BEGIN}\n${block}\n${END}\n`;
}

function claudeSettings(text: string | null, command: string | null): string {
  let obj: Record<string, unknown> = {};
  if (text && text.trim()) {
    try { obj = JSON.parse(text) as Record<string, unknown>; } catch { throw new UserError(`${paths.claudePaths().settings} is not plain JSON; add the hook by hand: ${command}`); }
  }
  const hooks = (obj['hooks'] && typeof obj['hooks'] === 'object' ? obj['hooks'] : {}) as Record<string, unknown>;
  const list = (Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []) as {hooks?: {command?: string}[]}[];
  const kept = list.filter(e => !(e.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('hook session-start --harness claude')));
  if (command) kept.push({matcher: 'startup|resume|compact', hooks: [{type: 'command', command, timeout: 20}]} as never);
  const next = {...obj, hooks: {...hooks, SessionStart: kept}};
  if (!kept.length) delete (next.hooks as Record<string, unknown>)['SessionStart'];
  if (!Object.keys(next.hooks).length) delete (next as Record<string, unknown>)['hooks'];
  return JSON.stringify(next, null, 2) + '\n';
}

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

function plan(o: SetupOptions, clients: readonly SetupClient[]): Change[] {
  const records = paths.recordsDir();
  const out: Change[] = [];
  const add = (client: SetupClient, file: string, what: string, after: string | null) => {
    const before = read(file);
    if (before !== after && !(before === null && after === null)) out.push({client, file, what, before, after});
  };
  for (const c of clients) {
    if (c === 'claude') {
      const dir = paths.claudeDir(o.claudeDir);
      add(c, path.join(dir, 'skills', SKILL, 'SKILL.md'), 'skill', o.remove ? null : skillText(records));
      const settings = path.join(dir, 'settings.json');
      add(c, settings, 'SessionStart hook', claudeSettings(read(settings), o.remove ? null : hookCommand('claude')));
    } else if (c === 'codex') {
      const home = paths.codexDir(o.codexDir);
      const file = path.join(home, 'AGENTS.md');
      add(c, file, 'AGENTS.md note', withBlock(read(file), o.remove ? null : agentNote(records)));
    } else {
      const root = path.join(paths.piDir(o.piDir), 'agent');
      add(c, path.join(root, 'skills', SKILL, 'SKILL.md'), 'skill', o.remove ? null : skillText(records));
      add(c, path.join(root, 'extensions', 'slopie.ts'), 'extension', o.remove ? null : piExtension());
    }
  }
  return out;
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
    const note = agentNote(paths.recordsDir(), {cli: process.env['SLOPIE_NOTE_CLI'] !== '0', guidance: process.env['SLOPIE_NOTE_GUIDANCE'] === '1', sidecar: process.env['SLOPIE_NOTE_SIDECAR'] === '1'});
    if (o.json) printJson({note, records: paths.recordsDir()}); else process.stdout.write(note + '\n');
    return 0;
  }
  const clients = o.clients?.length ? o.clients : detected(o);
  if (o.status) {
    const rows = SETUP_CLIENTS.map(c => {
      const pending = plan({...o, remove: false}, [c]);
      return {client: c, detected: detected(o).includes(c), installed: pending.length === 0, missing: pending.map(p => p.what)};
    });
    if (o.json) printJson({records: paths.recordsDir(), clients: rows});
    else for (const r of rows) print(`  ${r.client.padEnd(8)}${r.installed ? 'installed' : r.detected ? `missing: ${r.missing.join(', ')}  (slopie setup --${r.client})` : 'not found on this machine'}`);
    return 0;
  }
  if (!clients.length) {
    print('no Claude Code, Codex or pi directory found; name one: slopie setup --claude | --codex | --pi');
    return 1;
  }
  const changes = plan(o, clients);
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
    if (c.before !== null && !c.file.includes(`${path.sep}${SKILL}${path.sep}`) && !c.file.endsWith(`${path.sep}slopie.ts`)) fs.copyFileSync(c.file, `${c.file}.slopie-bak-${stamp}`);
    if (c.after === null) {
      fs.rmSync(c.file, {force: true});
      const dir = path.dirname(c.file);
      if (path.basename(dir) === SKILL) fs.rmSync(dir, {recursive: true, force: true});
    } else {
      fs.mkdirSync(path.dirname(c.file), {recursive: true});
      fs.writeFileSync(c.file, c.after);
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
