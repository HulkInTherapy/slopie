#!/bin/sh
# SessionStart: keep the session records current (incremental `slopie sync`; the first full build runs
# detached) and, on resume or after compaction, print a pointer of at most 10 lines to this session's
# record and the exact read/search commands. No summary, no model call. Never fails the session.
set -u
ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}}"
exec sh "$ROOT/bin/potsherd" hook session-start --harness codex 2>/dev/null || exit 0
