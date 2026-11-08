/** The teaser cover: the archetype as a locked silhouette with a rarity glow, plus three headline numbers. */
import { C, fade, hx, mix } from '../gfx/color.js';
import { box, spaced, textCenter, textWidth, type Rect } from '../gfx/draw.js';
import { bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { easeOutBack, easeOutCubic, seg } from '../gfx/motion.js';
import type { CoverData } from '../story/deck.js';
import type { Scene } from './scene.js';

const GOLD = hx('ffd27a');

export function coverBody(s: Scene, data: CoverData, r: Rect): boolean {
  const { c, t } = s;
  let busy = t < 1600;
  const glowColor = data.tier === 'legendary' ? GOLD : data.tier === 'epic' ? C.orange : data.tier === 'rare' ? C.peach : C.slate;
  // Silhouette: one ▓ block per letter (3 cells wide in the block font), word gaps kept.
  const big = s.tier.id !== 'S' && s.caps.unicode;
  const letterW = big ? 4 : 1;
  const silW = data.words.reduce((a, n) => a + n * letterW, 0) + (data.words.length - 1) * (big ? 2 : 1);
  const width = Math.min(r.w, silW + 8);
  const h = big ? 7 : 3;
  const x0 = r.x + Math.max(0, Math.floor((r.w - width) / 2));
  const total = h + 3 + (big ? 5 : 2);
  const y0 = r.y + Math.max(0, Math.floor((r.h - total) / 2) - 1);
  const pulse = s.caps.motion ? 0.55 + 0.45 * Math.sin(Math.min(t, 1600) / 1600 * Math.PI * 2.5) : 1;
  const a = seg(t, 100, 400, easeOutCubic);
  box(c, { x: x0, y: y0, w: width, h }, fade(mix(C.coal, glowColor, pulse), a), { rounded: false, ascii: !s.caps.unicode });
  let x = x0 + 4;
  const rows = big ? 3 : 1;
  const sy = y0 + Math.floor((h - rows) / 2);
  data.words.forEach((n, wi) => {
    for (let i = 0; i < n; i++) {
      const k = seg(t, 200 + (wi * 4 + i) * 35, 200);
      for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < letterW - (big ? 1 : 0); xx++) c.put(x + xx, sy + yy, s.caps.unicode ? '▓' : '#', fade(mix(C.coal, glowColor, 0.25), k));
      x += letterW;
    }
    x += big ? 2 : 1;
  });
  const label = data.tier ? `${data.tier.toUpperCase()} · LOCKED` : 'LOCKED';
  const la = seg(t, 700, 300);
  textCenter(c, x0 + width / 2, y0 + h, ` ${s.caps.unicode ? '◆' : '*'} ${label} `, { fg: glowColor, bold: true, alpha: la });
  // Three headline numbers.
  const ny = y0 + h + 3;
  if (ny + 4 <= r.y + r.h && data.numbers.length) {
    const n = data.numbers.length;
    const colW = Math.floor(r.w / n);
    data.numbers.forEach((num, i) => {
      const k = seg(t, 600 + i * 180, 450, easeOutBack);
      busy ||= k < 1;
      const cx = r.x + colW * i + colW / 2;
      const pixel = s.caps.color !== 'none' && s.caps.unicode && bigSupported(num.value) && bigWidth(num.value) <= colW - 2 && s.tier.id !== 'S';
      if (pixel) {
        const w = bigWidth(num.value);
        drawBig(c, Math.round(cx - w / 2), ny, num.value, { color: (_x, py) => fade(mix(C.cream, C.orange, py / 4), Math.min(1, k)), dy: () => Math.round((1 - Math.min(1, k)) * 2) });
        textCenter(c, cx, ny + 4, s.tier.id === 'L' ? spaced(num.label) : num.label.toUpperCase(), { fg: C.gray, alpha: Math.min(1, k) });
      } else {
        textCenter(c, cx, ny, num.value, { fg: C.orange, bold: true, alpha: Math.min(1, k) });
        textCenter(c, cx, ny + 1, num.label, { fg: C.gray, alpha: Math.min(1, k) });
      }
    });
  }
  void textWidth;
  return busy;
}
