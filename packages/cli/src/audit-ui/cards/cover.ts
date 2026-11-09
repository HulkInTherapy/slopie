/**
 * The cover: the archetype as a redacted shape (its real word lengths, at the display face's
 * footprint, unlocked at the end) and three hero numbers on a column grid divided by hairlines.
 */
import type { CoverData } from '../story/deck.js';
import type { Rect } from '../gfx/draw.js';
import { displayHeight, drawDisplay, fitDisplay, type DisplayOptions } from '../theme/display.js';
import { fade, txt, vrule, type K } from '../theme/kit.js';
import { fadeIn } from '../theme/tokens.js';

const TIER: Record<string, string> = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

export function coverBody(k: K, data: CoverData, r: Rect): void {
  const { tk, L } = k;
  // Hero numbers: one setting for all three, the richest that fits every column.
  const nums = data.numbers;
  const cols = Math.max(1, nums.length);
  const colW = Math.floor((r.w + 3) / cols);
  const base: DisplayOptions = { face: tk.face, tall: L && r.h >= 20, currency: tk.text2 };
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
  let x = r.x + txt(k, r.x, y, 'Archetype', tk.text3, { a: a1 }) + 2;
  if (data.tier) {
    x += txt(k, x, y, TIER[data.tier]!, tk.accent, { bold: true, a: a1 });
    txt(k, x, y, ' · unlocks at the end', tk.text3, { a: a1 });
  } else txt(k, x, y, 'unlocks at the end', tk.text3, { a: a1 });
  y += 2;
  x = r.x;
  data.words.forEach((n, wi) => {
    const w = silBig ? n * letter - 2 : n;
    const la = fade(k, 380 + wi * 120, 420);
    for (let yy = 0; yy < silH; yy++) for (let xx = 0; xx < w; xx++) k.c.put(x + xx, y + yy, k.uni ? '█' : '#', fadeIn(tk, tk.ghost, la), tk.bg, 0);
    x += w + (silBig ? 3 : 1);
  });
  y += silH + (L ? 4 : 2);

  nums.forEach((n, i) => {
    const cx = r.x + i * colW;
    const a = fade(k, 700 + i * 140, 420);
    if (i) vrule(k, cx - 3, y, numH, a);
    if (opts) {
      drawDisplay(k.c, cx, y, n.value, fadeIn(tk, tk.text, a), tk.bg, opts);
      txt(k, cx, y + displayHeight(opts) + 1, cap(n.label), tk.text2, { a });
    } else {
      txt(k, cx, y, n.value, tk.text, { bold: true, a });
      txt(k, cx, y + 1, cap(n.label), tk.text2, { a });
    }
  });
}
