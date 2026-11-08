import { describe, expect, it } from 'vitest';
import type { AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { shareCanvas } from '../../packages/cli/src/audit-ui/share.js';
import { priciestPerPrompt, tenths } from '../../packages/cli/src/audit-ui/story/board-data.js';
import { buildDeck } from '../../packages/cli/src/audit-ui/story/deck.js';
import { wentOnline } from '../../packages/cli/src/audit-ui/story/source.js';
import { InputParser } from '../../packages/cli/src/audit-ui/terminal.js';
import { readySnapshot } from './fixture.js';
import { storySnapshot } from './story-fixture.js';

type Color = 'truecolor' | '256' | '16' | 'none';

function boardText(snapshot: AuditSnapshot, w: number, h: number, opts: { color?: Color; ascii?: boolean; online?: boolean } = {}) {
  const deck = buildDeck(snapshot);
  const board = deck.at(-1)!;
  const c = new Canvas(w, h, C.ink);
  renderCard({ c, w, h, t: Infinity, tier: tierFor(w, h)!, caps: { color: opts.color ?? 'truecolor', motion: false, unicode: !opts.ascii }, blink: false, state: {}, index: deck.length - 1, total: deck.length, online: opts.online }, board);
  return c.toText();
}

const lineWith = (text: string, needle: string) => text.split('\n').find(line => line.includes(needle)) ?? '';
const SIZES = [[120, 40], [100, 30], [80, 24]] as const;
const VARIANTS = ['A', 'B', 'C'] as const;

function withVariant<T>(v: string, fn: () => T): T {
  const prior = process.env['SLOPIE_BOARD_VARIANT'];
  process.env['SLOPIE_BOARD_VARIANT'] = v;
  try { return fn(); } finally { if (prior === undefined) delete process.env['SLOPIE_BOARD_VARIANT']; else process.env['SLOPIE_BOARD_VARIANT'] = prior; }
}

function withoutV19(): AuditSnapshot {
  const snapshot = storySnapshot();
  const story = (snapshot.launch as unknown as { story: Record<string, unknown> }).story;
  delete story['spend'];
  delete story['modelShare'];
  delete (story['totals'] as Record<string, unknown>)['automatedRuns'];
  return snapshot;
}

describe('final board (personality poster)', () => {
  for (const [w, h] of SIZES) {
    it(`fits ${w}×${h} with no truncation: whole facts or none`, () => {
      for (const v of VARIANTS) {
        const text = withVariant(v, () => boardText(storySnapshot(), w, h));
        const rows = text.split('\n');
        expect(rows.length, `${v} ${w}×${h}`).toBeLessThanOrEqual(h);
        for (const row of rows) expect([...row].length).toBeLessThanOrEqual(w);
        expect(text, `variant ${v} at ${w}×${h}`).not.toContain('…');
        expect(text).not.toMatch(/\w\.\.\.(?!\.)/); // no ASCII ellipsis either (dot leaders start after a space)
        expect(text).toContain('npx slopie audit');
      }
      const text = boardText(storySnapshot(), w, h);
      // The default poster keeps the hero numbers and at least four whole fun facts.
      expect(text).toContain('at API prices');
      expect(text).toMatch(/\bprompts\b/);
      const shown = ['6 f-bombs per thank-you', 'swearing went 2.6% → 23%', '$412, 330× your median prompt', '7.5h without a real break', 'you call it “buddy” ×37', 'GPT-6 Sol gets 1.9× your swearing']
        .filter(line => text.includes(line));
      expect(shown.length, `facts at ${w}×${h}`).toBeGreaterThanOrEqual(4);
      // The clutter is gone.
      for (const gone of ['SPEND', 'recovered', 'per active day', 'this month', 'MODELS', 'AGENTS', 'YOUR WORK', 'lantern-api', 'Mon ', 'AWARDS']) expect(text).not.toContain(gone);
      expect(text).not.toMatch(/\$0\b/);
    });
  }

  it('the 120×40 hero poster shows the badge, tagline, three numbers, six facts and trophies', () => {
    const text = boardText(storySnapshot(), 120, 40);
    expect(text).toContain('★ EPIC ★');
    expect(text).toContain('dishwasher');
    for (const label of ['MANNERS', 'CHARACTER ARC', 'PRICIEST SENTENCE', 'LONGEST SIT', 'PET NAME', 'NEMESIS']) expect(text).toContain(label);
    // Trophies never repeat a fact already on the poster (priciest sentence, marathon, pet name).
    expect(text).toContain('Worst day');
    expect(text).not.toContain('Priciest sentence');
    expect(text).toContain('slopie remembers → slopie setup');
  });

  it('hides any hero number the snapshot does not have (never a zero)', () => {
    const old = boardText(withoutV19(), 120, 40);
    expect(old).toContain('at API prices'); // legacy single total still known
    const snapshot = storySnapshot();
    const story = (snapshot.launch as unknown as { story: { totals: { activeDays: number } } }).story;
    story.totals.activeDays = 0;
    const board = buildDeck(snapshot).at(-1)!;
    if (board.kind !== 'board') throw new Error('no board');
    expect(board.data.heroes.map(x => x.label)).toEqual(['at API prices', 'prompts']);
    expect(boardText(snapshot, 120, 40)).not.toMatch(/(^|\s)0\s/);
  });

  it('degrades to the 1.7.x facts without a story', () => {
    const text = boardText(readySnapshot(), 120, 40);
    expect(text).toContain('npx slopie audit');
    expect(text).not.toContain('…');
  });

  it('keeps 16-colour and ASCII posters legible', () => {
    const sixteen = boardText(storySnapshot(), 120, 40, { color: '16' });
    expect(sixteen).toContain('6 f-bombs per thank-you');
    const ascii = boardText(storySnapshot(), 120, 40, { ascii: true, color: 'none' });
    expect(ascii).toContain('T H E   N I G H T   S H I F T');
    expect(ascii).toContain('6 f-bombs per thank-you');
    expect(ascii).not.toContain('…');
  });

  it('says "all local" only when nothing could have left the machine', () => {
    expect(boardText(storySnapshot(), 120, 40)).toContain('all local');
    expect(boardText(storySnapshot(), 120, 40, { online: true })).toContain('online · Jev');
    const snapshot = storySnapshot();
    const story = (snapshot.launch as unknown as { story: { enrichment: { state: string; quotesSent: number; model: string | null } } }).story;
    expect(wentOnline(snapshot)).toBe(false);
    story.enrichment = { ...story.enrichment, state: 'complete', quotesSent: 2, model: 'jev' };
    expect(wentOnline(snapshot)).toBe(true);
    expect(wentOnline(storySnapshot(), 1)).toBe(true);
    const share = shareCanvas(snapshot)!.toText();
    expect(share).toContain('online · Jev');
  });

  it('share card: same poster, public-safe (no project names, no prompt text beyond catchphrase / pet name)', () => {
    const text = shareCanvas(storySnapshot())!.toText();
    const board = boardText(storySnapshot(), 120, 40);
    for (const secret of ['lantern-api', 'tidepool', 'paper-boats', 'pocket-garden', 'keep going', 'sync layer', 'leave the tests']) expect(text).not.toContain(secret);
    expect(text).toContain('npx slopie audit');
    expect(text).toContain('all local');
    expect(text).not.toContain('…');
    // Same layout: the facts on the board are the facts on the card.
    for (const line of ['6 f-bombs per thank-you', 'GPT-6 Sol gets 1.9× your swearing', 'you call it “buddy” ×37']) {
      expect(board).toContain(line);
      expect(text).toContain(line);
    }
    expect(text).not.toContain('q quit');
  });

  it('share card drops a tagline that quotes the user (other than catchphrase / pet name)', () => {
    const snapshot = storySnapshot();
    const story = (snapshot.launch as unknown as { story: { archetype: { tagline: string } } }).story;
    story.archetype.tagline = "'keep going' ×64. a manager in one word.";
    expect(shareCanvas(snapshot)!.toText()).not.toContain('keep going');
    expect(boardText(snapshot, 120, 40)).toContain('keep going');
  });

  it('largest-remainder shares sum to exactly 100.0', () => {
    for (const values of [[1, 1, 1], [0.335, 0.335, 0.33], [98, 1.9, 0.1], [5, 0, 7]]) {
      const shares = tenths(values);
      expect(Math.round(shares.reduce((a, b) => a + b, 0) * 10)).toBe(1000);
    }
  });

  it('"$ priciest" is cost per prompt among real models, not the volume leader', () => {
    const rows = [
      { label: 'Claude Opus 5', usd: 3076.4, prompts: 1240 },
      { label: 'GPT-6 Sol', usd: 1340.2, prompts: 410 },
      { label: 'Claude Fable 5', usd: 1182.6, prompts: 480 },
      { label: 'Claude Haiku 4.5', usd: 104, prompts: 31 }, // pricier per prompt, but only 1% of prompts
    ];
    expect(priciestPerPrompt(rows)?.label).toBe('GPT-6 Sol');
    expect(priciestPerPrompt(rows.slice(0, 1))).toBeNull();
    const board = buildDeck(storySnapshot()).at(-1)!;
    if (board.kind !== 'board') throw new Error('no board');
    const tagged = board.data.models!.rows.filter(r => r.tags?.includes('priciest')).map(r => r.label);
    expect(tagged).toEqual(['GPT-6 Sol']);
    expect(board.data.models!.facts[0]).toBe('$ priciest: GPT-6 Sol, $3.27/prompt');
  });
});

describe('input parser', () => {
  const run = (chunks: string[]) => {
    const keys: string[] = [];
    const parser = new InputParser(token => keys.push(token));
    for (const chunk of chunks) parser.feed(chunk);
    parser.flush();
    return keys;
  };

  it('ignores keys inside a bracketed paste whose delimiters are split across chunks', () => {
    expect(run(['\x1b[20', '0~', 'q', '\x1b[201~'])).toEqual([]);
    const text = '\x1b[200~qqq b s\x1b[201~';
    for (let i = 1; i < text.length; i++) expect(run([text.slice(0, i), text.slice(i)])).toEqual([]);
    expect(run([...text])).toEqual([]);
  });

  it('decodes arrows split at every byte and keeps keys around a paste', () => {
    expect(run(['\x1b', '[', 'C'])).toEqual(['\x1b[C']);
    expect(run(['l\x1b[200~q\x1b[2', '01~h'])).toEqual(['l', 'h']);
    expect(run(['\x1b'])).toEqual(['\x1b']);
  });
});
