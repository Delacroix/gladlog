# Judge Noise Floor Refactoring (Subproject A) Design

Date: 2026-08-05. Batch: Evaluation Engineering Improvements B→A→C→D, part A; Plan A3 confirmed in batch brainstorm, detailed in this spec. Prerequisite: Subproject B (`2026-08-05-outcome-halo-experiment-design.md`) has ruled **Judge maintains single pass** (halo contamination across the six non-outcome dimensions is unsupported), and provides a new efficacy baseline: same-arm judge paired difference SD=0.94 (accuracy, replacing archive value 1.3).

## Goals and Pain Points

Known pain point (Archive + eval-ab.md:95): Subjective dimensions like accuracy among the 7 dimensions lack resolution in A/B arbitration, unable to detect |Δ|<0.4. Internal consistency fixes can only be adopted based on deterministic criteria. Goals:

1. **Narrow down accuracy noise sources**: Shift from "overall judge scoring intuition" to "line-by-line claim verification"; the scoring step becomes a deterministic calculation;
2. **A/B arbitration resolution** increased to stably detect |Δ|≈0.2 (K=3 median + lower single-judge noise);
3. Calibration detection rate does not regress (currently 7/7 PASS).

## Design 1: Deterministic Accuracy (Structured, Root Fix)

Key fact: Currently, judges **are already** forced to write line-by-line factAudit (each verdict ∈ verified/unsupported/refuted, count constrained by `FACT_AUDIT_MIN/MAX` gate rules), and the accuracy rubric is already an errorCount lookup table (`eval-baseline.md` Step 3 lookup, no interpolation). So the change is only in the final step:

- Judges are responsible for producing factAudit (line-by-line claims + ternary verdict + evidence line citations); the score JSON **still writes the accuracy field to keep the contract unchanged** (downstream abStats/calibration zero changes), but its value must equal the computed lookup value;
- `checkScoreProvenance.ts` adds deterministic calculation: `accuracy = ACCURACY_LOOKUP(refuted+unsupported count)`, lookup rules identically match the current rubric verbatim, table exported as a constant single source;
- Judge-written accuracy does not match calculated value ⇒ provenance FAIL (same level as existing matchId/hash checks)—the scoring step now has zero degrees of freedom;
- rubric (`eval-baseline.md`) rewritten accordingly: the accuracy section changes from "scoring anchors" to "factAudit production specs", ternary verdict definitions follow AgentProcessBench-style 3-class semantics (correct / neutral exploration / error) mapped to the existing verified / unsupported / refuted.

**Not doing cross-judge claim alignment**: The claim sets extracted by different judges naturally won't match, and forcing alignment introduces new noise sources. Each judge generates their own factAudit → their own deterministic score; cross-judge aggregation uses the median in Design 2.

## Design 2: K=3 Multi-Judge, Only for A/B Arbitration

- **Scope (Confirmed)**: Multi-judge K only applies to A/B blind evaluations (where the pain point lies); baseline maintains K=1 (exploratory ranking, tolerating noise; cost not ×3). The protocol takes K as a parameter, defaulting to A/B=3, baseline=1.
- Dispatching: Each blind item gets 3 independent judges (one item one agent iron rule unchanged, the 3 judges for the same item are unaware of each other), score files named `blind/scores/<blindId>.r1.json` / `.r2.json` / `.r3.json` (specific naming goes to plan, must sync with abStats readers).
- Aggregation: `abStats` first takes the **median of the 3 scores** per dimension per item (the three inputs for accuracy are already deterministic scores), then runs the existing paired bootstrap. Missing copy rules: fewer than 2 copies for an item ⇒ item treated as missing score (entire pair discarded and counted); exactly 2 copies ⇒ take average (median of 2 scores) and annotate in the report.
- Cost accounting: 1 round of A/B of 100 pairs = 200 items × 3 = 600 judges (user confirmed acceptance); theoretical resolution gained: median variance ≈ ~0.45x of single judge ⇒ paired SE around 0.94×0.67/√100 ≈ 0.063, stably detecting |Δ|≈0.13-0.2.

## Design 3: Acceptance (Before/After Numbers, Same Criteria)

Same batch of fixed materials (fixed seed, recommend reusing the 100 arm O materials from B—prompt+response already exist, saves responder costs), testing old protocol vs new protocol:

| Criteria | Current Value (Old Protocol) | Pass Threshold |
| --- | --- | --- |
| accuracy inter-judge paired SD (two independent judges on same item) | 0.94 (measured in B) | Single judge deterministic score SD truthfully measured and reported (no hard line, expected to drop); **K=3 median paired SD ≤ 0.5 (hard line)** |
| `/calibrate-judge` planted defect detection | 7/7 dimensions PASS (≥0.8) | No regression (maintain 7/7) |
| Known difference pair detection | \|Δ\|<0.4 undetectable (archive) | Plant a synthesized difference of \|Δ\|≈0.2 (constructed by proportionally mixing in calibration perturbation items), K=3 protocol CI does not contain zero |

If any item cannot be provided, state clearly that it cannot be provided—do not sign off just claiming "the protocol changed, it should logically be more stable".

### Acceptance Results (Measured 2026-08-06, 50 pairs × K=3 = 300 judges, planted 10 pairs +3s)

| Criteria | Actual Measurement | Verdict |
| --- | --- | --- |
| K=1 same-content paired SD | 0.934 (independently reproduced B's 0.94 baseline) | ✅ Baseline credible |
| K=3 median paired SD ≤ 0.5 | **0.751** | ❌ FAIL—Replica errors are correlated (same model, same rubric picking the same facts), median only dropped ~20% |
| Planted Δ detection (CI does not contain zero) | Aggregated −0.10 [−0.32, 0.12] inconclusive; Pairwise: Planted mean −0.50 vs clean 0.000, 6/10 detected | ❌ Aggregation layer FAIL (design assumption of 100% detection rate was wrong, 60% × 20% proportion ≈ −0.12 matches actuals); pairwise signal valid |
| Calibration does not regress | fabricated-claim detection 9/10 (old protocol same suite 8/10; sensitivity 10/10, all suppressed to accuracy=1; the single non-counted pair only had specificity jitter) | ✅ PASS (only re-evaluated 20 accuracy-related items—rubrics for the other 6 dimensions untouched; desensitization relay used caseId to preserve blinding) |
| Accuracy contract consistency | 300/300 zero mismatches (accuracyMismatches=0) | ✅ Deterministic accuracy can be independently adopted |

Detailed report: eval-home `ab/2026-08-06-planted-accuracy/report.md`. **Final Resolution (User confirmed 2026-08-06, Option A)**: Adopt deterministic accuracy (Tasks 1-2: contract + validation gate + rubric, all landed); **K=3 not adopted**—code retained (K as parameter), A/B defaults to maintaining K=1, minimum detectable Δ remains ~0.4, smaller differences will continue to be arbitrated using deterministic text criteria. Heterogeneous replica direction left for future experiments.

## Landing Files

- `docs/commands/eval-baseline.md`: accuracy rubric rewritten (factAudit production specs + declaration that score is calculated by system);
- `packages/eval/src/provenance/checkScoreProvenance.ts`: `ACCURACY_LOOKUP` export (single source) + verdict count → score calculation + self-reported score consistency validation;
- `docs/commands/eval-ab.md` + `packages/eval/src/ab/blindAbPool.ts` (if needed) + `abCompareStats.ts`: K multi-judge dispatch naming convention and median aggregation;
- `packages/eval/src/judge/` (calibration side): checkCalibration reading scores adapted for K multi-judge renaming (calibration itself remains K=1);
- Predicate index bilingual registration `ACCURACY_LOOKUP` (rubric markdown ↔ code constant, pinned by equivalence unit tests, same paradigm as FACT_AUDIT_MIN/MAX).

## Explicitly Not Doing

- Two-pass judge (B already ruled unnecessary);
- Cross-judge claim alignment/merging;
- K multi-judge for baseline;
- Scoring mechanism changes for the other six dimensions (sufficiency is already a deterministic gate; noise/labelBias use deterministic diffs as arbitration in A/B, blind scores naturally have no arbitration power — eval-ab.md:95).
