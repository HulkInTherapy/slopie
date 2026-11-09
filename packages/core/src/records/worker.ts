/**
 * Parsing one native file into a record-ready session, inline or on a worker thread.
 */
import os from 'node:os';
import {Worker, parentPort} from 'node:worker_threads';
import {readSession, type Harness} from '../sources/sessions.js';
import {recSession, type RecSession} from './format.js';

export interface ParseJob {
  file: string;
  /** 'auto': an archive copy whose harness is read from its content (compressed copies are Codex). */
  harness: Harness | 'auto';
  /** Claude subagent parent from the path, when the file sits under `<sid>/subagents/`. */
  sub: string | null;
  size: number;
  sidecar: boolean;
}

export type ParseResult = {file: string; status: 'ok'; session: RecSession} | {file: string; status: 'none'} | {file: string; status: 'err'; err: string};

export function parseJob(job: ParseJob): ParseResult {
  try {
    const harness: Harness = job.harness === 'auto' ? 'codex' : job.harness;
    const lim = job.sidecar ? {output: 30000} : {};
    const s = readSession(job.file, harness, job.sub, lim);
    if (!s || !s.id) return {file: job.file, status: 'none'};
    return {file: job.file, status: 'ok', session: recSession(s, job.sidecar)};
  } catch (e) {
    return {file: job.file, status: 'err', err: `${job.file}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)};
  }
}

/** Entry point of the worker bundle. */
export function runRecordsWorker(): void {
  if (!parentPort) return;
  const port = parentPort;
  port.on('message', (job: ParseJob) => port.postMessage(parseJob(job)));
}

export function defaultSyncThreads(): number {
  const forced = Number(process.env['SLOPIE_SYNC_THREADS']);
  if (Number.isInteger(forced) && forced > 0) return Math.min(forced, 16);
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

/** Runs jobs (largest first) on `threads` workers, or inline when there is no worker entry. */
export async function runJobs(jobs: readonly ParseJob[], onResult: (r: ParseResult) => void, workerUrl: URL | null, threads = defaultSyncThreads()): Promise<void> {
  const order = [...jobs].sort((a, b) => b.size - a.size);
  if (!workerUrl || threads <= 1 || order.length < 4) {
    for (const job of order) onResult(parseJob(job));
    return;
  }
  let next = 0;
  const workers: Worker[] = [];
  try {
    await Promise.all(Array.from({length: Math.min(threads, order.length)}, () => new Promise<void>((resolve, reject) => {
      const w = new Worker(workerUrl, {resourceLimits: {maxOldGenerationSizeMb: Number(process.env['SLOPIE_SYNC_WORKER_MB']) || 1024}});
      workers.push(w);
      let current: ParseJob | null = null;
      const feed = () => {
        if (next >= order.length) { current = null; resolve(); return; }
        current = order[next++]!;
        w.postMessage(current);
      };
      w.on('message', (r: ParseResult) => { onResult(r); feed(); });
      w.on('error', e => {
        // A worker that dies (e.g. out of memory on one huge file) reports that file and is not reused.
        if (current) onResult({file: current.file, status: 'err', err: `${current.file}: ${e.message}`.slice(0, 500)});
        reject(e);
      });
      feed();
    }).catch(() => {
      // Finish the remaining jobs inline rather than lose them.
      while (next < order.length) onResult(parseJob(order[next++]!));
    })));
  } finally {
    await Promise.all(workers.map(w => w.terminate()));
  }
}
