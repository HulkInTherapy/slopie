import {fork, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createAuditSession, type AuditSession, type AuditOverviewOptions, type AuditSnapshot, type AuditEvent} from '@potsherd/core';
import {createScanPool} from '../../core/src/analytics/scan-pool.js';
import {appendCrashLog, writeCrashLog} from './audit-crash-log.js';

type Request = {kind: 'request'; id: number; op: string; args: unknown[]};
type Pending = {op: string; resolve: (value: any) => void; reject: (error: Error) => void};

/** Worker-thread scan pool next to the bundled CLI, when the asset exists. */
export function localScanPool(): ReturnType<typeof createScanPool> | undefined {
  const entry = new URL('./audit-native-worker.js', import.meta.url);
  return fs.existsSync(entry) ? createScanPool(entry) : undefined;
}

const STDERR_KEEP = 64 * 1024;

type WorkerSession = AuditSession & {
  /** The last ~64 KB the worker wrote to stderr. */
  stderrTail(): string;
  /** Resolves once the worker's stderr is closed (or shortly after it exits). */
  drained(): Promise<void>;
  /** Last op and progress stage, for the crash log. */
  stage(): string;
};

/**
 * The interactive renderer owns this process; the audit runs in a child so keystrokes stay
 * responsive. If the child fails before delivering a result, the same audit re-runs in this
 * process (the --plain code path), and a redacted crash log records what happened.
 */
export function createBackgroundAuditSession(options: AuditOverviewOptions, entry = process.argv[1]!): AuditSession & {logFile(): string | null} {
  const worker = createWorkerSession(options, entry);
  let local: AuditSession | null = null;
  let localBase = 0;
  let logFile: string | null = null;
  let cancelled = false, disposed = false, nextAck = 0;
  const acks = new Map<string, {resolve: () => void; reject: (error: Error) => void}>();
  const shiftSnapshot = (snapshot: AuditSnapshot): AuditSnapshot => (localBase ? {...snapshot, sequence: snapshot.sequence + localBase} : snapshot);
  const shiftEvent = (event: AuditEvent): AuditEvent =>
    event.type === 'snapshot' ? {...event, snapshot: shiftSnapshot(event.snapshot)} : 'sequence' in event ? {...event, sequence: event.sequence + localBase} as AuditEvent : event;

  const runLocal = async (callback: ((event: AuditEvent) => void) | undefined, workerError: unknown, maxSequence: number): Promise<AuditSnapshot> => {
    await worker.drained();
    logFile = writeCrashLog({stage: worker.stage(), error: workerError, stderr: worker.stderrTail(), notes: ['background worker failed before delivering a result; re-running the audit in-process']});
    worker.dispose();
    localBase = maxSequence + 1;
    let stage = 'in-process fallback · starting';
    try {
      if (process.env['SLOPIE_TEST_INPROCESS_FAIL'] === '1') throw new Error('in-process audit failed (SLOPIE_TEST_INPROCESS_FAIL)');
      local = createAuditSession({
        ...options, signal: undefined, sessionIdentity: worker.snapshot().snapshotId, nativeScanExecutor: localScanPool(),
        onTransfer: event => new Promise<void>((resolve, reject) => {
          const ackId = `local-${++nextAck}`;
          acks.set(ackId, {resolve, reject});
          callback?.(shiftEvent({...event, ackId}));
        }),
      });
      if (cancelled) local.cancel();
      const result = await local.run(event => {
        if (event.type === 'progress') stage = `in-process fallback · run · ${event.progress.stage}`;
        if (event.type !== 'transfer') callback?.(shiftEvent(event));
      });
      appendCrashLog(logFile, {stage: 'in-process fallback', error: 'none', notes: [`in-process fallback finished with status ${result.status}`]});
      return shiftSnapshot(result);
    } catch (error) {
      if (cancelled) return local ? shiftSnapshot(local.snapshot()) : worker.snapshot();
      logFile = appendCrashLog(logFile, {stage, error, notes: ['in-process fallback failed too; showing the error screen']});
      const failure = error instanceof Error ? error : new Error(String(error));
      throw Object.assign(failure, {logFile, stage});
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    worker.cancel();
    local?.cancel();
    for (const ack of acks.values()) ack.reject(new Error('audit_cancelled'));
    acks.clear();
  };
  options.signal?.addEventListener('abort', cancel, {once: true});
  const active = (): AuditSession => local ?? worker;

  return {
    snapshot: () => (local ? shiftSnapshot(local.snapshot()) : worker.snapshot()),
    run: async callback => {
      let maxSequence = worker.snapshot().sequence;
      const seen = (event: AuditEvent) => {
        maxSequence = Math.max(maxSequence, event.type === 'snapshot' ? event.snapshot.sequence : 'sequence' in event ? event.sequence : 0);
        callback?.(event);
      };
      try {
        return await worker.run(seen);
      } catch (error) {
        if (cancelled || disposed) return worker.snapshot();
        return runLocal(callback, error, maxSequence);
      }
    },
    analyzePeriod: async (period, callback) => (local ? shiftSnapshot(await local.analyzePeriod!(period, event => callback?.(shiftEvent(event)))) : worker.analyzePeriod!(period, callback)),
    prompts: (...args) => active().prompts(...args),
    evidence: route => active().evidence(route),
    previewLaunch: () => active().previewLaunch!(),
    preview: selection => active().preview!(selection),
    classify: (selection, callback) => active().classify(selection, callback),
    acknowledgeTransfer: ackId => {
      const ack = acks.get(ackId);
      if (ack) { acks.delete(ackId); ack.resolve(); return; }
      worker.acknowledgeTransfer?.(ackId);
    },
    cancel,
    dispose: () => { if (disposed) return; cancel(); disposed = true; worker.dispose(); local?.dispose(); },
    logFile: () => logFile,
  };
}

function createWorkerSession(options: AuditOverviewOptions, entry: string): WorkerSession {
  const seed = createAuditSession({...options, nativeScanExecutor: undefined, onTransfer: undefined, signal: undefined});
  let current: AuditSnapshot = seed.snapshot();
  seed.dispose();
  let child: ChildProcess | null = null;
  let disposed = false, cancelled = false, next = 0;
  let events: ((event: AuditEvent) => void) | undefined;
  const pending = new Map<number, Pending>();
  let ready: Promise<void> | null = null;
  let stderrTail = '', lastOp = 'start';
  let resolveDrained: () => void = () => {};
  const drainedPromise = new Promise<void>(resolve => { resolveDrained = resolve; });
  let resolveReady: () => void = () => {}, rejectReady: (error: Error) => void = () => {};

  const failAll = (error: Error) => {
    rejectReady(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  const settleCancelled = () => {
    current = {
      ...current, status: 'cancelled',
      progress: {...current.progress, stage: 'cancelled', provisional: false, cancellable: false},
      ...(current.launch ? {launch: {...current.launch, stage: 'ready' as const, semantics: current.launch.semantics ? {...current.launch.semantics, state: 'cancelled' as const} : null}} : {}),
    };
    for (const request of pending.values()) {
      if (request.op === 'run' || request.op === 'analyzePeriod') request.resolve(current);
      else request.reject(new Error('audit_cancelled'));
    }
    pending.clear();
  };

  const start = () => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    child = fork(path.resolve(entry), ['__audit_worker'], {stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced'});
    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding('utf8');
      stderr.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP); });
      stderr.once('close', () => resolveDrained());
      stderr.on('error', () => resolveDrained());
    } else resolveDrained();
    child.on('message', (raw: any) => {
      if (disposed || cancelled) return;
      if (raw?.kind === 'ready') { current = raw.snapshot; events?.({type: 'snapshot', snapshot: current}); resolveReady(); return; }
      if (raw?.kind === 'event') {
        const event = raw.event as AuditEvent;
        if (event.type === 'snapshot') current = event.snapshot;
        else if (event.type === 'progress') current = {...current, sequence: event.sequence, progress: event.progress, sources: event.sources};
        events?.(event);
        return;
      }
      if (raw?.kind === 'result') {
        const request = pending.get(raw.id);
        if (!request) return;
        pending.delete(raw.id);
        if (raw.error) { const error = new Error(raw.error); if (raw.stack) error.stack = raw.stack; request.reject(error); return; }
        if (request.op === 'run' || request.op === 'analyzePeriod') current = raw.value;
        request.resolve(raw.value);
      }
    });
    child.once('error', error => failAll(error));
    child.once('exit', (code, signal) => {
      // Let stderr flush, but never hang on it.
      setTimeout(resolveDrained, 250).unref();
      if (!cancelled && !disposed) failAll(new Error(`audit_background_worker_unavailable (worker exited with ${signal ? `signal ${signal}` : `code ${code}`})`));
    });
    const {signal: _signal, onTransfer: _onTransfer, nativeScanExecutor: _executor, ...serializable} = options;
    lastOp = 'init';
    try { child.send({kind: 'init', options: {...serializable, sessionIdentity: current.snapshotId}}, error => { if (error) failAll(error); }); }
    catch (error) { failAll(error as Error); }
    return ready;
  };

  const request = async (op: string, args: unknown[] = []): Promise<any> => {
    if (disposed || cancelled) throw new Error('audit_cancelled');
    await start();
    if (disposed || cancelled) throw new Error('audit_cancelled');
    return new Promise((resolve, reject) => {
      const id = ++next;
      lastOp = op;
      pending.set(id, {op, resolve, reject});
      try { child!.send({kind: 'request', id, op, args} satisfies Request, error => { if (error) { pending.delete(id); reject(error); } }); }
      catch (error) { pending.delete(id); reject(error as Error); }
    });
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    settleCancelled();
    rejectReady(new Error('audit_cancelled'));
    if (child?.connected) child.send({kind: 'cancel'});
    if (child && child.exitCode === null) {
      const owned = child;
      setTimeout(() => { owned.kill('SIGTERM'); setTimeout(() => owned.kill('SIGKILL'), 250).unref(); }, 500).unref();
    }
  };
  options.signal?.addEventListener('abort', cancel, {once: true});
  if (options.signal?.aborted) cancel();

  return {
    snapshot: () => current,
    run: async callback => {
      events = callback;
      try { return await request('run'); } catch (error) { if (cancelled) return current; throw error; }
    },
    analyzePeriod: async (period, callback) => { events = callback; return request('analyzePeriod', [period]); },
    prompts: (...args) => request('prompts', args),
    evidence: route => request('evidence', [route]),
    previewLaunch: () => request('previewLaunch'),
    preview: selection => request('preview', [selection]),
    classify: (selection, callback) => { events = callback; const {signal: _signal, ...safe} = selection; return request('classify', [safe]); },
    acknowledgeTransfer: ackId => { if (!cancelled && !disposed && child?.connected) child.send({kind: 'transfer_ack', ackId}); },
    cancel,
    dispose: () => { if (disposed) return; cancel(); disposed = true; events = undefined; },
    stderrTail: () => stderrTail,
    drained: () => (child ? Promise.race([drainedPromise, new Promise<void>(resolve => setTimeout(resolve, 300).unref())]) : Promise.resolve()),
    stage: () => `background worker · ${lastOp} · ${current.progress?.stage ?? current.status}`,
  };
}

/** Private internal entry of the child process. */
export async function runAuditWorkerHost(): Promise<void> {
  if (!process.send) throw new Error('audit_worker_requires_ipc');
  const testFail = process.env['SLOPIE_TEST_WORKER_FAIL'];
  if (testFail === 'exit') {
    process.stderr.write('slopie test hook: audit worker exiting at startup (SLOPIE_TEST_WORKER_FAIL=exit)\n', () => process.exit(70));
    return;
  }
  let session: AuditSession | null = null, nextAck = 0;
  const acknowledgements = new Map<string, {resolve: () => void; reject: (error: Error) => void}>();
  const send = (value: unknown) => { if (process.connected) process.send!(value); };
  const emit = (event: AuditEvent) => { if (event.type !== 'transfer') send({kind: 'event', event}); };
  process.on('message', async (raw: any) => {
    if (raw?.kind === 'init') {
      session = createAuditSession({
        ...raw.options,
        nativeScanExecutor: localScanPool(),
        onTransfer: (event: Extract<AuditEvent, {type: 'transfer'}>) => new Promise<void>((resolve, reject) => {
          const ackId = String(++nextAck);
          acknowledgements.set(ackId, {resolve, reject});
          send({kind: 'event', event: {...event, ackId}});
        }),
      });
      send({kind: 'ready', snapshot: session.snapshot()});
      return;
    }
    if (raw?.kind === 'transfer_ack') { acknowledgements.get(raw.ackId)?.resolve(); acknowledgements.delete(raw.ackId); return; }
    if (raw?.kind === 'cancel') {
      session?.cancel();
      for (const ack of acknowledgements.values()) ack.reject(new Error('audit_cancelled'));
      acknowledgements.clear();
      session?.dispose();
      if (process.connected) process.disconnect();
      return;
    }
    if (raw?.kind !== 'request' || !session) return;
    const {id, op, args} = raw as Request;
    try {
      let value: unknown;
      if (op === 'run' && testFail === 'throw') throw new Error('audit worker test failure (SLOPIE_TEST_WORKER_FAIL=throw)');
      if (op === 'run') value = await session.run(emit);
      else if (op === 'analyzePeriod') value = await session.analyzePeriod!(args[0] as any, emit);
      else if (op === 'classify') value = await session.classify(args[0] as any, emit);
      else if (['prompts', 'evidence', 'preview', 'previewLaunch'].includes(op)) value = await (session as any)[op](...args);
      else throw new Error('audit_worker_operation_unavailable');
      send({kind: 'result', id, value});
    } catch (error) {
      send({kind: 'result', id, error: error instanceof Error ? error.message : 'audit_worker_failed', stack: error instanceof Error ? error.stack : undefined});
    }
  });
  process.on('disconnect', () => { session?.dispose(); process.exit(0); });
}
