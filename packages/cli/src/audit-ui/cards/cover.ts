/**
 * The cover: the archetype as a redacted shape (its real word lengths, at the display face's
 * footprint, unlocked at the end) and three hero numbers on a column grid divided by hairlines.
 */
import type { CoverData } from '../story/deck.js';
import type { Rect } from '../gfx/draw.js';
import { displayHeight, displayWidth, drawDisplay, fitDisplay, type DisplayOptions } from '../theme/display.js';
import { fade, heroScale, textWidth, txt, type K } from '../theme/kit.js';
import { mix } from '../gfx/color.js';
import { fadeIn } from '../theme/tokens.js';

const TIER: Record<string, string> = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

export function coverBody(k: K, data: CoverData, r: Rect): void {
  const { tk, L } = k;
  // Hero numbers: one setting for all three, the richest that fits every column.
  const nums = data.numbers;
  const cols = Math.max(1, nums.length);
  const colW = Math.floor((r.w + 3) / cols);
  const base: DisplayOptions = { face: tk.face, tall: L && r.h >= 20, currency: tk.accentHi, scale: heroScale(k) };
  const widest = nums.reduce((a, n) => (n.value.length > a.length ? n.value : a), '');
  const fit = k.uni && nums.length ? fitDisplay(widest, colW - 4, base) : null;
  const opts = fit && nums.every(n => fitDisplay(n.value, colW - 4, fit)) ? fit : null;
  const numH = opts ? displayHeight(opts) + 2 : 2;

  // The locked title: one ghost bar per word, as long as the word in the display face.
  const letter = 7;
  const silW = data.words.reduce((a, n) => a + n * letter, 0) + (data.words.length - 1) * 3;
  const silBig = k.uni && silW <= r.w && r.h >= numH + 9;
  const silH = silBig ? 3 : 1;

  const block = 2 + silH + (L ? 4 : 2) + numH;
  let y = r.y + Math.max(0, Math.floor((r.h - block) / 2));

  const a1 = fade(k, 300, 500);
  let x = r.x + txt(k, r.x, y, 'ARCHETYPE', tk.text3, { a: a1 });
  const dot = k.uni ? ' · ' : ' - ';
  if (data.tier) {
    x += txt(k, x, y, dot, tk.text3, { a: a1 });
    x += txt(k, x, y, TIER[data.tier]!.toUpperCase(), tk.accentHi, { bold: true, a: a1 });
  }
  txt(k, x, y, dot + 'LOCKED', tk.text3, { a: a1 });
  y += 2;
  x = r.x;
  // A slow accent shimmer sweeps across one bar at a time (the first few seconds only).
  const t = k.s.caps.motion ? k.s.t : Infinity;
  const sweep = t < 2800 ? t / 2800 : -1;
  if (sweep >= 0 && k.s.caps.motion) k.busy = true;
  data.words.forEach((n, wi) => {
    const w = silBig ? n * letter - 2 : n;
    const la = fade(k, 380 + wi * 120, 420);
    for (let yy = 0; yy < silH; yy++) for (let xx = 0; xx < w; xx++) {
      const pos = (x + xx - r.x) / Math.max(1, silW);
      const glow = sweep >= 0 && wi === 0 ? Math.max(0, 1 - Math.abs(pos - sweep) * 8) : wi === 0 ? 0.35 : 0;
      k.c.put(x + xx, y + yy, k.uni ? '█' : '#', fadeIn(tk, mix(tk.accentLo, tk.accent, glow), la), tk.bg, 0);
    }
    x += w + (silBig ? 3 : 1);
  });
  y += silH + (L ? 4 : 2);

  // Justified across the width: equal wide gaps between the three numbers.
  const widths = nums.map(n => Math.max(opts ? displayWidth(n.value, opts) : textWidth(n.value), textWidth(n.label)));
  const gapW = nums.length > 1 ? Math.max(3, Math.floor((r.w - widths.reduce((a, b) => a + b, 0)) / (nums.length - 1))) : 0;
  let nx = r.x;
  nums.forEach((n, i) => {
    const cx = nx;
    nx += widths[i]! + gapW;
    const a = fade(k, 700 + i * 140, 420);
    if (opts) {
      drawDisplay(k.c, cx, y, n.value, fadeIn(tk, tk.text, a), tk.bg, opts);
      txt(k, cx, y + displayHeight(opts) + 1, n.label.toUpperCase(), tk.text3, { a });
    } else {
      txt(k, cx, y, n.value, tk.text, { bold: true, a });
      txt(k, cx, y + 1, n.label.toUpperCase(), tk.text3, { a });
    }
  });
}
