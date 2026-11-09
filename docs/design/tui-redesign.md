# slopie audit: TUI redesign brief (1.8.6)

## Why

The 1.8.5 audit looks AI-made. That isn't a vague complaint. It's a list of tells we can name:

- Anthropic-ish orange on warm black, with many accent tints (ember, peach, cream, gold, silver, bronze).
- Chunky 3×5 pixel numerals and titles with a cream-to-orange gradient.
- A pixel mascot in the corner of every card.
- Boxes around everything: the stats box, six framed tiles, a double frame on the title.
- Emoji-ish glyphs (♥ ☠ ✿ ★ ✦ ◆ ✸).
- A zig-zag receipt edge and a barcode.
- Letter-spaced headings ("S L O P I E   A U D I T").

Each one is a default some model reached for. Taken together they read as "nobody decided anything".

The fix is a system where every mark is a decision and most marks are removed.

## What the references actually do

Captured 2026-11-09 at 1440 px wide. The screenshots are in `design-out/refs/` (not committed).

**Linear** (linear.app, /method, /changelog)

- **Colour.** Background #08090a. Primary text #f7f8f8, secondary #8a8f98, tertiary #62666d. Hairlines are one step up from the background. Colour is almost absent.
- **Accent.** The changelog's newest entry gets one 4 px orange dot, and that's the only colour on the page. The brand indigo (#5e6ad2 / #7170ff) shows up only on interactive state.
- **Two-tone headlines.** A sentence is set in one size: the first clause is white and the continuation is grey. Hierarchy comes from tone, not from more sizes.
- **Labels.** Tiny, uppercase, mono, very dim ("FIG 0.1", "THE LINEAR METHOD").
- **Grid.** A strict meta | content grid: the changelog puts the date in a left column and the content in a right column, joined by a 1 px timeline. Lists are separated by hairline rows, never boxes.
- **Space.** A lot of empty space. One idea per band.

**cofounder.co**

- **Colour.** Paper #f5f5f2 with charcoal text (#3b3b39) and greys (#8e8d89, #b0afad). Hairlines are #e2e2df.
- **Section numbers.** Mono uppercase ("1.0 — LAUNCH", "2.0 — GROW"), and list rows numbered "1.1 Business positioning".
- **Headlines.** The same two-tone device as Linear: "Keep building the product. *Put Cofounder to work on the company.*"
- **Numbers and charts.** Numbers are set in mono ("10.291"). Charts are segmented tick meters (thin vertical ticks in a row) and thin lines.
- **Colour use.** Status colour only (a green dot, a red pill), never decoration.

## Translating to a monospace grid

A terminal gives us six levers: weight, dim, italic, colour, position, and a handful of glyphs. Every rule below is stated in those terms.

1. **Monochrome first.**
   - **Tones.** Four greys: primary, secondary, tertiary and rule. Everything is one of them.
   - **Accent.** One accent, on at most three things per screen, and each use carries meaning: the rarity tier, the one peak in a chart, the "all local" status dot. Never on a label, a border or a heading.
2. **Hierarchy through tone and position, not boxes.**
   - **Headings.** A heading is bold primary. Supporting text is secondary on the same or the next line, the two-tone headline in its terminal form.
   - **Labels.** Small, plain, tertiary, sentence case or tight uppercase. Never letter-spaced.
3. **One grid.** Each screen uses one left edge (margin 6 at 120 cols, 3 at 80). Numbers are right-aligned in a tabular column. Multi-column bands share the same column starts top to bottom.
4. **Hairlines instead of boxes.**
   - **Bands.** `─` in the rule tone separates bands. A `│` divides a meta column from content where Linear would.
   - **What's gone.** No corners, no frames, no tiles, no torn edge.
5. **Big numbers through scale.**
   - **Fonts.** Hero numbers and the archetype title are drawn in a real display face built from box-drawing strokes. The heavy face (`━┃┏┓`) gives "engraved bold" and the hairline face (`─│╭╮`) gives "engraved light". A third option is a solid single-tone block face drawn from the same skeleton.
   - **Colour and sizes.** One colour per word, no gradients. Two sizes only: 3 rows for titles, 5 rows for hero numbers.
   - **Typography.** `$` is a small secondary superscript, as in good price typography.
6. **Charts are instruments.**
   - **Marks.** Eighth-block bars (`▁▂▃▄▅▆▇█`) in one grey with the peak in the accent. Thin progress lines (`━━━━────`), segmented tick meters (`┃┃┃┃┃╎╎╎`), and a single-hue heat ramp.
   - **Legends.** Axis labels in tertiary. No legends that need a key, if position can say it instead.
7. **No decorative glyphs.**
   - **Banned.** ♥ ☠ ✿ ★ ✦ ◆ ✸ ◥ and the pixel trophies are gone.
   - **What replaces them.** Words do the work ("22 thank-yous", "131 f-bombs").
   - **Allowed glyphs.** The status dot `●` and arrows `→ ←`, used as punctuation.
8. **Restrained motion.**
   - **Kept.** Fades from the background (not from a fixed black), counters that settle, bars that grow once, a title that resolves in place.
   - **Removed.** Shimmer, sparkles, impact flash, slot-machine roll, hopping mascot.
9. **Mascot.**
   - **Recommendation.** Drop it from the cards. At most, keep it as a tiny monochrome mark beside the wordmark.
   - **Why.** A mascot in every corner is the strongest "toy" signal in the current UI.
10. **Degrade on purpose.**
    - **Colour.** Truecolor gets the exact greys. In 256 colours every token maps to a grey-ramp index (232–255) or one tuned cube colour for the accent, so greys never turn blue or brown.
    - **Small screens.** At 80×24 whole elements drop out (charts first, then the big type falls back to bold text). Nothing is ever cut mid-word.

## The decision: direction A, "Linear dark" (1.8.6)

Three directions were mocked up behind a temporary flag and rendered side by side:

- **a.** Linear dark, solid numerals.
- **b.** Editorial charcoal, hairline numerals.
- **c.** Paper, light background.

The owner chose **a**, and it is the only look that ships. The flag and the other two directions are gone.

| Token | Value | Use |
|---|---|---|
| `bg` | #08090a | background, painted edge to edge |
| `text` | #f7f8f8 | headlines, values, display type |
| `text2` | #8a8f98 | supporting copy |
| `text3` | #5d6168 | labels, axes, hints |
| `rule` | #1f2125 | hairlines, empty tracks |
| `bar` / `barSoft` | #3e424a / #25282d | chart ink, estimates |
| `accent` | #7c7cff | the one point a screen is about (at most ~3 marks) |

**Type**

- **Display face.** Hero numbers and the archetype title use a solid single-tone block face, built from one stroke skeleton (`theme/display.ts`). When the solid face does not fit, the heavy box-drawing face is the narrow fallback.
- **Small marks.** `$` and `×` are small secondary marks set beside the numerals.

**Charts**

- **Shapes.** Eighth-block columns on a hairline baseline, ━ meters on ─ tracks, and a single-hue heat ramp.
- **Accent.** Only the peak or the "you" cell gets the accent.

**Chrome** (`theme/chrome.ts`)

- **Header.** The wordmark, then the page counter. The hairline under them doubles as the story progress.
- **Top of the card.** A small uppercase label, then the two-tone headline.
- **Bottom of the card.** The "next →" bridge in tertiary, the key footer, and "● all local".

**Mascot.** Dropped entirely: no pixel mascot, no clones, no trophies, no sparkles. The wordmark carries the brand.

**Motion**

- **Restrained.** Fades from the background, counters that settle, meters and bars that grow once.
- **The reveal.** The archetype's redacted bars (shown on the cover) resolve into the title in place.
- **The poster.** It prints in top to bottom.

**Degrading**

- **256 colours.** Every token is pinned to a grey-ramp index or to indigo 105.
- **16 colours.** The greys map by lightness and the accent becomes bright blue.
- **`--no-color`.** The tertiary tones turn into dim text.
- **`--ascii`.** The display type falls back to bold text.
