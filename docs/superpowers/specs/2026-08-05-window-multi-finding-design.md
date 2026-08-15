# Window Deep Dive Multi-Finding (Scheme 1) Design

Date: 2026-08-05 · Predecessor: `2026-08-05-moment-deep-dive-design.md` (Dense snapshot N=20 blind evaluation 35.7% failed to beat baseline and was deprecated; this design is the form correction pointed out by its post-mortem, user chose Scheme 1).

## Motivation (Data-driven)

Structural conclusions from the deprecated round: Under the "one explanatory paragraph per anchor" form of window deep dives, (a) "number of items after audit" is a binary survival indicator and cannot measure depth; (b) one format mistake = the entire anchor zeroes out, suppressing the survival rate of the long-prompt Arm B systemically (70% vs 57.9%); (c) in manual experiments, B's advantageous form was exactly "multiple independent issues".
Scheme 1 changes the output contract of window/moment deep dives to **1~4 independent findings**, each audited independently — a single item's death only costs one item.

## Contract Changes (window mode only; deepen automatic round contract remains unchanged)

- Model output: `[{ "findingIndex": 0, "title": string, "deepDive": string, "citedKeys": string[] }]`,
  1~4 items, multiple items allowed for the same findingIndex (window mode only; deepen mode remains max 1 per findingIndex, excess discarded and counted as dropped).
- title: ≤20 chars, no digits (bare digit audit also covers title; placeholders don't go into title).
- Prompt tail (window mode variant): Explicitly states "find 1 to 4 independent skill usage issues; if unsure, write fewer, 1 or even 0 is acceptable (output []); each item focuses on one unit / one decision". Anti-padding: Audit unchanged + wording doesn't reward item count.
- `auditDeepDives`: window mode audits each item independently (currently it is per item, just unblocking multiple items with the same index); each item gets its own interpolate + chips. `DeepDiveResult` adds optional `title?: string`.
- `PROMPT_VERSION` 17→18 (output contract changed, window cache invalidated; routine semantics).

## main / Cache / UI

- `analyzeWindow` result `status:"ok"` changed from `{text, chips}` to `{entries: Array<{title: string|null, text, chips}>}`; cache entry takes the same shape (schemaVersion naturally invalidates with PROMPT_VERSION 18, no migration needed).
- `WindowAnalysisCard`: Single paragraph → list rendering (title row + body + chips, reusing the existing finding card style); 0 items still uses the existing audit-empty text.
- preload types synced.

## Acceptance

- momentDiveAb adapted for entries[] (both arms use the new contract; judging is fed the "concatenation of all items for that anchor", blind pairing and anti-contamination mechanisms remain unchanged).
- Retest N=20: Primary criterion is still blind pair B (dense snapshot) win rate; secondary criteria are item count / survival rate / citedKeys.
  **Decision rule continues to use the user criterion: Only flip the deepDiveSnapshot default if B win rate > 50%, otherwise maintain the deprecated status quo** (Multi-itemization itself is a product improvement independent of A/B, and will be kept regardless of the result).
- Regression: deepen automatic round contract remains byte-level identical (pinned by existing tests); single-item window output (model only gives 1 item) renders with equivalent readability to the old version.

## Retest Results (2026-08-05, N=20 multi-itemization form, one quota limit interruption resumed losslessly via --skip=8)

| Criterion | A (Normal pack) | B (Dense snapshot) | Single-item form round (Control) |
| --- | --- | --- | --- |
| Blind pair (n=15 comparable) | 4 wins | **7 wins** (4 ties) → B win rate 46.7% | B 35.7% |
| Items per anchor post-audit | 0.75 | **0.80** | 0.70 vs 0.58 |
| Survival rate | 70.0% | **70.0%** (Tied) | 70.0% vs 57.9% |
| citedKeys mean | 3.50 | 3.14 | 5.25 vs 4.64 |
| Category 6 violation / call-error | 0 / 0 | 0 / 0 | — |

## Round 4: Cross-AI scale-up (2026-08-06, script v5 `--gen/--judge`)

**4a: N=50, sonnet generation, dual judges (sonnet + agy flash), 50/50 no interruptions**

| | claude judge | agy judge |
| --- | --- | --- |
| Head-to-head | A 11 / **B 20** / Tie 9 | **A 17** / B 15 / Tie 8 |
| B win rate (n=40 comparable) | 50.0% | 37.5% |

Judge agreement rate 67.5% (opposite directions only 2/40, disagreements concentrated on "tie vs win/loss" 11 cases) — judges are reliable on direction, but the claude judge is systematically more willing to give wins to B (homologous/style bias exists). Item count B 0.82 > A 0.78, survival rate 73.5% vs 71.4% tied. **Average of two judges for B ≈ 44%, still under half → the decision to keep the knob default off is maintained.**

**4b: N=20, agy pro generation (production backend), dual judges — headline is not A/B, but a survival rate collapse**

- **Root cause**: **All** failed on `unknown-finding-index` — agy interpreted "1-4 items" as numbering items with `findingIndex: 1, 2, 3...`, while the sole pack in window mode has index 0, causing the first audit gate to reject everything; previous naked-eye attributions (causalLint/backticks) were completely mistaken, and quantitative attribution saved the direction.
- **Fix** (72e33ec, v19): When there is only a single pack, `findingIndex` carries no information → audit remaps it to the unique pack (all other audit gates run unchanged, multi-pack remains strict); the window contract line hardcodes `"findingIndex": 0` as double insurance.
- **Before/After numbers** (same 20 anchors, agy pro generation): Survival rate **A 5% → 70%, B 0% → 70%**, audit drops 27 → 0. First readable A/B on agy: Claude judge B 46.7%, agy judge B 33.3% (A 7 / B 5 / Tie 3), citedKeys B 4.50 > A 3.93 (B citations more dispersed for the first time).
- **Overall ruling (all metrics across 4 rounds)**: B failed to exceed 50% under any generation backend × judge combination (35.7% / 46.7% / 50.0% / 37.5% / 46.7% / 33.3%) — the decision to keep the knob default off holds across all criteria. The true gains are two production fixes: multi-itemization contract + findingIndex compatibility (the latter restored deep dives on the agy backend from "essentially empty" to a survival rate equal to sonnet).

**Conclusion**: All design goals of multi-itemization were fulfilled — B's survival rate deficit (70 vs 58) eliminated, item count surpassed A for the first time, head-to-head led 7:4; but according to the pre-registered criterion (flip `deepDiveSnapshot` default only if B win rate > 50%), 46.7% did not cross the bar (many ties): **default remains off, no flip**. Multi-itemization itself is kept as an independent product improvement (both arms benefit equally). Note: under the "prefer writing fewer" phrasing, the model rarely outputs >1 item (only 3 instances of 2 items across 20 anchors), so the full potential of multi-item upper bounds remains unreleased, serving as the next experimentable variable.
