/** Writes the SYNTHETIC story recording (loading events → rich 1.9 snapshot) for pty captures. `tsx dump-fixture.ts out.json` */
import fs from 'node:fs';
import { buildDeck } from '../../../packages/cli/src/audit-ui/story/deck.js';
import { storyRecording, storySnapshot } from '../story-fixture.js';

const out = process.argv[2] ?? 'slopie-fixture.json';
fs.writeFileSync(out, JSON.stringify(storyRecording()));
fs.writeFileSync(out.replace(/\.json$/, '.kinds.json'), JSON.stringify(buildDeck(storySnapshot()).map(c => c.kind)));
console.log(out);
