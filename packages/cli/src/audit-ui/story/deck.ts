/**
 * Snapshot → the ordered story deck. Pure and memoised per snapshot.
 *
 * Every card is either fed by a detector that fired or by plain totals; a card whose data is
 * missing is left out (never filler). Copy uses the engine's headline/support when it has one,
 * otherwise a local template built only from numbers in the snapshot.
 */
import type { AuditSnapshot } from '../../../../core/src/analytics/contracts.js';
import type { Expression } from '../mascot.js';
import { compact, count, harnessName, hourLabel, modelName, money, shortDate } from '../format.js';
import { sanitize } from '../text.js';
import { boardData, type BoardData } from '../view-model.js';
import { cardOf, num, storyOf, str } from './source.js';
import { boardSummaryData, type BoardSummary } from './board-data.js';
import { modelShareOf, spendOf } from './v19.js';
import type { AuditStory, StoryCard, StoryChart } from './types.js';

export type Kind =
  | 'cover' | 'cold_open' | 'scale' | 'bill' | 'clock' | 'guess' | 'faceoff' | 'mood' | 'fuse' | 'talk' | 'manners'
  | 'projects' | 'delegation' | 'then_now' | 'archetype' | 'awards' | 'insight' | 'board';

interface Base<K extends Kind, D> {
  kind: K;
  /** Stable id (detector id, or the kind for composite cards). */
  id: string;
  kicker: string;
  headline: string;
  support: string;
  expression: Expression;
  /** `?` method notes, plain English. */
  notes: string[];
  data: D;
  /** Short receipts drawn under the visual (merged detectors: rants, Esc, rage day...). */
  callouts?: string[];
  /** One-line lead-in to the next card ("next → it wasn't free."), set when the deck is assembled. */
  bridge?: string;
}

/** The 1.9 spend card: lifetime, monthly bars, daily heat strip (all measured from the snapshot). */
export interface SpendView {
  measured: number;
  recovered: number | null;
  estimated: { low: number; high: number; prompts: number } | null;
  months: { month: string; measured: number; extra: number }[];
  days: { day: string; usd: number; prompts: number }[];
  thisMonth: number | null;
  perDay: number | null;
  priciestDay: { day: string; usd: number } | null;
}

export interface Counter { label: string; value: number; style: 'count' | 'compact' | 'days' }
export interface BillLine { name: string; value: number }
export interface Option { name: string; share: number }
export interface Tile { label: string; text: string; count: number | null; quoted: boolean; sub?: string }
export interface Trophy { id?: string; title: string; value: string; sub: string; publicValue?: string; publicSub?: string; tier?: 'gold' | 'silver' }
export interface ProjectRow { name: string; prompts: number; cost: number | null }
export interface Gauge { label: string; per100: number; expected: number | null; ratio: number | null; prompts: number }

export interface CoverData {
  /** Word lengths of the archetype title, drawn as a locked silhouette. */
  words: number[];
  tier: 'common' | 'rare' | 'epic' | 'legendary' | null;
  numbers: { value: string; label: string }[];
}

export type DeckCard =
  | Base<'cover', CoverData>
  | Base<'cold_open', { quote: string; stamp: string; caption: string }>
  | Base<'scale', { counters: Counter[] }>
  | Base<'bill', { total: number; lines: BillLine[]; more: number; byAgent: { name: string; share: number }[]; priciest: { cost: number; day: string; model: string | null } | null; spend: SpendView | null }>
  | Base<'clock', { grid: number[][]; peakHour: number | null; peakWeekday: number | null; lateNightPct: number | null; callouts: { label: string; value: string; sub: string }[] }>
  | Base<'guess', { options: Option[]; answer: number; basis: string; after: string | null }>
  | Base<'faceoff', { best: Gauge | null; worst: Gauge | null; compare: { label: string; observed: number; expected: number | null; highlight: boolean }[]; compareUnit: string; eras: { month: string; label: string }[] }>
  | Base<'mood', { months: { month: string; pct: number }[]; tip: number }>
  | Base<'fuse', { median: number; sessions: number; of: number; firstPrompt: number; hist: number[] }>
  | Base<'talk', { tiles: Tile[] }>
  | Base<'manners', { kind: number; rude: number; kindLabel: string; rudeLabel: string; prompts: number | null }>
  | Base<'projects', { rows: ProjectRow[]; gotAway: { name: string; prompts: number; days: number; idle: number; lastDay: string; lastWords: string | null } | null }>
  | Base<'delegation', { total: number; months: { month: string; n: number }[]; firstMonth: string | null }>
  | Base<'then_now', { then: { day: string; words: number; quote: string | null; shell: boolean }; now: { day: string; words: number; quote: string | null }; spanDays: number; prompts: number }>
  | Base<'archetype', { title: string; tagline: string; profile: string; subRole: string | null; code: string | null; codeWords: string[]; deciding: { label: string; display: string; band: number }[]; tier: 'common' | 'rare' | 'epic' | 'legendary' | null; runners: { title: string; score: number }[] }>
  | Base<'awards', { trophies: Trophy[] }>
  | Base<'insight', { chart: StoryChart; motif: string }>
  | Base<'board', BoardSummary>;

export type { BoardSummary } from './board-data.js';

const WEEKDAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const monthLabel = (month: string, year = false) => {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  return `${MONTHS[Number(m[2]) - 1] ?? '?'}${year ? ` ${m[1]}` : ''}`;
};

/** Mask swears defensively (the engine already masks): f*** style, first letter kept. */
const SWEARS = /\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|dick\w*|cunt\w*|damn\w*|crap\w*|piss\w*|wtf|stfu)\b/gi;
export function mask(text: string): string {
  return sanitize(text).replace(SWEARS, word => word[0] + '*'.repeat(Math.min(5, word.length - 1)));
}

/** A quote is shown only when it came from an engine slot and still looks safe. */
function safeQuote(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = mask(text).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 120) return null;
  if (/https?:|www\.|@[\w-]+\.|\/Users\/|\/home\/|[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]/.test(clean)) return null;
  return clean;
}

/** One spelling for a model everywhere (the bill uses the same formatter). */
function displayModel(id: string | null | undefined, label: string): string {
  const formatted = id ? modelName(id) : '';
  return mask(formatted && formatted !== 'Unknown model' && formatted !== id ? formatted : label);
}

const engineCopy = (card: StoryCard | null) => (card ? { headline: mask(card.headline), support: mask(card.support) } : null);

function title(text: string): string {
  return text.toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase());
}

/* ── individual cards ─────────────────────────────────────────────────────── */

/** Teaser: the archetype as a locked silhouette, its rarity glow, and three headline numbers. */
function cover(story: AuditStory | null, board: BoardData): DeckCard | null {
  const a = story?.archetype;
  if (!story || !a || story.state === 'empty') return null;
  const spend = spendOf(story);
  const numbers: { value: string; label: string }[] = [];
  if (story.totals.prompts) numbers.push({ value: count(story.totals.prompts), label: 'prompts' });
  if (story.totals.spanDays) numbers.push({ value: count(story.totals.spanDays), label: 'days' });
  const money$ = spend?.measuredUsd ?? board.hero.value;
  if (money$ && money$ > 0) numbers.push({ value: money(money$).replace(/\.\d+$/, ''), label: 'at API prices' });
  const tier = ['common', 'rare', 'epic', 'legendary'].includes(a.rarity) ? a.rarity : null;
  return {
    kind: 'cover', id: 'cover', kicker: 'YOUR YEAR WITH AGENTS', expression: 'waving',
    headline: 'You were someone this year.', support: 'The verdict is at the end. First, the evidence.',
    notes: ['Everything in this story is computed on this machine from your agents\' history files. The locked title is your archetype: it unlocks at the end.'],
    data: { words: a.title.split(/\s+/).map(w => w.length), tier: tier as CoverData['tier'], numbers },
  };
}

const COLD_CAPTIONS: Record<string, string> = {
  first_prompt: 'The first thing you ever said to a coding agent. On this machine, anyway.',
  most_expensive: 'You typed this. Remember it. It comes back later.',
  last_words: 'The last thing you said to a project before you left it.',
  late_night: 'You typed this in the middle of the night.',
};

function coldOpen(story: AuditStory | null): DeckCard | null {
  const cold = story?.coldOpen;
  const coldQuote = safeQuote(cold?.quote);
  if (cold && coldQuote) {
    const time = Number.isInteger(cold.hour) ? ` · ${hourLabel(cold.hour)}` : '';
    return {
      kind: 'cold_open', id: 'cold_open', kicker: 'BEFORE WE START', expression: 'idle', headline: coldQuote, support: '',
      notes: ['One sentence you typed, quoted exactly (swears masked). Quotes only come from a few fixed slots (first prompt, most expensive prompt, last words to a project) and are checked for paths, keys, emails and sensitive topics first.'],
      data: { quote: coldQuote, stamp: `${shortDate(cold.day, true)}${time}`, caption: COLD_CAPTIONS[cold.why] ?? '' },
    };
  }
  const pricey = story?.highlights.mostExpensivePrompt;
  const quote = safeQuote(pricey?.quote);
  if (pricey && quote) {
    return {
      kind: 'cold_open', id: 'cold_open', kicker: 'BEFORE WE START', expression: 'idle',
      headline: quote, support: '',
      notes: ['This is one sentence you typed, quoted exactly (swears masked). It was picked because of what it cost, which comes on the next card.', 'Quotes only come from a few fixed slots and are checked for paths, keys, emails and sensitive topics first.'],
      data: { quote, stamp: `${shortDate(pricey.day, true)}${pricey.model ? ` · ${modelName(pricey.model)}` : ''}`, caption: 'You typed this. Remember it. It comes back later.' },
    };
  }
  const first = story?.highlights.firstPrompt;
  const firstQuote = first && !first.shellCommand ? safeQuote(first.quote) : null;
  if (first && firstQuote) {
    return {
      kind: 'cold_open', id: 'cold_open', kicker: 'BEFORE WE START', expression: 'idle', headline: firstQuote, support: '',
      notes: ['The first prompt we could find on this machine, quoted exactly (swears masked).'],
      data: { quote: firstQuote, stamp: shortDate(first.day, true), caption: 'The first thing you ever said to a coding agent. On this machine, anyway.' },
    };
  }
  return null;
}

function scale(story: AuditStory | null, board: BoardData): DeckCard | null {
  const prompts = story?.totals.prompts ?? board.stats.prompts;
  if (!prompts) return null;
  const counters: Counter[] = [{ label: 'PROMPTS', value: prompts, style: 'count' }];
  const chats = board.stats.chats ?? story?.totals.sessions;
  if (chats) counters.push({ label: 'CHATS', value: chats, style: 'count' });
  const tokens = story?.totals.tokens || board.stats.tokens;
  if (tokens) counters.push({ label: 'TOKENS', value: tokens, style: 'compact' });
  const days = story?.totals.activeDays ?? board.stats.activeDays;
  if (days) counters.push({ label: 'ACTIVE DAYS', value: days, style: 'count' });
  const streak = story?.totals.longestStreakDays ?? board.stats.streak;
  if (counters.length < 4 && streak) counters.push({ label: 'DAY STREAK', value: streak, style: 'days' });
  const span = story?.totals.spanDays;
  const words = story?.totals.words;
  const support = [
    span ? `${count(span)} days from your first prompt to your latest` : board.range.from ? `since ${shortDate(board.range.from, true)}` : null,
    words ? `${compact(words)} words typed` : null,
    streak && counters.every(c => c.label !== 'DAY STREAK') ? `longest streak ${streak} days` : null,
  ].filter(Boolean).join(' · ');
  return {
    kind: 'scale', id: 'scale', kicker: 'THE SCALE OF IT', expression: 'idle',
    headline: `${count(prompts)} things you said to a machine.`,
    support,
    notes: ['Prompts are messages you typed yourself. Tool output, pasted context and slash commands are not counted.', 'Chats are top-level conversations; subagents fold into the chat that started them.', 'Tokens include input, output, cache and reasoning tokens where the agent recorded them.'],
    data: { counters: counters.slice(0, 4) },
  };
}

function bill(story: AuditStory | null, board: BoardData): DeckCard | null {
  const total = board.hero.value ?? story?.totals.costUsd ?? null;
  if (!total || total <= 0) return null;
  const rows = board.models.rows.filter(row => row.value !== null && row.value > 0);
  const shown = rows.slice(0, 6).map(row => ({ name: row.name, value: row.value! }));
  const more = rows.slice(6).reduce((sum, row) => sum + (row.value ?? 0), 0);
  const pricey = story?.highlights.mostExpensivePrompt ?? null;
  const card = cardOf(story, 'most_expensive_sentence');
  const sv = spendOf(story);
  const headline = sv
    ? `${money(sv.measuredUsd)} of agent work, at API list prices.`
    : pricey
      ? `Your most expensive sentence cost ${money(pricey.costUsd)}.`
      : `Your agents would have cost ${money(total)} at API prices.`;
  const support = sv
    ? [sv.perActiveDayUsd > 0 ? `${money(sv.perActiveDayUsd)} per active day` : null, sv.priciestDay ? `worst day ${shortDate(sv.priciestDay.day)}: ${money(sv.priciestDay.usd)}` : null, pricey ? `and that sentence? ${money(pricey.costUsd)}` : null].filter(Boolean).join(' · ') + '.'
    : pricey
    ? `${shortDate(pricey.day)}${pricey.model ? `, ${modelName(pricey.model)}` : ''}. That's ${Math.round(pricey.timesMedian)}× your median prompt and ${Math.round(pricey.sharePct)}% of everything.`
    : card ? mask(card.support) : 'What your recorded tokens would cost at public list prices. Not a bill.';
  return {
    kind: 'bill', id: 'bill', kicker: 'THE BILL', expression: 'shocked', headline, support,
    notes: ['The total is what your recorded tokens would cost at public API list prices. It is not what you paid: subscriptions and discounts are unknown.',
      '"Measured" is priced request by request from usage logs. "Recovered" comes from usage counters that the logs no longer cover. "Est." is a low–high range for older prompts whose token logs are gone; it is never added to the measured total.', 'A prompt’s cost includes the subagents it started, counted by time window.', 'Models priced from the closest model in the list are marked ~ on the board.'],
    data: { total, lines: shown, more, byAgent: board.agentSplit, priciest: pricey ? { cost: pricey.costUsd, day: pricey.day, model: pricey.model ? modelName(pricey.model) : null } : null, spend: spendView(story) },
  };
}

function spendView(story: AuditStory | null): SpendView | null {
  const sp = spendOf(story);
  if (!sp || sp.measuredUsd <= 0) return null;
  return {
    measured: sp.measuredUsd,
    recovered: sp.recoveredUsd > 0.5 ? sp.recoveredUsd : null,
    estimated: sp.estimated ? { low: sp.estimated.lowUsd, high: sp.estimated.highUsd, prompts: sp.estimated.prompts } : null,
    months: sp.monthly.map(m => ({ month: m.month, measured: m.measuredUsd, extra: Math.max(0, m.recoveredUsd) + Math.max(0, m.estimatedUsd) })),
    days: [...sp.daily],
    thisMonth: sp.monthly.length ? sp.thisMonthUsd : null,
    perDay: sp.perActiveDayUsd > 0 ? sp.perActiveDayUsd : null,
    priciestDay: sp.priciestDay,
  };
}

function clock(story: AuditStory | null): DeckCard | null {
  const rhythm = story?.rhythm;
  if (!rhythm || rhythm.weekdayHour.length !== 7) return null;
  const total = rhythm.weekdayHour.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  if (total < 50) return null;
  const owl = cardOf(story, 'night_owl');
  const copy = engineCopy(owl);
  const peak = rhythm.peakHour !== null && rhythm.peakWeekday !== null ? `${WEEKDAYS[rhythm.peakWeekday]} around ${hourLabel(rhythm.peakHour).toLowerCase().replace(' ', '')}` : null;
  const peakLine = rhythm.peakHour !== null && rhythm.peakWeekday !== null ? `${WEEKDAYS[rhythm.peakWeekday]}, ${hourLabel(rhythm.peakHour)}. That's you.` : null;
  const headline = peakLine ?? copy?.headline ?? (story?.peakTime ? `You're a ${mask(story.peakTime.label)} person.` : peak ? `Peak you: ${peak}.` : 'Your week, hour by hour.');
  const support = (peakLine && copy ? copy.headline + ' ' + copy.support : null) ?? copy?.support ?? story?.peakTime?.narrative ?? (rhythm.lateNightDaysPct !== null ? `${Math.round(rhythm.lateNightDaysPct)}% of your days end after 1am.` : '');
  const busiest = [...(spendOf(story)?.daily ?? [])].sort((a, b) => b.prompts - a.prompts)[0];
  return {
    kind: 'clock', id: owl ? 'night_owl' : 'clock', kicker: 'YOUR CLOCK', expression: (rhythm.lateNightDaysPct ?? 0) >= 25 ? 'sleepy' : 'idle',
    headline, support: mask(support),
    notes: [`Every prompt placed on a weekday × hour grid in your timezone (${sanitize(story!.timezone)}). Brighter = more prompts.`, 'A "day" runs 6am to 6am, so a 2am prompt belongs to the night before.', 'Angriest and calmest hours only count hours with at least 50 prompts.'],
    data: { grid: rhythm.weekdayHour.map(row => [...row]), peakHour: rhythm.peakHour, peakWeekday: rhythm.peakWeekday, lateNightPct: rhythm.lateNightDaysPct, callouts: clockCallouts(story!, owl) },
    callouts: busiest && busiest.prompts > 0 ? [`busiest day ever: ${shortDate(busiest.day, true)}, ${count(busiest.prompts)} prompts`] : undefined,
  };
}

const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clockCallouts(story: AuditStory, owl: StoryCard | null): { label: string; value: string; sub: string }[] {
  const r = story.rhythm;
  const out: { label: string; value: string; sub: string }[] = [];
  if (r.peakHour !== null && r.peakWeekday !== null) out.push({ label: 'PEAK', value: `${SHORT_DAYS[r.peakWeekday]} ${hourLabel(r.peakHour)}`, sub: 'your busiest hour of the week' });
  if (r.lateNightDaysPct !== null && r.lateNightDaysPct >= 5) out.push({ label: 'LATE NIGHTS', value: `${Math.round(r.lateNightDaysPct)}%`, sub: 'of days end after 1am' });
  const angry = num(owl, 'angriestHour');
  if (angry !== null) out.push({ label: 'ANGRIEST HOUR', value: hourLabel(angry), sub: `${Math.round(num(owl, 'angriestPct') ?? 0)}% of prompts swear` });
  const calm = num(owl, 'calmestHour');
  if (calm !== null) out.push({ label: 'SAINT HOUR', value: hourLabel(calm), sub: `${count(num(owl, 'calmestSwears'))} swears in ${count(num(owl, 'calmestPrompts'))} prompts` });
  if (out.length < 4 && r.weekendPct !== null) out.push({ label: 'WEEKENDS', value: `${Math.round(r.weekendPct)}%`, sub: 'of your prompts' });
  return out.slice(0, 4);
}

function guess(story: AuditStory | null, board: BoardData, snapshot: AuditSnapshot): DeckCard | null {
  const share = modelShareOf(story);
  if (share && share.rows.length >= 2) {
    // One row per model (aliases merged upstream and again in modelShareOf), so no two choices are the same model.
    const rows = share.rows.slice(0, 4);
    const options = rows.map(m => ({ name: mask(m.label), share: m.tokenSharePct / 100 }));
    const seed = rows.reduce((sum, m) => sum + m.prompts, 0) % 997;
    const order = options.map((_, i) => i).sort((a, b) => ((a * 7 + seed) % 11) - ((b * 7 + seed) % 11));
    const leader = rows[0]!;
    const priciest = [...share.rows].sort((a, b) => b.usd - a.usd)[0]!;
    const unknown = share.unknownModelPrompts;
    const twist = priciest.label !== leader.label && priciest.usd > 0
      ? `…but ${mask(priciest.label)} cost you the most: ${money(priciest.usd)}.`
      : `${mask(leader.label)} wrote ${Math.round(leader.tokenSharePct)}% of everything your agents said back.`;
    return {
      kind: 'guess', id: 'guess', kicker: 'QUICK QUIZ', expression: 'smirk',
      headline: 'Which model did the most work?', support: `Press 1–${options.length} to guess.`,
      notes: [
        'Ranked by share of output tokens: what each model actually wrote back to you, across every agent on this machine. Only answers with a recorded model count.',
        unknown > 0 ? `${count(unknown)} older prompts have no recorded model (their history survived but the answer did not). They are left out, never guessed.` : '',
      ].filter(Boolean),
      data: { options: order.map(i => options[i]!), answer: order.indexOf(0), basis: 'share of output tokens', after: twist + (unknown > 0 ? ` (${count(unknown)} older prompts have no recorded model.)` : '') },
    };
  }
  const top = story?.models.top ?? [];
  if (top.length >= 2) {
    const options = top.slice(0, 4).map(m => ({ name: displayModel(m.model, m.label), share: m.sharePct / 100 }));
    const seed = top.reduce((sum, m) => sum + m.prompts, 0) % 997;
    const order = options.map((_, i) => i).sort((a, b) => ((a * 7 + seed) % 11) - ((b * 7 + seed) % 11));
    const d = story!.models.defection;
    const defCard = cardOf(story, 'defection');
    const after = defCard ? mask(defCard.headline) : d ? `You left ${d.from} for ${d.to} the week of ${shortDate(d.weekStart)}.` : `${options[0]!.name} answered ${Math.round(options[0]!.share * 100)}% of your prompts.`;
    return {
      kind: 'guess', id: 'guess', kicker: 'QUICK QUIZ', expression: 'smirk',
      headline: 'Which model did you talk to most?', support: `Press 1–${options.length} to guess.`,
      notes: ['Ranked by prompts each model answered (seen in transcripts, or inferred from the same day when only your typed history survives).', 'A switch is a run of weeks on one agent followed by at least three weeks on another.'],
      data: { options: order.map(i => options[i]!), answer: order.indexOf(0), basis: 'share of prompts', after },
    };
  }
  const models = (snapshot.launch?.facts?.models ?? []).filter(m => (m.canonicalModel ?? m.model) && (m.knownTokens ?? m.totalTokens ?? 0) > 0);
  if (models.length < 2) return null;
  const tokens = (m: typeof models[number]) => m.knownTokens ?? m.totalTokens ?? 0;
  const sum = models.reduce((s, m) => s + tokens(m), 0);
  const ranked = [...models].sort((a, b) => tokens(b) - tokens(a)).slice(0, 4);
  const options = ranked.map(m => ({ name: modelName(m.canonicalModel ?? m.model), share: tokens(m) / sum }));
  // Deterministic shuffle so the answer is not always "1".
  const seed = Math.round(sum) % 997;
  const order = options.map((_, i) => i).sort((a, b) => ((a * 7 + seed) % 11) - ((b * 7 + seed) % 11));
  const shuffled = order.map(i => options[i]!);
  const answer = order.indexOf(0);
  const defection = cardOf(story, 'defection');
  const leader = options[0]!;
  return {
    kind: 'guess', id: 'guess', kicker: 'QUICK QUIZ', expression: 'smirk',
    headline: 'Which model did you lean on most?',
    support: 'Press 1–' + shuffled.length + ' to guess.',
    notes: ['Ranked by tokens processed for you (input + output + cache), across every agent on this machine.', 'Switches are found week by week: a run of weeks on one agent followed by three weeks on another.'],
    data: {
      options: shuffled, answer, basis: 'share of all tokens',
      after: defection ? mask(defection.headline) : `${leader.name} did ${Math.round(leader.share * 100)}% of the heavy lifting.`,
    },
  };
  void board;
}

function timelineBeat(story: AuditStory | null): { line: string; eras: { month: string; label: string }[]; now: string | null } | null {
  const share = modelShareOf(story);
  const tl = share?.timeline ?? [];
  if (tl.length < 2) return null;
  const first = tl[0]!, last = tl.at(-1)!;
  const now = share!.last30d[0];
  const short = (l: string) => mask(l);
  const line = first.label !== last.label
    ? `You started on ${short(first.label)}. You're ending on ${short(last.label)}.`
    : `${short(first.label)} from ${monthLabel(first.month)} to ${monthLabel(last.month)}. No notes.`;
  return { line, eras: tl.map(t => ({ month: t.month, label: mask(t.label) })), now: now ? `last 30 days: ${mask(now.label)}, ${Math.round(now.promptSharePct)}% of prompts` : null };
}

function faceoff(story: AuditStory | null): DeckCard | null {
  const best = story?.models.best ?? null;
  // A nemesis needs at least two month-matched months before it can headline.
  const worst = story?.models.worst && story.models.worst.matchedMonths >= 2 ? story.models.worst : null;
  const beat = timelineBeat(story);
  if (!best && !worst && !beat) return null;
  const gauge = (m: NonNullable<typeof best>, key: 'praise' | 'swear'): Gauge => ({
    label: displayModel(m.model, m.label), prompts: m.prompts,
    per100: key === 'praise' ? m.praisePer100 : m.swearPer100,
    expected: key === 'praise' ? m.expectedPraisePer100 : m.expectedSwearPer100,
    ratio: key === 'praise' ? m.praiseRatio : m.swearRatio,
  });
  const worstCard = worst ? cardOf(story, 'worst_model') : null;
  const bestCard = cardOf(story, 'best_model');
  const verdict = worstCard ? mask(worstCard.headline) : bestCard ? mask(bestCard.headline) : worst ? `${mask(worst.label)} brings out the worst in you.` : best ? `${mask(best.label)} is your favourite.` : '';
  const headline = beat?.line ?? verdict;
  const support = beat ? verdict : worstCard ? mask(worstCard.support) : bestCard ? mask(bestCard.support) : '';
  const honey = cardOf(story, 'honeymoon');
  const callouts = [
    beat && beat.eras.length ? `eras: ${erasLine(beat.eras)}` : null,
    beat?.now ?? null,
    honey ? mask(honey.headline) : null,
  ].filter((x): x is string => !!x);
  return {
    kind: 'faceoff', id: 'faceoff', kicker: 'THE MODEL LINEUP', expression: 'side-eye', headline, support, callouts,
    notes: ['Rates per 100 prompts sent to each model, compared with what the other models got from you in the same months (month-matched), so a model is not blamed for the month you had.', 'Only models with at least 40 prompts seen in transcripts are ranked.'],
    data: { best: best ? gauge(best, 'praise') : null, worst: worst ? gauge(worst, 'swear') : null, ...compareOf(worstCard ?? bestCard), eras: beat?.eras ?? [] },
  };
}

function erasLine(eras: { label: string }[]): string {
  const seq: string[] = [];
  for (const e of eras) if (seq.at(-1) !== e.label) seq.push(e.label);
  return seq.join(' ▸ ');
}

/** Observed vs month-matched expected per model, from the worst/best model chart. */
function compareOf(card: StoryCard | null): { compare: { label: string; observed: number; expected: number | null; highlight: boolean }[]; compareUnit: string } {
  const observed = card?.chart.series.find(sr => /observed/i.test(sr.name)) ?? card?.chart.series[0];
  const expected = card?.chart.series.find(sr => /expected/i.test(sr.name));
  if (!card || !observed) return { compare: [], compareUnit: '' };
  return {
    compare: observed.points.slice(0, 6).map(p => ({
      label: mask(String(p.x)), observed: p.y,
      expected: expected?.points.find(q => String(q.x) === String(p.x))?.y ?? null,
      highlight: card.chart.highlight !== undefined && String(card.chart.highlight) === String(p.x),
    })),
    compareUnit: card.id === 'best_model' ? 'thank-yous per 100 prompts' : 'swears per 100 prompts',
  };
}

function mood(story: AuditStory | null): DeckCard | null {
  const card = cardOf(story, 'mood_drift');
  if (!card || !story) return null;
  const months = story.swearTimeline.filter(m => m.prompts >= 20).map(m => ({ month: m.month, pct: m.swearPct }));
  if (months.length < 3) return null;
  const tipMonth = str(card, 'tipMonth') ?? (typeof card.chart.highlight === 'string' ? card.chart.highlight : null);
  const tip = Math.max(0, months.findIndex(m => m.month === tipMonth));
  const mellow = (num(card, 'latePct') ?? 1) < (num(card, 'earlyPct') ?? 0);
  // Third act: nice → feral → making amends, when the latest month is under half the peak.
  const peak = months.reduce((a, m) => (m.pct > a.pct ? m : a), months[0]!);
  const last = months.at(-1)!;
  const amends = !mellow && peak !== last && last.pct <= peak.pct / 2;
  const manners = cardOf(story, 'thanks_vs_swears');
  const rants = cardOf(story, 'rant_length');
  const callouts = [
    amends ? `and then: ${monthLabel(peak.month)} peaked at ${peak.pct.toFixed(0)}%. ${monthLabel(last.month)}: back to ${last.pct.toFixed(1).replace(/\.0$/, '')}%. character development.` : null,
    manners ? mask(manners.headline) + (num(manners, 'pleases') !== null ? ` (${count(num(manners, 'pleases'))} pleases, ${count(num(manners, 'thanks'))} thank-yous)` : '') : null,
    rants ? mask(rants.headline) + (rants.support ? ' ' + mask(rants.support) : '') : null,
  ].filter((x): x is string => !!x);
  return {
    kind: 'mood', id: card.id, kicker: mellow ? 'YOU MELLOWED OUT' : amends ? 'MAKING AMENDS' : 'THE TURN', expression: mellow || amends ? 'proud' : 'smirk',
    headline: mask(card.headline), support: mask(card.support), callouts,
    notes: ['Share of each month’s prompts that contain a swear word or an insult (months with 40+ prompts).', 'The marked month is the first one that reached half of your recent rate.', 'Pasted text is ignored: only what you typed counts.'],
    data: { months, tip },
  };
}

function fuse(story: AuditStory | null): DeckCard | null {
  const f = story?.highlights.fuse;
  const card = cardOf(story, 'fuse_length');
  if (!f || !card) return null;
  return {
    kind: 'fuse', id: card.id, kicker: 'HOW YOU SNAP', expression: 'smirk', headline: mask(card.headline), support: mask(card.support),
    callouts: [cardOf(story, 'esc_key'), cardOf(story, 'rage_day'), cardOf(story, 'walk_away')].filter((x): x is StoryCard => !!x).map(x => mask(x.headline) + (x.support && x.id !== 'walk_away' ? ' ' + mask(x.support) : '')),
    notes: ['Sessions with at least 5 prompts and at least one swear. The fuse is the median prompt number of the first swear.'],
    data: {
      median: f.medianTurn, sessions: f.sessions, of: f.ofSessions, firstPrompt: f.firstPromptSwears,
      hist: (card.chart.series[0]?.points ?? []).filter(p => Number(p.x) >= 1).sort((a, b) => Number(a.x) - Number(b.x)).map(p => p.y),
    },
  };
}

function talk(story: AuditStory | null, board: BoardData): DeckCard | null {
  const tiles: Tile[] = [];
  const h = story?.highlights;
  if (h?.catchphrase) {
    const ru = h.catchphrase.runnersUp[0];
    tiles.push({ label: 'YOUR CATCHPHRASE', text: mask(h.catchphrase.phrase), count: h.catchphrase.count, quoted: true, sub: ru ? `runner-up “${mask(ru.phrase)}” ×${count(ru.count)}` : undefined });
  }
  const cont = cardOf(story, 'continue_count');
  if (cont && str(cont, 'word')) {
    const total = num(cont, 'total'), gap = str(cont, 'gapLabel');
    tiles.push({ label: 'YOUR NUDGE', text: mask(str(cont, 'word')!), count: num(cont, 'count'), quoted: true, sub: total ? `${count(total)} nudges${gap ? `, ~${gap} after it stops` : ''}` : undefined });
  } else if (h?.mostTypedLine) tiles.push({ label: 'MOST TYPED LINE', text: mask(h.mostTypedLine.text), count: h.mostTypedLine.count, quoted: true });
  if (h?.petName) {
    const other = h.petName.others[0];
    tiles.push({ label: 'WHAT YOU CALL IT', text: mask(h.petName.term), count: h.petName.count, quoted: true, sub: other ? `also “${mask(other.term)}” ×${count(other.count)}` : undefined });
  }
  const typo = cardOf(story, 'typo_fingerprint');
  if (typo && str(typo, 'typo')) tiles.push({ label: `IT'S “${mask(str(typo, 'word') ?? '?')}”`, text: mask(str(typo, 'typo')!), count: num(typo, 'count'), quoted: true, sub: mask(typo.support).slice(0, 60) || undefined });
  const we = cardOf(story, 'i_to_we');
  if (we && num(we, 'lateRatio') !== null) tiles.push({ label: '“WE” PER “I”', text: `${num(we, 'earlyRatio')?.toFixed(2) ?? '?'} → ${num(we, 'lateRatio')!.toFixed(2)}`, count: null, quoted: false, sub: num(we, 'letsNowPct') !== null ? `“let's” in ${Math.round(num(we, 'letsNowPct')!)}% of prompts now` : undefined });
  const next = cardOf(story, 'predicted_next_word');
  if (next && str(next, 'word') && tiles.length < 4) tiles.push({ label: 'NEXT PROMPT STARTS WITH', text: mask(str(next, 'word')!), count: null, quoted: true });
  // 1.7.x fallback: things typed again and again.
  if (!story) for (const row of board.repeats.rows.slice(0, 4)) tiles.push({ label: tiles.length ? 'ON REPEAT' : 'MOST TYPED LINE', text: mask(row.text), count: row.count, quoted: true });
  if (tiles.length < 2) return null;
  const lead = cardOf(story, 'verbal_tics') ?? cont ?? cardOf(story, 'pet_names');
  const first = tiles[0]!;
  return {
    kind: 'talk', id: 'talk', kicker: 'HOW YOU TALK', expression: 'smirk',
    headline: lead ? mask(lead.headline) : `You've typed “${first.text}” ${count(first.count)} times.`,
    support: lead ? mask(lead.support) : 'The lines you type again and again.',
    notes: ['Phrases are counted in text you typed (pastes excluded). A catchphrase must appear at least 25 times and is ranked against how common it is in everyday English.', 'Pet names count only when you address the agent with them ("thanks dude", "ok man,").'],
    data: { tiles: tiles.slice(0, 4) },
  };
}

function manners(story: AuditStory | null): DeckCard | null {
  const card = cardOf(story, 'thanks_vs_swears');
  if (!card) return null;
  const thanks = num(card, 'thanks') ?? 0;
  const pleases = num(card, 'pleases') ?? 0;
  const fbombs = num(card, 'fbombs');
  const rude = fbombs ?? num(card, 'swears') ?? 0;
  if (!rude && !thanks) return null;
  return {
    kind: 'manners', id: card.id, kicker: 'MANNERS METER', expression: rude > thanks ? 'smirk' : 'heart-eyes',
    headline: mask(card.headline), support: mask(card.support),
    notes: ['Thank-yous and pleases vs swear words, counted in text you typed. If there are fewer than 15 f-words, every swear counts.'],
    data: { kind: thanks + pleases, rude, kindLabel: 'thank-yous & pleases', rudeLabel: fbombs !== null ? 'f-bombs' : 'swears', prompts: num(card, 'prompts') },
  };
}

function projects(story: AuditStory | null, board: BoardData): DeckCard | null {
  const list = story ? [...story.projects].filter(p => p.prompts > 0).sort((a, b) => b.prompts - a.prompts) : [];
  const rows: ProjectRow[] = list.length
    ? list.slice(0, 6).map(p => ({ name: sanitize(p.name ?? p.alias), prompts: p.prompts, cost: p.costUsd > 0 ? p.costUsd : null }))
    : board.projects.rows.slice(0, 6).map(p => ({ name: p.name, prompts: p.prompts, cost: null }));
  if (rows.length < 3) return null;
  const away = story?.highlights.gotAway;
  const awayCard = cardOf(story, 'one_that_got_away');
  const pricey = cardOf(story, 'priciest_project');
  const top = rows[0]!;
  return {
    kind: 'projects', id: 'projects', kicker: 'YOUR PROJECT UNIVERSE', expression: 'idle',
    callouts: [cardOf(story, 'sprint_and_vanish'), cardOf(story, 'project_graveyard')].filter((x): x is StoryCard => !!x).map(x => mask(x.headline)),
    headline: awayCard ? mask(awayCard.headline) : `${top.name} got ${Math.round((top.prompts / rows.reduce((s, r) => s + r.prompts, 0)) * 100)}% of your top-project attention.`,
    // The support line must back the headline: got-away facts under a got-away headline, cost otherwise.
    support: awayCard ? mask(awayCard.support) : pricey ? mask(pricey.headline) : `${count(story?.totals.projects ?? board.stats.projects)} projects in all.`,
    notes: ['Projects are the folders you typed prompts in. Names stay on this machine; the share card replaces them.', '"Got away" = a project with 60+ prompts and no prompt in the last 45 days of your history.'],
    data: {
      rows,
      gotAway: away ? { name: sanitize(away.project ?? 'a project'), prompts: away.prompts, days: away.activeDays, idle: away.idleDays, lastDay: away.lastDay, lastWords: safeQuote(away.lastWords) } : null,
    },
  };
}

function delegation(story: AuditStory | null): DeckCard | null {
  const card = cardOf(story, 'orchestrator');
  if (!card) return null;
  const total = num(card, 'total') ?? story!.totals.subagents;
  const series = card.chart.series[0]?.points ?? [];
  const months = series.map(p => ({ month: String(p.x), n: p.y }));
  return {
    kind: 'delegation', id: card.id, kicker: 'FROM DOING TO MANAGING', expression: 'proud',
    headline: mask(card.headline), support: mask(card.support),
    notes: ['Subagents are counted from Task/Agent tool calls (Claude Code) and spawn calls (Codex) in your transcripts.'],
    data: { total, months, firstMonth: str(card, 'firstMonth') },
  };
}

function thenNow(story: AuditStory | null): DeckCard | null {
  const first = story?.highlights.firstPrompt;
  const latest = story?.highlights.latestPrompt;
  const card = cardOf(story, 'first_vs_latest');
  if (!first || !latest || !card) return null;
  return {
    kind: 'then_now', id: card.id, kicker: 'THEN AND NOW', expression: 'proud', headline: mask(card.headline), support: mask(card.support),
    notes: ['Your first and latest prompts on this machine. A quote is shown only when it passes the privacy filter; otherwise just the length.'],
    data: {
      then: { day: first.day, words: first.words, quote: first.shellCommand ? null : safeQuote(first.quote), shell: first.shellCommand },
      now: { day: latest.day, words: latest.words, quote: safeQuote(latest.quote) },
      spanDays: story!.totals.spanDays, prompts: story!.totals.prompts,
    },
  };
}

function archetype(story: AuditStory | null): DeckCard | null {
  const a = story?.archetype;
  if (!a) return null;
  const tier = ['common', 'rare', 'epic', 'legendary'].includes(a.rarity) ? a.rarity
    : a.confidence >= 0.85 ? 'legendary' : a.confidence >= 0.7 ? 'epic' : a.confidence >= 0.5 ? 'rare' : 'common';
  return {
    kind: 'archetype', id: 'archetype', kicker: 'THIS YEAR YOU’VE BEEN…', expression: 'proud',
    headline: mask(a.title), support: mask(a.tagline || a.profile),
    notes: [
      'The archetype is chosen locally from your numbers: each archetype has a rule, the highest score wins, ties go to a fixed order. The bars are the three metrics that decided it.',
      a.code ? `Your code ${sanitize(a.code)}: Night/Day · Spec/Vibe · Loyal/Roaming · Kind/Hot-headed (thank-yous and pleases vs swears).` : '',
      'Rarity = how extreme your deciding numbers are on fixed scales. It is not how many other people got it: slopie never sees anyone else\'s data.',
      a.source === 'jev' ? 'The wording was picked by Jev from local variants; any number not in your facts is rejected.' : 'The wording is a local template.',
    ].filter(Boolean),
    data: {
      title: mask(a.title), tagline: mask(a.tagline ?? ''), profile: mask(a.profile), subRole: a.subRole ? mask(a.subRole.label) : null, code: a.code || null,
      codeWords: codeWords(a.code),
      // The archetypes you nearly got, best first (real scores; the slot roll uses them).
      runners: (a.scores ?? []).filter(x => x.id !== a.id && x.score > 0).slice(0, 3).map(x => ({ title: mask(x.title), score: Math.round(x.score * 100) / 100 })),
      deciding: (a.deciding ?? []).slice(0, 3).map(m => ({ label: mask(m.label), display: mask(m.display), band: Math.max(0, Math.min(1, m.band)) })),
      tier: tier as 'common' | 'rare' | 'epic' | 'legendary',
    },
  };
}

const CODE_WORDS: Record<string, string>[] = [{ N: 'night', D: 'day' }, { S: 'spec', V: 'vibe' }, { L: 'loyal', R: 'roaming' }, { K: 'kind', H: 'hot-headed' }];
function codeWords(code: string | null | undefined): string[] {
  if (!code || code.length !== 4) return [];
  return [...code].map((ch, i) => CODE_WORDS[i]![ch] ?? ch);
}

function awards(story: AuditStory | null): DeckCard | null {
  const list = story?.awards ?? [];
  if (list.length < 3) return null;
  const trophies: Trophy[] = list.slice(0, 6).map(award => {
    const split = (text: string): [string, string] => {
      const dot = text.indexOf(' · ');
      if (dot > 0) return [text.slice(0, dot).trim(), text.slice(dot + 3).trim()];
      const colon = text.indexOf(': ');
      if (colon > 0) return [text.slice(colon + 2).trim(), text.slice(0, colon).trim()];
      const comma = text.indexOf(', ');
      return comma > 0 ? [text.slice(0, comma).trim(), text.slice(comma + 2).trim()] : [text.trim(), ''];
    };
    const [value, sub] = split(mask(award.receipt));
    const [publicValue, publicSub] = split(mask(award.publicReceipt));
    const tier = (award as { tier?: unknown }).tier;
    return { id: award.id, title: mask(award.title), value, sub, publicValue, publicSub, tier: tier === 'gold' || tier === 'silver' ? tier : undefined } as Trophy;
  });
  return {
    kind: 'awards', id: 'awards', kicker: 'THE AWARDS', expression: 'proud',
    headline: `${trophies.length} awards nobody asked for.`, support: 'Every one is real, ranked by how unusual it is for you. Receipts on the shelf.',
    notes: ['Every award comes from a detector that fired on your history and carries its receipt; none are participation trophies.'],
    data: { trophies },
  };
}

function insight(card: StoryCard): DeckCard {
  const expression: Expression = card.kind === 'mood' ? 'smirk' : card.kind === 'money' ? 'shocked' : card.kind === 'time' ? 'sleepy' : card.kind === 'model' ? 'side-eye' : 'idle';
  return {
    kind: 'insight', id: card.id, kicker: KICKERS[card.id] ?? card.kind.toUpperCase(), expression,
    headline: mask(card.headline), support: mask(card.support),
    notes: [`Detector "${card.id.replaceAll('_', ' ')}" fired with confidence ${Math.round(card.confidence * 100)}%.`],
    data: { chart: card.chart, motif: card.chart.motif ?? card.chart.type },
  };
}

const KICKERS: Record<string, string> = {
  honeymoon: 'THE HONEYMOON', rage_day: 'A BAD DAY', sprint_and_vanish: 'SPRINT, THEN SILENCE', rant_length: 'RANTS', walk_away: 'YOU WALK AWAY',
  weekend_self: 'WEEKEND YOU', command_to_question: 'ORDERS, THEN QUESTIONS', prompt_length_evolution: 'LONGER PROMPTS', project_graveyard: 'THE GRAVEYARD',
  esc_key: 'THE ESC KEY', marathon: 'THE MARATHON', streak: 'THE STREAK', day_night_topics: 'DAY YOU, NIGHT YOU', defection: 'THE SWITCH',
};

/** Detectors that feed a dedicated card (never shown again as a generic insight). */
const CONSUMED = new Set([
  'rant_length', 'esc_key', 'rage_day', 'walk_away', 'honeymoon', 'sprint_and_vanish', 'project_graveyard',
  'most_expensive_sentence', 'mood_drift', 'worst_model', 'best_model', 'thanks_vs_swears', 'one_that_got_away', 'continue_count', 'verbal_tics',
  'fuse_length', 'pet_names', 'defection', 'night_owl', 'i_to_we', 'typo_fingerprint', 'first_vs_latest', 'orchestrator', 'priciest_project', 'predicted_next_word',
]);

function boardSummary(story: AuditStory | null, board: BoardData, deck: DeckCard[]): DeckCard {
  const arche = deck.find(c => c.kind === 'archetype');
  const a = arche?.kind === 'archetype' ? arche.data : null;
  const awardsCard = deck.find(c => c.kind === 'awards');
  const awards = awardsCard?.kind === 'awards' ? awardsCard.data.trophies.slice(0, 6).map(tr => ({ id: tr.id, title: tr.title, value: tr.value, publicValue: tr.publicValue ?? tr.value, sub: tr.sub || undefined, publicSub: tr.publicSub || undefined, tier: tr.tier })) : [];
  const data = boardSummaryData(story, board, {
    archetype: a ? { title: a.title, tier: a.tier, subRole: a.subRole, code: a.code, tagline: a.tagline } : null,
    awards, mask,
  });
  return {
    kind: 'board', id: 'board', kicker: 'YOUR YEAR WITH AGENTS', expression: 'waving',
    headline: a ? `This year you've been ${a.title}.` : 'Your year with coding agents.',
    support: data.range ?? '',
    notes: [
      'The share card. Press s to save it as an SVG: project names are replaced and none of your words are included.',
      'Money is what your recorded tokens would cost at public API list prices, not what you paid. "Measured" is priced from per-request logs; "recovered" from usage counters the logs no longer cover; "est." is a range for older prompts whose token logs are gone.',
      'Model shares are by output tokens (who did the most work). Agent shares are by prompts you typed. Shares sum to 100%.',
    ],
    data,
  };
}

/* ── bridges ── */

/** Each card ends with a one-line lead-in to the next, so the deck reads as one story (≤ 48 chars, lowercase). */
function stitch(cards: DeckCard[], story: AuditStory | null, board: BoardData): void {
  const prompts = story?.totals.prompts ?? board.stats.prompts;
  const folders = story?.totals.projects ?? board.stats.projects;
  const peak = story?.rhythm.peakHour ?? null;
  const lead = (next: DeckCard): string => {
    switch (next.kind) {
      case 'cold_open': return "let's start with something you said.";
      case 'scale': return prompts ? `that was one of ${count(prompts)}.` : 'now the whole year.';
      case 'bill': return "it wasn't free.";
      case 'clock': return peak !== null ? `most of it around ${hourLabel(peak).toLowerCase()}. here's your clock.` : "let's look at your clock.";
      case 'guess': return 'and who was on the other end?';
      case 'faceoff': return "…but that's not the whole story.";
      case 'mood': return "you weren't always like this with them.";
      case 'manners': return 'let’s talk about your manners.';
      case 'fuse': return "here's exactly when you snap.";
      case 'talk': return "when you're calm, this is how you talk.";
      case 'projects': return folders ? `you said it across ${count(folders)} folders.` : 'where did it all go?';
      case 'delegation': return 'eventually you stopped doing it yourself.';
      case 'then_now': return 'which brings us to who you became.';
      case 'archetype': return prompts ? `so. after ${count(prompts)} prompts…` : 'so…';
      case 'awards': return 'you also won some things.';
      case 'board': return 'your year, on one poster. press s.';
      default: return `next: ${next.kicker.toLowerCase()}`;
    }
  };
  for (let i = 0; i < cards.length - 1; i++) {
    const text = lead(cards[i + 1]!);
    cards[i]!.bridge = text.length <= 48 ? text : text.slice(0, 47) + '…';
  }
}

/* ── assembly ── */

const cache = new WeakMap<AuditSnapshot, DeckCard[]>();

const MAX_EXTRAS = 1;

export function buildDeck(snapshot: AuditSnapshot): DeckCard[] {
  const hit = cache.get(snapshot);
  if (hit) return hit;
  const story = storyOf(snapshot);
  const board = boardData(snapshot);
  const safe = <T,>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
  const awardIds = new Set((story?.awards ?? []).map(a => a.id));
  const pool = (story?.cards ?? []).filter(c => !CONSUMED.has(c.id) && !awardIds.has(c.id)).sort((a, b) => a.rank - b.rank);
  let extrasLeft = MAX_EXTRAS;
  /** The best-ranked leftover detector of a section, as a chart card. */
  const extra = (section: string): DeckCard | null => {
    if (extrasLeft <= 0) return null;
    const i = pool.findIndex(c => (c as { section?: string }).section === section);
    if (i < 0) return null;
    extrasLeft--;
    return safe(() => insight(pool.splice(i, 1)[0]!));
  };
  // One wildcard: the best-ranked detector no dedicated card consumed, placed in its own act.
  const wild = pool[0] ?? null;
  const wildIn = (sections: string[]) => (wild && sections.includes((wild as { section?: string }).section ?? 'more') ? extra((wild as { section?: string }).section ?? 'more') : null);
  const turn = safe(() => mood(story));
  const deck: (DeckCard | null)[] = [
    // Cover
    safe(() => cover(story, board)),
    // I. The scale
    safe(() => coldOpen(story)),
    safe(() => scale(story, board)),
    safe(() => bill(story, board)),
    // II. The rhythm
    safe(() => clock(story)),
    wildIn(['clock']),
    // III. The models
    safe(() => guess(story, board, snapshot)),
    safe(() => faceoff(story)),
    wildIn(['models', 'best_worst']),
    // IV. The mood
    turn,
    turn ? null : safe(() => manners(story)),
    safe(() => fuse(story)),
    wildIn(['mood', 'manners', 'fuse']),
    // V. The voice
    safe(() => talk(story, board)),
    wildIn(['talk']),
    // VI. The work
    safe(() => projects(story, board)),
    safe(() => delegation(story)),
    wildIn(['projects', 'delegation', 'more', 'scale', 'bill', 'first_latest', 'cold_open', 'archetype', 'awards']),
    // VII. Who you became
    safe(() => thenNow(story)),
    safe(() => archetype(story)),
    safe(() => awards(story)),
  ];
  const cards = deck.filter((card): card is DeckCard => card !== null);
  cards.push(boardSummary(story, board, cards));
  stitch(cards, story, board);
  cache.set(snapshot, cards);
  return cards;
}

export { title, WEEKDAYS };
export const harness = harnessName;
