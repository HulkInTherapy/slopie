/**
 * Crash logs for the interactive audit: ~/.slopie/logs/audit-<ISO time>.log (dir 0700, file 0600),
 * redacted, newest 10 kept. A failed audit always leaves something a user can send.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {redactText, VERSION} from '@potsherd/core';

const KEEP = 10;

export interface CrashReport {
  /** Where it failed, e.g. "background worker · run · reading". */
  stage: string;
  error: unknown;
  /** Tail of the worker's stderr, if there was a worker. */
  stderr?: string;
  notes?: string[];
}

export function crashLogDir(): string {
  return process.env['SLOPIE_LOG_DIR'] || path.join(os.homedir(), '.slopie', 'logs');
}

/** `~/…` for paths under home. */
export function tildePath(file: string): string {
  const home = os.homedir();
  return home && (file === home || file.startsWith(home + path.sep)) ? '~' + file.slice(home.length) : file;
}

export function errorText(error: unknown): {message: string; stack: string} {
  if (error instanceof Error) return {message: error.message || error.name, stack: error.stack ?? error.message};
  return {message: String(error), stack: String(error)};
}

function section(report: CrashReport): string {
  const {message, stack} = errorText(report.error);
  const lines = [`stage: ${report.stage}`, `error: ${message}`, 'stack:', stack];
  if (report.stderr?.trim()) lines.push('worker stderr (tail):', report.stderr.trimEnd());
  for (const note of report.notes ?? []) lines.push(`note: ${note}`);
  return lines.join('\n') + '\n';
}

/** Write a new log; returns its path, or null when the log could not be written. */
export function writeCrashLog(report: CrashReport, dir = crashLogDir(), now = new Date()): string | null {
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
    const head = [`slopie ${VERSION}`, `node ${process.version}`, `platform ${process.platform}/${process.arch}`, `time ${now.toISOString()}`, ''].join('\n');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    let file = path.join(dir, `audit-${stamp}.log`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `audit-${stamp}-${n}.log`);
    fs.writeFileSync(file, redactText(head + section(report)), {mode: 0o600, flag: 'wx'});
    prune(dir);
    return file;
  } catch {
    return null;
  }
}

/** Add a later stage (e.g. the in-process fallback) to an existing log. */
export function appendCrashLog(file: string | null, report: CrashReport): string | null {
  if (!file) return writeCrashLog(report);
  try { fs.appendFileSync(file, redactText('\n' + section(report)), {mode: 0o600}); return file; } catch { return file; }
}

function prune(dir: string): void {
  const logs = fs.readdirSync(dir).filter(name => /^audit-.*\.log$/.test(name))
    .map(name => ({name, at: fs.statSync(path.join(dir, name)).mtimeMs})).sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  for (const old of logs.slice(KEEP)) fs.rmSync(path.join(dir, old.name), {force: true});
}
