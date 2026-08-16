# Report UI — Current State (2026-07-13)

The report UI evolved through "Initial 3 Views (#3/#4/#5) → Design Handoff Redesign (4 phases) → Multiple Iterations".
This document is the **single source of truth for the current state**. Earlier documents in this directory,
`2026-07-12-report-ui-design-brief.md` / `-review-handoff.md`, record the design process,
describing the state **prior to redesign**, and have been superseded by this document.

Code is located in `packages/desktop/src/renderer/src/report/`, and all styles are in `.../src/styles.css`.

## Top-Level: Three Views (Filled Gold Segmented Tabs)

A segmented control bar at the top of `MatchReport.tsx`: **Report / Replay / AI Analysis**.

## Report (`report`)

- Full-width, **no right-hand unit detail sidebar** (initial View B removed per design).
- **Meters Card** (`Meters`): Card header top-right contains "Meter Mode" + Damage / Healing / Damage Taken segmented control (mode switching moved into card header, no longer stacked as two rows with top tabs). Friendly names in `--ink` / enemy names in `--ink-2`.
- **Clickable row names** → select / unselect player to filter HP timeline below; unselected rows dim + strike through, with class-colored dots hollowed out.
- **HP Curve** (`Timeline`): Full-width HP timeline rendering only selected players + death markers.

## Replay (`replay`) — Arena + GCD Swimlane, 1:2 Layout

`ReplayView` = Left Arena : Right GCD Swimlane = **1 : 2** (CSS grid `1fr 2fr`, 8px gap).
Both share the same playback clock (`t` / `playing` / `speed` / `selUnits`).

**Arena:**

- Displays the **authentic minimap** for the arena based on `zoneId` (`arenaMaps.ts` stores world coordinate bounding boxes for 15 arenas; map imagery loaded at runtime from wowarenalogs CDN, not tracked in repo). Zones without map images fall back to an abstract grid. Coordinate system: aligned using real arena bounding box when image is present, otherwise fit to sample bounds.
- Units = Class-colored dot + team-colored border + 2-letter class glyph + HP bar below (color-coded by health) + player name; ~6s movement trail; leaves ghost + ✕ on death.
- Controls bar: Gold play/pause button + scrubber + clock + 1× / 2× / 4× speed control (full-width). Legend pills.

**GCD Swimlane (`GcdSwimlane`):**

- One column per player (206px); cast chips show only **spell name** (+ gold major CD badge), **target shown in hover tooltip title**; collision avoidance stacking (dense without overlapping); gold time cursor spanning across all columns; fully bright when paused, future actions dimmed during playback; player chips toggle column visibility; vertical scrolling + follows cursor during playback.

## AI Analysis (`ai`)

Two columns: Left findings severity color cards (high/med/low left border, 2-line collapsed + expand/collapse, ~72ch reading measure) + Right cohort "vs your cohort" sticky card (percentile).

## Local Preview / Iteration

- **`npm run dev:ui`** (port 5199) — Pure browser report rendering with HMR, no Electron required; fixture dropdown toggles between: real 3v3 (trimmed, anonymized) / synthetic / complete real match (local `dev/local`, gitignored). See `.claude/skills/run-ui`.
- **`VITE_FIXTURE_MODE=1 npm run dev`** — Real Electron App + fixture preview without real data (fixed, runs full App).

## Data

- `test/fixtures/real-match-sample.json` — Real 3v3 (anonymized, trimmed to first 90s), committed for rendering tests (`report.realmatch.test.tsx`).
- `dev/local/full-match.json` — Complete real match (real names, gitignored, local only).

## Key Files

`report/components/`: `MatchReport`, `Meters`, `Timeline`, `ReplayView`, `GcdSwimlane`, `UnitPanel` (now only used in direct tests / reserve), `StructuredAnalysisPanel`, `ProComparisonVerified`, `FindingsList`.
`report/derive/`: `summary`, `meterRows`, `timeline`, `casts` (`deriveUnitTimeline` / `isMajorCd`), `replay`.
`report/data/`: `gameConstants` (`classColor` / `classGlyph`), `arenaMaps`.
