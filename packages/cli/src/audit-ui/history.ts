/**
 * Run history: one numbers-only line per audit run under ~/.potsherd/audit-history/<scope>.jsonl.
 *
 * Holds no prompt text and no project names: counts, money, rates, an archetype id/title and a
 * model display name. It powers the board's "since last run" ticker, personal records and the
 * re-run behaviour (open on the board, ← replays the story). Writes are atomic (temp + rename).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { count, money, shortDate } from './format.js';
import { storyOf } from './story/source.js';
import { modelShareOf, spendOf } from './story/v19.js';

export interface RunDigest {
  v: 1;
  at: string;
  prompts: number;
  sessions: number;
  costUsd: number | null;
  /** Swearing share of the latest month with ≥ 20 prompts (0..100). */
  swearPct: number | null;
  peakHour: number | null;
  archetypeId: string | null;
  archetypeTitle: string | null;
  topModel: string | null;
  records: { streakDays: number; stretchH: number; busiestDayPrompts: number; priciestDayUsd: number; subagents: number };
}

const MAX_LINES = 200;

export function historyDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['SLOPIE_AUDIT_HISTORY_DIR']) return env['SLOPIE_AUDIT_HISTORY_DIR'];
  const root = env['POTSHERD_DIR'] || path.join(os.homedir(), '.potsherd');
  return path.join(root, 'audit-history');
}

/** One file per scope (harnesses, project filter, date window) so filtered runs never compare with full ones. */
export function scopeKey(snapshot: AuditSnapshot): string {
  const s = snapshot.scope;
  const raw = JSON.stringify([[...(s.harnesses ?? [])].sort(), s.project ?? null, s.eventFrom ?? null]);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function digestOf(snapshot: AuditSnapshot, now = new Date()): RunDigest | null {
  const story = storyOf(snapshot);
  if (!story || story.state === 'empty' || !story.totals.prompts) return null;
  const spend = spendOf(story);
  const months = story.swearTimeline.filter(m => m.prompts >= 20);
  const daily = spend?.daily ?? [];
  return {
    v: 1,
    at: now.toISOString(),
    prompts: story.totals.prompts,
    sessions: story.totals.sessions,
    costUsd: spend ? Math.round(spend.measuredUsd * 100) / 100 : story.totals.costUsd || null,
    swearPct: months.length ? months.at(-1)!.swearPct : null,
    peakHour: story.rhythm.peakHour,
    archetypeId: story.archetype?.id ?? null,
    archetypeTitle: story.archetype?.title ?? null,
    topModel: modelShareOf(story)?.rows[0]?.label ?? story.models.top[0]?.label ?? null,
    records: {
      streakDays: story.totals.longestStreakDays,
      stretchH: story.totals.longestStretchHours,
      busiestDayPrompts: daily.reduce((a, d) => Math.max(a, d.prompts), 0),
      priciestDayUsd: spend?.priciestDay?.usd ?? 0,
      subagents: story.totals.subagents,
    },
  };
}

function isDigest(x: unknown): x is RunDigest {
  const d = x as RunDigest;
  return !!d && d.v === 1 && typeof d.at === 'string' && typeof d.prompts === 'number' && !!d.records && typeof d.records === 'object';
}

export function readHistory(snapshot: AuditSnapshot, dir = historyDir()): RunDigest[] {
  try {
    const text = fs.readFileSync(path.join(dir, `${scopeKey(snapshot)}.jsonl`), 'utf8');
    const out: RunDigest[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const d: unknown = JSON.parse(line); if (isDigest(d)) out.push(d); } catch { /* skip a torn line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Append this run's digest (keeps the newest 200), atomically. Never throws. */
export function writeDigest(snapshot: AuditSnapshot, digest: RunDigest, dir = historyDir()): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${scopeKey(snapshot)}.jsonl`);
    const prior = readHistory(snapshot, dir);
    const lines = [...prior, digest].slice(-MAX_LINES).map(d => JSON.stringify(d));
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The run to compare against: the newest one at least 20 hours old, else the newest. */
export function baseline(history: readonly RunDigest[], now = new Date()): RunDigest | null {
  if (!history.length) return null;
  const old = [...history].reverse().find(d => now.getTime() - Date.parse(d.at) >= 20 * 3_600_000);
  return old ?? history.at(-1)!;
}

export interface Since { line: string; records: { metric: string; from: string; to: string }[]; archetypeChanged: string | null }

/** "since Nov 2: +214 prompts · +$312 · swearing 16.6% → 4.3% ↓ · new record: busiest day (98)". */
export function sinceLast(prev: RunDigest, now: RunDigest, all: readonly RunDigest[] = [prev]): Since {
  const parts: string[] = [`(${shortDate(prev.at.slice(0, 10))})`];
  const dp = now.prompts - prev.prompts;
  parts.push(`${dp >= 0 ? '+' : ''}${count(dp)} prompts`);
  if (now.costUsd !== null && prev.costUsd !== null) {
    const dc = now.costUsd - prev.costUsd;
    if (Math.abs(dc) >= 1) parts.push(`${dc >= 0 ? '+' : '−'}${money(Math.abs(dc))}`);
  }
  if (now.swearPct !== null && prev.swearPct !== null && Math.abs(now.swearPct - prev.swearPct) >= 0.5) {
    parts.push(`swearing ${prev.swearPct.toFixed(1)}% → ${now.swearPct.toFixed(1)}% ${now.swearPct < prev.swearPct ? '↓' : '↑'}`);
  }
  const records: Since['records'] = [];
  const best = (key: keyof RunDigest['records']) => Math.max(...all.map(d => d.records[key] ?? 0));
  const check = (key: keyof RunDigest['records'], label: string, fmt: (n: number) => string) => {
    const before = best(key), after = now.records[key];
    if (after > before && before > 0) records.push({ metric: label, from: fmt(before), to: fmt(after) });
  };
  check('busiestDayPrompts', 'busiest day', n => `${count(n)} prompts`);
  check('priciestDayUsd', 'priciest day', n => money(n));
  check('streakDays', 'streak', n => `${n} days`);
  check('stretchH', 'longest sit', n => `${n.toFixed(1)}h`);
  check('subagents', 'subagents', n => count(n));
  if (records.length) parts.push(`new record: ${records[0]!.metric} ${records[0]!.from} → ${records[0]!.to}`);
  const archetypeChanged = prev.archetypeTitle && now.archetypeTitle && prev.archetypeId !== now.archetypeId ? prev.archetypeTitle : null;
  if (archetypeChanged) parts.push(`no longer ${archetypeChanged}`);
  return { line: parts.join('  '), records, archetypeChanged };
}
