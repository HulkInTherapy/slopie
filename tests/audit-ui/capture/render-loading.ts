/**
 * Render the loading screen mid-scan (synthetic progress) to ANSI for headless captures.
 * `tsx render-loading.ts out.ansi [cols] [rows] [truecolor|256|16|none]`
 */
import fs from 'node:fs';
import { Canvas } from '../../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../../packages/cli/src/audit-ui/gfx/color.js';
import { CellRenderer } from '../../../packages/cli/src/audit-ui/gfx/screen.js';
import { LoadingStory, type LoadingModel } from '../../../packages/cli/src/audit-ui/loading.js';

const [out = 'loading.ansi', cols = '120', rows = '40', color = 'truecolor'] = process.argv.slice(2);
const w = Number(cols), h = Number(rows);
const model: LoadingModel = {
  rows: [
    { id: 'claude', name: 'Claude Code', state: 'found', info: '1,904 chats · since Dec 2025', flowing: true },
    { id: 'codex', name: 'Codex', state: 'found', info: '388 chats · since Mar 2026', flowing: true },
    { id: 'pi', name: 'pi', state: 'absent', info: 'not on this machine', flowing: false },
    { id: 'opencode', name: 'OpenCode', state: 'searching', info: 'looking…', flowing: false },
  ],
  counts: { messages: 18203, chats: 2292, prompts: 2904 }, stage: 'reading', progress: 0.62, ready: false, failure: null, fromDetail: true,
};
const c = new Canvas(w, h, C.bg);
new LoadingStory(0).render(c, model, 5000, { color: color as 'truecolor', motion: false, unicode: true }, false);
fs.writeFileSync(out, '\x1b[2J\x1b[H' + new CellRenderer(color as 'truecolor').frame(c, true) + '\x1b[0m');
