# P1/P2 Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four new candidate types (missed-sync-window / unsynced-burst / cd-hoarded / cd-spent-idle) land in product candidate layer, go through corpus calibration + **independent A/B per type** then roll out by result; attached with constrained budget audit arm.

**Architecture:** Detectors go into `candidateFindings.ts` (isomorphic with 22 existing builders, consume existing predicates); threat predicates single source new export; feature flags follow `dispelFeatureFlags.ts` precedent; eval uses existing eval infra (corpus/responder=sonnet/deterministic metrics priority).

**Tech Stack:** Existing (analysis predicates family, eval corpus tools, vitest).

**Spec:** `docs/superpowers/specs/2026-08-15-p1p2-distillation-design.md` (criteria red line section is hard constraint)

## Global Constraints

- **Match spec criteria red lines with tests item-by-item**: sync without HP threshold gate (B8) / threat gate active (B6) / cost_norm annotations / CC state check uses shim + CC-aware exemption / fact-suggestion separation phrasing.
- Single source for predicates: enemy healer hard CC window extraction and threat predicates exported from one place each; bilingual registration in predicate index; do not rewrite any existing sampling logic.
- eval batch responder/judge pinned to **sonnet** (established preference); judge is for reference only, primary criteria are deterministic metrics.
- Feature flags default to all false; A/B arms only flip flags.
- Long scans/evaluations batched in foreground, write to disk between batches, timeout 550000/batch; **subagents must not wait on their own background commands**.
- Commit directly to main one per task, verify output after push; full gate `npm test --workspaces && npm run typecheck && npx eslint . --quiet`.
- Fixes report before/after numbers; calibration and A/B reports written to `$GLADLOG_EVAL_HOME/reports/`.

## Data Contracts (Shared across entire plan)

```ts
// packages/analysis/src/utils/threatAssessment.ts (Task 1)
export function threatActiveAt(enemies: ICombatUnit[], ownerSideDamageSource: unknown, tSeconds: number): boolean;
// Implementation: enemy offensive major CD auras active (casts of Offensive type in extractMajorCooldowns project window) OR own team damage rate exceeds threshold
export function matchThreatLevel(...): "low" | "med" | "high"; // Match-wide peak pressure classification
export const THREAT_DAMAGE_RATE_PCT_PER_S = <calibration placeholder, Task 5 finalized>;

// packages/analysis/src/analysis/candidateFindings.ts (Task 2/3)
export function missedSyncWindowEvents(...): CandidateEvent[];  // type: "missed-sync-window"
export function unsyncedBurstEvents(...): CandidateEvent[];     // type: "unsynced-burst"
export function cdHoardedEvents(...): CandidateEvent[];         // type: "cd-hoarded"
export function cdSpentIdleEvents(...): CandidateEvent[];       // type: "cd-spent-idle"

// packages/analysis/src/data/candidateTypeFlags.ts (Task 4)
export const CANDIDATE_TYPE_FLAGS: Record<"missedSyncWindow"|"unsyncedBurst"|"cdHoarded"|"cdSpentIdle", boolean>; // default all false
```

Enemy healer hard CC window extraction: reuse applications from `analyzeOutgoingCCChains(friends, enemies)` (target = enemy healer by `isHealerSpec`) — do not write new CC sampling. Offensive major CD set: existing `isThroughput`/Offensive tag judgment from `extractMajorCooldowns`.

---

### Task 1: Threat Predicates

**Files:** Create `packages/analysis/src/utils/threatAssessment.ts`; Test `packages/analysis/test/threatAssessment.test.ts`; Modify `docs/predicate-index.md`+`.zh-CN.md`+`packages/eval/test/predicateIndex.test.ts` (registration).

- [ ] Step 1: Read existing pressure judgments in `counterfactual.ts`/`mitigationData` first, reuse what is reusable and note at file header; failing tests (synthetic fixture: enemy wings aura active timestamp → true; completely silent timestamp → false; matchThreatLevel one case per each of three tiers).
- [ ] Step 2: RED → Implementation → GREEN; add lines to bilingual predicate index + predicateIndex test registration green.
- [ ] Step 3: analysis suite + typecheck green; commit `feat(analysis): threat predicates threatActiveAt/matchThreatLevel (P2 gate, single source)` + trailers; push and verify.

### Task 2: P1 Dual Detectors (missed-sync-window + unsyncedBurst)

**Files:** Modify `packages/analysis/src/analysis/candidateFindings.ts`; Test `packages/analysis/test/candidateFindings.test.ts` extensions.

- [ ] Step 1: Shared "enemy healer hard CC window" extraction helper (private within file, consuming analyzeOutgoingCCChains output filtered for isHealerSpec targets); failing tests: ① synthetic 60ab-7:19 style fixture (enemy healer CCed for 8s + friendly Hammer of Justice ready + no burst initiated) → missed-sync-window 1 entry, facts contain CCed spell/duration/ready list/lowest enemy HP in window; ② **Red line test: all enemies at full HP with same fixture → still produces candidate** (no HP threshold gate, B8); ③ unsynced-burst: burst cast + zero hard CC on enemy healer in window → 1 entry; hard CC present → 0 entries.
- [ ] Step 2: RED → Implementation (id format / fmt / severity following healingGapEvents and existing builder conventions; phrasing fact-suggestion separation into facts design) → GREEN; existing tests all green.
- [ ] Step 3: commit `feat(analysis): P1 candidate detectors -- missed-sync-window/unsynced-burst (sync as gate, no HP threshold gate)` + trailers; push and verify.

### Task 3: P2 Dual Detectors (cdHoarded + cdSpentIdle)

**Files:** Same structure as Task 2.

- [ ] Step 1: Failing tests: ① cd-hoarded synthetic 60ab-AW style (6:20 ready, 6:30 own team 34%, 6:54 finally cast) → 1 entry with facts containing N seconds late / crisis timestamp; pressed immediately after ready → 0 entries; ② **Red line: when 642 hits, facts include costNorm** (costNormPhrase pipeline); ③ cd-spent-idle synthetic blind Divine Protection cast style (at cast timestamp threatActiveAt=false) → 1 entry; **Red line: matchThreatLevel="low" whole match → 0 entries** (B6 gate); cast when threat active → 0 entries.
- [ ] Step 2: RED → Implementation (threshold constants defined centrally, marked with `<Task 5 calibration finalization>` comments) → GREEN.
- [ ] Step 3: commit `feat(analysis): P2 candidate detectors -- cd-hoarded/cd-spent-idle (threat classification gate + costNorm linkage)` + trailers; push and verify.

### Task 4: Feature Flags + Menu Assembly + Prompt Legend

**Files:** Create `packages/analysis/src/data/candidateTypeFlags.ts`; Modify `candidateFindings.ts` menu assembly (read extractCandidateFindings assembly structure first), `buildFindingsPrompt.ts` (four legend entries, flag-gated rendering); Test extensions for each.

- [ ] Step 1: Failing tests: flags all false → four candidate types do not enter menu, legends not rendered; single flag turned on → only that type enters.
- [ ] Step 2: RED → Implementation → GREEN; full gate passes three greens (flags all false = zero product change, existing tests must pass as-is).
- [ ] Step 3: commit `feat(analysis): candidate type feature flags -- four new types default off, enabled per-type in A/B` + trailers; push and verify.

### Task 5: Corpus Calibration

**Files:** Create `packages/eval/src/explore/candidateCalibration.ts` + `packages/eval/scripts/candidateCalibrationScan.ts` (thin shell); report written to `$GLADLOG_EVAL_HOME/reports/p1p2-calibration.md`.

- [ ] Step 1: Scan logic (load legacy match by match → direct call to four detectors (bypassing flags) → counts) + fixture tests; n ≥ 500 matches run in foreground batches.
- [ ] Step 2: Output: per-type occurrence rate / per-match counts / threshold sensitivity table (cd-hoarded H ∈ {10,20,30,45}s, crisis HP threshold ∈ {35,45}%, threat damage rate threshold three tiers — each cell one per-match number); target range = 0.5-2 entries per match (referencing existing type volume); finalized thresholds written back to Task 1/3 constants + constant tests updated; **bidirectional error notes** one sentence per threshold.
- [ ] Step 3: commit (calibration numbers in message) + report; push and verify. Controller presents threshold table to user for review (non-blocking — user may veto retrospectively).

### Task 6: P1 Two Types Independent A/B

**Files:** Eval scripts organized following `/eval-ab` existing workflow (read docs/commands/eval-ab.md first); report `$GLADLOG_EVAL_HOME/reports/p1p2-ab-p1.md`.

- [ ] Step 1: Eval set: from Task 5 scan, select matches where the type **triggered** (n ≥ 30 each, or all if insufficient); two configuration sets: {missedSyncWindow enabled alone} vs all off, {unsyncedBurst enabled alone} vs all off.
- [ ] Step 2: For each set: construct prompts for both arms → responder (sonnet) → deterministic primary metrics: ① new candidate type adoption rate (finding.eventIds hits that candidate type id); ② gate audit pass rate of adopted findings; ③ filler rate changes; judge (sonnet) 7 dimensions for reference with noise floor noted. Foreground batches.
- [ ] Step 3: Report conclusions per type (adoption rate / audit rate / filler before-after numbers); commit + push and verify.
- [ ] Step 4: **PAUSE: Present P1 two-type results to user** (decide enable/disable individually).

### Task 7: P2 Two Types Independent A/B

Same structure as Task 6, configurations {cdHoarded} / {cdSpentIdle}; report `p1p2-ab-p2.md`; **PAUSE: Present results to user**.

### Task 8: Constraint Budget Audit Arm

**Files:** Report `$GLADLOG_EVAL_HOME/reports/constraint-budget-audit.md`.

- [ ] Step 1: Inventory output-space constraint list (candidate gates / guardian notes / rate limits / severity bounds, etc., each annotated with original justification receipts and mechanical risk ratings) —— document section included in report; controller selects 2-3 **low mechanical risk** candidate relaxation items (e.g. topic rate gates, severity upper bounds; never relax mechanical correctness gates such as dispel capability gate), relaxation method = configuration / minimal patch (not merged into main, temporary within eval arm).
- [ ] Step 2: A/B: baseline vs relaxed arm, n ≥ 40 matches; criteria: verified new discovery rate (gold standard caliber: factual + specific discovery counts previously uncovered by pipeline, deterministic approximation = new non-duplicate finding count × audit pass rate) vs mechanical error rate (gate hardFailures + causalLint hits); judge for reference.
- [ ] Step 3: Pareto data table + per-constraint conclusions reported; commit (report) + push; **PAUSE: Present data to user for ruling** (tighten/relax each constraint).

### Task 9: Finalization per Ruling

- [ ] After user ruling: winning type flags flipped to true (include A/B numbers in commit); losing types retained with notes; constraint rulings landed (if user decides to relax a gate, follow formal modification + test path); inventory / BACKLOG / predicate index synced; full gate all green; push and verify.

## Definition of Done

Four types each have independent A/B numbers and final user approval; calibration report documented; constraint audit Pareto table documented and ruled on by user; all red line tests permanently green.
