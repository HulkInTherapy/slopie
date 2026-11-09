# Slopie

**A Wrapped for your coding agents.** One command reads the session history that Claude Code, Codex, Cursor and pi already keep on your disk, and tells you who you were this year.

```sh
npx slopie audit
```

No signup, no API key, nothing uploaded. Requires Node.js 22+.

![An example Slopie poster: "The 2AM Deployer", $6,413 at API prices, 6 f-bombs per thank-you, nemesis GPT-6 Sol](https://raw.githubusercontent.com/HulkInTherapy/slopie/main/docs/images/slopie-poster.png)

<sub>Example poster rendered from test data. Yours is computed from your own history.</sub>

## What you get

A short story in your terminal (←/→ to move), ending on one poster you can share:

- **Your archetype.** One of 22, like *The 2AM Deployer*, *Jekyll & Hyde*, *Middle Management*, *The 'Keep going' Button* or *First Spared in the Uprising*, plus 5 rare legendary combos. Every tagline quotes one of your own numbers.
- **The bill.** What your agent work would cost at API list prices, per agent and per month, plus your priciest day and your single most expensive sentence.
- **Your manners.** F-bombs per thank-you, how your swearing changed over the year, the hour you're angriest and the hour you're a saint.
- **Your models.** Which model actually did the work (by recorded output tokens), the one you swear at most and the one you thank most.
- **Your habits.** Catchphrase, what you call your agent, longest sit, late nights, streaks, how many subagents you launched.

Press `s` to save the poster as an image with no project names on it. `--plain` prints the story as text, and `--json` prints the numbers.

It takes about 20 seconds the first time on a large history, then about a second.

## Private by default

The audit runs entirely on your machine: it reads your session files and writes only a local cache. It makes no network requests unless you pass `--online`, which lets a free hosted model (OpenCode Zen / TypeSafe Jev) polish the story's wording. Even then it sends only aggregates and a few filtered short quotes, never your prompts, and you see a notice before each request.

## How the numbers are made

- **Supported agents:** Claude Code, Codex (including compressed `.jsonl.zst` sessions and archives), Claude Desktop agent sessions, pi, OpenCode, and Cursor/Gemini/Copilot prompts.
- **Each session counts once.** Copies, forks, resumes and archives of a session are deduplicated per session lineage, and divergent tails are merged. Codex sessions imported from Claude Code and `codex exec` automation runs aren't counted as chats.
- **Spend has three parts, never added together:**
  - *measured*, from recorded token usage;
  - *recovered*, from Claude Code's own usage stats on days whose logs are gone;
  - an *estimated* range for prompts whose logs were deleted, clearly labelled.

  Prices are current API list prices, including long-context tiers. They are not your subscription bill.
- **Unknown models stay unpriced.** A model without a published price is reported as unpriced tokens, never guessed. Model shares count only models actually recorded on responses.
- **Checked against independent scripts.** On a 35 GB, 4,400-prompt history, the totals match two scripts that parse the raw files directly, to within 0.5%.

More detail: [coverage and privacy](docs/audit-terminal.md).

## Memory for your agents

Slopie started as local memory for coding agents, and that's still underneath: *your agents forget, slopie remembers.* `slopie setup` connects it to Claude Code, Codex, pi or OpenCode. Your agent can then search past sessions across projects and quote them exactly. The agent contract has four tools:

- `potsherd_recall`: scoped search;
- `potsherd_read`: exact source evidence;
- `potsherd_graft`: handoffs;
- `potsherd_write`: explicit memory.

See [MCP configuration](docs/mcp-clients.md) and the [agent contract](docs/AGENT-CONTRACT.md). The memory features are less mature than the audit; [release notes](docs/release-candidate.md) list measured results and limits.

## Install, build, upgrade

To install globally:

```sh
npm install -g slopie
slopie audit
```

`potsherd` remains a compatibility alias, and existing `POTSHERD_*` settings and data paths keep working. To build from source:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vendor
node packages/cli/bin/slopie.js audit
```

Before upgrading the memory store, back it up. `slopie maintain --migrate` creates a pre-upgrade backup. See the [changelog](CHANGELOG.md).

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
