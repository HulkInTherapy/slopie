import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });

// @potsherd/core is bundled in rather than published separately: one npm
// package means `npx potsherd audit` resolves one thing.
//
// External only if it cannot be bundled: better-sqlite3 is a native addon, loaded lazily (the search index
// falls back to node:sqlite without it). Everything else, commander included, is bundled, so the bundle runs
// beside an empty node_modules (a plugin install is a git clone with no install step).
const external = ['better-sqlite3'];

const targets = [
  { in: 'src/index.ts', out: 'dist/potsherd.js' },
  { in: 'src/audit-native-worker.ts', out: 'dist/audit-native-worker.js' },
  { in: 'src/records-worker.ts', out: 'dist/records-worker.js' },
];

for (const t of targets) {
  await build({
    // Stable source labels and wrapper keys regardless of the caller's cwd.
    absWorkingDir: path.resolve(here, '..', '..'),
    entryPoints: [path.join(here, t.in)],
    outfile: path.join(here, t.out),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external,
    logLevel: 'info',
    banner: {
      js: "import { createRequire as __potsherdCreateRequire } from 'node:module';\nconst require = __potsherdCreateRequire(import.meta.url);",
    },
  });
}

writeFileSync(path.join(here, 'dist', '.gitkeep'), '');

// The published package carries its own licence and credit. The originals live
// at the repo root; npm only packs files inside the package directory.
const repo = path.resolve(here, '..', '..');
for (const file of ['LICENSE', 'NOTICE', 'README.md']) {
  const from = path.join(repo, file);
  if (existsSync(from)) copyFileSync(from, path.join(here, file));
}

mkdirSync(path.join(here,'licenses'),{recursive:true});

copyFileSync(path.join(repo,'licenses','models-dev-MIT.txt'),path.join(here,'licenses','models-dev-MIT.txt'));

copyFileSync(path.join(repo,'licenses','ccusage-MIT.txt'),path.join(here,'licenses','ccusage-MIT.txt'));
