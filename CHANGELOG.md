# Changelog

Public releases use package versions. Internal development phase numbers are planning milestones, not product versions. This public release consolidates a development snapshot; the original private development branches are preserved separately.

## 1.9.1 — Secrets fixed, main threads first

- **Secrets no longer reach your agent.** Every string that enters a record is redacted before it is written, indexed or searched: messages, tool input and output, titles, first asks, last answers, `INDEX.tsv`, sidecars and the session cards. Raw re-reads (exact matches inside a thread) are redacted too. Masks read `[REDACTED:<type>]` and keep the variable name (`TAVILY_API_KEY=[REDACTED:tavily]`). Base64 images and other binary bulk are elided first.
- New explicit Tavily (`tvly-…`) and Telegram bot token rules, independent of the entropy threshold one Tavily key slipped under.
- The first `slopie sync` after upgrading rewrites every existing record in place, including records whose source the harness already deleted (they are re-redacted, never dropped), then rebuilds and vacuums the search index. Harness originals are never touched.
- Search puts main threads first: one passage per thread (the rest as "+N more in this thread"), at most two results per parent/subagent family with the parent first and the subagent under it, and a prior that favours long main threads over subagents and tiny threads.
- Threads that contain every word of the query rank above those that match only some, which are labelled "(partial match)". The shown snippet prefers what the user or assistant said over tool dumps.
- `--project`, `--harness`, `--since`, `--until` and `--session` now filter inside the query, before its candidate limit, so scoped searches no longer lose matches to stronger ones elsewhere.
- `slopie search` (and the MCP tool) refreshes the index first, for at most 1.5 s, and says so when it could not finish. Every reply starts with the index age. `SLOPIE_NO_REFRESH=1` turns the refresh off.
- `--latest` lists the threads with your words by last activity, newest first, each with its last matching passage. Backlinks now read "referenced later in".
- `--include-subagents` lists subagents as their own results, and `--parent <id>` lists a thread's children.
- `--json` (and MCP structuredContent) returns `{mode, indexed_at, partial, hits, next}`, with session, harness, project, parent, root, role, turn, time, snippet and read command per hit.
- A search with no match suggests a runnable relaxed query and the closest `--project` names. `--project` matches any path segment.
- `slopie setup` removes stale potsherd 1.x hooks (`potsherd rescue`, `potsherd-mcp`) from Claude and Codex settings, with a backup. It installs a Codex SessionStart refresh hook where `~/.codex/hooks.json` exists. `--status` shows the index age and whether each harness has a refresh hook or only the note.
- The skill now says "your past coding-agent sessions", and puts the three most useful `slopie search` recipes before the records format.

## 1.9.0 — Search your past sessions

**slopie — search your past coding-agent sessions.** Plus `slopie audit`, a Wrapped of your year.

Memory is rebuilt around what measured best, and cut down to one thing. Every session is kept as a plain-text record. Your agent gets exactly one skill, `slopie`, and one command, `slopie search` (or one MCP tool, `search`). The old memory stack is gone. The audit is unchanged.

- **`slopie sync`** writes one record per session to `~/.slopie/records` (or `SLOPIE_RECORDS_DIR`), plus `INDEX.tsv`. It covers Claude Code (with Desktop agent sessions), Codex (`.jsonl.zst`, archived sessions), pi, and the 1.x rescue archive.
  - Every line carries its turn tag and time, and tool output is shortened with a pointer to the raw line.
  - Subagents are named after their parent, and sessions known only from `history.jsonl` get prompt-only records.
  - Copies of a session are merged, and the one with the most turns wins.
  - Sync is incremental per source file and writes atomically. Directories are 0700.
  - Records outlive the harness deleting the transcript.
  - On a 35 GB history the full build takes about a minute, and a sync with nothing new about 0.3 s.

  Records also sync in the background of `slopie audit` and from the session-start hook.
- **One source layer.** The audit's discovery and opt-out policy are now shared, so the audit and the records read the same files the same way. The audit's numbers are unchanged: a 1.8.5 and a 1.9.0 snapshot of the same 35 GB history are identical.
- **One skill, `slopie`.** Every integration installs exactly one: the Claude Code and Codex plugins, `slopie setup` (a Claude Code skill, a marked `slopie` block in Codex's `AGENTS.md`, a pi skill plus extension). Its description is one sentence: "Search everything you and the user did in past coding sessions (Claude Code, Codex, pi). Use it whenever the user mentions earlier work, asks what happened before, or you continue a session." Its body is the evaluated note: the record format, a one-line answer protocol, and one line on `slopie search`. The plugins ship no other skills or commands. `slopie setup --note` prints the body for any other agent. A session-start hook keeps the records current and, after a resume or compaction, prints this session's record path and the exact `slopie search` commands, in at most 10 lines and with no summary.
- **One command, `slopie search`.** Its options pick the mode. With words it returns ranked passages from every thread. With `--session <id> --turns 120-160` (or `-30`) it reads a turn range. With words and `--session` it searches inside one thread, including full tool output. With `--project` / `--since` alone it lists threads. Every reply ends with the exact next command. It runs on a local SQLite FTS5 index (BM25 with a contextual prefix, plus a session-card lane). **`slopie mcp`** serves it as one MCP tool, `search`, with the same parameters, for harnesses without a shell. The pre-release verbs `read`, `threads` and `grep` remain as hidden aliases.
- **Privacy.** `slopie forget <session>` (new) and `slopie ignore <project>` remove sessions from the records and the index, and keep them out of the audit. Both lists live in `~/.slopie` and are seeded once, read-only, from the 1.8 lists.
- **Removed, a clean break:**
  - the 1.x memory store (capture, ingest, recall, graft, read and write);
  - the MCP tools `potsherd_recall`, `potsherd_read`, `potsherd_graft` and `potsherd_write`;
  - embeddings, `sqlite-vec`, ONNX and model assets;
  - notes, tags, cards, open threads, link suggestions and keyphrases;
  - the bridges, and the 1.x retention audit (`audit --legacy`, `--sweep`, `--verify`), together with the verbs that served them (`rescue`, `guard`, `maintain`, `index`, `find`, `ask`, `ls`, `show`, `stats`, `card`, `note`, `tag`, `pin`, `link`, `graft`, `export`, `stack`, `reader`).

  The dependencies `@huggingface/transformers`, `sqlite-vec`, `js-tiktoken`, `@anthropic-ai/*`, `@modelcontextprotocol/sdk` and `zod` are removed.
- **`~/.potsherd` is left untouched.** Only the audit's cache in it is still used. `slopie doctor` says when the rest is safe to remove by hand.
- **Fix:** `slopie audit --online` now actually turns on the opt-in online wording. In 1.8.5 the flag was parsed but never passed through.
- **Evaluation (R6), on the real 35 GB history with Claude Haiku and Sonnet:**
  - The records match the reference exporter's turn for turn.
  - Records + note + `rg`: 97% / 100% on 31 fresh questions, and 89% / 85% on 33 hard ones. The same agents scored 39% / 64% over the raw files.
  - With the CLI added: 100% / 100% and 88% / 88%, with Haiku's median cost per question about a quarter lower.
  - The final surface (one `slopie` skill, one `slopie search`) on 40 fresh, frozen questions (CONFIRM3), one rep: Haiku 39/40 and Sonnet 39/40. Both misses were the same borderline roster question.

  The optional full-output sidecar (`sync --sidecar`) and extra note guidance were measured, gave mixed results, and are not defaults. See `docs/memory.md`.

## 1.8.7 — Readable

- **Bigger type.** Every card has one hero number in the display face, secondary numbers in the thinner stroke face, and labels set as small uppercase captions above bold values. On big terminals (170×50 and up) the hero doubles in size.
- **More colour.** The indigo accent now comes in tints: eyebrows, key figures, chart fills, heatmaps and chips use it, so every card has a clear focal point. Body text is a lighter grey; the dim grey is kept for labels and footnotes.
- **Less text.** Each card has one short headline and at most one line under it. Detail moved into label/value rows.
- **Charts in the accent.** Bars, heatmaps and meters are drawn in indigo tints with the one point that matters in the full accent. Meters are solid one-row bars.
- **Layouts that fill large terminals.** Cards lay out in a content box that grows with the terminal (up to 176×52) and is centred, with taller charts and more air.
- **A new awards podium.** Gold, silver and bronze stand on a podium with their rank in the display face; ranks 4–6 sit in one row beneath. The board's facts grid gets proper spacing.
- Same numbers, same data: this release changes only how they look.

## 1.8.6 — New look

- **A new look for `slopie audit`.**
  - **Palette.** Near-black and four greys, with one indigo accent used sparingly: the rarity tier, the one peak a chart is about, and the "all local" dot.
  - **Layout.** Hairlines instead of boxes, small uppercase labels, and two-tone headlines (the statement in white, the context in grey) on one column grid.
  - **Display type.** Hero numbers and your archetype are set in a clean single-tone display face, not gradient pixel type.
- **No mascot, no ornaments.** The pixel mascot, trophies, sparkles, hearts, skulls, stars and the torn receipt edge are gone. Charts are precise and quiet: eighth-block bars on a baseline, thin meters, a single-hue heat grid.
- **Every card redrawn**: the loading screen, the 16 story cards, the final board and the `s` share card. `--plain` prints the hero number in the same face, with words instead of symbols. Nothing is cut at 120×40, 100×30 or 80×24, and the board keeps all six core facts at every size.
- **Calmer motion.**
  - **What stays.** Elements fade in, counters settle, and bars grow once.
  - **The reveal.** The archetype's redacted bars from the cover now resolve into your title in place, with no slot roll, shimmer or sparkles.
  - **The board.** It prints in top to bottom.
  - **When still, no timers.** Nothing repaints until you press a key, resize the window or new data arrives.
- **Better fallbacks.** In 256 colours every tone is pinned to the neutral grey ramp. In 16 colours the accent becomes bright blue. With `--no-color` labels and hints turn dim, and with `--ascii` the display type falls back to bold text.
- Same numbers, same data: this release changes only how they look.

## 1.8.5 — Every session counted, much faster

- **Local by default.** `slopie audit` now makes no network requests. The free hosted model that polishes story wording is opt-in with `--online` (it never received prompts, only aggregates and a few filtered quotes).
- **Complete history.** Reads Codex's compressed `.jsonl.zst` rollouts, archived sessions, the potsherd rescue archive, Claude Desktop agent sessions and Cursor/Gemini/Copilot prompts. Live, archived, copied and forked copies of a session count once: counters are deduplicated per session and fork lineage, and divergent tails are merged. Codex sessions imported from Claude Code and `codex exec` runs are not counted as chats; automated runs are reported separately.
- **Honest spend.** Spend is now split into three parts, never added together: *measured* (request logs), *recovered* (Claude Code's own usage stats for days without logs) and a labelled *estimate* range for prompts whose logs were deleted. Long-context tiers and request-time model/tier are priced correctly. Models without a published price stay unpriced instead of being guessed. You also get monthly and daily spend, this month, per active day and your priciest day.
- **Models you actually used.** The model quiz and model share count only models recorded on responses, ranked by output tokens, with a last-30-days view and eras. The quiz no longer guesses a prompt's model from other prompts on the same day.
- **Faster.** On a ~35 GB, 4.4k-prompt history: first run ~19 s (was 27 s), warm re-runs ~1.3 s (was 2.3 s), peak memory ~1.1 GB. Archive copies already present live are skipped, zstd is streamed, and adapter results are cached.
- **A personality poster.** The final board is a single dark "receipt": your archetype, your spend, prompts, days and catchphrase, your angriest and saint hours, six fun facts with small diagrams (manners, character arc, priciest sentence, longest sit, pet name, nemesis), and your top two trophies. It prints in on open and degrades without truncation down to 80×24. `s` saves the same poster with no project names.
- **22 archetypes and 5 legendary combos**, scored on soft bands so rarity means something, with the runner-up named in words. Awards: 24 candidates ranked by surprise, metal by rarity. The priciest-day award quotes the spend card.
- Fixes: malformed rows, timestamps out of range, India-time midnight (15-minute day buckets), undated prompts, model alias duplicates, Bedrock revision pricing, and shares that add up to exactly 100.

## 1.8.0 — Your story

- `slopie audit` is now a story: a loading screen where Slopie, the new mascot, finds each coding agent on your machine and eats your history, then one full-screen card per insight (←/→ to move), ending on a share board. `s` saves an anonymised share card; `--plain` prints the story as text.
- 30 offline insight detectors, each with sample-size guards and a receipt (a number, a date or your own words): most expensive sentence, swear-rate turning point, the model you swear at most and the one you thank most (compared within the same months), your fuse length, catchphrase, nudges, pet names, typos, honeymoon with a model, the project that got away, weekday-by-hour clock, first prompt vs latest, delegation, and more.
- A deterministic archetype (12 types, with sub-role and rarity) and awards. With the optional free model online, it only chooses among local wordings; numbers are never generated.
- Quotes come only from fixed slots and pass secret and sensitive-topic filters; swears are masked. The derived cache stores per-prompt features, not prompt text.
- Incremental reads: growing history files are parsed from where the last run stopped.
- Unchanged: offline cold run ~5 s, warm ~1 s; totals still match an independent check.

## 1.7.5 — Fast, correct audit

- Rebuild the audit pipeline: each native history file is read once on a worker-thread pool, cached by path/size/mtime, and aggregated in one pass. Full local results in ~5s cold and ~1s warm on a 3.9 GB history (was 35–110s).
- Fix totals: Claude Code spend is now included in the headline (it was reported only as a reference value), every model with usage gets a price, Codex fast-tier and compaction requests are priced, and cached input is no longer double-counted.
- Fix prompt counts: recognise current Codex user-message events, exclude slash commands, task notifications and headless runs, include prompts surviving only in Claude Code's history file, and treat Codex auto-review rollouts as child sessions.
- Deleted Claude Code sessions are read from `~/.claude/history.jsonl` instead of copying the potsherd archive; ignore/forget opt-outs still apply.
- Redesign the wallboard: big spend hero, model/project bars, weekly activity, repeated lines, reactions and swear jar on one screen; ←/→ pages on small terminals; first paint in ~0.1s.

## 1.7.0 — Native usage wallboard

- Replace section tabs and scrolling with a responsive orange-and-neutral fullscreen wallboard. Show model prices, top projects and requested work, grouped source lines and observed directed reactions; use mixed left/right pages on smaller terminals.
- Inventory native Claude Code, Codex, OpenCode and pi history before retained fallback. Stream full response usage separately from bounded latest complete-turn context; preserve cumulative, request/copy/fork and model-identity ambiguity semantics.
- Keep current-catalog API-equivalent pricing, named exact Anthropic references, explicit cache durations and native recorded API-cost fields distinct. Unknown or contradictory usage and routing are not guessed.
- Read actual privacy authority through guarded read-only SQLite metadata transactions instead of making a large index backup a startup prerequisite. Preserve committed-WAL checksums, ignore/forget revocation and immutable captured details after ordinary source appends.
- Run heavy work in a cancellable background process. Require a visible, flushed recipient notice before every actual free-provider request, including concurrent requests; keep offline facts usable without a transfer claim.
- Preserve legacy routes, executable aliases, storage and plugin identities. This release does not establish private semantic accuracy or universal latency.

## 1.6.2 — Live SQLite history

- Read committed live-WAL history from bounded private snapshots using SQLite recovery, without opening or mutating the source database, WAL or shared-memory files. Keep ignore, forget and source-currentness fences; hold active rollback journals and unsafe captures with distinct reasons.
- Distinguish local source failures, loading, explicitly offline analysis and provider quota failures. Settled failures no longer leave the selected window pending or imply a model request occurred.
- Resolve a proven self-counting token-receipt cycle at decimal boundaries using bounded legal whitespace in the actual immutable emission. Keep caller limits, request identity, evidence and exact measured JSON/MCP/human accounting; ordinary stable serialization stays unchanged.
- Preserve the Slopie command and Potsherd compatibility executable. This patch makes no new live model calls or broader semantic accuracy claim.

## 1.6.1 — Slopie

- Rebrand the public package, primary command, terminal and repository as Slopie (formerly Potsherd). Run `slopie audit`; `potsherd` remains a compatibility executable. Existing storage, cache, settings, plugins and tool IDs keep their compatibility names.
- Preserve the experimental audit disclosures: partial usage and unknown providers, explicit first-party reference pricing, quota-limited free analysis and unavailable private semantic accuracy. This branding release adds no Jev calls, performance improvement or broader accuracy qualification.
- Retain the observed large synthetic fixture timing of about 33 seconds cold / 22 seconds warm and untuned consumer scores of usefulness 7/10, ease 8/10 and appearance 8/10 at 80 columns (7/10 at 40).

## 1.6.0 — Potsherd release history

- Make `potsherd audit` the terminal retrospective, with Models, Projects, Work, Hall of Fame, Language and Timeline drilldowns. The retention audit remains available with `--legacy`; `--sweep` and `--verify` retain their existing routes.
- Extract recorded per-response models and native usage from Codex, Claude Code, OpenCode and pi. Show API-equivalent value at a dated current catalog snapshot, token/pricing coverage, and explicit unknowns.
- Prepare complete redacted dialogue segments for bounded free-only Jev judgments, select a fitting recent window or labelled newest-episode subset, keep evidence-bound work/outcome/quote judgments separate, and persist body-free derived caches and verified date inventories.
- Disclose transcript recipients at opening, preserve per-record ignore/project/forget/source-currentness checks, and cancel discovery, inference and background refresh when exiting.

## 1.5.0

- Promote the existing candidate implementation to stable package version 1.5.0 and the npm `latest` channel. The v2 tool contract is independent of the package version.
- Retry temporary registry lookup failures within the bounded provenance check after publishing.
- Retain the recorded rc.2 cold-retrieval limitations and 4/10 consumer result. The stable designation does not establish improved retrieval quality or unattended primary-memory acceptance.

## 2.0.0-rc.3

- Restore complete tag history in candidate CI so release-version checks run against reachable release tags.
- Name the v2 agent contract and its four tools explicitly in the README. This candidate carries release metadata and documentation fixes; the rc.2 memory engine and recorded consumer limitations remain unchanged.

## 2.0.0-rc.2

- Default an omitted JSON budget tokenizer to the pinned bundled accountant. Reject explicit unsupported identities and malformed budget fields with safe field-specific errors.
- Add complete scoped CLI JSON and ordinary-flag examples. Existing rc.1 consumer and qualification results remain bound to rc.1.
- Fix native Codex marketplace registration to select `plugins/codex`; Claude Code retains its own marketplace entry.

## 2.0.0-rc.1 — unpublished candidate

Versioned exact evidence and authored-note contracts, scoped capture enrollment, complementary bounded reading, and native integration adapters. Release qualification is incomplete; see [candidate notes](docs/release-candidate.md).

## 1.2.1

Prior public release, retained as the authenticated upgrade and rollback baseline.
