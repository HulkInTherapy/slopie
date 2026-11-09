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
  error: string | null;
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

/** The 1.9 forget list, or null when it does not exist yet. */
export function readForgetList(slopieRoot = paths.slopieDir()): ForgetEntry[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(forgetPath(slopieRoot), 'utf8')) as {forgotten?: unknown};
    return Array.isArray(raw.forgotten) ? (raw.forgotten as ForgetEntry[]).filter(e => e && typeof e.sourceId === 'string') : [];
  } catch {
    return null;
  }
}

export function writeForgetList(list: readonly ForgetEntry[], slopieRoot = paths.slopieDir()): void {
  fs.mkdirSync(slopieRoot, {recursive: true, mode: 0o700});
  const file = forgetPath(slopieRoot), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, forgotten: list}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

/** Opt-outs, read once: the `slopie ignore` list and the sources the user asked slopie to forget. */
export function loadPolicy(potsherdRoot: string, slopieRoot = paths.slopieDir()): Policy {
  const policy: Policy = {ignoredList: [], forgotten: new Set(), ignored: () => false, error: null};
  const fresh = fs.existsSync(paths.configPath(slopieRoot));
  const config = readIgnoreConfig(fresh ? slopieRoot : potsherdRoot);
  if (config.error) policy.error = 'ignore_policy_unreadable';
  policy.ignoredList = config.list;
  if (config.list.length) policy.ignored = project => !!project && isIgnoredProject(project, config.list);
  const list = readForgetList(slopieRoot);
  if (list) {
    for (const e of list) policy.forgotten.add(e.sourceId);
  } else {
    const legacy = legacyForgotten(potsherdRoot);
    for (const id of legacy.ids) policy.forgotten.add(id);
    if (legacy.error) policy.error ??= 'forget_list_unreadable';
  }
  return policy;
}
