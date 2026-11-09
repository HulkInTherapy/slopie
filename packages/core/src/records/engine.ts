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

  // ------------------------------------------------------------ call syntax
  private readCall(id: string, from: number, to?: number): string {
    if (this.style === 'mcp') return `read(session=${q(id)}, from_turn=${from}${to !== undefined ? `, to_turn=${to}` : ''})`;
    return `slopie read ${id} --from ${from}${to !== undefined ? ` --to ${to}` : ''}`;
  }
  private moreThreads(offset: number): string {
    return this.style === 'mcp' ? `threads(..., offset=${offset})` : `slopie threads ... --offset ${offset}`;
  }
  private grepCall(id: string, pattern: string | null, offset?: number): string {
    if (this.style === 'mcp') return `grep(session=${q(id)}, pattern=${pattern === null ? '...' : q(pattern)}${offset !== undefined ? `, offset=${offset}` : ''})`;
    return `slopie grep ${id} ${pattern === null ? '<pattern>' : shq(pattern)}${offset !== undefined ? ` --offset ${offset}` : ''}`;
  }
  private name(tool: 'search' | 'threads' | 'read' | 'grep'): string {
    return this.style === 'mcp' ? `${tool}(...)` : `slopie ${tool}`;
  }

  // ------------------------------------------------------------ helpers
  resolve(sid: string | undefined | null): {s: S | null; err: string | null} {
    let id = (sid ?? '').trim();
    if (id.split(':').length === 2 && ['claude', 'codex', 'pi'].includes(id.split(':')[0]!)) id = id.split(':')[1]!;
    if (!id) return {s: null, err: 'session is required'};
    let hits = [...this.sessions.values()].filter(s => s.id === id || s.key.endsWith(':' + id));
    if (!hits.length && id.length >= 6) hits = [...this.sessions.values()].filter(s => s.id.startsWith(id) || s.key.split(':').slice(1).join(':').startsWith(id));
    if (!hits.length) return {s: null, err: `no session matches '${id}'. Use ${this.name('threads')} or ${this.name('search')} to find ids.`};
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
    if (keys && !keys.size) return `No threads match those filters (project/harness/time). Try ${this.name('threads')} to see what exists.`;
    const cand = this.rank(o.query, keys, o.since, o.until, o.session);
    if (!cand.length) return `No passages matched. Try other words (the ones the user or agent would have typed), drop filters, or list ${this.name('threads')} to browse by project and date.`;
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
    const threadsAll = new Set(cand.map(r => r.skey)).size, shown = new Set(out.map(r => r.skey)).size;
    const more = threadsAll - shown;
    lines.push(`(${out.length} hits shown; ${cand.length} candidates across ${threadsAll} threads${more > 0 ? `, ${more} more threads not shown` : ''}; ${Date.now() - t0} ms.) `
      + `If these miss: rephrase with words the hits use, add project/since filters, or raise k. For every occurrence of an exact string in one thread use ${this.grepCall('<id>', null).replace('"<id>"', '...')}.`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------ read
  read(o: {session: string; from_turn?: number | null; to_turn?: number | null; max_chars?: number | null}): string {
    const {s, err} = this.resolve(o.session);
    if (err || !s) return err!;
    const N = s.n_turns;
    let a = o.from_turn === undefined || o.from_turn === null || Number.isNaN(Number(o.from_turn)) ? 1 : Math.trunc(Number(o.from_turn));
    if (a < 0) a = Math.max(1, N + a + 1);
    a = Math.max(1, Math.min(a, N));
    let b = o.to_turn === undefined || o.to_turn === null || Number.isNaN(Number(o.to_turn)) ? Math.min(N, a + 39) : Math.trunc(Number(o.to_turn));
    b = Math.max(a, Math.min(b, N));
    const maxChars = Math.max(2000, Math.min(Math.trunc(Number(o.max_chars ?? 12000)) || 12000, 40000));
    const rows = this.db.prepare('select n, role, ts, tool, body from turns where skey=? and n between ? and ? order by n').all(s.key, a, b) as Row[];
    const out = [this.head(s)];
    const ch = JSON.parse(s.children || '[]') as {id: string; kind: string}[];
    if (ch.length) out.push('children: ' + ch.slice(0, 20).map(x => `${x.id} (${x.kind})`).join(', ') + (ch.length > 20 ? ` … +${ch.length - 20}` : ''));
    let used = 0, last = a - 1;
    for (const r of rows) {
      let block = `t${r.n} ${r.role}${r.tool ? ' ' + r.tool : ''} ${shortTs(r.ts)}\n${r.body}\n`;
      if (used + block.length > maxChars && r.n > a) break;
      if (block.length > maxChars) block = block.slice(0, maxChars) + '…[turn truncated]\n';
      out.push(block);
      used += block.length;
      last = r.n;
    }
    if (last < N) out.push(`[turns ${a}-${last} of ${N}. Continue: ${this.readCall(s.id, last + 1)}]`);
    else out.push(`[turns ${a}-${last} of ${N}; end of thread.]`);
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
        let hit: {skey: string; n: number}[] = [];
        try { hit = this.db.prepare('select t.skey as skey, min(t.n) as n from ctx join turns t on t.rid = ctx.rowid where ctx match ? group by t.skey').all(`body : (${fq})`) as {skey: string; n: number}[]; } catch { hit = []; }
        for (const h of hit) firstHit.set(h.skey, h.n);
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
      out.push(`- ${s.id} | ${s.harness} | ${s.project || '?'} | ${shortTs(s.start)} → ${shortTs(s.end)} | ${s.n_turns} turns | "${(s.title ?? '').trim().slice(0, 70)}"` + (extra.length ? ` | ${extra.join('; ')}` : ''));
      out.push(`    ask: ${(s.first_user ?? '').slice(0, 110)}`);
      const la = s.last_assistant ?? '';
      out.push(`    last: ${la.slice(Math.max(0, la.length - 110))}`);
    }
    if (offset + page.length < pool.length) out.push(`[more: ${this.moreThreads(offset + page.length)}]`);
    return out.join('\n');
  }

  // ------------------------------------------------------------ grep
  /** Turns with full text and output: re-read from the raw source when it is still there, else the record's text. */
  private fullTurns(s: S): {role: string; ts: string | null; tool?: string; text: string; output?: string | null}[] {
    if (s.best && fs.existsSync(s.best)) {
      try {
        const sub = s.harness === 'claude' && s.parent_kind === 'subagent' ? s.parent : null;
        const parsed = readSession(s.best, s.harness as Harness, sub, {text: 200000, output: 200000});
        if (parsed && parsed.turns.length >= s.n_turns) return parsed.turns;
      } catch { /* fall back to the record */ }
    }
    return (this.db.prepare('select role, ts, tool, body from turns where skey=? order by n').all(s.key) as Row[]).map(r => {
      if (r.role !== 'TOOL') return {role: r.role, ts: r.ts, text: r.body};
      const i = r.body.indexOf('\n→ ');
      return {role: r.role, ts: r.ts, tool: r.tool ?? '', text: i < 0 ? r.body : r.body.slice(0, i), output: i < 0 ? null : r.body.slice(i + 3)};
    });
  }

  grep(o: {session: string; pattern: string; regex?: boolean; offset?: number; max_hits?: number}): string {
    const {s, err} = this.resolve(o.session);
    if (err || !s) return err!;
    if (!o.pattern) return 'pattern is required';
    let rx: RegExp;
    try { rx = new RegExp(o.regex ? o.pattern : o.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { return `bad regex: ${(e as Error).message}`; }
    const hits: string[] = [];
    this.fullTurns(s).slice(0, s.n_turns).forEach((t, i) => {
      for (const field of ['text', 'output'] as const) {
        const v = (field === 'text' ? t.text : t.output) ?? '';
        if (!v) continue;
        rx.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(v))) {
          if (m[0] === '') { rx.lastIndex++; continue; }
          const a = Math.max(0, m.index - 140), b = Math.min(v.length, m.index + m[0].length + 140);
          hits.push(`t${i + 1} ${t.role}${t.role === 'TOOL' ? ' ' + (t.tool ?? '') : ''}${field === 'output' ? ' (output)' : ''} ${shortTs(t.ts)}: ` + (a ? '…' : '') + ws(v.slice(a, b)) + (b < v.length ? '…' : ''));
        }
      }
    });
    const offset = Math.max(0, Math.trunc(Number(o.offset ?? 0)) || 0);
    const maxHits = Math.max(1, Math.min(Math.trunc(Number(o.max_hits ?? 40)) || 40, 200));
    const page = hits.slice(offset, offset + maxHits);
    const parent = s.parent && this.hitParent ? `, ${relation(s.parent_kind, s.parent)}` : '';
    const out = [`${hits.length} matches for ${pyRepr(o.pattern)} in ${s.harness} ${s.id} (${s.n_turns} turns, reading order${parent}):`, ...page];
    if (offset + page.length < hits.length) out.push(`[more: ${this.grepCall(s.id, o.pattern, offset + page.length)}]`);
    if (!hits.length) out.push(`No match. This clears only this spelling in this thread; try another spelling or ${this.name('search')}.`);
    return out.join('\n');
  }
}

/** Python repr of a string (the reference tool printed patterns that way). */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  return quote + s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`).replace(/\n/g, '\\n') + quote;
}
