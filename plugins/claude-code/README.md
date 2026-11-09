# slopie for Claude Code

slopie — search your past coding-agent sessions. Plus `slopie audit`, a Wrapped of your year.

What this plugin adds:

- **One skill, `slopie`.** Claude uses it whenever you mention earlier work. It teaches the record format and how to answer; Claude then searches `~/.slopie/records` with `rg` and `sed`, or with `slopie search`.
- **A SessionStart hook.** It keeps the records current with an incremental `slopie sync`. On resume or after compaction it prints at most 10 lines: this session's id, its record path, and the exact `slopie search` commands.

The plugin carries its own CLI bundle (`dist/potsherd.js`). There is no MCP server here, because Claude Code has a shell. For a harness without one, run `slopie mcp`.

```sh
./bin/potsherd sync          # build the records (about a minute for tens of GB of history)
./bin/potsherd search "pgbouncer pool size"
./bin/potsherd doctor
```

The records are local plain text with directory mode 0700. Nothing leaves the machine. `slopie forget <id>` and `slopie ignore <project>` remove sessions from the records.
