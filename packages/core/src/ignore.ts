import fs from 'node:fs';
import path from 'node:path';
import { configPath, expandTilde, potsherdDir } from './paths.js';

/**
 * The ignore list: projects you do not want slopie to keep or count.
 *
 * Nothing is ignored by default; the user names projects with `slopie ignore <project>` and takes them back with
 * `slopie unignore <project>`. The audit leaves ignored projects out of its numbers, and `slopie sync` removes
 * their sessions from the records (and the search index) and does not write them again.
 *
 * Storage is `~/.slopie/config.json` (1.9). Until that file exists the 1.8 file `~/.potsherd/config.json` is
 * read, read-only; the first write seeds the new file from it. The writer preserves every key it does not own.
 */

/** The key this module owns inside `config.json`. Everything else is left alone. */
export const IGNORE_KEY = 'ignore';

export interface IgnoreConfig {
  /** The list as stored, in the order it was written. */
  list: string[];
  /** Every other key in the file, preserved across writes. */
  rest: Record<string, unknown>;
  /**
   * Set when the file exists and could not be understood. The list is then
   * empty — but `doctor` says the file is unreadable rather than reporting an
   * empty list, because "you ignore nothing" and "I could not read your
   * settings" are different facts and only one of them is actionable.
   */
  error?: string;
  /** The file this came from, whether or not it exists. */
  file: string;
}

/**
 * Read `<root>/config.json`.
 *
 * A missing file is not an error: it is the normal state of a fresh install
 * and means an empty list. A malformed one is reported rather than repaired —
 * this file belongs to the user once they have opened it.
 */
export function readIgnoreConfig(root: string = potsherdDir()): IgnoreConfig {
  const file = configPath(root);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Missing is the fresh-install state; anything else (permissions, a directory) is unreadable, not empty.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], rest: {}, file };
    return { list: [], rest: {}, file, error: `config.json could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { list: [], rest: {}, file, error: 'config.json is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { list: [], rest: {}, file, error: 'config.json is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const { [IGNORE_KEY]: raw, ...rest } = record;
  if (raw === undefined) return { list: [], rest, file };
  if (!Array.isArray(raw)) {
    return { list: [], rest, file, error: `config.json "${IGNORE_KEY}" is not an array` };
  }
  const list: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const entry = normalizeIgnoreEntry(value);
    if (entry && !list.some((e) => sameEntry(e, entry))) list.push(entry);
  }
  return { list, rest, file };
}

/** Just the list. The shape every caller inside the engine wants. */
export function readIgnoreList(root: string = potsherdDir()): string[] {
  return readIgnoreConfig(root).list;
}

/**
 * Write the list back, preserving every other key.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write leaves the
 * old config rather than half of a new one, and created 0600 because
 * `~/.potsherd` holds copies of transcripts and this file sits beside them.
 */
export function writeIgnoreList(root: string, list: readonly string[]): string[] {
  const current = readIgnoreConfig(root);
  const clean: string[] = [];
  for (const value of list) {
    const entry = normalizeIgnoreEntry(value);
    if (entry && !clean.some((e) => sameEntry(e, entry))) clean.push(entry);
  }
  const next = { ...current.rest, [IGNORE_KEY]: clean };
  const file = current.file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

export interface IgnoreChange {
  /** The list after the change. */
  list: string[];
  /** The entry as it was stored or removed, normalised. */
  entry: string;
  /** False when the entry was already there (`ignore`) or absent (`unignore`). */
  changed: boolean;
}

/** `potsherd ignore <project>`. Idempotent, and says so rather than pretending. */
export function addIgnored(root: string, project: string): IgnoreChange {
  const entry = normalizeIgnoreEntry(project);
  if (!entry) throw new Error('an ignore entry needs at least one character that is not a slash');
  const before = readIgnoreList(root);
  if (before.some((e) => sameEntry(e, entry))) return { list: before, entry, changed: false };
  const list = writeIgnoreList(root, [...before, entry]);
  return { list, entry, changed: true };
}

/** `potsherd unignore <project>`. */
export function removeIgnored(root: string, project: string): IgnoreChange {
  const entry = normalizeIgnoreEntry(project);
  if (!entry) throw new Error('an ignore entry needs at least one character that is not a slash');
  const before = readIgnoreList(root);
  if (!before.some((e) => sameEntry(e, entry))) return { list: before, entry, changed: false };
  const list = writeIgnoreList(
    root,
    before.filter((e) => !sameEntry(e, entry)),
  );
  return { list, entry, changed: true };
}

/**
 * What the user typed, as it will be stored.
 *
 * `~` is expanded because a stored `~/code/potsherd` would never match a
 * project recorded as `/Users/me/code/potsherd`, and a trailing slash is
 * dropped because `potsherd/` and `potsherd` are the same directory to
 * everyone except a string comparison.
 */
export function normalizeIgnoreEntry(value: string): string {
  const trimmed = expandTilde(value.trim());
  return trimmed.replace(/[\\/]+$/, '');
}

function fold(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sameEntry(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/**
 * Does this entry name this project?
 *
 * Two forms, and the difference is whether the user typed a slash.
 *
 *   `potsherd`                a **path segment**. Matches
 *                             `/Users/me/randomness/potsherd` and everything
 *                             under it, including
 *                             `/Users/me/randomness/potsherd/wt/w3-ignore`.
 *                             It does **not** match `potsherd-notes`: the
 *                             segment must be the whole segment, or `ignore
 *                             core` would hide `core-app` and the user would
 *                             have no way to tell it had.
 *
 *   `~/randomness/potsherd`   a **path**. Matches that directory and its
 *                             descendants, and nothing else. This is the form
 *                             to reach for when the same directory name
 *                             appears in two places and only one of them is
 *                             noise.
 *
 * The segment form is the default because it is the one that works: potsherd's
 * own sessions on the reference machine are spread across the checkout, six
 * git worktrees and a `.claude/worktrees/agent-*` directory, and a rule that
 * matched only the exact path the user typed would hide one of eight.
 */
export function matchesIgnoreEntry(project: string | null | undefined, entry: string): boolean {
  if (!project) return false;
  const p = fold(project);
  const e = fold(entry);
  if (!p || !e) return false;
  if (p === e) return true;
  if (e.includes('/')) return p.startsWith(`${e}/`);
  return p.split('/').filter(Boolean).includes(e);
}

/** True when any entry in the list names this project. */
export function isIgnoredProject(
  project: string | null | undefined,
  entries: readonly string[],
): boolean {
  return entries.some((entry) => matchesIgnoreEntry(project, entry));
}
