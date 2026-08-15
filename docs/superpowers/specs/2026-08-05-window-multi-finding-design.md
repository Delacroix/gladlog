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

  **全部**死于 `unknown-finding-index`——agy 把「1-4 条」理解成给条目编号
  findingIndex 1,2,3…,窗口模式唯一 pack 是 index 0,第一道门全灭;此前肉眼归因
  (causalLint/反引号)全错,量化归因救了方向。
- **修复**(72e33ec,v19):单 pack 时 findingIndex 无信息量 → 审计重映射到唯一
  pack(其余审计门原样全跑,多 pack 保持严格);window 契约行写死
  `"findingIndex": 0` 双保险。
- **前后数字**(同 20 锚点,agy pro 生成):存活率 **A 5%→70%、B 0%→70%**,
  审计丢弃 27→0。agy 上首份可读 A/B:claude 判官 B 46.7%、agy 判官 B 33.3%
  (A 7/B 5/平 3),citedKeys B 4.50>A 3.93(B 首次引证更散)。
- **总裁决(四轮全口径)**:B 在任何 生成后端×判官 组合下都未过 50%
  (35.7%/46.7%/50.0%/37.5%/46.7%/33.3%)——knob 默认关的决定在所有口径下成立。
  真正的收获是两个生产修复:多条化契约 + findingIndex 兼容(后者让 agy 后端的
  深挖从「基本全空」恢复到与 sonnet 同等存活率)。

**结论**:多条化设计目标全部兑现——B 的存活率劣势(70 vs 58)清零、条数首次反超、
头对头 7:4 领先;但按预注册判据(B 胜率 >50% 才翻转 `deepDiveSnapshot` 默认),
46.7% 未过线(平局多):**默认维持关,不翻转**。多条化本身作为独立产品改进保留
(两口径同受益)。附注:模型在「宁可少写」措辞下很少产出 >1 条(20 锚点仅 3 次
2 条),多条上限的潜力未完全释放,是下一个可实验变量。
