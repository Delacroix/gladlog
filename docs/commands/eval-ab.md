# eval-ab — A/B Validation for Prompt Builder Changes

Validates whether a specific _prompt builder code_ change (`buildMatchContext` and its dependencies) truly improves scores: same batch of local logs, two-arm build, blind evaluation, paired statistics. Stateful — reads `$GLADLOG_EVAL_HOME/ab/<abId>/state.json` to determine which phase to run.

> Use `/eval-baseline` to find "what to fix next"; run `/calibrate-judge` before trusting the judge.

Suggested `abId` format: `YYYY-MM-DD-<change-slug>`. gladlog simplification compared to upstream: **no need to save raw logs** — corpus comes from the local log manifest, matchId is a content hash, rebuilding both arms from the same manifest naturally produces pairs (ordinal is determined by the corpus builder; when corpus builder code is not part of the test surface, ordinals are stable across arms; if your change modifies the corpus builder itself, stop first — that cannot be tested by this workflow).

## Argument Handling

- No arguments → Automatically determine phase from state: no state → Phase 1 (Control); `control-ready`/`treatment-ready` → Phase 2 (Treatment)
- `adopt` / `abandon` → Phase 3 (Wrap-up)

## Shared: Response Generation (Common to Both Arms)

Execute `eval-baseline.md` Step 2 (including `MATCHID:` header and ordinal integrity checks) on arm directory `BASE` (Phase 1 = `ab/<abId>/control`, Phase 2 = `ab/<abId>/treatment`), writing responses to `BASE/responses/NNN.txt`; then run deterministic quality checks:

```bash
BASE_DIR="<BASE>" npx tsx packages/eval/scripts/qualityCheck.ts
```

**Neither arm is scored individually.** All rubric scoring is performed only once during blind evaluation in Phase 2 Step 2.4 — scoring while knowing the arm identity (or having implemented the test change) = unblinding bias, forbidden.

## Phase 1 — Control

1. **Ask the user two things** (in a single message): What change is being tested? Which dimension is targeted for improvement? Wait for response.
2. **On control code** (usually = main, without the tested change), build the control arm:
   ```bash
   npx tsx packages/eval/scripts/buildCorpus.ts --manifest "$GLADLOG_EVAL_HOME/corpus/manifest.txt" --run <temp>  # or direct
   BASE_DIR version: If builder doesn't support arbitrary dirs, run with --run first then move to ab/<abId>/control/
   ```
   In practice: `buildCorpus --manifest … --run ab-<abId>-control` followed by `mv "$GLADLOG_EVAL_HOME/runs/ab-<abId>-control" "$GLADLOG_EVAL_HOME/ab/<abId>/control"`.
3. Shared response generation (BASE=control). **Do not score.**
4. Write `ab/<abId>/state.json`:
   ```json
   {
     "phase": "control-ready",
     "manifest": "<path to used log manifest>",
     "fingerprint": "<control fingerprint.txt content>",
     "controlRunDate": "YYYY-MM-DD",
     "controlCommit": "<git rev-parse --short HEAD>",
     "treatmentRuns": 0,
     "targetDimension": "<dimension>",
     "changeDescription": "<change description>"
   }
   ```
5. Report: control ready (N matches, unscored), prompt user to implement the change before running `/eval-ab` again.

## Phase 2 — Treatment

1. Read state, print change / target dimension / control information.
2. **On code containing the tested change**, rebuild the treatment arm using the **exact same manifest** (same method as Phase 1 Step 2, directory `ab/<abId>/treatment`). Verify that treatment `fingerprint.txt` matches the control fingerprint in state — **mismatch = differing corpus, comparison rejected, abort**.
3. **Both arms must genuinely differ (pre-flight, prior to response generation):** When the tested change modifies the prompt builder, diff prompts between both arms — if all are verbatim identical = one arm used the wrong code, abort and investigate. Known pitfall (experienced 2026-07-15): **git worktree + symlinked root node_modules** — workspace package symlink (`node_modules/@gladlog/analysis → ../../packages/analysis`) resolves relatively back to main tree source, causing control arm to silently build using HEAD. Must run `npm ci` in worktree to install its own node_modules.
   ```bash
   diff -qr ab/<abId>/control/prompts ab/<abId>/treatment/prompts | head -3   # differences expected; no difference = abort
   ```
4. Shared response generation (BASE=treatment).
5. **Blind Evaluation:**

   ```bash
   AB_DIR="$GLADLOG_EVAL_HOME/ab/<abId>" npx tsx packages/eval/scripts/blindPool.ts
   ```

   > **Blind Evaluation Cardinal Rule (Non-negotiable):** Do NOT read `blind/mapping.json` until all blind scores are written — not now, not "just to verify", not even on error. Having implemented the tested change, knowing which item is treatment destroys the comparison. Only `abStats` reads `mapping.json`.
   >
   > **Equal Cardinal Rule — Blind Item Content:** The orchestrator must only **list directories** in `blind/items/` to obtain `ITEMID`s; never read any `prompt.txt`/`response.txt` content, nor read `blind/scores/*.json` (contents or sha256 can be reverse-mapped to arm identities using the files you just built). Check whether score files are complete solely via file existence (`ls`); defer integrity validation until after unblinding.

   Launch one background scoring subagent for each directory in `blind/items/` (self-contained, one agent per item — never feed two items to one agent, or it will recognize pairs):

   > You are scoring a WoW arena coaching prompt/response pair. Read
   > `$GLADLOG_EVAL_HOME/ab/<abId>/blind/items/ITEMID/prompt.txt` and `.../ITEMID/response.txt`.
   > Apply the scoring rubric from `docs/commands/eval-baseline.md` Step 3 exactly (three-pass
   > process, 1/3/5 anchors; there is no quality-report.json for this item — skip the consistency
   > rules that reference it). Do not read any other file or directory. Write ONLY the score JSON
   > (standard 7-dimension format, factAudit + provenance included) to
   > `$GLADLOG_EVAL_HOME/ab/<abId>/blind/scores/ITEMID.json`. In that JSON set `matchId` to
   > exactly `ITEMID` — the blind item id. Do not guess, invent, or go looking for a real match id.

   (matchId=ITEMID is a fixed placeholder convention — blind items by design omit the `MATCHID:` header; in the 2026-07-20 run, judges
   invented three different variations: `null`/`"unknown"`/`"NO_MATCHID_HEADER_FOUND"`. abStats checks this field during unblinding:
   values not equal to the blind item id are flagged as non-compliant; values equal to the **real** matchId trigger a dedicated unblinding breach alert.
   All subsequent analyses aggregated by real matchId are converted via `blind/mapping.json`.)

   **K-Replicate Judges (Optional, default K=1):** Empirical acceptance testing on 2026-08-06 (spec
   `2026-08-05-judge-noise-floor-design.md` results) showed K=3 median only reduced same-content paired SD from
   0.93 to 0.75 — replicate errors are correlated, failing the ≤0.5 hard threshold, so it is **not used as default**; A/B defaults to a single judge
   `blind/scores/ITEMID.json`, keeping minimum detectable |Δ| ~0.4, with smaller differences adjudicated by deterministic text criteria.
   If experimentally enabling K-replicates: dispatch K independent judges per ITEMID (judges on the same item remain mutually unaware, preserving
   the one-item-one-agent cardinal rule), writing scores to `blind/scores/ITEMID.r1.json` / `.r2.json` / `.r3.json` respectively.
   abStats automatically recognizes both naming conventions: K-mode takes the per-dimension median for each item before pairing; if an item has fewer than 2 scores,
   the entire pair is dropped due to missing scores; if exactly 2, the mean is taken and annotated in replicateSummary. accuracy is always aggregated using
   the `computeAccuracyFromFactAudit` value calculated from each judge's factAudit (rubric in eval-baseline.md).

   After all scores are written, unblind and compute paired statistics:

   ```bash
   AB_DIR="$GLADLOG_EVAL_HOME/ab/<abId>" npx tsx packages/eval/scripts/abStats.ts
   ```

   Outputs per-dimension mean Δ, SD, 95% bootstrap CI, sign test p-value, verdict (improved/regressed = CI excludes 0), and writes `comparison-stats.json`.

6. **Comparison Report** `ab/<abId>/comparison-report.md`, two categories of evidence:
   - **Deterministic Metrics** (basis for adjudicating sufficiency/noise/labelBias): diff `quality-report.json` across both arms — coverage, repetition rate, spammy lines, biased terms, hard failures, approximate token count.
   - **Blind Evaluation Statistics** (basis for adjudicating accuracy/outcomeAlignment/focusCalibration/inferenceScaffolding): abStats table.
     The sufficiency/noise rows in the blind evaluation table are for display only with **no adjudicative authority** — blind evaluators review prompts individually without quality-report anchors, unable to see what the builder change added/removed (upstream empirical evidence: F20 pilot, where kick-interrupt coverage differed by 88 percentage points yet both arms received judge sufficiency 4.9). These dimensions rely on deterministic diffs.
     Report structure: Deterministic Metrics table → Target dimension per-ordinal table (after unblinding) → All-dimension blind eval stats table → Regressions (dimensions where CI is entirely negative + clearly worsened deterministic metrics; inconclusive dimensions with negative point estimates are labeled "(inconclusive — monitor)" and not counted as regressions) → New Issues (items where treatment blind score ≤2 while paired control >2) → Triage (fix now / next cycle / backlog) → Rubric Feedback → Decision (IMPROVED/INCONCLUSIVE/REGRESSED + recommendation ADOPT/ABANDON/ITERATE; state inconclusive plainly, adopting based on deterministic reasons is user discretion — never package inconclusive as a win).
7. Increment `treatmentRuns` in state by 1, keep phase as `treatment-ready`; print summary.

## Phase 3 — Wrap-up (adopt / abandon)

1. Read state and print summary; if `abandon`, remind to revert code changes.
2. **Write ledger before deleting artifacts**: Append a row to the A/B cycles table in `$GLADLOG_EVAL_HOME/ledger.md` (date, commit, change description, target dimension, pairs n, target mean Δ (95% CI), verdict, decision, notes — including justification when adopting on deterministic grounds). `ab/<abId>/` is about to be deleted; the ledger row is the only persistent record of this run.
3. Extract and preserve the Rubric Feedback section from comparison-report, then `rm -rf "$GLADLOG_EVAL_HOME/ab/<abId>"`.
4. Print rubric feedback and next steps (adopt → change is live, run `/eval-baseline` to establish a new baseline; abandon → revert then run `/eval-baseline` to confirm baseline unchanged).

## Must Do Before Starting: Calculate Minimum Detectable Effect (MDE)

**Empirical result 2026-07-20: A full A/B run with 50 pairs and ~200 subagents finished with all seven dimensions inconclusive —
not because the change was useless, but because the ruler's ticks were coarser than the effect being measured.** This section exists to prevent wasting money again.

Before dispatching any subagents, calculate MDE using the noise floor from the table below:

```
MDE ≈ 1.96 × SD / √n        (n = number of pairs)
```

SD of per-pair differences across dimensions (2026-07-20, 50 pairs, sonnet judge, 7-dimension 1–5 integer rubric):

| Dimension            | SD       | Tied in 50 pairs | MDE for n=50 |
| -------------------- | -------- | ---------------- | ------------ |
| focusCalibration     | 0.14     | 49               | 0.04         |
| outcomeAlignment     | 0.25     | 47               | 0.07         |
| labelBias            | 0.43     | 41               | 0.12         |
| inferenceScaffolding | 0.55     | 41               | 0.15         |
| noise                | 0.60     | 32               | 0.17         |
| sufficiency          | 0.65     | 38               | 0.18         |
| **accuracy**         | **1.30** | **14**           | **0.36**     |

**accuracy is an outlier** — SD is 2x the second highest dimension and 9x the lowest, with 36 out of 50 pairs varying.
When choosing it as the target dimension, `|Δ| < 0.36` is completely undetectable at n=50; detecting Δ=0.2 requires n≈331 pairs.

### When Target Dimension is accuracy, Anchor on factAudit Instead

Empirical testing on the same batch of data showed that the variance of `factAudit` refuted **count** (rubric fixes 3 load-bearing claims per item,
so total claims across arms are naturally equal with no count confound) is only **48%** of the accuracy score variance:

| Metric                  | SD    | MDE for n=50 |
| ----------------------- | ----- | ------------ |
| accuracy (1–5 scale)    | 1.298 | 0.36         |
| factAudit refuted count | 0.842 | **0.23**     |

Resolution increases by 36%. Note this is not "stronger signal" (effect sizes d are comparable), but **higher precision**;
the tradeoff is a coarse 0–3 scale, but an observed SD of 0.84 demonstrates sufficient dispersion to support analysis.

### Never Write Labels Alone in Conclusions

If CI spans 0 it is inconclusive, but **do not write just "inconclusive, monitor"** — you must include
point estimate, CI, and MDE for that n, enabling readers to distinguish "measured no difference" from "lacked power to detect a difference":

> accuracy Δ = −0.30 (95% CI −0.66 ~ +0.06), MDE for n=50 = 0.36.
> CI crosses 0, not significant; point estimate is negative, aligned in direction with factAudit refuted rate (8.7% → 14.0%,
> CI −0.024 ~ +0.131). Both fall below the detectable threshold for this sample size, **qualifying as "underpowered to detect"
> rather than "detected no difference"**, labeled (inconclusive — monitor).

## Notes

- Blind scoring is executed by subagents; the orchestrator session **never** scores items directly — it knows what changed.
- Blind evaluation statistics are just noise until the judge passes `/calibrate-judge` — calibrate first.
- Under small samples (10–40 pairs), sign test + bootstrap CI serve as primary evidence; not significant means not significant.
- **Deterministic metrics can independently support ADOPT; lack of detection in blind eval does not constitute a veto.** They do not measure the same thing:
  deterministic checks measure **whether the rendered artifact itself is self-contradictory** (e.g. prompt claiming the same unit at the same second is both 88% and 2%
  HP, which is a correctness property of the artifact regardless of whether anyone notices); blind evaluation measures **whether downstream coaching quality
  improved**, which is a harder and noisier question. A null obtained from an instrument with an already-measured high noise floor
  **is not evidence of absence of effect**. Cross-AI review previously offered an opposing opinion on this point (advocating REJECT),
  but its argument rested on misinterpreting "reducing 185 hard failure lines to zero" as "a line number", and was rejected.
