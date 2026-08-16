# 2026-07-20 Retrospective — Eight Classes of Prompt Self-Contradiction Fixes and Blind A/B Evaluation

> Archived record (originally two HANDOFFs, merged upon completion). **Technical root causes have been documented in comments directly within relevant code**
> — they will naturally be encountered when modifying that code without needing to refer back here. This document preserves **empirical numbers** and
> **the journey through two mistaken conclusions**, neither of which belongs in code comments.
>
> Relevant single sources of truth: `CLAUDE.md` (single-source predicates, fixes requiring before/after numbers),
> `docs/commands/eval-ab.md` (MDE and adjudication rules), `docs/BACKLOG.md` Section 14 (leftovers).

## One-Sentence Conclusion

All eight classes of prompt self-contradiction defects were fixed, **each with before/after numbers under identical criteria**.
The subsequent blind A/B evaluation **did not detect a coaching quality improvement** (all seven dimensions inconclusive, including the target accuracy dimension) —
adoption was justified based on deterministic metrics, not A/B results. Any claim reading this round as "A/B verified" is incorrect.

---

# Part 1 · Eight Classes of Defect Fixes

## Summary Table of Fixes

All fixes were verified using **deterministic A/B** (same corpus fingerprint `be78167b..2faaf381`, 50 matches, **no model calls**): rebuild prompt → count violations using text criteria → compare before vs after.

| Class | Defect                                                                | Pre-fix                        | Post-fix   | commit    |
| ----- | --------------------------------------------------------------------- | ------------------------------ | ---------- | --------- |
| A     | `[DMG SPIKE]` HP contradicts same-second `[STATE]`                    | 33 places across 26/50 matches | **0**      | `0e13264` |
| B     | Baseline percentile inversion p50>p90                                 | 14/50 matches                  | **0**      | `0e13264` |
| C     | Inline embedded `(X% HP)` contradicts same-second STATE               | 2/50 matches                   | **0**      | `f42fca1` |
| E/G   | Window duration mismatches displayed start/end                        | 4/33 lines                     | **0**      | `cd60380` |
| E/G   | Missing legends for notations (`[n/m]`/`rdy:Δ`/spike timestamp)       | —                              | Added      | `cd60380` |
| H     | Two rounding conventions for duration (0:36 vs 37s)                   | —                              | Fixed      | `cd60380` |
| F     | Missing DR annotations on self-cast CC                                | 0/159 lines                    | **86/159** | `be36279` |
| I     | OFFENSIVE WINDOW damage mismatches interval                           | —                              | Fixed      | `23de9f5` |
| **D** | Cooldown ledger contradiction (two cooldown constants for same spell) | 1/50 matches                   | **0**      | `c820ad4` |

> **Class D had an initial false conclusion.** Commit `dbe61bd` initially determined "not a data inconsistency, just notation ambiguity" and only updated the legend —
> that resulted from **extrapolating an entire class after checking only a single sample (Lay on Hands)**. The real root cause was that `deathOutcomeAnalysis` private table
> and the main path independently maintained cooldown values (Ironbark 45s vs 65s), overturned by a blind eval responder counterexample and fixed in `c820ad4`.
> See Class D subsection at the end of this document for details.

---

## Most Important Lesson: First Ask "Are Both Queries Checking the Exact Same Timestamp?"

**The first-version fix for Class A was wrong and completely ineffective.**

Commit `3cd5342` attempted a fix via "unifying sampling radii" (reasoning seemingly sound: `[STATE]` used ±1.5s in critical windows while
`[DMG SPIKE]` consistently used ±3s). Empirically, **26/50 → 26/50, not a single number changed**.

Reason: `getUnitHpAtTimestamp` **first fetches the nearest sample, then uses maxDtMs to decide whether to accept it**.
Changing the radius can only turn values into `null`, **never altering the fetched number**.

The real root cause was query timestamps being on different grids: `[STATE]` sampled on integer seconds, while `[DMG SPIKE]` sampled on
`pw.fromSeconds` (fractional seconds), yet both rendered to the same displayed second via `fmtTime`.
Aligning query timestamps dropped violations from 26/50 to 0/50.

> Whenever faced with "numbers inconsistent between two places", **first ask whether they query the same timestamp**, before asking about radius.
> This is the literal scenario of CLAUDE.md's rule: "fractional seconds within analysis must first be floored to the render grid".

**Follow-up (`dbe61bd`): The two-tier radius mechanism was removed entirely**, rather than just reverting `3cd5342`. Because the narrowed
radius existed on the STATE side prior to `3cd5342`, a simple revert would leave the same latent defect. Removal was justified by empirical data:
it was redundant with the STATE emission gate (HP change ≥10% to emit a line), and in **24/50 matches** it completely dropped units from the
`[STATE]` line — precisely units taking no damage whose HP remained stable. After removal, A/C stayed at 0, and STATE HP readings increased
from 6349 to 6380. **To improve freshness, modify emission gates or sampling sources; do not introduce a second radius.**

Class C concealed a third layer: enemy target HP bypassed `getHpPercentAtTime` entirely, using `cast.targetHpPct` — pre-computed in
`cooldowns.ts` during cooldown extraction using **raw log milliseconds + hardcoded 2000ms radius**. **A third sampling path for the exact same fact.**

## Newly Added Shared Predicates (Do Not Implement Separately Again)

| Predicate                         | Location                     | Responsibility                                                                       |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `toRenderSecond(t)`               | `utils/cooldowns.ts`         | Aligns sampling timestamp to render grid (matches `fmtTime` rule)                    |
| `renderedWindowSeconds(from,to)`  | `utils/cooldowns.ts`         | Derives window width from **displayed endpoints**                                    |
| `toSortedFinite` / `medianFinite` | `utils/stats.ts`             | Order statistics, discarding non-finite values                                       |
| `buildCriticalWindowSet`          | `context/criticalWindows.ts` | Set of critical window seconds (constructed once in buildMatchContext and passed down)|

## Class B Root Cause (Worth Documenting Separately)

`(a,b)=>a-b` returns NaN for NaN; **V8 does not throw on this comparator**, but silently leaves an *incompletely sorted*
array; `percentile()` retrieves out-of-order samples by index. A single NaN causes p50>p90, and when NaN becomes
`null` via `JSON.stringify`, it doesn't necessarily land on the sampled index — **corrupted data looks like "completely normal numbers", just in the wrong order**.

NaN source: `Math.abs(d.effectiveAmount)` for damageIn in `metrics.ts` lacked a guard, whereas damageOut in the same file already had a `"effectiveAmount" in d` guard — it was simply missed in one place.

After recalculation, **4 out of 28 specs** were contaminated: 2 showed visible inversion (Arms/MM), while the other 2
(Feral Druid / Restoration Shaman) happened to remain monotonic after disordering, **never manifesting symptoms**.

## Deterministic Guardrails (All Reparse Rendered Prompt Text)

In `packages/eval/src/quality/promptQualityCheck.ts`, all integrated into `hardFailures`:

- `checkPercentileMonotonicity` — Percentiles in same row must be monotonically non-decreasing (Class B)
- `checkSameSecondHpConsistency` — HP for same unit in same second must be consistent (3pp tolerance);
  Class A's `X% -> Y% HP` and Class C's `→ target (X% HP)` share this criterion
- `checkWindowSpanConsistency` — Annotated duration must equal difference between displayed start and end (Class E/G)
- `checkCooldownLedgerConsistency` — Cooldowns claimed available in MISSED OPTIONS must not simultaneously appear
  in `cd:` of same-second `[RES]` ledger (Class D, completed in `0eeabb2`)

These criteria **do not depend on models** and served as the measurement tool for all A/B evaluations in this round. Replication method:

```bash
npx tsx packages/eval/scripts/buildCorpus.ts \
  --manifest <50-log manifest> --run <runId>
# Then run the four criteria above against runs/<runId>/prompts
```

## Thousand-Match Pipeline Verification (After All Changes Landed)

`pipelineFuzz --count 1000 --run fuzz-2026-07-20-postfix`:

```
{"files":1000,"parseFail":0,"matches":695,"rounds":1830,"combatsAudited":2525}
229 findings —— all cjk:* (CN server player names, legitimate), identical count to pre-change round
```

No new finding categories, zero parse failures, zero anomalies — changes in this round introduced no pipeline regressions.

---

## Class D Cooldown Ledger Contradiction — Fixed (`c820ad4`), but Failed Once First

> **⚠️ Two conclusions; the first was wrong.** Commit `dbe61bd` determined "not a data inconsistency, just change the legend" —
> **that conclusion was overturned by `c820ad4`**. Real root cause detailed in the "Correction" subsection below. Original notes retained.

The `[RES]` cooldown ledger in death blocks and "DEATHS WITH MISSED OPTIONS" made contradictory availability determinations for the **exact same cooldown**.

**Confirmed facts** (Instance: `003-c5f8395a.txt` @ 2:03):

- Neither `rdy:` nor `cd:` columns in the `[RES]` ledger **contained Lay on Hands**, meaning that path did not track this spell at all
- At the exact same timestamp, MISSED OPTIONS stated "had Lay on Hands available"
- The two paths used **independently maintained spell lists**: missed-options used `deathOutcomeAnalysis.ts`'s private `EXTERNAL_DEFENSIVE_SPELLS` /
  `IMMUNITY_SPELLS`, while the `[RES]` ledger used `extractMajorCooldowns`

### Conclusion 1 (`dbe61bd`) — **Later Disproven, Do Not Rely On**

- The data source for the `[RES]` ledger was **`classMetadata` + `spellEffectData`**, not the guessed `SPELL_CATEGORIES` (which only stores CC/roots/immunities).
- The real divergence involved **only 1 spell**: Lay on Hands (633), absent from both datasets; the other 10 private list entries were present in `classMetadata`.
- **Across the 1000-match corpus (2525 combats), 633 was cast only once.** With n=1, cooldown intervals cannot be measured (requires two casts by the same player), and usage rate approached 0 — per CLAUDE.md whitelist empirical requirements, **insufficient to include in tracking**, especially as it would alter every Paladin prompt.
- Missed-options reporting it available because "never cast = available all match" was not technically wrong. The real issue was that **readers could not distinguish between "untracked by ledger" and "unavailable"**.
- Adopted fix: Clarify in legend that `[RES]` only lists tracked CDs, and absence ≠ unavailable.

### Correction (`c820ad4`) — The Real Root Cause

The conclusion above was flawed because it **checked only a single sample (Lay on Hands) and extrapolated**. In the A/B round, the responder
subagent produced a counterexample on ordinal 041:

- Death at 1:53, `[RES]` ledger had `cd:Ironbark(7s)` (on cooldown)
- MISSED OPTIONS in the same prompt stated "had Ironbark available"
- Ironbark **was** in the tracked list — not a missing whitelist issue

**Real root cause: Two independently maintained cooldown values for the same spell** (duplicate constant drift).
`EXTERNAL_DEFENSIVE_SPELLS` in `deathOutcomeAnalysis.ts` had hardcoded cooldownSeconds (Ironbark 45s), while the main path resolved to 65s via spellEffectData + talent modifications.
Verification: Cast at 0:52 → 0:52+45=1:37 "available"; 0:52+65=1:57, still on cooldown at 1:53.

Fix: `buildDeathOutcomeSummary` accepts a `resolvedCooldownSeconds` resolver parameter, consuming the same resolved cooldowns as the ledger for availability checks. Deterministic A/B: false available claims dropped from 1/50 to 0/50.

> **Two Lessons**
>
> 1. When two determinations conflict, first check if they assert the same fact — but **never conclude based on a single sample**.
>    The Lay on Hands sample was indeed "untracked", whereas Ironbark was a genuine data inconsistency;
>    applying the former conclusion across the entire class missed the latter.
> 2. An independent second pair of eyes has real value: this counterexample was caught by the blind eval responder, which refused to credit
>    MISSED OPTIONS because it contradicted the ledger in the exact same prompt.

---

# Part 2 · Blind A/B Evaluation (Model-Side Verification)

### Conclusion for This Round

**Blind evaluation did not detect a coaching quality improvement (all seven dimensions inconclusive, including the target dimension).
Adoption was justified by deterministic metrics, not A/B.** Any claim reading this round as "A/B verified" is incorrect.

## Why This Round Was Run

The session before last fixed all 8 classes of prompt defects and verified them using **deterministic text criteria** (A 26/50→0,
B 14/50→0, C 2/50→0, E/G 4/33→0, D 1/50→0, F 0→86/159 lines, H/I fixed).

However, that only proved **internal prompt consistency**, not that **coaching quality improved**. This blind A/B round provided the second layer of evidence.
The previous session stopped at 6/100 when the **subagent quota reached 200/200**, and this session completed the remaining 94 cases.

## Results

EVAL_HOME = `/Users/mingjianliu/code/gladlog-eval-private`
abId = `2026-07-20-prompt-defects`; artifacts committed (private repo `ac73af4`).

### Blind Evaluation Statistics (50 pairs, 100 cases, all sonnet)

| Dimension                    | control | treatment | Δ (95% CI)               | p     | Verdict      |
| ---------------------------- | ------- | --------- | ------------------------ | ----- | ------------ |
| **accuracy (target)**        | 4.44    | 4.14      | **−0.30 [−0.66, +0.06]** | 0.243 | inconclusive |
| sufficiency                  | 4.82    | 4.72      | −0.10 [−0.28, 0.06]      | 0.774 | inconclusive |
| noise                        | 4.70    | 4.74      | +0.04 [−0.12, 0.20]      | 0.815 | inconclusive |
| labelBias                    | 4.88    | 4.90      | +0.02 [−0.10, 0.14]      | 1.000 | inconclusive |
| inferenceScaffolding         | 4.86    | 4.92      | +0.06 [−0.10, 0.20]      | 0.508 | inconclusive |
| outcomeAlignment             | 4.98    | 4.96      | −0.02 [−0.10, 0.04]      | 1.000 | inconclusive |
| focusCalibration             | 4.98    | 5.00      | +0.02 [0.00, 0.06]       | 1.000 | inconclusive |

Zero CI regressions, zero new issues — **across 350 dimension scores (50 pairs × 7 dimensions) in both arms, not a single score was ≤2**.
The point estimate for accuracy was negative, marked per workflow as (inconclusive — monitor), not counted as a regression.

### Deterministic Metrics (Basis for Adoption)

| Metric                                       | control               | treatment             |
| -------------------------------------------- | --------------------- | --------------------- |
| hard-failure lines                           | **185**               | **0**                 |
| Matches with ≥1 hard failure                 | **80 / 98**           | **0 / 98**            |
| A DMG SPIKE↔STATE HP divergence              | 71 lines / 51 matches | 0                     |
| B Baseline percentile inversion              | 27 lines / 27 matches | 0                     |
| C `[CD]` embedded HP↔STATE                   | 77 lines / 52 matches | 0                     |
| E/G Window duration mismatches start/end     | 10 lines / 10 matches | 0                     |
| coverage (deaths/cc/interrupt/trinket/dispel)| 100/100/100/100/98.0% | No regression         |
| approxTokens (p50)                           | 4970                  | 5218 (**+5.0%**, cost)|

**Decision: ADOPT — Based on deterministic criteria, not blind evaluation.**
Rationale: The fixes address **internal prompt self-contradictions**. The danger is not immediate score deduction (empirical tests last round showed defects reported in 46/50 matches with only 1 flagged, because responders usually spotted and navigated around contradictions), but that **correctness relies on the model happening to be sufficiently cautious**, and ordinal 043 was observed slipping from "spotted and discarded" into "quoting and paraphrasing". Eliminating contradictions removes this dependency.

## The Most Valuable Outputs This Round Were Methodological, Not Scores

### 1. Accuracy Judge Noise Floor SD = 1.30 — Dimension Nearly Ineffective as an A/B Target

accuracy varied across **36/50 pairs, jumping ±2 on 17 pairs**, with a paired SD of **1.30**, which is **2–9x higher** than the other six dimensions (0.14–0.65). Same underlying matches, same judge model.
**Under this noise level, |Δ| < 0.4 cannot be detected at all**, leaving this round powerless to reject −0.30.

→ Recommend **tying accuracy anchors to the count of refuted claims in `factAudit`** (0 claims → 5, 1 minor claim → 4, 1 load-bearing or 2 claims → 3), replacing discretion with counts; or taking medians across multiple judges on the same case.

### 2. Sufficiency Judge Blind Spot 20% (Calibration Measured)

Under the injection method of "deleting all death lines for the match", judges gave equal or higher scores on **4 out of 5 cases** (5→5, 5→5, 5→5, 4→5).
**This dimension has no adjudicative power in blind eval** and must be arbitrated solely by deterministic coverage gates. This represents cross-round methodological debt.

> Together: **Two of the seven dimensions currently lack adjudicative power.** This must be accounted for when selecting target dimensions in future A/B rounds.

## Leftover Backlog

All transferred to `docs/BACKLOG.md` Section 14 (eval / QA infrastructure backlog); not duplicated here.

## Blind Evaluation Discipline (Strictly Maintained Throughout This Round, Retained Moving Forward)

1. **Do not read `blind/mapping.json`** — Do not read before all scores are written, not on errors, not to "verify". Only `abStats` reads it. This round read it for the first time only after reaching 100/100.
2. **Do not read blind case contents or `blind/scores/*.json`** — Judge completeness strictly using `ls`.
3. **Orchestration sessions must never score cases directly.** A session that implemented the changes under test can easily recognize arms (Class A same-second HP, Class B inverted baselines, Class F DR annotations are all obvious tells); such scores are self-reviews, not evaluations.
4. **Do not selectively redispatch or drop cases based on subagent summary snippets.** Completion notifications contain score summaries, which is the only channel through which orchestrators could inadvertently bias comparisons — redispatch solely based on file presence.
5. **Fixed judge model: sonnet.** Calibration was performed on sonnet; switching models invalidates calibration. Score files already committed were also scored by sonnet; mixing models ruins paired statistics. agy's role is cross-AI review after the report is written.

---

# Part 3 · Pitfalls Encountered (Cumulative Across Two Rounds, Deduplicated)

## Analysis / Fix Side

1. **"Numbers inconsistent between two places": first check if querying the same timestamp, then check tolerance.** Class A's first-version fix failed on this.
2. **Never extrapolate an entire class from a single sample.** Class D stumbled on this.
3. **Defect line ≠ Score line** — 46/50 matches reported defects but only 1 was flagged; responders mostly bypass contradictory data on their own, yielding high `accuracy` scores. Defects must be collected independently.
   **Additionally, judges underreport**: Class B had 11 matches reported by judges vs 14 measured by deterministic criteria.

## Eval Orchestration Side

4. **Subagent quota is a hard ceiling** (200/200 in this session); hitting it requires switching sessions or requesting quota increases — verify before starting work.
5. **Typoing NNN/ITEMID during subagent dispatch is not caught immediately by anything.** Ordinal 041 was once dispatched as 031, caught only during post-hoc integrity checks. Always perform ordinal↔MATCHID verification after dispatch.
6. **Ensure no subagents are in flight before aggregating.** Numbers were once published while a judge was still running; late results shifted two dimension means, requiring errata.
7. **Seven-dimension scores cannot serve as absolute cross-run scales** unless `/calibrate-judge` has been run.
8. **In cross-AI reviews, verify its paraphrased premises**, not just its conclusions. agy delivered an emphatic REJECT this round with flawless arithmetic, but misread "185 **total** hard-failure lines reduced to zero" as "a single line number", and invented the premise that "accuracy is the sum of five subdimensions". Its tone when misreading is indistinguishable from when correct.

## Engineering Side

9. **Local jsdom lacks `localStorage`, CI has it** — Tests relying on persistence fail locally and pass in CI.
10. **`report-*` visual baselines must be regenerated when report UI changes**; running `test:visual` locally will yield false positives. Additionally, the `report-replay` scenario in that suite is inherently flaky (see BACKLOG 14.1).
11. **Never `cd` within compound commands**; **never add pipes to gate chains** (exit code becomes that of tail).
12. **Private eval repos may contain uncommitted changes not from this session** — Commit with explicit paths; never `git add -A`.
