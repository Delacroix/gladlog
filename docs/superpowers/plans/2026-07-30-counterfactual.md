# Damage Reduction Counterfactual 17a+17b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 17b: Damage reduction audit in death window (A already used / B external unused / narrow gate available but unpressed, three tiers predicate single source, only "decisive" opens) dual-sided output (death recap card + [DEATH] prompt line); 17a: External `Unnecessary` sixth tier → `questionable-external` candidate + MISTAKE_RULES.

**Architecture:** analysis new module `counterfactual.ts` carries all arithmetic and three tiers predicates; B's two prerequisite fixes (deathOutcome external table 7→14 convergence, deathRecap zoneId two-point fix) go first; 17a adds tier in `annotateDefensiveTimings` (corpus validation prerequisite); desktop/prompt consume the same arithmetic on both sides.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-counterfactual-design.md`
**Working Directory:** Always worktree `/Users/mingjianliu/code/gladlog-wt-17` (main; dependencies installed). Main checkout `/Users/mingjianliu/code/gladlog` is occupied by user, **absolutely do not touch**.

## Global Constraints

- Directly commit to worktree main, finally push; compound commands must never use naked `cd`; gate chains must never add pipes; run `npm run presubmit` before push; test across workspace scope.
- **Three-tier predicate exported from single location**, aligned with quantitative report criteria (decisive = saved amount > net damage + 15% maxHp; marginal = (0.5× net damage, decisive threshold]; fatal = remainder); window = 10s prior to death; net damage = absolute HP at window start; B / narrow gate **only open for "decisive"**.
- Reverse extrapolation formula: mitigated amount = observed damage × pct / (100 − pct); immunities (pct=100) are not reverse-extrapolated; mechanic/unlisted spells are reported faithfully without fabricated numbers; positional (Darkness) is skipped; multiple entries are evaluated independently without modeling stacking.
- HP sampling strictly follows `HP_SAMPLE_RADIUS_MS` / `getUnitHpAtTimestamp` single source (comment in cooldowns.ts:348 explicitly forbids a second radius constant).
- 17a criteria rely entirely on existing predicates; **corpus empirical validation is a prerequisite** (stop and report if incidence rate is ≈0 or >50%); new candidates must be declared in MISTAKE_RULES / IGNORED (enforced by anti-corruption tests).
- Numbers in new prompt lines must first be formatted to render grid (evaluation gate predicate serves as spec); wording uses possibility framework, without conflicting with existing "counterfactual unknown" disclaimer line in buildMatchContext.ts:966 (which is a disclaimer regarding pressure correlation of availableWindows; this feature's lines **include numeric data**, and must not reuse the word "unknown").

**Verified Facts During Planning Phase (executor does not need to re-verify, cite directly)**:

- The zoneId bug actually has two points: `deathRecap.ts:61` reads non-existent `legacy.zoneId` (ground truth is in `legacy.startInfo.zoneId`, convert.ts:574) → `combatLike.startInfo.zoneId` is perpetually `""`; `deathRecap.ts:72` passes `legacy` directly to `buildDeathOutcomeSummary`, whose signature (deathOutcomeAnalysis.ts:292) reads **top-level** `combat.zoneId` → perpetually undefined → LoS gate (:383) never takes effect in desktop path. The call in analysis `buildMatchContext` is correct (passing top-level zoneId), only desktop path is broken.
- In `annotateDefensiveTimings`, Reactive spike evaluation (cooldowns.ts:1010-1041) inspects **caster's** own damageIn (code comments acknowledge: External inspects Paladin instead of beneficiary) — 17a's "no damage spike" condition must inspect **beneficiary's** (`cast.targetName` → reverse lookup in `combat.units`) damageIn, falling back to caster when target is unresolvable with note in timingContext.
- Impact of sixth tier on `TimingCounts` / spec baselines (benchmark/metrics.ts:29-35, specBaselines.ts:15-21): baselines are offline pre-generated five-tier criteria, not regenerated — **metrics.ts tallies `Unnecessary` into `unknown` bucket** (one line + comment), other consumers (prompt/criticalMoments `!== "Unknown"` criteria) will automatically print new tier without modification.
- There are two implementations named `buildAuraIntervals`: **use the publicly exported one** (`utils/auraIntervals.ts:57`, signature `(unit, {startTime,endTime}) → IAuraInterval[]`, relative seconds, full auras filtered by whitelist); do not confuse with private version in burstLedger (utils.ts:62, absolute ms).
- The 7-entry `EXTERNAL_DEFENSIVE_SPELLS` table is in deathOutcomeAnalysis.ts:69-120 (entries include spellName/cooldownSeconds metadata); `IMissedExternal` fields :128-134; `wasLockedOutThroughWindow` (:260, LETHAL_WINDOW_SECONDS=5 / MIN_FREE_GAP_SECONDS=1).
- Precedents for candidate registration triplet: `externalUnusedEvents` (candidateFindings.ts:863-921, including id format / facts / gate), MISTAKE_RULES entry shape (mistakes.ts:89-94), anti-corruption tests (test/report.mistakes.test.tsx:79-102); new type not in `OFFENSIVE_CANDIDATE_TYPES` defaults to routing to survival; category reuses existing 8 categories (using "cooldowns"), findingCategories requires no change.
- Precedent for [DEATH] block appended lines: HP trajectory / Top damage lines in matchTimelineSections.ts:596-632 (no independent timestamp, indented alignment, same addEntry); `DeathRecap` interface (deathRecap.ts:26-41) and card section insertion point (DeathRecapCard.tsx:108-131 after verdict section, before table).
- Corpus scan skeleton: `packages/eval/scripts/newCandidateScan.ts` (same pattern as arenacoach batch 1: owner evaluation mirroring analysisInput, applicable denominator, SAMPLE_CAP=5 sampling, rate table).

---

### Task 1: analysis — counterfactual.ts (Three-Tier Predicate + Three Forms Arithmetic)

**Files:**

- Create: `packages/analysis/src/utils/counterfactual.ts`
- Modify: `packages/analysis/src/index.ts` (export)
- Test: `packages/analysis/test/counterfactual.test.ts` (new)

**Interfaces:**

- Consumes: `MITIGATION_TABLE/IMitigationEntry`, `buildAuraIntervals` (utils/auraIntervals public version), `cdAvailableAt`, `wasLockedOutThroughWindow`, `getUnitHpAtTimestamp`/`HP_SAMPLE_RADIUS_MS`, `spellIdLists`, `IMissedExternal`.
- Produces (consumed by Task 3/4):

```ts
export const COUNTERFACTUAL_WINDOW_S = 10;
export const DECISIVE_MARGIN_PCT = 15; // Decisive threshold margin: 15% maxHp
export const MARGINAL_FLOOR_RATIO = 0.5; // Marginal lower bound: 0.5× net damage

export type CounterfactualTier = "decisive" | "marginal" | "fatal";
/** Single source three-tier predicate (aligned with quantitative report). savedAmount/netDamage/maxHp share units (absolute HP value). */
export function counterfactualTier(
  savedAmount: number,
  netDamage: number,
  maxHp: number,
): CounterfactualTier;

export interface IMitigationAuditRow {
  spellId: string;
  spellName: string;
  kind: "arith" | "immunity" | "mechanic";
  /** Active overlap seconds with death window (one decimal place). */
  activeOverlapS: number;
  /** kind=arith: mitigated amount (absolute) and percentage of maxHp. */
  blockedAmount?: number;
  blockedPctMaxHp?: number;
  /** kind=immunity: observed damage during immunity coverage (should be ≈0, reported faithfully). */
  damageTakenDuringImmunity?: number;
}
/** Form A: Item-by-item audit of active whitelisted damage reductions on victim during death window (independent basis). */
export function computeMitigationAudit(
  victim: ICombatUnit,
  combat: {
    startTime: number;
    endTime: number;
    units: Record<string, ICombatUnit>;
  },
  deathS: number,
): {
  rows: IMitigationAuditRow[];
  netDamage: number | null;
  maxHp: number | null;
};

export interface ICounterfactualHit {
  spellId: string;
  spellName: string;
  source: "unused-self" | "missed-external";
  casterName?: string; // when missed-external
  savedAmount: number;
  savedPctMaxHp: number;
  tier: CounterfactualTier;
}
/** Narrow gate: self available but unpressed (in-table non-positional; CC deadlock returns empty). Returns decisive only. */
export function computeUnusedSelfCounterfactuals(
  victim: ICombatUnit,
  victimCds: IMajorCooldownInfo[],
  victimCcSummary: Pick<IPlayerCCTrinketSummary, "playerName" | "ccInstances">,
  combat: { startTime: number; units: Record<string, ICombatUnit> },
  deathS: number,
): ICounterfactualHit[];

/** Form B: missedExternals × table → three tiers, returns decisive only. */
export function computeMissedExternalCounterfactuals(
  missedExternals: IMissedExternal[],
  victim: ICombatUnit,
  combat: { startTime: number },
  deathS: number,
): ICounterfactualHit[];
```

- [ ] **Step 1: Write failing test**

`packages/analysis/test/counterfactual.test.ts` (synthetic unit structure following mkUnit pattern in `deepDive.test.ts`: damageIn with `{logLine:{timestamp}, effectiveAmount, spellSchoolId}`, auraEvents, advancedActions):

```ts
import { describe, expect, test } from "vitest";
import {
  COUNTERFACTUAL_WINDOW_S,
  DECISIVE_MARGIN_PCT,
  counterfactualTier,
  computeMitigationAudit,
  computeUnusedSelfCounterfactuals,
  computeMissedExternalCounterfactuals,
} from "../src/utils/counterfactual";

describe("counterfactualTier (three-tier predicate, aligned with quantitative report)", () => {
  const maxHp = 1000_000;
  test("decisive: saved > net + 15% maxHp", () => {
    expect(counterfactualTier(700_001 - 1 + 150_001, 700_000, maxHp)).toBe(
      "decisive",
    );
    expect(counterfactualTier(850_001, 700_000, maxHp)).toBe("decisive");
  });
  test("boundary: exactly equals decisive threshold → marginal (> is strict)", () => {
    expect(counterfactualTier(850_000, 700_000, maxHp)).toBe("marginal");
  });
  test("marginal lower bound: saved ≤ 0.5× net → fatal", () => {
    expect(counterfactualTier(350_000, 700_000, maxHp)).toBe("fatal");
    expect(counterfactualTier(350_001, 700_000, maxHp)).toBe("marginal");
  });
});

describe("computeMitigationAudit (Form A)", () => {
  // Synthetic: death t=60s, window [50,60]; Barkskin (22812, 20%, 0x7f) active [52,58];
  // In-window damageIn: 52.5s 100k (0x1 physical), 55s 200k (0x20 shadow), 59s 300k (0x4 fire, outside aura interval)
  test("arith: reverse extrapolation only accounts for observed damage matching active interval ∩ window ∩ schoolMask", () => {
    const { rows } = computeMitigationAudit(victim, combat, 60);
    const bark = rows.find((r) => r.spellId === "22812")!;
    expect(bark.kind).toBe("arith");
    // (100k+200k) × 20/(100-20) = 75k; 59s damage outside interval not counted
    expect(bark.blockedAmount).toBe(75_000);
    expect(bark.activeOverlapS).toBe(6);
  });
  test("immunity (pct=100): does not reverse extrapolate, reports coverage seconds and observed damage during period", () => {
    // Divine Shield 642 active [54,56], observed during period 0
    const ds = rowsWithImmunity.find((r) => r.spellId === "642")!;
    expect(ds.kind).toBe("immunity");
    expect(ds.blockedAmount).toBeUndefined();
    expect(ds.damageTakenDuringImmunity).toBe(0);
  });
  test("mechanic (in whitelist but not in table, e.g. 6940) → kind=mechanic without numbers", () => {
    const m = rowsWithMechanic.find((r) => r.spellId === "6940")!;
    expect(m.kind).toBe("mechanic");
    expect(m.blockedAmount).toBeUndefined();
  });
  test("positional (196718) skipped without row emission", () => {
    expect(rowsWithDarkness.some((r) => r.spellId === "196718")).toBe(false);
  });
  test("netDamage = absolute HP at window start; unresolvable → null with rows still emitted (blockedAmount does not depend on netDamage)", () => {});
  test("schoolMask filtering: 0x7e magic-only entries do not consume 0x1 physical damage", () => {});
});

describe("computeUnusedSelfCounterfactuals (narrow gate)", () => {
  test("CC deadlock (wasLockedOutThroughWindow) → empty array", () => {});
  test("returns decisive only; marginal/fatal silent", () => {});
  test("positional candidates skipped", () => {});
});

describe("computeMissedExternalCounterfactuals (B)", () => {
  test("in-table external (e.g. 33206 40%) → saved = in-window matching school damage × 40%, decisive only returned", () => {});
  test("unlisted external (e.g. 633 Lay on Hands) skipped", () => {});
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/analysis -- counterfactual`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

Key points in `counterfactual.ts`:
- Whitelist = `bigDefensiveSpellIds ∪ externalDefensiveSpellIds` (single-source derived);
- A: `buildAuraIntervals(victim, combat)` (public version, relative seconds) filter whitelist id → intersect each with window `[deathS-10, deathS]`; `MITIGATION_TABLE[spellId]` hit and non-positional → arith/immunity split by pct; unlisted / `NO_MITIGATION_IDS` → mechanic; positional → skip;
- School filtering: `Number.parseInt(d.spellSchoolId ?? "0x0", 16) & schoolMask`, damage takes `Math.abs(effectiveAmount)`, time filtering uses `d.logLine.timestamp` overlap with active interval ∩ window (interval is in relative seconds, convert to `combat.startTime`);
- Extrapolation: `blocked = observed × pct / (100 - pct)` (rounded integer); immunity branch never enters this formula;
- netDamage / maxHp: `getUnitHpAtTimestamp(victim, startTime + (deathS-10)*1000, HP_SAMPLE_RADIUS_MS)` and maxHp at death timestamp (note: this function returns percentage, absolute values require sampling `advancedActorCurrentHp/advancedActorMaxHp` pairs from `advancedActions`; write intra-module helper `absHpAt(unit, tMs)` returning `{hp, maxHp} | null`, using `HP_SAMPLE_RADIUS_MS` as sampling radius without inventing new radius constants);
- Narrow gate: candidates = victimCds with `cdAvailableAt(cd, deathS)` and in-table non-positional; saved = in-window matching school damage × pct% (unactivated, direct discount basis rather than reverse extrapolation — aligned with quantitative report); if `wasLockedOutThroughWindow(ccSummary, deathS)` is true, return empty; `counterfactualTier` filters to retain decisive only;
- B: same discount basis as narrow gate, per missedExternal; unlisted skipped.

Export all new symbols in `index.ts`.

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test --workspace=packages/analysis` + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis): counterfactual three-tier predicate single source + three forms mitigation arithmetic (17b core)"
```

---

### Task 2: analysis+desktop — B Prerequisite Fixes (External Table Convergence + zoneId Dual-Point)

**Files:**

- Modify: `packages/analysis/src/utils/deathOutcomeAnalysis.ts:69-120` (EXTERNAL_DEFENSIVE_SPELLS 7→14)
- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts:58-72` (zoneId dual-point)
- Test: `packages/analysis/test/deathOutcome.whitelist.test.ts` (new) + existing deathRecap/deathOutcome regression tests

**Interfaces:**

- Produces: `EXTERNAL_DEFENSIVE_SPELLS` key set === `externalDefensiveSpellIds` (14 entries, anti-drift test); desktop path LoS gate operational.

- [ ] **Step 1: Write failing anti-drift test**

```ts
import { describe, expect, test } from "vitest";
import { EXTERNAL_DEFENSIVE_SPELLS } from "../src/utils/deathOutcomeAnalysis";
import spellIdLists from "../src/data/spellIdLists";

describe("deathOutcome external table converges with main whitelist (whitelist corruption fix)", () => {
  test("key set is identical to externalDefensiveSpellIds (14 entries)", () => {
    expect(Object.keys(EXTERNAL_DEFENSIVE_SPELLS).sort()).toEqual(
      [...spellIdLists.externalDefensiveSpellIds].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to confirm failure** (7≠14)

- [ ] **Step 3: Implement**

- Add metadata for 7 missing entries (spellName/cooldownSeconds, matching field structure of existing 7 entries; lookup CD values from `spellEffectData` or game facts with sources documented);
- `deathRecap.ts:61` → `startInfo: { zoneId: (legacy.startInfo as { zoneId?: string } | undefined)?.zoneId ?? "" }`; `:72` → `buildDeathOutcomeSummary({ startTime: legacy.startTime, zoneId: (legacy.startInfo as { zoneId?: string } | undefined)?.zoneId }, players, ccSummaries)`;
- **Corpus before/after metrics**: Run temporary one-off script across full corpus (fixed seed ≥60 matches): total missedExternals under (legacy 7-entry table × LoS broken) vs (new 14-entry table × LoS working), isolating the two contributions (+X entries from table expansion; −Y entries from LoS taking effect). Document numbers in commit message and report.

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test --workspace=packages/analysis` + `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "fix(analysis,desktop): deathOutcome external table 7->14 convergence + deathRecap zoneId dual-point fix (B prerequisite, before/after metrics in body)"
```

---

### Task 3: analysis — 17a Unnecessary Tier + questionable-external Candidate (Corpus Empirical Validation Prerequisite)

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts` (DefensiveTimingLabel + annotateDefensiveTimings)
- Modify: `packages/analysis/src/benchmark/metrics.ts:230-236` (Unnecessary → unknown bucket)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts` (new candidate)
- Modify: `packages/desktop/src/renderer/src/report/derive/mistakes.ts` (MISTAKE_RULES entry)
- Test: `packages/analysis/test/ported/cooldowns.test.ts` (append), `packages/analysis/test/candidateFindings` related (append)

**Interfaces:**

- Produces: `DefensiveTimingLabel` adds `"Unnecessary"`; candidate `type: "questionable-external"` (id `questionable-external:${casterId}:${Math.round(t)}`, facts: t/spell/caster/target/targetHp/nearestBurstGapS, category "cooldowns", not in OFFENSIVE_CANDIDATE_TYPES = defaults to survival route); MISTAKE_RULES entry `{ type: "questionable-external", label: "External cast in no-pressure window", severity: "average", source: "candidate" }`.

- [ ] **Step 0 (Prerequisite Gate): Corpus Empirical Incidence Rate**

Temporary script (`newCandidateScan.ts` skeleton): evaluate 3 Unnecessary conditions for each of the 14 externals across full corpus (threshold targetHp ≥80), output: applicable denominator (matches with external casts), hit rate, SAMPLE_CAP=5 manual inspection samples. **If incidence is ≈0 (<0.5%) or >50% → STOP, report BLOCKED for threshold adjudication**; 5%-30% range is healthy expectation. Include numbers and inspection samples in report.

- [ ] **Step 1: Write failing test**

Append to `cooldowns.test.ts`:

```ts
it("Unnecessary: no burst alignment + target no spike + target high HP → sixth tier", () => {
  // External cast t=30, no burst window / single enemy CD within ±(PRE_WALL/LATE);
  // Beneficiary damageIn in [27,33] total < 50k; target HP sample 92%
  expect(cast.timingLabel).toBe("Unnecessary");
  expect(cast.timingContext).toContain("no pressure");
});
it("three conditions independently veto: with spike → no emit; target 78% HP → no emit; window boundary (within PRE_WALL) → remains Early", () => {});
it("unresolvable target → spike evaluation falls back to caster damageIn with context note", () => {});
it("non-external (self defensive) does not enter Unnecessary evaluation (retains 5 tiers)", () => {});
```

- [ ] **Step 2: Run test to confirm failure**

- [ ] **Step 3: Implement**

- Add `"Unnecessary"` to `DefensiveTimingLabel`; insert 6th tier evaluation in `annotateDefensiveTimings` before tertiary fallback to `Unknown`, **only when** `EXTERNAL_DEFENSIVE_IDS.has(cd.spellId)`:
  - No burst alignment: reaching fallback itself means no alignment;
  - Target spike: `cast.targetName` → `combat.units` lookup target unit (match by name), perform before/after window check on **target's** damageIn matching Reactive pattern (using `TIMING_DAMAGE_WINDOW_S`, criterion: **both** before and after < 50,000 = no spike); unresolvable target → fallback to caster damageIn with note "(caster-side fallback)" in context;
  - Target high HP: `cast.targetHpPct !== undefined && cast.targetHpPct >= UNNECESSARY_TARGET_HP_PCT` (export constant, value from Step 0 empirical data, prior 80; missing targetHpPct → no evaluation, falls to Unknown);
  - `timingContext`: one sentence with 3 reasons (including target name/HP/nearest burst window gap);
- `metrics.ts` TimingCounts bucket: `case "Unnecessary": counts.unknown++` (comment: spec baselines offline 5-tier criteria, not regenerated);
- `candidateFindings`: `questionableExternalEvents(...)` consumes annotated casts (`timingLabel === "Unnecessary"`), wired into `extractCandidateFindings`; format all facts numbers with `fmt`;
- `MISTAKE_RULES` entry added per Interfaces.

- [ ] **Step 4: Run test to confirm pass**

Run: analysis + desktop full suite + typecheck (desktop mistakes anti-corruption test must pass).

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis,desktop): 17a Unnecessary 6th tier + questionable-external candidate / MISTAKE dual registration (empirical incidence in report)"
```

---

### Task 4: Output Surface — Death Recap Card + [DEATH] Prompt Line

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts` (add fields to DeathRecap)
- Modify: `packages/desktop/src/renderer/src/report/components/DeathRecapCard.tsx` (new section)
- Modify: `packages/analysis/src/context/matchTimelineSections.ts` (appended line in emitFriendlyDeathEntries)
- Modify: `packages/analysis/src/context/buildMatchContext.ts` (pass required dependencies to emit)
- Test: `packages/desktop/test/deathRecap` related (append), `packages/analysis/test/context.timelineSections.test.ts` (append)

**Interfaces:**

- Consumes: All Task 1 exports, missedExternals fixed in Task 2.
- Produces: `DeathRecap` adds `mitigationAudit: IMitigationAuditRow[]` and `counterfactuals: ICounterfactualHit[]` (decisive only, B + narrow gate combined).

- [ ] **Step 1: Write failing test**

- desktop: Synthetic source with Barkskin active in death window → `deriveDeathRecaps` returns recap with `mitigationAudit` (assert exact numbers on blockedAmount); card renders "Mitigation audit" section (`data-testid="recap-mitigation"`) and decisive lines (`data-testid="recap-counterfactual"`, omitted when no decisive hits);
- analysis: timelineSections test asserts appended line in [DEATH] block (indented precedent format):
  - `               Mitigation audit: Barkskin blocked ~75k (≈8% max HP) over 6.0s active`
  - When decisive: `               Counterfactual (arithmetic, single-factor): Pain Suppression from <caster> would have cut window damage below lethal (margin >15% max HP)`
  - **Omitted when no decisive hits and no active defensives** (empty yields no lines).

- [ ] **Step 2: Run test to confirm failure**

- [ ] **Step 3: Implement**

- `deathRecap.ts`: Call 3 Task 1 functions for each recap (victimCds from `extractMajorCooldowns` results; ccSummary existing; missedExternals from Task 2 outcome), populate 2 new fields;
- `DeathRecapCard.tsx`: Insert "Mitigation audit" section after verdict section (per row: ability name + blocked X (≈N% maxHp) / immunity coverage Xs / mechanic special not participating in arithmetic) and decisive counterfactual line (possibility wording: "If <ability> had covered this window, damage would have dropped below lethal (margin >15% max HP) — arithmetic basis, single-factor");
- `matchTimelineSections.ts`: Add `counterfactualOf?: (victimName: string) => { auditLines: string[]; decisiveLines: string[] }` parameter to `emitFriendlyDeathEntries`; wire implementation in `buildMatchContext` (calls Task 1 functions, formats numbers to render grid with `fmt`/`fmtTime`); English prompt copy and Chinese card copy are independent but share identical numeric sources;
- causalLint compatibility self-check: avoid "led to/caused/resulted in" (use "would have cut ... below lethal" subjunctive).

- [ ] **Step 4: Run test to confirm pass + run-ui visual check**

analysis + desktop full suite + typecheck + eslint; inspect death recap card new section rendering with death fixtures in dev:ui.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis,desktop): mitigation audit / counterfactual dual-sided output — death recap card + [DEATH] prompt line (shared arithmetic)"
```

---

### Task 5: Gates, Push, CI, Baselines, Ledger Wrap-up

**Files:**

- Modify: `docs/BACKLOG.md` (#17.1/#17.3 notes)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png` (if death recap card is captured, regenerate in CI for human review)

- [ ] **Step 1**: `(cd /Users/mingjianliu/code/gladlog-wt-17 && npm run presubmit)` all green.
- [ ] **Step 2**: BACKLOG: Add ✅ to #17 item 1 (questionable-external landed + incidence rate); add notes to item 3 (A/B/narrow gate landed, 17c not done; spec path); commit + push.
- [ ] **Step 3**: Monitor CI by headSha; if frontend-qa fails on death recap card baseline → expected, proceed to Step 4; otherwise report failure.
- [ ] **Step 4**: Regenerate visual baseline in CI → human review → commit and push to verify green.
- [ ] **Step 5**: Report: 17a incidence rate and sampling, Task 2 before/after metrics, A/B/narrow gate empirical trigger rates across real corpus (compared with quantitative report 33.2%/23.0%/1.3%), **real model smoke test handover note** (new prompt lines represent new audit surface, left for real machine).

---

## Self-Review Records (Run Before Finalization)

1. **Spec Coverage**: Three-tier predicate single source + A/B/narrow gate arithmetic (T1), B two prerequisite fixes (T2), 17a full chain + empirical prerequisite (T3), dual-sided output + phrasing discipline (T4), ledger wrap-up and smoke test handover (T5). Mechanic types do not expand table = T1 mechanic branch; positional skipped = T1; immunity not reverse-extrapolated = T1; CC deadlock does not trigger = T1 narrow gate.
2. **Placeholders**: T1/T3 contain commented test skeletons with criteria and assertions specified; T3 threshold "determined after empirical testing, prior 80" is a design specification rather than TBD.
3. **Type Consistency**: `ICounterfactualHit/IMitigationAuditRow/CounterfactualTier` defined in T1, consumed in T4; `counterfactualOf` callback signature consistent in T4; `questionable-external` string consistent across 3 places (candidate / MISTAKE / tests).
