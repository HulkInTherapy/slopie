# Memory: plain-text records

slopie 1.9 keeps every coding-agent session as a plain-text record and teaches your agents the format. This page covers the design, the commands and the evidence behind them.

## Why plain text

Our evaluations ran on a real 35 GB history: 2,251 sessions across Claude Code, Codex and pi. The questions were about earlier work: continuing a session, finding a thread, the latest decision on something, which threads touched a topic, and cross-harness questions. R5 compared techniques in a lab, and R6 measured this product.

- **Plain-text records, a nine-line note and the agent's own `rg` / `sed`** (R6 arm P1):
  - 31 fresh questions: Haiku 97% (60/62 attempts), Sonnet 100% (31/31).
  - 33 harder questions: Haiku 89%, Sonnet 85%.
  - The same agents running the same `rg` over the raw harness files scored 39% (Haiku) and 64% (Sonnet) on the harder set.
- **With the `slopie` CLI on PATH as well** (P2):
  - Haiku 100% and Sonnet 100% on the fresh set; 88% and 88% on the harder set.
  - Haiku's median cost per question fell by about a quarter. Sonnet mostly kept using `rg`.
- **Heavier techniques (R5) improved nothing measurably**, and several cost far more. We tried hybrid dense retrieval, cross-encoder and LLM reranking, LLM summaries, an entity graph, a memory sub-agent, long-context stuffing and a full external memory system.
- **The format is what matters, not the search engine.**

So 1.9 ships records, the note, the CLI and an MCP wrapper. There are no embeddings, rerankers, daemon or model calls.

## Records

`slopie sync` writes `~/.slopie/records`, or the directory in `SLOPIE_RECORDS_DIR`:

```
INDEX.tsv                                     harness, id, project, start, end, turns, parent, title, first user message, file, active
claude/<project-slug>/<date>_<session>.txt    one file per session
claude/<project-slug>/<date>_<parent>__agent-<id>.txt   Claude subagents, named after their parent
codex/…   pi/…
```

Every file starts with `## ` header lines (session, project, title, time, parent, children, raw source paths). After the header, every line carries its turn tag:

```
t1 USER 2026-10-01 09:12 | the login page loops back to /signin after OAuth
t2 ASSISTANT 2026-10-01 09:13 | Looking at the callback handler first.
t3 TOOL Bash 09:13 | rg -n "redirect_uri" src/
t3 > src/auth/callback.ts:41:  const redirect_uri = …
t3 > …[1054 chars cut; full output: /…/1a2b3c4d-….jsonl:5]…
```

`rg -n` output is therefore self-locating, and `sed -n 'a,bp'` reads a range.

- **Sources.** These are the same readers the audit uses: Claude Code (including Claude Desktop agent sessions), Codex (`sessions/`, `archived_sessions/`, compressed `.jsonl.zst`), pi, and the potsherd 1.x rescue archive.
- **Copies.** Live, compressed, archived and rescued copies of one session become one record, and the copy with the most turns wins. Codex threads that are imports of Claude sessions are dropped, unless the user went on working in Codex: then the turns after the import are kept as `import of <claude id>` (1.9.0 before R7 dropped them, losing 486 messages in 4 threads of the 35 GB history). Fork prefixes are skipped.
- **Prompt-only records.** A session that survives only as typed prompts in `history.jsonl` gets a prompt-only record.
- **Tool output** up to 4,000 characters is kept whole; longer output keeps 2,000 + 1,000 characters, with a pointer to the raw line. `slopie grep` reaches the full text. (1.9.0 before R7 cut everything over 800 characters to 500 + 300; R7 found answers in the cut middle of 2 kB outputs. Records grow about half, to ~165 MB on the 35 GB history.) `slopie sync --sidecar` still writes `<record>.out.txt` with every cut output, up to 20 kB each, as an opt-in.
- **Records outlive their sources.** When a harness deletes a transcript, its record stays. A record never shrinks to a shorter copy.
- **Incremental.** A source file is re-read only when its size or mtime changes. On the 35 GB history a full build takes about a minute, and a sync with nothing new takes about 0.3 s.
- **Atomic and private.** Every file is written to a temp file and renamed. Directories are 0700 and files 0600.

Records sync on `slopie sync`, in the background of `slopie audit`, and from the session-start hook. There is no file watcher.

## The note

`slopie setup` installs the evaluated note, with your records path filled in, plus one line about the CLI:

- **Claude Code:** `~/.claude/skills/slopie-memory/SKILL.md`, plus a SessionStart hook in `~/.claude/settings.json`.
- **Codex:** a marked block in `~/.codex/AGENTS.md`.
- **pi:** `~/.pi/agent/skills/slopie-memory/SKILL.md`, plus an extension that syncs on session start and, after a resume or compaction, hands the agent the same pointer with `pi.sendMessage` (delivered with the next prompt).

The Claude Code and Codex plugins carry the same skill and hook. Two more commands help: `slopie setup --note` prints the note to paste anywhere, and `slopie setup --remove` takes out exactly what setup wrote. Setup also removes the MCP server potsherd 1.x registered (in `~/.claude.json`, `~/.codex/config.toml`, the pi `potsherd.ts` extension, and Cursor, Gemini, opencode and Copilot configs when no agent is named): only an entry in the shape potsherd wrote, shown in the plan first and backed up like every other change.

After a resume or compaction, the session-start hook prints at most 10 lines: this session's id, its record path, and the exact `slopie read <id> --from -30` and `slopie search … --session <id>` commands. It is a pointer, not a summary. The hook never waits on a sync: it points at the records as they are and refreshes them in a detached process (if this session has no record yet, it waits up to 3 seconds for one, `SLOPIE_HOOK_WAIT_MS`).

## CLI and MCP

| command | MCP tool | what it does |
|---|---|---|
| `slopie search <words> [--project --harness --since --until --session -k]` | `search` | Ranked passages. Each hit shows session, project, date and turn, and ends with the `read` command for it. |
| `slopie read <id> [--from N --to M --max-chars]` | `read` | A turn range. `--from -30` reads the end, and the reply ends with the command that continues. |
| `slopie threads [--project --since --until --text --subagents --parent]` | `threads` | Sessions, newest first. `--text` lists every thread containing all the words. |
| `slopie grep <id> <text> [--regex]` | `grep` | Every occurrence in one session, including full tool output, re-read from the raw source when it is still there. |

- **Index.** The search index is `<records>/.slopie/index.sqlite`. It holds one row per turn, with the deterministic prefix `title · project · date · ROLE[ tool]`, plus a session-card lane (title and every user ask), fused by reciprocal rank. It is built by `sync` and opened read-only by the lookups.
- **Subagent hits.** Every hit on a subagent prints `subagent of <parent-id>`.
- **Delegated threads.** A thread another thread dispatched through a `delegate_task` tool (T3 Code orchestration) has `parent: delegated by <id>`, and the dispatcher lists it under `children`. Both sides are linked by the dispatched task text. Hits on such threads print `delegated by <id>`.
- **Backlinks.** When a later session's user or assistant names a session by id (full or its first 8 hex characters), that session's record carries `## mentioned later in: <id> (<harness>, <date>)` as its second-last header line and its last line, so an agent reading where a thread ended sees where the work went next.
- **Activity dates.** INDEX.tsv's last column, `active`, lists every UTC date with a turn, so `rg 2026-07-14 INDEX.tsv` finds threads active that day, including long threads that started earlier. Each record's modification time is its session's last activity, so `rg -l --sortr modified <term>` lists the most recently active threads first. `slopie search` ends with the newest threads among its best candidates.
- **MCP.** `slopie mcp` serves the four tools over stdio for harnesses without a shell. Their names, descriptions and schemas are the evaluated ones, verbatim.

## Privacy

- **Local only.** Records are plain text on your disk, in a 0700 directory. Nothing is uploaded, and no model sees them unless your own agent reads them.
- **`slopie forget <session>`** removes a session and its subagents from the records and the index now, and from every later sync and from the audit. The native transcript is never touched.
- **`slopie ignore <project>`** does the same for a whole project.
- **The lists** live in `~/.slopie/forget.json` and `~/.slopie/config.json`. On the first write they are seeded, read-only, from the 1.8 lists in `~/.potsherd`.

## Upgrading from 1.8

The 1.8 memory store, MCP tools (`potsherd_recall`, `_read`, `_graft`, `_write`), embeddings and model assets are gone. This is a clean break: run `slopie setup` to install the new surface.

1.9 never writes to or deletes from `~/.potsherd`, except the audit's existing cache in `audit-derived/`. It reads the rescue archive there as a source. After one `slopie sync`, the records hold every archived session, and `slopie doctor` says the old store is safe to remove by hand.
