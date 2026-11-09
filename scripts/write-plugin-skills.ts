/** Writes each plugin's one skill, skills/slopie/SKILL.md, from the product's own text (what `slopie setup` installs). */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SKILL, skillText } from '../packages/cli/src/commands/setup.js';

const repo = path.resolve(import.meta.dirname, '..');
for (const plugin of ['claude-code', 'codex']) {
  const skills = path.join(repo, 'plugins', plugin, 'skills');
  rmSync(skills, { recursive: true, force: true });
  const dir = path.join(skills, SKILL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), skillText('~/.slopie/records'));
  console.log(`  ${path.relative(repo, dir)}/SKILL.md`);
}
