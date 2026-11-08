/**
 * The poster's "fun facts": a small ranked picker over the snapshot.
 *
 * Every candidate has
 *   - a guard: it returns null when the number it quotes is missing, zero or too ordinary;
 *   - a surprise score (0..100): how unusual this is for a person, so different users get
 *     different posters;
 *   - a fixed catalogue position, the deterministic tie-break (then the id).
 *
 * Every line quotes a real number or word straight from the snapshot. All facts are
 * public-safe (model names, counts, hours, money); the only user words allowed are the
 * catchphrase and the pet name, which the poster and the share card both show.
 */
import { count, harnessName, hourLabel, money, monthYear } from '../format.js';
import { sanitize } from '../text.js';
import { cardOf, num } from './source.js';
import type { AuditStory } from './types.js';
import { spendOf } from './v19.js';

/** One styled run of a fact line. */
export interface FactPart { text: string; tone?: 'num' | 'name' | 'quote' }

export interface FunFact {
  id: string;
  /** Families cap how many facts of one kind a poster shows (variety). */
  family: 'model' | 'voice' | 'time' | 'money' | 'mood' | 'work';
  /** Small kicker above or beside the line: "NEMESIS". */
  label: string;
  /** The line, as styled runs. */
  parts: FactPart[];
  /** A shorter wording for narrow screens (still complete, never cut). */
  short?: FactPart[];
  /** 0..100. */
  score: number;
  /** Awards this fact repeats (that trophy is dropped when the fact is shown). */
  awards: string[];
}

export const factText = (parts: readonly FactPart[]) => parts.map(p => p.text).join('');

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const log2 = Math.log2;
const N = (text: string): FactPart => ({ text, tone: 'num' });
const M = (text: string): FactPart => ({ text, tone: 'name' });
const Q = (text: string): FactPart => ({ text: `“${text}”`, tone: 'quote' });
const T = (text: string): FactPart => ({ text });
/** 1.95 → "2×", 2.4 → "2.4×". */
const times = (ratio: number) => `${ratio >= 9.95 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, '')}×`;
const shortModel = (label: string) => sanitize(label).replace(/^(Claude|Gemini)\s+/, '');
/** Short user words only (catchphrase / pet name): ≤ 24 chars, no URLs or paths. */
const safeWord = (text: string | null | undefined, mask: (s: string) => string): string | null => {
  if (!text) return null;
  const clean = mask(text).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 24 || /[/\\@:]|https?/i.test(clean)) return null;
  return clean;
};

type Candidate = (story: AuditStory, mask: (s: string) => string) => Omit<FunFact, 'id'> | null;

/**
 * The catalogue, in tie-break order. Guards and scores are listed in each entry.
 * Exported for tests and for the method notes.
 */
export const CATALOGUE: readonly { id: string; guard: string; score: string; make: Candidate }[] = [
  {
    id: 'manners', guard: 'f-bombs (or swears) > 0, thanks > 0, ratio ≥ 1.5 either way',
    score: '50 + 20·|log2 ratio|',
    make: story => {
      const card = cardOf(story, 'thanks_vs_swears');
      const thanks = num(card, 'thanks') ?? 0, fb = num(card, 'fbombs'), sw = num(card, 'swears');
      const rude = fb ?? sw ?? 0;
      if (!(thanks > 0) || !(rude > 0)) return null;
      const ratio = rude / thanks;
      if (ratio < 1.5 && ratio > 1 / 1.5) return null;
      const word = fb !== null ? 'f-bomb' : 'swear';
      const score = clamp(50 + 20 * Math.abs(log2(ratio)));
      if (ratio >= 1) {
        const n = ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1).replace(/\.0$/, '');
        return { family: 'voice', label: 'MANNERS', parts: [N(n), T(` ${word}s per thank-you`)], short: [N(n), T(` ${word}s per thanks`)], score, awards: [] };
      }
      const inv = 1 / ratio;
      const n = inv >= 10 ? String(Math.round(inv)) : inv.toFixed(1).replace(/\.0$/, '');
      return { family: 'voice', label: 'MANNERS', parts: [N(n), T(` thank-yous per ${word}`)], short: [N(n), T(` thanks per ${word}`)], score, awards: [] };
    },
  },
  {
    id: 'nemesis', guard: 'models.worst with swearRatio ≥ 1.3 over ≥ 2 matched months',
    score: '45 + 35·log2(swearRatio)',
    make: story => {
      const w = story.models.worst;
      if (!w || !(w.swearRatio !== null && w.swearRatio >= 1.3) || w.matchedMonths < 2 || !w.label) return null;
      return {
        family: 'model', label: 'NEMESIS', score: clamp(45 + 35 * log2(w.swearRatio)), awards: [],
        parts: [M(sanitize(w.label)), T(' gets '), N(times(w.swearRatio)), T(' your swearing')],
        short: [M(shortModel(w.label)), T(', '), N(times(w.swearRatio)), T(' the swears')],
      };
    },
  },
  {
    id: 'soft_spot', guard: 'models.best with praiseRatio ≥ 1.3 over ≥ 2 matched months, not the nemesis',
    score: '40 + 30·log2(praiseRatio)',
    make: story => {
      const b = story.models.best;
      if (!b || !(b.praiseRatio !== null && b.praiseRatio >= 1.3) || b.matchedMonths < 2 || !b.label) return null;
      if (story.models.worst && story.models.worst.label === b.label) return null;
      return {
        family: 'model', label: 'SOFT SPOT', score: clamp(40 + 30 * log2(b.praiseRatio)), awards: [],
        parts: [M(sanitize(b.label)), T(' gets '), N(times(b.praiseRatio)), T(' your thank-yous')],
        short: [M(shortModel(b.label)), T(', '), N(times(b.praiseRatio)), T(' the thanks')],
      };
    },
  },
  {
    id: 'pet_name', guard: 'pet name said ≥ 5 times, short and safe',
    score: '50 + 10·log2(count / 5), max 90',
    make: (story, mask) => {
      const p = story.highlights.petName;
      const term = safeWord(p?.term, mask);
      if (!p || !term || p.count < 5) return null;
      return {
        family: 'voice', label: 'PET NAME', score: clamp(50 + 10 * log2(p.count / 5), 0, 90), awards: ['pet_names'],
        parts: [T('you call it '), Q(term), T(' '), N(`×${count(p.count)}`)],
      };
    },
  },
  {
    id: 'catchphrase', guard: 'catchphrase said ≥ 10 times, short and safe',
    score: '30 + 15·log2(1 + uses per 100 prompts)',
    make: (story, mask) => {
      const c = story.highlights.catchphrase;
      const phrase = safeWord(c?.phrase, mask);
      if (!c || !phrase || c.count < 10 || !(story.totals.prompts > 0)) return null;
      const rate = (c.count / story.totals.prompts) * 100;
      return {
        family: 'voice', label: 'CATCHPHRASE', score: clamp(30 + 15 * log2(1 + rate)), awards: ['verbal_tics'],
        parts: [Q(phrase), T(' '), N(`×${count(c.count)}`)],
      };
    },
  },
  {
    id: 'mood_drift', guard: 'mood_drift fired, late% > early% > 0, factor ≥ 3',
    score: '40 + 15·log2(factor)',
    make: story => {
      const card = cardOf(story, 'mood_drift');
      const early = num(card, 'earlyPct'), late = num(card, 'latePct');
      if (early === null || late === null || !(early > 0) || !(late > early)) return null;
      const factor = late / early;
      if (factor < 3) return null;
      const pct = (v: number) => `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}%`;
      return {
        family: 'mood', label: 'CHARACTER ARC', score: clamp(40 + 15 * log2(factor)), awards: ['mood_drift'],
        parts: [T('swearing went '), N(pct(early)), T(' → '), N(pct(late))],
      };
    },
  },
  {
    id: 'mood_hours', guard: 'night_owl angriest and calmest hours known and different, angriest ≥ 5% swearing',
    score: '40 + 2·angriest%, max 85',
    make: story => {
      const owl = cardOf(story, 'night_owl');
      const angry = num(owl, 'angriestHour'), calm = num(owl, 'calmestHour'), pct = num(owl, 'angriestPct');
      if (angry === null || calm === null || angry === calm || pct === null || pct < 5) return null;
      return {
        family: 'time', label: 'MOOD CLOCK', score: clamp(40 + 2 * pct, 0, 85), awards: [],
        parts: [T('angriest at '), N(hourLabel(angry)), T(', a saint at '), N(hourLabel(calm))],
        short: [T('angry '), N(hourLabel(angry)), T(' · saint '), N(hourLabel(calm))],
      };
    },
  },
  {
    id: 'late_nights', guard: '≥ 15% of active days end past 1am',
    score: '20 + 1.5·pct',
    make: story => {
      const pct = story.rhythm.lateNightDaysPct;
      if (pct === null || pct < 15) return null;
      return {
        family: 'time', label: 'NIGHT OWL', score: clamp(20 + 1.5 * pct), awards: [],
        parts: [N(`${Math.round(pct)}%`), T(' of your days end past 1am')],
        short: [N(`${Math.round(pct)}%`), T(' of days end past 1am')],
      };
    },
  },
  {
    id: 'priciest_sentence', guard: 'most expensive prompt ≥ $5 and ≥ 10× the median prompt',
    score: '30 + 20·log10(timesMedian)',
    make: story => {
      const p = story.highlights.mostExpensivePrompt;
      if (!p || !(p.costUsd >= 5) || !(p.timesMedian >= 10)) return null;
      return {
        family: 'money', label: 'PRICIEST SENTENCE', score: clamp(30 + 20 * Math.log10(p.timesMedian)), awards: ['most_expensive_sentence'],
        parts: [N(money(p.costUsd)), T(', '), N(`${count(Math.round(p.timesMedian))}×`), T(' your median prompt')],
        short: [N(money(p.costUsd)), T(', '), N(`${count(Math.round(p.timesMedian))}×`), T(' the median')],
      };
    },
  },
  {
    id: 'longest_sit', guard: 'longest unbroken stretch ≥ 4h',
    score: '20 + 8·hours, max 90',
    make: story => {
      const h = story.totals.longestStretchHours;
      if (!(h >= 4)) return null;
      return {
        family: 'time', label: 'LONGEST SIT', score: clamp(20 + 8 * h, 0, 90), awards: ['marathon'],
        parts: [N(`${h.toFixed(1).replace(/\.0$/, '')}h`), T(' without a real break')],
        short: [N(`${h.toFixed(1).replace(/\.0$/, '')}h`), T(' straight')],
      };
    },
  },
  {
    id: 'fuse', guard: 'snaps in ≥ 10 sessions, median first swear at prompt ≤ 15',
    score: '62 − 3·medianTurn',
    make: story => {
      const f = story.highlights.fuse;
      if (!f || f.sessions < 10 || !(f.medianTurn >= 1) || f.medianTurn > 15) return null;
      return {
        family: 'mood', label: 'FUSE', score: clamp(62 - 3 * f.medianTurn), awards: ['fuse_length'],
        parts: [T('you snap at prompt '), N(`#${f.medianTurn}`)],
      };
    },
  },
  {
    id: 'agent_split', guard: 'a lasting agent switch, or a second agent with ≥ 15% of prompts',
    score: 'switch: 55 · split: 30 + 40·(minor share / 50%)',
    make: story => {
      const d = story.models.defection;
      if (d && d.from && d.to && d.from !== d.to && d.weekStart) {
        return {
          family: 'work', label: 'THE SWITCH', score: 55, awards: [],
          parts: [T('left '), M(sanitize(d.from)), T(' for '), M(sanitize(d.to)), T(' in '), N(monthYear(d.weekStart))],
        };
      }
      const spend = spendOf(story);
      const merged = new Map<string, number>();
      for (const r of spend?.byHarness ?? []) if (r.prompts > 0) { const k = r.harness === 'claude_hist' ? 'claude' : r.harness; merged.set(k, (merged.get(k) ?? 0) + r.prompts); }
      const rows = [...merged].map(([harness, prompts]) => ({ harness, prompts })).sort((a, b) => b.prompts - a.prompts);
      const total = rows.reduce((s, r) => s + r.prompts, 0);
      if (rows.length < 2 || !(total > 0)) return null;
      const a = rows[0]!, b = rows[1]!;
      const minor = (b.prompts / total) * 100;
      if (minor < 15) return null;
      const name = harnessName;
      return {
        family: 'work', label: 'AGENTS', score: clamp(30 + 40 * Math.min(1, minor / 50)), awards: [],
        parts: [M(name(a.harness)), T(' '), N(`${Math.round((a.prompts / total) * 100)}%`), T(' · '), M(name(b.harness)), T(' '), N(`${Math.round(minor)}%`)],
      };
    },
  },
  {
    id: 'subagents', guard: '≥ 50 subagents launched',
    score: '30 + 10·log2(n / 50)',
    make: story => {
      const n = story.totals.subagents;
      if (!(n >= 50)) return null;
      return { family: 'work', label: 'MIDDLE MANAGER', score: clamp(30 + 10 * log2(n / 50)), awards: ['orchestrator'], parts: [N(count(n)), T(' subagents launched')] };
    },
  },
  {
    id: 'streak', guard: 'longest streak ≥ 14 days',
    score: '25 + days, max 70',
    make: story => {
      const d = story.totals.longestStreakDays;
      if (!(d >= 14)) return null;
      return { family: 'time', label: 'STREAK', score: clamp(25 + d, 0, 70), awards: ['streak'], parts: [N(count(d)), T(' days in a row')] };
    },
  },
];

/** Every fact that passes its guard, best first (score, then catalogue order). */
export function rankFunFacts(story: AuditStory | null, mask: (s: string) => string = sanitize): FunFact[] {
  if (!story) return [];
  const out: (FunFact & { order: number })[] = [];
  CATALOGUE.forEach((entry, order) => {
    let fact: Omit<FunFact, 'id'> | null = null;
    try { fact = entry.make(story, mask); } catch { fact = null; }
    if (fact && Number.isFinite(fact.score) && fact.score > 0) out.push({ ...fact, id: entry.id, score: Math.round(fact.score * 10) / 10, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order || a.id.localeCompare(b.id));
  return out.map(({ order: _order, ...fact }) => fact);
}

/** The poster's picks: the top facts with at most `perFamily` of one family. */
export function pickFunFacts(story: AuditStory | null, limit = 6, mask?: (s: string) => string, perFamily = 2): FunFact[] {
  const picked: FunFact[] = [];
  const families = new Map<string, number>();
  for (const fact of rankFunFacts(story, mask)) {
    if (picked.length >= limit) break;
    const n = families.get(fact.family) ?? 0;
    if (n >= perFamily) continue;
    families.set(fact.family, n + 1);
    picked.push(fact);
  }
  return picked;
}

