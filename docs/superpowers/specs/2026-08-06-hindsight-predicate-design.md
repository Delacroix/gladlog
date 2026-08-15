# Product-Side Hindsight Bias Predicate (Subproject C) Design

Date: 2026-08-06. Batch: Evaluation Engineering Improvements B→A→C→D, part C (B and A are concluded). Anchor semantics confirmed by user: **Implicit Anchors + Exemption List** (zero output contract changes, zero PROMPT_VERSION bump, zero cache invalidation).

## Pain Points and Goals

The findings pipeline (`buildFindingsPrompt.ts` → `parseModelJsonArray` → `auditFindings`) has four layers of deterministic validation on model output (grounding / ambiguity / numbers / causality lint), but **zero temporal sequencing checks**: the model can cite an event at t=130s to write advice, and then cite a death event at t=160s as evidence—"if you used trinket at 2:10 you wouldn't have died at 2:40" style hindsight bias. Currently, this is only blocked by prose rules (no-causation), which can be bypassed by rephrasing. Goal: upgrade temporal constraints to a deterministic predicate, exported in one place, consumed by both product and eval sides, and added to the predicate index.

## Design 1: Predicate Definition

New file `packages/analysis/src/analysis/hindsightLint.ts`, exports:

```ts
export const HINDSIGHT_CLUSTER_SLACK_S = 30; // Cluster window for a single engagement; independent constant, semantics ≠ PACK_BEFORE_S
export function hindsightViolations(
  eventIds: string[], // Called by the audit layer after grounding, IDs are guaranteed to be resolvable
  byId: Map<string, CandidateEvent>, // Requires .facts.t and .type
): string[]; // Empty array = pass; violations return human-readable reasons (zh, includes hindsight: prefix)
```

Rules (comparison is based on **rendered facts** `Number(facts.t)`—the values the model sees in the menu; `facts.t === undefined` means menu-rendered `t=whole-round`, not `CandidateEvent.t`, as filling 0 for whole-round candidates would poison the min calculation):

1. **Anchor** T = the minimum `t` among cited events **that have a timestamp**. Whole-round events (no `t`) do not participate in anchor calculation, and **do not exempt the entire finding** (to prevent bypass: inserting a whole-round citation cannot disable the predicate); if there are fewer than 2 timestamped events ⇒ pass.
2. Let Anchor Cluster = all cited events where `t ≤ T + HINDSIGHT_CLUSTER_SLACK_S`. For each cited event e, if `e.t − T > HINDSIGHT_CLUSTER_SLACK_S` **AND** `e.type` is not in the type set of the Anchor Cluster ⇒ violation ("Cited a {e.type} event at {e.t}s which is beyond the cluster window of {T}s from the anchor, and crosses types"). (No ambiguity when anchors tie with multiple types: the cluster type set naturally contains all tied types.)
3. **Exemption List** (both are already implied in the rules, listed to solidify semantics):
   - **Same type repetition** = Pattern-class finding ("You ate kicks at 1:10, 2:30, and 4:00")—aggregate advice has no specific anchor, legal;
   - **Future facts declared by producer** (`facts.deathT` in death-setup, etc.)—these are **facts fields of a single event**, not another cited event, so the predicate naturally does not trigger; the legend already requires death-setup to only cite itself.

Design trade-offs: We do not read the explanation text to judge "intent" (undecidable), but only constrain the **citation structure**—multi-event citations spanning types and cluster windows are better split into independent findings as coaching outputs anyway; the 30s cluster window allows legal combinations within the "same engagement" (missed kick + CC chain locked within the same 10s).

## Design 2: Consumers (One Predicate, Two Sides)

1. **Product Gate (auditFindings)**: Fifth layer drop, reason takes the returned string from the predicate directly (the predicate includes the `hindsight: ` prefix natively, so the consumer **no longer concatenates the prefix** to prevent `hindsight: hindsight:` duplication), placed after causalLint and before accept. dropped[] flows through the existing onDrop diagnostic channel, visible in the developer workbench. **Direct enforce (drop)**, no shadow/flag period—Rationale: hindsight advice is a hard quality flaw, and the rules are conservatively designed based on structure (false positive surface = genuine cross-type cross-timeframe citations, covered by smoke tests, see Design 3).
2. **Eval Side**: `packages/eval/scripts/hindsightScan.ts` corpus scan (rotScan paradigm)—rebuild candidate menus for corpus matches + synthesize/replay findings to run the same predicate, quantifying violation rates; planted acceptance testing (taking two events from a real menu that are cross-type and cross-window to synthesize a finding) is also implemented here (Implementation correction: the originally planned `buildCalibrationSuite` `hindsight-pair` perturbation class is not done—judge calibration is unrelated to deterministic predicates).
3. **Predicate Index**: `docs/predicate-index.md` + `.zh-CN.md` add a row to the "Gate side" section (`hindsightViolations` + `HINDSIGHT_CLUSTER_SLACK_S`), `predicateIndex.test.ts` pinning (symbol existence + constant single source).

## Design 3: Acceptance (Before/After Numbers, Same Criteria)

| Criteria | Pass Threshold |
| --- | --- |
| Planted Detection: synthesize 20 cross-type cross-window findings from real corpus menus | Predicate captures 20/20 |
| Legal Fidelity: multiple events of same type + clusters within 30s + death-setup single event, totaling 20 synthesized legal findings | 0/20 false positives |
| Real Smoke Test: 20-match corpus sonnet responder runs full findings pipeline, statisticizing hindsight drop rate | Report truthfully; drops reviewed manually line-by-line, if false positives >1/3 then re-tune SLACK/rules (no silent relaxation) |
| Unit Tests | Predicate boundaries (exactly 30s, whole-round, cross-timeframe same type, single event) all green |

### Acceptance Results (Measured 2026-08-06)

| Criteria | Actual Measurement | Verdict |
| --- | --- | --- |
| Planted Detection | **20/20 Captured** (synthesized from 398 menus / 302 real corpus matches, including combinations like death + early event, death-setup + distant cross-type) | ✅ |
| Legal Fidelity | **20/20 Passed, 0 false positives** (same type pairs, cluster pairs within 30s, single events, whole-round fully covered) | ✅ |
| Real Smoke Test | 20 matches sonnet responder full pipeline, **101 findings, 0 hindsight drops, 0 total drops**; cross-type combinations (death+missed-purge Δ9s/Δ14s) passed legally within cluster window | ✅ Zero false positives; truthful note: under current prompt discipline, the model did not naturally generate violations. The value of the predicate is a deterministic insurance against regressions/model changes/prompt alterations, not cleaning up existing stock |
| Unit Tests | 8/8 Green (boundaries fully covered) | ✅ |

## Landing Files

- New files `packages/analysis/src/analysis/hindsightLint.ts` + `hindsightLint.test.ts`;
- `packages/analysis/src/analysis/auditFindings.ts`: Fifth layer drop;
- `packages/eval/scripts/hindsightScan.ts` + `packages/eval/src/quality/hindsightScan.ts` + `packages/eval/src/corpus/candidateMenu.ts` (smoke test / occurrence rate; planted synthesis implemented here—originally planned `buildCalibrationSuite` `hindsight-pair` perturbation class is **not done**: judge calibration is unrelated to deterministic predicates, planted acceptance is handled by hindsightScan, corrected during implementation);
- `docs/predicate-index.md` / `.zh-CN.md` + `packages/eval/test/predicateIndex.test.ts`.

## Explicitly Not Doing

- Temporal audits for the deepDive pipeline (the +10s trailing window for packs is intentional design, window pattern semantics differ—handled in separate follow-up tasks, not mixed into this predicate);
- Explanation text-level hindsight sentence structure recognition (causalLint already covers causal sentences; intent is undecidable, structural constraints are sufficient);
- Adding anchorEventId to findings schema (user rejected, zero contract changes is the core constraint of this plan);
- Retroactive cleaning of old cached analysis results (the predicate only governs the new generation pipeline).
