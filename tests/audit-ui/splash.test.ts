import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS launcher module
import { FIRST_CAPTION as SPLASH_CAPTION, PRIVACY_LINE as SPLASH_PRIVACY, SPLASH_PALETTE, splashGeometry, splashRuns } from '../../packages/cli/bin/audit-splash.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C, hex, to256 } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { FIRST_CAPTION, LoadingStory, PRIVACY_LINE, loadingGeometry, type LoadingModel } from '../../packages/cli/src/audit-ui/loading.js';

const empty: LoadingModel = { rows: [], counts: { messages: null, chats: null, prompts: null }, stage: 'discovering', progress: 0, ready: false, failure: null, fromDetail: true };

describe('instant splash', () => {
  it('uses the same geometry, palette and words as the loading screen', () => {
    for (const [w, h] of [[120, 40], [100, 30], [80, 24], [60, 20], [200, 60]]) expect(splashGeometry(w, h)).toEqual(loadingGeometry(w, h));
    expect(SPLASH_CAPTION).toBe(FIRST_CAPTION);
    expect(SPLASH_PRIVACY).toBe(PRIVACY_LINE);
    for (const tone of ['bg', 'text', 'text2', 'text3', 'rule', 'accent'] as const) {
      const [hexValue, index] = SPLASH_PALETTE[tone] as [string, number];
      expect(hexValue).toBe(hex(C[tone]).toLowerCase());
      expect(index).toBe(to256(C[tone]));
    }
  });

  it('draws exactly what the loading screen\'s first frame draws, in the same tones', () => {
    for (const [w, h] of [[120, 40], [100, 30], [80, 24], [60, 20]]) {
      const c = new Canvas(w, h, C.bg);
      new LoadingStory(0).render(c, empty, 0, { color: 'truecolor', motion: true, unicode: true }, false);
      for (const run of splashRuns(w, h) as { x: number; y: number; text: string; tone: keyof typeof C; bold?: boolean }[]) {
        expect(c.row(run.y).slice(run.x, run.x + run.text.length), `${w}×${h} "${run.text}"`).toBe(run.text);
        expect(hex(c.fg[run.y * w + run.x]!), `${w}×${h} tone of "${run.text}"`).toBe(hex(C[run.tone]));
      }
    }
  });
});
