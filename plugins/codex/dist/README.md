# Generated local candidate artifacts

This plugin's CLI bundle (which also serves `slopie mcp`) runs independently of a sibling plugin or repository checkout. There are no model assets: memory is plain-text records plus a SQLite FTS5 index.

SQLite uses a locally available better-sqlite3 driver or Node's built-in node:sqlite when available. No native addon is vendored. This package includes its ESM marker, licenses and a hash manifest. Source maps are omitted.

Regenerate: pnpm build && pnpm vendor. Candidate version is not a publication or acceptance claim.
