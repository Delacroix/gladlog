# BACKLOG #10 Completion (Eight Surfacing Signals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose all eight sets of signals already computed by buildMatchContext but only passed to LLM text to the UI (spec: docs/superpowers/specs/2026-08-01-backlog10-surfacing-design.md).

**Architecture:** Consume existing analysis predicates with zero new calculation; renderer side derive (toLegacySafe mode) + expand existing card/lane/axis formats; the only new analysis side function is `buildMatchArcStructured` (structures existing internal values, prose version changed to consume it, output remains byte-for-byte identical).

**Tech Stack:** TypeScript / React / vitest.

## Global Constraints

- Gate predicates as specification: do not recalculate any conditions; DR tier text uses `DR_LEVEL_LABEL` (`drAnalysis.ts:433`); STAYED_IN cost determination uses `stayedInHadRealCost` (`positionAnalysis.ts:72`); `buildMatchArc` prose output after refactoring must remain **byte-for-byte identical** to before (double-guarded by existing prompt tests + new consistency assertions).
- Panel family conventions (Kick/Dispel exact format): `try{}catch{return EMPTY}`; range filters only results, not inputs; empty state maintains shell; row header classColor dot; ▶ seek = `onSeek(Math.max(0, t-3), [name])`.
- `KeyMomentAxis`'s `KIND_ICON`/`KIND_ZH` is an exhaustive Record — new kind must be updated synchronously (TS enforced); icons use text glyphs, emojis forbidden.
- New interactive elements must have accessible names (axe gate is independent of pixel gate).
- New fields in `healerMetrics` must be scalars (ProComparison is flattened via `Record<string,number|null>`); `compare.ts`/`perMatchRecord`/`api.ts` type chains synced.
- Visual baseline: never run `test:visual` locally; finalize via CI regeneration for human review.
- Commit discipline: independent commit per task, do not push; workspace-scoped tests; `npm run typecheck` (never `tsc -b`); desktop changes run `npx eslint packages/desktop/src --quiet`; renderer new imports watch bundle hygiene (final presubmit's `electron-vite build` is the real gate).

## Verified Interfaces from Planning Phase (For implementer reference, do not re-investigate; all file:line at worktree HEAD)

- `deriveDampeningSeries(source): Array<{tS;pct}>` (`derive/dampeningSeries.ts:10`, pct 0–100, zero consumers; internally calls `getDampeningPercentage` per second O(n²)); `computeDampeningTimeline(bracket, players, startTime, endTime): IDampeningSnapshot[]` (`dampening.ts:170`, 30s inflection sampling, `dampening` is 0–1).
- Timeline props single object `pressure?: {spikes; exposures}` (`Timeline.tsx:89`), lane rendering `:252-288`, geometry `LANE_H=8` (`:18`), wiring pattern `MatchReport.tsx:124+:464`.
- `ICCInstance.drInfo: IDRInfo|null` (`ccTrinketAnalysis.ts:189`); keyMoments cc entry construction `:205-227` (already calls `analyzePlayerCCAndTrinket`, discarding drInfo); `IDRInfo{category; level: DRLevel; sequenceIndex}` (`drAnalysis.ts:155`).
- `analyzeKillWindowTargetSelection(windows, enemies, combat): IKillWindowTargetEval[]` (`killWindowTargetSelection.ts:331`; `IKillWindowTargetEval{windowFromSeconds; windowToSeconds; focusedTarget; otherTargets; betterTargetExists; betterTargetName?; betterTargetSpec?}` `:66`; returns `[]` if enemies < 2); `burstLedger.ts:45` already computes `windows = computeOffensiveWindows(...)`; `LedgerPlayer` (`burstLedger.ts:16`); BurstLedgerCard "Window Target Discipline" section `:161-186`, row key `windowFromSeconds`, `Chip({kind,children})` `:13`.
- `detectHealingGaps(healer, friends, enemies, combat): IHealingGap[]` (`healingGaps.ts:150`; `IHealingGap{fromSeconds; toSeconds; durationSeconds; freeCastSeconds; mostDamagedName; mostDamagedSpec; mostDamagedAmount}` `:41`; call precedent `buildMatchContext.ts:249-251` gated on owner is healer).
- `IHealerMetrics` (`healerMetrics.ts:52-62`); `computeHealerMetrics(combat, playerName)` throws if unit does not exist (`:72`); consumer chain `ProComparisonVerified.tsx:157-165` (flattened), `compare.ts`, `corpus-tools/perMatchRecord`, `preload/api.ts`.
- `buildMatchArc(enemyCDTimeline, allTeamCooldownsWithPlayer, friendlyDeaths, durationSeconds, bracket): string[]` (`matchNarrative.ts:200`; internal discarded values: `firstDefensiveSeconds/Name/Spec` `:243-256`, `firstBurst.fromSeconds/toSeconds/dangerLabel`, `firstDeath.atSeconds`, `earlyEnd/midEnd/lateStart` `:258-271`; sole caller `buildMatchContext.ts:862`, argument assembly `:856-861`); renderer assembly pattern: `keyMoments.ts:129` `reconstructEnemyCDTimeline(enemies, legacy, owner, friends)` + `:149` `extractMajorCooldowns(u, legacy)` + `:86` `deaths`.
- `ReportHeader({source, roundLabel})` (`ReportHeader.tsx:21`), mounted at `MatchReport.tsx:382` (right side of `rpt-head-row`; left side `:369-381` is view tab bar).
- `computeOwnerPositionEvents(params single object)` (`positionAnalysis.ts:200`; **not in barrel**, needs `export * from "./utils/positionAnalysis"` added to `index.ts`; minimal params template = `deepDive.ts:411`: `owner/enemies/combat/burstWindows/ownerCooldowns/ownerCCSummary/isHealer/ownerIsMelee/friends`); `IPositionEvent` (`:91`, time fields **atSeconds/toSeconds**, no severity); `PositionEventType` (`:83`).
- `detectPanicDefensives(friends, enemies, combat): IPanicDefensive[]` (`cooldowns.ts:1809`; `IPanicDefensive{timeSeconds; casterSpec; casterName; spellName; spellId; targetName; targetSpec}` `:1694`); `findCheaperDefensiveAlternatives(cd, ownerCDs, atSeconds, opts): string[]` (`cooldowns.ts:885`, raw string names); DeathRecapEvent `def_used` already has `spellId+tS` (`deathRecap.ts:22-33`); KeyMoment **has no spellId field** (`keyMoments.ts:20-35`), defensive entry construction `:147-177`.
- `analyzeOutgoingCCChains(friendlies, enemies, combat): IOutgoingCCChain[]` (`drAnalysis.ts:320`; `IOutgoingCCChain{targetName; targetSpec; applications: IOutgoingCCApplication[]; hasWastedApplications}` `:302`; `IOutgoingCCApplication{atSeconds; durationSeconds; spellId; spellName; casterName; casterSpec; drInfo}` `:292`; do NOT add DR filter — `:311-318` comment explicitly mandates); Kick panel format: `derive/kickDash.ts` (`KickDashRow` `:8-21`, `deriveKickDash(source, range?)` `:30`) + `KickDashboard.tsx` (`props` `:14-20`, empty state shell `:22-33`); mount point `MatchReport.tsx:501-502`.
- Dead code: `detectFriendlyCDOverlaps` (`cooldowns.ts:1411`) + `IOverlapCast` (`:1394`) + `IFriendlyCDOverlapGroup` (`:1402`) + `formatFriendlyCDOverlapsForContext` (`:1490`), proven zero calls across the repo.
- `KeyMomentKind` (`keyMoments.ts:17`); `MAJOR_KINDS` (`:37-40`); `KIND_ICON`/`KIND_ZH` (`KeyMomentAxis.tsx:26-40`, exhaustive); `nodeColor` (`:171-184`); kind union in `videoMoments.ts:13` automatically relaxes (new kinds naturally flow into video strip/feed — expected behavior, do not block).
- Visual baseline blast radius: lanes / ledger / CC panel → `report-battle/synth/window`; axis / metrics → `report-ai`; header line → all `report-*`; dead code removal → zero.

---

### Task 1: Analysis Foundation —— buildMatchArcStructured + barrel + Dead Code Cleanup

**Files:**

- Modify: `packages/analysis/src/context/matchNarrative.ts`
- Modify: `packages/analysis/src/index.ts` (+`export * from "./utils/positionAnalysis"`)
- Modify: `packages/analysis/src/utils/cooldowns.ts` (delete four dead code items)
- Test: `packages/analysis/test/matchNarrative.arc.test.ts` (new)

**Interfaces:**

- Produces:

```ts
export interface IMatchArcPhase {
  phase: "early" | "mid" | "late";
  fromS: number;
  toS: number;
  prose: string; // One sentence for this phase (consistent with text after colon in corresponding buildMatchArc line)
  turningPoint?: { tS: number; label: string }; // early = first defensive CD; mid = first death or first burst window resolved
}
export function buildMatchArcStructured(
  enemyCDTimeline: IEnemyCDTimeline,
  allTeamCooldownsWithPlayer: Array<{
    player: ICombatUnit;
    cd: IMajorCooldownInfo;
  }>,
  friendlyDeaths: Array<{ spec: string; atSeconds: number }>,
  durationSeconds: number,
  bracket: string,
): IMatchArcPhase[]; // Two phases when durationSeconds < 90, same branch as prose version
```

- `buildMatchArc` changed to internally call `buildMatchArcStructured` then format; **output unchanged byte-for-byte**.

- [ ] **Step 1**: Write failing tests: ① assert structured phase boundaries / turningPoint match manual calculation on synthetic inputs; ② consistency assertion — for identical inputs, `buildMatchArc` output array before and after refactoring are deeply equal (inline old implementation expected output snapshot in test first; must still match after refactor); ③ barrel import `computeOwnerPositionEvents` compiles; ④ `detectFriendlyCDOverlaps` and other three symbols fail import (deletion verification, use `@ts-expect-error` or assert index export surface excludes them).
- [ ] **Step 2**: Run `npm run test --workspace=packages/analysis -- matchNarrative` to confirm red.
- [ ] **Step 3**: Implementation (extract internal discarded values in structured; consume in prose version; add barrel export line; delete four dead code items and test leftovers).
- [ ] **Step 4**: analysis workspace all green (existing prompt/faithfulness tests act as byte-for-byte anti-regression net) + typecheck.
- [ ] **Step 5**: Commit `feat(analysis): buildMatchArcStructured single-source structuring + positionAnalysis barrel export + CD overlap dead code cleanup (#10 T1)`.

### Task 2: Dampening Lane + CC DR Annotation

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/dampeningSeries.ts` (switch internal sampling to computeDampeningTimeline, output shape unchanged)
- Modify: `packages/desktop/src/renderer/src/report/components/Timeline.tsx` (new `dampening?` prop + second lane)
- Modify: `packages/desktop/src/renderer/src/report/derive/keyMoments.ts` + `components/KeyMomentAxis.tsx` (add DR to cc detail)
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (two wiring lines)
- Test: `packages/desktop/test/` (dampeningSeries unit test refactor; Timeline lane render assertions; keyMoments DR text assertions)

**Interfaces:** Consumes T1 none; Produces Timeline `dampening?: Array<{tS: number; pct: number}>`.

- [ ] **Step 1**: Failing tests: dampeningSeries outputs correctly under synthetic 110310 events with O(events) call count (mock count); Timeline passed dampening renders `data-testid="rpt-damp-lane"` rect count > 0, absent when omitted; cc KeyMoment detail contains "DR:½" (using actual text from `DR_LEVEL_LABEL`).
- [ ] **Step 2**: Confirm red.
- [ ] **Step 3**: Implementation (lane y position = above existing pressure lane, new `LANE_GAP=2` constant; opacity maps pct/100; title tooltip).
- [ ] **Step 4**: desktop workspace all green + typecheck + eslint.
- [ ] **Step 5**: Commit `feat(desktop): Timeline dampening lane + CC moment DR tier annotation (#10 T2)`.

### Task 3: Kill Window Target Selection + Healing Gaps

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/burstLedger.ts` (return adds team-level targetSelection)
- Modify: `packages/desktop/src/renderer/src/report/components/BurstLedgerCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/derive/keyMoments.ts` (heal-gap kind) + `KeyMomentAxis.tsx` (Record completion)
- Modify: `packages/analysis/src/utils/healerMetrics.ts` (+healingGapSeconds/healingGapCount scalars) and consumer chain types (compare.ts / corpus-tools perMatchRecord / preload api.ts / ProComparisonVerified display cells)
- Test: Corresponding tests for each file

**Interfaces:** `deriveBurstLedger` return changed to `{ players: LedgerPlayer[]; targetSelection: IKillWindowTargetEval[] }` (**breaking return shape change** — sync BurstLedgerCard with existing call sites; search full call surface).

- [ ] **Step 1**: Failing tests: targetSelection non-empty in synthetic two-enemy scenario and joined to card rows (betterTargetExists → bad Chip text); single enemy returns []; heal-gap KeyMoment appears in synthetic gap scenario, omitted for non-healer owner; healerMetrics new field value assertions + consumer chain typecheck.
- [ ] **Step 2**: Confirm red.
- [ ] **Step 3**: Implementation.
- [ ] **Step 4**: analysis+desktop workspace all green + typecheck + eslint.
- [ ] **Step 5**: Commit `feat(desktop,analysis): burst ledger target selection eval + healing gap surfacing (axis + metrics) (#10 T3)`.

### Task 4: Match Pace Header Line + Position Events

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/matchArc.ts` (renderer assembles buildMatchArcStructured params, keyMoments:129/:149 pattern)
- Create: `packages/desktop/src/renderer/src/report/components/MatchArcLine.tsx`
- Modify: `MatchReport.tsx` (mount below header line) + `styles.css`
- Modify: `keyMoments.ts` (position kind, deepDive.ts:411 minimal params, three filter categories: STAYED_IN with stayedInHadRealCost / MISSED_PUSH / CD_OUT_OF_RANGE) + `KeyMomentAxis.tsx`
- Test: Corresponding tests for each file

**Interfaces:** Consumes T1 `buildMatchArcStructured`/`IMatchArcPhase` and barreled positionAnalysis.

- [ ] **Step 1**: Failing tests: MatchArcLine renders three phases and clickable turning points (onSeek receives jumpT); two phases for short matches; position KeyMoment three categories enter axis, KITED / zero-cost STAYED_IN excluded.
- [ ] **Step 2**: Confirm red.
- [ ] **Step 3**: Implementation (arc line compact single row, `data-testid="match-arc-line"`, turning point button with aria-label).
- [ ] **Step 4**: All green + typecheck + eslint.
- [ ] **Step 5**: Commit `feat(desktop): match pace header line (structured clickable turning points) + position events on timeline axis (#10 T4)`.

### Task 5: Panic/Alternative Notes + CC Chain Panel

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts` (def_used join panic + unused row adds alternatives) and `DeathRecapCard.tsx`
- Modify: `keyMoments.ts` (KeyMoment adds optional spellId; defensive join panic)
- Create: `packages/desktop/src/renderer/src/report/derive/ccChainDash.ts` + `components/CCChainPanel.tsx`
- Modify: `MatchReport.tsx` (mount panel after :501-502) + `styles.css`
- Test: Corresponding tests for each file

**Interfaces:** Consumes none new; ccChainDash outputs `{rows: Array<{targetName; targetSpec; chainLen: number; totalCcSeconds: number; wasted: boolean; apps: IOutgoingCCApplication[]}>}`, EMPTY fallback.

- [ ] **Step 1**: Failing tests: panic join (same spellId same second → badge; different second does not join); cheaper alternative text appears in unused row; CC chain panel rows / expansion / empty state shell / 25% tier marked red; range filter only affects displayed rows.
- [ ] **Step 2**: Confirm red.
- [ ] **Step 3**: Implementation (full Kick panel conventions).
- [ ] **Step 4**: All green + typecheck + eslint.
- [ ] **Step 5**: Commit `feat(desktop): panic defensive / cheaper alternative notes + enemy CC chain panel (#10 T5)`.

### Task 6: Wrap-up —— presubmit, push, baselines, ledger reconciliation

**Files:**

- Modify: `docs/BACKLOG.md` (§10 marked ✅)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png` (CI generated for human review)

- [ ] **Step 1**: `npm run presubmit` all green (report honestly if red, do not self-patch).
- [ ] **Step 2**: BACKLOG §10 ledger reconciliation commit; fetch/rebase; push; monitor test.yml by headSha.
- [ ] **Step 3**: frontend-qa expected red (report-battle/synth/window/ai + header line ripple to report-replay/events) → visual-baseline.yml regenerate → cmp → review images one by one (differences must be attributable: lanes / ledger rows / CC panel / new axis points / header line / metric cells) → commit and push, monitor green; stop immediately on unexplainable differences.
- [ ] **Step 4**: Report: eight items individual landing points + manual verification checklist.

## Self-Review Record

1. Spec coverage: spec §1→T2; §2→T3; §3→T3; §4→T4; §5→T4; §6→T5; §7→T5; §8→T1; boundary section has no tasks (correct).
2. Placeholders: Each Step 1 clearly states assertion targets and construction methods; interface signatures given verbatim in "Verified Interfaces" and task Interfaces.
3. Type consistency: `IMatchArcPhase` defined in T1, consumed in T4; `deriveBurstLedger` new return shape closed inside T3; KeyMoment.spellId T5 additions do not conflict with T3/T4 new kinds (optional field).
