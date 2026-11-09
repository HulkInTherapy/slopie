# slopie for Codex

What this plugin adds:

- **The `slopie-memory` skill.** It is the note that teaches Codex the record format. Codex then finds earlier work with its shell over `~/.slopie/records`, or with the `slopie` CLI.
- **A SessionStart hook.** It keeps the records current. On resume it prints where this session's record is.

`slopie setup --codex` can also put the note in `~/.codex/AGENTS.md`, inside a marked block that `slopie setup --remove` takes out again.

```sh
./bin/potsherd sync
./bin/potsherd threads --project my-app --since 2026-10-01
```

The records are local plain text with directory mode 0700. There are no models, no daemon and no network calls.
