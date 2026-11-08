import { describe, expect, it } from 'vitest';
import type { AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { shareCanvas } from '../../packages/cli/src/audit-ui/share.js';
import { tenths } from '../../packages/cli/src/audit-ui/story/board-data.js';
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

function withoutV19(): AuditSnapshot {
  const snapshot = storySnapshot();
  const story = (snapshot.launch as unknown as { story: Record<string, unknown> }).story;
  delete story['spend'];
  delete story['modelShare'];
  delete (story['totals'] as Record<string, unknown>)['automatedRuns'];
  return snapshot;
}

describe('final board', () => {
  for (const [w, h] of SIZES) {
    it(`draws every agent row with a bar at ${w}×${h} (0.1% still gets a sliver)`, () => {
      const text = boardText(storySnapshot(), w, h);
      for (const name of ['Claude Code', 'Codex', 'pi ', 'OpenCode']) {
        const line = lineWith(text, name.trim() === 'pi' ? '│ pi ' : name);
        expect(line, `${name} row at ${w}×${h}`).not.toBe('');
        expect(line).toMatch(/[█▏▎▍▌▋▊▉]/);
      }
      expect(lineWith(text, 'OpenCode')).toContain('0.1%');
    });

    it(`fills ${w}×${h} with the spend panel, model bars and the install line`, () => {
      const text = boardText(storySnapshot(), w, h);
      const rows = text.split('\n');
      expect(rows.length).toBeLessThanOrEqual(h);
      for (const row of rows) expect([...row].length).toBeLessThanOrEqual(w);
      expect(text).toContain('SPEND');
      expect(text).toContain('per active day');
      expect(text).toContain('npx slopie audit');
      expect(text).toContain('47.1%');
      expect(text).toMatch(/480 (older )?prompts/);
      // Nothing unknown is drawn as zero.
      expect(text).not.toMatch(/\$0\b/);
    });
  }

  it('shows recovered and estimated money only where the snapshot has them', () => {
    const text = boardText(storySnapshot(), 120, 40);
    expect(text).toContain('+ $455 recovered');
    expect(text).toMatch(/≈ \$410–760 est/);
    const old = boardText(withoutV19(), 120, 40);
    expect(old).not.toContain('recovered');
    expect(old).not.toContain('this month');
    expect(old).not.toContain('per active day');
    expect(old).toContain('SPEND');
  });

  it('degrades to the 1.7.x facts without a story', () => {
    const text = boardText(readySnapshot(), 120, 40);
    expect(text).toContain('Y O U R   Y E A R');
    expect(text).toContain('npx slopie audit');
    expect(text).toContain('Rotor-Notes');
  });

  it('ranks models by output tokens with a favourite, nemesis and priciest tag', () => {
    const text = boardText(storySnapshot(), 120, 40);
    expect(text).toContain('MODELS · output tokens');
    expect(lineWith(text, 'Claude Fable 5')).toContain('♥');
    expect(lineWith(text, 'GPT-6 Sol ')).toContain('☠');
    expect(lineWith(text, 'Claude Opus 5')).toContain('$');
  });

  it('keeps 16-colour and ASCII boards legible (bars never invisible)', () => {
    const sixteen = boardText(storySnapshot(), 120, 40, { color: '16' });
    expect(lineWith(sixteen, 'OpenCode')).toMatch(/[▏▎]/);
    const ascii = boardText(storySnapshot(), 120, 40, { ascii: true, color: 'none' });
    expect(lineWith(ascii, 'OpenCode')).toMatch(/\.\s+0\.1%/);
    expect(lineWith(ascii, 'Claude Code')).toContain('#');
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
    expect(share).not.toContain('nothing left the machine');
    expect(share).toContain('online · Jev');
  });

  it('share card: no project names, no quotes, carries the install line', () => {
    const text = shareCanvas(storySnapshot())!.toText();
    for (const secret of ['lantern-api', 'tidepool', 'paper-boats', 'real quick', 'buddy', 'keep going', 'dishwasher']) expect(text).not.toContain(secret);
    expect(text).toContain('Project A');
    expect(text).toContain('npx slopie audit');
    expect(text).toContain('all local');
  });

  it('largest-remainder shares sum to exactly 100.0', () => {
    for (const values of [[1, 1, 1], [0.335, 0.335, 0.33], [98, 1.9, 0.1], [5, 0, 7]]) {
      const shares = tenths(values);
      expect(Math.round(shares.reduce((a, b) => a + b, 0) * 10)).toBe(1000);
    }
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
