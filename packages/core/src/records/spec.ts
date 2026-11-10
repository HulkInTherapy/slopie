/**
 * The agent-facing text of slopie's memory surface.
 *   NOTE_B_TEMPLATE   the records note (R5 NOTE_B, extended through R8 and measured there), with {RECORDS} for the path
 *   MCP_TOOLS         the one MCP tool, `search` (1.9.0: replaces R5's search/read/threads/grep; measured as the
 *                     `slopie search` CLI it mirrors, arm P3)
 *   MCP_INSTRUCTIONS  the server instructions
 * tests/records-tools.test.ts pins them.
 */

export const NOTE_B_TEMPLATE = "The user's agent history (Claude Code, Codex, Pi; all projects; including sessions the harness deleted) is exported as plain text records under {RECORDS}:\n- INDEX.tsv: one line per session: harness, id, project (working dir), start, end (last activity), turns, parent, title, first user message, file, active (every UTC date with a turn, so rg '2026-07-14' INDEX.tsv lists every thread active that day, including long threads that started earlier), later (later threads that name this one, where the work or a decision often continued).\n- <harness>/<project-slug>/<start-date>_<session-id>.txt: one file per session. Header lines start with \"## \" (session, project, title, time, parent, children, later threads that mention it, raw source paths).\n- Every content line starts with its turn tag: \"t12 USER 2026-08-20 20:26 | text\", \"t13 ASSISTANT ...\", \"t14 TOOL Bash 20:27 | command\", tool output lines \"t14 > ...\", continuation lines \"t12 | ...\". SYSTEM turns are injected/harness text.\n- Tool output is shortened; \"full output: <raw path>:<line>\" points to the original JSONL line (Codex .zst: use zstdcat).\n- Subagent sessions have \"parent: subagent of <id>\"; their files are named <date>_<parent-id>__agent-*.txt. Tasks another thread dispatched have \"parent: delegated by <id>\" (that thread briefed, tracked and applied the work, and lists them under children).\nSearch with rg (e.g. rg -n -i 'term' {RECORDS}, rg -l, rg 'pattern' INDEX.tsv) and read ranges with sed -n 'a,bp' file. Times are UTC. A record's modification time is its last activity, so rg -l --sortr modified 'term' {RECORDS} lists the most recently active threads first: decisions often change in a later thread or the other harness.";

export const MCP_INSTRUCTIONS = "slopie: search the user's past coding-agent sessions (Claude Code, Codex, pi; every project). Use it whenever the user mentions earlier work, asks what happened before, or you continue a session.";

export const MCP_TOOLS = [
  {
    name: 'search',
    description: "Search the user's past coding-agent sessions (Claude Code, Codex, pi). "
      + 'query finds passages; session + turns reads a thread; query + session searches inside one thread; project or since alone lists threads. Every reply ends with the exact next call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Words or exact text to find, e.g. "pgbouncer pool size".'},
        session: {type: 'string', description: 'A session id (or its first 8+ characters) from an earlier reply, e.g. "9c4d2f18".'},
        turns: {type: 'string', description: 'With session: the turns to read, e.g. "120-160", or "-30" for the last 30.'},
        project: {type: 'string', description: 'Only threads whose working directory contains this, e.g. "my-app".'},
        since: {type: 'string', description: 'Only activity on or after this date, e.g. "2026-11-01".'},
        until: {type: 'string', description: 'Only activity on or before this date, e.g. "2026-11-07".'},
        latest: {type: 'boolean', description: 'With query: the threads with these words, newest last activity first, each with its last matching passage, e.g. "true".'},
        include_subagents: {type: 'boolean', description: 'List subagent threads as their own results (default: grouped under their parent), e.g. "true".'},
        parent: {type: 'string', description: "A session id: list that thread's child threads (subagents, delegated tasks), e.g. \"9c4d2f18\"."},
      },
    },
  },
] as const;
