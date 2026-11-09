/** The archetype title in the display face: word-wrapped, one tone, with a text fallback. */
import type { Rgb } from '../gfx/color.js';
import { displayHeight, displaySupported, displayWidth, drawDisplay, gapOf } from './display.js';
import { textWidth, txt, type K } from './kit.js';
import { fadeIn, type DisplayFace } from './tokens.js';

export interface TitlePlan { lines: string[]; big: boolean; h: number; w: number; face: DisplayFace }

export function planTitle(k: K, title: string, maxW: number, maxLines: number): TitlePlan {
  // One line in either face beats two lines; the solid face is wide, the heavy stroke face narrow.
  const faces: DisplayFace[] = k.tk.face === 'solid' ? ['solid', 'heavy'] : [k.tk.face];
  if (k.uni && displaySupported(title)) for (let n = 1; n <= maxLines; n++) for (const face of faces) {
    const words = title.toUpperCase().split(/\s+/);
    const lines: string[] = [];
    let line = '';
    let ok = true;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (displayWidth(next, { face }) <= maxW) line = next;
      else { if (line) lines.push(line); line = word; if (displayWidth(word, { face }) > maxW) ok = false; }
    }
    if (line) lines.push(line);
    if (ok && lines.length <= n) {
      const h = lines.length * displayHeight({ face }) + (lines.length - 1);
      return { lines, big: true, h, w: Math.max(...lines.map(l => displayWidth(l, { face }))), face };
    }
  }
  return { lines: [title], big: false, h: 1, w: textWidth(title), face: k.tk.face };
}

/** Word footprints of the plan (for the redacted placeholder). */
export function titleBars(k: K, plan: TitlePlan): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  const face = plan.face;
  plan.lines.forEach((line, li) => {
    const words = line.split(' ');
    words.forEach((word, wi) => {
      const x = !wi ? 0 : plan.big ? displayWidth(words.slice(0, wi).join(' ') + ' ', { face }) + gapOf(face) : textWidth(words.slice(0, wi).join(' ') + ' ');
      const w = plan.big ? displayWidth(word, { face }) : textWidth(word);
      out.push({ x, y: li * (displayHeight({ face }) + 1), w });
    });
  });
  return out;
}

export function drawTitle(k: K, x: number, y: number, plan: TitlePlan, color: Rgb, a = 1): void {
  const face = plan.face;
  const fg = fadeIn(k.tk, color, a);
  if (!plan.big) { txt(k, x, y, plan.lines[0]!, color, { bold: true, a }); return; }
  plan.lines.forEach((line, i) => drawDisplay(k.c, x, y + i * (displayHeight({ face }) + 1), line, fg, k.tk.bg, { face }));
}

/** The locked title: one ghost bar per word, as tall as the set title. */
export function drawGhost(k: K, x: number, y: number, plan: TitlePlan, a = 1): void {
  const rows = plan.big ? displayHeight({ face: plan.face }) : 1;
  const color = fadeIn(k.tk, k.tk.ghost, a);
  for (const b of titleBars(k, plan)) for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < b.w; xx++) k.c.put(x + b.x + xx, y + b.y + yy, k.uni ? '█' : '#', color, k.tk.bg, 0);
}
