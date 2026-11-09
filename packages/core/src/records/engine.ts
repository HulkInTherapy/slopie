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

  constructor(recordsDir?: string, readonly style: CallStyle = 'cli') {
    this.recordsDir = paths.recordsDir(recordsDir);
    const file = path.join(stateDir(this.recordsDir), INDEX_FILE);
    if (!fs.existsSync(file)) throw new NoIndexError(file);
    this.db = openDatabase(file, {readonly: true, fileMustExist: true});
    for (const r of this.db.prepare('select * from sessions').all() as S[]) this.sessions.set(r.key, r);
  }

  close(): void { this.db.close(); }

  // ------------------------------------------------------------ call syntax (one tool: search)
  private call(a: {query?: string; session?: string; turns?: string; project?: string; since?: string}): string {
    if (this.style === 'mcp') {
      const parts = Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${q(v!)}`);
      return `search(${parts.join(', ')})`;
    }
    const parts = ['slopie search'];
    if (a.query !== undefined) parts.push(a.query === '...' ? '<text>' : shq(a.query));
    if (a.session !== undefined) parts.push('--session', a.session);
    if (a.turns !== undefined) parts.push('--turns', a.turns);
    if (a.project !== undefined) parts.push('--project', shq(a.project));
    if (a.since !== undefined) parts.push('--since', a.since);
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
    if (id.split(':').length === 2 && ['claude', 'codex', 'pi'].includes(id.split(':')[0]!)) id = id.split(':')[1]!;
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
      const p = (o.project ?? '').toLowerCase().replace(/\/+$/, '');
      for (const s of this.sessions.values()) {
        if (p && !(s.project ?? '').toLowerCase().includes(p)) continue;
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
        const next = (items.find(x => !x.id.startsWith('agent-')) ?? items[0]!).id;
        return ` Mentioned later in: ${items.slice(0, 6).map(x => x.text).join(', ')}${items.length > 6 ? ` … +${items.length - 6}` : ''}; the work or a decision often continued there. Next: ${this.call({session: next, turns: '-30'})}`;
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
  private rank(query: string, keys: Set<string> | null, since?: string, until?: string, session?: string): Row[] {
    const fq = ftsQuery(query);
    const score = new Map<number, number>();
    if (fq) {
      let rids: number[] = [];
      try { rids = (this.db.prepare('select rowid as r from ctx where ctx match ? order by rank limit 400').all(fq) as {r: number}[]).map(r => r.r); } catch { rids = []; }
      if (rids.length && (keys || since || until)) {
        const ok = new Set<number>();
        for (const r of this.db.prepare(`select rid, skey, ts from turns where rid in (${rids.join(',')})`).all() as {rid: number; skey: string; ts: string | null}[]) {
          if (keys && !keys.has(r.skey)) continue;
          if ((since && (r.ts ?? '') < since) || (until && (r.ts ?? '') > until)) continue;
          ok.add(r.rid);
        }
        rids = rids.filter(r => ok.has(r));
      }
      rids.slice(0, 300).forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (60 + i)));
      if (!session) {
        let cards: string[] = [];
        try { cards = (this.db.prepare('select skey from cards where cards match ? order by bm25(cards, 0, 3.0, 1.0) limit 60').all(fq) as {skey: string}[]).map(r => r.skey); } catch { cards = []; }
        if (keys) cards = cards.filter(k => keys.has(k));
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
    const ranked = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!).slice(0, 300);
    if (!ranked.length) return [];
    const rows = new Map((this.db.prepare(`select rid, skey, n, role, ts, tool, body from turns where rid in (${ranked.join(',')})`).all() as Row[]).map(r => [r.rid, r]));
    return ranked.map(r => rows.get(r)).filter((r): r is Row => !!r);
  }

  search(o: {query: string; k?: number; project?: string; harness?: string; since?: string; until?: string; session?: string}): string {
    const t0 = Date.now();
    const k = Math.max(1, Math.min(Math.trunc(Number(o.k ?? 8)) || 8, 30));
    if (!o.query || !o.query.trim()) return 'query is required.';
    let keys: Set<string> | null;
    try { keys = this.filters(o); } catch (e) { return (e as Error).message; }
    if (keys && !keys.size) return `No threads match those filters (project/harness/time). See what exists: ${this.name('threads')}`;
    const cand = this.rank(o.query, keys, o.since, o.until, o.session);
    if (!cand.length) return `No passages matched. Try other words (the ones the user or agent would have typed), drop filters, or browse threads by project and date: ${this.name('threads')}`;
    const out: Row[] = [];
    const per = new Map<string, number>();
    for (const r of cand) {
      if ((per.get(r.skey) ?? 0) >= 2) continue;
      per.set(r.skey, (per.get(r.skey) ?? 0) + 1);
      out.push(r);
      if (out.length >= k) break;
    }
    const ts = terms(o.query);
    const lines: string[] = [];
    out.forEach((r, i) => {
      const s = this.sessions.get(r.skey)!;
      lines.push(`[${i + 1}] ${this.head(s)}`);
      const rl = r.role === 'USER' && s.parent_kind === 'subagent' ? 'PROMPT-FROM-PARENT-AGENT' : r.role;
      lines.push(`    t${r.n} ${rl}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}: ${snippet(r.body, ts)}`);
      lines.push(`    → ${this.readCall(s.id, Math.max(1, r.n - 2), r.n + 4)}`);
    });
    // The newest threads among the 20 best candidates (by last activity): ranking is by relevance, and the latest word on
    // something is often in a later thread.
    const newest = [...new Set(cand.slice(0, 20).map(r => r.skey))].map(k => this.sessions.get(k)!).filter(s => s && s.parent_kind !== 'subagent')
      .sort((a, b) => ((b.end ?? '') < (a.end ?? '') ? -1 : (b.end ?? '') > (a.end ?? '') ? 1 : 0)).slice(0, 3);
    if (newest.length > 1) lines.push(`Newest threads with these words: ${newest.map(s => `${s.id} (${s.harness}, last active ${(s.end ?? '?').slice(0, 10)}${(s.title ?? '').trim() ? `, "${(s.title ?? '').trim().slice(0, 50)}"` : ''})`).join('; ')}.`);
    const threadsAll = new Set(cand.map(r => r.skey)).size, shown = new Set(out.map(r => r.skey)).size;
    const more = threadsAll - shown;
    lines.push(`(${out.length} hits shown; ${cand.length} candidates across ${threadsAll} threads${more > 0 ? `, ${more} more threads not shown` : ''}; ${Date.now() - t0} ms.) `
      + 'If these miss: rephrase with words the hits use, or add project/since filters.');
    const top = this.sessions.get(out[0]!.skey)!;
    lines.push(`Next: ${this.readCall(top.id, Math.max(1, out[0]!.n - 2), out[0]!.n + 4)} reads around hit 1; ${this.grepCall(top.id, o.query.trim())} lists every match inside that thread.`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------ the one tool
  /**
   * `search` (MCP) / `slopie search` (CLI): one entry point for every lookup.
   *   query                 ranked passages across every thread (project/harness/since/until filter them)
   *   session [+ turns]     read that thread's turns ("120-160", "-30" = the last 30, "120" = from 120)
   *   query + session       every exact match inside that thread, then the best passages with the words
   *   neither               list threads, newest first (project/harness/since/until filter them)
   */
  find(o: {query?: string; session?: string; turns?: string | number; project?: string; harness?: string; since?: string; until?: string; k?: number}): string {
    const text = (o.query ?? '').trim();
    const turns = o.turns === undefined || o.turns === null || o.turns === '' ? null : String(o.turns).trim();
    if (o.session) {
      if (text) return this.inside(o.session, text);
      const r = parseTurns(turns);
      if (!r) return `turns must look like "120-160", "-30" (the last 30) or "120" (from turn 120). Example: ${this.call({session: o.session, turns: '-30'})}`;
      return this.read({session: o.session, from_turn: r.from, to_turn: r.to, from_char: r.char});
    }
    if (turns) return `turns needs a session. Example: ${this.call({session: '<id>', turns: '-30'})}`;
    if (text) return this.search({query: text, k: o.k, project: o.project, harness: o.harness, since: o.since, until: o.until});
    return this.list({project: o.project, harness: o.harness, since: o.since, until: o.until});
  }

  /** Threads newest first (up to 60), each with its opening ask; ends with the call that reads the newest one's end. */
  list(o: {project?: string; harness?: string; since?: string; until?: string}): string {
    const out = this.threads({...o, limit: 60}).split('\n').filter(l => !l.startsWith('[more: ') && !l.startsWith('    last: '));
    const m = /^(\d+) threads/.exec(out[0] ?? '');
    const total = m ? Number(m[1]) : 0;
    if (!total) return `No threads match those filters. Drop one, or search by words: ${this.name('search')}`;
    if (total > 60) out.push(`(${total - 60} older threads not shown: narrow with since/until, or add a query.)`);
    const first = /^- (\S+) \|/.exec(out[1] ?? '');
    if (first) out.push(`Next: ${this.call({session: first[1]!, turns: '-30'})} reads the end of the newest thread.`);
    return out.join('\n');
  }

  /** query + session: every exact (case-insensitive) match in reading order, then the best passages with the words. */
  inside(session: string, text: string): string {
    const {s, err} = this.resolve(session);
    if (err || !s) return err!;
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const {hits, partial} = this.grepHits(s, rx);
    const MAX = 60;
    const parent = s.parent && this.hitParent ? `, ${relation(s.parent_kind, s.parent)}` : '';
    const out = [`${hits.length} exact matches for ${pyRepr(text)} in ${s.harness} ${s.id} (${s.n_turns} turns, reading order${parent}):`, ...hits.slice(0, MAX).map(h => h.line)];
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

  private grepHits(s: S, rx: RegExp): {hits: {n: number; line: string}[]; partial: string | null} {
    const hits: {n: number; line: string}[] = [];
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
          hits.push({n: i + 1, line: `t${i + 1} ${t.role}${t.role === 'TOOL' ? ' ' + (t.tool ?? '') : ''}${field === 'output' ? ' (output)' : ''} ${shortTs(t.ts)}: ` + (a ? '…' : '') + ws(v.slice(a, b)) + (b < v.length ? '…' : '')});
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
