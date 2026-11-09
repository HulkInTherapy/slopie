/**
 * The final board: a personality poster (see poster.ts). It is the last card and the share
 * image, and draws its own chrome (no story rail).
 */
import type { BoardSummary } from '../story/board-data.js';
import { posterBody } from './poster.js';
import type { Scene } from './scene.js';

export { INSTALL, MEMORY_LINE } from './poster.js';

export function boardBody(s: Scene, data: BoardSummary): boolean {
  return posterBody(s, data);
}
