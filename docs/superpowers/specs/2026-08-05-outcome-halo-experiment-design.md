# Judge Outcome Halo Experiment (Subproject B) Design

Date: 2026-08-05. Batch: Evaluation Engineering Improvements (Derived from the gap list after reconciling with the Gemini deep research report "Systematic Construction of Industrial Large Language Model Evaluation Engineering and Game Log Tactical Coaching").

## Batch Overview and Sequencing

Four subprojects, sequenced **B → A → C → D**, each with independent spec/plan/implementation loops:

| Subproject | Content | Status |
| --- | --- | --- |
| B | Judge Outcome Halo Experiment (This spec). **Executed on 2026-08-05: 95% CI of halo-aligned delta for all six non-outcome dimensions contains zero, contamination is unsupported (accuracy +0.11 [−0.07, 0.30], measured resolution ≈0.19 points). Report: `$GLADLOG_EVAL_HOME/ab/2026-08-05-outcome-halo/report.md`** | Executed, No Contamination |
| A | Judge Noise Floor: Plan A3 confirmed — accuracy split into line-by-line claim ternary arbitration (correct/neutral/error, errorCount deterministically aggregated into existing lookup table) + remaining subjective dimensions use 3-judge independent medians per dimension. **B numbers are in: Judge maintains single pass, no split into two-pass structure; A's efficacy calculation uses B's measured accuracy paired difference SD 0.94 (replacing archive value 1.3)** | Pending Independent Spec |
| C | Product-Side Hindsight Bias Predicate: Events cited by finding advice must precede anchor T (except declared deathT), prose rule ("Do NOT assert causation" in `buildFindingsPrompt.ts`) upgraded to gate predicate, entering predicate index | Pending Independent Spec |
| D | Intrafamilial Bias Quantification (DeepSeek dual-judge directed mean error) + Ask Coach Sycophancy Evaluation | Pending Independent Spec |

Reason for sequencing: B has zero product code changes and produces numbers in one session round; its conclusions directly determine A's judge prompt structure — test first, build later, avoiding rework after A is built.

Reconciled, explicitly **not doing**: DSPy full prompt compilation (prompts are deterministic facts rendered by TS builder, not free text; blocked by A's noise floor), in-product multi-agent debate (burns user CLI quota per match).

## B: Goals and Hypotheses

Judges always know the outcome when scoring: the first line of `prompt.txt` is `Result:` (rendered by `packages/analysis/src/context/buildMatchContext.ts:802`), unavoidable even in blind evaluations. The `outcomeAlignment` dimension requires the match outcome by design; the question is whether the **other six dimensions** (sufficiency/noise/labelBias/inferenceScaffolding/accuracy/focusCalibration) are systematically skewed by a "Win → Lenient / Loss → Strict" halo. The current defense is only a prose rule in the rubric (`docs/commands/eval-baseline.md:142`).

- Hypothesis H1: There is at least one non-outcome dimension whose halo-aligned delta (defined in "Blind Protocol and Statistics") has a 95% CI that does not contain zero.
- Null Hypothesis H0: The halo-aligned delta for all six dimensions ≈ 0.

Purely a judge-side experiment, zero changes to product code.

## Materials and Grouping

- Corpus: `runs/2026-07-30-wire-unnecessary-baseline` (buildCorpus product of the same 300-match corpus, containing index.json with result metadata; `prompts-3v3-1800-2026-07-31/` is a flat, indexless version of the same batch, not programmatically consumable). Fixed-seed sampling of **n=100** items, stratified as 50 Win / 50 Loss with a fixed seed (seed written into run product, reproducible). Do not mix in the 10 old pairs from `runs/2026-07-23-causal/` (pipeline versions differ, only inflates variance).
- Responses: Generate one response per prompt, sonnet responder, one item per agent (repo convention: eval batch sub-agents are strictly sonnet). The response is only generated once and shared by both arms — the subject of the experiment is the judge, not the responder.
- Grouping: Each response gets paired with two judge items. **Arm O** = (Original prompt, Response); **Arm R** = (Redacted prompt, Same response). The only variable is the outcome label visible to the judge.

## Redaction Definition (Minimal Intervention)

Only redact **explicit outcome labels**, without touching factual materials:

1. Header line `Result: Win/Loss` → `Result: Unknown`;
2. The macroOutcome conclusion line in the `finalAssessment` section neutralized similarly.

Death roster, timeline, cooldown ledger are all retained — they are legal materials for coach discussions; erasing them is a different experiment (Full Fog), outside the scope of this spec.

Redaction is implemented as a deterministic text transformation in `packages/eval` (exported function + unit tests asserting that target lines are rewritten, remaining bytes are untouched). **Do not write disposable scripts** (verification rule: solidify criteria, scripts vanish with the session).

Zero changes to judge instructions, completely blind to the experiment's purpose: The rubric already defines that when `Result=Unknown`, outcomeAlignment is scored based on "whether the key turning points were captured" (`eval-baseline.md:196-198`).

## Blind Protocol and Statistics

- Reuse eval-ab infrastructure: `blindAbPool` (seedless Fisher–Yates mix pool, `packages/eval/src/ab/blindAbPool.ts`) mixes and renames 200 judge items; one item per judge, never two items in one agent; the orchestrator does not read `mapping.json`, item contents, or scores (`docs/commands/eval-ab.md` anti-deblinding rules copied verbatim).
- Judge: Claude sub-agents within the session, both arms use the same model, `judgeModel` recorded truthfully.
- Primary metric: **Halo-aligned delta**. Calculated per-item as Δ = score(Arm R) − score(Arm O), for Win matches take −Δ before merging — the expected direction of the halo is opposite in Win/Loss matches (Win → label brings leniency, removing it should lower the score; Loss → label brings strictness, removing it should raise the score), so direct merging would cancel them out. After alignment, merge n=100, paired bootstrap (seed 1337, 10000 iterations), outputting mean + 95% CI per dimension; the Win/Loss stratified table is reported alongside for transparency.
- Efficacy accounting: The noisiest dimension accuracy SD≈1.3, independent judges for both arms ⇒ paired difference SD≈1.8, with n=100, SE≈0.18, can stably detect an alignment effect |Δ|≳0.35, reaching the repo's known noise floor resolution of 0.4; other dimensions have smaller SDs and finer resolution. One round yields a definitive conclusion, no follow-up rounds.

## Interpretation Rules

- **Any** of the six non-outcome dimensions has a CI not containing zero ⇒ Contamination established ⇒ A's judge adopts a two-pass structure: "Outcome-blind 6-dim + Outcome-aware 1-dim".
- All contain zero ⇒ Maintain single pass, A only does A3's structuring + K multi-judge.
- Movement in `outcomeAlignment` is the expected behavior of a rubric switch (Outcome present → Unknown), reported separately, does not count as a contamination signal.
- Decisions are strictly based on the merged CI of the halo-aligned delta; the Win/Loss stratified appendix table is only used to verify if the two layers' directions are opposite as expected, not for standalone decisions (n≈50 per layer, insufficient resolution).
- Limitations statement: Factual materials like the death roster still allow the judge to **infer** the outcome; this experiment measures the "marginal effect of explicit labels". All containing zero does not mean the judge is completely blind to the outcome, it only shows that the intervention of redacting labels is not worth doing — the necessity of a two-pass structure is judged based on this, because redacting labels is exactly the only implementable intervention in A.

## Deliverables and Acceptance

1. `ab/2026-08-05-outcome-halo/` full products (sampling seed, responses, blind pool, scores, mapping; A/B directory layout reuses the blindPool contract);
2. Report: Per-dimension halo-aligned delta + CI main table, Win/Loss stratified appendix table, a one-sentence citable conclusion;
3. `ledger.md` accounting;
4. Conclusion written into A's spec (decision basis for two-pass or not);
5. Redaction transformation unit tests put into the `packages/eval` test suite, permanently in CI.

Acceptance is the numbers in the report itself (this experiment is a measurement); redaction transformation is accepted via unit tests.
