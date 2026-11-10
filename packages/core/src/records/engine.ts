/**
 * search / read / threads / grep over the records' index (R5 §11.2 semantics and output shapes).
 *
 * Ranking is the R5 M4 surface without its dense lane (R5 found it added nothing measurable): BM25 over
 * turns with a deterministic contextual prefix, fused by reciprocal rank (k = 60) with a session-card lane
 * (title + project + every user ask). Every reply ends with ready-to-copy follow-up calls, in the caller's
 * syntax: MCP tool calls, or `slopie` commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import {openDatabase, type Db} from '../sqlite-driver.js';
import {readSession, type Harness} from '../sources/sessions.js';
import * as paths from '../paths.js';
import {stateDir} from './sync.js';
import {INDEX_FILE} from './index-db.js';
import {relation} from './format.js';
import {scrub} from './scrub.js';

export type CallStyle = 'mcp' | 'cli';

const STOP = new Set(`a an the and or but if then else of to in on at by for with from into about as is are was were be been being
do does did done have has had having i me my we our you your he she it its they them their this that these those there here
what which who whom whose when where why how all any both each few more most other some such no nor not only own same so than
too very can will just should now could would may might must shall find chat session thread conversation where did we us
let lets get got make made please tell show give went one ones also out up down over again further once`.split(/\s+/));
const WORD = /[A-Za-z0-9][A-Za-z0-9_./:@+-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

export function ftsQuery(q: string, mode: 'or' | 'and' = 'or'): string | null {
  const toks: string[] = [];
  for (const w of q.match(WORD) ?? []) {
    const lw = w.toLowerCase();
    if (STOP.has(lw) || (lw.length < 2 && !/^\d$/.test(lw))) continue;
    const tok = `"${w.replace(/"/g, '')}"`;
    if (!toks.includes(tok)) toks.push(tok);
  }
  return toks.length ? toks.join(mode === 'or' ? ' OR ' : ' AND ') : null;
}

const terms = (q: string) => (q.match(WORD) ?? []).filter(w => !STOP.has(w.toLowerCase()));
const shortTs = (ts: string | null) => (ts ?? '?').replace('T', ' ').slice(0, 16);
const ws = (s: string) => s.replace(/\s+/g, ' ');
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
/** A crude stem for "does this passage hold the word" (the index itself stems with porter). */
const stem = (t: string) => (t.length > 5 ? t.replace(/(ings?|ed|es|s)$/, '') : t);
const ttl = (s: {title: string | null}) => ws((s.title ?? '').trim()).slice(0, 70);
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
/** Scope predicates over `turns t` for the candidate SQL: session keys, turn time window. */
function scopeSql(keys: Set<string> | null, since?: string, until?: string): {where: string; args: unknown[]} {
  const where: string[] = [], args: unknown[] = [];
  if (keys) { where.push('t.skey in (select value from json_each(?))'); args.push(JSON.stringify([...keys])); }
  if (since) { where.push(`coalesce(t.ts, '') >= ?`); args.push(since); }
  if (until) { where.push(`coalesce(t.ts, '') <= ?`); args.push(until); }
  return {where: where.join(' and '), args};
}

/** One structured hit (`--json`, MCP structuredContent). */
export interface Hit {
  session: string; harness: string; project: string | null; parent: string | null; root: string | null;
  role: string; turn: number; at: string | null; snippet: string; read_cmd: string;
}
export interface FindResult {
  mode: 'search' | 'latest' | 'read' | 'inside' | 'list' | 'error';
  indexed_at: string | null;
  partial: boolean;
  hits: Hit[];
  next: string[];
  text: string;
}

interface S {
  key: string; harness: string; id: string; project: string | null; title: string | null; start: string | null; end: string | null;
  n_turns: number; parent: string | null; parent_kind: string | null; children: string; archive_only: number; sources: string; best: string | null;
  rel: string; first_user: string | null; last_assistant: string | null;
}
type Row = {rid: number; skey: string; n: number; role: string; ts: string | null; tool: string | null; body: string};

export class NoIndexError extends Error {
  constructor(readonly file: string) { super(`no search index at ${file}. Run: slopie sync`); }
}

function snippet(body: string, ts: readonly string[], width = 360): string {
  const low = body.toLowerCase();
  let pos = -1;
  for (const t of [...ts].sort((a, b) => b.length - a.length)) { pos = low.indexOf(t.toLowerCase()); if (pos >= 0) break; }
  if (pos < 0 || body.length <= width) return ws(body.slice(0, width)) + (body.length > width ? '…' : '');
  const a = Math.max(0, pos - Math.floor(width / 3));
  const b = Math.min(body.length, a + width);
  return (a ? '…' : '') + ws(body.slice(a, b)) + (b < body.length ? '…' : '');
}

const q = (s: string) => JSON.stringify(s);
const shq = (s: string) => (/^[A-Za-z0-9_./:@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export class Engine {
  readonly db: Db;
  readonly sessions = new Map<string, S>();
  private mainById: Map<string, S> | null = null;
  private laterByKey: Map<string, string> | null = null;
  readonly recordsDir: string;
  /** Print "subagent of <parent>" on every hit (on by default; SLOPIE_HIT_PARENT=0 turns it off, for ablation only). */
  hitParent = process.env['SLOPIE_HIT_PARENT'] !== '0';
  /** When the index was last built (meta 'built'), for the age line every reply starts with. */
  readonly indexedAt: string | null;
  /** Lines the caller adds under the age line (e.g. "refresh did not finish in 1.5 s"). */
  notes: string[] = [];
  /** The structured form of the last find() (`--json`, MCP structuredContent). */
  result: Omit<FindResult, 'text' | 'indexed_at'> = {mode: 'search', partial: false, hits: [], next: []};

  constructor(recordsDir?: string, readonly style: CallStyle = 'cli') {
    this.recordsDir = paths.recordsDir(recordsDir);
    const file = path.join(stateDir(this.recordsDir), INDEX_FILE);
    if (!fs.existsSync(file)) throw new NoIndexError(file);
    this.db = openDatabase(file, {readonly: true, fileMustExist: true});
    for (const r of this.db.prepare('select * from sessions').all() as S[]) this.sessions.set(r.key, r);
    let built: string | null = null;
    try { built = (this.db.prepare(`select v from meta where k='built'`).get() as {v: string} | undefined)?.v ?? null; } catch { /* old index */ }
    this.indexedAt = built;
  }

  close(): void { this.db.close(); }

  // ------------------------------------------------------------ call syntax (one tool: search)
  private call(a: {query?: string; session?: string; turns?: string; project?: string; since?: string; latest?: boolean; parent?: string}): string {
    if (this.style === 'mcp') {
      const parts = Object.entries(a).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => `${k}=${v === true ? 'true' : q(String(v))}`);
      return `search(${parts.join(', ')})`;
    }
    const parts = ['slopie search'];
    if (a.query !== undefined) parts.push(a.query === '...' ? '<text>' : shq(a.query));
    if (a.session !== undefined) parts.push('--session', a.session);
    if (a.turns !== undefined) parts.push('--turns', a.turns);
    if (a.project !== undefined) parts.push('--project', shq(a.project));
    if (a.since !== undefined) parts.push('--since', a.since);
    if (a.latest) parts.push('--latest');
    if (a.parent !== undefined) parts.push('--parent', a.parent);
    return parts.join(' ');
  }
  private readCall(id: string, from: number, to?: number, fromChar?: number): string {
    return this.call({session: id, turns: fromChar ? `${from}@${fromChar}` : to !== undefined ? `${from}-${to}` : `${from}`});
  }
  private grepCall(id: string, pattern: string | null, offset?: number, regex = false): string {
    if (regex || offset !== undefined) {
      // Hidden 1.9 alias forms (slopie grep --regex / --offset); the one tool has no such flags.
      if (this.style === 'mcp') return `grep(session=${q(id)}, pattern=${pattern === null ? '...' : q(pattern)}${regex ? ', regex=true' : ''}${offset !== undefined ? `, offset=${offset}` : ''})`;
      return `slopie grep ${id} ${pattern === null ? '<pattern>' : shq(pattern)}${regex ? ' --regex' : ''}${offset !== undefined ? ` --offset ${offset}` : ''}`;
    }
    return this.call({query: pattern ?? '...', session: id});
  }
  private moreThreads(offset: number): string {
    return this.style === 'mcp' ? `threads(..., offset=${offset})` : `slopie threads ... --offset ${offset}`;
  }
  private name(tool: 'search' | 'threads' | 'read' | 'grep'): string {
    if (tool === 'threads') return this.call({project: '...'});
    return this.style === 'mcp' ? 'search(query=...)' : 'slopie search <words>';
  }

  // ------------------------------------------------------------ helpers
  resolve(sid: string | undefined | null): {s: S | null; err: string | null} {
    let id = (sid ?? '').trim();
    if (id.split(':').length === 2 && ['claude', 'codex', 'pi', 'antigravity'].includes(id.split(':')[0]!)) id = id.split(':')[1]!;
    if (!id) return {s: null, err: 'session is required'};
    let hits = [...this.sessions.values()].filter(s => s.id === id || s.key.endsWith(':' + id));
    if (!hits.length && id.length >= 6) hits = [...this.sessions.values()].filter(s => s.id.startsWith(id) || s.key.split(':').slice(1).join(':').startsWith(id));
    if (!hits.length) return {s: null, err: `no session matches '${id}'. Find ids with ${this.name('search')} or ${this.name('threads')}.`};
    hits.sort((a, b) => Number(a.parent_kind === 'subagent') - Number(b.parent_kind === 'subagent') || (b.n_turns ?? 0) - (a.n_turns ?? 0));
    return {s: hits[0]!, err: null};
  }

  private filters(o: {project?: string; harness?: string; since?: string; until?: string; session?: string; includeSubagents?: boolean}): Set<string> | null {
    if (o.session) {
      const {s, err} = this.resolve(o.session);
      if (err || !s) throw new Error(err ?? 'no session');
      return new Set([s.key]);
    }
    let keys: Set<string> | null = null;
    const inc = o.includeSubagents ?? true;
    if (o.project || o.harness || !inc) {
      keys = new Set();
      const p = (o.project === '.' ? process.cwd() : o.project ?? '').toLowerCase().replace(/\/+$/, '');
      for (const s of this.sessions.values()) {
        if (p && !projectMatches(s.project, p)) continue;
        if (o.harness && s.harness !== o.harness) continue;
        if (!inc && s.parent_kind === 'subagent') continue;
        keys.add(s.key);
      }
    }
    if (o.since || o.until) {
      const base = keys ?? new Set(this.sessions.keys());
      keys = new Set([...base].filter(k => { const s = this.sessions.get(k)!; return (!o.since || (s.end ?? '') >= o.since) && (!o.until || (s.start ?? '') <= o.until); }));
    }
    return keys;
  }

  /** The INDEX.tsv `later` column (later threads that name this one by id), read once on first use. */
  private laterOf(s: S): string {
    if (!this.laterByKey) {
      this.laterByKey = new Map();
      try {
        for (const line of fs.readFileSync(path.join(this.recordsDir, 'INDEX.tsv'), 'utf8').split('\n')) {
          const f = line.split('\t');
          if (f.length >= 12 && f[11]) this.laterByKey.set(`${f[0]}:${f[1]}`, f[11]);
        }
      } catch { /* no INDEX.tsv: no backlinks */ }
    }
    return this.laterByKey.get(s.key) ?? this.laterByKey.get(`${s.harness}:${s.id}`) ?? '';
  }

  /** The end-of-thread line: where the work went next (the record's "## mentioned later in"), else later threads in the project. */
  private endOfThread(s: S): string {
    const later = this.laterOf(s);
    if (later) {
      const items = [...later.matchAll(/(\S+) \(([^,)]+), ([^)]+)\)/g)].map(m => ({id: m[1]!, text: m[0]}));
      if (items.length) {
        // The most recently active main thread among them (not the first listed).
        const act = (id: string) => [...this.sessions.values()].find(x => x.id === id)?.end ?? '';
        const mains = items.filter(x => !x.id.startsWith('agent-'));
        const next = ([...(mains.length ? mains : items)].sort((a, b) => (act(b.id) < act(a.id) ? -1 : act(b.id) > act(a.id) ? 1 : 0))[0]!).id;
        return ` Referenced later in: ${items.slice(0, 6).map(x => x.text).join(', ')}${items.length > 6 ? ` … +${items.length - 6}` : ''} (threads that mention this one; not necessarily where it continued). Read one: ${this.call({session: next, turns: '-30'})}`;
      }
    }
    return s.project ? ` Later threads in this project: ${this.call({project: s.project, since: (s.end ?? '').slice(0, 10) || undefined})}` : '';
  }

  private parentOf(s: S): S | null {
    if (!s.parent) return null;
    this.mainById ??= new Map([...this.sessions.values()].filter(x => x.parent_kind !== 'subagent').map(x => [x.id, x]));
    return this.mainById.get(s.parent) ?? null;
  }

  head(s: S): string {
    let par = '';
    if (s.parent && this.hitParent) {
      const p = this.parentOf(s);
      const pt = p && (p.title ?? '').trim() ? ` "${(p.title ?? '').trim().slice(0, 60)}"` : '';
      par = ` · ${relation(s.parent_kind, s.parent)}${pt}` + (s.parent_kind === 'subagent' ? ' (the user worked in the parent thread)' : s.parent_kind === 'delegated' ? ' (that thread dispatched and tracked this task)' : '');
    }
    const arch = s.archive_only ? ' · [deleted from harness; recovered from archive]' : '';
    return `${s.harness} ${s.id} · ${s.project || '?'} · ${shortTs(s.start)} → ${shortTs(s.end)} · ${s.n_turns} turns · "${(s.title ?? '').trim().slice(0, 80)}"${par}${arch}`;
  }

  // ------------------------------------------------------------ search
  /** Candidate turn ids for an FTS expression, scope predicates applied inside the SQL (before ORDER/LIMIT). */
  private ctxRids(fq: string, keys: Set<string> | null, since: string | undefined, until: string | undefined, limit: number): number[] {
    try {
      if (!keys && !since && !until) return (this.db.prepare('select rowid as r from ctx where ctx match ? order by rank limit ?').all(fq, limit) as {r: number}[]).map(r => r.r);
      const {where, args} = scopeSql(keys, since, until);
      return (this.db.prepare(`select ctx.rowid as r from ctx join turns t on t.rid = ctx.rowid where ctx match ? and ${where} order by bm25(ctx) limit ?`)
        .all(fq, ...args, limit) as {r: number}[]).map(r => r.r);
    } catch { return []; }
  }

  /** Sessions with at least one turn matching `fq`, scope applied in SQL. */
  private sessionsMatching(fq: string, keys: Set<string> | null, since?: string, until?: string): Set<string> {
    try {
      const {where, args} = scopeSql(keys, since, until);
      return new Set((this.db.prepare(`select distinct t.skey as k from ctx join turns t on t.rid = ctx.rowid where ctx match ?${where ? ` and ${where}` : ''}`)
        .all(fq, ...args) as {k: string}[]).map(r => r.k));
    } catch { return new Set(); }
  }

  private rank(query: string, keys: Set<string> | null, since?: string, until?: string, session?: string): (Row & {score: number})[] {
    const fq = ftsQuery(query);
    const score = new Map<number, number>();
    const lane = (rids: number[]) => rids.slice(0, 300).forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (60 + i)));
    if (fq) {
      lane(this.ctxRids(fq, keys, since, until, 400));
      // An AND lane: turns holding every word rank on their own, not only through OR.
      const fa = ftsQuery(query, 'and');
      if (fa && fa !== fq) lane(this.ctxRids(fa, keys, since, until, 200));
      if (!session) {
        let cards: string[] = [];
        try {
          cards = keys
            ? (this.db.prepare('select skey from cards where cards match ? and skey in (select value from json_each(?)) order by bm25(cards, 0, 3.0, 1.0) limit 60').all(fq, JSON.stringify([...keys])) as {skey: string}[]).map(r => r.skey)
            : (this.db.prepare('select skey from cards where cards match ? order by bm25(cards, 0, 3.0, 1.0) limit 60').all(fq) as {skey: string}[]).map(r => r.skey);
        } catch { cards = []; }
        const best = new Map<string, number>();
        if (score.size) {
          for (const r of this.db.prepare(`select rid, skey from turns where rid in (${[...score.keys()].join(',')})`).all() as {rid: number; skey: string}[]) {
            const b = best.get(r.skey);
            if (b === undefined || score.get(r.rid)! > score.get(b)!) best.set(r.skey, r.rid);
          }
        }
        const firstUser = this.db.prepare(`select rid from turns where skey=? and role='USER' order by n limit 1`);
        cards.forEach((sk, i) => {
          let rid = best.get(sk);
          if (rid === undefined) { const row = firstUser.get(sk) as {rid: number} | undefined; if (!row) return; rid = row.rid; }
          score.set(rid, (score.get(rid) ?? 0) + 1 / (60 + i));
        });
      }
    }
    const ranked = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!).slice(0, 400);
    if (!ranked.length) return [];
    const rows = new Map((this.db.prepare(`select rid, skey, n, role, ts, tool, body from turns where rid in (${ranked.join(',')})`).all() as Row[]).map(r => [r.rid, r]));
    return ranked.map(r => rows.get(r)).filter((r): r is Row => !!r).map(r => ({...r, score: score.get(r.rid)!}));
  }

  /** Main-thread prior: native subagents ×0.6, delegated ×0.85, ≤3 turns ×0.7, main threads a mild length prior (≤ ×1.3). */
  private prior(s: S): number {
    let m = s.parent_kind === 'subagent' ? 0.6 : s.parent_kind === 'delegated' ? 0.85 : Math.min(1.3, 1 + 0.1 * Math.log10(Math.max(1, s.n_turns)));
    if (s.n_turns <= 3) m *= 0.7;
    return m;
  }

  /** The family root: the main thread a subagent / delegated chain hangs from (itself for a main thread). */
  private rootOf(s: S): S {
    let cur = s;
    for (let i = 0; i < 8 && cur.parent; i++) {
      const p = this.parentOf(cur) ?? [...this.sessions.values()].find(x => x.id === cur.parent) ?? null;
      if (!p || p === cur) break;
      cur = p;
    }
    return cur;
  }

  private ageText(): string {
    const built = this.indexedAt ? Date.parse(this.indexedAt) : NaN;
    if (!Number.isFinite(built)) return 'index: age unknown';
    const s = Math.max(0, Math.round((Date.now() - built) / 1000));
    return `index: ${s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`} old`;
  }

  private hitOf(s: S, r: {n: number; role: string; ts: string | null; body: string; tool?: string | null}, snip: string, read: string): Hit {
    const root = this.rootOf(s);
    return {session: s.id, harness: s.harness, project: s.project, parent: s.parent, root: root.key !== s.key ? root.id : null, role: r.role, turn: r.n, at: r.ts, snippet: snip, read_cmd: read};
  }

  /** Project basenames closest to the words (for the no-match footer). */
  private nearProjects(words: string[], n = 3): string[] {
    const bases = new Map<string, number>();
    for (const s of this.sessions.values()) { const b = (s.project ?? '').split('/').filter(Boolean).pop(); if (b) bases.set(b, (bases.get(b) ?? 0) + 1); }
    const ws = words.map(w => w.toLowerCase()).filter(w => w.length >= 3);
    const scored = [...bases.entries()].map(([b, c]) => {
      const lb = b.toLowerCase();
      let d = Infinity;
      for (const w of ws) d = Math.min(d, lb.includes(w) || w.includes(lb) ? 0 : lev(lb, w));
      return {b, d, c};
    }).filter(x => x.d <= 3).sort((a, b) => a.d - b.d || b.c - a.c);
    return scored.slice(0, n).map(x => x.b);
  }

  private noMatch(o: {query: string; project?: string; harness?: string; since?: string; until?: string}): string {
    const ts = terms(o.query);
    const lines = ['No passages matched.'];
    const nexts: string[] = [];
    if (ts.length > 1) {
      // Relaxed: drop the last word (then keep only the longest one).
      nexts.push(this.call({query: ts.slice(0, -1).join(' '), project: o.project, since: o.since}));
      const longest = [...ts].sort((a, b) => b.length - a.length)[0]!;
      if (ts.length > 2) nexts.push(this.call({query: longest, project: o.project, since: o.since}));
    }
    if (o.project || o.since) nexts.push(this.call({query: o.query}));
    for (const p of this.nearProjects([...ts, ...(o.project ? [o.project] : [])])) if (p !== o.project) nexts.push(this.call({query: o.query, project: p}));
    if (!nexts.length) nexts.push(this.call({project: '...'}));
    this.result.next = nexts;
    lines.push(`Next: ${nexts.join('   or   ')}`);
    return lines.join('\n');
  }

  search(o: {query: string; k?: number; project?: string; harness?: string; since?: string; until?: string; session?: string; latest?: boolean; includeSubagents?: boolean}): string {
    const t0 = Date.now();
    const k = Math.max(1, Math.min(Math.trunc(Number(o.k ?? 8)) || 8, 30));
    if (!o.query || !o.query.trim()) return 'query is required.';
    let keys: Set<string> | null;
    // Subagents stay candidates (they are grouped under their parent below, not dropped).
    try { keys = this.filters({...o, includeSubagents: true}); } catch (e) { return (e as Error).message; }
    if (keys && !keys.size) return this.noScope(o);
    if (o.latest) return this.latest({...o, k}, keys, t0);
    this.result.mode = 'search';
    const cand = this.rank(o.query, keys, o.since, o.until, o.session);
    if (!cand.length) return this.noMatch(o);
    const ts = uniq(terms(o.query).map(t => t.toLowerCase()));
    // Per session: its candidate passages, coverage (every non-stopword term somewhere in its matching passages).
    const bySess = new Map<string, (Row & {score: number})[]>();
    for (const r of cand) { const l = bySess.get(r.skey); if (l) l.push(r); else bySess.set(r.skey, [r]); }
    const sk = new Set(bySess.keys());
    const covered = new Map<string, number>();
    if (ts.length > 1) {
      for (const t of ts) for (const key of this.sessionsMatching(`"${t.replace(/"/g, '')}"`, sk, o.since, o.until)) covered.set(key, (covered.get(key) ?? 0) + 1);
    }
    const full = (key: string) => ts.length <= 1 || (covered.get(key) ?? 0) >= ts.length;
    const rowCov = (r: Row) => { const low = r.body.toLowerCase(); return ts.filter(t => low.includes(stem(t))).length; };
    type E = {s: S; score: number; tier: number; row: Row; more: number};
    const entries: E[] = [];
    for (const [key, rows] of bySess) {
      const s = this.sessions.get(key);
      if (!s) continue;
      const top = Math.max(...rows.map(r => r.score));
      // The shown passage: most terms, then USER/ASSISTANT over TOOL dumps, then score.
      const row = [...rows].sort((a, b) => rowCov(b) - rowCov(a) || Number(a.role === 'TOOL') - Number(b.role === 'TOOL') || b.score - a.score)[0]!;
      entries.push({s, score: top * this.prior(s), tier: full(key) ? 0 : 1, row, more: rows.length - 1});
    }
    entries.sort((a, b) => a.tier - b.tier || b.score - a.score);
    const lines: string[] = [];
    const hits: Hit[] = [];
    let shown = 0, idx = 0;
    const emit = (e: E, indent: string) => {
      const s = e.s, r = e.row;
      const rl = r.role === 'USER' && s.parent_kind === 'subagent' ? 'PROMPT-FROM-PARENT-AGENT' : r.role;
      const snip = snippet(r.body, ts);
      const read = this.readCall(s.id, Math.max(1, r.n - 2), r.n + 4);
      lines.push(`${indent}    t${r.n} ${rl}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}: ${snip}`);
      lines.push(`${indent}    → ${read}`);
      if (e.more > 0) lines.push(`${indent}    +${e.more} more in this thread: ${this.grepCall(s.id, o.query.trim())}`);
      hits.push(this.hitOf(s, r, snip, read));
      shown++;
    };
    const tag = (e: E) => (e.tier ? ' (partial match)' : '');
    if (o.includeSubagents || o.session) {
      for (const e of entries) {
        if (shown >= k) break;
        lines.push(`[${++idx}]${tag(e)} ${this.head(e.s)}`);
        emit(e, '');
      }
    } else {
      // Families: a child and its root parent; at most two results per family, the parent first.
      const fams = new Map<string, E[]>();
      for (const e of entries) { const rk = this.rootOf(e.s).key; const l = fams.get(rk); if (l) l.push(e); else fams.set(rk, [e]); }
      const done = new Set<string>();
      for (const e of entries) {
        if (shown >= k) break;
        const rk = this.rootOf(e.s).key;
        if (done.has(rk)) continue;
        done.add(rk);
        const fam = fams.get(rk)!;
        let parent = fam.find(x => x.s.key === rk) ?? null;
        if (!parent && rk !== e.s.key) {
          // The parent matched outside the candidates: it is still shown first (its best passage), the child under it.
          const root = this.sessions.get(rk);
          const fq = ftsQuery(o.query);
          if (root && fq && (!keys || keys.has(rk))) {
            const rid = this.ctxRids(fq, new Set([rk]), o.since, o.until, 1)[0];
            const row = rid === undefined ? undefined : this.db.prepare('select rid, skey, n, role, ts, tool, body from turns where rid=?').get(rid) as Row | undefined;
            if (row) parent = {s: root, score: e.score, tier: e.tier, row, more: 0};
          }
        }
        const kids = fam.filter(x => x !== parent);
        if (parent) {
          lines.push(`[${++idx}]${fam.every(x => x.tier) ? tag(parent) : ''} ${this.head(parent.s)}`);
          emit(parent, '');
          const c = kids[0];
          if (c && shown < k) {
            lines.push(`    ↳ ${c.s.parent_kind === 'delegated' ? 'delegated' : 'subagent'}: ${ttl(c.s) || c.s.id} (t${c.row.n}) · ${c.s.harness} ${c.s.id} · ${c.s.n_turns} turns${tag(c)}`);
            emit(c, '    ');
          }
          if (kids.length > 1) lines.push(`    +${kids.length - 1} more child threads matched: ${this.call({parent: parent.s.id})}`);
        } else {
          // Only the child holds the words: it ranks on its own, labelled with its parent.
          lines.push(`[${++idx}]${tag(e)} ${this.head(e.s)}`);
          emit(e, '');
          if (kids.length > 1) lines.push(`    +${kids.length - 1} more threads of the same parent matched: ${this.call({parent: e.s.parent ?? e.s.id})}`);
        }
      }
    }
    this.result.hits = hits;
    this.result.partial = entries.length > 0 && entries[0]!.tier > 0;
    const threadsAll = bySess.size;
    lines.push(`(${hits.length} passages from ${idx} result groups; ${cand.length} candidates across ${threadsAll} threads; ${Date.now() - t0} ms.) If these miss: rephrase with words the hits use, or add project/since filters.`);
    const first = hits[0]!;
    const nexts = [first.read_cmd, this.grepCall(first.session, o.query.trim()), this.call({query: o.query.trim(), project: o.project, since: o.since, latest: true})];
    this.result.next = nexts;
    lines.push(`Next: ${nexts[0]} reads around hit 1; ${nexts[1]} lists every match inside that thread; ${nexts[2]} lists the threads with these words newest first.`);
    return lines.join('\n');
  }

  /** `--latest`: every eligible matching thread, newest last activity first, each with its LAST matching USER/ASSISTANT passage. */
  private latest(o: {query: string; k: number; project?: string; since?: string; until?: string; includeSubagents?: boolean}, keys: Set<string> | null, t0: number): string {
    this.result.mode = 'latest';
    const ts = uniq(terms(o.query).map(t => t.toLowerCase()));
    const fq = ftsQuery(o.query);
    if (!fq) return this.noMatch(o);
    let pool: Set<string> | null = null;
    for (const t of ts) {
      const m = this.sessionsMatching(`"${t.replace(/"/g, '')}"`, keys, o.since, o.until);
      const prev = pool as Set<string> | null;
      pool = prev ? new Set<string>([...prev].filter((x: string) => m.has(x))) : m;
    }
    let partial = false;
    if (!pool || !pool.size) { pool = this.sessionsMatching(fq, keys, o.since, o.until); partial = ts.length > 1; }
    if (!pool.size) return this.noMatch(o);
    const ss = [...pool].map(k => this.sessions.get(k)!).filter(s => s && (o.includeSubagents || s.parent_kind !== 'subagent'))
      .sort((a, b) => ((b.end ?? '') < (a.end ?? '') ? -1 : (b.end ?? '') > (a.end ?? '') ? 1 : 0));
    const lastRow = (key: string, expr: string, chat: boolean) => {
      const {where, args} = scopeSql(null, o.since, o.until);
      try {
        return this.db.prepare(`select t.rid, t.skey, t.n, t.role, t.ts, t.tool, t.body from ctx join turns t on t.rid = ctx.rowid where ctx match ? and t.skey = ?${chat ? ` and t.role in ('USER','ASSISTANT')` : ''}${where ? ` and ${where}` : ''} order by t.n desc limit 1`)
          .get(expr, key, ...args) as Row | undefined;
      } catch { return undefined; }
    };
    const fa = ftsQuery(o.query, 'and') ?? fq;
    const lines = [`${ss.length} threads with ${partial ? 'some of' : 'all of'} these words, newest last activity first${partial ? ' (partial match)' : ''}:`];
    const hits: Hit[] = [];
    ss.slice(0, o.k).forEach((s, i) => {
      const r = lastRow(s.key, fa, true) ?? lastRow(s.key, fq, true) ?? lastRow(s.key, fq, false);
      lines.push(`[${i + 1}] ${this.head(s)}`);
      if (!r) return;
      const snip = snippet(r.body, ts);
      const read = this.readCall(s.id, Math.max(1, r.n - 2), r.n + 4);
      lines.push(`    last match t${r.n} ${r.role}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}: ${snip}`);
      lines.push(`    → ${read}`);
      hits.push(this.hitOf(s, r, snip, read));
    });
    if (ss.length > o.k) lines.push(`(${ss.length - o.k} older threads not shown: add since/until or project.)`);
    lines.push(`(${Date.now() - t0} ms.)`);
    this.result.hits = hits;
    this.result.partial = partial;
    const nexts = hits.length ? [hits[0]!.read_cmd, this.call({session: hits[0]!.session, turns: '-30'})] : [];
    this.result.next = nexts;
    if (nexts.length) lines.push(`Next: ${nexts[0]} reads around the newest match; ${nexts[1]} reads that thread's end.`);
    return lines.join('\n');
  }

  /** Filters that leave no thread: say so, with the closest projects and the cwd's basename. */
  private noScope(o: {query?: string; project?: string; since?: string}): string {
    const nexts: string[] = [];
    if (o.project) {
      for (const p of this.nearProjects([o.project, ...terms(o.query ?? '')])) if (p !== o.project) nexts.push(this.call({query: o.query, project: p, since: o.since}));
      const cwd = path.basename(process.cwd());
      if (cwd && cwd !== o.project && [...this.sessions.values()].some(s => (s.project ?? '').toLowerCase().includes(cwd.toLowerCase()))) nexts.push(this.call({query: o.query, project: cwd, since: o.since}));
    }
    nexts.push(o.query ? this.call({query: o.query}) : this.call({since: o.since}).replace(/\(\)$/, '(project=...)'));
    this.result.next = uniq(nexts);
    return `No threads match those filters (project/harness/time)${o.project ? `: no thread's working directory contains ${pyRepr(o.project)}` : ''}. Next: ${uniq(nexts).join('   or   ')}`;
  }

  // ------------------------------------------------------------ the one tool
  /**
   * `search` (MCP) / `slopie search` (CLI): one entry point for every lookup.
   *   query                 ranked passages across every thread (project/harness/since/until filter them)
   *   session [+ turns]     read that thread's turns ("120-160", "-30" = the last 30, "120" = from 120)
   *   query + session       every exact match inside that thread, then the best passages with the words
   *   neither               list threads, newest first (project/harness/since/until filter them)
   */
  find(o: FindArgs): string {
    return this.findResult(o).text;
  }

  /** find() with its structured form. Every reply starts with the index age; the whole text is scrubbed once more. */
  findResult(o: FindArgs): FindResult {
    this.result = {mode: 'search', partial: false, hits: [], next: []};
    let body: string;
    try { body = this.find0(o); } catch (e) { this.result.mode = 'error'; body = `error: ${(e as Error).message}`; }
    const text = scrub([`(${this.ageText()})`, ...this.notes, body].join('\n'));
    return {...this.result, hits: this.result.hits.map(h => ({...h, snippet: scrub(h.snippet)})), indexed_at: this.indexedAt, text};
  }

  private find0(o: FindArgs): string {
    const text = (o.query ?? '').trim();
    const turns = o.turns === undefined || o.turns === null || o.turns === '' ? null : String(o.turns).trim();
    if (o.parent && !o.session) {
      this.result.mode = 'list';
      return this.threads({parent: o.parent, include_subagents: true, text: text || undefined, limit: 60});
    }
    if (o.session) {
      if (text) return this.inside(o.session, text);
      this.result.mode = 'read';
      const r = parseTurns(turns);
      if (!r) return `turns must look like "120-160", "-30" (the last 30) or "120" (from turn 120). Example: ${this.call({session: o.session, turns: '-30'})}`;
      return this.read({session: o.session, from_turn: r.from, to_turn: r.to, from_char: r.char});
    }
    if (turns) return `turns needs a session. Example: ${this.call({session: '<id>', turns: '-30'})}`;
    if (text) return this.search({query: text, k: o.k, project: o.project, harness: o.harness, since: o.since, until: o.until, latest: !!o.latest, includeSubagents: !!o.includeSubagents});
    this.result.mode = 'list';
    return this.list({project: o.project, harness: o.harness, since: o.since, until: o.until, includeSubagents: !!o.includeSubagents});
  }

  /** Threads newest first (up to 60), each with its opening ask; ends with the call that reads the newest one's end. */
  list(o: {project?: string; harness?: string; since?: string; until?: string; includeSubagents?: boolean}): string {
    const out = this.threads({...o, include_subagents: !!o.includeSubagents, limit: 60}).split('\n').filter(l => !l.startsWith('[more: ') && !l.startsWith('    last: '));
    const m = /^(\d+) threads/.exec(out[0] ?? '');
    const total = m ? Number(m[1]) : 0;
    if (!total) return this.noScope(o);
    if (total > 60) out.push(`(${total - 60} older threads not shown: narrow with since/until, or add a query.)`);
    const first = /^- (\S+) \|/.exec(out[1] ?? '');
    for (const l of out) {
      const m2 = /^- (\S+) \| (\S+) \| (.*?) \| (\S+ \S+) → (\S+ \S+) \|/.exec(l);
      if (m2) this.result.hits.push({session: m2[1]!, harness: m2[2]!, project: m2[3]!, parent: null, root: null, role: '', turn: 0, at: m2[5]!, snippet: '', read_cmd: this.call({session: m2[1]!, turns: '-30'})});
    }
    if (first) { this.result.next = [this.call({session: first[1]!, turns: '-30'})]; out.push(`Next: ${this.result.next[0]} reads the end of the newest thread.`); }
    return out.join('\n');
  }

  /** query + session: every exact (case-insensitive) match in reading order, then the best passages with the words. */
  inside(session: string, text: string): string {
    this.result.mode = 'inside';
    const {s, err} = this.resolve(session);
    if (err || !s) return err!;
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const {hits, partial} = this.grepHits(s, rx);
    const MAX = 60;
    const parent = s.parent && this.hitParent ? `, ${relation(s.parent_kind, s.parent)}` : '';
    const out = [`${hits.length} exact matches for ${pyRepr(text)} in ${s.harness} ${s.id} (${s.n_turns} turns, reading order${parent}):`, ...hits.slice(0, MAX).map(h => h.line)];
    this.result.hits = hits.slice(0, MAX).map(h => this.hitOf(s, {n: h.n, role: h.role, ts: h.ts, body: ''}, h.line, this.readCall(s.id, Math.max(1, h.n - 2), Math.min(s.n_turns, h.n + 4))));
    if (hits.length > MAX) out.push(`[${hits.length - MAX} more matches from t${hits[MAX]!.n} on: ${this.readCall(s.id, hits[MAX]!.n, Math.min(s.n_turns, hits[MAX]!.n + 39))}, or use more specific text]`);
    if (partial) out.push(`[partial scan: ${partial}.]`);
    let firstN = hits[0]?.n ?? 0;
    if (hits.length < 5 && terms(text).length > 1) {
      const cand = this.rank(text, new Set([s.key]), undefined, undefined, s.id).filter(r => !hits.some(h => h.n === r.n)).slice(0, 5);
      if (cand.length) {
        out.push(`Passages with these words${hits.length ? '' : ' (no exact match)'}:`);
        const ts = terms(text);
        firstN ||= cand[0]!.n;
        for (const r of cand) out.push(`t${r.n} ${r.role}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}: ${snippet(r.body, ts, 240)}`);
      }
    }
    if (firstN) out.push(`Next: ${this.readCall(s.id, Math.max(1, firstN - 2), Math.min(s.n_turns, firstN + 4))} reads around t${firstN}.`);
    else out.push(`No match in this thread. Try other words, or search every thread: ${this.call({query: text})}`);
    return out.join('\n');
  }

  // ------------------------------------------------------------ read
  read(o: {session: string; from_turn?: number | null; to_turn?: number | null; max_chars?: number | null; from_char?: number | null}): string {
    const {s, err} = this.resolve(o.session);
    if (err || !s) return err!;
    const N = s.n_turns;
    let a = o.from_turn === undefined || o.from_turn === null || Number.isNaN(Number(o.from_turn)) ? 1 : Math.trunc(Number(o.from_turn));
    if (a < 0) a = Math.max(1, N + a + 1);
    a = Math.max(1, Math.min(a, N));
    let b = o.to_turn === undefined || o.to_turn === null || Number.isNaN(Number(o.to_turn)) ? Math.min(N, a + 39) : Math.trunc(Number(o.to_turn));
    b = Math.max(a, Math.min(b, N));
    const maxChars = Math.max(2000, Math.min(Math.trunc(Number(o.max_chars ?? 12000)) || 12000, 40000));
    // Resume inside from_turn (a turn an earlier reply had to cut): the offset into its text.
    const c0 = Math.max(0, Math.trunc(Number(o.from_char ?? 0)) || 0);
    const rows = this.db.prepare('select n, role, ts, tool, body from turns where skey=? and n between ? and ? order by n').all(s.key, a, b) as Row[];
    const out = [this.head(s)];
    const ch = JSON.parse(s.children || '[]') as {id: string; kind: string}[];
    if (ch.length) out.push('children: ' + ch.slice(0, 20).map(x => `${x.id} (${x.kind})`).join(', ') + (ch.length > 20 ? ` … +${ch.length - 20}` : ''));
    // max_chars is the whole reply: header lines, turns and the footer (room for the longest footer is kept).
    const footerRoom = Math.max(`[turn ${N} of ${N} cut at character ${99999999} of ${99999999}; turns ${N}-${N} of ${N}. Continue: ${this.readCall(s.id, N, undefined, 99999999)}]`.length,
      `[turns ${N}-${N} of ${N}; end of thread.${this.endOfThread(s)}]`.length) + 1;
    let used = out.reduce((n, l) => n + l.length + 1, 0);
    let last = a - 1;
    let cut: {n: number; at: number; of: number} | null = null;
    for (const r of rows) {
      const from = r.n === a ? Math.min(c0, r.body.length) : 0;
      const head = `t${r.n} ${r.role}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}${from ? ` (continued from character ${from})` : ''}\n`;
      const block = `${head}${r.body.slice(from)}\n`;
      const room = maxChars - footerRoom - used;
      if (block.length + 1 <= room) { out.push(block); used += block.length + 1; last = r.n; continue; }
      // A turn that does not fit is cut only when it is the first one; later ones start the next reply.
      if (r.n > a) break;
      const mark = '…[turn continues]\n';
      let take = Math.max(0, room - head.length - mark.length - 1);
      const code = r.body.charCodeAt(from + take - 1);
      if (take > 0 && code >= 0xd800 && code <= 0xdbff) take--; // never split a surrogate pair
      out.push(`${head}${r.body.slice(from, from + take)}${mark}`);
      cut = {n: r.n, at: from + take, of: r.body.length};
      break;
    }
    if (cut) out.push(`[turn ${cut.n} cut at character ${cut.at} of ${cut.of}; ${last >= a ? `turns ${a}-${last}, then ` : ''}part of t${cut.n} of ${N}. Continue: ${this.readCall(s.id, cut.n, undefined, cut.at)}]`);
    else if (last < N) out.push(`[turns ${a}-${last} of ${N}. Continue: ${this.readCall(s.id, last + 1, Math.min(N, last + 40))}]`);
    else out.push(`[turns ${a}-${last} of ${N}; end of thread.${this.endOfThread(s)}]`);
    return out.join('\n');
  }

  // ------------------------------------------------------------ threads
  threads(o: {project?: string; harness?: string; since?: string; until?: string; text?: string; include_subagents?: boolean; parent?: string; limit?: number; offset?: number} = {}): string {
    const keys = this.filters({...o, includeSubagents: !!o.include_subagents});
    let pool = [...(keys ?? new Set(this.sessions.keys()))].map(k => this.sessions.get(k)!);
    if (o.parent) {
      const {s: ps, err} = this.resolve(o.parent);
      if (err || !ps) return err!;
      pool = [...this.sessions.values()].filter(s => s.parent === ps.id || s.key === ps.key);
    }
    let note = '';
    const firstHit = new Map<string, number>();
    if (o.text) {
      const fq = ftsQuery(o.text, 'and');
      if (fq) {
        // Session level: a thread qualifies when every word occurs somewhere in it (in any turns), so each word's
        // threads are found on their own and intersected. First match: the first turn holding all the words,
        // else the first turn holding any of them.
        const perTerm = this.db.prepare('select t.skey as skey, min(t.n) as n from ctx join turns t on t.rid = ctx.rowid where ctx match ? group by t.skey');
        const hits = (expr: string): Map<string, number> => {
          try { return new Map((perTerm.all(`body : (${expr})`) as {skey: string; n: number}[]).map(h => [h.skey, h.n])); } catch { return new Map(); }
        };
        let both: Map<string, number> | null = null;
        for (const term of fq.split(' AND ')) {
          const m = hits(term);
          if (!both) { both = m; continue; }
          for (const [k, n] of both) { const x = m.get(k); if (x === undefined) both.delete(k); else if (x < n) both.set(k, x); }
        }
        const together = hits(fq);
        for (const [k, n] of both ?? []) firstHit.set(k, together.get(k) ?? n);
        pool = pool.filter(s => firstHit.has(s.key));
        note = ` containing all of: ${o.text}`;
      }
    }
    pool.sort((a, b) => ((b.end ?? '') < (a.end ?? '') ? -1 : (b.end ?? '') > (a.end ?? '') ? 1 : 0));
    const limit = Math.max(1, Math.min(Math.trunc(Number(o.limit ?? 40)) || 40, 200));
    const offset = Math.max(0, Math.trunc(Number(o.offset ?? 0)) || 0);
    const page = pool.slice(offset, offset + limit);
    const out = [`${pool.length} threads${note} (newest first; showing ${offset + 1}-${offset + page.length}):`];
    for (const s of page) {
      const ch = JSON.parse(s.children || '[]') as unknown[];
      const extra: string[] = [];
      if (s.parent) extra.push(relation(s.parent_kind, s.parent));
      if (ch.length) extra.push(`${ch.length} child threads`);
      if (s.archive_only) extra.push('deleted from harness, archived copy');
      if (firstHit.has(s.key)) extra.push(`first match t${firstHit.get(s.key)}`);
      out.push(`- ${s.id} | ${s.harness} | ${s.project || '?'} | ${shortTs(s.start)} → ${shortTs(s.end)} | ${s.n_turns} turns | "${ws((s.title ?? '').trim()).slice(0, 70)}"` + (extra.length ? ` | ${extra.join('; ')}` : ''));
      out.push(`    ask: ${(s.first_user ?? '').slice(0, 110)}`);
      const la = s.last_assistant ?? '';
      out.push(`    last: ${la.slice(Math.max(0, la.length - 110))}`);
    }
    if (offset + page.length < pool.length) out.push(`[more: ${this.moreThreads(offset + page.length)}]`);
    return out.join('\n');
  }

  // ------------------------------------------------------------ grep
  /**
   * Turns with full text and output: re-read, uncapped, from the raw source when it is still there; else the
   * record's text, whose long fields are cut, so a scan of it is partial (`partial` says why).
   */
  private fullTurns(s: S): {turns: {role: string; ts: string | null; tool?: string; text: string; output?: string | null}[]; partial: string | null} {
    let why = s.best ? 'its raw source is gone' : 'it has no raw source (prompt history only)';
    if (s.best && fs.existsSync(s.best)) {
      try {
        const sub = s.harness === 'claude' && s.parent_kind === 'subagent' ? s.parent : null;
        const parsed = readSession(s.best, s.harness as Harness, sub, {text: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER});
        // Raw, uncapped text: grepHits scrubs every field it matches before a snippet is cut from it.
        if (parsed && parsed.turns.length >= s.n_turns) return {turns: parsed.turns, partial: null};
        why = 'its raw source no longer matches the record';
      } catch (e) {
        why = `its raw source could not be read (${(e as Error).message.slice(0, 80)})`;
      }
    }
    const turns = (this.db.prepare('select role, ts, tool, body from turns where skey=? order by n').all(s.key) as Row[]).map(r => {
      if (r.role !== 'TOOL') return {role: r.role, ts: r.ts, text: r.body};
      const i = r.body.indexOf('\n→ ');
      return {role: r.role, ts: r.ts, tool: r.tool ?? '', text: i < 0 ? r.body : r.body.slice(0, i), output: i < 0 ? null : r.body.slice(i + 3)};
    });
    return {turns, partial: `searched the record only (${why}); text the record shortens was not searched`};
  }

  private grepHits(s: S, rx: RegExp): {hits: {n: number; role: string; ts: string | null; line: string}[]; partial: string | null} {
    const hits: {n: number; role: string; ts: string | null; line: string}[] = [];
    const {turns, partial} = this.fullTurns(s);
    turns.slice(0, s.n_turns).forEach((t, i) => {
      for (const field of ['text', 'output'] as const) {
        const raw = (field === 'text' ? t.text : t.output) ?? '';
        if (!raw) continue;
        rx.lastIndex = 0;
        if (!rx.test(raw)) continue;
        // Secrets masked and binary elided before any snippet is cut (the raw source is uncapped and unredacted);
        // the turn list is untouched, so turn numbers match the record.
        const v = scrub(raw);
        rx.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(v))) {
          if (m[0] === '') { rx.lastIndex++; continue; }
          const a = Math.max(0, m.index - 140), b = Math.min(v.length, m.index + m[0].length + 140);
          hits.push({n: i + 1, role: t.role, ts: t.ts, line: `t${i + 1} ${t.role}${t.role === 'TOOL' ? ' ' + (t.tool ?? '') : ''}${field === 'output' ? ' (output)' : ''} ${shortTs(t.ts)}: ` + (a ? '…' : '') + ws(v.slice(a, b)) + (b < v.length ? '…' : '')});
        }
      }
    });
    return {hits, partial};
  }

  grep(o: {session: string; pattern: string; regex?: boolean; offset?: number; max_hits?: number}): string {
    const {s, err} = this.resolve(o.session);
    if (err || !s) return err!;
    if (!o.pattern) return 'pattern is required';
    let rx: RegExp;
    try { rx = new RegExp(o.regex ? o.pattern : o.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { return `bad regex: ${(e as Error).message}`; }
    const {hits: found, partial} = this.grepHits(s, rx);
    const hits = found.map(h => h.line);
    const offset = Math.max(0, Math.trunc(Number(o.offset ?? 0)) || 0);
    const maxHits = Math.max(1, Math.min(Math.trunc(Number(o.max_hits ?? 40)) || 40, 200));
    const page = hits.slice(offset, offset + maxHits);
    const parent = s.parent && this.hitParent ? `, ${relation(s.parent_kind, s.parent)}` : '';
    const out = [`${hits.length} matches for ${pyRepr(o.pattern)} in ${s.harness} ${s.id} (${s.n_turns} turns, reading order${parent}):`, ...page];
    if (offset + page.length < hits.length) out.push(`[more: ${this.grepCall(s.id, o.pattern, offset + page.length, !!o.regex)}]`);
    if (partial) out.push(`[partial scan: ${partial}.]`);
    if (!hits.length) {
      out.push(partial ? `No match in what could be searched. This does not clear the spelling: the full text was not available; try ${this.name('search')} or the raw files.`
        : `No match. This clears only this spelling in this thread; try another spelling or ${this.name('search')}.`);
    }
    return out.join('\n');
  }
}

/** Python repr of a string (the reference tool printed patterns that way). */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  return quote + s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`).replace(/\n/g, '\\n') + quote;
}

/** "120-160", "-30" (the last 30), "120" or "120-" (from 120), "t120-t160", "120@4000" (from character 4000 of t120). Null when malformed. */
export function parseTurns(t: string | null): {from: number | null; to: number | null; char: number | null} | null {
  if (t === null) return {from: null, to: null, char: null};
  const m = /^\s*(-?)t?(\d+)\s*(?:@\s*(\d+))?\s*(?:(?:-|\.\.|–|to)\s*t?(\d+)?)?\s*$/i.exec(t);
  if (!m) return null;
  const from = Number(m[2]) * (m[1] ? -1 : 1);
  return {from, to: m[4] !== undefined && !m[1] ? Number(m[4]) : null, char: m[3] !== undefined ? Number(m[3]) : null};
}

export interface FindArgs {
  query?: string; session?: string; turns?: string | number; project?: string; harness?: string; since?: string; until?: string; k?: number;
  latest?: boolean; includeSubagents?: boolean; parent?: string;
}

/** `--project`: the working directory contains it (a path or any path segment), case-insensitively. */
export function projectMatches(project: string | null, p: string): boolean {
  const lp = (project ?? '').toLowerCase();
  if (!p) return true;
  if (lp.includes(p)) return true;
  const segs = lp.split('/').filter(Boolean);
  return p.split('/').filter(Boolean).every(x => segs.includes(x));
}
