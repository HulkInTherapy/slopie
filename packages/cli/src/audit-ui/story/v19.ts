/**
 * slopie 1.9 snapshot fields (V19-CONTRACT): `story.spend`, `story.modelShare`, `story.totals.automatedRuns`.
 *
 * Read defensively: an older cached snapshot simply lacks them, and every accessor then returns
 * null so the card or panel that needs it is hidden (never drawn as $0 or 0%).
 */
import type { AuditStory } from './types.js';

export type V19Harness = 'claude' | 'claude_hist' | 'codex' | 'pi' | 'opencode' | 'cursor' | 'gemini' | 'copilot';

export interface Spend {
  measuredUsd: number;
  recoveredUsd: number;
  estimated: { lowUsd: number; highUsd: number; prompts: number; basis: string } | null;
  unpricedTokens: number;
  byHarness: readonly { harness: V19Harness; usd: number; prompts: number; tokens: number; sharePct: number }[];
  monthly: readonly { month: string; measuredUsd: number; recoveredUsd: number; estimatedUsd: number; prompts: number }[];
  daily: readonly { day: string; usd: number; prompts: number }[];
  thisMonthUsd: number;
  perActiveDayUsd: number;
  priciestDay: { day: string; usd: number } | null;
  priceVersion: string;
}

export interface ModelShareRow {
  model: string; label: string; harness: V19Harness;
  outputTokens: number; tokenSharePct: number;
  prompts: number; promptSharePct: number;
  usd: number; spendSharePct: number;
}

export interface ModelShare {
  basis: 'output_tokens';
  rows: readonly ModelShareRow[];
  unknownModelPrompts: number;
  last30d: readonly { model: string; label: string; promptSharePct: number }[];
  timeline: readonly { month: string; model: string; label: string; tokenSharePct: number }[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const arr = <T,>(v: unknown): readonly T[] => (Array.isArray(v) ? v as T[] : []);

/** Spend block, or null when the snapshot predates 1.9 or carries nothing measured. */
export function spendOf(story: AuditStory | null): Spend | null {
  const raw = (story as { spend?: Partial<Spend> } | null)?.spend;
  if (!raw || typeof raw !== 'object' || !finite(raw.measuredUsd)) return null;
  const est = raw.estimated && finite(raw.estimated.lowUsd) && finite(raw.estimated.highUsd) && raw.estimated.highUsd > 0 ? raw.estimated : null;
  const spend: Spend = {
    measuredUsd: raw.measuredUsd,
    recoveredUsd: finite(raw.recoveredUsd) ? raw.recoveredUsd : 0,
    estimated: est,
    unpricedTokens: finite(raw.unpricedTokens) ? raw.unpricedTokens : 0,
    byHarness: arr<Spend['byHarness'][number]>(raw.byHarness).filter(row => row && finite(row.usd) && finite(row.prompts)),
    monthly: arr<Spend['monthly'][number]>(raw.monthly).filter(row => row && /^\d{4}-\d{2}$/.test(row.month) && finite(row.measuredUsd)),
    daily: arr<Spend['daily'][number]>(raw.daily).filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && finite(row.usd)),
    thisMonthUsd: finite(raw.thisMonthUsd) ? raw.thisMonthUsd : 0,
    perActiveDayUsd: finite(raw.perActiveDayUsd) ? raw.perActiveDayUsd : 0,
    priciestDay: raw.priciestDay && finite(raw.priciestDay.usd) && raw.priciestDay.usd > 0 ? raw.priciestDay : null,
    priceVersion: typeof raw.priceVersion === 'string' ? raw.priceVersion : '',
  };
  if (spend.measuredUsd <= 0 && spend.recoveredUsd <= 0 && !spend.estimated) return null;
  return spend;
}

/** Model share block (rows de-duplicated by label), or null. */
export function modelShareOf(story: AuditStory | null): ModelShare | null {
  const raw = (story as { modelShare?: Partial<ModelShare> } | null)?.modelShare;
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Map<string, ModelShareRow>();
  for (const row of arr<ModelShareRow>(raw.rows)) {
    if (!row || typeof row.label !== 'string' || !finite(row.outputTokens) || !finite(row.tokenSharePct)) continue;
    const key = row.label.trim().toLowerCase();
    const prior = seen.get(key);
    // The contract promises one row per model; merge defensively if an alias slipped through.
    if (prior) seen.set(key, {
      ...prior, outputTokens: prior.outputTokens + row.outputTokens, tokenSharePct: prior.tokenSharePct + row.tokenSharePct,
      prompts: prior.prompts + (row.prompts || 0), promptSharePct: prior.promptSharePct + (row.promptSharePct || 0),
      usd: prior.usd + (row.usd || 0), spendSharePct: prior.spendSharePct + (row.spendSharePct || 0),
    });
    else seen.set(key, { ...row, prompts: row.prompts || 0, promptSharePct: row.promptSharePct || 0, usd: row.usd || 0, spendSharePct: row.spendSharePct || 0 });
  }
  const rows = [...seen.values()].filter(row => row.outputTokens > 0).sort((a, b) => b.tokenSharePct - a.tokenSharePct || b.outputTokens - a.outputTokens);
  const timeline = arr<ModelShare['timeline'][number]>(raw.timeline).filter(row => row && /^\d{4}-\d{2}$/.test(row.month) && typeof row.label === 'string');
  const last30d = arr<ModelShare['last30d'][number]>(raw.last30d).filter(row => row && typeof row.label === 'string' && finite(row.promptSharePct));
  const unknown = finite(raw.unknownModelPrompts) ? raw.unknownModelPrompts : 0;
  if (!rows.length && !timeline.length) return null;
  return { basis: 'output_tokens', rows, unknownModelPrompts: unknown, last30d, timeline };
}

export function automatedRunsOf(story: AuditStory | null): number | null {
  const v = (story?.totals as { automatedRuns?: unknown } | undefined)?.automatedRuns;
  return finite(v) && v > 0 ? v : null;
}

/**
 * Largest-remainder rounding: integer percents that sum to exactly 100.
 * Values below 1% that are non-zero keep a fractional display (see `pctLabel`).
 */
export function roundTo100(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map(v => (Math.max(0, v) / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]!++; left--; }
  return floors;
}

/** "98%", "1.3%", "0.1%", "<0.1%" from a 0..100 value. */
export function pctLabel(pct: number): string {
  if (!(pct > 0)) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10 && pct !== Math.round(pct)) return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(pct)}%`;
}
