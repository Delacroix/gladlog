# UI review adoption (2026-08-21) — design

Status: **proposal, awaiting user approval**. Branch `worktree-ui-review-2026-08-21`.

Source: an external UI review produced by rendering real games through a
recreation of the report UI (the reviewer's own `gladlog-data/derive.js`, with
analysis predicates marked APPROX and layout inferred from `styles.css`). The
review lists four things that hold up and eight improvements. This document
grounds each of the eight in the actual renderer code, corrects the premises
the recreation got wrong, and states what we adopt, reshape, or decline.

## Premise corrections (read first)

The recreation is approximate, and four of the eight suggestions rest on a
premise the real code does not share. These change the shape of the work, not
just the wording:

| #   | Reviewer premise                                                | What the code says                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | "~9.8k rows/round, casts ~70%, virtualize the table"            | Table is **already windowed** (`EventsPanel.tsx:204-206`, `ROW_H=22`, `OVERSCAN_ROWS=40`, landed `eee70066` — 48k display rows → ≤108 resident). On the real fixture casts are **4.9 %** of rows; **heal 56 %** and **aura 23 %** are the flood, and aura/tick floods are already collapsed by `groupEventRows`. |
| 6   | "Spec icon alone could do all three jobs (class, team, name)"   | Spec/class colour cannot carry **team**: mirror comps put the same spec on both sides; `TeamDot.tsx:3-16` documents why team is a separate channel. Replay and the swimlane already solve this with a **side ring** on the icon (`ReplayView.tsx:820-843`, `GcdSwimlane.tsx:83-95`).                             |
| 8   | "you already do this with sampleN in cohorts" (`cohortDims.ts`) | `cohortDims.ts` has no floor. The real pattern is `cellLookup.ts:62` (`sampleN >= nFloor` → suppress entirely) + `ProComparisonVerified.tsx:405` (print N when shown). And `N_FLOOR = 30` is **hand-copied** in `compare.ts:41` and `buildCorpus.ts:16` — an unregistered shared-predicate violation.            |
| 2   | "default to 只看我方 + enemy-on-hover"                          | `只看我方` **exists** (`Timeline.tsx:719-747`). It cannot be defaulted on: `hidden` is persisted, shared with the Meters leaderboard, and pre-filling it kills the first-click-solo branch (`Timeline.tsx:712-718`, `MatchReport.tsx:619-624`).                                                                  |

Also: the renderer has **no i18n layer** — all chrome strings are zh literals
(`aiLanguage` only steers the coach reply). New copy follows that convention.

## Numbers gathered for this proposal

Dispel classification, full local library (1095 matches, 149,935
`SPELL_DISPEL`), predicate = _same source emitted `SPELL_CAST_SUCCESS` with the
same spellId within ±1 s_:

- cast-matched **78.1 %**, not matched **21.9 %**; per-match proc share
  p50 = 0.18, **p90 = 0.49** (926 matches with ≥20 dispels).
- Cleanse the Weak `199427`: **5,036 events, 0 % cast-matched**, removes
  减速药膏/致伤药膏/恶性病变 — exactly the reviewer's round. Other 0 %
  spells: 幻隐 114239 (4,092), 火焰吐息 357209 (3,469), 喷流 462820, 雷霆之爪
  378076, 紧急药膏 459521, 主人的召唤 357148, 荒野医疗 384784, 广布圣言：自由
  199508, 疾风步 365080, 旅行形态 165961.
- The predicate is near-bimodal: every cleanse/purge/steal spell sits at
  99–100 %, every proc at 0 %; the only mixed spells (20–80 %) are six
  form-shift / rider spells (熊形态 30 %, 枭兽形态 24 %, 化身 29 %, 深呼吸
  57 %, 治疗绷带 75 %, 剑刃风暴 43 %) — all already in eval's
  `MOVEMENT_ROOT_BREAK_DISPEL_IDS` or the same family.
- Known edge: 群体驱散 has two ids — the cast `32375` (1,837, 100 %) and an
  effect id `32592` (682, 0 %); id-only matching would misfile 0.45 % of all
  dispels as procs. Matching on spellId **or spellName** of the same source's
  cast closes it without a list.

Script: `scratchpad/dispelScan.mjs` (throwaway; the production predicate is
specified below and will be re-measured with the same script after landing).

## Decisions

Legend: **ADOPT** as suggested · **RESHAPE** adopt the goal, different
mechanism · **DECLINE** with reason.

### 1. First-glance story — RESHAPE (hero line yes, overflow menu yes, no new "killer" fact)

Current order on the report tab (`MatchReport.tsx:650-893`): head row
(tabs + `ReportHeader`) → `MatchArcLine` → `KpiChips` → toolbar (TimeRangeBar,
AI 分析此段, 复制 Markdown, 导出图片, 报告问题) → Timeline → … The three
workflow buttons sit in the reading path at `:716-757`.

- **Overflow menu**: move 复制 Markdown / 导出图片 / 报告问题 into a `⋯`
  button at the right end of `.rpt-toolbar-row`, reusing the existing
  `role="menu"` / `aria-haspopup` / outside-click pattern from
  `StructuredAnalysisPanel.tsx:778-830`. `AI 分析此段` stays visible (it is
  reading, not workflow). Preserve `data-testid="bug-report-btn"` on the menu
  item so `MatchReport` tests and the bug-report modal keep working.
- **Hero line**: fold the existing facts into one line directly under the
  head row, replacing the separate `ReportHeader` meta row:
  `败北 · 3v3 · 回合 2/6 · 纳格兰 · 2:14` + `终结 Healer 1:32 ▶` (from
  `KpiChips` `lastDeath`, `KpiChips.tsx:36-41`) + `转折 0:41 ▶ Rogue's Cloak`
  (from `IMatchArcPhase.turningPoint`, `matchNarrative.ts:189-199`). 终结
  leaves `KpiChips`; the other four chips (失误/爆发窗/打断/驱散) stay.
  `MatchArcLine` keeps its per-phase buttons.
- **Declined inside this item**: a "killed by X's Y" finisher. No
  killing-blow predicate exists anywhere (`deathRecap.ts` has the event
  stream but no "cause" field); inventing one is a new analysis fact that
  would need its own gate and prompt parity. 终结 = last death + seek is the
  honest version of the same line. Also note turning points exist only for
  matches ≥ 90 s and only for early/mid phases (`matchNarrative.ts:229-256`,
  `:370-375`) — the hero renders the slot empty rather than inventing one.

Touches every `report-*` and `video*` visual baseline (head row is outside
the view switch) and `e2e/exportImage.spec.ts` (full-page height).

### 2. HP curve saturation — RESHAPE (plateau fade + hover focus; no default filter)

Mechanism of the complaint: all 100 % samples land on `y(1)=PAD.t=18`, the
same pixel as the 100 % gridline; downsampling (`timeline.ts:38-72`) is a
no-op under 2,320 points and is deliberately anti-culling.

- **Plateau fade**: per unit, build two paths from the same samples — the
  full path at `opacity .25` and the sub-plateau runs (hp < 99.5 %) at full
  opacity on top. Nothing is removed (faithfulness: sample count and death
  markers unchanged); the five ropes at 100 % recede visually, the curve
  that is actually moving stays crisp. Threshold constant exported from
  `derive/timeline.ts` so the test and the renderer share it.
- **Hover focus**: hovering a legend entry or a curve sets a transient
  `focusUnitId` (local state, not lifted — same rule as the replay clock);
  every other curve and its death marker get `.rpt-tl-dim`. Works for enemy
  and friendly alike, which subsumes "enemy-on-hover". Keyboard: legend
  buttons already exist; focus-visible triggers the same class.
- **Declined**: "don't draw segments at 100 %" (hides data; contradicts the
  `downsampleMinMax` contract) and default `只看我方` (see premise table).
  Bands / dampening lane / pressure lane stay always-on — the review did not
  show them being the problem once the ropes recede; revisit after baselines.

### 3. Auto-proc dispels — ADOPT via a shared predicate (split, not /min)

Today every dispel surface counts `reconstructDispelSummary`'s
`allyCleanse + ourPurges + steals` with **no** filter on the dispelling spell
(`dispelAnalysis.ts:1198-1207`, `:1293-1319`): KPI chip
(`KpiChips.tsx:52-54`), tab label (duplicate reducer,
`EngagementPanel.tsx:92-95`), per-player table (`statsTable.ts:120-127`),
dashboard rows (`dispelDash.ts:128-141`), prompt `[MINOR DISPELS]` fold
(`matchTimeline.ts:1944-1990`). The only proc-filtered consumer is eval's
coverage denominator (`coverageManifest.ts:105-134`, 25-id hand list), which
neither analysis nor desktop import.

- **Predicate** `classifyDispel(event, casts): "deliberate" | "proc" | "rider"`
  exported from `packages/analysis/src/utils/dispelAnalysis.ts` and stamped on
  `IDispelEvent` as `dispelKind`:
  - `proc` — no `SPELL_CAST_SUCCESS` from the same **raw source GUID**
    (`action.srcUnitId`, not the merged owner) with the same spellId **or**
    spellName within ±1 s (list-free; measured bimodal above). The cast set
    is built from `spellCastEvents` of **all** units including pets —
    `mergePetEvents` (`parser-compat/convert.ts:508-527`) merges only
    damage/heal/absorb into the owner, so a Felhunter's Devour Magic cast
    stays on the pet unit and matches its own pet-sourced dispel (measured:
    `19505` n=2,573, 100 % cast-matched, 0 player-sourced).
  - `rider` — cast-matched but the dispelling spell is in
    `MOVEMENT_ROOT_BREAK_DISPEL_IDS`, **moved** from eval into analysis and
    imported back by `coverageManifest.ts` (one list, one owner). The list's
    completeness check becomes a pinned script in `packages/eval/scripts/`
    (the scan above, both directions: unlisted spells at 0 % cast-match and
    listed spells with 0 corpus occurrences), per the Curated-List rule.
  - `deliberate` — everything else.
- **Consumers**: `deriveDispelDash` exposes `deliberate` and `proc` counts per
  row; `KpiChips` and `EngagementPanel` both read one new
  `dispelDash.totals.friendlyDeliberate` (kills the duplicate reducer); chip
  renders `驱散 12` with `+80 被动` as a muted suffix when procs > 0;
  `DispelDashboard` gets a 被动 column; `StatsTable` 驱散 column uses
  deliberate only. Prompt side: the `[MINOR DISPELS]` fold labels proc groups
  `(passive)` so the model stops reading 92 cleanses as decisions — same
  predicate, so gate and prompt cannot drift.
- **Verification** (before/after, same criterion): re-run `dispelScan.mjs`
  against the production classifier on the full library — expect the
  deliberate set to equal the cast-matched set minus riders (78.1 % → report
  exact), and the reviewer's round to read `驱散 N (+~80 被动)`.
- **Declined**: `/min`. It adds a rate on top of a polluted count; the split
  fixes the pollution. Interrupts already have `/min` in `StatsTable` if a
  rate is wanted later.
- Predicate-index: new row for `classifyDispel` + `MOVEMENT_ROOT_BREAK_DISPEL_IDS`
  (analysis ↔ eval ↔ desktop), both language files + `predicateIndex.test.ts`.

### 4. Round pills wrap — ADOPT (CSS + narrow-mode dots)

Cause: `.rpt-shuffle-seq` has no rule of its own — its `<i>` pills are inline
text and wrap as text; `.rpt-shuffle-head` has no `flex-wrap`; pills use
`margin-right` not `gap` (`styles.css:1570-1598`). The app's window floor is
900 px (`windowState.ts:27`), so < 1000 px is reachable with the 292 px
sidebar.

- `.rpt-shuffle { container-type: inline-size }`; `.rpt-shuffle-head
{ flex-wrap: wrap; row-gap: 4px }`; title `flex: none; white-space: nowrap`;
  `.rpt-shuffle-seq { display: flex; flex-wrap: wrap; gap: 3px }`.
- `@container (max-width: 640px)`: pills drop to `N` on the W/L-tinted
  background (text `R`/` · W` hidden, `title`/`aria-label` keep the full
  label). First container query in the codebase — acceptable, Electron's
  Chromium supports it.
- Tests: extend `report.app.test.tsx` to a **6-round** shuffle (today max is
  3); add a `report-shuffle` visual scene (none exists). Honest gap: QA
  viewports start at 1280, so the < 1000 px regime stays outside baselines.

### 5. Events default lens — RESHAPE (preset yes; virtualization already done)

- Add a **preset row** above the filter row: `关键 (damage · interrupt ·
dispel · death)` | `全部`, each with its live row count so nothing is hidden
  silently. Wired through the existing `kinds` state; `KindFilter` popover
  unchanged.
- **Default = 关键** on a fresh open. The B2 provenance path already clears
  kinds to guarantee the target row is visible (`EventsPanel.tsx:310-325`),
  so seeks are unaffected. No persistence (consistent with every other
  filter on the panel).
- **The preset is the baseline, not a filter** (AGY-caught): today
  `activeFilterCount` counts `kinds.length > 0` (`EventsPanel.tsx:520`) and
  `清除筛选` runs `setKinds([])` (`:530`), so a populated default would boot
  with "清除筛选(1)" lit and clearing it would silently flip to 全部.
  Export `DEFAULT_EVENT_KINDS` from `derive/eventsView.ts`; the kinds
  dimension counts as active only when `kinds` differs from the default set,
  and `清除筛选` restores the default. 全部 is an explicit preset button.
- Tests: `report.eventscolumns.test.tsx:202` (全清复原) and
  `report.eventsview.test.tsx:181-206` assume the unfiltered baseline —
  adjust to click 全部 first; derive-level conservation tests untouched.
- **Dropped from scope**: "virtualize the table" — done since `eee70066`.

### 6. Meter identity channels — RESHAPE (one icon with side ring; fix the grid)

Two causes, the reviewer named one. The identity block is a fixed
`150px 1fr 100px` grid (`styles.css:467-473`); at 1440 px with the default
sidebar the bar track is ~77 px of a ~347 px row.

- Replace glyph chip + `TeamDot` with a single 17 px **spec icon with the side
  ring** (`MatchListRow.tsx:35-57` `SpecDot` for the icon + fallback glyph;
  `sideRing` from the swimlane/replay for team). One element carries
  class (fallback colour), spec (icon), team (ring). Name stays.
- `meterRows()` copies `specId` from `UnitTotals` into `MeterRow`
  (`meterRows.ts:44-58`) — currently absent.
- Grid → `minmax(88px, 32%) minmax(60px, 1fr) auto`; value column
  `min-width: 64px`. The `60px` floor on the bar track keeps it from
  collapsing at narrow widths (AGY-caught).
- Keep `.rpt-meter-row` / `.rpt-meter-bar` / `.rpt-meter-value` untouched —
  `faithfulness.ts:17-64` queries them positionally and `verify:vision`
  runs it.
- Icon is async (`useIconDataUrl`) and Meters re-renders on every replay
  tick. Rows are currently mapped inline (`Meters.tsx:125`), so the hook
  cannot be called there (rules of hooks — AGY-caught): extract a
  `<MeterUnitRow>` component that owns the hook and is `React.memo`'d on
  `(row, side, off)`.

### 7. Demo analysis on the AI tab — ADOPT (ship the fixture, fenced)

The "text wall" is four stacked cards each showing one grey sentence
(`CoachChatCard.tsx:165-178`, `StructuredAnalysisPanel.tsx:46-47`,
`ProComparisonVerified.tsx:497`). The demo already exists:
`fixtureBridge.ts:64-100` `sampleAnalysis` (3 findings, one deep-dive, ~1.5 KB,
anonymised by construction, tree-shaken out of prod today).

- Move `sampleAnalysis` to `report/data/demoAnalysis.ts`; `fixtureBridge`
  imports it (no drift between dev scene and prod demo — the `report-ai`
  visual baseline is literally this demo).
- When `!isBackendAvailable` and no cached result, the hero CTA row gains
  `看一个演示分析`. Clicking renders the findings through the normal
  `rpt-ai-body` with a persistent banner `演示数据 · 与本场无关 · 设置 →`
  and `data-testid="ai-demo-banner"`.
- **Fence** (the repo already treats fake findings beside a real match as a
  hazard — `dev/main.tsx:423-445` strips them in blind-review mode):
  demo state is component-local, never written to the analysis cache, never
  shown to `CoachChatCard`, cleared the moment 分析 is clicked or the match
  changes; finding ▶ seeks are disabled in demo mode (they point at events
  that do not exist in this match). Export buttons hidden in demo mode.

### 8. Small-N honesty in 战绩 — ADOPT (floor + counts-first), plus a drive-by

Three render sites share one formatter `winPct` (`StatsDashboard.tsx:53-54`):
KPI tile (already captions `8-4`), comp rows, zone rows. No floor anywhere;
a comp seen once draws a full green 100 % bar. Note `rateGames` counts
shuffle **rounds** while 场次 counts matches — which is how "12" and "2"
coexist.

- Two floors, not one (AGY-caught unit mismatch): `bumpComp`
  (`dashboard.ts:123-157`) counts **matches** for 3v3 but **rounds** for
  shuffle, and 20 matches against one exact enemy comp is rare in a personal
  library — a single `20` would grey out nearly every comp/zone row.
  Export `RATE_MIN_N_ROW = 5` (comp/zone rows) and `RATE_MIN_N_TOTAL = 20`
  (the 胜率 tile, whose `rateGames` is already round-granular for shuffle)
  from `components/dashboard.ts` (the derive owner); register both in the
  predicate index's Report UI section. Values are priors for the user to
  tune.
- Below the floor: tile shows `8-4` as the large numeral and `67%` demoted
  to the caption; comp/zone rows show `3-1` in place of the percentage, the
  bar is drawn in neutral grey (no win/loss tint via `rateBarColor`).
  At/above the floor: today's layout.
- Tests: none assert win-rate text today — add unit tests for the formatter
  at N=19/20 and the tile swap; four `dashboard*.png` baselines move
  (`DEMO_METAS` is 12 matches → below floor, so the scene now shows the
  counts-first layout).
- **Drive-by (same rule, found while grounding this)**: `N_FLOOR = 30` is
  declared twice (`compare.ts:41`, `corpus-tools/scripts/buildCorpus.ts:16`).
  Export once from `packages/analysis` `cellLookup.ts`, import on both sides,
  add the predicate-index row. Out of the UI scope strictly, but it is the
  exact class CLAUDE.md forbids and costs one commit.

## Sequencing (smallest blast radius first)

1. **4** pills (CSS + test + scene) · **8** small-N (+ `N_FLOOR` drive-by)
2. **3** dispel predicate (analysis → eval → desktop; re-scan for numbers)
3. **6** meters · **5** events preset · **7** demo analysis
4. **1** hero/overflow · **2** HP plateau/hover — last because they move
   every report baseline; regenerate baselines once via `visual-baseline.yml`
   after both land.

Each item is its own commit with before/after under the same criterion where
a number exists (3, 8, 6's bar-width arithmetic, 4's 6-round test).
Push gate: `npm run presubmit`.

## What we are not doing

- Killing-blow / death-cause fact (1) — new predicate, not a UI change.
- Hiding 100 % segments or defaulting 只看我方 (2).
- Dispel `/min` (3).
- New QA viewport tier below 1280 px (4) — separate decision.
- Table virtualization (5) — already shipped.
- Collapsing team identity into class colour (6).

## AGY debate outcome (Gemini 3.1 Pro, 2 rounds, final STANCE: CONCEDE)

Round 1 stance PARTIAL with four concrete objections; round 2 CONCEDE.

| Objection                                                                                                                                               | Outcome                                                                                                                                                                                                                                                            | Where it landed |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| (a) Pet dispels (Felhunter Devour Magic, Imp Singe Magic) are merged into the owner, so "same source" cast-match would misfile every pet dispel as proc | **Refuted with evidence**: `mergePetEvents` merges only damage/heal/absorb; `action.srcUnitId` keeps the pet GUID (`dispelAnalysis.ts:1257`); scan shows `19505` 100 % cast-matched. Spec now keys the cast set on raw `srcUnitId` across all units. AGY accepted. | §3              |
| (b) A populated default `kinds` lights `清除筛选(1)` and clearing it silently reverts to 全部 (`EventsPanel.tsx:520/530`)                               | **Conceded** — preset is the baseline; `DEFAULT_EVENT_KINDS` exported; active-count compares against it; 清除 restores it.                                                                                                                                         | §5              |
| (e) `useIconDataUrl` cannot run inside the inline `rows.map` (rules of hooks); `1fr` bar track can collapse                                             | **Conceded** — `<MeterUnitRow>` extraction; `minmax(60px, 1fr)`.                                                                                                                                                                                                   | §6              |
| (f) One `RATE_MIN_N=20` greys out nearly every 3v3 comp/zone row (`bumpComp` counts matches for 3v3, rounds for shuffle)                                | **Conceded** — split `RATE_MIN_N_ROW=5` / `RATE_MIN_N_TOTAL=20`. AGY also argued the tile's mixed round+match denominator is correct (each shuffle round carries ~one match of rating weight), so the tile keeps a single 20.                                      | §8              |

Bets (c) demo fence and (d) plateau fade / hover focus drew no objection.
