# Changelog

Public releases use package versions. Internal development phase numbers are planning milestones, not product versions. This public release consolidates a development snapshot; the original private development branches are preserved separately.

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
