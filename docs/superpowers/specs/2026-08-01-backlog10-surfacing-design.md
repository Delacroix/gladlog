# BACKLOG #10 Completion: Comprehensive Structured Signal Surfacing — Design

2026-08-01 · User-approved design matrix (eight items). Principle: Consume only existing predicates with zero new computations, pure derive + UI;
Surfacing formats follow the established conventions of existing card / swimlane / axis families.

## 1. Dampening Swimlane + CC Entry DR Level Annotation

- Timeline adds `dampening?: Array<{tS; pct}>` prop (mirroring the `pressure` prop shape), sourced from
  `deriveDampeningSeries` (existing zero-consumer export; internally switched to sampled `computeDampeningTimeline` to fix O(n²), 0–1 → 0–100 unit conversion encapsulated within derive); rendered as a second thin band above the pressure swimlane
  (new `LANE_GAP` constant, gradient opacity = concentration), title tooltip displays percentage on hover.
- CC entry detail in `KeyMomentAxis` appends DR tier: `ICCInstance.drInfo` is already in the `analyzePlayerCCAndTrinket` output, `keyMoments.ts` performs pure formatting (`DR_LEVEL_LABEL` single source).

## 2. Kill Window Target Selection → Burst Ledger Card

- `deriveBurstLedger` return type adds team-level `targetSelection: IKillWindowTargetEval[]` (reuses computed windows from line :45, single call);
- `BurstLedgerCard` "Window Target Discipline" section joins by `windowFromSeconds`: when `betterTargetExists` is true, appends `<Chip kind="bad">Should attack {betterTargetName}({spec})</Chip>` at row end, otherwise `<Chip kind="good">Reasonable Target</Chip>`.

## 3. Healing Gaps → KeyMomentAxis + Metric Cells

- `keyMoments` new kind `heal-gap` (minor): calls `detectHealingGaps` when owner is a healer, one moment point per gap (t=fromSeconds, toT=toSeconds, detail=duration + most heavily damaged player); `KIND_ICON`/`KIND_ZH` completed (enforced by TS Record);
- `healerMetrics` adds `healingGapSeconds: number`, `healingGapCount: number` scalar fields (synchronized across compare/corpus consumer types), also displayed in `ProComparison` panel.

## 4. Match Pace / Arc → Combat Report Header Row

- New `buildMatchArcStructured(same args as buildMatchArc): Array<{phase: "early"|"mid"|"late"; fromS; toS; prose; jumpT?}>` — structures previously discarded values inside `buildMatchArc` (firstDefensive / firstBurst / firstDeath / phase boundaries); `buildMatchArc` refactored to consume this before formatting (single-source drift prevention, existing prompt text preserved byte-for-byte = anti-regression for existing tests);
- New compact "Match Pace" bar below the `MatchReport` header row (horizontal 3-phase layout, turning points within phases clickable with `onSeek`); renderer-side derive reuses the `enemyCDTimeline`/`majorCooldowns` assembly pattern from `keyMoments`.

## 5. Positioning Events → KeyMomentAxis

- `keyMoments` new kind `position` (minor): minimal parameter template from `computeOwnerPositionEvents` deepDive.ts:411; only includes `STAYED_IN` (with real cost: `stayedInHadRealCost` single-source predicate) / `MISSED_PUSH` / `CD_OUT_OF_RANGE` (HEALER_TRAINED is already covered by the healer exposure swimlane, KITED is a positive event and excluded from the axis). `positionAnalysis` added to analysis barrel (`index.ts export *`).

## 6. Panic / Cheaper Alternatives → Death Recap + KeyMomentAxis Annotation

- `deathRecap`'s `def_used` event row: joins `detectPanicDefensives` (key `spellId + |tS - timeSeconds| < 1`) to add a "Panic Usage" badge;
- `keyMoments` defensive entries: `KeyMoment` adds optional `spellId`, joins on the same key to add detail annotation;
- `findCheaperDefensiveAlternatives`: `deathRecap`'s unused-defensive rows (existing `availableImmunities`/`missedExternals` structure) append "Cheaper Alternative: X" for each owner cast moment (requires `extractMajorCooldowns`, matching the `keyMoments:149` pattern).

## 7. CC Chain Panel

- New derive `ccChainDash.ts` + component `CCChainPanel.tsx`, mirroring the full Kick/Dispel panel conventions (EMPTY fallback / range filters results only / classColor row header / expandable rows / ▶ seek / empty state prevents layout jamming);
- Row = one chain per enemy target (directly wired to `analyzeOutgoingCCChains`): chain length, total CC duration, `hasWastedApplications` badge; expansion = application by application (moment / spell / caster / DR tier, 25%/Immune rows highlighted in red); mounted after the `MatchReport` Interrupt/Dispel panel.

## 8. Dead Code Cleanup

- Remove `detectFriendlyCDOverlaps` + `IOverlapCast` / `IFriendlyCDOverlapGroup` / `formatFriendlyCDOverlapsForContext` (verified zero call sites).

## Scope Boundaries (Out of Scope)

- `extractMatchDynamics` surfacing (clustering feature vectors are non-narrative, no UI value); `buildMatchFlow` is already deprecated and left untouched; AoE CC events independent surfacing (covered by chain panel expansion); dampening swimlane has no click interactions (read-only).

## Testing and Baselines

- Each item: derive unit tests (red → green) + component assertions; `buildMatchArcStructured` vs `buildMatchArc` output consistency assertions (single-source preservation); compare/corpus type chains for `healerMetrics` new fields all pass;
- Visual baselines: `report-battle`/`synth`/`window` (swimlane + ledger + CC panel + header row), `report-ai` (axis new kinds + metric cells) will all change — regenerated in CI for human review; header row affects all `report-*` scenarios;
- New interactive elements include accessible names (axe gate).
