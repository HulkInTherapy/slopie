/**
 * Render the final board (any variant, any size) straight to ANSI for headless captures, without a pty.
 * `tsx render-board.ts out.ansi [variant A|B|C|M1|M2|M3] [cols] [rows] [share] [t ms|Infinity] [title] [tier] [subRole]`
 * A finite `t` renders that frame of the entry animation (motion on); Infinity is the static frame.
 */
import fs from 'node:fs';
import { renderCard } from '../../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C, hex } from '../../../packages/cli/src/audit-ui/gfx/color.js';
import { buildDeck } from '../../../packages/cli/src/audit-ui/story/deck.js';
import { storySnapshot } from '../story-fixture.js';

const [out = 'board.ansi', variant = 'M1', cols = '120', rows = '40', share = '', time = 'Infinity', title = '', tier = '', subRole = ''] = process.argv.slice(2);
process.env['SLOPIE_BOARD_VARIANT'] = variant;
const w = Number(cols), h = Number(rows);
const snapshot = storySnapshot();
const story = (snapshot.launch as unknown as { story: { archetype: { title: string; rarity: string; subRole: unknown; tagline: string } } }).story;
if (title) story.archetype.title = title;
if (tier) story.archetype.rarity = tier;
if (subRole === 'none') story.archetype.subRole = null;
else if (subRole) story.archetype.subRole = { id: 'x', title: subRole, label: `with a streak of ${subRole}` };
const deck = buildDeck(snapshot);
const board = deck.at(-1)!;
const c = new Canvas(w, h, C.ink);
c.fill(0, 0, w, h, ' ', { bg: C.ink });
const t = Number(time);
renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color: 'truecolor', motion: Number.isFinite(t), unicode: true }, blink: false, state: {}, index: deck.length - 1, total: deck.length, share: share === 'share' }, board);
const rgb = (v: number) => { const x = hex(v).slice(1); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)).join(';'); };
let ansi = '\x1b[2J\x1b[H';
for (let y = 0; y < h; y++) {
  ansi += `\x1b[${y + 1};1H`;
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const ch = c.ch[i]!;
    if (ch === '') continue;
    const fg = c.fg[i]!, bg = c.bg[i]!, at = c.at[i]!;
    ansi += `\x1b[0${at & 1 ? ';1' : ''}${at & 4 ? ';3' : ''}${fg >= 0 ? ';38;2;' + rgb(fg) : ''}${bg >= 0 ? ';48;2;' + rgb(bg) : ''}m${ch}`;
  }
}
fs.writeFileSync(out, ansi + '\x1b[0m');
console.log(c.toText());
