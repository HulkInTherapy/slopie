/**
 * The agent-facing text of slopie's memory surface, verbatim from the R5 evaluation (memory-lab-sweep 76a0280):
 *   NOTE_B         the L1 system note (eval/arms.py), with {DATA}/records written as {RECORDS}
 *   MCP_TOOLS      the four tools' names, descriptions and schemas (lab/spec.py TOOLS)
 *   MCP_INSTRUCTIONS  the server instructions (lab/spec.py SERVER_INSTRUCTIONS)
 * Do not edit these strings: they are what was measured. tests/records-mcp.test.ts pins them.
 */

export const NOTE_B_TEMPLATE = "The user's agent history (Claude Code, Codex, Pi; all projects; including sessions the harness deleted) is exported as plain text records under {RECORDS}:\n- INDEX.tsv: one line per session: harness, id, project (working dir), start, end (last activity), turns, parent, title, first user message, file, active (every UTC date with a turn, so rg '2026-07-14' INDEX.tsv lists every thread active that day, including long threads that started earlier).\n- <harness>/<project-slug>/<start-date>_<session-id>.txt: one file per session. Header lines start with \"## \" (session, project, title, time, parent, children, raw source paths).\n- Every content line starts with its turn tag: \"t12 USER 2026-08-20 20:26 | text\", \"t13 ASSISTANT ...\", \"t14 TOOL Bash 20:27 | command\", tool output lines \"t14 > ...\", continuation lines \"t12 | ...\". SYSTEM turns are injected/harness text.\n- Tool output is shortened; \"full output: <raw path>:<line>\" points to the original JSONL line (Codex .zst: use zstdcat).\n- Subagent sessions have \"parent: subagent of <id>\"; their files are named <date>_<parent-id>__agent-*.txt. Tasks another thread dispatched have \"parent: delegated by <id>\" (that thread briefed, tracked and applied the work, and lists them under children).\nSearch with rg (e.g. rg -n -i 'term' {RECORDS}, rg -l, rg 'pattern' INDEX.tsv) and read ranges with sed -n 'a,bp' file. Times are UTC. A record's modification time is its last activity, so rg -l --sortr modified 'term' {RECORDS} lists the most recently active threads first: decisions often change in a later thread or the other harness.";

export const MCP_INSTRUCTIONS = "Memory of the user's past AI coding sessions (Claude Code, Codex, Pi), every project, including sessions the harness deleted. Read-only. Use it whenever the user refers to earlier work, or when you continue a session.";

export const MCP_TOOLS = [
  {
    "name": "search",
    "description": "Search every past agent session (all projects and harnesses) for passages about something. Words and meaning both count: exact terms like error text, file names or ids match literally, and a description in other words still finds the passage. Returns the best passages with their session id, project, date and turn number, each followed by a ready-to-copy read(...) call to see the surrounding turns. Results are ranked by relevance, not date: to get the latest word on something, add since= or compare dates. Nothing is hidden: if the hits miss, rephrase in the words the hits use, add project=, or raise k.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "What you are looking for, in words or exact strings."
        },
        "k": {
          "type": "integer",
          "description": "Number of passages to return (default 8, max 30)."
        },
        "project": {
          "type": "string",
          "description": "Only sessions whose working directory contains this text, e.g. 'my-app'."
        },
        "harness": {
          "type": "string",
          "enum": [
            "claude",
            "codex",
            "pi"
          ],
          "description": "Only sessions from this harness."
        },
        "since": {
          "type": "string",
          "description": "Only passages at or after this ISO date/time, e.g. 2026-11-02."
        },
        "until": {
          "type": "string",
          "description": "Only passages at or before this ISO date/time."
        },
        "session": {
          "type": "string",
          "description": "Search inside one session only (id or 8+ char prefix)."
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "read",
    "description": "Read a past session's turns verbatim (user, assistant and tool turns, tool output shortened), by turn range. Use it after search to see context, or to read the end of a session you are continuing (from_turn=-30 reads the last 30 turns). Every reply says which turns it covered and gives the exact call to continue.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session": {
          "type": "string",
          "description": "Session id (or 8+ char prefix) from search or threads."
        },
        "from_turn": {
          "type": "integer",
          "description": "First turn to read (default 1). Negative counts from the end: -30 = last 30 turns."
        },
        "to_turn": {
          "type": "integer",
          "description": "Last turn to read (default from_turn+39)."
        },
        "max_chars": {
          "type": "integer",
          "description": "Character budget for the reply (default 12000, max 40000)."
        },
        "from_char": {
          "type": "integer",
          "description": "Resume inside from_turn at this character, when a reply had to cut that turn (its continuation line gives it)."
        }
      },
      "required": [
        "session"
      ]
    }
  },
  {
    "name": "threads",
    "description": "List past sessions (threads), newest first, with one line each: id, harness, project, start → end, turn count, title, the opening ask and the last assistant words, plus parent/child links. Filter by project, harness and time window to see what a project's threads are doing, and by text= to list EVERY thread containing some words (exhaustive, not ranked) — use that to answer 'which threads touched X'. Subagent threads are hidden unless include_subagents=true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "description": "Working-directory substring, e.g. 'slopie' or '/Users/me/work'."
        },
        "harness": {
          "type": "string",
          "enum": [
            "claude",
            "codex",
            "pi"
          ]
        },
        "since": {
          "type": "string",
          "description": "Threads active at or after this ISO date/time."
        },
        "until": {
          "type": "string",
          "description": "Threads active at or before this ISO date/time."
        },
        "text": {
          "type": "string",
          "description": "Only threads whose transcript contains all of these words."
        },
        "include_subagents": {
          "type": "boolean",
          "description": "Also list subagent threads (default false)."
        },
        "parent": {
          "type": "string",
          "description": "List the child threads (subagents, forks) of this session id."
        },
        "limit": {
          "type": "integer",
          "description": "Max rows (default 40, max 200)."
        },
        "offset": {
          "type": "integer",
          "description": "Skip this many rows (paging)."
        }
      }
    }
  },
  {
    "name": "grep",
    "description": "Find every occurrence of an exact string inside ONE session, in reading order, including full tool output. Use it when you know the wording (an error, a path, a number) and need where or how often it appears. No match clears only that spelling in that session.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session": {
          "type": "string",
          "description": "Session id or 8+ char prefix."
        },
        "pattern": {
          "type": "string",
          "description": "Literal text (case-insensitive)."
        },
        "regex": {
          "type": "boolean",
          "description": "Treat pattern as a regular expression."
        },
        "offset": {
          "type": "integer",
          "description": "Skip this many matches (paging)."
        }
      },
      "required": [
        "session",
        "pattern"
      ]
    }
  }
] as const;
