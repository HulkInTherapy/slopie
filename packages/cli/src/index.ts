import process from 'node:process';
import { Command, Option } from 'commander';
import { fail, print, printJson, themeFrom, type GlobalOptions } from './output.js';
import { runAudit } from './commands/audit.js';
import { runDoctor } from './commands/doctor.js';
import { runIgnore } from './commands/ignore.js';
import { runSetup, SETUP_CLIENTS } from './commands/setup.js';
import { runForget, runGrep, runHook, runMcp, runRead, runSearch, runSync, runThreads } from './commands/memory.js';

import { VERSION } from '@potsherd/core';
export { VERSION };

// React and Ink are loaded only by the interactive route, after this bootstrap.
// Ordinary CLI processes use production rendering; explicit environments stay intact.
if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = 'production';

/**
 * The `slopie` binary (also installed as `potsherd`).
 *
 *   audit                             the terminal audit (unchanged), plus a background records sync
 *   sync                              native history -> ~/.slopie/records (+ INDEX.tsv, search index)
 *   search | read | threads | grep    lookups over the records; every reply ends with the next command
 *   mcp                               the same four tools as a stdio MCP server
 *   setup | doctor                    install the agent note and hooks; say what slopie sees
 *   ignore | forget                   privacy: keep a project / a session out of records and audit
 *
 * Every verb takes `--json`, shows a real example in `--help`, and accepts the global flags in either position.
 */
const GLOBAL_ONLY =
  /^(--json|--no-color|--ascii|--width|--claude-dir|--codex-dir|--potsherd-dir|--debug|\d+|\/.*|~.*)$/;

const publicCommandName=process.env['POTSHERD_CLI_PUBLIC_NAME']==='slopie'?'slopie':'potsherd';
function publicHelpText(text:string):string{return publicCommandName==='slopie'?text.replace(/\bpotsherd(?=\s|:)/g,'slopie'):text;}
function addGlobals(cmd: Command): Command {
  // An error inside a verb should point at that verb's help, not at the list
  // of twenty verbs: `potsherd setup --nosuch` used to answer "run potsherd
  // --help for the list of verbs", which is the one page that cannot say what
  // `--nosuch` should have been. `05` asks every error for the one command
  // that fixes it, and for a mistyped flag that command names the verb.
  const name = cmd.name();
  if (name && name !== publicCommandName) {
    // Short enough that the longest verb name still fits 60 columns: `(run
    // potsherd export --help  for its flags and an example)` is 59.
    cmd.showHelpAfterError(`(run  ${publicCommandName} ${name} --help  for its flags and an example)`);
  }
  return cmd
    .option('--json', 'machine-readable output, same data as the human view')
    .option('--no-color', 'disable colour (NO_COLOR is honoured too)')
    .option('--ascii', 'ASCII-only glyphs, for terminals without a unicode font')
    .addOption(new Option('--width <n>', 'render for this terminal width').argParser(Number))
    .option('--claude-dir <path>', 'read Claude Code data from here (CLAUDE_CONFIG_DIR is honoured)')
    .option('--codex-dir <path>', 'read Codex data from this enrolled root')
    .option('--pi-dir <path>', 'read pi data from this enrolled root')
    .option('--opencode-dir <path>', 'read OpenCode data from this enrolled root')
    .option('--potsherd-dir <path>', "potsherd's own directory (default ~/.potsherd)")
    .option('--debug', 'print full errors');
}


function main(argv: string[]): void {
  const program = new Command();
  program.configureOutput({writeOut:text=>{process.stdout.write(publicHelpText(text));},writeErr:text=>{process.stderr.write(publicHelpText(text));}});
  addGlobals(
    program
      .name(publicCommandName)
      .description('audit your coding-agent history, and keep every session as plain text your agents can search')
      .version(VERSION, '-v, --version')
      .showHelpAfterError(`(run  ${publicCommandName} --help  for the list of verbs)`),
  );

  const audit = addGlobals(
    program
      .command('audit')
      .description('your year with coding agents: a Wrapped computed from local history')
      .option('--overview', 'open the terminal audit (the default)')
      .option('--tone <tone>', 'voice override: elegant,witty,chaotic,roast')
      .option('--online', 'opt in: let a free hosted model (OpenCode Zen / TypeSafe Jev) polish story wording; sends aggregates and a few filtered quotes')
      .option('--plain', 'print the new overview without interactive controls')
      .option('--no-motion', 'keep the new terminal view still')
      .option('--private', 'show project names in the new private explorer')
      .option('--harness <list>', 'scope the overview to claude,codex,pi,opencode,cursor,gemini,copilot')
      .option('--project <path>', 'scope the overview to this project')
      .option('--since <when>', 'overview events on or after this date')
      .option('--until <when>', 'overview events on or before this date')
      .option('--timezone <zone>', 'calendar timezone for the overview')
      .option('--export <path>', 'save a public-safe overview SVG')

  ).addHelpText('after', `
example:
  potsherd audit
  potsherd audit --plain
  potsherd audit --harness codex --since 2026-09-01
  potsherd audit --export ~/Desktop/audit.svg

also brings the session records (~/.slopie/records) current in the background.`);
  audit.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, audit, opts);
    await run(
      () => runAudit({ ...o,
        overview: Boolean(opts['overview']), plain: Boolean(opts['plain']), online: Boolean(opts['online']),
        private: Boolean(opts['private']), motion: opts['motion'] !== false,
        harness: opts['harness'] as string | undefined, project: opts['project'] as string | undefined,
        since: opts['since'] as string | undefined, until: opts['until'] as string | undefined,
        timezone: opts['timezone'] as string | undefined, tone:opts['tone'] as string|undefined, export: opts['export'] as string | undefined }),
      o,
    );
  });

  const records = (cmd: Command) => cmd.option('--records-dir <path>', 'records directory (default ~/.slopie/records; SLOPIE_RECORDS_DIR)');

  const sync = addGlobals(records(
    program
      .command('sync')
      .description('write every session as a plain-text record (incremental), plus INDEX.tsv and the search index')
      .option('--full', 'rewrite every record and rebuild the index')
      .option('--sidecar', 'also write <record>.out.txt with full tool outputs (up to 20 kB each)')
      .addOption(new Option('--threads <n>', 'parser threads').argParser(Number))
      .option('--if-idle', 'do nothing when another sync is running')
      .option('-q, --quiet', 'print nothing on success'),
  )).addHelpText('after', `
example:
  potsherd sync
  potsherd sync --json | jq .seconds
  SLOPIE_RECORDS_DIR=/tmp/recs potsherd sync --full

one plain-text record per session under ~/.slopie/records (mode 0700).
sessions the harness later deletes keep their record;
forget and ignore remove them.`);
  sync.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, sync, opts);
    await run(() => runSync({...o, ...rec(opts), full: Boolean(opts['full']), ...(opts['sidecar'] ? {sidecar: true} : {}),
      ...(opts['threads'] ? {threads: Number(opts['threads'])} : {}), ifIdle: Boolean(opts['ifIdle'])}), o);
  });

  const search = addGlobals(records(
    program
      .command('search')
      .description('find passages in every past session (ranked; each hit ends with the read command for it)')
      .argument('<query...>', 'words or exact strings')
      .addOption(new Option('-k <n>', 'passages to return (default 8, max 30)'))
      .option('--project <text>', 'only sessions whose working directory contains this')
      .addOption(new Option('--harness <name>', 'only this harness').choices(['claude', 'codex', 'pi']))
      .option('--since <iso>', 'only passages at or after this date/time')
      .option('--until <iso>', 'only passages at or before this date/time')
      .option('--session <id>', 'search inside one session (id or 8+ char prefix)'),
  )).addHelpText('after', `
example:
  potsherd search pgbouncer pool size
  potsherd search "ECONNREFUSED 5432" --project api --since 2026-10-01
  potsherd search deploy --session 9c4d2f18`);
  search.action((query: string[], opts: Record<string, unknown>) => {
    const o = globals(program, search, opts);
    void run(async () => runSearch({...o, ...rec(opts), query: query.join(' '), k: opts['k'], project: str(opts['project']), harness: str(opts['harness']),
      since: str(opts['since']), until: str(opts['until']), session: str(opts['session'])}), o);
  });

  const read = addGlobals(records(
    program
      .command('read')
      .description("read a past session's turns (tool output shortened); --from -30 reads the last 30")
      .argument('<session>', 'session id or 8+ char prefix')
      .addOption(new Option('--from <n>', 'first turn (negative counts from the end)'))
      .addOption(new Option('--to <n>', 'last turn (default from+39)'))
      .addOption(new Option('--max-chars <n>', 'character budget (default 12000, max 40000)'))
      .addOption(new Option('--from-char <n>', 'resume inside the --from turn at this character (from a cut reply)')),
  )).addHelpText('after', `
example:
  potsherd read 9c4d2f18
  potsherd read 9c4d2f18 --from 120 --to 140
  potsherd read 9c4d2f18 --from -30`);
  read.action((session: string, opts: Record<string, unknown>) => {
    const o = globals(program, read, opts);
    void run(async () => runRead({...o, ...rec(opts), session, from: opts['from'], to: opts['to'], maxChars: opts['maxChars'], fromChar: opts['fromChar']}), o);
  });

  const threads = addGlobals(records(
    program
      .command('threads')
      .description('list sessions newest first; --text lists EVERY thread containing all the words')
      .option('--project <text>', 'working-directory substring')
      .addOption(new Option('--harness <name>', 'only this harness').choices(['claude', 'codex', 'pi']))
      .option('--since <iso>', 'threads active at or after this date/time')
      .option('--until <iso>', 'threads active at or before this date/time')
      .option('--text <words>', 'only threads whose transcript contains all of these words')
      .option('--subagents', 'also list subagent threads')
      .option('--parent <id>', 'the child threads (subagents, forks) of this session')
      .addOption(new Option('--limit <n>', 'max rows (default 40, max 200)'))
      .addOption(new Option('--offset <n>', 'skip this many rows')),
  )).addHelpText('after', `
example:
  potsherd threads --project slopie --since 2026-10-20
  potsherd threads --text "vercel deploy" --subagents
  potsherd threads --parent 9c4d2f18`);
  threads.action((opts: Record<string, unknown>) => {
    const o = globals(program, threads, opts);
    void run(async () => runThreads({...o, ...rec(opts), project: str(opts['project']), harness: str(opts['harness']), since: str(opts['since']), until: str(opts['until']),
      text: str(opts['text']), subagents: Boolean(opts['subagents']), parent: str(opts['parent']), limit: opts['limit'], offset: opts['offset']}), o);
  });

  const grep = addGlobals(records(
    program
      .command('grep')
      .description('every occurrence of an exact string in ONE session, including full tool output')
      .argument('<session>', 'session id or 8+ char prefix')
      .argument('<pattern>', 'literal text (case-insensitive)')
      .option('--regex', 'treat the pattern as a regular expression')
      .addOption(new Option('--offset <n>', 'skip this many matches')),
  )).addHelpText('after', `
example:
  potsherd grep 9c4d2f18 "No space left on device"
  potsherd grep 9c4d2f18 'max_connections\\s*=\\s*\\d+' --regex`);
  grep.action((session: string, pattern: string, opts: Record<string, unknown>) => {
    const o = globals(program, grep, opts);
    void run(async () => runGrep({...o, ...rec(opts), session, pattern, regex: Boolean(opts['regex']), offset: opts['offset']}), o);
  });

  const mcp = addGlobals(records(
    program
      .command('mcp')
      .description('serve search, read, threads and grep as a stdio MCP server (for harnesses without a shell)'),
  )).addHelpText('after', `
example:
  potsherd mcp                                       # speaks MCP on stdin/stdout
  claude mcp add slopie -- slopie mcp`);
  mcp.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, mcp, opts);
    await run(() => runMcp({...o, ...rec(opts)}), o);
  });

  const hook = addGlobals(records(
    program
      .command('hook')
      .description('session-start hook: keep records current; on resume/compaction print where this session is')
      .argument('<event>', 'session-start')
      .addOption(new Option('--harness <name>', 'the calling harness').choices(['claude', 'codex', 'pi']).default('claude')),
  )).addHelpText('after', `
example (what slopie setup installs):
  echo '{"session_id":"9c4d2f18-…","source":"compact"}' | potsherd hook session-start --harness claude`);
  hook.action(async (event: string, opts: Record<string, unknown>) => {
    const o = globals(program, hook, opts);
    await run(() => runHook({...o, ...rec(opts), event, harness: str(opts['harness'])}), o);
  });

  const setup = addGlobals(
    program
      .command('setup')
      .description('install the memory note (skill / AGENTS.md / pi extension) and the session-start hook')
      .option('--all', 'every detected agent (the default when none is named)')
      .option('--dry-run', 'print every change, write nothing')
      .option('--status', 'what is installed where')
      .option('--remove', 'take it all out again')
      .option('--note', 'print the note it installs (paste it into any other agent) and exit')
      .option('-y, --yes', 'do not ask'),
  );
  for (const id of SETUP_CLIENTS) setup.option(`--${id}`, `only ${id}`);
  setup.addHelpText('after', `
example:
  potsherd setup                                     # every agent found on this machine
  potsherd setup --claude --dry-run                  # show the diff, write nothing
  potsherd setup --status
  potsherd setup --note                              # the note itself, for any other agent
  potsherd setup --remove`);
  setup.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, setup, opts);
    const clients = SETUP_CLIENTS.filter((id) => opts[id]);
    await run(
      () => runSetup({ ...o, clients, all: Boolean(opts['all']), dryRun: Boolean(opts['dryRun']), status: Boolean(opts['status']), remove: Boolean(opts['remove']), note: Boolean(opts['note']) }),
      o,
    );
  });

  const doctor = addGlobals(
    program
      .command('doctor')
      .description('what slopie can see, what it keeps, and what is installed'),
  ).addHelpText('after', `
example:
  potsherd doctor
  potsherd doctor --json | jq .records`);
  doctor.action(async (opts: Record<string, unknown>) => {
    const o = globals(program, doctor, opts);
    await run(() => runDoctor(o), o);
  });

  const ignore = addGlobals(
    program
      .command('ignore')
      .description('keep a project out of the records and the audit; none at all prints the list')
      .argument('[project]', 'a directory name, or a path'),
  ).addHelpText('after', `
example:
  potsherd ignore scratch                            # a directory name: that segment anywhere
  potsherd ignore ~/work/client-x                    # or a path and everything under it
  potsherd ignore                                    # what is ignored now
  potsherd unignore scratch

the next sync removes ignored projects' records (and never writes them again);
the audit leaves them out of its numbers. stored in ~/.slopie/config.json`);
  ignore.action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, ignore, opts);
    await run(() => runIgnore({ ...o, ...(project ? { project } : {}) }), o);
  });

  const unignore = addGlobals(
    program
      .command('unignore')
      .description('take a project off the ignore list')
      .argument('<project>', 'the entry as  potsherd ignore  stored it'),
  ).addHelpText('after', `
example:
  potsherd unignore scratch
  potsherd ignore                                    # what is left`);
  unignore.action(async (project: string, opts: Record<string, unknown>) => {
    const o = globals(program, unignore, opts);
    await run(() => runIgnore({ ...o, project, remove: true }), o);
  });

  const forget = addGlobals(records(
    program
      .command('forget')
      .description('remove one session from the records and the audit, now and on every later sync')
      .argument('[session]', 'session id (or an 8+ char prefix the records know); none prints the list'),
  )).addHelpText('after', `
example:
  potsherd forget 9c4d2f18
  potsherd forget                                    # the list
  potsherd unforget 9c4d2f18

the native transcript is never touched: forgetting is slopie's copy and numbers only.
stored in ~/.slopie/forget.json`);
  forget.action(async (session: string | undefined, opts: Record<string, unknown>) => {
    const o = globals(program, forget, opts);
    await run(() => runForget({...o, ...rec(opts), ...(session ? {session} : {})}), o);
  });

  const unforget = addGlobals(records(
    program
      .command('unforget')
      .description('take a session off the forget list (the next sync writes its record again)')
      .argument('<session>', 'the session id'),
  )).addHelpText('after', `
example:
  potsherd unforget 9c4d2f18`);
  unforget.action(async (session: string, opts: Record<string, unknown>) => {
    const o = globals(program, unforget, opts);
    await run(() => runForget({...o, ...rec(opts), session, remove: true}), o);
  });

  const globalsOnly = argv.slice(2).every((a) => GLOBAL_ONLY.test(a));
  if (argv.length <= 2 || globalsOnly) {
    const i = argv.indexOf('--width');
    tour({
      ...(i >= 0 && argv[i + 1] ? { width: Number(argv[i + 1]) } : {}),
      ascii: argv.includes('--ascii'),
      color: !argv.includes('--no-color'),
      json: argv.includes('--json'),
    });
    return;
  }
  program.parseAsync(argv).catch((err: unknown) => fail(err, {}));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const rec = (opts: Record<string, unknown>): {recordsDir?: string} => (typeof opts['recordsDir'] === 'string' ? {recordsDir: opts['recordsDir']} : {});

function globals(program: Command, cmd: Command, local: Record<string, unknown>): GlobalOptions {
  const g = program.opts();
  const pick = <T>(key: string): T | undefined =>
    (local[key] !== undefined ? local[key] : g[key]) as T | undefined;

  const width = pick<number>('width');
  const claudeDir = pick<string>('claudeDir');
  const codexDir = pick<string>('codexDir');
  const piDir = pick<string>('piDir');
  const opencodeDir = pick<string>('opencodeDir');
  const potsherdDir = pick<string>('potsherdDir');
  void cmd;
  return {
    json: Boolean(pick<boolean>('json')),
    color: local['color'] === false || g['color'] === false ? false : true,
    ascii: Boolean(pick<boolean>('ascii')),
    ...(width ? { width: Number(width) } : {}),
    debug: Boolean(pick<boolean>('debug')),
    ...(claudeDir ? { claudeDir: String(claudeDir) } : {}),
    ...(codexDir ? { codexDir: String(codexDir) } : {}),
    ...(piDir ? { piDir: String(piDir) } : {}),
    ...(opencodeDir ? { opencodeDir: String(opencodeDir) } : {}),
    ...(potsherdDir ? { potsherdDir: String(potsherdDir) } : {}),
    quiet: Boolean(local['quiet']),
    yes: Boolean(local['yes']),
  };
}

async function run(fn: () => Promise<number>, o: GlobalOptions): Promise<void> {
  try {
    const code = await fn();
    if (code) process.exitCode = code;
  } catch (err) {
    fail(err, o);
  }
}

const VERBS: [string, string][] = [
  ['audit', 'your year with coding agents, from local history'],
  ['sync', 'every session as a plain-text record your agents can search'],
  ['search', 'find passages in every past session'],
  ['read', "read a session's turns; --from -30 for the end"],
  ['threads', 'sessions by project and date; --text for every match'],
  ['grep', 'every occurrence of a string in one session'],
  ['setup', 'teach your agents the records (skill, AGENTS.md, pi)'],
];
const REST = ['mcp', 'doctor', 'ignore', 'unignore', 'forget', 'unforget'];

function tour(o: { width?: number; ascii?: boolean; color?: boolean; json?: boolean } = {}): void {
  const t = themeFrom(o);
  if (o.json) {
    printJson({version: VERSION, verbs: VERBS.map(([verb, what]) => ({verb, what})), also: REST, start: `${publicCommandName} audit`});
    return;
  }
  const wide = t.width >= 80;
  print('');
  print(`  ${t.bold(publicCommandName)} ${t.dim(VERSION)}  ${t.dim(`${t.g('—', '-')} ${wide ? 'your coding-agent history, audited and kept as plain text' : 'audit and records'}`)}`);
  print('');
  for (const [verb, what] of VERBS) print(wide ? `    ${publicCommandName} ${verb.padEnd(8)} ${t.dim(what)}` : `    ${verb.padEnd(8)} ${t.dim(what.slice(0, Math.max(10, t.width - 14)))}`);
  print('');
  print(t.dim(`  also:  ${REST.join('  ')}`));
  print(t.dim(`         ${publicCommandName} help <verb> for any of them`));
  print('');
  print(`  start here:  ${t.accent(`${publicCommandName} audit`)}`);
  print('');
}

if(process.argv[2]==='__audit_worker'&&process.send){
  void import('./audit-background.js').then(({runAuditWorkerHost})=>runAuditWorkerHost());
}else main(process.argv);
