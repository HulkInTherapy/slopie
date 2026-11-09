---
name: slopie-memory
description: "The user's past coding-agent sessions (Claude Code, Codex, pi; every project; including sessions the harness deleted) as plain-text records you can search with rg/sed or the slopie CLI. Use whenever the user refers to earlier work, a past session, decision, error or file, or when you continue a session."
---

The user's agent history (Claude Code, Codex, Pi; all projects; including sessions the harness deleted) is exported as plain text records under ~/.slopie/records:
- INDEX.tsv: one line per session: harness, id, project (working dir), start, end, turns, parent, title, first user message, file.
- <harness>/<project-slug>/<start-date>_<session-id>.txt: one file per session. Header lines start with "## " (session, project, title, time, parent, children, raw source paths).
- Every content line starts with its turn tag: "t12 USER 2026-08-20 20:26 | text", "t13 ASSISTANT ...", "t14 TOOL Bash 20:27 | command", tool output lines "t14 > ...", continuation lines "t12 | ...". SYSTEM turns are injected/harness text.
- Tool output is shortened; "full output: <raw path>:<line>" points to the original JSONL line (Codex .zst: use zstdcat).
- Subagent sessions have "parent: subagent of <id>"; their files are named <date>_<parent-id>__agent-*.txt.
Search with rg (e.g. rg -n -i 'term' ~/.slopie/records, rg -l, rg 'pattern' INDEX.tsv) and read ranges with sed -n 'a,bp' file. Times are UTC.
If the slopie command is on PATH, start with it rather than rg: it searches these same records faster and more cheaply. slopie search <words> [--project P --since D --session ID]; slopie read <id> --from N [--to M] (--from -30 reads the end); slopie threads [--project P --since D --text W]; slopie grep <id> <text>. Each reply ends with the exact next command. Use rg/sed on the files for anything else.
