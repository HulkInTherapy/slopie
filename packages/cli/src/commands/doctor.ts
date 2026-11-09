import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { VERSION, discover, loadPolicy, paths, readForgetList, sqliteDriverName, stateDir } from '@potsherd/core';
import { fold, print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { runSetup } from './setup.js';

/**
 * `slopie doctor`: what slopie can see, what it keeps, what is installed. Read-only.
 *
 * It also says what is no longer used: potsherd 1.x kept a store under ~/.potsherd (potsherd.db, archive/,
 * models/, cards/). 1.9 never writes or deletes there except the audit's own cache (audit-derived/); after one
 * `slopie sync` the records hold every archived session, so the rest is safe to remove by hand.
 */
export async function runDoctor(o: GlobalOptions): Promise<number> {
  const t = themeFrom(o);
  const opts = {...(o.claudeDir ? {claudeDir: o.claudeDir} : {}), ...(o.codexDir ? {codexDir: o.codexDir} : {}), ...(o.piDir ? {piDir: o.piDir} : {}), ...(o.potsherdDir ? {potsherdDir: o.potsherdDir} : {})};
  const found = discover(['claude', 'codex', 'pi'], opts);
  const census = Object.fromEntries([...found.census].map(([h, r]) => [h, {files: r.files, bytes: r.bytes}]));
  const records = paths.recordsDir();
  const state = ((): {sessions?: Record<string, unknown>} | null => {
    try { return JSON.parse(fs.readFileSync(path.join(stateDir(records), 'state.json'), 'utf8')) as {sessions?: Record<string, unknown>}; } catch { return null; }
  })();
  const index = path.join(stateDir(records), 'index.sqlite');
  let mode: string | null = null;
  try { mode = (fs.statSync(records).mode & 0o777).toString(8); } catch { /* none */ }
  const policy = loadPolicy(paths.potsherdDir(o.potsherdDir));
  const legacy = paths.potsherdDir(o.potsherdDir);
  const legacyParts = ['potsherd.db', 'archive', 'models', 'cards'].filter(p => fs.existsSync(path.join(legacy, p)));
  const report = {
    version: VERSION,
    node: process.version,
    sqlite: sqliteDriverName(),
    sources: census,
    records: {dir: records, built: !!state, sessions: state?.sessions ? Object.keys(state.sessions).length : 0, mode, index: fs.existsSync(index) ? fs.statSync(index).size : 0},
    privacy: {ignored: policy.ignoredList, forgotten: policy.forgotten.size, forgetFile: (() => { try { return readForgetList() !== null; } catch { return true; } })(),
      error: policy.errorDetail},
    legacy: {dir: legacy, present: legacyParts, unused: legacyParts.length > 0},
  };
  if (o.json) { printJson(report); return 0; }
  const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
  // Paths and lists are the user's and can be any length: wrapped to the terminal (--json has them whole).
  const say = (text: string, style: (s: string) => string = s => s, indent = 2) => {
    fold(text, Math.max(20, t.width - indent - 2)).forEach((row, i) => print(' '.repeat(i ? indent + 2 : indent) + style(row)));
  };
  print(`${t.bold('slopie')} ${VERSION}`);
  say(`node ${process.version} · sqlite ${report.sqlite ?? 'unavailable (search needs better-sqlite3 or node:sqlite)'}`, s => t.dim(s));
  print('');
  print(t.dim('sources (read-only)'));
  for (const [h, r] of Object.entries(census)) print(`  ${h.padEnd(8)}${String(r.files).padStart(6)} files  ${mb(r.bytes)}`);
  print('');
  print(t.dim('records'));
  if (state) {
    say(paths.tildify(records));
    say(`${report.records.sessions} sessions · mode ${mode} · index ${mb(report.records.index)}`);
  } else print(`  not built yet: ${t.accent('slopie sync')}`);
  say(`ignored projects: ${policy.ignoredList.length ? policy.ignoredList.join(', ') : 'none'} · forgotten sessions: ${policy.forgotten.size}`);
  if (policy.errorDetail) say(`unreadable opt-outs: ${policy.errorDetail}; sync and audit stop until it is fixed`, s => t.warn(s));
  print('');
  print(t.dim('agents'));
  await runSetup({...o, json: false, status: true});
  if (legacyParts.length) {
    print('');
    print(t.dim('no longer used'));
    say(paths.tildify(legacy));
    say(`${legacyParts.join(', ')}: potsherd 1.x data that slopie 1.9 does not use (only audit-derived/ is still used: the audit's cache).`);
    say(`${state ? 'The records hold the archived sessions, so they are' : 'After one  slopie sync  they are'} safe to remove by hand. slopie never deletes them.`);
  }
  return 0;
}
