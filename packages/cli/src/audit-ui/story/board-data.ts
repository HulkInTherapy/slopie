/**
 * The final board's data: every panel is built only from numbers in the snapshot. A panel whose
 * data is missing is null (the renderer hides it); nothing is ever shown as 0 because it is unknown.
 */
import { compact, count, harnessName, hourLabel, money, shortDate } from '../format.js';
import { sanitize } from '../text.js';
import type { BoardData } from '../view-model.js';
import { cardOf, num, str } from './source.js';
import type { AuditStory } from './types.js';
import { automatedRunsOf, modelShareOf, spendOf, type Spend } from './v19.js';

export interface BarRow {
  label: string;
  /** Public-safe label (project alias). */
  publicLabel?: string;
  /** 0..100. */
  pct: number;
  /** Display value, e.g. '47.1%'. */
  value: string;
  tags?: ('fav' | 'nemesis' | 'priciest')[];
  /** Extra right-hand note (e.g. '$802'). */
  note?: string;
}

export interface SpendPanel {
  lifetime: number;
  /** Lifetime is the 1.9 measured figure (vs an older snapshot's single total). */
  measured: boolean;
  recovered: number | null;
  estimated: { low: number; high: number; prompts: number } | null;
  thisMonth: number | null;
  perDay: number | null;
  priciestDay: { day: string; usd: number } | null;
  priciestLine: { usd: number; times: number } | null;
  months: { month: string; measured: number; extra: number }[];
  hundredDays: number | null;
  unpriced: number | null;
}

export interface VoiceLine { label: string; short: string; value: string; valueShort?: string; quoted: boolean; count: number | null; private: boolean }

export interface BoardSummary {
  archetype: string | null;
  tier: 'common' | 'rare' | 'epic' | 'legendary' | null;
  subRole: string | null;
  code: string | null;
  tagline: string | null;
  range: string | null;
  days: string | null;
  hero: { value: string; label: string }[];
  spend: SpendPanel | null;
  /** Legacy single total for snapshots without a story. */
  bill: number | null;
  models: { basis: string; rows: BarRow[]; more: number; unknown: number | null; facts: string[] } | null;
  agents: { basis: string; rows: BarRow[]; money: string | null; automated: number | null } | null;
  time: { grid: number[][] | null; peak: string | null; lines: string[] } | null;
  voice: VoiceLine[];
  work: { rows: BarRow[]; lines: string[] } | null;
  awards: { title: string; value: string; publicValue: string; tier: 'gold' | 'silver' }[];
  /** "since last run" ticker (filled when a run history exists). */
  sinceLast: string | null;
  /** First run with history support: plant the weekly habit. */
  firstRun: boolean;
  /** Opened straight on the board (re-run): ← replays the story. */
  replay?: boolean;
}

const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOBBIT_WORDS = 95_000;

/** One-decimal shares that sum to exactly 100.0 (largest remainder on tenths). */
export function tenths(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map(v => (Math.max(0, v) / total) * 1000);
  const floors = exact.map(Math.floor);
  let left = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]!++; left--; }
  return floors.map(v => v / 10);
}

export const shareText = (pct: number) => (pct > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`);

function spendPanel(story: AuditStory | null, spend: Spend | null, legacyTotal: number | null): SpendPanel | null {
  const pricey = story?.highlights.mostExpensivePrompt ?? null;
  const priciestLine = pricey && pricey.costUsd > 0 ? { usd: pricey.costUsd, times: Math.round(pricey.timesMedian) } : null;
  if (spend) {
    const months = spend.monthly.map(m => ({ month: m.month, measured: m.measuredUsd, extra: Math.max(0, m.recoveredUsd) + Math.max(0, m.estimatedUsd) }));
    return {
      lifetime: spend.measuredUsd, measured: true,
      recovered: spend.recoveredUsd > 0.5 ? spend.recoveredUsd : null,
      estimated: spend.estimated ? { low: spend.estimated.lowUsd, high: spend.estimated.highUsd, prompts: spend.estimated.prompts } : null,
      thisMonth: spend.monthly.length ? spend.thisMonthUsd : null,
      perDay: spend.perActiveDayUsd > 0 ? spend.perActiveDayUsd : null,
      priciestDay: spend.priciestDay,
      priciestLine,
      months: months.slice(-12),
      hundredDays: spend.daily.length ? spend.daily.filter(d => d.usd >= 100).length : null,
      unpriced: spend.unpricedTokens > 0 ? spend.unpricedTokens : null,
    };
  }
  const total = legacyTotal ?? (story?.totals.costUsd || null);
  if (!total || total <= 0) return null;
  return { lifetime: total, measured: false, recovered: null, estimated: null, thisMonth: null, perDay: null, priciestDay: null, priciestLine, months: [], hundredDays: null, unpriced: null };
}

function modelsPanel(story: AuditStory | null, board: BoardData): BoardSummary['models'] {
  const share = modelShareOf(story);
  const best = story?.models.best ?? null;
  const worst = story?.models.worst && story.models.worst.matchedMonths >= 2 ? story.models.worst : null;
  const same = (a: string, b: string | null | undefined) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const tag = (label: string, priciest: string | null, topLabel: string | null) => {
    const tags: NonNullable<BarRow['tags']> = [];
    if (best ? same(label, best.label) : same(label, topLabel)) tags.push('fav');
    if (worst && same(label, worst.label)) tags.push('nemesis');
    if (priciest && same(label, priciest)) tags.push('priciest');
    return tags;
  };
  if (share && share.rows.length) {
    const pcts = tenths(share.rows.map(r => r.outputTokens));
    const priciest = [...share.rows].sort((a, b) => b.usd - a.usd)[0];
    const priciestLabel = priciest && priciest.usd > 0 ? priciest.label : null;
    const rows = share.rows.map((r, i) => ({ label: sanitize(r.label), pct: pcts[i]!, value: shareText(pcts[i]!), tags: tag(r.label, priciestLabel, share.rows[0]!.label), note: r.usd > 0 ? money(r.usd) : undefined }));
    const facts: string[] = [];
    if (priciest && priciestLabel && priciest.usd > 0) facts.push(`$ priciest: ${sanitize(priciest.label)}, ${money(priciest.usd)}`);
    if (worst) facts.push(`☠ nemesis: ${sanitize(worst.label)}, ${(worst.swearRatio ?? 1).toFixed(1)}× swears`);
    const era = eras(share.timeline);
    if (era) facts.push(`eras ${era}`);
    const now = share.last30d[0];
    if (now) facts.push(`last 30 days: ${sanitize(now.label)} ${Math.round(now.promptSharePct)}%`);
    return { basis: 'share of output tokens', rows, more: 0, unknown: share.unknownModelPrompts > 0 ? share.unknownModelPrompts : null, facts };
  }
  const top = story?.models.top ?? [];
  if (top.length) {
    const pcts = tenths(top.map(t => t.prompts));
    return { basis: 'by prompts', rows: top.map((t, i) => ({ label: sanitize(t.label), pct: pcts[i]!, value: shareText(pcts[i]!), tags: tag(t.label, null, top[0]!.label) })), more: 0, unknown: null, facts: worst ? [`☠ nemesis: ${sanitize(worst.label)}`] : [] };
  }
  const rows = board.models.rows.filter(r => r.value !== null && r.value > 0);
  if (!rows.length) return null;
  const pcts = tenths(rows.map(r => r.value!));
  return { basis: 'share of spend', rows: rows.map((r, i) => ({ label: r.name, pct: pcts[i]!, value: shareText(pcts[i]!), tags: r.favourite ? ['fav'] : [] })), more: 0, unknown: null, facts: [] };
}

/** "Fable 5 ▸ GPT-6 Sol ▸ Opus 5": consecutive months collapsed. */
function eras(timeline: readonly { month: string; label: string }[]): string | null {
  const seq: string[] = [];
  for (const row of timeline) if (seq.at(-1) !== row.label) seq.push(row.label);
  if (seq.length < 2) return null;
  const short = (label: string) => sanitize(label).replace(/^Claude\s+/, '');
  return seq.slice(-4).map(short).join(' ▸ ');
}

function agentsPanel(story: AuditStory | null, board: BoardData, spend: Spend | null): BoardSummary['agents'] {
  const automated = automatedRunsOf(story);
  const merged = new Map<string, { prompts: number; usd: number }>();
  const add = (harness: string, prompts: number, usd: number) => {
    const key = harness === 'claude_hist' ? 'claude' : harness;
    const prior = merged.get(key) ?? { prompts: 0, usd: 0 };
    merged.set(key, { prompts: prior.prompts + prompts, usd: prior.usd + usd });
  };
  if (spend && spend.byHarness.length) for (const h of spend.byHarness) add(h.harness, h.prompts, h.usd);
  else if (story) for (const [h, n] of Object.entries(story.totals.byHarness)) if (typeof n === 'number') add(h, n, 0);
  const entries = [...merged.entries()].filter(([, v]) => v.prompts > 0).sort((a, b) => b[1].prompts - a[1].prompts);
  if (entries.length) {
    const pcts = tenths(entries.map(([, v]) => v.prompts));
    const priced = entries.filter(([, v]) => v.usd > 0);
    return {
      basis: 'by prompts',
      rows: entries.map(([h, v], i) => ({ label: harnessName(h), pct: pcts[i]!, value: shareText(pcts[i]!), note: count(v.prompts) })),
      money: priced.length ? priced.slice(0, 2).map(([h, v]) => `${money(v.usd)} ${harnessName(h)}`).join(' · ') : null,
      automated,
    };
  }
  if (board.agentSplit.length) {
    const pcts = tenths(board.agentSplit.map(a => a.share));
    return { basis: 'share of spend', rows: board.agentSplit.map((a, i) => ({ label: a.name, pct: pcts[i]!, value: shareText(pcts[i]!) })), money: null, automated };
  }
  return null;
}

function timePanel(story: AuditStory | null): BoardSummary['time'] {
  const r = story?.rhythm;
  if (!r || r.weekdayHour.length !== 7) return null;
  const total = r.weekdayHour.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  if (total < 50) return null;
  const owl = cardOf(story, 'night_owl');
  const lines: string[] = [];
  const saint = num(owl, 'calmestHour'), angry = num(owl, 'angriestHour');
  if (saint !== null && angry !== null) lines.push(`saint ${hourLabel(saint)} · angriest ${hourLabel(angry)}`);
  if (r.lateNightDaysPct !== null && r.lateNightDaysPct >= 5) lines.push(`${Math.round(r.lateNightDaysPct)}% of days end past 1am`);
  if (r.weekendPct !== null) lines.push(`weekends ${Math.round(r.weekendPct)}% of prompts`);
  return {
    grid: r.weekdayHour.map(row => [...row]),
    peak: r.peakHour !== null && r.peakWeekday !== null ? `${SHORT_DAYS[r.peakWeekday]} ${hourLabel(r.peakHour)}` : null,
    lines,
  };
}

function voiceLines(story: AuditStory | null, board: BoardData, mask: (s: string) => string): VoiceLine[] {
  const out: VoiceLine[] = [];
  const h = story?.highlights;
  if (h?.catchphrase) out.push({ label: 'catchphrase', short: 'phrase', value: mask(h.catchphrase.phrase), quoted: true, count: h.catchphrase.count, private: true });
  else if (!story && board.repeats.rows[0]) out.push({ label: 'on repeat', short: 'repeat', value: mask(board.repeats.rows[0].text), quoted: true, count: board.repeats.rows[0].count, private: true });
  if (h?.petName) out.push({ label: 'you call it', short: 'calls it', value: mask(h.petName.term), quoted: true, count: h.petName.count, private: true });
  const cont = cardOf(story, 'continue_count');
  if (cont && str(cont, 'word')) out.push({ label: 'your nudge', short: 'nudge', value: mask(str(cont, 'word')!), quoted: true, count: num(cont, 'count'), private: true });
  const manners = cardOf(story, 'thanks_vs_swears');
  if (manners) {
    const thanks = num(manners, 'thanks') ?? 0, fb = num(manners, 'fbombs'), sw = num(manners, 'swears');
    const rude = fb ?? sw ?? 0;
    if (thanks > 0 && rude > 0) {
      const ratio = rude / thanks;
      const n = ratio >= 1 ? (ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1).replace(/\.0$/, '')) : null;
      out.push({ label: 'manners', short: 'manners', valueShort: n ? `${n}:1 ${fb !== null ? 'f-bombs' : 'swears'}:thanks` : undefined, value: ratio >= 1 ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, '')} ${fb !== null ? 'f-bombs' : 'swears'} : 1 thanks` : `${(1 / ratio).toFixed(1).replace(/\.0$/, '')} thanks : 1 ${fb !== null ? 'f-bomb' : 'swear'}`, quoted: false, count: null, private: false });
    }
    const please = num(manners, 'pleases');
    if (please !== null || thanks) out.push({ label: 'polite', short: 'polite', valueShort: `${count(please ?? 0)} pls · ${count(thanks)} thx`, value: `${count(please ?? 0)} please · ${count(thanks)} thanks`, quoted: false, count: null, private: false });
  }
  const f = h?.fuse;
  if (f) out.push({ label: 'fuse', short: 'fuse', value: `snaps at prompt #${f.medianTurn}`, quoted: false, count: null, private: false });
  const peak = (story?.swearTimeline ?? []).filter(m => m.prompts >= 40).reduce<{ month: string; swearPct: number } | null>((a, m) => (!a || m.swearPct > a.swearPct ? m : a), null);
  if (peak && peak.swearPct >= 1) out.push({ label: 'saltiest', short: 'saltiest', value: `${shortDate(peak.month + '-01').split(' ')[0]}, ${peak.swearPct.toFixed(0)}% swore`, quoted: false, count: null, private: false });
  return out;
}

function workPanel(story: AuditStory | null, board: BoardData): BoardSummary['work'] {
  const list = story ? [...story.projects].filter(p => p.prompts > 0).sort((a, b) => b.prompts - a.prompts) : [];
  const total = story?.totals.prompts ?? 0;
  const lines: string[] = [];
  if (list.length && total > 0) {
    const rows: BarRow[] = list.slice(0, 4).map(p => ({ label: sanitize(p.name ?? p.alias), publicLabel: p.alias, pct: (p.prompts / total) * 100, value: `${Math.round((p.prompts / total) * 100)}%`, note: p.costUsd >= 1 ? money(p.costUsd) : undefined }));
    const folders = story!.totals.projects;
    const quiet = list.filter(p => p.idleDays >= 30).length;
    lines.push(`${count(folders)} folders · ${count(list.length - quiet)} alive${story!.highlights.gotAway ? ' · 1 got away' : ''}`);
    if (story!.totals.subagents > 0) lines.push(`${count(story!.totals.subagents)} subagents launched`);
    const ghost = cardOf(story, 'sprint_and_vanish');
    if (ghost && num(ghost, 'prompts') !== null && num(ghost, 'days') !== null) lines.push(`hackathon ghost: ${count(num(ghost, 'prompts'))} prompts in ${num(ghost, 'days')} days`);
    return { rows, lines };
  }
  const rows = board.projects.rows;
  if (rows.length < 2) return null;
  const sum = rows.reduce((a, r) => a + r.prompts, 0);
  return { rows: rows.slice(0, 4).map((p, i) => ({ label: p.name, publicLabel: `Project ${String.fromCharCode(65 + i)}`, pct: (p.prompts / sum) * 100, value: `${Math.round((p.prompts / sum) * 100)}%` })), lines: [`${count(board.stats.projects)} projects`] };
}

function heroStats(story: AuditStory | null, board: BoardData): BoardSummary['hero'] {
  const t = story?.totals;
  const out: BoardSummary['hero'] = [];
  const push = (value: number | null | undefined, label: string, fmt: (n: number) => string = count) => {
    if (value === null || value === undefined || !(value > 0)) return;
    const v = fmt(value);
    // "23-" + "day streak" reads as one word: "23-day streak".
    if (v.endsWith('-')) out.push({ value: v.slice(0, -1), label: '-' + label });
    else out.push({ value: v, label });
  };
  push(t?.prompts ?? board.stats.prompts, 'prompts');
  push(t?.sessions ?? board.stats.chats, 'chats');
  push(t?.activeDays ?? board.stats.activeDays, 'active days');
  push(t?.longestStreakDays ?? board.stats.streak, 'day streak', n => `${count(n)}-`);
  if (t?.longestStretchHours) out.push({ value: `${t.longestStretchHours.toFixed(1)}h`, label: 'longest sit' });
  if (t?.words) out.push({ value: compact(t.words), label: `words ≈ ${(t.words / HOBBIT_WORDS).toFixed(1).replace(/\.0$/, '')} Hobbits` });
  else push(board.stats.tokens, 'tokens', compact);
  return out;
}

export function boardSummaryData(
  story: AuditStory | null,
  board: BoardData,
  extras: {
    archetype: { title: string; tier: BoardSummary['tier']; subRole: string | null; code: string | null; tagline: string } | null;
    awards: { title: string; value: string; publicValue: string; tier?: 'gold' | 'silver' }[];
    mask: (s: string) => string;
  },
): BoardSummary {
  const spend = spendOf(story);
  const range = story?.totals.firstAt && story.totals.lastAt ? `${shortDate(story.totals.firstAt, true)} → ${shortDate(story.totals.lastAt, true)}`
    : board.range.from && board.range.to ? `${shortDate(board.range.from, true)} → ${shortDate(board.range.to, true)}` : null;
  const span = story?.totals.spanDays, active = story?.totals.activeDays ?? board.stats.activeDays;
  return {
    archetype: extras.archetype?.title ?? null,
    tier: extras.archetype?.tier ?? null,
    subRole: extras.archetype?.subRole ?? null,
    code: extras.archetype?.code ?? null,
    tagline: extras.archetype?.tagline || null,
    range,
    days: span ? `${count(span)} days${active ? ` · ${count(active)} active` : ''}` : null,
    hero: heroStats(story, board),
    spend: spendPanel(story, spend, board.hero.value),
    bill: board.hero.value,
    models: modelsPanel(story, board),
    agents: agentsPanel(story, board, spend),
    time: timePanel(story),
    voice: voiceLines(story, board, extras.mask),
    work: workPanel(story, board),
    awards: extras.awards.map((a, i) => ({ ...a, tier: a.tier ?? (i < 2 ? 'gold' : 'silver') })),
    sinceLast: null,
    firstRun: false,
  };
}
