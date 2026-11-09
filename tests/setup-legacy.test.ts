/**
 * `slopie setup` removes the MCP server potsherd 1.x registered (1.9.0 review D6), and only that: shown in
 * the plan, backed up, every other server and setting kept, idempotent. Scratch HOME only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFixture, type Fixture } from './records-fixture.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'slopie.js');
const made: Fixture[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, {recursive: true, force: true}); });

function run(f: Fixture, args: string[]): {code: number; stdout: string} {
  const env = {...process.env, NO_COLOR: '1', HOME: f.root, SLOPIE_DIR: f.slopieDir, SLOPIE_RECORDS_DIR: f.recordsDir, CLAUDE_CONFIG_DIR: f.claudeDir,
    POTSHERD_CODEX_DIR: f.codexDir, CODEX_HOME: f.codexDir, POTSHERD_PI_DIR: f.piDir, POTSHERD_DIR: f.potsherdDir, POTSHERD_CURSOR_DIR: path.join(f.root, '.cursor'),
    POTSHERD_GEMINI_DIR: path.join(f.root, '.gemini'), POTSHERD_COPILOT_DIR: path.join(f.root, '.copilot'), XDG_CONFIG_HOME: path.join(f.root, '.config'), PATH: path.dirname(process.execPath)};
  try { return {code: 0, stdout: execFileSync(process.execPath, [bin, ...args], {encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe']})}; }
  catch (err) { const e = err as {status?: number; stdout?: string}; return {code: e.status ?? 1, stdout: e.stdout ?? ''}; }
}

const OTHER = {type: 'stdio', command: 'other-mcp', args: ['--flag']};
const NODE_SCRIPT = ['/usr/local/bin/node', '/opt/tools/node_modules/@potsherd/mcp/dist/index.js'];

function seed(f: Fixture) {
  const claudeJson = path.join(f.claudeDir, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({numStartups: 7, mcpServers: {potsherd: {type: 'stdio', command: 'potsherd-mcp', args: []}, other: OTHER}, projects: {'/work/x': {allowedTools: []}}}, null, 2) + '\n', {mode: 0o600});
  const toml = path.join(f.codexDir, 'config.toml');
  fs.writeFileSync(toml, `model = "gpt"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n\n[mcp_servers.potsherd]\ncommand = ${JSON.stringify(NODE_SCRIPT[0])}\nargs = [${JSON.stringify(NODE_SCRIPT[1])}]\n\n[profiles.fast]\nmodel = "mini"\n`);
  const piExt = path.join(f.piDir, 'agent', 'extensions');
  fs.mkdirSync(piExt, {recursive: true});
  fs.writeFileSync(path.join(piExt, 'potsherd.ts'), `// potsherd-pi-entry: {"command":"potsherd-mcp","args":[]}\nexport default async function(pi) {}\n`);
  fs.writeFileSync(path.join(piExt, 'mine.ts'), 'export default function () {}\n');
  // Cursor: a potsherd entry the user changed (an env key potsherd never wrote) stays.
  fs.mkdirSync(path.join(f.root, '.cursor'), {recursive: true});
  fs.writeFileSync(path.join(f.root, '.cursor', 'mcp.json'), JSON.stringify({mcpServers: {potsherd: {command: 'potsherd-mcp', args: [], env: {X: '1'}}}}, null, 2) + '\n');
  // opencode: potsherd's own entry goes.
  fs.mkdirSync(path.join(f.root, '.config', 'opencode'), {recursive: true});
  fs.writeFileSync(path.join(f.root, '.config', 'opencode', 'opencode.json'), JSON.stringify({$schema: 'https://opencode.ai/config.json', mcp: {potsherd: {type: 'local', command: NODE_SCRIPT, enabled: true}}}, null, 2) + '\n');
  return {claudeJson, toml, piExt};
}

describe('D6: setup removes potsherd 1.x MCP registrations', () => {
  it('plans, backs up and removes exactly the entries potsherd wrote', () => {
    const f = makeFixture(); made.push(f);
    const {claudeJson, toml, piExt} = seed(f);
    const cursorBefore = fs.readFileSync(path.join(f.root, '.cursor', 'mcp.json'), 'utf8');
    const dry = run(f, ['setup', '--dry-run']);
    expect(dry.stdout).toContain('remove the potsherd 1.x MCP server');
    expect(dry.stdout).toContain('.claude.json');
    expect(dry.stdout).toContain('config.toml');
    expect(dry.stdout).toContain('potsherd.ts');
    expect(fs.readFileSync(claudeJson, 'utf8')).toContain('potsherd-mcp');

    expect(run(f, ['setup', '--yes']).code).toBe(0);
    const cj = JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as Record<string, unknown>;
    expect(cj).toEqual({numStartups: 7, mcpServers: {other: OTHER}, projects: {'/work/x': {allowedTools: []}}});
    expect(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(toml, 'utf8')).toBe(`model = "gpt"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n\n[profiles.fast]\nmodel = "mini"\n`);
    expect(fs.existsSync(path.join(piExt, 'potsherd.ts'))).toBe(false);
    expect(fs.existsSync(path.join(piExt, 'mine.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(f.root, '.cursor', 'mcp.json'), 'utf8')).toBe(cursorBefore);
    expect(JSON.parse(fs.readFileSync(path.join(f.root, '.config', 'opencode', 'opencode.json'), 'utf8'))).toEqual({$schema: 'https://opencode.ai/config.json', mcp: {}});
    // Backups of what was changed.
    expect(fs.readdirSync(f.claudeDir).some(n => n.startsWith('.claude.json.slopie-bak-'))).toBe(true);
    expect(fs.readdirSync(f.codexDir).some(n => n.startsWith('config.toml.slopie-bak-'))).toBe(true);
    expect(fs.readdirSync(piExt).some(n => n.startsWith('potsherd.ts.slopie-bak-'))).toBe(true);
    // Idempotent.
    expect(run(f, ['setup', '--yes']).stdout).toContain('already set up');
  });

  it('naming one client touches only that client\'s registration', () => {
    const f = makeFixture(); made.push(f);
    const {claudeJson, toml} = seed(f);
    const tomlBefore = fs.readFileSync(toml, 'utf8');
    expect(run(f, ['setup', '--claude', '--yes']).code).toBe(0);
    expect(fs.readFileSync(claudeJson, 'utf8')).not.toContain('potsherd-mcp');
    expect(fs.readFileSync(toml, 'utf8')).toBe(tomlBefore);
    expect(fs.readFileSync(path.join(f.root, '.config', 'opencode', 'opencode.json'), 'utf8')).toContain('potsherd');
  });
  it('the minimal shapes too (`claude mcp add`, a bare command), wherever .claude.json is', () => {
    const f = makeFixture(); made.push(f);
    const home = path.join(f.root, '.claude.json'), inside = path.join(f.claudeDir, '.claude.json');
    fs.writeFileSync(home, JSON.stringify({mcpServers: {potsherd: {command: 'potsherd-mcp'}}}));
    fs.writeFileSync(inside, JSON.stringify({mcpServers: {potsherd: {type: 'stdio', command: 'potsherd-mcp', args: [], env: {}}}}));
    fs.writeFileSync(path.join(f.codexDir, 'config.toml'), '[mcp_servers.potsherd]\ncommand = "potsherd-mcp"\n');
    expect(run(f, ['setup', '--yes']).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(home, 'utf8'))).toEqual({mcpServers: {}});
    expect(JSON.parse(fs.readFileSync(inside, 'utf8'))).toEqual({mcpServers: {}});
    expect(fs.readFileSync(path.join(f.codexDir, 'config.toml'), 'utf8')).toBe('');
    // A potsherd entry with settings the user added is theirs.
    fs.writeFileSync(home, JSON.stringify({mcpServers: {potsherd: {command: 'potsherd-mcp', env: {TOKEN: 'x'}}}}));
    expect(run(f, ['setup', '--yes']).stdout).toContain('already set up');
  });
});
