/**
 * The per-prompt feature table the story detectors run on (one row per human
 * prompt in scope), built from the aggregate without any prompt text.
 *
 *  - Claude transcript prompts take their features from the matching typed
 *    entry of ~/.claude/history.jsonl (same session, |Δt| < 5 s): transcripts
 *    expand pastes inline, history keeps what was typed.
 *  - Turn cost = priced, de-duplicated responses between this prompt and the
 *    next one of the conversation, plus subagent spend in the same window.
 *  - History-only prompts have no responses and no model: models are observed
 *    only (never imputed from other days); they count as unknown-model prompts.
 *  - Word counters are dated, so a scoped story only sees words from its days.
 */
import {sourceId} from '../memory/source-identity.js';
import type {Aggregate} from './aggregate.js';
import type {HistoryEntry, PromptFact, SourceFacts, UsageFact} from './extract.js';
import {FLAG, has, type PromptFeatures} from './story-lexicon.js';
import type {StoryHarness} from './story-contracts.js';
import {localClock} from './story-time.js';
import {canonicalModel} from './model-names.js';

export interface StoryRow {
  id: string;
  /** Conversation (top-level session) id. */
  conv: string;
  harness: StoryHarness;
  /** Epoch ms. */
  ts: number;
  project: string | null;
  /** Canonical model that answered (observed on the responses of this turn), else null. */
  model: string | null;
  modelSrc: 'observed' | 'none';
  /** 1-based index of the prompt in its conversation. */
  turn: number;
  gapReplyS: number | null;
  gapPromptS: number | null;
  intr: boolean | null;
  prevIntr: boolean | null;
  costUsd: number | null;
  costTotalUsd: number | null;
  outTokens: number | null;
  durS: number | null;
  tools: number | null;
  subs: number | null;
  day: string;
  month: string;
  hour: number;
  minute: number;
  dow: number;
  f: PromptFeatures;
  /** Safe quote candidate (fixed slots only). */
  q: string | null;
  typed: boolean;
  angry: boolean;
  polite: boolean;
}

export interface StoryTable {
  rows: StoryRow[];
  /** Word counters for typos and day/night topics (from history.jsonl, Codex, pi, OpenCode). */
  vocab: Map<string, number>;
  topics: Map<string, {night: number; day: number; words: Map<string, [number, number]>}>;
  sessions: {conv: string; harness: StoryHarness; project: string | null; costUsd: number; subCostUsd: number; first: number; last: number; prompts: number}[];
  /** Headline counts over every human prompt in scope, dated or not (rows hold dated prompts only). */
  headline: {prompts: number; sessions: number; undated: number};
}

interface Spend {at: number; cost: number; out: number; model: string | null}

const memo = new Map<string, string>();
const sid = (h: string, id: string) => { const k = `${h}\0${id}`; let v = memo.get(k); if (!v) { v = sourceId(h, id); memo.set(k, v); } return v; };

export interface StoryTableInput {
  aggregate: Aggregate;
  history: readonly HistoryEntry[];
  historyCounters: ReadonlyMap<string, {project: string | null; vocab: Map<string, Map<string, number>>; topics: Map<string, {night: number; day: number; words: Map<string, [number, number]>}>}>;
  historyFile: string | null;
  timezone: string;
  /** Projects the user ignores and sessions forgotten (counters are filtered by them). */
  allowed: (project: string | null, session: string | null) => boolean;
  /** Local dates in the audit's date scope (word counters); default all. */
  dateAllowed?: (date: string) => boolean;
  /** Undated words count only in an unscoped story (default true). */
  undatedAllowed?: boolean;
}

export function buildStoryTable(input: StoryTableInput): StoryTable {
  const {aggregate: a, timezone} = input;
  const clock = localClock(timezone);
  const {refs, costOf} = a.story;
  const dateAllowed = input.dateAllowed ?? (() => true);

  // ---- typed text of live Claude sessions, by session id
  const typed = new Map<string, HistoryEntry[]>();
  for (const h of input.history) if (h.kind === 'human' && h.f && h.sessionId && h.at !== null) {
    const list = typed.get(h.sessionId) ?? [];
    list.push(h);
    typed.set(h.sessionId, list);
  }

  // ---- spend per conversation: main thread and subagents (kept, deduplicated responses only)
  const main = new Map<string, Spend[]>(), sub = new Map<string, Spend[]>();
  // Only conversations with a human prompt get turn windows (automated runs never do).
  const promptConvs = new Set<string>();
  for (const ref of refs) promptConvs.add(ref.prompt.conversationId);
  const convOf = new Map<SourceFacts, string | null>();
  for (const {u, s} of a.story.rows) {
    if (u.at === null) continue;
    let conv = convOf.get(s);
    if (conv === undefined) { const c = sid(s.harness, s.child && s.parentId ? s.parentId : s.sessionId); conv = promptConvs.has(c) ? c : null; convOf.set(s, conv); }
    if (conv === null) continue;
    const target = s.child ? sub : main;
    let list = target.get(conv);
    {
      if (!list) { list = []; target.set(conv, list); }
      // Unpriced responses still tell which model answered; their cost is unknown, not $0.
      list.push({at: u.at, cost: costOf.get(u) ?? 0, out: u.output, model: u.model && !u.inferredModel ? canonicalModel(u.model) : null});
    }
  }
  for (const list of [...main.values(), ...sub.values()]) list.sort((x, y) => x.at - y.at);

  // ---- rows
  const byConv = new Map<string, {row: StoryRow; fact: PromptFact | HistoryEntry}[]>();
  const rows: StoryRow[] = [];
  const allConvs = new Set<string>();
  let undated = 0;
  for (const ref of refs) {
    const fact = ref.fact;
    allConvs.add(ref.prompt.conversationId);
    if (fact.at === null) undated++;
    if (!fact.f || fact.at === null) continue;
    const s = ref.source;
    let f = fact.f, q = 'q' in fact ? fact.q ?? null : null, isTyped = ref.history;
    if (s && s.harness === 'claude' && !s.child) {
      const match = matchTyped(typed, s, fact.at);
      if (match) { f = match.f!; q = match.q ?? null; isTyped = true; }
    }
    const harness: StoryHarness = ref.history ? 'claude_hist' : (s?.harness ?? 'claude');
    const local = clock(fact.at);
    const t = 'key' in fact ? fact.t : undefined;
    const row: StoryRow = {
      id: ref.prompt.id, conv: ref.prompt.conversationId, harness, ts: fact.at, project: ref.prompt.project ?? null,
      model: null, modelSrc: 'none', turn: 0, gapReplyS: t?.g ?? null, gapPromptS: null,
      intr: t ? t.x === 1 : null, prevIntr: null,
      costUsd: null, costTotalUsd: null, outTokens: null, durS: t?.d ?? null, tools: t ? t.tl : null, subs: t ? t.sa : null,
      day: local.day, month: local.month, hour: local.hour, minute: local.minute, dow: local.dow,
      f, q, typed: isTyped, angry: f.sw > 0 || f.ins > 0, polite: has(f, FLAG.polite),
    };
    rows.push(row);
    const list = byConv.get(row.conv) ?? [];
    list.push({row, fact});
    byConv.set(row.conv, list);
  }

  // ---- turns, windows, sessions
  const sessions: StoryTable['sessions'] = [];
  for (const [conv, list] of byConv) {
    list.sort((x, y) => x.row.ts - y.row.ts);
    const spend = main.get(conv) ?? [], subs = sub.get(conv) ?? [];
    let j = 0, k = 0, cost = 0, subCost = 0;
    list.forEach(({row}, i) => {
      row.turn = i + 1;
      if (i) { row.gapPromptS = Math.round((row.ts - list[i - 1]!.row.ts) / 100) / 10; row.prevIntr = list[i - 1]!.row.intr; } else row.prevIntr = row.intr === null ? null : false;
      if (row.harness === 'claude_hist') return;
      const next = i + 1 < list.length ? list[i + 1]!.row.ts : Infinity;
      while (j < spend.length && spend[j]!.at < row.ts) j++;
      let c = 0, out = 0;
      const models = new Map<string, number>();
      while (j < spend.length && spend[j]!.at < next) { const e = spend[j++]!; c += e.cost; out += e.out; if (e.model) models.set(e.model, (models.get(e.model) ?? 0) + 1); }
      while (k < subs.length && subs[k]!.at < row.ts) k++;
      let sc = 0;
      while (k < subs.length && subs[k]!.at < next) sc += subs[k++]!.cost;
      row.costUsd = c; row.costTotalUsd = c + sc; row.outTokens = out;
      cost += c; subCost += sc;
      let best: string | null = null, bestN = 0;
      for (const [m, n] of models) if (n > bestN) { best = m; bestN = n; }
      // Only observed answering models; a turn with no recorded model stays unknown.
      if (best) { row.model = best; row.modelSrc = 'observed'; }
    });
    const first = list[0]!.row;
    sessions.push({conv, harness: first.harness, project: first.project, costUsd: cost, subCostUsd: subCost, first: first.ts, last: list.at(-1)!.row.ts, prompts: list.length});
  }
  rows.sort((x, y) => x.ts - y.ts || x.id.localeCompare(y.id));

  // ---- word counters (Claude transcripts excluded: their typed text is in history.jsonl)
  const vocab = new Map<string, number>();
  const topics: StoryTable['topics'] = new Map();
  const addTopics = (month: string, bag: {night: number; day: number; words: Map<string, [number, number]>}) => {
    let t = topics.get(month);
    if (!t) { t = {night: 0, day: 0, words: new Map()}; topics.set(month, t); }
    t.night += bag.night; t.day += bag.day;
    for (const [w, [n, d]] of bag.words) { const c = t.words.get(w); if (c) { c[0] += n; c[1] += d; } else t.words.set(w, [n, d]); }
  };
  const inScope = new Set(rows.map(r => r.conv));
  const addVocab = (bags: Map<string, Map<string, number>>) => {
    for (const [date, words] of bags) {
      if (date ? !dateAllowed(date) : input.undatedAllowed === false) continue;
      for (const [w, n] of words) vocab.set(w, (vocab.get(w) ?? 0) + n);
    }
  };
  // Transcript prompts (Codex, pi, OpenCode, adapters): from the deduplicated, in-scope prompts, so every
  // copy of a session counts once and a divergent tail of a non-primary copy still counts.
  for (const ref of refs) {
    const fact = ref.fact;
    if (ref.history || !ref.source || ref.source.harness === 'claude' || ref.source.child || !('key' in fact)) continue;
    if (fact.at === null) {
      if (input.undatedAllowed === false) continue;
      for (const w of fact.w ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
      continue;
    }
    const local = clock(fact.at);
    if (!dateAllowed(local.day)) continue;
    for (const w of fact.w ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
    const slot = local.hour < 5 ? 0 : local.hour >= 9 && local.hour < 19 ? 1 : -1;
    if (slot >= 0) {
      const words = new Map<string, [number, number]>();
      for (const w of fact.tw ?? []) words.set(w, slot === 0 ? [1, 0] : [0, 1]);
      addTopics(local.month, {night: slot === 0 ? 1 : 0, day: slot === 1 ? 1 : 0, words});
    }
  }
  for (const [session, c] of input.historyCounters) {
    if (!input.allowed(c.project, session || null) || !inScope.has(sid('claude', session))) continue;
    addVocab(c.vocab);
    for (const [date, bag] of c.topics) if (dateAllowed(date)) addTopics(date.slice(0, 7), bag);
  }
  return {rows, vocab, topics, sessions, headline: {prompts: refs.length, sessions: allConvs.size, undated}};
}

function matchTyped(typed: Map<string, HistoryEntry[]>, s: SourceFacts, at: number): HistoryEntry | null {
  for (const session of s.sessionIds ?? [s.sessionId]) {
    for (const h of typed.get(session) ?? []) if (Math.abs(h.at! - at) < 5000) return h;
  }
  return null;
}

export type {UsageFact};
