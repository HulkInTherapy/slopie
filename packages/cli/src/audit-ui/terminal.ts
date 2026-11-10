/**
 * The interactive `slopie audit` experience: loading story → story cards → share board.
 *
 * - Cell-diff rendering, one synchronized write per frame, 30 fps only while something moves.
 *   When everything is still, no timer runs (the next paint waits for a key, a resize or data).
 * - ←/→ (h/l, space, enter, n) page; on the board → restarts the story at the cover; b board; s save share SVG; ? method notes; 1–4 guess; q/Ctrl-C quit.
 * - Alt screen, cursor, raw mode and bracketed paste are always restored (quit, signals, crashes).
 * - A transfer notice is acknowledged only after the frame showing it in full has been flushed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, AuditSession, AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { renderCard } from './cards/index.js';
import { revealDone, T } from './cards/reveal.js';
import { MIN_COLS, MIN_ROWS, tierFor, type CardState, type Scene } from './cards/scene.js';
import { Canvas } from './gfx/canvas.js';
import { C, mix } from './gfx/color.js';
import { textCenter, textWidth, wrapText } from './gfx/draw.js';
import { CellRenderer, detectCaps, type Caps } from './gfx/screen.js';
import { LoadingStory, loadingModel } from './loading.js';
import { applyAuditEvent, applyPreviewInvalidation, applyPrivacyEvent, type PrivacyView, type TransferEvent } from './session-state.js';
import { storyShareSvg } from './share.js';
import { buildDeck, type DeckCard } from './story/deck.js';
import { sanitize } from './text.js';
import { baseline, digestOf, historyDir, readHistory, sinceLast, writeDigest, type Since } from './history.js';
import { wentOnline } from './story/source.js';
import { detailLines } from './view-model.js';

export interface TerminalIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface TerminalOptions {
  /** Injected streams for tests; defaults to the process TTY. */
  io?: TerminalIo;
  color?: boolean;
  ascii?: boolean;
  width?: number;
  motion?: boolean;
  private?: boolean;
  /** Where `s` saves the share card (default: the current directory). */
  shareDir?: string;
  /** Injected clock for tests. */
  now?: () => number;
  /** Run-history directory; false disables it (default: ~/.potsherd/audit-history, off with injected io). */
  historyDir?: string | false;
}

export interface TerminalResult {
  snapshot: AuditSnapshot;
  reason: 'quit' | 'cancelled' | 'complete';
}

export type Key = 'quit' | 'left' | 'right' | 'details' | 'back' | 'enter' | 'board' | 'share' | `guess${1 | 2 | 3 | 4}` | null;

/**
 * Split a stdin chunk into keys at escape boundaries, so fast typists (or a terminal that batches
 * "Esc s") still get every key. Runs of plain characters stay one token and are ignored as paste.
 */
export function splitKeys(chunk: string): string[] {
  const out: string[] = [];
  for (const part of chunk.split(/(?=\x1b)/)) {
    if (!part) continue;
    const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(part);
    if (seq) {
      out.push(seq[0]);
      if (part.length > seq[0].length) out.push(part.slice(seq[0].length));
    } else if (part[0] === '\x1b' && part.length > 1) out.push('\x1b', part.slice(1));
    else out.push(part);
  }
  return out;
}

/** Decode one key token. Pasted or unknown multi-character input never triggers a command. */
export function decodeKey(chunk: string): Key {
  switch (chunk) {
    case '\x03': case 'q': case 'Q': return 'quit';
    case '\x1b[C': case '\x1bOC': case 'l': case 'n': case ' ': return 'right';
    case '\x1b[D': case '\x1bOD': case 'h': return 'left';
    case '?': return 'details';
    case '\x1b': return 'back';
    case '\r': case '\n': return 'enter';
    case 'b': case 'B': return 'board';
    case 's': case 'S': return 'share';
    case '1': return 'guess1';
    case '2': return 'guess2';
    case '3': return 'guess3';
    case '4': return 'guess4';
    default: return null;
  }
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Streaming key parser. Escape sequences and bracketed-paste delimiters may arrive split across
 * stdin chunks at any byte; an incomplete tail is held until the next chunk (or a short timeout),
 * and everything between paste delimiters is dropped, never executed as keys.
 */
export class InputParser {
  private pending = '';
  private pasting = false;
  constructor(private readonly emit: (token: string) => void) {}

  get holding(): boolean { return this.pending.length > 0; }

  feed(chunk: string): void {
    let buf = this.pending + chunk;
    this.pending = '';
    for (;;) {
      if (this.pasting) {
        const end = buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep only what could be the start of the end marker.
          this.pending = partialTail(buf, PASTE_END);
          return;
        }
        buf = buf.slice(end + PASTE_END.length);
        this.pasting = false;
        continue;
      }
      const start = buf.indexOf(PASTE_START);
      if (start >= 0) {
        this.keys(buf.slice(0, start));
        buf = buf.slice(start + PASTE_START.length);
        this.pasting = true;
        continue;
      }
      // An unfinished escape sequence at the end waits for the rest.
      const tail = /\x1b(?:\[[0-9;]*|O)?$/.exec(buf);
      if (tail) {
        this.keys(buf.slice(0, tail.index));
        this.pending = tail[0];
        return;
      }
      this.keys(buf);
      return;
    }
  }

  /** Timeout: a held lone Esc is a real Esc; a held partial sequence is dropped. */
  flush(): void {
    const held = this.pending;
    this.pending = '';
    if (!this.pasting && held === '\x1b') this.emit('\x1b');
  }

  private keys(text: string): void {
    if (!text) return;
    for (const token of splitKeys(text)) this.emit(token);
  }
}

/** The longest suffix of `text` that is a proper prefix of `marker`. */
function partialTail(text: string, marker: string): string {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) if (marker.startsWith(text.slice(-n))) return text.slice(-n);
  return '';
}

const FRAME_MS = 33;
/** Card clocks run 1.5× real time: entrances read as snappy (most settle in ~1 s) without losing their shape. */
const CARD_SPEED = 1.5;
const TRANSFER_LINGER_MS = 1800;

export async function runWallboard(session: AuditSession, options: TerminalOptions = {}): Promise<TerminalResult> {
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return { snapshot: await session.run(), reason: 'complete' };

  const caps: Caps = detectCaps(process.env, { color: options.color, motion: options.motion, ascii: options.ascii });
  const renderer = new CellRenderer(caps.color);
  const clock = options.now ?? (() => performance.now());
  const started = clock();

  let view: PrivacyView = { snapshot: session.snapshot(), generation: 0, revoked: null };
  let settled = false;
  let stopping = false;
  let reason: TerminalResult['reason'] = 'quit';
  let mode: 'loading' | 'deck' = 'loading';
  let notes: { page: number } | null = null;
  let deck: DeckCard[] = [];
  let deckSnapshot: AuditSnapshot | null = null;
  let index = 0;
  let enteredAt = started;
  const states = new Map<string, CardState>();
  const story = new LoadingStory(started);
  let toast: { text: string; until: number } | null = null;
  const blink = false;
  let needsClear = true;

  let ticker: ReturnType<typeof setInterval> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  const transfers: TransferEvent[] = [];
  const queue: TransferEvent[] = [];
  const acknowledged = new Set<string>();
  let lastTransferSequence = -1;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let lingering: TransferEvent | null = null;

  /* ── terminal setup and guaranteed restore ── */
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdin.setRawMode(false); } catch { /* stdin already closed */ }
    stdin.pause();
    try { stdout.write('\x1b[?2026l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'); } catch { /* stdout already closed */ }
  };
  const onCrash = (error: unknown) => {
    restore();
    process.stderr.write(`slopie audit crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  const onSignal = () => stop();
  process.on('exit', restore);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);

  (globalThis as { __slopieSplash?: { handOff(): void } }).__slopieSplash?.handOff();
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  const size = () => ({
    w: Math.max(1, Math.min(stdout.columns || 80, options.width ?? Infinity)),
    h: Math.max(1, stdout.rows || 24),
  });

  /* ── composition ── */

  function current(): DeckCard | null {
    return mode === 'deck' ? deck[index] ?? null : null;
  }

  function stateOf(card: DeckCard): CardState {
    let state = states.get(card.id);
    if (!state) { state = {}; states.set(card.id, state); }
    return state;
  }

  function drawTooSmall(c: Canvas, w: number, h: number): void {
    const msg = `slopie needs ${MIN_COLS}×${MIN_ROWS}. You're at ${w}×${h}.`;
    const y = Math.max(0, Math.floor(h / 2) - 1);
    const head = wrapText('Make the window bigger.', w - 2);
    const body = wrapText(msg, w - 2);
    if (head.length === 1) textCenter(c, w / 2, y, head[0]!, { fg: C.text, bold: true });
    if (body.length <= 2) body.forEach((line, i) => textCenter(c, w / 2, y + 1 + i, line, { fg: C.text2 }));
  }

  /** Transfer banner (Jev): returns false when the notice cannot be shown in full. */
  function drawBanner(c: Canvas, w: number, h: number): boolean {
    const event = queue[0] ?? lingering;
    if (!event) return false;
    const text = sanitize(event.notice);
    const lines = wrapText(text, Math.max(10, w - 6), 99);
    if (lines.length > 4 || lines.length + 2 > h) return false;
    // A full-width band one step up from the background, closed by a hairline.
    const height = lines.length + 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) c.put(x, y, y === height - 1 ? (caps.unicode ? '─' : '-') : ' ', C.text3, C.rule);
    lines.forEach((line, i) => c.text(3, 1 + i, line, { fg: C.text, bg: C.rule, bold: i === 0 }));
    return true;
  }

  function drawNotes(c: Canvas, card: DeckCard, w: number, h: number): void {
    const pw = Math.min(76, w - 6);
    const keys = card.kind === 'board' ? ['Press → to watch your story from the first card; b brings you back to this board.'] : [];
    const sections: { title: string; lines: string[] }[] = [{ title: 'HOW WE KNOW', lines: [...keys, ...card.notes] }];
    if (card.kind === 'board' || card.kind === 'bill' || card.kind === 'scale') {
      for (const section of detailLines(view.snapshot, transfers)) sections.push({ title: section.title.toUpperCase(), lines: section.lines });
    }
    const all: { text: string; title: boolean }[] = [];
    for (const section of sections) {
      if (all.length) all.push({ text: '', title: false });
      all.push({ text: section.title, title: true });
      for (const line of section.lines) for (const row of wrapText(sanitize(line), pw - 4)) all.push({ text: row, title: false });
    }
    const perPage = Math.max(3, h - 8);
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const page = Math.min(notes!.page, pages - 1);
    notes!.page = page;
    const rows = all.slice(page * perPage, (page + 1) * perPage);
    // A page of its own (no box): the card fades back, the notes sit on a hairline-framed column.
    for (let i = 0; i < c.fg.length; i++) if (c.fg[i]! >= 0) c.fg[i] = mix(C.bg, c.fg[i]!, 0.12);
    const ph = rows.length + 4;
    const px = Math.floor((w - pw) / 2), py = Math.max(1, Math.floor((h - ph) / 2));
    for (let y = py - 1; y < py + ph + 1; y++) for (let x = px - 2; x < px + pw; x++) c.put(x, y, ' ', C.text, C.bg);
    for (let x = px - 2; x < px + pw; x++) { c.put(x, py - 1, caps.unicode ? '─' : '-', C.rule, C.bg); c.put(x, py + ph, caps.unicode ? '─' : '-', C.rule, C.bg); }
    rows.forEach((row, i) => c.text(px, py + 1 + i, row.text, { fg: row.title ? C.text3 : C.text, bg: C.bg }, pw - 2));
    const foot = pages > 1 ? `${page + 1}/${pages}  ${caps.unicode ? '← →' : '< >'} page · ? or esc to close` : '? or esc to close';
    c.text(px, py + ph - 1, foot, { fg: C.text2, bg: C.bg });
  }

  function compose(now: number): { canvas: Canvas; busy: boolean; bannerShown: boolean } {
    const { w, h } = size();
    const paintBg = caps.color === 'truecolor' || caps.color === '256';
    const canvas = new Canvas(w, h, paintBg ? C.bg : -1);
    if (paintBg) canvas.fill(0, 0, w, h, ' ', { bg: C.bg });
    let busy = false;
    const tier = tierFor(w, h);
    if (!tier) {
      drawTooSmall(canvas, w, h);
      return { canvas, busy: false, bannerShown: false };
    }
    if (mode === 'loading') {
      const model = loadingModel(view.snapshot);
      busy = story.render(canvas, model, now, caps, blink);
      if (model.ready && !model.failure && (!caps.motion || story.done(now))) {
        startDeck(now);
        return compose(now);
      }
    } else {
      const card = deck[index];
      if (card) {
        const scene: Scene = {
          c: canvas, w, h, tier, caps, blink, state: stateOf(card), index, total: deck.length, online: wentOnline(view.snapshot, transfers.length),
          t: caps.motion ? (now - enteredAt) * CARD_SPEED : Infinity,
        };
        busy = renderCard(scene, card);
        if (notes) drawNotes(canvas, card, w, h);
      }
    }
    if (toast && toast.until > now) {
      const text = ` ${toast.text} `;
      const tx = Math.max(0, Math.floor((w - textWidth(text)) / 2));
      canvas.text(tx, h - (tier.id === 'L' ? 4 : 3), text, { fg: C.text, bg: C.rule, bold: true });
    }
    const bannerShown = drawBanner(canvas, w, h);
    return { canvas, busy, bannerShown };
  }

  /* ── painting and timers ── */

  function paint(): void {
    if (scheduled) { clearTimeout(scheduled); scheduled = null; }
    if (restored) return;
    const now = clock();
    const { canvas, busy, bannerShown } = compose(now);
    const out = renderer.frame(canvas, needsClear);
    needsClear = false;
    const active = queue[0];
    if (active && bannerShown) stdout.write(out || '\x1b[?2026h\x1b[?2026l', () => acknowledge(active));
    else if (out) stdout.write(out);
    animate(busy);
  }

  function schedule(): void {
    if (scheduled || restored) return;
    scheduled = setTimeout(paint, 8);
  }

  function animate(busy: boolean): void {
    if (busy && caps.motion && !restored) {
      if (!ticker) ticker = setInterval(paint, FRAME_MS);
      return;
    }
    // Still: no timers at all until a key, a resize or new data arrives.
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function flash(text: string, ms = 1600): void {
    toast = { text, until: clock() + ms };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; toastTimer = null; paint(); }, ms);
    paint();
  }

  /* ── run history ── */
  const histDir = options.historyDir !== undefined ? options.historyDir : options.io ? false : historyDir();
  let history: { since: Since | null; firstRun: boolean } | null = null;
  let digestWritten = false;
  let openedOnBoard = false;
  /** The "press → to watch your story" banner, until the first keypress. */
  let bannerOn = false;

  function loadHistory(snapshot: AuditSnapshot): void {
    if (history || histDir === false) return;
    const digest = digestOf(snapshot);
    if (!digest) return;
    const past = readHistory(snapshot, histDir);
    const prev = baseline(past);
    history = { since: prev ? sinceLast(prev, digest, past) : null, firstRun: !past.length };
    if (!digestWritten && (snapshot.status === 'ready' || snapshot.status === 'partial')) digestWritten = writeDigest(snapshot, digest, histDir);
  }

  /** The deck with this run's history folded into the board (ticker, records, replay hint). */
  function decorate(cards: DeckCard[]): DeckCard[] {
    const last = cards.at(-1);
    if (!last || last.kind !== 'board' || !history) return cards;
    const since = history.since;
    const records = since?.records ?? [];
    const awards = records.length
      ? [{ title: 'New Personal Best', value: `${records[0]!.metric}: ${records[0]!.to}`, publicValue: `${records[0]!.metric}: ${records[0]!.to}`, tier: 'gold' as const }, ...last.data.awards].slice(0, 6)
      : last.data.awards;
    const board = { ...last, data: { ...last.data, sinceLast: since?.line ?? null, firstRun: history.firstRun, replay: openedOnBoard && bannerOn, awards } };
    return [...cards.slice(0, -1), board];
  }

  /* ── navigation ── */

  function startDeck(now: number): void {
    deckSnapshot = view.snapshot;
    loadHistory(view.snapshot);
    // Re-runs open on the verdict (the screenshot); → replays the story from the cover.
    openedOnBoard = !!history && !history.firstRun;
    bannerOn = openedOnBoard;
    deck = decorate(buildDeck(view.snapshot));
    mode = 'deck';
    index = openedOnBoard ? deck.length - 1 : 0;
    enteredAt = now;
    needsClear = false;
  }

  function go(next: number): void {
    if (next < 0) { flash('this is the start'); return; }
    if (next >= deck.length) { flash(`that's all of it · s saves the card · q quits`); return; }
    index = next;
    enteredAt = clock();
    notes = null;
    paint();
  }

  /* ── transfers ── */
  function acknowledge(event: TransferEvent): void {
    if (stopping || queue[0] !== event) return;
    if (event.ackId && !acknowledged.has(event.ackId)) {
      acknowledged.add(event.ackId);
      session.acknowledgeTransfer?.(event.ackId);
    }
    queue.shift();
    if (queue.length) { schedule(); return; }
    lingering = event;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { lingering = null; bannerTimer = null; schedule(); }, TRANSFER_LINGER_MS);
  }

  /* ── session events ── */
  function publish(event: AuditEvent): void {
    if (stopping) return;
    const revoked = applyPrivacyEvent(view, event);
    if (revoked) {
      view = revoked;
      queue.length = 0;
      lingering = null;
      session.cancel();
      if (mode === 'deck') { deck = decorate(buildDeck(view.snapshot)); index = Math.min(index, deck.length - 1); }
      flash('Cleared by your privacy settings');
      return;
    }
    if (view.revoked) return;
    const withdrawn = applyPreviewInvalidation(view, event);
    if (withdrawn) { view = withdrawn; schedule(); return; }
    if (event.type === 'transfer') {
      if (event.snapshotId !== view.snapshot.snapshotId || event.sequence < view.snapshot.sequence || event.sequence <= lastTransferSequence) return;
      if (event.ackId && (acknowledged.has(event.ackId) || queue.some(item => item.ackId === event.ackId))) return;
      lastTransferSequence = event.sequence;
      if (queue.length >= 128) { reason = 'cancelled'; stop(); return; }
      transfers.push(event);
      if (transfers.length > 100) transfers.shift();
      queue.push(event);
      lingering = null;
      schedule();
      return;
    }
    view = { ...view, snapshot: applyAuditEvent(view.snapshot, event) };
    // A later snapshot (e.g. Jev wording) refreshes the deck in place, keeping the current card.
    if (mode === 'deck' && view.snapshot !== deckSnapshot) {
      const id = deck[index]?.id;
      deckSnapshot = view.snapshot;
      deck = decorate(buildDeck(view.snapshot));
      const found = deck.findIndex(card => card.id === id);
      index = found >= 0 ? found : Math.min(index, deck.length - 1);
    }
    schedule();
  }

  /* ── input ── */
  const input = new InputParser(token => onKey(token));
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  const onData = (chunk: string) => {
    input.feed(chunk);
    // A held lone Esc (or a split escape) is released if nothing completes it soon.
    if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    if (input.holding) inputTimer = setTimeout(() => { inputTimer = null; input.flush(); }, 40);
  };
  const onKey = (token: string) => {
    if (stopping) return;
    const key = decodeKey(token);
    if (!key) return;
    if (key === 'quit') { stop(); return; }
    const now = clock();
    if (mode === 'loading') {
      const model = loadingModel(view.snapshot);
      if (story.skippable(model, now) && !model.failure) { startDeck(now); paint(); }
      else if (key === 'back') stop();
      return;
    }
    if (bannerOn) { bannerOn = false; deck = decorate(buildDeck(view.snapshot)); }
    const card = current();
    if (!card) return;
    if (notes) {
      if (key === 'details' || key === 'back' || key === 'enter') notes = null;
      else if (key === 'left') notes.page = Math.max(0, notes.page - 1);
      else if (key === 'right') notes.page += 1;
      paint();
      return;
    }
    switch (key) {
      case 'details': notes = { page: 0 }; paint(); return;
      case 'back': return;
      case 'board': go(deck.length - 1); return;
      case 'share': share(); return;
      case 'left':
        go(index - 1);
        return;
      case 'right': case 'enter': {
        // The board leads back into the story: the next step from the last card is the cover.
        if (card.kind === 'board' && index === deck.length - 1) { go(0); return; }
        // The archetype ceremony is skippable: the first key jumps to its final frame.
        if (card.kind === 'archetype' && caps.motion && !revealDone((now - enteredAt) * CARD_SPEED)) {
          enteredAt = now - T.settle / CARD_SPEED - 1;
          paint();
          return;
        }
        if (card.kind === 'guess') {
          const state = stateOf(card);
          if (state.guess === undefined) { state.guess = -1; state.guessAt = (now - enteredAt) * CARD_SPEED; paint(); return; }
        }
        go(index + 1);
        return;
      }
      default: {
        if (key.startsWith('guess') && card.kind === 'guess') {
          const choice = Number(key.slice(5)) - 1;
          const state = stateOf(card);
          if (state.guess === undefined && choice < card.data.options.length) { state.guess = choice; state.guessAt = (now - enteredAt) * CARD_SPEED; paint(); }
        }
      }
    }
  };
  stdin.on('data', onData);

  function share(): void {
    try {
      const svg = storyShareSvg(view.snapshot);
      if (!svg) { flash('nothing to share yet'); return; }
      const dir = options.shareDir ?? process.cwd();
      // Exclusive create, moving to the next free name if someone (or another run) got there first.
      let file = '';
      for (let n = 1; n < 100 && !file; n++) {
        const candidate = path.join(dir, n === 1 ? 'slopie-wrapped.svg' : `slopie-wrapped-${n}.svg`);
        try { fs.writeFileSync(candidate, svg, { flag: 'wx', mode: 0o644 }); file = candidate; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!file) { flash('too many slopie-wrapped files here already'); return; }
      flash(`saved ${path.basename(file)} · no project names, none of your words`, 2600);
    } catch (error) {
      flash(`couldn't save: ${error instanceof Error ? sanitize(error.message).slice(0, 60) : 'unknown error'}`);
    }
  }

  const onResize = () => {
    renderer.invalidate();
    needsClear = true;
    paint();
  };
  stdout.on('resize', onResize);

  /* ── lifecycle ── */
  function stop(): void {
    if (stopping) return;
    stopping = true;
    if (!settled || queue.length) {
      reason = 'cancelled';
      session.cancel();
    }
    queue.length = 0;
    resolveDone();
  }

  paint();

  const scan = Promise.resolve()
    .then(() => session.run(publish))
    .then(
      final => {
        settled = true;
        if (!view.revoked) view = { ...view, snapshot: final.snapshotId === view.snapshot.snapshotId && final.sequence >= view.snapshot.sequence ? final : view.snapshot };
      },
      () => {
        settled = true;
        const snapshot = view.snapshot;
        view = { ...view, snapshot: { ...snapshot, status: stopping ? 'cancelled' : 'error', launch: snapshot.launch ? { ...snapshot.launch, stage: 'ready' } : undefined } };
      },
    )
    .then(() => schedule());

  try {
    await done;
  } finally {
    for (const timer of [scheduled, toastTimer, bannerTimer, inputTimer]) if (timer) clearTimeout(timer);
    if (ticker) clearInterval(ticker);
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    restore();
    process.off('exit', restore);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
  }
  if (!settled) session.cancel();
  await Promise.race([scan, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
  return { snapshot: view.revoked ?? view.snapshot, reason };
}

