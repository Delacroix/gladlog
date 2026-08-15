# Report UI Phase 4 — Four Borrowings from WCL / WoWAnalyzer (v0.1 Major Release)

Branch: `release/0.1`. Source: Architectural research on WCL help docs + full WoWAnalyzer codebase (`~/code/wowanalyzer`, indexed via CodeGraph) on 2026-07-22/23. Four items sorted by dependency:
① Time Window Selection → ④ Aura Interval Sets / Uptime Bars → ② Events View → ③ Deterministic Mistake Engine (#8).

## ① Time Window Selection (Foundation) ✅ (Landed 2026-07-23, e1be96d..ccd9e72: drag selection / phase dropdown / chips, hybrid semantics + conservation tests + report-window baseline)

**Goal**: Drag-select time ranges on Timeline / select windows via phase dropdown, recalculating all aggregation panels for that window.
WCL's equivalent is "every view = a query of (event stream, time window, filters)"; WoWAnalyzer relies on re-running the entire parsing pipeline on sub-intervals + materializing cross-boundary state into fabricated events (`FilterCooldownInfo` / `prepull applybuff`). We don't need such heavy machinery — data shapes allow two cheaper and mutually correct paths:

- **Instant Event Aggregation (Meters / summary / detail breakdown) → Event-layer Slicing**: Damage/heal events are instantaneous without cross-boundary state. `clipSource(source, range)` shallow-clones units and filters event arrays by timestamp, requiring zero changes in derives (`WeakMap` caching in `toLegacySafe` naturally works for new objects).
- **Stateful Facts (CC instances in statsTable / kick audit / dispel ledgers / dual panels) → Fact-layer Filtering**: Derives run as usual over the full stream (state inference is unaffected by window boundaries), then filter down to the window by fact `tS`/`fromSeconds`; cross-boundary duration facts (CC active spans) are counted by their overlapping portions. **Never apply event-layer clipping to these derives** — CC where aura was applied outside the window and removed inside would vanish completely, and opener reset inferences (trinkets) would also be corrupted by window start timestamps.
- **Window-Agnostic Views**: HP Timeline (always full match, window rendered as highlighted selection), WindowList, Death Recap, Burst Ledger (inherently window-anchored), Replay.

**UI**: Timeline drag-selection (`mouseDown`/`mouseMove` on SVG, coordinate conversion logic reused from existing bands); phase dropdown options = full match + each band from `deriveVulnBands` (kill windows / vulnerable windows, labels reuse `WindowList` copy); clear button; active window displayed in `rpt-head` row.
State: `MatchReport` local `timeRange: {fromS, toS} | null`, not stored in global state (same as replay clock).

**Acceptance**: Sum of Meters within window = sum of full match detail events where `tS ∈ window` (conservation test); `statsTable` window count ≤ full match count; visual baseline adds a "selected window" scenario.

## ④ Aura Interval Sets + Uptime Bars ✅ (Landed 2026-07-23: analysis `buildAuraIntervals` single-source predicate + inferred segments tracking; uptime uses interval union — empirical tests show duplicate-name buffs from multiple sources double-count without union correction; `AuraUptimeCard` window linkage)

Shared builder (WoWAnalyzer's `Auras`/`getBuffStacks` pattern): `auraEvents` paired applied → removed, refresh coalescing (`BuffRefreshNormalizer` buffer approach), pre-combat active segments tagged as `inferred`. CC / DR / major buff uptime bars render from the same interval set; existing `ccWindows` paths gradually migrate to consume this (single-source predicate, no secondary pairing logic permitted).

## ② Events View (Also B2 Provenance Container) ✅ (Landed 2026-07-23: 4th view tab, type chips / units / spell substring / window anchoring (full match, global window, kill/vulnerable window) + pagination + ▶ row-by-row replay seek; finding card deep link entry point left for follow-up)

Structured filtering (type / source / target / spell / time window), avoiding an expression DSL; killer feature is "Anchor to window" dropdown (pre-computed kill windows / pressure windows / CC chains cover 90% of WCL `IN RANGE FROM..TO` use cases). Finding cards add "View raw events" → jump with pre-filled filters. Virtual scrolling (event volume ~tens of thousands).

## ③ #8 Deterministic Mistake Engine ✅ (Landed 2026-07-23: `MISTAKE_RULES` 8 3-tier rules + `IGNORED` exemption table + anti-corruption tests requiring upstream types to declare stance; `MistakesCard` + timeline ⚠ marks; `juked-kick` uses `kickAudit` across all friendlies, preventing the candidate version from missing non-DPS friendlies)

Three borrowings: Rules as data objects (`{actual, isGreaterThan: {minor, average, major}}` 3 tiers); enumerable rules table → `purgeWhitelist`-style anti-corruption tests (every rule must either trigger in corpus or be in the exemption table); mistakes annotated event-by-event onto Timeline / swimlanes (seek pipeline already in place). Initial rules port 6 `candidateFindings` categories + `kickAudit` + missed purges / missed dispels, all of which are already deterministic predicates, only lacking a UI channel that bypasses LLMs.

## Borrowed But Scheduled Separately

Normalization audit trail (`__fabricated`/`__modified` flags tracking implicit fixes in parser-compat), mana curves (requires expanding parser `advancedSamples` to extract power fields, passing A1 oracle).
