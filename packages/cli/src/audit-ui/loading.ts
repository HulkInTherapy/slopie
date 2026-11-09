/**
 * The loading screen: each coding agent lighting up as it is actually discovered, a large
 * counter ticking toward the engine's running count of prompts, a thin progress line and a
 * caption that follows the real scan stage.
 *
 * Everything shown comes from progress events (`progress.detail`) or, for older engines,
 * from `snapshot.sources`. Nothing is invented: unknown counts are simply not shown.
 */
import type { AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import type { Canvas } from './gfx/canvas.js';
import { C, mix } from './gfx/color.js';
import { textWidth } from './gfx/draw.js';
import { clamp01 } from './gfx/motion.js';
import type { Caps } from './gfx/screen.js';
import { count, monthYear } from './format.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay } from './theme/display.js';
import { progressDetailOf, storyOf } from './story/source.js';
import { boardData, isLoading } from './view-model.js';

export const MIN_STORY_MS = 2400;
const OUTRO_MS = 950;

const ORDER = ['claude', 'codex', 'pi', 'opencode'] as const;
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' };

export interface HarnessRow {
  id: string;
  name: string;
  state: 'searching' | 'found' | 'absent';
  /** Shown after the dot: "1,904 chats · since Dec 2025". */
  info: string;
  /** Messages are still flowing from this agent. */
  flowing: boolean;
}

export interface LoadingModel {
  rows: HarnessRow[];
  counts: { messages: number | null; chats: number | null; prompts: number | null };
  stage: 'discovering' | 'reading' | 'aggregating' | 'detecting' | 'ready';
  progress: number | null;
  ready: boolean;
  failure: string | null;
  /** Rows and counts came from the engine's progress detail (not the 1.7.x fallback). */
  fromDetail: boolean;
}

export function loadingModel(snapshot: AuditSnapshot): LoadingModel {
  const detail = progressDetailOf(snapshot);
  const loading = isLoading(snapshot);
  const board = boardData(snapshot);
  const rows: HarnessRow[] = [];
  for (const id of ORDER) {
    const d = detail?.harnesses.find(h => h.harness === id) as (NonNullable<typeof detail>['harnesses'][number] & { discovered?: boolean; absent?: boolean; chats?: number; prompts?: number }) | undefined;
    const source = snapshot.sources.find(s => s.harness === id);
    if (!d && !source) continue;
    let state: HarnessRow['state'];
    if (d) state = d.absent || (d.discovered !== false && d.files === 0 && (detail!.stage !== 'discovering' || d.discovered)) ? 'absent' : d.discovered === false ? 'searching' : 'found';
    else state = source!.state === 'checking' ? 'searching' : source!.state === 'absent' || source!.state === 'unsupported' ? 'absent' : 'found';
    if (state === 'searching' && !loading) state = source?.state === 'absent' ? 'absent' : 'found';
    let info = '';
    if (state === 'absent') info = 'not on this machine';
    else if (state === 'searching') info = 'looking…';
    else {
      const chats = d?.chats;
      const files = d?.files ?? source?.census?.files ?? source?.candidateFiles ?? null;
      const head = chats ? `${count(chats)} chats` : files ? `${count(files)} files` : 'found';
      const since = d?.firstAt ? ` · since ${monthYear(d.firstAt)}` : '';
      info = head + since;
    }
    const flowing = loading && state === 'found' && (!d || d.filesDone < d.files || detail?.stage === 'discovering');
    rows.push({ id, name: NAMES[id] ?? id, state, info, flowing });
  }
  const totals = storyOf(snapshot)?.totals;
  const counts = {
    messages: detail?.counts.messages ?? null,
    chats: totals?.sessions ?? detail?.counts.chats ?? board.stats.chats,
    prompts: totals?.prompts ?? detail?.counts.prompts ?? board.stats.prompts,
  };
  const stage: LoadingModel['stage'] = !loading ? 'ready'
    : detail ? (detail.stage === 'enriching' || detail.stage === 'ready' ? 'detecting' : detail.stage)
      : board.phase === 'finding' ? 'discovering' : board.phase === 'finishing' ? 'aggregating' : 'reading';
  const progress = detail && detail.counts.files > 0 ? detail.counts.filesDone / detail.counts.files
    : board.progress?.total ? (board.progress.done ?? 0) / board.progress.total : null;
  return { rows, counts, stage, progress: loading ? progress : 1, ready: !loading, failure: board.failure, fromDetail: Boolean(detail) };
}

function caption(model: LoadingModel, shownPrompts: number): string {
  if (model.failure && model.ready) return model.failure;
  switch (model.stage) {
    case 'discovering': return 'finding your agents';
    case 'reading': return shownPrompts > 0 ? `reading ${count(Math.round(shownPrompts))} things you said` : 'reading your history';
    case 'aggregating': return 'counting the money';
    case 'detecting': return 'noticing patterns';
    case 'ready': return 'ok. I know you now.';
  }
}

export const PRIVACY_LINE = 'all local · nothing leaves this machine';
export const FIRST_CAPTION = 'finding your agents';
/** Slots reserved for the agents (the layout never moves as they are found). */
const SLOTS = ORDER.length;

/** Where things sit on the loading screen. Mirrored by bin/audit-splash.js (tested). */
export function loadingGeometry(w: number, h: number) {
  const L = w >= 100 && h >= 30;
  const S = w < 76 || h < 23;
  const mx = L ? 6 : 3;
  const top = L ? 1 : 0;
  const footY = L ? h - 2 : h - 1;
  const rowStep = L ? 2 : 1;
  const numH = L ? 5 : 3;
  // label + gap, the agent rows, gap, the counter and its label + gap, the progress line + gap, the caption.
  const blockH = 2 + SLOTS * rowStep + 1 + numH + 2 + 2 + 1;
  const labelY = Math.max(top + 3, top + 2 + Math.floor((footY - top - 2 - blockH) / 2));
  const rowsY = labelY + 2;
  const numY = rowsY + SLOTS * rowStep + 1;
  const barY = numY + numH + 2;
  const captionY = barY + 2;
  return { L, S, mx, top, footY, rowStep, numH, labelY, rowsY, numY, barY, captionY };
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Stateful (tweened counters, row light-up times); everything else is derived from the model. */
export class LoadingStory {
  private shown = { messages: 0, chats: 0, prompts: 0 };
  private lastCaption = '';
  private captionAt = 0;
  private readyAt: number | null = null;
  private litAt = new Map<string, number>();
  privacyLine = PRIVACY_LINE;

  constructor(private readonly started: number) {}

  /** True once the outro has played and the deck may start. */
  done(now: number): boolean {
    return this.readyAt !== null && now - this.readyAt >= OUTRO_MS && now - this.started >= MIN_STORY_MS;
  }

  /** Data is in and the minimum story time has passed: a key press may skip ahead. */
  skippable(model: LoadingModel, now: number): boolean {
    return model.ready && now - this.started >= 600;
  }

  private lastDetail: LoadingModel | null = null;

  render(c: Canvas, input: LoadingModel, now: number, caps: Caps, blink: boolean): boolean {
    void blink;
    const t = now - this.started;
    // Never regress: a final snapshot without progress detail keeps the rows and counts already shown.
    let model = input;
    if (input.fromDetail) this.lastDetail = input;
    else if (this.lastDetail) {
      const last = this.lastDetail;
      model = {
        ...input,
        rows: last.rows.map(row => ({ ...row, flowing: false, state: row.state === 'searching' ? 'found' : row.state })),
        counts: { messages: last.counts.messages, chats: input.counts.chats ?? last.counts.chats, prompts: input.counts.prompts ?? last.counts.prompts },
      };
    }
    const { w, h } = c;
    const motion = caps.motion;
    const uni = caps.unicode;
    if (model.ready && this.readyAt === null && (t >= MIN_STORY_MS - OUTRO_MS || !motion)) this.readyAt = now;
    let busy = false;

    // Tween the counters.
    const k = motion ? 0.22 : 1;
    for (const key of ['messages', 'chats', 'prompts'] as const) {
      const target = model.counts[key] ?? 0;
      this.shown[key] += (target - this.shown[key]) * k;
      if (Math.abs(target - this.shown[key]) < 0.5) this.shown[key] = target;
      if (this.shown[key] !== target) busy = true;
    }

    const g = loadingGeometry(w, h);
    const iw = w - g.mx * 2;
    const put = (x: number, y: number, text: string, fg: number, bold = false, italic = false) => c.text(x, y, text, { fg, bg: C.bg, bold, italic });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c.put(x, y, ' ', C.text, C.bg, 0);

    // Header: the wordmark and a hairline (the progress line lives lower down).
    put(g.mx, g.top, 'slopie', C.text, true);
    put(g.mx + 7, g.top, 'audit', C.text3);
    for (let x = 0; x < iw; x++) c.put(g.mx + x, g.top + 1, uni ? '─' : '-', C.rule, C.bg, 0);
    put(g.mx, g.labelY, 'YOUR AGENTS', C.text3);

    // Agent rows: a status dot, the name, what was found.
    const nameW = 14;
    model.rows.slice(0, SLOTS).forEach((row, i) => {
      const y = g.rowsY + i * g.rowStep;
      if (row.state !== 'searching' && !this.litAt.has(row.id)) this.litAt.set(row.id, now);
      const lit = this.litAt.get(row.id);
      const a = lit === undefined ? 1 : motion ? clamp01((now - lit) / 350) : 1;
      if (a < 1) busy = true;
      let dot: string, dotColor: number;
      if (row.state === 'found') { dot = uni ? '●' : '*'; dotColor = mix(C.text3, C.text, a); }
      else if (row.state === 'absent') { dot = uni ? '○' : 'o'; dotColor = C.text3; }
      else { dot = uni ? SPIN[Math.floor(t / 90) % SPIN.length]! : '-'; dotColor = C.text2; busy = true; }
      put(g.mx, y, dot, dotColor);
      put(g.mx + 2, y, row.name, row.state === 'found' ? mix(C.text2, C.text, a) : C.text3, row.state === 'found');
      c.text(g.mx + 2 + nameW, y, row.info, { fg: row.state === 'found' ? C.text2 : C.text3, bg: C.bg, italic: row.state === 'absent' }, w - g.mx * 2 - nameW - 2);
    });

    // The counter: prompts (or the first count the engine has), large; the others beside its label.
    const counters: [number | null, number, string][] = [
      [model.counts.prompts, this.shown.prompts, 'prompts'],
      [model.counts.messages, this.shown.messages, 'messages'],
      [model.counts.chats, this.shown.chats, 'chats'],
    ];
    const known = counters.filter(([v]) => v !== null && v > 0);
    if (known.length) {
      const [, shown, label] = known[0]!;
      const text = count(Math.round(shown));
      const final = count(Math.round(known[0]![0]!));
      const opts = uni ? fitDisplay(final, iw, { face: 'solid', tall: g.L }) : null;
      if (opts && displayHeight(opts) <= g.numH) drawDisplay(c, g.mx, g.numY + (g.numH - displayHeight(opts)), text, C.text, C.bg, opts);
      else put(g.mx, g.numY + g.numH - 1, text, C.text, true);
      let x = g.mx + put(g.mx, g.numY + g.numH, label, C.text2);
      for (const [, v, l] of known.slice(1)) {
        const part = `${count(Math.round(v))} ${l}`;
        if (x + 5 + textWidth(part) > g.mx + iw) break;
        x += put(x, g.numY + g.numH, '  ·  ', C.text3);
        x += put(x, g.numY + g.numH, count(Math.round(v)), C.text) + put(x + textWidth(count(Math.round(v))), g.numY + g.numH, ` ${l}`, C.text2);
      }
      void displayWidth;
    }

    // Progress: a thin line, determinate when the engine knows the total.
    const barW = Math.min(64, iw);
    const p = model.ready ? 1 : model.progress;
    for (let i = 0; i < barW; i++) {
      const filled = p !== null && i < Math.round(barW * p);
      // Indeterminate: a short segment travels along the line.
      const head = p === null && motion ? Math.abs(((t / 22) % (barW + 12)) - 6 - i) < 6 : false;
      c.put(g.mx + i, g.barY, uni ? (filled || head ? '━' : '─') : filled || head ? '=' : '-', filled ? C.accent : head ? C.text3 : C.rule, C.bg, 0);
    }
    if (p === null) busy = true;

    // Caption (crossfades on stage change).
    const text = caption(model, this.shown.prompts);
    if (text !== this.lastCaption) { this.lastCaption = text; this.captionAt = now; }
    const ca = motion && this.lastCaption !== FIRST_CAPTION ? clamp01((now - this.captionAt) / 260) : 1;
    if (ca < 1) busy = true;
    c.text(g.mx, g.captionY, text, { fg: mix(C.bg, model.ready && !model.failure ? C.text : C.text2, ca), bg: C.bg, bold: model.ready && !model.failure }, iw);

    // Privacy promise, always visible.
    put(g.mx, g.footY, uni ? '●' : '*', C.accent);
    put(g.mx + 2, g.footY, this.privacyLine, C.text3);

    if (model.ready && !this.done(now)) busy = true;
    return busy;
  }
}
