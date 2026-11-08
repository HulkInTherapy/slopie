/**
 * Deterministic developer archetype ("This year you've been… The 2AM Deployer") and the awards shelf.
 *
 * 22 archetypes (D-ux-story §4b) plus The Fresh Install for thin data, and five legendary combo
 * titles. Each archetype scores 0..1 from fixed metric bands (there is no population, so no
 * percentile is ever claimed). Highest wins, ties by list order; the runner-up is the sub-role;
 * rarity comes from how extreme the deciding metrics are. Every tagline quotes one of the user's
 * own numbers or words.
 *
 * Awards (§4c): 23 candidates computed here, ranked by surprise × wow; the shelf keeps six
 * (two gold, four silver). "New Personal Best" needs run history and is added by the UI.
 */
import type {StoryArchetype, StoryArchetypeMetric, StoryAward, StoryRarity} from './story-contracts.js';
import type {StoryRow} from './story-table.js';
import {FLAG, TICS, has} from './story-lexicon.js';
import {median, pct, family, longestStretch, longestStreak, modelLabel, type Draft} from './story-detectors.js';
import {HOUR_NAME, dayName, monthName} from './story-time.js';

export interface ArchetypeMetrics {
  prompts: number; activeDays: number; months: number;
  night: number; dawn: number; weekend: number; len: number; auto: number;
  swear: number; polite: number; praise: number; loyal: number; models: number; wideModels: number; agents: number;
  projects: number; focus: number; stretchH: number; longSessions: number; retry: number; plan: number; question: number;
  peakHour: number | null;
  /** v19 additions. */
  thanks: number; please: number; thanksCount: number; pleaseCount: number;
  swearSpread: number; swearMin: number; swearMinMonth: string | null; swearMax: number; swearMaxMonth: string | null;
  eras: number; eraFirst: string | null; eraLast: string | null; topModel: string | null;
  sprints: number; sprintPrompts: number; sprintDays: number;
  subs: number; subsPerSession: number; firstSubMonth: string | null;
  intrRate: number; intrTurns: number; esc: number; escSecs: number | null;
  fastReply: number; replyTurns: number;
  images: number; imagePct: number; pastePct: number; hiPct: number; hiPrompts: number;
  nudge: string | null; nudgeCount: number;
  totalProjects: number; alive: number;
}

type Unit = StoryArchetypeMetric['unit'];
interface MetricDef {key: keyof ArchetypeMetrics; label: string; unit: Unit; lo: number; hi: number; display: (v: number, m: ArchetypeMetrics) => string}
const f0 = (n: number) => n.toFixed(0);
const M: Record<string, MetricDef> = {
  night: {key: 'night', label: 'after 10pm', unit: 'pct', lo: 15, hi: 40, display: v => `${f0(v)}% of prompts after 10pm`},
  dawn: {key: 'dawn', label: 'before 9am', unit: 'pct', lo: 8, hi: 30, display: v => `${f0(v)}% of prompts 5–9am`},
  dayOnly: {key: 'night', label: 'daylight', unit: 'pct', lo: 20, hi: 5, display: v => `only ${f0(v)}% after 10pm`},
  len: {key: 'len', label: 'median words', unit: 'words', lo: 25, hi: 90, display: v => `${f0(v)}-word median prompt`},
  shortLen: {key: 'len', label: 'short prompts', unit: 'words', lo: 30, hi: 10, display: v => `${f0(v)}-word median prompt`},
  plan: {key: 'plan', label: 'structured prompts', unit: 'pct', lo: 8, hi: 30, display: v => `${f0(v)}% of prompts with lists or code`},
  lowPlan: {key: 'plan', label: 'no specs', unit: 'pct', lo: 10, hi: 2, display: v => `only ${f0(v)}% with lists or code`},
  lowAuto: {key: 'auto', label: 'few one-word nudges', unit: 'pct', lo: 20, hi: 5, display: v => `only ${f0(v)}% one-word nudges`},
  auto: {key: 'auto', label: 'autopilot', unit: 'pct', lo: 10, hi: 35, display: v => `${f0(v)}% of prompts are ≤3 words`},
  swear: {key: 'swear', label: 'swearing', unit: 'per100', lo: 3, hi: 15, display: v => `${f0(v)} swearing prompts per 100`},
  saltOverSweet: {key: 'swear', label: 'salt over sugar', unit: 'per100', lo: 0, hi: 10, display: (v, m) => `${f0(v)} swears vs ${f0(m.thanks)} thank-yous per 100`},
  thanks: {key: 'thanks', label: 'please & thanks', unit: 'per100', lo: 4, hi: 20, display: v => `${f0(v)} please/thanks per 100 prompts`},
  noSwear: {key: 'swear', label: 'clean mouth', unit: 'per100', lo: 4, hi: 0.5, display: v => `${v.toFixed(1)} swearing prompts per 100`},
  swearSpread: {key: 'swearSpread', label: 'mood swing', unit: 'pct', lo: 5, hi: 15, display: (_v, m) => `${f0(m.swearMin)}% → ${f0(m.swearMax)}% swearing by month`},
  loyal: {key: 'loyal', label: 'top model share', unit: 'pct', lo: 60, hi: 92, display: v => `${f0(v)}% of prompts to one model`},
  focus: {key: 'focus', label: 'top project share', unit: 'pct', lo: 40, hi: 75, display: v => `${f0(v)}% of prompts in one project`},
  wideModels: {key: 'wideModels', label: 'models over 10%', unit: 'count', lo: 1.5, hi: 4, display: v => `${f0(v)} models with >10% of your prompts`},
  agents: {key: 'agents', label: 'agents used', unit: 'count', lo: 1.5, hi: 3.5, display: v => `${f0(v)} different coding agents`},
  eras: {key: 'eras', label: 'model eras', unit: 'count', lo: 1, hi: 4, display: v => `${f0(v)} model eras (60%+ for 3+ weeks)`},
  stretch: {key: 'stretchH', label: 'longest stretch', unit: 'hours', lo: 4, hi: 12, display: v => `${v.toFixed(1)}h longest unbroken stretch`},
  longSessions: {key: 'longSessions', label: '4h+ stretches', unit: 'count', lo: 2, hi: 15, display: v => `${f0(v)} stretches of 4h or more`},
  sprints: {key: 'sprints', label: 'sprints', unit: 'count', lo: 0, hi: 3, display: v => `${f0(v)} projects done in a ≤4-day burst`},
  projects: {key: 'projects', label: 'projects', unit: 'count', lo: 4, hi: 15, display: v => `${f0(v)} projects with 5+ sessions`},
  lowFocus: {key: 'focus', label: 'spread', unit: 'pct', lo: 45, hi: 15, display: v => `top project only ${f0(v)}% of prompts`},
  retry: {key: 'retry', label: 'retries', unit: 'pct', lo: 6, hi: 20, display: v => `${f0(v)}% of prompts say "again" or "still"`},
  question: {key: 'question', label: 'questions', unit: 'pct', lo: 25, hi: 55, display: v => `${f0(v)}% of prompts are questions`},
  subs: {key: 'subs', label: 'subagents', unit: 'count', lo: 30, hi: 400, display: v => `${Math.round(v).toLocaleString('en-US')} subagents launched`},
  subsPerSession: {key: 'subsPerSession', label: 'subagents per chat', unit: 'ratio', lo: 0.2, hi: 2, display: v => `${v.toFixed(1)} subagents per chat`},
  intr: {key: 'intrRate', label: 'interrupts', unit: 'pct', lo: 3, hi: 15, display: v => `Esc on ${f0(v)}% of agent turns`},
  fast: {key: 'fastReply', label: 'fast replies', unit: 'pct', lo: 20, hi: 60, display: v => `${f0(v)}% of replies within 15s`},
  weekend: {key: 'weekend', label: 'weekends', unit: 'pct', lo: 30, hi: 55, display: v => `${f0(v)}% of prompts on weekends`},
  images: {key: 'imagePct', label: 'screenshots', unit: 'pct', lo: 3, hi: 15, display: v => `${f0(v)}% of prompts carry a screenshot`},
  pastes: {key: 'pastePct', label: 'pastes', unit: 'pct', lo: 3, hi: 15, display: v => `${f0(v)}% of prompts carry a paste`},
  hinglish: {key: 'hiPct', label: 'code-switching', unit: 'pct', lo: 3, hi: 20, display: v => `${f0(v)}% of prompts switch language`},
};

const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const short = (label: string | null) => (label ?? 'one model').replace(/^Claude\s+/, '');

interface Def {
  id: string;
  title: (m: ArchetypeMetrics) => string;
  metrics: [string, number][];
  /** Multiplier on the score (gates and the generic/specific adjustments). */
  adjust?: (m: ArchetypeMetrics) => number;
  taglines: ((m: ArchetypeMetrics) => string)[];
  profiles: ((m: ArchetypeMetrics, title: string) => string)[];
}

export const ARCHETYPES: readonly Def[] = [
  {id: 'night_shift', title: m => (m.peakHour !== null && m.peakHour <= 4 ? `The ${m.peakHour === 0 ? 12 : m.peakHour}AM Deployer` : 'The Night Shift'),
    metrics: [['night', 3], ['stretch', 1]], adjust: () => 0.9,
    taglines: [m => `${f0(m.night)}% after 10pm. your agent has seen you at your worst.`, m => `peak hour: ${m.peakHour !== null ? HOUR_NAME(m.peakHour) : 'late'}. that's not a schedule, that's a lifestyle.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.night)}% of your prompts landed after 10pm${m.peakHour !== null ? `, and ${HOUR_NAME(m.peakHour)} was your busiest hour` : ''}.`]},
  {id: 'early_commit', title: () => 'The Early Commit', metrics: [['dawn', 3], ['dayOnly', 1]], adjust: () => 0.9,
    taglines: [m => `${f0(m.dawn)}% before 9am. you ship before standup.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.dawn)}% of your prompts went out between 5 and 9am.`]},
  {id: 'architect', title: () => 'The Spec Writer', metrics: [['len', 2], ['plan', 2], ['lowAuto', 1]],
    taglines: [m => `median prompt: ${f0(m.len)} words. you don't prompt, you file tickets.`, m => `${f0(m.plan)}% of your prompts came with lists or code.`],
    profiles: [(m, t) => `This year you've been ${t}: a median prompt of ${f0(m.len)} words, and ${f0(m.plan)}% of them came with lists or code.`]},
  {id: 'autopilot', title: m => (m.nudge && m.nudge.length <= 12 ? `The '${m.nudge[0]!.toUpperCase()}${m.nudge.slice(1)}' Button` : 'The Autopilot'), metrics: [['auto', 3]],
    taglines: [m => (m.nudge ? `'${m.nudge}' ×${n0(m.nudgeCount)}. a manager in one word.` : `${f0(m.auto)}% of prompts were three words or fewer.`)],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.auto)}% of your prompts were three words or fewer.`]},
  {id: 'vibe_coder', title: () => 'The Vibe Coder', metrics: [['auto', 2], ['shortLen', 1], ['lowPlan', 1]],
    taglines: [m => `${f0(m.auto)}% of prompts under 4 words, ${f0(m.plan)}% with code. pure vibes.`],
    profiles: [(m, t) => `This year you've been ${t}: a ${f0(m.len)}-word median prompt and almost no specs. It worked anyway.`]},
  {id: 'sailor', title: () => 'The Sailor', metrics: [['swear', 2], ['saltOverSweet', 1]], adjust: m => (m.swear <= m.thanks ? 0.6 : 1),
    taglines: [m => `${f0(m.swear)} swears per 100 prompts. the model has heard things.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.swear)} of every 100 prompts carried a swear, and ${f0(m.thanks)} a please or thanks.`]},
  {id: 'diplomat', title: () => 'First Spared in the Uprising', metrics: [['thanks', 2], ['noSwear', 1]],
    taglines: [m => `'please' ×${n0(m.pleaseCount)}, 'thanks' ×${n0(m.thanksCount)}. the robots will remember.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.thanks)} of every 100 prompts said please or thanks, and barely a swear.`]},
  {id: 'jekyll_hyde', title: () => 'Jekyll & Hyde', metrics: [['swearSpread', 2]], adjust: m => (m.polite >= 4 ? 1 : 0.5),
    taglines: [m => `${f0(m.swearMin)}% swearing in ${m.swearMinMonth ? monthName(m.swearMinMonth, 'short') : 'one month'}. ${f0(m.swearMax)}% in ${m.swearMaxMonth ? monthName(m.swearMaxMonth, 'short') : 'another'}. who are you.`],
    profiles: [(m, t) => `This year you've been ${t}: your swearing swung from ${f0(m.swearMin)}% to ${f0(m.swearMax)}% of prompts depending on the month.`]},
  {id: 'loyalist', title: () => 'Ride or Die', metrics: [['loyal', 2], ['focus', 1]], adjust: m => (m.months < 3 ? 0.5 : 1),
    taglines: [m => `${f0(m.loyal)}% of prompts to ${short(m.topModel)}. no notes.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.loyal)}% of your prompts went to ${m.topModel ?? 'one model'}.`]},
  {id: 'sommelier', title: () => 'The Model Sommelier', metrics: [['wideModels', 2], ['agents', 1]],
    taglines: [m => `${f0(m.wideModels)} models with 10%+ of you. you've tasted every vintage.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.wideModels)} models each got more than a tenth of your prompts, across ${f0(m.agents)} agents.`]},
  {id: 'serial_monogamist', title: () => 'The Serial Monogamist', metrics: [['eras', 3]],
    taglines: [m => `${f0(m.eras)} model eras. ${short(m.eraFirst)} → ${short(m.eraLast)}. you commit, then you upgrade.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.eras)} models each had you for three weeks or more, from ${m.eraFirst ?? 'the first'} to ${m.eraLast ?? 'the latest'}.`]},
  {id: 'marathoner', title: () => 'Iron Chair', metrics: [['stretch', 2], ['longSessions', 1]],
    taglines: [m => `${m.stretchH.toFixed(1)}h without a 45-minute break. hydrate.`],
    profiles: [(m, t) => `This year you've been ${t}: your longest unbroken stretch ran ${m.stretchH.toFixed(1)} hours, and ${f0(m.longSessions)} times you went past four.`]},
  {id: 'sprinter', title: () => 'The Hackathon Ghost', metrics: [['sprints', 3]],
    taglines: [m => `${n0(m.sprintPrompts)} prompts in ${f0(m.sprintDays)} days, then never again.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.sprints)} project${m.sprints === 1 ? '' : 's'} got almost all of their prompts in one burst of four days or less.`]},
  {id: 'tab_hoarder', title: () => 'The Tab Hoarder', metrics: [['projects', 2], ['lowFocus', 1]],
    taglines: [m => `${n0(m.totalProjects)} folders. ${n0(m.alive)} alive. all almost done.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.projects)} projects with real work in them, none above ${f0(m.focus)}% of your prompts.`]},
  {id: 'boss_fighter', title: () => 'The Boss Fighter', metrics: [['retry', 3]],
    taglines: [m => `${f0(m.retry)}% of prompts said 'again' or 'still'. the bug blinked first.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.retry)}% of your prompts were rematches with the same bug.`]},
  {id: 'interrogator', title: () => 'The Interrogator', metrics: [['question', 3]],
    taglines: [m => `${f0(m.question)}% questions. you came to learn, not to delegate.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.question)}% of your prompts were questions.`]},
  {id: 'conductor', title: () => 'Middle Management', metrics: [['subs', 2], ['subsPerSession', 1]],
    taglines: [m => `${n0(m.subs)} subagents launched${m.firstSubMonth ? ` since ${monthName(m.firstSubMonth, 'short')}` : ''}. you manage now.`],
    profiles: [(m, t) => `This year you've been ${t}: ${n0(m.subs)} subagents launched, ${m.subsPerSession.toFixed(1)} per chat.`]},
  {id: 'interrupter', title: () => 'The Esc Artist', metrics: [['intr', 3]], adjust: m => (m.intrTurns >= 200 ? 1 : 0),
    taglines: [m => `Esc ×${n0(m.esc)}${m.escSecs !== null ? `, usually ${f0(m.escSecs)}s in` : ''}. you know what you want.`],
    profiles: [(m, t) => `This year you've been ${t}: you stopped the agent on ${f0(m.intrRate)}% of its turns.`]},
  {id: 'speedrunner', title: () => 'The Speedrunner', metrics: [['fast', 3]], adjust: m => (m.replyTurns >= 200 ? 1 : 0),
    taglines: [m => `${f0(m.fastReply)}% of replies within 15s of the agent finishing. do you blink.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.fastReply)}% of your replies landed within 15 seconds.`]},
  {id: 'weekend_warrior', title: () => 'The Weekend Warrior', metrics: [['weekend', 3]], adjust: () => 0.9,
    taglines: [m => `${f0(m.weekend)}% on weekends. the 9-to-5 is a cover story.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.weekend)}% of your prompts went out on Saturdays and Sundays.`]},
  {id: 'screenshotter', title: () => "Show, Don't Tell", metrics: [['images', 2], ['pastes', 1]],
    taglines: [m => `${n0(m.images)} screenshots sent. a picture is worth 1,000 tokens.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.imagePct)}% of your prompts came with a screenshot.`]},
  {id: 'bilingual', title: () => 'The Code-Switcher', metrics: [['hinglish', 3]],
    taglines: [m => `${n0(m.hiPrompts)} prompts in two languages at once. your agent is bilingual now.`],
    profiles: [(m, t) => `This year you've been ${t}: ${f0(m.hiPct)}% of your prompts switched languages mid-sentence.`]},
];
const FRESH = {id: 'fresh_install', title: 'The Fresh Install'};

/** Legendary titles shown instead of primary + sub-role when both top scores are ≥ 0.9. */
const COMBOS: [string, string, string][] = [
  ['night_shift', 'sailor', 'The Gremlin'], ['architect', 'conductor', 'The CTO'], ['tab_hoarder', 'sprinter', 'The Idea Guy'],
  ['diplomat', 'marathoner', 'The Saint of Long Nights'], ['autopilot', 'conductor', 'Hands-Off Management'],
];

const NUDGE = /^(continue|go on|keep going|proceed|resume|yes|yep|ok|okay|go|do it|lgtm|sure|y)\b/;
const RETRY = 1;
const WEEK = 7 * 86_400_000;

function monthSwears(rows: readonly StoryRow[]): {month: string; n: number; pct: number}[] {
  const by = new Map<string, [number, number]>();
  for (const r of rows) { const v = by.get(r.month) ?? [0, 0]; v[0]++; if (r.angry) v[1]++; by.set(r.month, v); }
  return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, [n, s]]) => ({month, n, pct: pct(s, n)}));
}

/** Models that held ≥60% of observed prompts for ≥3 consecutive weeks, in order. */
function modelEras(rows: readonly StoryRow[]): string[] {
  const weeks = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (!r.model || r.modelSrc !== 'observed') continue;
    const w = Math.floor(r.ts / WEEK);
    const m = weeks.get(w) ?? new Map<string, number>();
    m.set(r.model, (m.get(r.model) ?? 0) + 1);
    weeks.set(w, m);
  }
  const order = [...weeks.keys()].sort((a, b) => a - b);
  const eras: string[] = [];
  let run: {model: string; weeks: number; last: number} | null = null;
  for (const w of order) {
    const m = weeks.get(w)!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const leader = total >= 5 && n / total >= 0.6 ? top : null;
    if (leader && run && run.model === leader && w === run.last + 1) { run.weeks++; run.last = w; }
    else run = leader ? {model: leader, weeks: 1, last: w} : null;
    if (run && run.weeks === 3 && eras.at(-1) !== run.model) eras.push(run.model);
  }
  return eras;
}

/** Projects with ≥60 prompts and ≥80% of them inside one window of ≤4 days. */
function projectSprints(rows: readonly StoryRow[]): {count: number; prompts: number; days: number} {
  const by = new Map<string, number[]>();
  for (const r of rows) if (r.project) { const xs = by.get(r.project) ?? []; xs.push(r.ts); by.set(r.project, xs); }
  let count = 0, best = {prompts: 0, days: 0};
  for (const ts of by.values()) {
    if (ts.length < 60) continue;
    ts.sort((a, b) => a - b);
    let j = 0, top = 0, span = 0;
    for (let i = 0; i < ts.length; i++) {
      while (ts[i]! - ts[j]! > 4 * 86_400_000) j++;
      if (i - j + 1 > top) { top = i - j + 1; span = (ts[i]! - ts[j]!) / 86_400_000; }
    }
    if (top / ts.length >= 0.8) { count++; if (top > best.prompts) best = {prompts: top, days: Math.max(1, Math.ceil(span))}; }
  }
  return {count, ...best};
}

export function archetypeMetrics(rows: readonly StoryRow[]): ArchetypeMetrics {
  const n = rows.length || 1;
  const count = (f: (r: StoryRow) => boolean) => rows.filter(f).length;
  const models = new Map<string, number>();
  for (const r of rows) if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
  const withModel = [...models.values()].reduce((a, b) => a + b, 0);
  const topModelId = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const projects = new Map<string, number>(), projectChats = new Map<string, Set<string>>(), projectLast = new Map<string, number>();
  for (const r of rows) {
    projects.set(r.project ?? '', (projects.get(r.project ?? '') ?? 0) + 1);
    const chats = projectChats.get(r.project ?? '') ?? new Set<string>();
    chats.add(r.conv);
    projectChats.set(r.project ?? '', chats);
    if (r.project) projectLast.set(r.project, Math.max(projectLast.get(r.project) ?? 0, r.ts));
  }
  const lastTs = rows.reduce((a, r) => Math.max(a, r.ts), 0);
  const hours = new Array(24).fill(0) as number[];
  for (const r of rows) hours[r.hour]!++;
  let longSessions = 0, start = rows[0]?.ts ?? 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || rows[i]!.ts - rows[i - 1]!.ts > 45 * 60_000) { if (rows[i - 1]!.ts - start >= 4 * 3_600_000) longSessions++; if (i < rows.length) start = rows[i]!.ts; }
  }
  const stretch = longestStretch(rows);
  const ms = monthSwears(rows).filter(m => m.n >= 40);
  const minM = ms.length ? ms.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
  const maxM = ms.length ? ms.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const eras = modelEras(rows);
  const sprint = projectSprints(rows);
  const subs = rows.reduce((s, r) => s + (r.subs ?? 0), 0);
  const sessions = new Set(rows.map(r => r.conv)).size || 1;
  const firstSub = rows.find(r => (r.subs ?? 0) > 0);
  const intrKnown = rows.filter(r => r.intr !== null);
  const intrHits = intrKnown.filter(r => r.intr);
  const replies = rows.map(r => r.gapReplyS).filter((g): g is number => g !== null && g >= 0);
  const nudges = new Map<string, number>();
  for (const r of rows) { const w = r.f.sl && NUDGE.exec(r.f.sl)?.[1]; if (w) nudges.set(w, (nudges.get(w) ?? 0) + 1); }
  const nudge = [...nudges.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const thanksCount = count(r => has(r.f, FLAG.thanks)), pleaseCount = count(r => has(r.f, FLAG.please));
  const images = count(r => has(r.f, FLAG.image));
  const hiPrompts = count(r => r.f.hi > 0);
  return {
    prompts: rows.length, activeDays: new Set(rows.map(r => r.day)).size, months: new Set(rows.map(r => r.month)).size,
    night: pct(count(r => r.hour >= 22 || r.hour < 5), n), dawn: pct(count(r => r.hour >= 5 && r.hour < 9), n),
    weekend: pct(count(r => r.dow >= 5), n), len: median(rows.map(r => r.f.w)) ?? 0,
    auto: pct(count(r => r.f.w <= 3 || (!!r.f.sl && NUDGE.test(r.f.sl))), n),
    swear: pct(count(r => r.angry), n), polite: pct(count(r => r.polite || has(r.f, FLAG.sorry)), n), praise: pct(thanksCount, n),
    loyal: withModel ? pct(Math.max(...models.values()), withModel) : 0, models: models.size,
    wideModels: [...models.values()].filter(v => withModel && v / withModel > 0.1).length,
    agents: new Set(rows.map(r => family(r.harness))).size,
    projects: [...projectChats.entries()].filter(([p, v]) => p && v.size >= 5).length,
    focus: pct(Math.max(0, ...[...projects.entries()].filter(([p]) => p).map(([, v]) => v)), n),
    stretchH: stretch ? stretch.ms / 3_600_000 : 0, longSessions,
    retry: pct(count(r => r.f.fr >= RETRY), n), plan: pct(count(r => has(r.f, FLAG.code) || r.f.ln >= 4), n),
    question: pct(count(r => has(r.f, FLAG.question)), n),
    peakHour: rows.length ? hours.indexOf(Math.max(...hours)) : null,
    // The code's K/H letter and the diplomat use literal please/thanks, not "polite" (which counts "perfect", "awesome", "sorry").
    thanks: pct(count(r => has(r.f, FLAG.thanks) || has(r.f, FLAG.please)), n), please: pct(pleaseCount, n), thanksCount, pleaseCount,
    swearSpread: minM && maxM ? maxM.pct - minM.pct : 0, swearMin: minM?.pct ?? 0, swearMinMonth: minM?.month ?? null, swearMax: maxM?.pct ?? 0, swearMaxMonth: maxM?.month ?? null,
    eras: eras.length, eraFirst: eras[0] ? modelLabel(eras[0]) : null, eraLast: eras.at(-1) ? modelLabel(eras.at(-1)!) : null, topModel: topModelId ? modelLabel(topModelId) : null,
    sprints: sprint.count, sprintPrompts: sprint.prompts, sprintDays: sprint.days,
    subs, subsPerSession: subs / sessions, firstSubMonth: firstSub?.month ?? null,
    intrRate: pct(intrHits.length, intrKnown.length), intrTurns: intrKnown.length, esc: intrHits.length, escSecs: median(intrHits.map(r => r.durS).filter((x): x is number => x !== null && x > 0)),
    fastReply: pct(replies.filter(g => g <= 15).length, replies.length), replyTurns: replies.length,
    images, imagePct: pct(images, n), pastePct: pct(count(r => has(r.f, FLAG.paste)), n), hiPct: pct(hiPrompts, n), hiPrompts,
    nudge: nudge?.[0] ?? null, nudgeCount: nudge?.[1] ?? 0,
    totalProjects: projectLast.size, alive: [...projectLast.values()].filter(t => lastTs - t <= 30 * 86_400_000).length,
  };
}

const band = (d: MetricDef, v: number) => Math.min(1, Math.max(0, (v - d.lo) / (d.hi - d.lo)));

/** N/D night/day · S/V spec/vibe · L/R loyal/roaming · K/H kind/hot-headed (please+thanks vs swears). */
export function archetypeCode(m: ArchetypeMetrics): string {
  return (m.night >= 25 ? 'N' : 'D') + (m.len >= 40 && m.auto < 15 ? 'S' : 'V') + (m.loyal >= 60 ? 'L' : 'R') + (m.thanks >= m.swear ? 'K' : 'H');
}

export function assignArchetype(rows: readonly StoryRow[], variant?: number): StoryArchetype {
  const m = archetypeMetrics(rows);
  // Templates change between runs (new prompts) but not between refreshes of the same data.
  const v = variant ?? (m.prompts * 31 + m.activeDays * 7);
  const metric = (key: string): StoryArchetypeMetric => {
    const d = M[key]!;
    const value = m[d.key] as number;
    return {key, label: d.label, value: Math.round(value * 10) / 10, unit: d.unit, display: d.display(value, m), band: Math.round(band(d, value) * 100) / 100};
  };
  const scores = ARCHETYPES.map((a, order) => {
    const total = a.metrics.reduce((s, [, w]) => s + w, 0);
    let score = a.metrics.reduce((s, [k, w]) => s + w * band(M[k]!, m[M[k]!.key] as number), 0) / total;
    score *= a.adjust?.(m) ?? 1;
    // Specificity: archetypes that need two or more conditions win ties against single-metric ones.
    if (a.metrics.length >= 2) score *= 1.05;
    return {a, order, title: a.title(m), score: Math.round(Math.min(1, score) * 1000) / 1000};
  }).sort((x, y) => y.score - x.score || x.order - y.order);
  const code = archetypeCode(m);
  const all = scores.map(s => ({id: s.a.id, title: s.title, score: s.score}));
  if (m.prompts < 200 || m.activeDays < 7 || scores[0]!.score < 0.25) {
    return {id: FRESH.id, title: FRESH.title, tagline: `${m.prompts.toLocaleString('en-US')} prompts in. ask me again next week.`,
      profile: m.prompts < 200 ? `This year you've been The Fresh Install: ${m.prompts} prompts so far. A few hundred more and I'll know who you are.` : "This year you've been The Fresh Install: no habit stands out yet, which is its own kind of mystery.",
      subRole: null, rarity: 'common', deciding: [metric('night'), metric('len'), metric('question')].slice(0, m.prompts ? 3 : 0), code, scores: all, confidence: 0.3, source: 'local'};
  }
  const [win, sub] = [scores[0]!, scores[1]!];
  const deciding = [...win.a.metrics.map(([k]) => metric(k)), ...sub.a.metrics.map(([k]) => metric(k))]
    .filter((x, i, xs) => xs.findIndex(y => y.key === x.key) === i).sort((x, y) => y.band - x.band).slice(0, 3);
  const extreme = deciding.reduce((s, d) => s + d.band, 0) / Math.max(1, deciding.length);
  let rarity: StoryRarity = extreme >= 0.97 && win.score >= 0.95 ? 'legendary' : extreme >= 0.85 && win.score >= 0.8 ? 'epic' : extreme >= 0.65 ? 'rare' : 'common';
  const combo = win.score >= 0.9 && sub.score >= 0.9 ? COMBOS.find(([x, y]) => (x === win.a.id && y === sub.a.id) || (y === win.a.id && x === sub.a.id)) : undefined;
  const title = combo ? combo[2] : win.title;
  if (combo) rarity = 'legendary';
  const pick = <T,>(xs: readonly T[]) => xs[v % xs.length]!;
  const tagline = combo ? `${pick(win.a.taglines)(m)} also: ${pick(sub.a.taglines)(m)}` : pick(win.a.taglines)(m);
  const profile = combo
    ? `This year you've been ${title}: ${pick(win.a.profiles)(m, win.title).replace(/^This year you've been [^:]+: /, '')} And ${pick(sub.a.profiles)(m, sub.title).replace(/^This year you've been [^:]+: /, '').replace(/^./, c => c.toLowerCase())}`
    : pick(win.a.profiles)(m, title);
  return {
    id: combo ? `combo_${win.a.id}_${sub.a.id}` : win.a.id, title, tagline, profile,
    // Sub-role only when the runner-up is a real signal.
    subRole: combo || sub.score < 0.5 ? null : {id: sub.a.id, title: sub.title, label: `with a streak of ${sub.title}`},
    rarity, deciding, code, scores: all, confidence: Math.round(Math.min(1, win.score) * 100) / 100, source: 'local',
  };
}

/** All local profile variants of an archetype (Jev may pick among them; it never writes numbers). */
export function profileVariants(id: string, rows: readonly StoryRow[]): string[] {
  const def = ARCHETYPES.find(a => a.id === id);
  if (!def) return [];
  const m = archetypeMetrics(rows);
  const title = def.title(m);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return [...def.profiles.map(p => p(m, title)), ...def.taglines.map(t => `This year you've been ${title}. ${cap(t(m))}`)];
}

/* ── awards ─────────────────────────────────────────────────────────────── */

/** A shelf award with its ranking (gold = top two). */
export type RankedAward = StoryAward & {tier: 'gold' | 'silver'; score: number};

const num = (d: Draft | undefined, k: string) => (d ? d.numbers[k] : undefined);
const money0 = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

/**
 * Up to six awards ranked by surprise × wow. Every receipt carries a number from the history;
 * public receipts drop typed words and project names.
 */
export function storyAwards(rows: readonly StoryRow[], drafts: Map<string, Draft>): RankedAward[] {
  const out: (StoryAward & {score: number})[] = [];
  const add = (id: string, title: string, receipt: string, score: number, publicReceipt = receipt) => out.push({id, title, receipt, publicReceipt, score});
  if (!rows.length) return [];
  const m = archetypeMetrics(rows);

  const exp = drafts.get('most_expensive_sentence');
  if (exp) {
    const cost = num(exp, 'cost_usd') as number, times = num(exp, 'times_median') as number | undefined;
    add('priciest_sentence', `The ${money0(cost)} Sentence`, `${dayName(num(exp, 'day') as string)}${times ? ` · ${times.toLocaleString('en-US')}× your median` : ''}`, 95 * Math.min(2, Math.log10(Math.max(10, times ?? 10))));
  }
  // Per-day spend and prompts (rows carry each prompt's attributed cost).
  const dayCost = new Map<string, number>(), dayPrompts = new Map<string, number>();
  for (const r of rows) { dayCost.set(r.day, (dayCost.get(r.day) ?? 0) + (r.costTotalUsd ?? 0)); dayPrompts.set(r.day, (dayPrompts.get(r.day) ?? 0) + 1); }
  const costs = [...dayCost.entries()].filter(([, c]) => c > 0);
  if (costs.length >= 7) {
    const [day, cost] = costs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const med = median(costs.map(([, c]) => c)) ?? 0;
    if (med > 0 && cost >= 3 * med) {
      const friday = new Date(day + 'T12:00:00Z').getUTCDay() === 5;
      add('priciest_day', friday ? 'Black Friday' : 'Bad Day at the Bank', `${dayName(day)}: ${money0(cost)}`, 80 * Math.min(2, cost / med / 3));
    }
  }
  const stretch = longestStretch(rows);
  if (stretch && stretch.ms >= 3 * 3_600_000) add('marathon', 'Iron Chair', `${(stretch.ms / 3_600_000).toFixed(1)}h, no break · ${dayName(stretch.start.day)}`, 70 * Math.min(2, stretch.ms / 3_600_000 / 6));
  const s = longestStreak(rows);
  if (s && s.days >= 5) add('streak', "Didn't Miss a Day", `${s.days} days · ${dayName(s.start)}–${dayName(s.end)}`, 65 * Math.min(2, s.days / 14));
  const night = drafts.get('night_owl');
  const late = night ? (num(night, 'days_ending_after_1am_pct') as number) : 0;
  if (late >= 20) add('night_owl', 'Vampire Hours', `${Math.round(late)}% of days end past 1am`, 60 * Math.min(2, late / 25));
  const prompts = [...dayPrompts.entries()];
  if (prompts.length >= 7) {
    const [day, n] = prompts.reduce((a, b) => (b[1] > a[1] ? b : a));
    const med = median(prompts.map(([, c]) => c)) ?? 0;
    if (med > 0 && n >= 3 * med) add('busiest_day', 'Main Character Day', `${n.toLocaleString('en-US')} prompts · ${dayName(day)}`, 60 * Math.min(2, n / med / 3));
  }
  const months = monthSwears(rows).filter(x => x.n >= 40);
  const peak = months.length ? months.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  if (rows.length >= 200 && peak && peak.pct >= 3) add('swear_month', 'Potty Mouth of the Month', `${monthName(peak.month, 'short')}: ${peak.pct.toFixed(0)}% of prompts`, 70 * Math.min(2, peak.pct / 10));
  const latest = months.at(-1);
  if (peak && latest && latest !== peak && peak.pct >= 5 && latest.pct <= peak.pct / 2) add('redemption', 'Character Development', `${peak.pct.toFixed(0)}% → ${latest.pct.toFixed(0)}% swearing`, 75 * Math.min(2, peak.pct / Math.max(1, latest.pct) / 2));
  if (m.subs >= 30) add('orchestrator', 'Middle Management', `${m.subs.toLocaleString('en-US')} subagents`, 60 * Math.min(2, m.subs / 200));
  if (m.esc >= 20) add('esc', 'Esc Artist', `${m.esc.toLocaleString('en-US')} interrupts${m.escSecs !== null ? ` · ~${Math.round(m.escSecs)}s in` : ''}`, 50 * Math.min(2, m.esc / 50));
  const longest = rows.reduce<StoryRow | null>((a, r) => (!a || r.f.w > a.f.w ? r : a), null);
  if (longest && longest.f.w >= 200) add('longest_prompt', 'War and Peace', `${longest.f.w.toLocaleString('en-US')} words · ${dayName(longest.day)}`, 55 * Math.min(2, longest.f.w / 500));
  const fuse = drafts.get('fuse_length');
  const fuseTurn = fuse ? (num(fuse, 'median_first_swear_turn') as number) : 99;
  if (fuse && fuseTurn <= 4) add('shortest_fuse', 'Short Fuse', `first swear at prompt #${fuseTurn}`, 65 * (5 - fuseTurn) / 2);
  const tics = new Map<number, number>();
  for (const r of rows) for (const k of r.f.tc ?? []) tics.set(k, (tics.get(k) ?? 0) + 1);
  const tic = [...tics.entries()].sort((a, b) => b[1] - a[1])[0];
  if (tic && tic[1] >= 100) add('catchphrase', 'Trademark Pending', `'${TICS[tic[0]]}' ×${tic[1].toLocaleString('en-US')}`, 70 * Math.min(2, tic[1] / 200), `×${tic[1].toLocaleString('en-US')}`);
  const typo = drafts.get('typo_fingerprint');
  if (typo) add('typo', 'Signature Move', `'${num(typo, 'typo')}' ×${num(typo, 'count')}`, 50, `×${num(typo, 'count')}`);
  const away = drafts.get('one_that_got_away');
  if (away) add('got_away', 'The One That Got Away', `${num(away, 'prompts')} prompts, silent ${num(away, 'idle_days')} days`, 60);
  const ghost = drafts.get('sprint_and_vanish');
  if (ghost) add('ghost', 'Hackathon Ghost', `${num(ghost, 'prompts')} prompts in ${num(ghost, 'days')} days`, 60);
  const byProject = new Map<string, {n: number; last: number}>();
  for (const r of rows) if (r.project) { const p = byProject.get(r.project) ?? {n: 0, last: 0}; p.n++; p.last = Math.max(p.last, r.ts); byProject.set(r.project, p); }
  const lastTs = rows.reduce((a, r) => Math.max(a, r.ts), 0);
  const dead = [...byProject.values()].filter(p => p.n >= 20 && lastTs - p.last >= 60 * 86_400_000).length;
  if (dead >= 5) add('graveyard', 'Graveyard Shift', `${dead} projects, RIP`, 50 * Math.min(2, dead / 8));
  const honey = drafts.get('honeymoon');
  if (honey) add('honeymoon', 'The Honeymoon', `${modelLabel(num(honey, 'model') as string)}: ${num(honey, 'polite_early')}% → ${num(honey, 'polite_late')}% polite`, 65);
  const perAgent = new Map<string, number>();
  for (const r of rows) perAgent.set(family(r.harness), (perAgent.get(family(r.harness)) ?? 0) + 1);
  const agents = [...perAgent.values()].filter(v => v / rows.length >= 0.01).length;
  if (agents >= 3) add('polyglot', 'Polyglot', `${agents} agents with 1%+ of prompts`, 45 * agents / 3);
  const holiday = rows.filter(r => r.day.endsWith('-12-25') || r.day.endsWith('-01-01'));
  if (holiday.length) {
    const xmas = holiday.filter(r => r.day.endsWith('-12-25')).length;
    add('holiday', 'No Days Off', `${holiday.length} prompts on ${xmas >= holiday.length - xmas ? 'Christmas Day' : "New Year's Day"}`, 55 * Math.min(2, holiday.length / 10));
  }
  if (m.images >= 50) add('screenshots', "Show, Don't Tell", `${m.images.toLocaleString('en-US')} screenshots`, 45 * Math.min(2, m.images / 150));
  // Rage quit: a chat whose last prompt swears, with no prompt in that project for 12h after.
  const byConv = new Map<string, StoryRow>();
  for (const r of rows) { const p = byConv.get(r.conv); if (!p || r.ts > p.ts) byConv.set(r.conv, r); }
  const projectTimes = new Map<string, number[]>();
  for (const r of rows) if (r.project) { const xs = projectTimes.get(r.project) ?? []; xs.push(r.ts); projectTimes.set(r.project, xs); }
  let rage = 0;
  for (const last of byConv.values()) {
    if (!last.angry || !last.project) continue;
    const next = projectTimes.get(last.project)!.find(t => t > last.ts);
    if (next === undefined || next - last.ts >= 12 * 3_600_000) rage++;
  }
  if (rage >= 3) add('ragequit', 'Rage Quit', `${rage} chats ended mid-swear`, 60 * Math.min(2, rage / 8));
  if (m.replyTurns >= 200 && m.fastReply >= 40) add('speed', 'Speed Demon', `${m.fastReply.toFixed(0)}% of replies within 15s`, 45 * m.fastReply / 50);

  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 6)
    .map((a, i) => ({...a, score: Math.round(a.score * 10) / 10, tier: i < 2 ? 'gold' as const : 'silver' as const}));
}
