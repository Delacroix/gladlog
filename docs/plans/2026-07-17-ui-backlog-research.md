# UI Backlog #6–#11 Detailed Research (2026-07-17)

> Code-level verification + design decision records for `app-feature-backlog.md` #6–#11.
> For each item, **Research Findings** are listed first (facts actually verified in the two repositories, including reversals of original backlog assumptions),
> followed by **Design Decisions** (with options and recommendations where real choices exist). Implementation follows this document as the source of truth, indexed by backlog items.

## Cross-Cutting Findings (Read this first; all three reversed/refined architectural assumptions in the backlog)

1. **The renderer is already importing `@gladlog/analysis`** — `report/derive/casts.ts` uses
   `SPELL_CATEGORIES`, and `UnitPanel.tsx` uses `getTalentNames` (package.json dependencies
   only lists parser, resolved via workspace + bundled with Vite, an established pattern). Therefore, the correct architectural rule is not
   "the renderer cannot touch analysis", but rather: **Pure data / pure function exports (`SPELL_CATEGORIES`,
   name tables, icon tables) can be directly imported by the renderer; analysis functions that consume unit structures** (which have the
   parser-compat legacy shape, whereas the renderer doc has the new parser shape) **must be computed on the main side and passed
   over IPC**. Predicate sharing rules remain: neither side is allowed to duplicate constants.
2. **Half of the evidence-chain jumping for #8 already exists**: findings JSON is structured as
   `RawFinding{ eventIds, severity, category, title, explanation }`, and the event menu is
   `CandidateEvent{ id, type, t(seconds), unitNames, spell?, facts }`
   (`analysis/src/analysis/types.ts`); `FindingsList` already has an Evidence button →
   `activeEventIds` → `TimelineStrip` (24px strip, clickable markers, title with `t`).
   **What's missing is just cross-view interaction**: strip/Evidence → switch replay + seek + swimlane highlighting. The workload is
   half of the original backlog estimate.
3. **The true cost of #9 is data, not UI**: The icon pipeline is connected (bridge → main `iconCache` →
   `wow.zamimg.com/icons/large/<iconName>.jpg`, disk cache + dataURL return), but
   **no spellId→iconName mapping exists in the entire repo** — currently only talents have icon names
   (`talentNames.ts`), `t.icon` in UnitPanel is a talent, not a spell; SpellIcon
   always falls back to the initial letter. #9 is blocked on a mined table (via update-wow-data /
   game-data pipeline, following the `spellEffectGenerated` pattern).

## #6 Death Recap

**Research Findings**

- analysis contains `deathOutcomeAnalysis.ts` (determination of immune ability availability at the moment of death, including CDR/reset
  mechanics, LoS/range predicates), prompt-side death narratives in `matchTimeline.ts` / death-trace gatekeeper
  predicates have been audited (0/3733). Recap does not need to invent any predicates; everything is already available.
- The rendering test fixture `real-match-sample.json` **contains 1 death** — testable directly in dev:ui.
- The main side already has a per-match caching pattern: `<matchesDir>/<matchId>/analysis.json` in `analysis.ts`.

**Design Decisions**

- **Compute location**: main IPC (`report:deathRecap(matchId)`), passing through analysis predicates after internal
  parser-compat conversion. (Alternative: renderer computes on-the-fly from new doc — Rejected: would spawn a second set of death
  predicates, reintroducing the double-predicate issue from the audit.)
- **Output shape** (v1, pragmatic sufficiency):
  ```ts
  interface DeathRecap {
    unitId: string;
    unitName: string;
    deathT: number; // ms
    events: Array<{
      t: number;
      kind: "dmg" | "heal" | "cc" | "def_used";
      spell: string;
      amount?: number;
      srcName: string;
    }>; // 10s before death
    healerState: { name: string; ccdBy?: string; casting?: string } | null;
    defensivesUnused: string[]; // available but not pressed (deathOutcomeAnalysis determination)
  }
  ```
- **UI placement**: Right-side drawer card (overlay), does not occupy persistent layout — opened by clicking the `Timeline` death
  marker in report view; can also open from the death ✕ in replay view (v2). Bottom of card has "Replay This Moment" → `setView("replay")` +
  seek(deathT − 8s) (see #8 for seek mechanism, shared between both items).
- **No caching**: recap computation takes milliseconds; computed on demand, not written to disk.
- **Testing**: main unit test (fixture death asserts defensivesUnused) + dev:ui manual testing.

## #7 Match List Rich Rows

**Research Findings**

- meta is forged in `MatchStore.store()`, **where the complete GladMatch is available in hand** (units contain
  spec/class/rating — `deriveRoster` is extracted from the same doc) → adding fields has zero extra IO.
- Index = JSONL append + per-directory `meta.json` fallback rebuild path already exists (in `init()`).
- zone names: `ARENA_MAPS` has bounding boxes for 15 maps, but **names only exist in comments**; legacy repo
  `zoneMetadata.ts` is a complete table of 17 `{id, name, ...}` entries, names can be ported directly.
- spec icons: `CombatStubList/bits.tsx` in legacy repo uses a specId→zamimg icon name static table for `TeamSpecs`→`PlayerIcon` —
  table can be ported, loading uses existing iconCache (same pipeline as #9,
  but spec table is only dozens of rows, **proceeding ahead without waiting for #9's mining pipeline**).

**Design Decisions**

- **New meta fields (all optional)**: `durationS: number`, `avgRating?: number`
  (friendly team average), `teams?: [Array<{specId: string}>, Array<{specId: string}>]`
  (only stores specId, looked up during rendering; does not store name/rating details since unused in rows).
- **Legacy data compatibility**: Rendering fallback (no teams → current plain text style); **no automatic migration** —
  DevPanel adds a "Rebuild Index" button (reads match.json across directories to reforge meta, one-off, user-initiated).
  (Alternative: auto-migrate during init — Rejected: uncontrollable startup IO storm.)
- **Row layout**: Two rows — top row: win/loss color bar + map name + duration + rating badge; bottom row:
  friendly spec icon group vs enemy group. Shuffle row kind badge preserved.
- **Testing**: Add missing-field fallback assertions alongside `App.pagination.test.tsx` + store() new field unit tests.

## #8 Evidence Chain Jump + KILL WINDOW/VULNERABLE Annotations

**Research Findings**

- See Cross-Cutting Finding 2: Closed loop within AI view is complete; `CandidateEvent.t` is in seconds, `unitNames` is an array of
  names (not unitId — cross-view highlighting needs name→unitId matching, ReportSource units have names,
  in-match name collision probability is negligible).
- **Replay clock `t` is local state in `ReplayView`** (`useState(startTime)`, along with
  playing/speed/selUnits), not in `MatchReport`; view toggle state `view` is in MatchReport.
- KILL WINDOW data: main already imports analysis (same conversion pipeline as when `analysis.ts` builds prompt),
  `computeOffensiveWindows` outputs `bursts` + span; after the 2026-07-17 redesign,
  spans are short and honest (p50 14s).

**Design Decisions**

- **seek mechanism**: `MatchReport` holds `seekReq: { t: number; nonce: number } | null`,
  passed to `ReplayView`, whose `useEffect` consumes by nonce (setT + pause).
  (Alternative: lift entire playback clock to MatchReport — Rejected: lifting
  hot-path state would cause all three views to re-render with every tick.)
- **Entry points**: (a) `TimelineStrip` active state adds a small "Jump to Replay" button; (b) findings
  card Evidence click shows the same button at the same position. Clicking → `setView("replay")` + seek(t) +
  `setSelUnits(matched from unitNames)`.
- **Swimlane highlight**: `GcdSwimlane` receives optional `flashT?: number`; during rendering, chips with |chip.t − flashT|
  < 2s get a flash class, fading out after a few seconds (pure CSS animation, no added state machine).
- **Window color bands**: main IPC `report:windows(matchId)` →
  `{ vulnSpans: [{from,to,targetName}], bursts: [{from,to,targetName,damage}] }`
  (main computes using `computeOffensiveWindows`/`KW_*`, renderer only draws); drawn on the
  **replay scrubber** (primary) + TimelineStrip background (secondary). burst = semi-transparent gold,
  vulnerable = muted red; hover title includes target + team damage.
- **Testing**: seek nonce consumption unit test; Evidence→replay jump integration test on fixture (dev:ui).

## #9 GCD Swimlane Spell Icons

**Research Findings**

- See Cross-Cutting Finding 3: Pipeline works, mapping is missing. `CastRow`/`UnitEvent` have no icon field; iconCache
  fetches from zamimg by icon name, with disk cache + failure set + fetch limit.

**Design Decisions**

- **Prerequisite data task**: `update-wow-data` pipeline adds artifact `spellIconsGenerated.ts`
  (spellId→iconName). Scope control: all IDs in SPELL_CATEGORIES + top-N cast IDs from corpus
  (N chosen based on rendering needs, expected hundreds of rows, not aiming for full DB). This is the first PR for #9; UI is the second.
- **Rendering**: `deriveCasts` adds `icon?: string` (looked up from generated table); `GcdSwimlane` chips with width
  ≥ threshold render icon+name, otherwise icon-only; `SpellIcon`'s initial letter fallback guarantees missing table entries.
- **Performance**: Renderer side memos `Map<iconName, Promise<dataURL>>` (bridge already has disk
  cache; this layer prevents hundreds of IPC round-trips for the same icon name).
- **Testing**: Swimlane rendering tests add "no icon name → initial letter block" assertions.

## #10 Stats Table (Interrupts / CC / Dispels)

**Research Findings**

- Determinations are entirely in analysis (interrupts classification — 7 IDs just added on 2026-07-17, CC duration logic
  `ccSecondsInWindow` pattern, `dispelAnalysis`), signatures all take legacy unit shape → main side.

**Design Decisions**

- **IPC**: `report:statsTable(matchId)` → one row per player
  `{ unitId, kicksDone, kicksTaken, ccTakenS, ccTakenPct, ccDoneS, dispels, purges }`
  (including /min computed by renderer, avoid storing redundancy in two places).
- **UI placement**: `Meters` card scoreboard mode segment control (Damage / Healing / Damage Taken) adds a 4th item "Stats"; switching
  replaces entire card with `StatsTable.tsx`; column structure copies table from legacy repo `CombatCC` (53 lines, verified information
  density) + dispel columns.
- **Detailed breakdown deferred to v2** (row click expands player's interrupt/CC details, timestamp connects to #8 seek).
- **Testing**: IPC table unit test (fixture asserts interrupt row values).

## #11 Replay Three Small Additions

**Research Findings**

- **(a) dampening**: `getDampeningPercentage(bracket, units, ts)` is in
  `analysis/utils/dampening.ts`, consumes legacy unit shape → cannot be called directly from renderer. It is a prompt-rendered
  value (adjacent to gatekeeper rules) → predicate sharing requires a single source of truth.
- **(b) Cast bar**: **parser src has no SPELL_CAST_START** — new doc casts only have
  SUCCESS. True cast bar (in-progress reading) **cannot be built**, requires parser L2 to emit cast-start events first.
- **(c) HP numbers**: Replay interpolation sampling already exists (samples in replay.ts contain hp), pure rendering.

**Design Decisions**

- **(a)**: main IPC `report:dampening(matchId)` → 1s grid sequence `[{t, pct}]`,
  renderer control bar corner displays current value (playback clock looks up nearest point). Do not re-derive aura
  stacks in renderer (prohibition on second set of predicates).
- **(b) Downgrade or defer**: v1 uses SUCCESS events for "cast flash" (unit overhead icon
  flashes 1s at cast instant) — informative, zero parser changes; true cast bar = standalone parser spike (emit
  SPELL_CAST_START/STOP into doc, evaluate volume), **does not block this item**.
- **(c)**: Implement directly, 9px monospace HP% beside health bar.

## Implementation Results (2026-07-17, All Completed)

#7 `8772f4f` → #8 `60d9707`+`b825184` → #6 `3501c76` → #9 `b2fc00f` →
#10 `f32a4d2` → #11 `c03731f`. **One deviation from design**: The "main computes → IPC" decided
in #6/#10/#11a was changed to renderer derive directly calling analysis (via toLegacySafe shim
+ StructuredAnalysisPanel precedent) — predicates remain single source of truth with one less IPC surface; shim
also fixed the issue where analysis-derived UI silently disappeared under truncated fixtures. #11b cast bar
confirmed unfeasible (parser lacks SPELL_CAST_START), downgraded to cast flash, true cast bar
standalone spike.

## Implementation Order (Revised After Research)

1. **#7 Rich Rows** (fully independent, half-day scope)
2. **#8 Seek Mechanism + Window Color Bands** (moved up: smaller than expected, and #6 "Replay This Moment" depends on seek)
3. **#6 Death Recap** (reuses #8 seek)
4. **#9 Data PR (spellIconsGenerated) → UI PR**
5. **#10 Stats Table**
6. **#11c HP Numbers (convenient) → #11a Dampening → #11b Cast Flash**

Dependencies: #6 depends on #8 seek; #9 UI depends on its data PR; others are independent.
