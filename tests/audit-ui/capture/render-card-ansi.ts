/**
 * Render any deck card of the SYNTHETIC fixture to ANSI (truecolor, 256, 16 or none) for headless captures.
 * `tsx render-card-ansi.ts <kind|id> out.ansi [cols] [rows] [truecolor|256|16|none] [t ms|Infinity] [ascii] [share]`
 */
import fs from 'node:fs';
import { renderCard } from '../../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../../packages/cli/src/audit-ui/gfx/color.js';
import { CellRenderer } from '../../../packages/cli/src/audit-ui/gfx/screen.js';
import { buildDeck } from '../../../packages/cli/src/audit-ui/story/deck.js';
import { storySnapshot } from '../story-fixture.js';

const [kind = 'board', out = 'card.ansi', cols = '120', rows = '40', color = 'truecolor', time = 'Infinity', ascii = '', share = ''] = process.argv.slice(2);
const w = Number(cols), h = Number(rows);
const deck = buildDeck(storySnapshot());
const index = deck.findIndex(card => card.kind === kind || card.id === kind);
if (index < 0) throw new Error(`no card ${kind}: ${deck.map(c => c.id).join(', ')}`);
const c = new Canvas(w, h, C.bg);
c.fill(0, 0, w, h, ' ', { bg: C.bg });
const t = Number(time);
const state = kind === 'guess' && process.env.GUESS ? { guess: Number(process.env.GUESS), guessAt: 0 } : {};
renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color: color as 'truecolor', motion: Number.isFinite(t), unicode: ascii !== 'ascii' }, blink: false, state, index, total: deck.length, share: share === 'share' }, deck[index]!);
fs.writeFileSync(out, '\x1b[2J\x1b[H' + new CellRenderer(color as 'truecolor').frame(c, true) + '\x1b[0m');
