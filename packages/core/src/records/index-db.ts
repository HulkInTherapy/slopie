/**
 * The lexical search index over the records (built by `slopie sync`, read by search/read/threads/grep):
 *
 *   sessions  one row per record (header fields, first ask, last assistant words, raw sources)
 *   turns     one row per turn: role, time, tool, body (the record's text of that turn)
 *   ctx       contentless FTS5 (pre, body): pre = "<title> · <project basename> · <date> · <ROLE>[ <tool>]",
 *             the deterministic contextual prefix of R5 arm M4; body = the turn (porter unicode61)
 *   cards     FTS5 session cards: title + project basename, and the user's asks
 *
 * No embeddings, no daemon: one SQLite file beside the records (`<records>/.slopie/index.sqlite`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {openDatabase, type Db} from '../sqlite-driver.js';
import type {Role} from '../sources/sessions.js';
import {squash} from '../sources/text.js';
import {turnBody, type RecSession, type RecTurn} from './format.js';

const SCHEMA = `
create table if not exists meta(k text primary key, v text);
create table if not exists sessions(
  key text primary key, harness text, id text, project text, title text, start text, "end" text,
  n_turns int, parent text, parent_kind text, children text, archive_only int, sources text, best text, rel text,
  first_user text, last_assistant text, sig text);
create index if not exists s_id on sessions(id);
create table if not exists turns(rid integer primary key, skey text, n int, role text, ts text, tool text, body text);
create index if not exists t_s on turns(skey, n);
create virtual table if not exists ctx using fts5(pre, body, content='', tokenize="porter unicode61 remove_diacritics 2");
create virtual table if not exists cards using fts5(skey unindexed, title, asks, tokenize="porter unicode61 remove_diacritics 2");
`;

export const INDEX_FILE = 'index.sqlite';

export interface IndexMeta {
  rel: string;
  children: readonly {id: string; kind: string}[];
  sources: readonly string[];
  archiveOnly: boolean;
  best: string | null;
  firstUser: string;
  lastAssistant: string;
}

const base = (p: string | null) => (p ?? '').split('/').pop() ?? '';

/** The contextual prefix of one turn (R5 M4). */
export function ctxPrefix(title: string | null, project: string | null, ts: string | null, role: string, tool: string | null): string {
  return `${squash(title ?? '').trim().slice(0, 120)} · ${base(project)} · ${(ts ?? '').slice(0, 10)} · ${role}${tool ? ' ' + tool : ''}`;
}

export class RecordIndex {
  private constructor(readonly db: Db, readonly file: string) {}

  /** Opens (creating) the index for writing; one transaction until finish(). */
  static open(dir: string): RecordIndex {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const file = path.join(dir, INDEX_FILE);
    const db = openDatabase(file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    // A rollback journal, not WAL: readers (search, MCP, an agent sandbox) can then open the index on a
    // read-only mount, where WAL would need to create its -shm file.
    db.exec('pragma journal_mode=delete; pragma synchronous=normal; pragma secure_delete=on;');
    db.exec(SCHEMA);
    db.exec('begin');
    return new RecordIndex(db, file);
  }

  clear(): void {
    this.db.exec(`delete from sessions; delete from turns; delete from cards; drop table if exists ctx;
      create virtual table ctx using fts5(pre, body, content='', tokenize="porter unicode61 remove_diacritics 2");`);
  }

  /** key -> sig of every indexed session. */
  keys(): Map<string, string> {
    return new Map((this.db.prepare('select key, sig from sessions').all() as {key: string; sig: string}[]).map(r => [r.key, r.sig]));
  }

  remove(key: string): void {
    const s = this.db.prepare('select title, project from sessions where key=?').get(key) as {title: string | null; project: string | null} | undefined;
    if (s) {
      const del = this.db.prepare(`insert into ctx(ctx, rowid, pre, body) values('delete', ?, ?, ?)`);
      for (const t of this.db.prepare('select rid, role, ts, tool, body from turns where skey=?').all(key) as {rid: number; role: string; ts: string | null; tool: string | null; body: string}[]) {
        del.run(t.rid, ctxPrefix(s.title, s.project, t.ts, t.role, t.tool), t.body ?? '');
      }
    }
    this.db.prepare('delete from turns where skey=?').run(key);
    this.db.prepare('delete from cards where skey=?').run(key);
    this.db.prepare('delete from sessions where key=?').run(key);
  }

  put(key: string, s: RecSession, m: IndexMeta, sig: string): void {
    const old = this.db.prepare('select title, project from sessions where key=?').get(key) as {title: string | null; project: string | null} | undefined;
    // Transcripts grow by appending: when the turns' prefix (title, project) is unchanged, only turns that
    // differ are replaced, so a sync after one new turn in a 3,000-turn session touches one row, not 3,000.
    const existing = new Map<number, {rid: number; role: string; ts: string | null; tool: string | null; body: string}>();
    if (old && old.title === s.title && old.project === s.project) {
      for (const r of this.db.prepare('select rid, n, role, ts, tool, body from turns where skey=?').all(key) as {rid: number; n: number; role: string; ts: string | null; tool: string | null; body: string}[]) existing.set(r.n, r);
    } else {
      this.remove(key);
    }
    this.db.prepare('delete from cards where skey=?').run(key);
    this.db.prepare('insert or replace into sessions values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      key, s.harness, s.id, s.project, s.title, s.start, s.end, s.turns.length, s.parent, s.parentKind, JSON.stringify(m.children), m.archiveOnly ? 1 : 0,
      JSON.stringify(m.sources), m.best, m.rel, m.firstUser, m.lastAssistant, sig);
    const ins = this.db.prepare('insert into turns(skey, n, role, ts, tool, body) values(?,?,?,?,?,?)');
    const fts = this.db.prepare('insert into ctx(rowid, pre, body) values(?,?,?)');
    const delFts = this.db.prepare(`insert into ctx(ctx, rowid, pre, body) values('delete', ?, ?, ?)`);
    const delTurn = this.db.prepare('delete from turns where rid=?');
    const drop = (e: {rid: number; role: string; ts: string | null; tool: string | null; body: string}) => {
      delFts.run(e.rid, ctxPrefix(old!.title, old!.project, e.ts, e.role, e.tool), e.body ?? '');
      delTurn.run(e.rid);
    };
    const asks: string[] = [];
    let askLen = 0;
    s.turns.forEach((t, i) => {
      const body = turnBody(t);
      if (t.role === 'USER' && askLen <= 30000) { asks.push(body.slice(0, 2000)); askLen += asks[asks.length - 1]!.length; }
      const e = existing.get(i + 1);
      if (e) {
        existing.delete(i + 1);
        if (e.role === t.role && e.ts === t.ts && e.tool === (t.tool ?? null) && e.body === body) return;
        drop(e);
      }
      const r = ins.run(key, i + 1, t.role, t.ts, t.tool ?? null, body);
      fts.run(Number(r.lastInsertRowid), ctxPrefix(s.title, s.project, t.ts, t.role, t.tool ?? null), body);
    });
    for (const e of existing.values()) drop(e);
    this.db.prepare('insert into cards(skey, title, asks) values(?,?,?)').run(key, `${s.title ?? ''} ${base(s.project)}`, asks.join('\n'));
  }

  /** Commits. `optimize` merges the FTS segments: worth it after a large rebuild, too slow for every small sync. */
  finish(optimize = false, vacuum = false): void {
    this.db.prepare(`insert or replace into meta values('built', ?)`).run(new Date().toISOString());
    this.db.exec('commit');
    if (optimize) try { this.db.exec(`insert into ctx(ctx) values('optimize')`); } catch { /* optional */ }
    // After a redaction migration: no freed page may still hold pre-redaction text (index, journal or WAL).
    if (vacuum) try { this.db.exec('pragma wal_checkpoint(TRUNCATE); vacuum;'); } catch { /* optional */ }
    this.db.close();
  }

  bytes(): number {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }
}

const DATED = /^t(\d+) (USER|ASSISTANT|SYSTEM) (\d{4}-\d\d-\d\d \d\d:\d\d|\?) \| (.*)$/;
const TOOL = /^t(\d+) TOOL (.*?) ?(\d\d:\d\d)? \| (.*)$/;
const CONT = /^t(\d+) \| (.*)$/;
const OUT = /^t(\d+) > ?(.*)$/;

/** A record file read back into its header and turns (used when a record outlives its sources). */
export function parseRecordText(text: string): {session: RecSession; header: {children: {id: string; kind: string}[]; sources: string[]; archiveOnly: boolean}} | null {
  const lines = text.split('\n');
  const h: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length && lines[i]!.startsWith('## '); i++) {
    const l = lines[i]!.slice(3);
    if (l.startsWith('session ')) h['session'] = l.slice(8);
    else { const c = l.indexOf(': '); if (c > 0) h[l.slice(0, c)] = l.slice(c + 2); }
  }
  const sess = h['session'];
  if (!sess) return null;
  const [harness, ...idParts] = sess.split(':');
  const time = /^(.*?) -> (.*?)\s+turns: \d+$/.exec(h['time'] ?? '');
  // "subagent of <id>", "fork of <id>", "delegated by <id>", "import of <id> (…)" (format.ts relation()).
  const pr = h['parent'] ?? '';
  const dm = /^delegated by (\S+)/.exec(pr), km = /^(\S+) of (\S+)/.exec(pr);
  const parentM: [string, string, string] | null = dm ? ['', 'delegated', dm[1]!] : km && pr !== 'none' ? ['', km[1]!, km[2]!] : null;
  const turns: (RecTurn & {lines: string[]; outs: string[]})[] = [];
  let lastDate = '';
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) continue;
    let m: RegExpExecArray | null;
    if ((m = DATED.exec(l))) {
      const ts = m[3] === '?' ? null : `${m[3]!.replace(' ', 'T')}:00Z`;
      if (ts) lastDate = ts.slice(0, 10);
      turns.push({role: m[2] as Role, ts, text: '', lines: [m[4]!], outs: []});
    } else if ((m = TOOL.exec(l)) && !CONT.test(l)) {
      const ts = m[3] && lastDate ? `${lastDate}T${m[3]}:00Z` : null;
      turns.push({role: 'TOOL', ts, tool: m[2] ?? '', text: '', lines: [m[4]!], outs: []});
    } else if ((m = CONT.exec(l))) {
      turns[turns.length - 1]?.lines.push(m[2]!);
    } else if ((m = OUT.exec(l))) {
      turns[turns.length - 1]?.outs.push(m[2]!);
    }
  }
  const children = (h['children'] && h['children'] !== 'none' ? h['children'].split(', ') : []).map(c => { const m = /^(\S+) \((.*)\)$/.exec(c); return m ? {id: m[1]!, kind: m[2]!} : null; }).filter((x): x is {id: string; kind: string} => !!x);
  const raw = h['raw'] ?? '';
  const archiveOnly = raw.includes('[deleted from harness; recovered from .potsherd archive]');
  const sources = raw.replace(/\s+\[deleted from harness; recovered from \.potsherd archive\]$/, '').split(' | ').filter(Boolean);
  return {
    session: {
      harness: harness as RecSession['harness'], id: idParts.join(':'), project: h['project'] === '?' ? null : h['project'] ?? null, title: h['title'] || null,
      start: time && time[1] !== '?' ? time[1]! : null, end: time && time[2] !== '?' ? time[2]! : null,
      parent: parentM ? parentM[2]! : null, parentKind: parentM ? parentM[1]! : null,
      turns: turns.map(t => ({role: t.role, ts: t.ts, ...(t.role === 'TOOL' ? {tool: t.tool} : {}), text: t.lines.join('\n'), ...(t.role === 'TOOL' ? {out: t.outs.length ? t.outs.join('\n') : null} : {})})),
    },
    header: {children, sources, archiveOnly},
  };
}
