# Moment-Level Deep Dive (Deep Dive This Moment) Design

Date: 2026-08-05 · Status: Pending User Review
User Decision: Directly create the "Deep Dive This Moment" entry point; automatic deepen rounds and dense snapshots run in parallel, selected via a settings toggle.

## Background and Empirical Evidence

The existing deep dive (deepDive/windowAnalysis) is somewhat general: pack ≤14 items, only 8+6 categories of determined events,
**without** moment cooldown ledgers, DR levels, auras, coordinate distances, cast streams — yet these predicates are all readily available in the analysis package.

Controlled experiment (2026-08-05, match 6c663a46, death moment 2:13 ±10s, both sonnet):

|        | A: Existing Selection Pipeline                        | B: Dense Moment Snapshot                                                                            |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Output | 1 item 461 words, general ("no external given, call out earlier") | 4 items 1327 words                                                                                  |
| Depth  | —                                                     | Healer 14s zero healing casts; Rogue engages with CC when all defensives on CD; Full DR Gouge 1s broken by friendly damage; Rallying Cry available but unused |
| Verif  | Passed audit                                          | 3/4 fully supported by data rows; 1/4 core stands but contains timeline-error causal inference (post-death event claimed as cause of death) |

Conclusion: Data density determines depth; B's hallucination form (timeline/causality overstep) is exactly what the existing placeholders + audit discipline are meant to block
— so implementation must be done within the existing pipeline, without reinventing the wheel.

## Goals / Non-Goals

**Goals**

1. "Deep Dive This Moment" entry point: Select moment t in Replay/Timeline → t±10s window → Dense snapshot pack → Same pipeline deep dive.
2. Dense snapshot pack: Add snapshot-type PackItem, carrying cooldown ledger / DR / aura / distance LoS / pre-calculated stream signals.
3. Automatic deepen rounds can opt to use dense pack: settings toggle `deepDiveSnapshot` (default off, status quo unchanged);
   Manual "Deep Dive This Moment" always uses dense pack (this is its reason for existing, unaffected by toggle).

**Non-Goals**

- Mana/Resource fields (parser does not collect `advancedActorPowers`, always empty, dead end).
- Aura "remaining duration" (experiments proved inferredEnd semantics are unreliable when close is missing — almost all in the sample were 3s;
  phase 1 only lists active aura names, wait until remaining duration and other predicates are fixed).
- API conversational follow-ups (user explicitly wants an independent dense prompt, not resume conversation).

## Architecture: Fully reuse existing deepDive pipeline

`windowOverride` already supports arbitrary windows; the real increment is **adding new pack item kinds** + one entry point.

### 1. Snapshot item kinds (packages/analysis, new file `momentSnapshot.ts`, called by `buildDeepDivePack` according to flag)

| kind           | Granularity per item       | facts (all through fmtFactNum, moment floor to render grid first) | Source predicate (all existing exports, see predicate-index)                                                                              |
| -------------- | -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cd-ledger`    | Per unit                   | `t, unit, role, ready, onCd` (spell name list string)             | `extractMajorCooldowns` + `cdAvailableAt`                                                                                                 |
| `aura-snap`    | Per unit                   | `t, unit, role, auras` (name list, no remaining seconds)          | `buildAuraIntervals` (utils/auraIntervals.ts version! Be careful of collision with same-named function in utils/utils.ts) + new predicate `aurasActiveAt(unit, combat, t)` single source export |
| `pos-snap`     | owner↔per unit             | `t, unit, role, dist, los` (los=yes/blocked/unknown)              | `getUnitPositionAtTime` (INTERP_MAX_GAP_MS) / LoS uses `getUnitRawPositionAtTime` + `hasLineOfSight` (null→"unknown", never treat as false) |
| `dr-state`     | Every landed CC in window  | `t, caster, target, spell, drLevel, durationS`                    | `analyzeOutgoingCCChains` (friendly→enemy) + owner receiving side reuses `analyzePlayerCCAndTrinket` existing cc item                     |
| `healing-gap`  | Every friendly healer gap  | `unit, fromT, toT, gapS`                                          | Reuse #10's healingGap predicate (healerMetrics same source, no rewrite)                                                                  |
| `activity-gap` | Max no-cast gap per unit   | `unit, fromT, toT, gapS`                                          | New predicate `largestCastGap(unit, fromS, toS)` single source export (spellCastEvents adjacent gap take max); debate adopted item, covers non-healer gaps (DPS kited/peeled) |
| `hp-snap`      | Per unit                   | `t0, t1, hpStart, hpEnd, hpMin`                                   | `getHpPercentAtTime` / `getLowestHpPercentInWindow` (explicit HP_SAMPLE_RADIUS_MS)                                                        |

Raw cast stream: As **context paragraphs** of the prompt (one line per `M:SS Caster → Spell`, moment uses fmtTime),
Added HARD RULE: "Stream is only for understanding timeline; any numbers cited in the body must still use `{{pN.field}}` placeholders."
If the model wants to say "No healing for X seconds" → the number is carried by the `healing-gap` item. Zero relaxation of audit discipline.

### 1b. Debate Conclusion (agy Gemini 3.1 Pro, 2026-08-05, 1 round)

Opponent OPPOSE, three counter-examples handled one by one:

- **Adopt**: Enumerating kinds will silence insights about non-healer gaps ("DPS kited for 9s") → Added
  `activity-gap` (Max no-cast gap for everyone, see table above). Aggregate counting classes ("Wasted 3 GCDs") will not be done in phase 1,
  during acceptance test, count the silence rate of "model wants to say but no placeholder available", and add kind if data suggests so.
- **Reject** (opponent's counter-example is false): "Full DR Gouge 1s cannot be expressed" — `dr-state` facts already contain
  `durationS` (the 1.0s in the experiment comes exactly from `analyzeOutgoingCCChains`'s durationSeconds);
  "Broken by friendly damage" causal attribution is exactly what should be blocked by causalLint, not something to be let through.
- **Reject their alternative** (Dynamic reference/derivation check `{{timeline_delta|a|b}}`): That would be a second validation engine,
  which directly conflicts with the gatekeeping predicate discipline (one fact one predicate, deterministic text check), and "letting simple addition/subtraction derivations through"
  is itself a new hallucination attack surface. If the acceptance silence rate is high, prioritize adding deterministic kinds, do not open the dynamic derivation loophole.

### 2. Pack Limit

`PACK_MAX_ITEMS=14` remains unchanged (zero changes to the default path for automatic rounds). Snapshot mode uses an independent limit
`MOMENT_PACK_MAX = 32`, truncated by kind quota (cd-ledger/aura-snap/hp-snap/activity-gap
1 per unit, pos-snap ≤5, dr-state/healing-gap sorted by time distance to anchor to take the remainder),
discarded items due to exceeding the limit must be logged into the pack metadata.

### 3. main / IPC / Settings

- Reuse `analyzeWindow` channel: input adds `snapshot?: boolean`; cache key appends `:snap` segment;
  PROMPT_VERSION routine +1 (pack shape changed).
- Settings: `deepDiveSnapshot: boolean` (default false) → deepen automatic round's `buildDeepenPacks`
  selects pack construction according to the toggle; SettingsPanel AI section adds a toggle, with copy stating token cost is about 2-4x.
- max_tokens: Snapshot mode window call 2048 → 3072 (many facts, 3-6 findings).

### 4. UI Entry Point

- ReplayView control bar + "Deep Dive This Moment" button: Get current replay clock t (absolute ms → relative seconds boundary conversion only happens at
  MatchReport boundary, keep using established rules), window [t-10, t+10] clamp, go through
  `buildWindowAnalysisRequest` (snapshot: true) → results displayed reusing WindowAnalysisCard.
- TimeRangeBar's existing box selection entry point incidentally gains snapshot toggle capability (same request build function).

### 5. Audit and Gatekeeping Rules (Predicates are Specifications)

- Output side: `auditDeepDives` remains the same (placeholder key validation / claimChecker / raw numbers / repairSpellNameZh / causalLint).
- New predicate `aurasActiveAt` one export, prompt and any future gatekeeping rules share the same source; register in predicate-index.
- The same-named `buildAuraIntervals` in utils/utils.ts and utils/auraIntervals.ts is an existing predicate duplication,
  register it in the "not yet unified" section of predicate-index (this design only consumes the auraIntervals.ts version, won't merge in passing).
- eval adds class 6 hardFailure: Parse the snapshot facts of the deep dive prompt, recalculate same-second consistency
  (`hp-snap` must be consistent with existing `hp` item for the same render second and same unit; `cd-ledger` must not contradict
  `immunity/external-available`) — the existing five classes only scan the global timeline format,
  the deep dive prompt has been unguarded, plug this hole.

### 6. Acceptance (Before and After Numbers)

- Fixed anchor set: Take 20 death anchors from recent matches, run snapshot mode vs status quo once each (sonnet):
  Compare average findings count / audit pass rate / manual sample evaluation depth (experiment baseline: 1 generalized vs 4 specific).
- Silence rate (debate legacy criterion): Spot-check items discarded by audit, calculate the percentage of "model cited a number that actually exists in the stream
  but has no placeholder available"; if high, add deterministic kind (prioritize aggregate counting classes), do not open dynamic derivation.
- Determinism: Snapshot items generation coverage (all 20 anchors ≥ expected kind quota),
  eval class 6 hardFailure 0 triggers.
- Automatic round toggle: Run the same batch for on vs off, confirm off = byte-level status quo unch**First Round Testing (2026-08-05, N=10, local match library, claude-sonnet-5, script
`packages/eval/scripts/momentDiveAb.ts`) — Status: DONE_WITH_CONCERNS**

10 recent death anchors (±10s window), A=existing buildWindowPack, B=snapshot:true, both arms passed through
`auditDeepDives`:

| Anchor               | A (post-audit) | B (post-audit) | B Snapshot Item Count | B Class 6 Violation |
| -------------------- | -------------- | -------------- | --------------------- | ------------------- |
| 6c663a46/r0@134s     | 1              | 0              | 27                    | 0                   |
| 4555c043/r0@172s     | 0              | 1              | 28                    | 2                   |
| 46fa60f5/r0@27s      | 0 (No signal)  | 0 (No signal)  | 0                     | 0                   |
| 8531f0e7/r1@184s     | 0 (No signal)  | 0 (No signal)  | 0                     | 0                   |
| b309351e/r0@153s     | 1              | 1              | 24                    | 0                   |
| 8aa941f4/r0@168s     | 1              | 0              | 26                    | 1                   |
| 4159c044/r1@193s     | 0              | 0              | 28                    | 0                   |
| a95c27ac/r0@227s     | 0 (No signal)  | 0 (No signal)  | 0                     | 0                   |
| 8821f528/r2@152s     | 0              | 0              | 25                    | 0                   |
| 5b3157c2/r4@97s      | 1              | 1              | 26                    | 0                   |
| **Mean (N=10)**      | **0.40**       | **0.30**       | 18.40                 | Total 3             |
| Mean (7 signal anchors)| 0.57         | 0.43           | 26.29                 | 2/7 prompt hits     |

**Conclusion: In this round B ≤ A (0.30 ≤ 0.40), did not meet the "B is better" acceptance expectation of §6, stopped according to rules, do not write
"Met".** Three anchors returned null for `buildWindowPack` on both arms (the window inherently lacked teachable signals, unrelated to
A/B, dragged down the means for both but does not affect the relative comparison); two items discarded by audit in group B were manually checked:

1. One item had complete substantial content and cited real evidence, but the model wrote the legal pack key directly as raw text `p11`
   (instead of `{{p11.field}}`), and was rejected by the raw numbers discipline (`/\d/.test(prose)` in auditDeepDives)
   — a near-miss of discipline, not missing data in the snapshot evidence itself.
2. One item destroyed `JSON.parse` because of unescaped straight quotes (`"..."`) in the Chinese text, not even
   `parseModelJsonArray`'s fallback strategy could save it — this is a formatting robustness issue caused by snapshot mode's longer prompt/
   more verbose model, not an audit logic or evidence density issue.

Class 6 hardFailure (`checkSnapshotFactsConsistency`) had 2 hits across 7 successfully built B prompts, totaling 3 violations — **this is the first time this check has been electrified on real corpus and actually rang**, validating that
Task 3's implementation does not only work in unit test fixtures; the violations themselves (hp-snap inconsistent with hp at the same second / cd-ledger
contradicting external-available) are worth investigating as independent bugs, but are outside the scope of this task.

**Known Limitations**: Nearly half of the anchors in N=10 lacked comparable signals, true comparable sample is only 7; both silent attributions
point to fixable discipline/formatting details rather than architectural flaws, but the sample is too small to draw the conclusion that "B only needs to fix these two points to surpass A".
Recommendation: Retest with a larger sample (N≥20, as originally planned in §6), while checking if the class 6 violations are real
bugs (if so, the fix itself may improve B's audit pass rate).角引号(`"……"`)破坏 `JSON.parse`,连
   `parseModelJsonArray` 的兜底策略都未能挽回——这是 snapshot 模式 prompt 更长/
   模型更啰嗦带来的格式健壮性问题,不是审计逻辑或证据密度问题。

第 6 类 hardFailure(`checkSnapshotFactsConsistency`)在 7 个成功构建的 B prompt
中有 2 个命中共 3 处违规——**这是该检查第一次在真实语料上通电并真的响**,验证了
Task 3 的落地不是只在单测夹具里生效;违规内容(hp-snap 与 hp 同秒不一致 / cd-ledger
与 external-available 矛盾)本身值得作为独立 bug 排查,但不在本任务范围。

**已知局限**:N=10 里近一半锚点没有可比信号,真正可比样本只有 7 个;两条静音归因
都指向可修的纪律/格式细节而非架构性缺陷,但样本太小不足以下"B 只需修这两点就能反超"
的结论。建议:更大样本(N≥20,如§6 原定)复测,同时先看第 6 类违规是否为真实
bug(若是,修复本身可能改善 B 的审计通过率)。

**第二轮实测(2026-08-05,N=20,盲配对判优,门规误报修复(1ed42d7)+ prompt 格式
硬规则 v17(39bf02b)之后;此前一次 N=20 因 session 限额污染作废、数据不采)——
最终裁决:B 未跑赢,弃用**

| 判据                                      | A(现有管线) | B(密集快照)                          |
| ----------------------------------------- | ----------- | ------------------------------------ |
| 盲配对(双向消位置偏差,n=14 可比锚点)      | **7 胜**    | 5 胜,平 2 → B 胜率 35.7%             |
| 审计后条数/锚点(排除 1 个孤立 call-error) | **0.70**    | 0.58                                 |
| 存活率                                    | **70.0%**   | 57.9%                                |
| 平均 citedKeys(引证多样性)                | **5.25**    | 4.64                                 |
| 第 6 类违规                               | 0           | **0**(首轮 3 → 0,I-3/I-4 修复被验证) |

定性:B 被审计丢弃的 2 条内容质量其实很高(「Spirit Link 在手未按」「满 DR 下开控
不如救人」),但长 prompt 下格式失误率仍系统性偏高;且盲评显示 A 的短聚焦解说在
「每锚点一段解说」的产品形态里更常胜出——手工实验(自由文本、多条输出)里 B 的
优势在这个形态下施展不开,这是结构性结论,不是执行瑕疵。

**处置(用户判据「B 不赢就不用」,2026-08-05 执行)**:所有入口(含「深挖此刻」)
均跟随 `deepDiveSnapshot` 设置,默认关 = A 口径;不再有任何入口强制密集模式。
快照管线/门规/评测脚本全部保留(设置可开,供后续实验);若未来改变产品形态
(如深挖输出多条),可用 momentDiveAb 直接复测。

## 分期

1. **P1**:momentSnapshot.ts + kinds + prompt 段落 + 审计/eval 第 6 类 + `analyzeWindow` snapshot flag(TimeRangeBar 即可触发,验收跑数)。
2. **P2**:ReplayView「深挖此刻」按钮 + 设置开关接通自动轮 + SettingsPanel + 视觉基线。
