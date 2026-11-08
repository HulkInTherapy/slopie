/** Dev helper: render one deck card of the SYNTHETIC story fixture to text. `tsx tests/audit-ui/render-card.ts board 120 40 [t]` */
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { buildDeck } from '../../packages/cli/src/audit-ui/story/deck.js';
import { storySnapshot } from './story-fixture.js';

const [kind = 'board', w = '120', h = '40', t = 'Infinity', color = 'truecolor', ascii = ''] = process.argv.slice(2);
const deck = buildDeck(storySnapshot());
const index = Math.max(0, deck.findIndex(card => card.kind === kind || card.id === kind));
const c = new Canvas(Number(w), Number(h), C.ink);
renderCard({ c, w: Number(w), h: Number(h), t: Number(t), tier: tierFor(Number(w), Number(h))!, caps: { color: color as 'truecolor', motion: true, unicode: !ascii }, blink: false, state: {}, index, total: deck.length }, deck[index]!);
console.log(c.toText().split('\n').map(l => l.padEnd(Number(w)) + '|').join('\n'));
