# Self-Learning Evolution: Cross-Match Pattern Accumulation (Design)

Date: 2026-07-26
Status: Aligned with user; see implementation plan at `docs/superpowers/plans/2026-07-26-self-learning-rules.md`

## Corrections (2026-07-26 Planning Phase, subject to implementation plan)

1. **The cross-match key is not findingKey**: findingKey = `category|sorted(eventIds)`, and eventIds
   are local IDs of candidate events per match, which never repeat across matches (the existing `aggregate()` also only uses
   category across matches; findingKey only serves single-match flags). The cross-match granularity is changed to **category
   (+ candidate event type, e.g., survival+death)**: during live analysis, main has candidates
   to parse the type; backfilled old matches have no candidates, degrading to pure category level.
2. **Ledger rows changed to "one row per run, embedding findings"**, re-analysis of the same match replaces the whole match by matchId
   using last-run-wins — last-write-wins per finding would leave old findings permanently residual
   if abandoned by a new round. The sort key uses meta's `startTime` (not endTime); removed
   ownerSpec (condition slicing does not use it, YAGNI).
3. **Enhanced consolidation failure semantics**: Deterministic parts (stats/retirement/resurrection) **always** persist; AI distillation
   failures only affect description/advice text. Rules missing text use deterministic fallback display in UI,
   and will be lazily backfilled in the next consolidation — stronger than "retain old rules.json entirely if audit is completely empty".
4. description/advice store **templates** (containing `{{hits}}`/`{{windowMatches}}` placeholders),
   interpolated from current stats by the shared `interpolate` function during rendering — stats updates do not invalidate text.

## Goals and Non-Goals

**Goal**: Evolve AI analysis from "one-time per-match feedback" to "cross-match learning" — concentrate historical findings into local storage, periodically consolidate them, and generate **fixed, verifiable patterns**, used for:

1. **Deterministic Rules**: Automatically highlight "habitual problems" during new match analysis without calling the AI.
2. **Long-Term Pattern Report**: A standalone page displaying the player's long-term bad habits and improvement curves.

**Non-Goals** (explicitly excluded, do not smuggle into implementation):

- Do NOT feedback into single-match analysis prompts (the user explicitly rejected "the more you use it, the better it knows you" injections).
- Do NOT rely on user markings (done/recurring remain independent features, not used as learning signals for this feature).
- Do NOT upload to the cloud. Storage is entirely local in the main process (`userData/learning/`).
- Do NOT use embedding/clustering for pattern mining (conflicts with the "predicates as specifications" philosophy, unverifiable).

**Learning Signal Source**: Exclusively AI historical findings themselves (cross-match pattern mining), requiring no user action.

## Confirmed Key Decisions

| Decision Point       | Conclusion                                                     |
| -------------------- | -------------------------------------------------------------- |
| Learning Signal      | AI historical findings (findingKey/category cross-match frequency) |
| Pattern Destination  | Deterministic rules + Long-term pattern report page (does not enter prompt) |
| Consolidation Mech   | Deterministic filter stable patterns → AI only translates/summarizes → Deterministic audit |
| Storage              | Local `userData/learning/`, managed by main process            |
| Consolidation Trigger| Ledger adds ≥10 matches automatically + Manual button on report page |
| Rule Lifecycle       | Deterministic retirement: recent window frequency drops below threshold → `improved`, not deleted, resurrectable |
| Description Language | Generated in current aiLanguage, lazy re-translation on language switch (only reruns distillation, stats untouched) |
| Condition Slicing Dims | Initial version only "enemy spec presence" and "map" dimensions |

## Architecture: Four-Layer Data Flow

```
Single match analysis done ──append──▶ ledger.ndjson (Learning Ledger)
                              │
                              ▼ (≥10 new matches or manual)
                     patternScan (Deterministic filter, pure function)
                              │ StablePattern[]
                              ▼
                     AI Distillation (main learning.ts, sonnet)
                              │ Rule[] draft
                              ▼
                     Deterministic Audit (Placeholder discipline, discard violations)
                              │
                              ▼
                        rules.json ──┬──▶ New matches: Rule engine runs on deterministic candidates, attaches "Habitual Problem" badges (no AI call)
                                     └──▶ Long-term pattern report page (trends/status/evidence chain)
```

## 1. Storage: `userData/learning/`

### `ledger.ndjson` (append-only ledger)

One finding instance per row:

```jsonc
{
  "v": 1,
  "matchId": "...",
  "findingKey": "...",
  "category": "...",
  "severity": 2,
  "meta": {
    "endTime": 1753500000000,
    "mapId": 1552,
    "win": false,
    "ownerSpec": 105,
    "enemySpecs": [62, 71, 264],
  },
  "promptVersion": 12,
  "createdAt": 1753500100000,
}
```

- **Only stores keys and structured metadata, no text**. findingKey (`packages/desktop/src/shared/findingKey.ts`, `category|sorted(eventIds)`) is language-agnostic, making the ledger naturally cross-lingual.
- Re-analyzing the same match → append new row; when reading, use **last-write-wins** by `(matchId, findingKey)`; skip bad rows (same fault-tolerance convention as `_index.ndjson`).
- **promptVersion is only recorded, not invalidated**. This is the core reason the ledger exists: `analysis-v2.*.json` caches are entirely invalidated upon promptVersion upgrades, so learning memory must be decoupled from cache invalidation.
- Write point: `packages/desktop/src/main/analysis.ts` appends after every successful analysis cache write (written in the initial run; deepDive only fills in text, producing no new ledger entries).

### `rules.json` (Consolidation Output)

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": 0,
  "ledgerCursor": "...",
  "rules": [
    {
      "ruleId": "...",
      "status": "active", // "active" | "improved"
      "category": "...",
      "findingKeys": ["..."],
      "condition": { "enemySpecs": [62], "mapIds": [] }, // nullable = unconditional
      "stats": {
        "windowMatches": 20,
        "hits": 9,
        "firstSeen": 0,
        "lastSeen": 0,
        "trend": [2, 3, 1, 2, 1],
      }, // bucketed per 5 matches
      "description": { "zh": "…{{hits}}…", "en": null }, // lazy re-translation: null for ungenerated languages
      "advice": { "zh": "…", "en": null },
      "evidence": ["matchId1", "matchId2"],
      "distilledAt": 0,
      "distillModel": "claude-sonnet-5",
    },
  ],
}
```

### Backfilling

Upon first enablement, scans all existing `matches/*/analysis-v2.*.json` (≈794 matches) to write the ledger, reusing `notebook()`'s scanning logic, one-time, with progress events, writing a `backfill-done` marker upon completion. **Unlike `notebook()`: old matches with mismatched promptVersion are also collected** (just record their promptVersion). Everything is incremental thereafter.

## 2. Deterministic Filter: `packages/analysis/src/learning/patternScan.ts`

Pure function: `LedgerEntry[] → StablePattern[]`. All thresholds exported as constants, **filtering, retiring, badge rendering, and any future verification gates share the exact same predicates** (predicates as specifications):

```ts
export const PATTERN_WINDOW_MATCHES = 20; // Stats window: recent N matches
export const PATTERN_MIN_HITS = 5; // Minimum hits within the window
export const RULE_RETIRE_MAX_HITS = 2; // Recent window hits ≤ this value → improved
```

- Grouping: Primary = normalized category (`normalizeFindingCategory`); Granular = findingKey.
- **Stability determination**: Hits ≥ `PATTERN_MIN_HITS` within the recent `PATTERN_WINDOW_MATCHES` match window, **and the hit distribution spans both the front and back halves of the window** (excluding a single loss-streak spike).
- **Condition Slicing** (Initial version two dimensions: enemy spec presence, map): Produces conditional patterns when the subset hit rate is significantly higher than the overall set. "Significantly" uses deterministic thresholds (subset hit rate ≥ 2× overall hit rate AND subset sample ≥ 4 matches), without statistical tests.
- Outputs `StablePattern`: groupKey, hits, window, trend buckets, representative instances (2-3 entries, including matchId to fetch the then-explanation text during distillation), condition slices.

## 3. AI Distillation + Deterministic Audit (new `learning.ts` service in main)

- Input: `StablePattern[]` + the original explanation text of 2-3 representative instances per pattern (read from the corresponding match's analysis cache; matches where the cache is already invalidated by promptVersion degrade to only providing structured fields).
- Model: Default sonnet (consistent with the coach product line), routing through the existing `resolveAiClient`/`resolveAiModel` three-backend system.
- Requires Rule JSON array output: translates statistical patterns into human-readable descriptions, summarizes applicable conditions, and provides a coaching suggestion. Parsing uses the existing `parseModelJsonArray` (tolerates markdown fences).
- **Audit (copying existing disciplines, offending items entirely discarded)**:
  1. No raw numbers in descriptions/advice, only `{{key}}` placeholders, interpolated from stats by code (reusing the placeholder mechanism pattern of `auditFindings`).
  2. Rules can only reference the fed patternId; findingKeys ⊆ the pattern's key set.
  3. The condition field values must be ⊆ the spec/map enums that actually appeared in the pattern.
  4. Adhering to the causalLint spirit: bans evidence-free causal assertions.
- Failure handling: bad-json retries once (same strategy as `analysis.ts`); if rule count is 0 after audit → keep the old rules.json without overwriting, and display the consolidation failure reason on the report page.

## 4. 规则应用 + UI

### 新对局自动标记(不调 AI)

- renderer 在 `extractCandidateFindings` 产出候选后,经 IPC 取 rules.json,用 `packages/analysis` export 的**同一匹配谓词**在候选上跑规则引擎。
- 命中 → 战报该 finding/候选上挂徽章:"惯性问题 · 近 {{windowMatches}} 场第 {{hits+1}} 次"(数字从 stats 插值,不由任何模型生成)。
- 徽章可点 → 跳长期规律报告页对应规则。

### 长期规律报告页

挂在 StatsDashboard 旁(复用其页面骨架):

- 规则列表:active/improved 徽章、描述、建议、条件。
- 每规则频次趋势迷你曲线(stats.trend,按 5 场分桶)。
- 证据 matchId 可点跳对应战报。
- 手动"重新整合"按钮 + 上次整合时间/台账覆盖场数。
- 回填未完成时显示进度。

### IPC 面(新增,沿现有命名)

`gladlog:learning:getRules` / `consolidate` / `getState`(含回填进度)/ 事件 `gladlog:learning:progress|done|error`。

## 5. 触发与生命周期

- **整合触发**:analysis done 时检查台账自上次整合新增 ≥10 场 → 自动跑;报告页手动按钮随时可跑。并发守卫(同 `deepening` Set 模式)。
- **退役**:每次整合重算所有既有规则 stats;近窗命中 ≤ `RULE_RETIRE_MAX_HITS` → status `improved`(不删除,报告页作为进步证据);频次回升 ≥ `PATTERN_MIN_HITS` → 自动复活为 active。退役/复活纯确定性,不经过 AI。
- **规则同一性**:ruleId 由 category+findingKeys+condition 派生(稳定哈希),整合幂等——同样的台账跑两次得到同样的规则集,AI 只影响描述文本。

## 6. 错误处理与边界

- 台账坏行:跳过,计数上报(不静默)。
- 同场重分析:后写胜出,旧行留在文件里,达到阈值(如 >20% 冗余)时后台压缩重写(tmp+rename 原子,与 analysis 缓存同法)。
- 语言切换:description/advice 缺当前语言 → 报告页触发懒重译(只重跑提炼步,统计与规则集不动)。
- 库很小(<PATTERN_WINDOW_MATCHES 场):窗口取实际场数,报告页明示"样本不足,规律仅供参考";< 5 场不产规则。

## 7. 测试与验收

- 单测(fixture 法,desktop-dev 约定):
  - patternScan:阈值边界、前后两半分布判定、条件切片显著性。
  - 审计:伪造数字/越界 patternId/越界 condition 的规则被丢弃。
  - 退役/复活谓词;ruleId 稳定哈希幂等。
  - 台账:后写胜出、坏行容错、压缩前后等价。
- **验收给前后数字**(verification rule):在真实 794 场库上回填 + 整合,报告"筛出 N 个稳定模式 / 提炼出 M 条规则 / 审计丢弃 K 条",抽查 3 条规则把描述里每个插值数字逐一对回台账重算核实。
- 谓词单源检查:徽章渲染、报告页、patternScan 引用同一组常量——做不到共享 import 的位置写断言相等的单测。

## 8. 实现范围切分(供写实现计划参考)

1. 台账层:ledger 读写 + analysis.ts 写入点 + 回填。
2. patternScan 纯函数 + 单测。
3. learning.ts 服务:提炼 prompt + 审计 + rules.json + IPC。
4. 规则引擎应用 + 战报徽章。
5. 长期规律报告页。

各步可独立验证;1+2 完成后即可在真实库上先看"筛出什么模式"再调阈值,不必等全链路。
