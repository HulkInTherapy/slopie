# slopie for Codex

slopie — search your past coding-agent sessions. Plus `slopie audit`, a Wrapped of your year.

What this plugin adds:

- **One skill, `slopie`.** Codex uses it whenever you mention earlier work. It teaches the record format and how to answer; Codex then searches `~/.slopie/records` with its shell, or with `slopie search`.
- **A SessionStart hook.** It keeps the records current. On resume it prints where this session's record is.

`slopie setup --codex` can instead put the same text in `~/.codex/AGENTS.md`, inside a marked `slopie` block that `slopie setup --remove` takes out again.

```sh
./bin/potsherd sync
./bin/potsherd search --project my-app --since 2026-10-01
```

The records are local plain text with directory mode 0700. There are no models, no daemon and no network calls.
