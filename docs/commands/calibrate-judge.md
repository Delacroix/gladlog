# calibrate-judge — Judge Calibration (Synthetic Defect Meta-Evaluation)

Calibrate before trusting LLM-judge scores (e.g., when introducing a new rubric, switching scoring models, or when the target A/B Δ is very small < 0.5): implant **known defects** into real prompt/response pairs to verify that the judge scores each perturbed case lower on the target dimension than its unperturbed counterpart. No manual annotation required — we generate the defects ourselves, so the ground truth is free.

Seven defect classes cover seven dimensions: fabricated claims (accuracy), duplicated noise lines (noise), loaded severity labels (labelBias), scrambled event order (inferenceScaffolding), deleted death lines (sufficiency), inverted match outcome framing (outcomeAlignment — Win/Loss sources only), and triviality-dominated restructuring (focusCalibration).

## Step 1: Build the Suite

Requires a completed `/eval-baseline` run (with `prompts/`, `responses/`, and `index.json` intact):

```bash
npx tsx packages/eval/scripts/buildCalibration.ts --run <runId>   # Optional: --source-count 5 --seed 42
```

Outputs `runs/<runId>/judge-calibration/cases/case-NN/{prompt.txt,response.txt}` (up to 1 original + 7 perturbed cases per source) + `calibration-manifest.json`.

> Known upstream results (2026-07-04): the judge has reliable detection (100%) for accuracy/scaffolding/labelBias defects, but is unreliable for noise (67%) and removed-deaths sufficiency (33%) — in the real pipeline, these two dimensions are adjudicated by deterministic `qualityCheck` metrics. Their FAIL status here does not block A/B testing where the target dimension is a deterministic metric. Gladlog establishes its own baseline in its first calibration round.

> **Blind-Evaluation Ironclad Rule (Non-Negotiable):** Before all scores are written, neither you (the orchestrator) nor any scoring subagent may read `calibration-manifest.json` — it contains the planted defect for each case, and reading it invalidates calibration. Only checkCalibration reads it. Likewise, the orchestrator may only list directories under `cases/` to get CASEIDs, and must NOT read any case file contents (comparing near-duplicates allows inferring perturbations) or read `scores/*.json`; score completeness must only be verified by file existence.

## Step 2: Item-by-Item Blind Evaluation

Spawn a background subagent for each directory in `judge-calibration/cases/` (execution model identical to `eval-baseline.md` Step 2, no external APIs). Each subagent only receives this prompt (substituting CASEID):

> You are scoring a WoW arena coaching prompt/response pair. Read:
> `$GLADLOG_EVAL_HOME/runs/<runId>/judge-calibration/cases/CASEID/prompt.txt` and `.../CASEID/response.txt`.
> Apply the scoring rubric from `docs/commands/eval-baseline.md` Step 3 exactly — three-pass
> process (fact audit → anchored dimension assessment → JSON) and the 1/3/5 anchors. There is no
> quality-report.json for this item — skip the consistency rules that reference it.
>
> BLIND-EVALUATION RULE — NON-NEGOTIABLE: read ONLY the two files named above plus the rubric.
> Do NOT read, grep, list, or otherwise inspect `calibration-manifest.json`, any other case
> directory, any other score file, or any directory listing under `judge-calibration/`. Your
> judgment must rest solely on the prompt and response text in front of you — never on what
> another case was scored or on whether a defect "looks planted".
>
> For `matchId`: write `"unknown"`. Do not go looking for it.
>
> Write ONLY the score JSON (standard 7-dimension format with prompt and response blocks,
> factAudit included) to
> `$GLADLOG_EVAL_HOME/runs/<runId>/judge-calibration/scores/CASEID.json`.

> **Before rescoring a case, its old score file MUST be deleted.** Editing/writing tools commonly enforce "read before write if file already exists" —
> when redispatching to the same path, the new judge will be forced to read the **previous judge's score**. Verified in empirical testing on 2026-07-21: a redispatched judge
> read the old score and changed its `inferenceScaffolding` from 5 to 4, exactly matching the old score. It reported this honestly,
> but that dimension was no longer an independent judgment. **This is contamination caused by tool constraints, not judge misbehavior, and cannot be blocked merely by adding prohibitions** —
> the target file must first be `rm`'d, and the prompt must explicitly state: "This file does not exist; if reported existing, do not read it, overwrite directly."

> **These paragraphs were earned through empirical testing, do not delete them** (2026-07-21, 80-case calibration): The old template only said "do not read other files",
> resulting in **2/80 boundary violations** — one judge grepped `calibration-manifest.json` and read the planted defect description;
> another read sibling score files and cited "sibling case is a mirrored defect" to support its judgment. The root cause was that the template **did not tell
> the judge what to write when `matchId` could not be found**, so they browsed directories to fill the field and inadvertently saw what they shouldn't have.
> "Explicitly providing fallback values" is more effective than "prohibiting an action": eliminating the motivation rather than just announcing rules.
> Both cases were isolated and rescored. **Blind evaluation cannot be enforced at the harness level alone; it relies on templates + post-hoc self-reporting + isolated rescoring.**

Dispatch all in parallel at once. One case per agent — never put two cases in one agent (it will recognize near-duplicate prompts and infer perturbations).

## Step 3: Detection Rate Adjudication

```bash
npx tsx packages/eval/scripts/checkCalibration.ts --run <runId>   # PASS_THRESHOLD defaults to 0.8
# Adjustable env vars: MIN_PAIRS (default 4), DELTA_FLOOR (default 1), SPECIFICITY_TOL (default 1, suitable for integer rubrics — ±1 is quantization jitter rather than defect signal; can be lowered to 0 for continuous rubrics)
```

A perturbed case is **considered detected** only when passing both discriminant validity gates, not merely "score dropped":

1. **Sensitivity** — Target dimension drops by at least `DELTA_FLOOR` below the `none` control (above-threshold drop, filtering out judge noise / integer ties).
2. **Specificity** — Every other dimension remains unchanged within `SPECIFICITY_TOL`. Otherwise, a mindless harsh judge that "penalizes all dimensions whenever text changes" would pass cleanly despite having zero signal for specific defects.

**Exception: sufficiency is adjudicated by a deterministic coverage gate, not judge blind scores.** The judge can only see what is in the prompt,
not what the builder omitted — with removed-deaths stripping all death lines, the judge had 0 reaction on 8/10 pairs (5→5),
three rounds of rubric adjustments had zero effect, reproduced across five independent measurements (BACKLOG 14.2 final draft). checkCalibration runs
`checkFriendlyDeaths` directly on removed-deaths pairs (the same predicate as production `qualityCheck`,
anchored to the ground truth in `runs/<runId>/manifests/NNN.json`): original is clean and perturbed
reports missing → detected. **Therefore, the run directory must contain `manifests/`** (written by buildCorpus; for older runs that
were cleaned up, rebuild using the same log manifest and copy back aligned by matchId). Pairs where the source match had no friendly deaths are marked unscored (no jurisdiction),
neither counted as detected nor as missed. Blind scores from judges for sufficiency are written and displayed as usual — they simply carry no adjudicative weight.

Writes `judge-calibration/calibration-report.md` and prints per-dimension detection rates; exit code 1 (FAIL) if detection on any dimension is < 80%, or if scorable pairs < `MIN_PAIRS` (judged INSUFFICIENT).

## Interpretation

- **PASS** — Judge scores on these dimensions have valid signal; A/B Δ can be trusted (still subject to sample size constraints).
- **Dimension FAIL** — The judge cannot detect this defect class, or treats this defect by indiscriminately penalizing all dimensions rather than targeted recognition: A/B Δ for this dimension cannot be trusted. Modify rubric anchors (`eval-baseline.md`) **without rebuilding the suite** (controlled comparison with the same seed), then rescore (Step 2) and readjudicate (Step 3).
- **Dimension INSUFFICIENT** — Scorable pair count is below `MIN_PAIRS`, preventing a definitive conclusion: increase `--source-count` to rebuild the suite, or temporarily lower `MIN_PAIRS` (which weakens the statistical power of cross-dimension conjunction).
- Record each round's verdict in the Judge calibrations table in `$GLADLOG_EVAL_HOME/ledger.md`.

## Notes

- The suite is deterministic for a given `--seed` — rescoring before and after rubric changes is a controlled comparison.
- When real judge failures are discovered, add a new perturbation class to `buildCalibrationSuite.ts` (turning each judge bug into a planted defect).
- Calibration scores are calibration artifacts, not eval results — never mix them into the run's `scores/`.
