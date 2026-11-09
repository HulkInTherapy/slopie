/** Writes each plugin's skills/slopie-memory/SKILL.md from the product's own note (the text `slopie setup` installs). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { skillText } from '../packages/cli/src/commands/setup.js';

const repo = path.resolve(import.meta.dirname, '..');
for (const plugin of ['claude-code', 'codex']) {
  const dir = path.join(repo, 'plugins', plugin, 'skills', 'slopie-memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), skillText('~/.slopie/records'));
  console.log(`  ${path.relative(repo, dir)}/SKILL.md`);
}
