/**
 * v19 spend and model share for the story (`story.spend`, `story.modelShare`).
 *
 * Three kinds of dollars, never added together silently:
 *
 *  - measured:  deduplicated per-request usage logs (all harnesses), priced.
 *  - recovered: Claude Code's own per-model token totals in ~/.claude/stats-cache.json
 *               (`modelUsage`, through `lastComputedDate`) minus every request-log token of
 *               the same model up to that date; only positive residuals are priced, cache
 *               writes at the 5-minute rate (the cache has no TTL split: the cheaper rate is
 *               the conservative one). Spread over months by `dailyModelTokens` weight.
 *  - estimated: human prompts whose token logs no longer exist (history-only Claude prompts, on
 *               days the stats cache does not cover) × the per-prompt turn cost of Claude prompts
 *               with logs in the nearest months: median as the central scenario, p25–p75 as the
 *               range. Always labelled.
 *
 * Model share is observed only: models recorded on responses (and the stats cache's
 * per-model totals, which are recorded by Claude Code, not inferred). Prompts without an
 * observed answering model are counted as unknown, never redistributed.
 */
import fs from 'node:fs';
import type {Aggregate} from './aggregate.js';
import {canonicalModel, largestRemainder, modelLabel} from './model-names.js';
import type {PriceBook} from './pricing.js';
import type {StoryHarness, StoryModelShare, StorySpend} from './story-contracts.js';
import type {StoryRow, StoryTable} from './story-table.js';
import {localClock} from './story-time.js';

const r2 = (x: number) => Math.round(x * 100) / 100;
const MILLION = 1_000_000;
/** A month is a usable estimate basis with at least this many priced Claude human prompts. */
const BASIS_MIN_PROMPTS = 50;
const BASIS_MONTHS = 3;

/* ------------------------------------------------------- stats-cache --- */

export interface StatsCacheModel {input: number; output: number; cacheRead: number; cacheWrite: number}
export interface StatsCache {
  file: string;
  /** Last local date the cache covers (YYYY-MM-DD). */
  lastDate: string;
  firstDate: string | null;
  /** Canonical model -> lifetime token totals. */
  models: Map<string, StatsCacheModel>;
  /** date -> canonical model -> tokens (weights only). */
  daily: Map<string, Map<string, number>>;
  /** Dates with any recorded activity. */
  activeDays: Set<string>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const pick = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (k in o) return num(o[k]); return 0; };

/** Parses ~/.claude/stats-cache.json; null when absent or unusable. */
export function readStatsCache(file: string): StatsCache | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const lastDate = typeof o.lastComputedDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.lastComputedDate) ? o.lastComputedDate.slice(0, 10) : null;
  if (!lastDate) return null;
  const models = new Map<string, StatsCacheModel>();
  const usage = o.modelUsage && typeof o.modelUsage === 'object' ? o.modelUsage as Record<string, unknown> : {};
  for (const [model, v] of Object.entries(usage)) {
    if (!v || typeof v !== 'object') continue;
    const u = v as Record<string, unknown>;
    const id = canonicalModel(model);
    const row = models.get(id) ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    row.input += pick(u, 'inputTokens', 'input_tokens');
    row.output += pick(u, 'outputTokens', 'output_tokens');
    row.cacheRead += pick(u, 'cacheReadInputTokens', 'cache_read_input_tokens');
    row.cacheWrite += pick(u, 'cacheCreationInputTokens', 'cache_creation_input_tokens');
    models.set(id, row);
  }
  const daily = new Map<string, Map<string, number>>();
  const activeDays = new Set<string>();
  for (const row of Array.isArray(o.dailyModelTokens) ? o.dailyModelTokens : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.date !== 'string' || !r.tokensByModel || typeof r.tokensByModel !== 'object') continue;
    const m = daily.get(r.date) ?? new Map<string, number>();
    for (const [model, n] of Object.entries(r.tokensByModel as Record<string, unknown>)) {
      const t = num(n);
      if (!t) continue;
      const id = canonicalModel(model);
      m.set(id, (m.get(id) ?? 0) + t);
      activeDays.add(r.date);
    }
    daily.set(r.date, m);
  }
  for (const row of Array.isArray(o.dailyActivity) ? o.dailyActivity : []) {
    const r = row as Record<string, unknown> | null;
    if (r && typeof r.date === 'string' && (num(r.messageCount) || num(r.sessionCount))) activeDays.add(r.date);
  }
  const firstDate = typeof o.firstSessionDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.firstSessionDate) ? o.firstSessionDate.slice(0, 10) : null;
  return {file, lastDate, firstDate, models, daily, activeDays};
}

/* -------------------------------------------------------------- spend --- */

export interface SpendInput {
  aggregate: Aggregate;
  table: StoryTable;
  book: PriceBook;
  priceVersion: string;
  timezone: string;
  statsCaches: readonly StatsCache[];
  /** Project-scoped audits cannot use the stats cache (it has no project). */
  projectScoped: boolean;
  /** Local-date filter of a date-scoped audit. */
  dateAllowed?: (date: string) => boolean;
  now?: Date;
}

type UsageSummary = Aggregate['story']['usage'];

export interface RecoveredSpend {
  usd: number;
  unpricedTokens: number;
  /** month -> usd */
  byMonth: Map<string, number>;
  /** canonical model -> {usd, output} */
  byModel: Map<string, {usd: number; output: number; byMonth: Map<string, number>}>;
  /** Dates whose usage the stats cache accounts for. */
  coveredDays: (day: string) => boolean;
}

/** Residual of each stats cache over the request logs, priced at base rates (5m cache writes). */
export function recoveredSpend(caches: readonly StatsCache[], claudeObserved: UsageSummary['claudeObserved'], book: PriceBook, dateAllowed: (d: string) => boolean): RecoveredSpend {
  const out: RecoveredSpend = {usd: 0, unpricedTokens: 0, byMonth: new Map(), byModel: new Map(), coveredDays: () => false};
  const covered: StatsCache[] = [];
  for (const cache of caches) {
    covered.push(cache);
    // Request-log tokens of the same model up to the cache's last day.
    const observed = new Map<string, StatsCacheModel>();
    for (const [model, days] of claudeObserved) {
      const o = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      for (const [day, t] of days) if (day <= cache.lastDate) { o.input += t[0]; o.output += t[1]; o.cacheRead += t[2]; o.cacheWrite += t[3]; }
      observed.set(model, o);
    }
    for (const [model, total] of cache.models) {
      const o = observed.get(model) ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      const res = {input: Math.max(0, total.input - o.input), output: Math.max(0, total.output - o.output),
        cacheRead: Math.max(0, total.cacheRead - o.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - o.cacheWrite)};
      const tokens = res.input + res.output + res.cacheRead + res.cacheWrite;
      if (!tokens) continue;
      const price = book.lookup(model);
      // Weights: the model's own daily tokens up to the cutoff; else the cutoff month.
      const days: [string, number][] = [];
      for (const [d, m] of cache.daily) { const w = m.get(model) ?? 0; if (w > 0 && d <= cache.lastDate) days.push([d, w]); }
      if (!days.length) days.push([cache.lastDate, 1]);
      const weight = days.reduce((n, [, w]) => n + w, 0);
      const inScope = days.filter(([d]) => dateAllowed(d)), share = inScope.reduce((n, [, w]) => n + w, 0) / weight;
      if (!price) { out.unpricedTokens += Math.round(tokens * share); continue; }
      const r = price.rates;
      const usd = (res.input * r.input + res.output * r.output + res.cacheRead * r.cacheRead + res.cacheWrite * r.cacheWrite) / MILLION;
      const row = out.byModel.get(model) ?? {usd: 0, output: 0, byMonth: new Map<string, number>()};
      row.output += Math.round(res.output * share);
      for (const [d, w] of inScope) {
        const part = usd * (w / weight), month = d.slice(0, 7);
        out.usd += part; row.usd += part;
        out.byMonth.set(month, (out.byMonth.get(month) ?? 0) + part);
        row.byMonth.set(month, (row.byMonth.get(month) ?? 0) + part);
      }
      out.byModel.set(model, row);
    }
  }
  out.coveredDays = day => covered.some(c => day <= c.lastDate && (c.activeDays.size ? c.activeDays.has(day) : (c.firstDate === null || day >= c.firstDate)));
  return out;
}

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const usd = (x: number) => `$${x.toFixed(2)}`;
/** Linear-interpolated quantile of an ascending list. */
function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function buildSpend(input: SpendInput): {spend: StorySpend; modelShare: StoryModelShare} {
  const a = input.aggregate, rows = input.table.rows;
  const dateAllowed = input.dateAllowed ?? (() => true);
  const now = input.now ?? new Date();
  const clock = localClock(input.timezone);
  const summary = a.story.usage;
  const recovered = input.projectScoped ? {usd: 0, unpricedTokens: 0, byMonth: new Map<string, number>(), byModel: new Map(), coveredDays: () => false} as RecoveredSpend
    : recoveredSpend(input.statsCaches, summary.claudeObserved, input.book, dateAllowed);

  // ---- measured, per day / month / harness
  const daily = new Map<string, {usd: number; prompts: number}>();
  const monthly = new Map<string, {measured: number; recovered: number; estimated: number; prompts: number; priced: number; unlogged: number}>();
  const M = (m: string) => { let x = monthly.get(m); if (!x) { x = {measured: 0, recovered: 0, estimated: 0, prompts: 0, priced: 0, unlogged: 0}; monthly.set(m, x); } return x; };
  const D = (d: string) => { let x = daily.get(d); if (!x) { x = {usd: 0, prompts: 0}; daily.set(d, x); } return x; };
  const harnessRows = new Map<StoryHarness, {usd: number; recovered: number; prompts: number; tokens: number}>();
  const H = (h: StoryHarness) => { const k: StoryHarness = h === 'claude_hist' ? 'claude' : h; let x = harnessRows.get(k); if (!x) { x = {usd: 0, recovered: 0, prompts: 0, tokens: 0}; harnessRows.set(k, x); } return x; };
  const measured = summary.measured;
  for (const [harness, x] of summary.byHarness) { const h = H(harness as StoryHarness); h.usd += x.usd; h.tokens += x.tokens; }
  for (const [day, x] of summary.byDay) D(day).usd += x.usd;
  for (const [month, x] of summary.byMonth) M(month).measured += x.usd;
  if (recovered.usd > 0) H('claude').recovered += recovered.usd;
  for (const [m, x] of recovered.byMonth) M(m).recovered += x;

  // ---- prompts: priced (has logs or stats-cache coverage) vs unlogged (history-only, uncovered)
  let unloggedUndated = 0;
  const unloggedMonths = new Map<string, number>();
  for (const r of rows) {
    D(r.day).prompts++; H(r.harness).prompts++;
    const m = M(r.month);
    m.prompts++;
    if (r.harness !== 'claude_hist' || recovered.coveredDays(r.day)) m.priced++;
    else { m.unlogged++; unloggedMonths.set(r.month, (unloggedMonths.get(r.month) ?? 0) + 1); }
  }
  for (const ref of a.story.refs) if (ref.prompt.eventAt === null) { H(ref.history ? 'claude_hist' : (ref.source?.harness as StoryHarness ?? 'claude')).prompts++; if (ref.history) unloggedUndated++; }

  // ---- estimate for unlogged prompts. They are history-only Claude prompts, so the basis is Claude
  // transcript prompts only: in each of the BASIS_MONTHS months nearest to the prompt's month that have
  // >=BASIS_MIN_PROMPTS priced Claude prompts, the cost of each prompt's turn (its responses and its
  // subagents'). The pooled distribution's median is the central scenario, p25-p75 the range.
  const claudeCosts = new Map<string, number[]>();
  for (const r of rows) if (r.harness === 'claude' && r.costTotalUsd !== null) { const l = claudeCosts.get(r.month) ?? []; l.push(r.costTotalUsd); claudeCosts.set(r.month, l); }
  const basis = [...claudeCosts].filter(([, l]) => l.length >= BASIS_MIN_PROMPTS).map(([m, costs]) => ({m, i: monthIndex(m), costs})).sort((p, q) => p.i - q.i);
  let estimated: StorySpend['estimated'] = null;
  const unloggedTotal = [...unloggedMonths.values()].reduce((x, y) => x + y, 0) + unloggedUndated;
  if (unloggedTotal && basis.length) {
    let low = 0, mid = 0, high = 0;
    const used = new Set<string>();
    const lows: number[] = [], highs: number[] = [];
    const apply = (i: number, n: number, month: string | null) => {
      const near = [...basis].sort((p, q) => Math.abs(p.i - i) - Math.abs(q.i - i) || p.i - q.i).slice(0, BASIS_MONTHS);
      const costs = near.flatMap(b => b.costs).sort((x, y) => x - y);
      for (const b of near) used.add(b.m);
      const p25 = quantile(costs, 0.25), p50 = quantile(costs, 0.5), p75 = quantile(costs, 0.75);
      lows.push(p25); highs.push(p75);
      low += n * p25; mid += n * p50; high += n * p75;
      if (month) M(month).estimated += n * p50;
    };
    const dated = [...unloggedMonths].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (const [m, n] of dated) apply(monthIndex(m), n, m);
    if (unloggedUndated) {
      // Undated prompts: the months around the middle of the dated unlogged ones, else the latest basis months.
      const middle = dated.length ? monthIndex(dated[Math.floor(dated.length / 2)]![0]) : basis.at(-1)!.i;
      apply(middle, unloggedUndated, null);
    }
    const months = [...used].sort();
    estimated = {lowUsd: r2(low), midUsd: r2(mid), highUsd: r2(high), prompts: unloggedTotal,
      basis: `${unloggedTotal.toLocaleString('en-US')} Claude prompts survive only in history.jsonl, on days with no token logs and no stats-cache coverage. `
        + `Each is valued at what one Claude prompt with surviving logs cost (its turn, including subagents) in the ${BASIS_MONTHS} nearest months with at least ${BASIS_MIN_PROMPTS} such prompts (${months.join(', ')}): `
        + `the median turn cost (about ${usd(mid / unloggedTotal)} per prompt) gives ${usd(mid)}; the 25th to 75th percentile turn costs `
        + `(${usd(Math.min(...lows))} to ${usd(Math.max(...highs))} per prompt) give ${usd(low)} to ${usd(high)}. A scenario, not a measurement.`};
  }

  // ---- series
  const monthKeys = [...monthly.keys()].sort();
  const series: StorySpend['monthly'][number][] = [];
  if (monthKeys.length) for (let i = monthIndex(monthKeys[0]!); i <= monthIndex(monthKeys.at(-1)!); i++) {
    const m = monthOf(i), x = monthly.get(m);
    series.push({month: m, measuredUsd: r2(x?.measured ?? 0), recoveredUsd: r2(x?.recovered ?? 0), estimatedUsd: r2(x?.estimated ?? 0), prompts: x?.prompts ?? 0});
  }
  const days = [...daily].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([day, x]) => ({day, usd: r2(x.usd), prompts: x.prompts}));
  const spendDays = days.filter(d => d.usd > 0);
  const priciest = spendDays.reduce<{day: string; usd: number} | null>((p, d) => (!p || d.usd > p.usd ? {day: d.day, usd: d.usd} : p), null);
  const thisMonth = clock(now.getTime()).month;
  const harnessList = [...harnessRows].sort((x, y) => y[1].usd - x[1].usd || y[1].prompts - x[1].prompts);
  const shares = largestRemainder(harnessList.map(([, x]) => x.usd));
  const spend: StorySpend = {
    measuredUsd: r2(measured), recoveredUsd: r2(recovered.usd), estimated,
    unpricedTokens: a.unpricedTokens + recovered.unpricedTokens,
    byHarness: harnessList.map(([harness, x], i) => ({harness, usd: r2(x.usd), prompts: x.prompts, tokens: x.tokens, sharePct: shares[i]!, ...(x.recovered ? {recoveredUsd: r2(x.recovered)} : {})})),
    monthly: series, daily: days,
    thisMonthUsd: r2(monthly.get(thisMonth)?.measured ?? 0),
    perActiveDayUsd: spendDays.length ? r2(measured / spendDays.length) : 0,
    priciestDay: priciest,
    priceVersion: input.priceVersion,
  };
  return {spend, modelShare: modelShare(summary.models, rows, recovered, input.table.headline?.prompts ?? rows.length, now)};
}

/* -------------------------------------------------------- model share --- */

function modelShare(observed: UsageSummary['models'], rows: readonly StoryRow[], recovered: RecoveredSpend, headlinePrompts: number, now: Date): StoryModelShare {
  const models = new Map<string, {output: number; usd: number; prompts: number; recoveredOutput: number; harness: Map<StoryHarness, number>; months: Map<string, number>}>();
  const R = (m: string) => { let x = models.get(m); if (!x) { x = {output: 0, usd: 0, prompts: 0, recoveredOutput: 0, harness: new Map(), months: new Map()}; models.set(m, x); } return x; };
  const monthTotals = new Map<string, Map<string, number>>();
  const addMonth = (month: string, model: string, n: number) => { const t = monthTotals.get(month) ?? new Map<string, number>(); t.set(model, (t.get(model) ?? 0) + n); monthTotals.set(month, t); };
  for (const [model, o] of observed) {
    const x = R(model);
    x.output += o.output; x.usd += o.usd;
    for (const [h, n] of o.harness) x.harness.set(h as StoryHarness, (x.harness.get(h as StoryHarness) ?? 0) + n);
    for (const [month, n] of o.months) addMonth(month, model, n);
  }
  for (const [model, r] of recovered.byModel) {
    const x = R(model);
    x.output += r.output; x.recoveredOutput += r.output; x.usd += r.usd;
    x.harness.set('claude', (x.harness.get('claude') ?? 0) + r.output);
    // Recovered output tokens follow the same monthly weights as recovered dollars.
    const total = [...r.byMonth.values()].reduce((p, q) => p + q, 0);
    for (const [month, part] of r.byMonth) if (total > 0) addMonth(month, model, r.output * part / total);
  }
  let observedPrompts = 0;
  for (const r of rows) if (r.model) { R(r.model).prompts++; observedPrompts++; }
  const list = [...models].filter(([, x]) => x.output > 0 || x.prompts > 0).sort((p, q) => q[1].output - p[1].output || q[1].prompts - p[1].prompts || (p[0] < q[0] ? -1 : 1));
  const tok = largestRemainder(list.map(([, x]) => x.output)), pr = largestRemainder(list.map(([, x]) => x.prompts)), sp = largestRemainder(list.map(([, x]) => x.usd));
  const since = now.getTime() - 30 * 86_400_000;
  const recent = new Map<string, number>();
  for (const r of rows) if (r.model && r.ts >= since) recent.set(r.model, (recent.get(r.model) ?? 0) + 1);
  const recentList = [...recent].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1));
  const recentPct = largestRemainder(recentList.map(([, n]) => n));
  const timeline: StoryModelShare['timeline'][number][] = [];
  for (const [month, t] of [...monthTotals].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
    const total = [...t.values()].reduce((p, q) => p + q, 0);
    const top = [...t].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0];
    if (top && total > 0) timeline.push({month, model: top[0], label: modelLabel(top[0]), tokenSharePct: Math.round((top[1] / total) * 100)});
  }
  return {
    basis: 'output_tokens',
    rows: list.map(([model, x], i) => ({
      model, label: modelLabel(model), harness: [...x.harness].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 'claude',
      outputTokens: Math.round(x.output), tokenSharePct: tok[i]!, prompts: x.prompts, promptSharePct: pr[i]!, usd: r2(x.usd), spendSharePct: sp[i]!,
      ...(x.recoveredOutput ? {recoveredOutputTokens: Math.round(x.recoveredOutput)} : {}),
    })),
    unknownModelPrompts: Math.max(0, headlinePrompts - observedPrompts),
    last30d: recentList.map(([model], i) => ({model, label: modelLabel(model), promptSharePct: recentPct[i]!})),
    timeline,
  };
}
