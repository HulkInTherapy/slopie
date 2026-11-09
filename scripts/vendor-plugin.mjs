/** Build-local distribution packaging. Each host installs one plugin directory. */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [built bundle, where each plugin wants it] */
const ARTIFACTS = [
  ['packages/cli/dist/potsherd.js', 'dist/potsherd.js'],
  ['packages/cli/dist/audit-native-worker.js', 'dist/audit-native-worker.js'],
  ['packages/cli/dist/records-worker.js', 'dist/records-worker.js'],
];
const PLUGINS = ['plugins/claude-code','plugins/codex'];

// Generated artifacts and docs do not change build provenance. Freeze bundles
// after committing these inputs so a later artifact commit reproduces the manifest.
const BUILD_INPUTS = [
  ':(glob)packages/*/src/**',
  ':(glob)packages/*/bin/**',
  ':(glob)packages/*/package.json',
  ':(glob)packages/*/build.mjs',
  ':(glob)packages/*/tsconfig*.json',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  ':(glob)tsconfig*.json', 'scripts/vendor-plugin.mjs',
  ':(glob)plugins/*/package.json',
  ':(glob)plugins/*/.*-plugin/*.json',
  '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json',
  'LICENSE', 'NOTICE', 'licenses/models-dev-MIT.txt', 'licenses/ccusage-MIT.txt',
];
const sourceRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', ...BUILD_INPUTS], {
  cwd: repo, encoding: 'utf8',
}).trim();
if (!sourceRevision) throw new Error('No committed build inputs found');

const missing = ARTIFACTS.map(([from]) => from).filter((f) => !existsSync(path.join(repo, f)));
if (missing.length > 0) {
  console.error(`not built: ${missing.join(', ')}\nrun:  pnpm build`);
  process.exit(1);
}

let bytes = 0;
for (const plugin of PLUGINS) {
  mkdirSync(path.join(repo, plugin, 'dist'), { recursive: true });
  for (const [from, to] of ARTIFACTS) {
    const src = path.join(repo, from);
    const dst = path.join(repo, plugin, to);
    copyFileSync(src, dst);
    bytes += statSync(dst).size;
    console.log(`  ${plugin}/${to}  <-  ${from}  (${(statSync(dst).size / 1024).toFixed(0)} KB)`);
  }
  for(const license of ['LICENSE','NOTICE'])copyFileSync(path.join(repo,license),path.join(repo,plugin,license));
  mkdirSync(path.join(repo,plugin,'licenses'),{recursive:true});
  for(const license of ['models-dev-MIT.txt','ccusage-MIT.txt'])copyFileSync(path.join(repo,'licenses',license),path.join(repo,plugin,'licenses',license));
  const files=Object.fromEntries(ARTIFACTS.map(([,name])=>{const body=readFileSync(path.join(repo,plugin,name));return [name,{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}];}));
  const version=JSON.parse(readFileSync(path.join(repo,'packages','cli','package.json'),'utf8')).version;
  writeFileSync(path.join(repo,plugin,'dist','artifact-manifest.json'),JSON.stringify({contractVersion:2,version,sourceRevision,files,memory:'plain-text records + SQLite FTS5; no models'},null,2)+'\n');
  writeFileSync(path.join(repo,plugin,'dist','README.md'),`# Generated local candidate artifacts

This plugin's CLI bundle (which also serves \`slopie mcp\`) runs independently of a sibling plugin or repository checkout. There are no model assets: memory is plain-text records plus a SQLite FTS5 index.

SQLite uses a locally available better-sqlite3 driver or Node's built-in node:sqlite when available. No native addon is vendored. This package includes its ESM marker, licenses and a hash manifest. Source maps are omitted.

Regenerate: pnpm build && pnpm vendor. Candidate version is not a publication or acceptance claim.
`);

}
console.log(`vendored ${ARTIFACTS.length * PLUGINS.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
