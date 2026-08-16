# Handoff: gladlog UI Redesign (Report 1c Scheme + Full Module Optimization)

## Overview
Implementation instructions for the UI redesign of six modules in gladlog (WoW arena log analysis desktop app, Electron + React, renderer located in
`packages/desktop/src/renderer/src/`):

- **Report** → Use the "Timeline Spine" scheme (Design draft ID 1c)
- **Match List** → 1e, **Replay** → 1f, **AI Analysis** → 1g, **Stats** → 1h, **Settings** → 1i
- A new set of global design tokens (see Design Tokens section), replacing the existing slate black + gold scheme

## About the Design Files
The `module-optimization-mockup.dc.html` in this package is an **HTML design reference draft** (static mockup, including a side-by-side comparison of the current reproduction and the improved draft).
It is not production code that can be copied directly. The task is to **reproduce these designs** within gladlog's existing environment (React + TypeScript, single
`styles.css`, no CSS-in-JS): modify the tokens and classes in `styles.css`,
and refactor the structure of the corresponding `.tsx` components. Continue using existing conventions: class name prefixes `rpt-`/`mlr-`/`mlf-`/`dash-`,
and all styles are centralized in `packages/desktop/src/renderer/src/styles.css`.

## Fidelity
**High-fidelity**. The colors, font sizes, spacing, and border radii in the design drafts are final values and should be reproduced pixel by pixel.
The "Problem → Solution" comments below each module in the design draft explain the design intent; the implementation should be based on the visual mockup.

## Design Tokens (Step 1: Modify `:root` in `styles.css`)

Replace/Add (Keep variable names, change values; add accent family):

```css
:root {
  --bg: #161826;            /* was #0d0f12 */
  --surface: #1b1e2c;       /* was #14171c; card background */
  --surface-2: #12141f;     /* was #1a1e25; input background / bar track / inset background */
  --hairline: #3f424d;      /* was #262b34; control border */
  --hairline-soft: #292b31; /* was #1d2129; card outer frame, row separator */
  --ink: #e9e9ed;
  --ink-2: #b2b6ca;         /* secondary text (was #98a1b0) */
  --mute: #75798c;          /* weak text (was #626b7a); for even weaker use #595d6c */
  --accent: #9184d9;        /* new: interaction / active / link / time cursor */
  --accent-text: #d2cefd;   /* text on accent / active text color */
  --accent-soft: #b5abfc;   /* one shade lighter (rating ↑, ultimate chip dot) */
  --accent-fill: #2b2741;   /* active segmented control background, chip background */
  --accent-line: #5d5294;   /* accent element border */
  --gold: #d9a842;          /* only kept for data semantics: ultimate border, kill window, defensive unused */
  --win: #7ac9a3;           /* was #4ade80, desaturated */
  --loss: #e08585;          /* was #f87171, desaturated */
  --font-ui: "Inter", system-ui, sans-serif;  /* needs import Inter 400/500/600/700 */
}
```

Rules (applied globally, not listed one by one):
1. **Numbers no longer use monospace fonts**: The usage of `--font-data` is completely replaced by
   `font-variant-numeric: tabular-nums` (supported by Inter), unifying the font to Inter.
2. **Active/interactive elements all use accent**, the gold color `--gold` only appears in: ultimate CD, kill window color band,
   "available but unused" data determinations. All buttons/tabs/timestamps with `color: var(--gold)` should be changed one by one.
3. **Two-level control forms**: Page-level tab = underline style (2px accent underline); intra-card switch = capsule segmented control
   (active state `background: var(--accent-fill); color: var(--accent-text)`).
   Existing `.rpt-view-tabs` (filled gold) should be changed to underline style; the active state of `.rpt-mode-seg` should be changed from
   `--gold-dim` fill to accent-fill.
4. **Font sizes converge to three tiers**: 11px (auxiliary) / 12.5px (body, tables) / 14px (headings).
   Remove usages of 9/10/10.5/11.5px (10px for badge corners can be retained).
5. **Intra-card dividers use fade-out at both ends**:
   `background: linear-gradient(90deg, transparent, var(--hairline) 48px, var(--hairline) calc(100% - 48px), transparent); height: 1px;`
6. Class colors (`gameConstants.ts CLASS_COLORS`) remain unchanged — data layer identity colors.
7. Focus state: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`

## Screens / Views

### 1. Report (Scheme 1c "Timeline Spine") — Largest change
Involves: `MatchReport.tsx`, `ReportHeader.tsx`, `Timeline.tsx`, `Meters.tsx`,
`DeathRecapCard.tsx`, `BurstLedgerCard.tsx` (remove standalone card), `vulnWindows.ts` (existing data).

**Layout (Top to Bottom):**
1. **Header Row** (replaces current `ReportHeader` 3-column score header + separate `.rpt-view-tabs` in 2 segments):
   Left: `Victory` (16px/600, --win) + `3v3 · Nagrand Arena · 4:52` (12px --mute);
   Right: Underline style 3 tabs "Report / Replay / AI Analysis" (13.5px, active 500 weight + 2px accent underline,
   inactive --mute). Player names/ratings no longer appear in the header (they are in the leaderboard).
2. **Main Card: Health Curve** (Full width, `--surface` card, padding 14px 16px):
   - SVG height 240, y-axis 100%/50%/0% grid lines (--hairline-soft), x-axis time ticks
     0:00/1:00/… (10px, #595d6c);
   - Kill window color band `rgba(217,168,66,.16)`, vulnerability window `rgba(224,133,133,.14)`;
   - Curve stroke-width 2, class color; death point: 5px circle (--surface bg, --loss stroke, inner ✕)
     + 9px name time label above;
   - **Replay cursor projection**: Draw an accent dashed line (3 3) here at the current moment of the replay view + time label;
   - **Window List** (Below SVG, one row per vulnBand):
     `3px vertical color bar (Gold/Red) | 0:42–0:55 | Kill Attempt → Zhaoming | Team Damage 812k · Mitigated by Penance Shield | ▶ Replay`
     Row styles: `--bg` background, --hairline-soft border, 7px border radius, 12px text, 6px line spacing, entire row clickable to jump to replay.
     Data source `deriveVulnBands` + outcome determination from `burstLedger`.
3. **Bottom two-column grid (1fr 1fr, gap 16px)**:
   - Left: **Leaderboard Card** (Keep `Meters` four-mode segmented control; row: 17px class glyph square
     (radius 4, class color bg, #10121c text) + name 12.5px + 8px high radius 4 progress bar + right-aligned value;
     line spacing 8px; enemy names --ink-2; filtering curve by clicking names behavior kept, hidden row = opacity .45 +
     strikethrough + glyph outline border);
   - Right: **Death Recap Persistent Column** (replaces current popover `DeathRecapCard`): When no deaths/unselected, show
     placeholder "Click ✕ on the curve to view death recap"; when content exists: card border
     `1px solid rgba(224,133,133,.33)`, title row + judgement capsule ("Unused: Guardian Spirit" gold text gold border,
     "Teammate could give but didn't" gray text) + event 5-column grid (Time 44px | Type 40px colored text: Damage--loss/
     Healing--win/CC--gold | Spell 1fr | Amount right-aligned | Source --mute), line spacing 5px.
     **No longer pushes the page down** (currently inserted into the document flow causing layout jumps).
4. **Burst Ledger**: Standalone card removed, its "Burst Alignment" data merged into the window list (outcome copy),
   "Interrupt Audit" merged into the expanded details of the stats mode table. If you want to be conservative, you can keep the ledger card first but change
   `.rpt-ledger-row` to a 4-column grid (Time 78px | Comp 220px | Target Result 1fr | Judgement 190px).

### 2. Match List (1e)
Involves: `MatchListRow.tsx`, `MatchListFilter.tsx`, `App.tsx` (list grouping), styles.css.

- **Row structure**: Remove WIN/LOSS text badges; win/loss = 2px color line on the left edge of the row (--win/--loss).
  First row: Map name 12.5px/500 + duration 11px --mute + rating 11px with rise/fall
  (`2145 ↑` rise = --accent-soft, `2139 ↓` fall = --mute).
  Second row: Both sides' spec glyphs (17px radius 4 squares, class color bg #10121c text, spacing 3px) +
  9px "vs" + right side time only shows `HH:MM` (tabular-nums). Row inner padding 9px 12px.
- **Date group header**: Today / Yesterday / M/D, 10px uppercase letter-spacing .1em --mute,
  right side daily summary `6 matches · 4-2` (#595d6c). Grouped by `startTime` local day.
- **Selected state**: Bright bg `#1e2130` + inner edge accent line
  (`box-shadow: inset 3px 0 0 -1px var(--accent)`), coexists with win/loss left edge line.
- **Filter bar**: Three controls unified 26px height, 7px border radius, same --hairline border; segmented control active =
  accent-fill; "Clear" is an accent text button, persistent on the right end (only shows when there are filters).
- Rating rise/fall needs the difference between adjacent matches: calculate during meta derivation (compare with previous match in the same bracket),
  if not available, do not show the arrow.

### 3. Replay (1f)
Involves: `ReplayView.tsx`, `GcdSwimlane.tsx`, styles.css.

- **Frames stick to both sides of the arena**: Arena column changed to grid `96px 1fr 96px` (left friendly frames column, middle SVG,
  right enemy frames column), frame card: 2px left edge (friendly --win / enemy --loss), name 11px, 4px health bar,
  10px percentage (color = 3 health tiers: >60% --win / 30–60% --gold / <30% --loss);
  Dead frames opacity .55 showing "✝ Dead + time"; bursting unit names have a 9px --loss "Burst"
  badge appended. Original `.rpt-replay-frames-row` below the arena is removed.
- **Control bar grouping** (inside one card, left to right):
  `⏸ Pause` (accent outline primary button) | Time `2:20.1 / 4:52` (right next to play button) |
  Progress bar (track 6px, played = accent 40% fill, thumb 3px bright bar; kill/vulnerability color band opacity
  increased to .4/.35) | Dampening capsule (--loss text+border) | 1px divider | Zoom +/− | Speed segmented control.
  Below, one line 11px #595d6c shortcut hint:
  `Space Play/Pause · ← → ±5s · Shift ±1s · ⌘+Scroll Zoom · Double-click Reset`.
- **GCD Swimlane**:
  - Background gets horizontal 5s dividing bands (`repeating-linear-gradient`, one 1px --surface line every 5s),
    ticks densified from 15s to 5s;
  - Time cursor 1.5px accent line + right end time badge (accent bg, --bg text, 9px, radius 3);
  - Ultimate chip: accent-fill bg + --accent-line border + 2px accent left edge +
    right end 9px "CD" (--accent-text); "Most recent GCD" border changed to gold (--gold),
    no longer conflicts with ultimate styles;
  - Swimlane header legend: `▮ Ultimate` persistent (11px).

### 4. AI Analysis (1g)
Involves: `StructuredAnalysisPanel.tsx`, `KeyMomentAxis.tsx`, `FindingsList.tsx`,
`ProComparisonVerified.tsx`, `CohortDimsTable.tsx`, `MatchHero.tsx` (remove).

- **Action area fixed at top**: `Re-analyze` (accent outline primary button) + EN/CN segmented control + status text
  "Cached · 3 findings · Highest severity high" + right end "Export ▾".
  `MatchHero` information is merged into this status text line.
- **Match Objective** bar: accent light background (`--accent-fill` 20% transparent) + --accent-line border card,
  objective as a capsule (--accent-text text + --accent-line border).
- **Timeline axis changed to single-sided left track**: grid `52px 1fr`; time column right-aligned 11px --mute; track = 2px
  vertical line (--hairline, bottom 48px fade-out), one 8px node circle per item
  (--bg bg + 2px event color border: kill window --gold / dead enemy --win friendly --loss /
  finding by severity). **Cancel alternating left/right** (delete `.rpt-axis-row.left/.right` logic).
- **Finding card**: max-width 64ch; severity = colored bg tag
  `HIGH · Target Selection` (10px/600 uppercase, HIGH: --loss text + `#e0858518` bg; MED: --gold;
  LOW: --mute); title 13.5px/500 inline; body 12.5px/1.65 --ink-2;
  action row: Evidence + `⏱ 1:20` evidence chips (11px outline button) + `▶ Replay this moment` (accent text);
  **Follow-up marks (✓/↻) moved to the top right corner of the card**.
- **Empty window collapse**: >30s interval shows a row 10.5px `⏱ 63s no key events — collapsed`, does not interrupt the track.
- **Cohort table**: 3-column grid per dimension `150px 1fr 120px`: Name | Distribution bar | Judgement.
  Distribution bar: 14px height, track --surface-2, p10–p90 = --hairline rounded bar, p50 = 1.5px tick,
  your value = 3px cursor (good --win / bad --loss / average --ink-2); judgement column
  `p64 · Above median` (same color as cursor, tabular-nums).

### 5. Stats (1h)
Involves: `StatsDashboard.tsx`, styles.css.

- **Title row**: `Stats` 14px/500 + character chips (active accent-fill capsule, with match count small text) +
  right end time segmented control (Today / 7 days / All).
- **Overview numbers band** (replaces three `.dash-stat` small cards): full-width radius 10 card,
  background `linear-gradient(135deg, #262a60, #353b80)` (the only saturated color block on the page),
  four grid numbers (34px/600 tabular-nums) + 1px `#ffffff22` vertical dividers:
  Matches | Win Rate (`58% · 39-28`, win ≥50% uses `#a8e6c4`) | Current Rating + 7-day change
  (`2145 ↑63`) | Median duration. **"Current Rating and Change" is new data**: take the personal rating of the most recent match in that bracket,
  subtract the most recent match before the start of the time range.
- **Rating curve**: Add x-axis date ticks and y-axis 3 rating tiers; endpoints of each bracket line get a dot +
  current rating label; series colors: 3v3 = --accent, Solo Shuffle = --win, others use
  `SERIES_COLORS` sequentially; legend moved to card header (12px color line + name).
- **Enemy comp table**: 3-column grid per row: spec glyph group | 8px win rate bar
  (≥55% --win / ≤45% --loss / in-between #9397ab) | `71% · 7 matches` (same color as bar + match count #595d6c).
  Sorted by match count; bottom description "Click row to go back to list and filter this comp". Old data prompt moved to card bottom 11px.
- **Most frequent mistakes**: Row = Title 12.5px/500 + `×9` count + ↻/✓ colored text (no border chip) +
  row end `Most recent match →` (accent text link).

### 6. Settings (1i)
Involves: `SettingsPanel.tsx`, styles.css.

- Inside each group card **3-column grid**: `130px 1fr auto` (Label | Value/Input | Action), gap 12px 16px,
  replaces `.settings-row` flex-wrap.
- Inputs unified: bg --surface-2, 1px --hairline-soft border, 7px border radius, padding 5px 10px,
  12px text.
- **API key row**: Input prepended with "Configured" capsule (--win text + 33% transparent --win border);
  "Save" normal outline button, "Clear" = red text-only button (--loss, no border).
- **In-place save feedback**: ✓ prompt (11px --win) shows inside the corresponding group title row, disappears in 2s
  (replaces `.settings-saved` at the top of the page).
- Below the "Backend" dropdown, add an 11px #595d6c explanation row:
  `Debug can switch to Claude CLI / agy (local), no network usage`.
- WoW directory path 12px --mute single-line ellipsis; "History logs" row description: `Duplicate imports are automatically deduplicated by match`.

## Interactions & Behavior
- All existing interactions kept: clicking names to filter curve, clicking color bands/evidence/ledger ▶ jump to replay (`handleSeekEvent`
  pipeline unchanged), stats table row expansion, shuffle round tabs, keyboard controls.
- New: Report window list row click = jump to replay at that window's start; death recap changed from "popover" to "right column persistent position"
  (state unchanged, render position changed); replay current moment projected on report curve (need to sync replay clock t to MatchReport at low frequency,
  or only show last position when switching back to report from replay).
- Hover: Button/row hover uses accent light color (`color-mix(in srgb, var(--accent) 12%, transparent)`
  bg or --accent border), no longer uses gold.
- Segmented control/tab switching without animation; cards have no transition requirements.

## State Management
No new global state. Changes:
- `MatchReport`: `recap` renders into right column instead of popover; optional new `lastReplayT` (projection cursor).
- `App`: List grouping by day is purely derived (`useMemo`), group summary is the same.
- `StatsDashboard`: New "Current Rating/Change" derived function (based on existing metas).

## Design Tokens Quick Reference (specific values used in mockup)
- Backgrounds: Page `#161826` / Card `#1b1e2c` / Input and track `#12141f` / Selected row `#1e2130`
- Borders: Card frame and row divider `#292b31` / Control outline `#3f424d`
- Text: `#e9e9ed` / Secondary `#b2b6ca` / Explanation `#9397ab` / Weak `#75798c` / Weakest `#595d6c`
- Accent: `#9184d9`, Text `#d2cefd`, Bright `#b5abfc`, Bg `#2b2741`, Border `#5d5294`
- Win `#7ac9a3` / Loss `#e08585` / Data Gold `#d9a842` / Stats Band `#262a60→#353b80`
- Border Radius: Card 8px / Control 7px / Chip 5px / Capsule 999px; Font Inter (numbers tabular-nums)
- Class colors unchanged: see `report/data/gameConstants.ts`

## Assets
No new image assets. Spec/class identifiers use existing glyph fallback scheme (`classGlyph` 2 letters + class color square,
changed to radius 4, text color `#10121c`); spec icon CDN (`specIconUrl`) can continue to be used, replacing the glyph square on success,
and keeping fallback on failure. Inter font needs to be imported in `index.html` or CSS
(Google Fonts, weights 400/500/600/700).

## Files
- `module-optimization-mockup.dc.html` — Design reference draft (open directly in browser; includes current reproduction and
  improved draft side-by-side for each module, with "Problem → Solution" comments for each). Report adopts **1c** from it; other modules adopt
  1e / 1f / 1g / 1h / 1i. 1a (report current reproduction) and 1b/1d are for comparison only, not to be implemented.

## Suggested Implementation Order
1. Tokens + Global Rules (half day, whole App color change but layout remains)
2. Settings 1i, Match List 1e (small, to verify new language first)
3. Stats 1h, AI Analysis 1g
4. Replay 1f
5. Report 1c (largest, do last; can drop "window list + death recap right column" first, then remove ledger card)
