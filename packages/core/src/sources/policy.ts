/**
 * The user's opt-outs, read once and applied by both the audit and the records:
 *   - the `slopie ignore` list (projects), and
 *   - the sources the user asked slopie to forget.
 *
 * 1.9.0 keeps them in ~/.slopie (config.json, forget.json). Until those files exist, the 1.8 locations
 * (~/.potsherd/config.json and the forget tombstones in ~/.potsherd/potsherd.db) are read, read-only,
 * so an upgrade changes nothing; the first `slopie ignore` / `slopie forget` seeds the new files from them.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../paths.js';
import {readIgnoreConfig, isIgnoredProject} from '../ignore.js';
import {openDatabase} from '../sqlite-driver.js';

export interface Policy {
  ignoredList: string[];
  forgotten: Set<string>;
  ignored(project: string | null): boolean;
  /** Set when an opt-out file exists but cannot be read or understood: the opt-outs are then unknown. */
  error: string | null;
  /** What was wrong, and with which file (for the user). */
  errorDetail: string | null;
}

/**
 * An opt-out file exists but cannot be read or understood. Nothing that writes records (or counts or sends
 * anything) may go on: carrying on would silently undo the user's ignore / forget choices.
 */
export class PolicyError extends Error {
  readonly fix = 'repair or move that file aside, then run the command again';
  constructor(readonly code: string, readonly detail: string) {
    super(`cannot read ${detail}; slopie stops rather than undo your ignore / forget choices.`);
  }
}

/** Stops when the opt-outs could not be established. */
export function assertPolicy(policy: Policy): void {
  if (policy.error) throw new PolicyError(policy.error, policy.errorDetail ?? policy.error);
}

/** Source ids (sourceId(harness, native id)) in the legacy store's forget tombstones; read-only. */
export function legacyForgotten(potsherdRoot: string): {ids: Set<string>; error: boolean} {
  const ids = new Set<string>();
  const dbFile = paths.dbPath(potsherdRoot);
  if (!fs.existsSync(dbFile)) return {ids, error: false};
  try {
    const db = openDatabase(dbFile, {readonly: true, fileMustExist: true});
    try {
      const rows = db.prepare(`SELECT source_id FROM memory_sources WHERE availability='forgotten'
        UNION SELECT source_id FROM forget_tombstones WHERE state<>'reversed' AND source_id IS NOT NULL`).all() as {source_id: string}[];
      for (const row of rows) ids.add(row.source_id);
    } finally {
      db.close();
    }
    return {ids, error: false};
  } catch {
    return {ids, error: true};
  }
}

export interface ForgetEntry {sourceId: string; harness?: string; id?: string; at?: string}

export function forgetPath(slopieRoot = paths.slopieDir()): string {
  return path.join(slopieRoot, 'forget.json');
}

/**
 * The 1.9 forget list, or null when it does not exist yet. Throws PolicyError when the file exists but cannot
 * be read or is not a forget list: "nothing is forgotten" and "the list is unreadable" are different facts.
 */
export function readForgetList(slopieRoot = paths.slopieDir()): ForgetEntry[] | null {
  const file = forgetPath(slopieRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PolicyError('forget_list_unreadable', `${file} (${(e as NodeJS.ErrnoException).code ?? 'unreadable'})`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PolicyError('forget_list_unreadable', `${file} (not valid JSON)`); }
  const list = raw && typeof raw === 'object' ? (raw as {forgotten?: unknown}).forgotten : undefined;
  if (!Array.isArray(list)) throw new PolicyError('forget_list_unreadable', `${file} (no "forgotten" list)`);
  return (list as ForgetEntry[]).filter(e => e && typeof e.sourceId === 'string');
}

export function writeForgetList(list: readonly ForgetEntry[], slopieRoot = paths.slopieDir()): void {
  fs.mkdirSync(slopieRoot, {recursive: true, mode: 0o700});
  const file = forgetPath(slopieRoot), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, forgotten: list}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

/** Opt-outs, read once: the `slopie ignore` list and the sources the user asked slopie to forget. */
export function loadPolicy(potsherdRoot: string, slopieRoot = paths.slopieDir()): Policy {
  const policy: Policy = {ignoredList: [], forgotten: new Set(), ignored: () => false, error: null, errorDetail: null};
  const fail = (code: string, detail: string) => { if (!policy.error) { policy.error = code; policy.errorDetail = detail; } };
  // lstat, not exists: a config.json that is there but unreadable must not fall back to the 1.8 file.
  const fresh = (() => { try { fs.lstatSync(paths.configPath(slopieRoot)); return true; } catch { return false; } })();
  const config = readIgnoreConfig(fresh ? slopieRoot : potsherdRoot);
  if (config.error) fail('ignore_policy_unreadable', `${config.file} (${config.error})`);
  policy.ignoredList = config.list;
  if (config.list.length) policy.ignored = project => !!project && isIgnoredProject(project, config.list);
  let list: ForgetEntry[] | null = null;
  try { list = readForgetList(slopieRoot); } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    fail(e.code, e.detail);
  }
  if (list) {
    for (const e of list) policy.forgotten.add(e.sourceId);
  } else if (policy.error !== 'forget_list_unreadable') {
    const legacy = legacyForgotten(potsherdRoot);
    for (const id of legacy.ids) policy.forgotten.add(id);
    if (legacy.error) fail('forget_list_unreadable', `${paths.dbPath(potsherdRoot)} (the 1.8 forget list)`);
  }
  return policy;
}
