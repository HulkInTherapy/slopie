import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { paths } from '@potsherd/core';

/**
 * The MCP server potsherd 1.x registered (`potsherd setup`), which 1.9 removed: its program is gone, so the
 * registration only makes the agent fail to start a server. `slopie setup` takes it out again.
 *
 * Only potsherd's own registration is touched: an entry named `potsherd` that runs `potsherd-mcp`, or node with
 * potsherd's own server script (packages/mcp/dist/index.js, @potsherd/mcp/dist/index.js, a plugin's dist/mcp.js),
 * and nothing the user added (no env values, no other keys) — the shape `potsherd setup` and the documented
 * `claude mcp add` wrote; and the pi extension file carrying potsherd's marker line. A `potsherd` entry the user
 * changed is left alone. Every other server and setting stays as it was.
 *
 * The Claude Code / Codex plugin carried its own server too; updating the plugin (1.9 ships none) removes it.
 */
export const LEGACY_WHAT = 'remove the potsherd 1.x MCP server (its program is gone)';
const NAME = 'potsherd';
const PI_MARK = '// potsherd-pi-entry: ';
const PI_STUB = 'export default function() {}\n';
const SCRIPT = /(?:^|[\\/])(?:packages[\\/]mcp[\\/]dist[\\/]index\.js|@potsherd[\\/]mcp[\\/]dist[\\/]index\.js|dist[\\/]mcp\.js)$/;

export type LegacyTarget = 'claude' | 'codex' | 'pi' | 'cursor' | 'gemini' | 'opencode' | 'copilot';

export interface LegacyChange {
  client: LegacyTarget;
  file: string;
  /** The file as it should be after the removal, from its current text; null deletes the file. */
  transform: (text: string) => string | null;
}

/** argv potsherd's setup wrote: `potsherd-mcp`, or a node binary and one of potsherd's server scripts. */
function ownArgv(argv: unknown[]): boolean {
  if (!argv.every(a => typeof a === 'string')) return false;
  const [cmd, ...args] = argv as string[];
  if (!cmd) return false;
  if (cmd === 'potsherd-mcp') return args.length === 0;
  return /^node(?:\.exe)?$|[\\/]node(?:\.exe)?$/.test(cmd) && args.length === 1 && SCRIPT.test(args[0]!);
}

/** One JSON entry, in the shape each client's 1.x stanza had. */
function ownJsonEntry(target: LegacyTarget, e: unknown): boolean {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  const args = Array.isArray(o['args']) ? o['args'] as unknown[] : o['args'] === undefined ? [] : null;
  if (target === 'opencode') return keys === 'command,enabled,type' && o['type'] === 'local' && o['enabled'] === true && Array.isArray(o['command']) && ownArgv(o['command'] as unknown[]);
  if (args === null || typeof o['command'] !== 'string') return false;
  if (!Object.keys(o).every(k => ['type', 'command', 'args', 'env', 'tools'].includes(k))) return false;
  if (o['type'] !== undefined && o['type'] !== 'stdio' && o['type'] !== 'local') return false;
  if (o['env'] !== undefined && JSON.stringify(o['env']) !== '{}') return false;
  if (o['tools'] !== undefined && JSON.stringify(o['tools']) !== '["*"]') return false;
  return ownArgv([o['command'], ...args]);
}

function jsonTransform(target: LegacyTarget, holderKey: string): (text: string) => string {
  return text => {
    const json = JSON.parse(text) as Record<string, unknown>;
    const holder = json[holderKey] as Record<string, unknown>;
    if (holder && ownJsonEntry(target, holder[NAME])) delete holder[NAME];
    return JSON.stringify(json, null, 2) + '\n';
  };
}

function jsonHas(target: LegacyTarget, holderKey: string, text: string): boolean {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const holder = json?.[holderKey];
    return !!holder && typeof holder === 'object' && ownJsonEntry(target, (holder as Record<string, unknown>)[NAME]);
  } catch {
    return false; // not plain JSON (comments, damage): not something potsherd wrote, and not ours to rewrite
  }
}

// [mcp_servers.potsherd] with exactly the command / args lines potsherd wrote.
const TABLE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"([^"]+)"|'([^']+)'|([^\]]+?))[ \t]*\][ \t]*$/;
/** The server a `[mcp_servers.…]` header names (sub-tables such as `[mcp_servers.x.env]` name x), and its full name. */
const tableOf = (line: string): {server: string; full: string} | null => {
  const m = TABLE.exec(line);
  if (!m) return null;
  const full = m[1] ?? m[2] ?? m[3]!;
  return {server: m[3] !== undefined ? full.split('.')[0]! : full, full};
};

function tomlOwnTable(text: string): {start: number; end: number} | null {
  const lines = text.split('\n');
  const start = lines.findIndex(l => tableOf(l)?.full === NAME);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^[ \t]*\[/.test(lines[end]!)) end++;
  const body: Record<string, unknown> = {};
  for (const l of lines.slice(start + 1, end)) {
    if (!l.trim()) continue;
    const m = /^[ \t]*([A-Za-z_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(l);
    if (!m) return null;
    try { body[m[1]!] = JSON.parse(m[2]!); } catch { return null; }
  }
  // Any other potsherd table (e.g. [mcp_servers.potsherd.env]) means the user extended it: leave it.
  if (lines.some((l, i) => i !== start && tableOf(l)?.server === NAME)) return null;
  if (lines.some(l => /^[ \t]*mcp_servers[ \t]*=/.test(l))) return null;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'args,command' && keys !== 'command') return null;
  const args = body['args'] === undefined ? [] : body['args'];
  return Array.isArray(args) && ownArgv([body['command'], ...args]) ? {start, end} : null;
}

function tomlTransform(text: string): string {
  const t = tomlOwnTable(text);
  if (!t) return text;
  const lines = text.split('\n');
  lines.splice(t.start, t.end - t.start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** `~/.claude.json`, and the one inside the config directory when CLAUDE_CONFIG_DIR or --claude-dir moves it. */
function claudeJsons(claudeDirOpt?: string): string[] {
  const override = claudeDirOpt ?? (process.env['CLAUDE_CONFIG_DIR']?.trim() || undefined);
  return [...new Set([...(override ? [path.join(paths.claudeDir(override), '.claude.json')] : []), path.join(paths.home(), '.claude.json')])];
}

function opencodeConfig(): string {
  const xdg = process.env['XDG_CONFIG_HOME']?.trim();
  return path.join(xdg ? path.resolve(paths.expandTilde(xdg)) : path.join(paths.home(), '.config'), 'opencode', 'opencode.json');
}

/** The potsherd 1.x registrations that are still there, for these targets. */
export function legacyChanges(targets: readonly LegacyTarget[], o: {claudeDir?: string; codexDir?: string; piDir?: string} = {}): LegacyChange[] {
  const out: LegacyChange[] = [];
  const json = (client: LegacyTarget, file: string, holder: string) => {
    const text = read(file);
    if (text !== null && jsonHas(client, holder, text)) out.push({client, file, transform: jsonTransform(client, holder)});
  };
  for (const t of targets) {
    if (t === 'claude') for (const file of claudeJsons(o.claudeDir)) json(t, file, 'mcpServers');
    else if (t === 'cursor') json(t, path.join(paths.cursorDir(), 'mcp.json'), 'mcpServers');
    else if (t === 'gemini') json(t, path.join(paths.geminiDir(), 'settings.json'), 'mcpServers');
    else if (t === 'copilot') json(t, path.join(paths.copilotDir(), 'mcp-config.json'), 'mcpServers');
    else if (t === 'opencode') json(t, opencodeConfig(), 'mcp');
    else if (t === 'codex') {
      const file = path.join(paths.codexDir(o.codexDir), 'config.toml');
      const text = read(file);
      if (text !== null && tomlOwnTable(text)) out.push({client: t, file, transform: tomlTransform});
    } else if (t === 'pi') {
      const file = path.join(paths.piDir(o.piDir), 'agent', 'extensions', 'potsherd.ts');
      const text = read(file);
      if (text !== null && (text.startsWith(PI_MARK) || text === PI_STUB)) out.push({client: t, file, transform: () => null});
    }
  }
  return out;
}
