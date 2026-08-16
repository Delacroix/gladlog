# Match Report UI Three Changes —— Implementation & Visual Review Handoff (2026-07-12)

> ⚠️ **Historical Document (2026-07-13).** This is the handoff for the initial version of the three changes (#3/#4/#5); afterwards, the UI underwent **overall redesign + multiple iterations** through design handoffs (e.g., View B unit sidebar was removed, arena redrawn with real map backgrounds, added GCD lanes, dual AI columns). For current state, see [`2026-07-13-report-ui-current-state.md`](./2026-07-13-report-ui-current-state.md); "fixture preview broken" mentioned in the text has also been fixed, `VITE_FIXTURE_MODE=1 npm run dev` is available.

Branch `worktree-report-ui-backlog`, one per-feature commit for each of the three UI requirements. Behavior has been verified with vitest (see below); **visual presentation is unverified**, handed off to another agent for review. This document is a complete handoff for the reviewer: what changed, how to run it, what to check for each item, and pending v1 tradeoffs.

## Commits

| SHA       | Requirement                             | Main Files                                                                   |
| --------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `82a2b21` | #3 Split AI analysis into standalone full-width Tab | MatchReport.tsx, styles.css, report.app.test.tsx                             |
| `ffb4680` | #4 Unit detail merge casts + important auras & player filter | UnitPanel.tsx, derive/casts.ts, styles.css, +3 tests                         |
| `57697dc` | #5 Replay Tab (2D movement simulation)  | ReplayView.tsx (new), derive/replay.ts (new), MatchReport.tsx, styles.css, +tests |

Each commit has been individually verified to compile + pass tests (intermediate states for #3 and #4 each passed typecheck + report tests; final state fully passes); the branch tip is byte-for-byte consistent with the independently verified final state, with no refactor drift.

## File Map

- `report/components/MatchReport.tsx` —— Top-level view skeleton. Added `View = "report" | "replay" | "ai"` three-state toggle (`.rpt-view-tabs`), replacing the previous right-side `SideTab(unit/ai)`.
- `report/components/UnitPanel.tsx` —— Unit details. Merged event stream + player dropdown (#4).
- `report/components/ReplayView.tsx` —— **New**, replay view (SVG arena + playback controls).
- `report/derive/casts.ts` —— **New** `deriveUnitTimeline()`, `auraCategory()` (#4).
- `report/derive/replay.ts` —— **New** `deriveReplay()` / `sampleAt()` / `pathUpTo()` / `deathPosition()` (#5, pure functions, unit tested).
- `styles.css` —— Style blocks for the three items (`.rpt-view-tabs` / `.rpt-ai-full` / `.rpt-unit-filter` / `.rpt-ev-aura` / `.rpt-cat` / `.rpt-replay-*`).

## How to Run and Inspect (For Reviewer)

**Path A —— Real Data (Recommended):** In `packages/desktop`, run `npm run dev` (electron-vite dev correctly binds env + preload, opening a real Electron window), select a match with **advanced combat logging** (replay requires x/y from `advancedSamples`; without them, replay page shows fallback notice "No position data").

**Path B —— Fixture Preview Without Real Data:** Currently **broken**, requires a patch before use (see details at end under "Fixture preview broken"). Do not take the "build static server + headless Chrome screenshot" route — that was proven to be a dead end.

## Item-by-Item: What Changed + What to Check Visually

### #3 AI Analysis Full-Width Tab (`82a2b21`)

- **Changes:** AI analysis was previously squeezed into a 330px narrow right sideTab; now elevated to a top-level view with a full-width container `.rpt-ai-full`, removing inner 420px max scroll height limit so long text can spread out. The right sidebar degenerates into pure unit details.
- **What to check:** Whether top three tabs (Match Report / Replay / AI Analysis) are clear and switch properly; whether AI analysis page structured analysis + pro comparison truly uses full width without long text squeezed in a narrow column.

### #4 Unit Details: Merged Stream + Player Filter (`ffb4680`)

- **Changes:** Original two separate tables "Casts" and "Aura Events" → single ascending chronological merged event stream (`deriveUnitTimeline`). Auras **only keep curated PvP categories** (importance judgment reuses `@gladlog/analysis` `SPELL_CATEGORIES`: CC / Root / Immune / Defensive CD / Offensive CD / Disarm / Interrupt), filtering noisy procs. Added player dropdown at panel top, sharing `unitId` with timeline clicks.
- **What to check:** Merged table readability (distinguishing casts vs auras: thin gold bar on left of aura rows + category badges such as CC / Immune / Defensive; `+`/`−` buff gain/fade); player dropdown lists all players, switching updates table and title in sync.

### #5 Replay 2D Simulation (`57697dc`)

- **Changes:** New top-level "Replay" view. Reconstructs 2D top-down movement from each unit's `advancedSamples` (x/y/hp). SVG arena: player = class-colored circle + faction border (friendly green / enemy red) + opacity scales with HP; play/pause, 1×/2×/4× speed toggle, timeline scrub; recent 6s movement trails, death ✕ markers, player legend, grid.
- **What to check:** Whether movement looks reasonable (coordinate mapping y inverted so North faces up); whether trails help read positioning; speed toggle/scrub feel; whether dead units disappear leaving ✕; whether legend is recognizable; fallback notice for matches without advanced combat logs.

## Design Tradeoffs Requiring Reviewer Decision

1. **Replay Coloring:** Circle = class color, border = faction color (friendly/enemy). Is this distinguishable enough? Should it change to pure two-tone faction colors, or add names/class icons?
2. **"Important Auras" Scope (#4):** Currently = all entries in curated `SPELL_CATEGORIES` set are displayed. User previously selected "all categorized"; confirm during review whether information density is appropriate (too much / too little), and whether to narrow down further using `PRIORITY_MAP`.
3. **Replay Trail Window:** Currently fixed to recent 6 seconds (`pathUpTo` default `windowMs=6000`).
4. **Replay v1 Not Done (Reserved for Refinement):** Cast markers, arena map background images, class color legend descriptions, pet/totem units, post-death ghosting. Data supports all of these; add on demand.

## Behavioral Test Coverage (Verified Parts)

Full suite: typecheck passes across all workspaces; desktop **126 tests** pass; monorepo fully green; lint 0 errors.
New / modified tests:

- `report.app.test.tsx` —— Top-level view switching (default report; click AI analysis full-width, click replay shows arena, returns properly).
- `report.casts.test.ts` —— `deriveUnitTimeline` merge / filter / ascending / empty + `auraCategory`.
- `report.components.timeline.test.tsx` —— Player dropdown lists all players + switch callback; merged stream title.
- `report.replay.test.ts` —— `deriveReplay` / `sampleAt` (interpolation / endpoint clamping / death cutoff) / `pathUpTo` (window trails / death freeze) / `deathPosition`.
- `report.talents.test.tsx` —— UnitPanel new `onSelectUnit` prop adaptation.

jsdom can only verify DOM structure and interactions, **cannot verify layout / animations / visual presentation** — which is precisely the part handed off for review.

## Appendix: Fixture Preview Without Real Data Broken (For Anyone Wanting to Fix Preview)

`VITE_FIXTURE_MODE` + `fixtureBridge.ts` is currently unavailable, full round explored on 2026-07-12:

1. **`fixtureBridge.ts` mock is outdated** —— Only has `matches.list/get`, missing `matches.page`. Since the windowed-pagination refactor, App calls `bridge().matches.page(...)` during mount, crashing immediately upon entering fixture mode.
   Patch (just add to `matches` mock):
   ```ts
   async page(opts: { before?: number; limit: number }): Promise<StoredMatchMeta[]> {
     const all = await gladlogMock.matches.list();
     const filtered = opts.before == null ? all
       : all.filter((mt) => mt.startTime < opts.before!);
     return filtered.sort((a, b) => b.startTime - a.startTime).slice(0, opts.limit);
   },
   ```
   (This branch **did not** touch `fixtureBridge.ts` — it was simultaneously modified on `feat/local-ai-backend`, avoiding conflicts.)
2. **`VITE_FIXTURE_MODE` is not passed into renderer** —— In `electron.vite.config.ts`, `renderer.root = "src/renderer"`, shell variables and package root `.env` are not exposed to `import.meta.env`; `electron-vite build` eliminates `if(import.meta.env.VITE_FIXTURE_MODE)` as dead code. `npm run dev` running in dev mode binds env normally.
3. Even if manually injecting full `window.__gladlogFixture` synchronously in `index.html` to bypass env, the built renderer still **stays blank and unmounted with no console errors** (bundle 200 / MIME normal), root cause undetermined — so do not waste time on headless build. To inspect actual appearance, please use `npm run dev` (Path A).
