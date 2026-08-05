# 谓词索引

[English](predicate-index.md) · **中文**

写常量、阈值、容差、采样调用、格式化函数之前,先来这里查一句:这个事实是不是已经有谓词了?

## 这份索引解决什么问题

`CLAUDE.md` 开篇第一条硬规矩是**门规谓词即规范(shared-predicate rule)**:分析代码(`packages/analysis`)与验证门(`packages/eval`)判定**同一个事实**必须用**同一个谓词**——同一常量、同一采样函数、同一容差,并且**锚定在渲染值上**,因为门规是重新解析渲染后的 prompt 文本。规矩里也写了做法:谓词放一处 export、两边 import;做不到时写断言相等的单测,别靠注释。

违反的历史代价:2026-07 全量审计中,**5 个独立 bug 全是这一类**——HP 采样半径不一致、有界 vs 无界回溯、LoS 用插值 vs raw vs 非同时刻采样、小数秒 vs 渲染秒扫描网格。

缺的从来不是规矩。2026-08-01 这一轮里,同一个人读过这条规矩,照样在一天的工作里手抄了两次谓词:「已知场次」判据被抄进了编排壳,`dateKey` 格式化在另一个文件里又写了一遍。**缺的是索引**——一个能在动手写新代码之前看到「这个事实已经有主了」的地方。

## 怎么用

**写新代码之前。**按**事实**去表里搜,用大白话搜,别去猜符号名。事实在表里,就 import 那个谓词:不要重新推导、不要抄字面量、不要「就这一次」把已经存在的正则内联一遍。

**新增「分析断言 X、门规验证 X」的配对时:**

1. 谓词从一个模块 export,两边 import。
2. 在下面的索引表里加一行——**两个语言版本都要加**。
3. 同一行加进 `packages/eval/test/predicateIndex.test.ts`。该测试会解析这个页面,所以页面与测试不可能各自腐烂。
4. 如果共享 export 确实做不到(对面是 markdown 规格、是渲染出的字符串、或者是另一种语言),就在同一个测试里加断言相等的用例。这是 `CLAUDE.md` 明写的备选办法,一句注释顶替不了它。下面的 `FACT_AUDIT_MIN` / `FACT_AUDIT_MAX` 就是这条路的范例。

**改名或删除谓词时。**该测试按文件路径 import 了这里列出的每一个符号,改名会直接把 CI 打红。请更新本页(两个语言版本),而不是把行删掉。

## 表怎么读

- **事实**——判定的是什么,用大白话写。要搜的就是这一列。
- **权威谓词**——`文件` → `export`。一个事实只有一个。
- **消费方**——有代表性的调用点,不求穷尽。「门规」指 `packages/eval`。
- **备注**——容易搞错的语义。

路径都相对仓库根。`packages/analysis/src` 下的东西都能按文件路径 import;大部分也从包根(`@gladlog/analysis`)再导出,但 `factFormat.ts`、`spellCategories.ts` 的 `isCastBlockingAuraType` 等少数几个只能按文件路径拿。

## 索引表

<!-- predicate-index:begin -->

### 时间与渲染网格

| 事实                           | 权威谓词                                                             | 消费方                                                                                                                               | 备注                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 时刻渲染进 prompt 文本(`M:SS`) | `packages/analysis/src/utils/cooldowns.ts` → `fmtTime`               | `analysis/src/context/` 下所有渲染器;desktop `WindowAnalysisCard.tsx`                                                                | 向下取整到整秒。门规复算时重新解析的正是这个格式,所以它定义了其余一切必须对齐的网格。                         |
| 把时刻归到 prompt 的渲染网格   | `packages/analysis/src/utils/cooldowns.ts` → `toRenderSecond`        | `matchTimeline.ts`、`criticalMoments.ts`、`buildMatchContext.ts`、`matchTimelineSections.ts`、`candidateFindings.ts`、`dampening.ts` | 凡是结果会被门规从渲染文本复算的查询,**先归网格再查**。按小数秒采样却渲染成整秒,就是 2026-07 的同秒 HP 矛盾。 |
| 渲染出来的窗口有多长           | `packages/analysis/src/utils/cooldowns.ts` → `renderedWindowSeconds` | `buildMatchContext.ts`、`offensiveWindows.ts`、`healerOffenseAnalysis.ts`                                                            | 取两个**渲染秒**之差,绝不取原始值之差。`checkWindowSpanConsistency` 正是它的逆运算。                          |

### HP 采样

| 事实                           | 权威谓词                                                            | 消费方                                                                                                                                                       | 备注                                                                                  |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 取 HP 读数时允许离目标时刻多远 | `packages/analysis/src/utils/cooldowns.ts` → `HP_SAMPLE_RADIUS_MS`  | `matchTimeline.ts`、`matchTimelineSections.ts`、`candidateFindings.ts`、`killWindowTargetSelection.ts`、`enemyCDs.ts`、`counterfactual.ts`、`burstLedger.ts` | 全程 3000 ms。曾为「提升新鲜度」收窄过又撤回:半径只控制接受/拒绝,不改变取到的样本值。 |
| 某单位在某时刻的 HP%           | `packages/analysis/src/utils/cooldowns.ts` → `getUnitHpAtTimestamp` | 同上各调用点                                                                                                                                                 | 一律显式传 `HP_SAMPLE_RADIUS_MS`——默认参数松得多。                                    |

### 冷却可用性

| 事实                                            | 权威谓词                                                                           | 消费方                                                                                                                                   | 备注                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 某时刻这个冷却可用吗(读已解析的施法台账)        | `packages/analysis/src/utils/cooldowns.ts` → `cdAvailableAt`                       | `matchNarrative.ts`、`candidateFindings.ts`、`timelineHelpers.ts`、`matchTimelineSections.ts`、`criticalMoments.ts`、`counterfactual.ts` | 别在调用点手算 `lastCast + cooldown <= t`。`packages/analysis/test/cdAvailablePredicateConvergence.test.ts` 是防漂移哨兵。       |
| 某时刻这个冷却可用吗(死亡结局口径)              | `packages/analysis/src/utils/deathOutcomeAnalysis.ts` → `isAvailableAt`            | `deathOutcomeAnalysis.ts`、`positionAnalysis.ts`                                                                                         | 与 `cdAvailableAt` 语义重叠且必须同判——由 `packages/analysis/test/cooldownAvailabilityKernel.test.ts` 钉住。                     |
| owner 整场/整轮的最低 HP%                       | `packages/analysis/src/utils/killWindowTargetSelection.ts` → `matchMinHpPct`       | `candidateFindings.ts`(cd-waste 承压门)、`buildMatchContext.ts`(低承压守护注)                                                            | 委托 `getLowestHpPercentInWindow` 扫 advanced 样本;无 advanced → `null`——此时门倾向照发、守护注倾向沉默。                        |
| 这局到底有没有把 owner 打出承压(未用减伤教学门) | `packages/analysis/src/analysis/candidateFindings.ts` → `CD_WASTE_PRESSURE_HP_PCT` | `cdWasteEvents`(菜单门);`matchTimelineSections.ts` → `lowPressureUnusedDefensiveNote`(prompt 守护注)                                     | 门槛处精确互补:≥ 门槛压掉 cd-waste、出守护注;< 门槛照发 cd-waste、不出注。由 `packages/analysis/test/cdWasteGate.test.ts` 钉住。 |

### 位置与几何

| 事实                                  | 权威谓词                                                                           | 消费方                                                                                                                          | 备注                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LoS 扫描在锚点前后各扫多少秒          | `packages/analysis/src/utils/positionSampling.ts` → `LOS_SWEEP_SLACK_S`            | `healerExposureAnalysis.ts`;门规 `positioningScan.ts`(别名 `TIME_SLACK_SECONDS`)                                                | 分析与门规必须完全相同,否则门规复算不出分析的结论。`CLAUDE.md` 点名的共享点。                                                                                                     |
| LoS 扫描插值位置时允许的最大采样间隔  | `packages/analysis/src/utils/positionSampling.ts` → `LOS_SWEEP_GAP_MS`             | `healerExposureAnalysis.ts`;门规 `positioningScan.ts`(别名 `POSITION_MAX_GAP_MS`)                                               | 要求同上。                                                                                                                                                                        |
| 单点插值超过多大间隔就算编的          | `packages/analysis/src/utils/positionSampling.ts` → `INTERP_MAX_GAP_MS`            | `positionAnalysis.ts`、`healerExposureAnalysis.ts`、`ccTrinketAnalysis.ts`                                                      | **刻意不等于** `LOS_SWEEP_GAP_MS`(1500 vs 3000)。两者都曾叫 `POSITION_MAX_GAP_MS`,正是这么看串的。                                                                                |
| 门规复算一个区间时该查哪些时刻        | `packages/analysis/src/utils/positionSampling.ts` → `positionSampleInstants`       | 门规 `positioningScan.ts`(`windowDistanceSpan`、`minDistanceInWindow`)                                                          | 锚点时刻 ∪ 两单位的真实 advanced 采样时刻 ∪ 亚秒网格。门规里两处复算曾各抄一份。只定义时刻集合 —— gap 容差仍由调用方按用途传,因为两个 gap 常量刻意不等。                          |
| 玩家 CC 技能的最大施法射程            | `packages/analysis/src/utils/positionSampling.ts` → `CC_MAX_CAST_RANGE_YARDS`      | `healerExposureAnalysis.ts`                                                                                                     | 前瞻判定:站在这之外的敌人无论有没有视线都落不到 CC。与下一行**不是**同一个事实 —— 141237 条已渲染的 CC 距离主张里有 90 条落在 (40, 45]。                                          |
| 已落地的 CC,复算距离的可信上限        | `packages/analysis/src/utils/positionSampling.ts` → `CC_MAX_PLAUSIBLE_RANGE_YARDS` | `ccTrinketAnalysis.ts`(超过即抑制该距离);门规 `positioningScan.ts` 的 G6(别名 `MAX_CC_CLAIM_YARDS`)                             | = 施法射程 **+** 观测宽容量(插值误差、飞行物旅行时间、施法瞬间双方仍在移动),派生而来,永远不可能低于射程。门规验的是产出侧自己的契约;它曾私有写更松的 50 码,导致 G6 根本触发不了。 |
| 「治疗被贴脸」的定义距离              | `packages/analysis/src/utils/positionSampling.ts` → `HEALER_TRAINED_YARDS`         | `positionAnalysis.ts`(产出并渲染主张);门规 `positioningScan.ts` 的 G2(别名 `TRAINED_MAX_YARDS`)                                 | 定义本身 —— 门规必须验产出侧用的那个定义。                                                                                                                                        |
| 驱散/进攻驱散的最大施法射程           | `packages/analysis/src/utils/positionSampling.ts` → `DISPEL_MAX_RANGE_YARDS`       | `dispelAnalysis.ts`(漏解/漏 purge 可行性门 a)                                                                                   | 今天与 CC 射程同为 40,但是**另一个事实**(驱散系 30-40 码,取上界宽容判定)。喂 2026-08-02「够不着的驱散不怪」门。                                                                   |
| 踢技 → 学派锁定秒数                   | `packages/analysis/src/data/spellCategories.ts` → `kickLockoutSeconds`             | `ccTrinketAnalysis.ts`(interruptInstances);`dispelAnalysis.ts`(无法施法门 b+c)                                                  | SPELL_INTERRUPT 没有光环事件,锁定时长只能查表,查不到保守按 3s。两处消费方此前各自内联。                                                                                           |
| 漏解窗结束后多久内的续控算「链」      | `packages/analysis/src/utils/dispelAnalysis.ts` → `DR_CHAIN_LOOKAHEAD_S`           | `dispelAnalysis.ts`(drChainRisk 注解)                                                                                           | 价值门 d:DR 全新鲜 **且** 此窗口内观测到同类续控,责难降级为谨慎注解(此处驱散大概率换来满时长续控)。                                                                               |
| 某单位在某时刻的插值位置              | `packages/analysis/src/utils/losAnalysis.ts` → `getUnitPositionAtTime`             | `positionAnalysis.ts`、`healerExposureAnalysis.ts`、`ccTrinketAnalysis.ts`、`deathOutcomeAnalysis.ts`;门规 `positioningScan.ts` | 容差显式传参;传哪个 gap 常量取决于这条主张会不会被门规复算。                                                                                                                      |
| 某单位在某时刻的原始(不插值)位置      | `packages/analysis/src/utils/losAnalysis.ts` → `getUnitRawPositionAtTime`          | `healerExposureAnalysis.ts`                                                                                                     | 同一条主张一处用 raw 一处用插值,正是 2026-07 五个 bug 里的一个。                                                                                                                  |
| 两点距离(码)                          | `packages/analysis/src/utils/losAnalysis.ts` → `distanceBetween`                   | `positionAnalysis.ts`、`healerExposureAnalysis.ts`、`ccTrinketAnalysis.ts`、`deathOutcomeAnalysis.ts`;门规 `positioningScan.ts` |                                                                                                                                                                                   |
| 两点之间有没有视线                    | `packages/analysis/src/utils/losAnalysis.ts` → `hasLineOfSight`                    | `healerExposureAnalysis.ts`、`ccTrinketAnalysis.ts`、`deathOutcomeAnalysis.ts`;门规 `positioningScan.ts`                        | 返回 `false` / `true` / `null`(地图未知)。`null` 要当「不能下结论」,绝不能当 `false`。                                                                                            |
| 竞技场障碍物几何                      | `packages/analysis/src/data/arenaGeometry.ts` → `arenaObstacles`                   | `losAnalysis.ts`;desktop `ReplayView.tsx`、`arenaMaps.ts`;门规 `positioningScan.ts`                                             | 回放图层与 LoS 谓词必须读同一份障碍物,否则 UI 与门规互相打脸。                                                                                                                    |
| 哪些走位事件类型算失误                | `packages/analysis/src/utils/positionAnalysis.ts` → `POSITION_MISTAKES`            | `deepDive.ts`;desktop `keyMoments.ts`                                                                                           |                                                                                                                                                                                   |
| 一次 `STAYED_IN` 是否真的付了 HP 代价 | `packages/analysis/src/utils/positionAnalysis.ts` → `stayedInHadRealCost`          | `positionAnalysis.ts`、`deepDive.ts`;desktop `keyMoments.ts`                                                                    | 三个阈值就在同文件它旁边;消费这个函数,别消费那几个数。                                                                                                                            |

### 次序统计量

| 事实                      | 权威谓词                                                  | 消费方                                                                             | 备注                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 排好序、剔除 NaN 的样本池 | `packages/analysis/src/utils/stats.ts` → `toSortedFinite` | `benchmark/metrics.ts`(`toPercentiles`);门规 `ab/abCompareStats.ts`(`bootstrapCI`) | 池子里混进 NaN 时,裸 `sort((a, b) => a - b)` 会静默留下乱序数组——50 场里 11 场的 `p50 214k \| p90 65k` 就是这么来的。对应的门是 `checkPercentileMonotonicity`。 |
| 可能含 NaN 的池子的中位数 | `packages/analysis/src/utils/stats.ts` → `medianFinite`   | `healerMetrics.ts`                                                                 |                                                                                                                                                                 |

### 阈值

| 事实                                   | 权威谓词                                                                    | 消费方                                                                                                                                         | 备注                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 一个窗口内多大伤害算尖峰               | `packages/analysis/src/context/timelineHelpers.ts` → `DMG_SPIKE_THRESHOLD`  | `matchTimeline.ts`、`matchTimelineSections.ts`、`criticalWindows.ts`、`buildMatchContext.ts`、`positionAnalysis.ts`;desktop `pressureLanes.ts` | prompt 承压泳道与 UI 承压泳道必须完全一致;已有 parity 测试把泳道数钉到 prompt 行数。 |
| 反事实的回溯窗口                       | `packages/analysis/src/utils/counterfactual.ts` → `COUNTERFACTUAL_WINDOW_S` | `matchTimelineSections.ts`                                                                                                                     |                                                                                      |
| 减伤反事实达到多少 HP 边际算「决定性」 | `packages/analysis/src/utils/counterfactual.ts` → `DECISIVE_MARGIN_PCT`     | `matchTimelineSections.ts`;desktop `DeathRecapCard.tsx`                                                                                        | prompt 措辞与死亡回顾卡片必须把同一个事件归成同一档。                                |

### 分类与名表

| 事实                         | 权威谓词                                                                           | 消费方                                                                                                                                  | 备注                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 专精的显示字符串             | `packages/analysis/src/utils/cooldowns.ts` → `specToString`                        | `analysis/src/context/*`、`benchmark/metrics.ts`;门规 `coverageManifest.ts`;corpus-tools `perMatchRecord.ts`                            | 门规按这些字符串匹配,任何一处拼法不同都会静默漏掉覆盖率。                                   |
| 这个专精是不是治疗           | `packages/analysis/src/utils/cooldowns.ts` → `isHealerSpec`                        | `analysis/src/context/*`、`candidateFindings.ts`;门规 `positioningScan.ts`、`buildCorpus.ts`;corpus-tools `perMatchRecord.ts`           |                                                                                             |
| 这个专精是不是近战           | `packages/analysis/src/utils/cooldowns.ts` → `isMeleeSpec`                         | `buildMatchContext.ts`、`deepDive.ts`、`enemyCompArchetype.ts`、`positionAnalysis.ts`;desktop `keyMoments.ts`;门规脚本                  |                                                                                             |
| 哪些技能 id 是控制           | `packages/analysis/src/data/spellTags.ts` → `ccSpellIds`                           | `matchTimeline.ts`、`ccTrinketAnalysis.ts`、`drAnalysis.ts`、`healerExposureAnalysis.ts`、`healerMetrics.ts`;门规 `coverageManifest.ts` |                                                                                             |
| 哪些技能 id 是 PvP 饰品      | `packages/analysis/src/data/spellTags.ts` → `trinketSpellIds`                      | desktop `keyMoments.ts`;门规 `coverageManifest.ts`                                                                                      |                                                                                             |
| 技能的英文名                 | `packages/analysis/src/data/spellEffectData.ts` → `getEnglishSpellName`            | `analysis/src/context/*`、`ccTrinketAnalysis.ts`、`healerOffenseAnalysis.ts`;门规 `coverageManifest.ts`                                 | 门规在渲染后的 prompt 里找这些名字;只改一边,这个技能对覆盖率就直接消失。                    |
| 某种光环类型会不会打断施法   | `packages/analysis/src/data/spellCategories.ts` → `isCastBlockingAuraType`         | `healingGaps.ts`、`dispelAnalysis.ts`                                                                                                   | 只能按文件路径 import——包根没再导出。                                                       |
| finding 的类别词表           | `packages/analysis/src/analysis/findingCategories.ts` → `FINDING_CATEGORIES`       | `buildFindingsPrompt.ts`                                                                                                                |                                                                                             |
| 归一化模型写出来的类别       | `packages/analysis/src/analysis/findingCategories.ts` → `normalizeFindingCategory` | `auditFindings.ts`、`learning/types.ts`;desktop `main/analysis.ts`、`main/learning.ts`、`findingDisplay.ts`                             | prompt、审计器、自学习库、UI 四处必须把同一条 finding 归进同一个桶,否则教练闭环会重复计数。 |
| 一次爆发窗口有没有转化成伤害 | `packages/analysis/src/utils/dpsMetrics.ts` → `isBurstConverted`                   | `candidateFindings.ts`;desktop `keyMoments.ts`                                                                                          |                                                                                             |

### 格式化与记号

| 事实                           | 权威谓词                                                                             | 消费方                                                       | 备注                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{{key}}` 占位符记号           | `packages/analysis/src/compare/claimChecker.ts` → `PLACEHOLDER`                      | `claimChecker.ts`、`learning/distillRules.ts`、`deepDive.ts` | 写入方、插值方、纪律检查三处必须认同一种记号形状。                                                                                       |
| 哪些 cohort 对比缓存仍然有效   | `packages/analysis/src/compare/buildExemplarLedPrompt.ts` → `COMPARE_PROMPT_VERSION` | desktop `main/compare.ts`(`finish` 写侧、`getCached` 读侧)   | 与它所版本化的 prompt 放在一起。此前用的是**分析**的 `PROMPT_VERSION`,于是 findings prompt 每 bump 一次,全库已存的对比就被静默作废一次。 |
| finding 的 fact 串里数字怎么写 | `packages/analysis/src/analysis/factFormat.ts` → `fmtFactNum`                        | `candidateFindings.ts`、`deepDive.ts`                        | 只能按文件路径 import。finding 在下游是按文本比对的,两个格式化器 = 两个「不同」的事实。                                                  |

### 门规侧(`packages/eval`)

| 事实                                                    | 权威谓词                                                                             | 消费方                                                                        | 备注                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一行里的百分位序列必须单调不减                        | `packages/eval/src/quality/promptQualityCheck.ts` → `checkPercentileMonotonicity`    | `checkMatch`(`hardFailures`)                                                  | 四条确定性硬门之一。要加第五条就加进 `hardFailures`,绝不要留一次性脚本——脚本随会话消失。                                                                    |
| 同一渲染秒、同一单位 ⇒ 同一 HP                          | `packages/eval/src/quality/promptQualityCheck.ts` → `checkSameSecondHpConsistency`   | `checkMatch`(`hardFailures`)                                                  | 刻意锚定在渲染文本上:早先那次「统一采样半径」的修法,这个数一个都没动。                                                                                      |
| 窗口标注的时长等于渲染起止之差                          | `packages/eval/src/quality/promptQualityCheck.ts` → `checkWindowSpanConsistency`     | `checkMatch`(`hardFailures`)                                                  | `renderedWindowSeconds` 的精确逆运算。                                                                                                                      |
| 声称「available」的冷却不得同时在同刻台账的冷却中列表里 | `packages/eval/src/quality/promptQualityCheck.ts` → `checkCooldownLedgerConsistency` | `checkMatch`(`hardFailures`)                                                  | 判定带归属:镜像阵容下只按技能名比对会有 67% 假阳性。                                                                                                        |
| 哪些行算与死亡相关                                      | `packages/eval/src/quality/promptQualityCheck.ts` → `DEATH_KEYWORDS`                 | `checkFriendlyDeaths`;`judge/buildCalibrationSuite.ts`(`removeDeaths`)        | 植入的校准缺陷与门规必须看同一批行,否则校准什么都没测。                                                                                                     |
| prompt 文本里出现了哪些几何主张                         | `packages/eval/src/quality/positioningScan.ts` → `extractGeoClaims`                  | `packages/eval/scripts/positioningScan.ts`                                    |                                                                                                                                                             |
| 这些主张从日志复算能否成立                              | `packages/eval/src/quality/positioningScan.ts` → `checkGeoClaims`                    | `packages/eval/scripts/positioningScan.ts`                                    | 复算用的正是上面那批分析侧几何谓词——它们之所以 export 就是为了这个。                                                                                        |
| 判官必须写的事实审计条数下限                            | `packages/eval/src/provenance/checkScoreProvenance.ts` → `FACT_AUDIT_MIN`            | `checkScoreProvenance`                                                        | 对面是 `docs/commands/eval-baseline.md`,一份 import 不进来的 markdown 规格——断言相等这条备选路的范例,由 `packages/eval/test/factAuditBounds.test.ts` 钉住。 |
| 判官必须写的事实审计条数上限                            | `packages/eval/src/provenance/checkScoreProvenance.ts` → `FACT_AUDIT_MAX`            | `checkScoreProvenance`                                                        | 同上。                                                                                                                                                      |
| 可复现抽样用的确定性随机数                              | `packages/eval/src/ab/abCompareStats.ts` → `makeRng`                                 | `bootstrapCI`、`judge/buildCalibrationSuite.ts`、`packages/eval/src/index.ts` | 2026-08-01 起单源。`buildCalibrationSuite.ts` 曾私有抄一份、注释写「与 abCompareStats 同」;两份 RNG 一旦漂移,校准结果就不可复现。                           |

### 语料归档(`packages/corpus-tools`)

| 事实                                    | 权威谓词                                                                | 消费方                                                     | 备注                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 某时刻属于哪个 UTC 日期键(`YYYY-MM-DD`) | `packages/corpus-tools/src/archiveLedger.ts` → `dateKeyOf`              | 账本分片名;`archivePlan.ts`(`matchDateKey`)                | 2026-08-01 被写了第二遍;账本分片名与归档目录名必须出自同一个函数,否则去重静默失效。                                            |
| 账本往回加载多少天的分片                | `packages/corpus-tools/src/archiveLedger.ts` → `LEDGER_WINDOW_DAYS`     | `scripts/archivePvpLogs.ts`                                | 刻意取 10 天——比 feed 的 7 天窗口宽。                                                                                          |
| 一场比赛归到哪个日期目录                | `packages/corpus-tools/src/archivePlan.ts` → `matchDateKey`             | `scripts/archivePvpLogs.ts`                                | 按**比赛开始时刻**而非下载时刻,补扫才会落进同一个目录。格式化走 `dateKeyOf`。                                                  |
| 暂存区里的这一项是不是日期分片目录      | `packages/corpus-tools/src/archivePlan.ts` → `isDateKeyDir`             | `scripts/archivePvpLogs.ts`                                | 防 `.DS_Store`:它按字典序排在所有日期之前,曾把整轮跑挂掉。                                                                     |
| 这一场是不是已知                        | `packages/corpus-tools/src/archivePlan.ts` → `isKnownStub`              | `shouldArchive`;`scripts/archivePvpLogs.ts` 的连续已知计数 | 双键:id **与** `logObjectUrl`。这就是 2026-08-01 被手抄进编排壳的那个谓词。判错一边是重下(花钱),另一边是早停(7 天后永久丢失)。 |
| 这一场收不收                            | `packages/corpus-tools/src/archivePlan.ts` → `shouldArchive`            | `scripts/archivePvpLogs.ts`                                |                                                                                                                                |
| 连续见到多少个已知场次才停止翻页        | `packages/corpus-tools/src/archivePlan.ts` → `shouldStopScanning`       | `scripts/archivePvpLogs.ts`                                | 包住 `STOP_AFTER_KNOWN`,别直接拿常量去比。                                                                                     |
| 下载下来的载荷完整吗                    | `packages/corpus-tools/src/archivePlan.ts` → `checkArchivePayload`      | `scripts/archivePvpLogs.ts`                                | 按正确顺序组合下面两层检查。                                                                                                   |
| 压缩字节数与 GCS 声明是否一致           | `packages/corpus-tools/src/pvpLogFetch.ts` → `checkRawPayloadBytes`     | `archivePlan.ts`、`scripts/fetchPvpLogs.ts`                | 必须在**未解压**字节上比。                                                                                                     |
| 解压后的文本是否含两个哨兵              | `packages/corpus-tools/src/pvpLogFetch.ts` → `checkDecompressedPayload` | `archivePlan.ts`、`scripts/fetchPvpLogs.ts`                | 这一层永远不看字节数——那是上一条的事。                                                                                         |

### 录像回放与托管 OBS(`packages/desktop`)

| 事实                                      | 权威谓词                                                          | 消费方                                                                                                                                         | 备注                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 装的是哪个 OBS 发行版(钉死的版本号字符串) | `packages/desktop/src/shared/obsAsset.ts` → `OBS_VERSION`         | `main/obsAssets.ts`(安装根目录、profile 的 `LastVersion`);`main/obsConfigWriter.ts`(`global.ini` 里的 `LastVersion`);`scripts/obsGateCheck.ts` | 2026-08-04 对着真实 GitHub release 与真机核对过 —— 升版本前必须连同下面几个常量一起复核。                                                                    |
| 钉死的 OBS 发行版从哪下载                 | `packages/desktop/src/shared/obsAsset.ts` → `OBS_ZIP_URL`         | `main/obsAssets.ts`(下载);`scripts/obsGateCheck.ts`;渲染进程 `SettingsPanel.tsx`(手动「打开发行页」链接)                                       | 由 `OBS_VERSION` 拼出 —— 两个常量升版本时一起动。                                                                                                            |
| 下载下来的 OBS zip 期望的 SHA-256         | `packages/desktop/src/shared/obsAsset.ts` → `OBS_ZIP_SHA256`      | `main/obsAssets.ts`(校验);`scripts/obsGateCheck.ts`                                                                                            | 尺寸对但哈希不对的文件会被删掉,下一次跑就会重新下载,而不是永远重复同一个失败。                                                                               |
| 下载下来的 OBS zip 期望的字节数           | `packages/desktop/src/shared/obsAsset.ts` → `OBS_ZIP_BYTES`       | `main/obsAssets.ts`(缓存判定 + 断点续传);`scripts/obsGateCheck.ts`;渲染进程 `SettingsPanel.tsx`(进度条总量、MB 文案)                           |                                                                                                                                                              |
| 托管 OBS 实例的 websocket 端口            | `packages/desktop/src/shared/obsAsset.ts` → `MANAGED_WS_PORT`     | `main/managedAssembly.ts`;`main/obsConfigWriter.ts`;`scripts/obsGateCheck.ts`                                                                  | 4466 —— 刻意避开用户自己 OBS 的默认端口 4455(设计文档 §2.4),真机核实过空闲。                                                                                 |
| 解压出的 OBS 目录树里哪些文件留、哪些丢   | `packages/desktop/src/shared/obsAsset.ts` → `shouldExtract`       | `main/obsAssets.ts`                                                                                                                            | 黑名单式:默认全解压,只跳过已知体积大、已知用不到的载荷(CEF、pdb、脚本引擎、多余语言包)。两种路径分隔符都认。                                                 |
| 一场比赛的开局/结尾在录像里的位置与余量   | `packages/desktop/src/shared/videoTime.ts` → `computeVideoWindow` | 渲染进程 `VideoTab.tsx`;`scripts/headroomBaseline.ts`(设计文档 §9.1 验收基线)                                                                  | `headroomS` 刻意带符号 —— 负值是真实、可上报的值(一期基线预期全负);绝不能夹到 0。一期曾用 `Math.max(0, ...)` 包住偏移量,结果把每次跳转都晚移了整段日志滞后。 |
| 录像秒 → 这场比赛的对局内秒               | `packages/desktop/src/shared/videoTime.ts` → `toBattleSeconds`    | 渲染进程 `VideoTab.tsx`                                                                                                                        |                                                                                                                                                              |
| 对局内秒 → 这场比赛的录像秒               | `packages/desktop/src/shared/videoTime.ts` → `toVideoSeconds`     | 渲染进程 `VideoTab.tsx`                                                                                                                        |                                                                                                                                                              |
| 用户点某个战斗时刻时该跳到录像的哪一秒    | `packages/desktop/src/shared/videoTime.ts` → `seekTargetS`        | 渲染进程 `VideoTab.tsx`                                                                                                                        | 先按 `PRE_ROLL_S` 回退再夹进窗口;`VideoTab.tsx` 里三处独立的点击接线都走这里,不再各自手算偏移。                                                              |

<!-- predicate-index:end -->

## 尚未统一

**截至 2026-08-01 为空。**编这份索引时登记的五条重复当天全部收口:四条改成了共享 export,一条查下来根本不是重复。各自的处置:

- **「治疗被贴脸」距离**改为 `positionSampling.ts` → `HEALER_TRAINED_YARDS`,产出侧 import、门规侧取别名。
- **「CC 的最大合理距离」**原本是三个数自称同一个事实。实际是两个事实:`CC_MAX_CAST_RANGE_YARDS`(40 —— 这个 CC 够不够得着)与 `CC_MAX_PLAUSIBLE_RANGE_YARDS`(45 —— 这个复算出来的距离信不信得过),后者由前者派生,顺序关系不可能漂。门规私有的 50 码删了:它比产出侧自己的抑制阈值还松,`G6_IMPOSSIBLE_CC` 根本触发不了。收紧在今天的语料上行为不变 —— 141237 条已渲染的 CC 距离主张里,>50 码 0 条,>45 码 0 条(最大 44.7)。
- **`makeRng`** 改为从 `ab/abCompareStats.ts` import,私有副本删除。
- **`IndexEntry`** 只在 `corpus/buildCorpus.ts` 声明一次,其余各处(含 `scripts/positioningScan.ts`)一律 `import type`。

以下**不是**重复,登记在此以免有人「顺手统一」:

- **「窗口内最近距离」产出侧与门规侧刻意不同参。**`positionAnalysis.ts` 按整秒扫,容差 `INTERP_MAX_GAP_MS`(1500 ms);门规的 `minDistanceInWindow` 按整秒**加**每个 advanced-action 时刻**加**亚秒网格扫,容差 `LOS_SWEEP_GAP_MS`(3000 ms)。门规的时刻集合是产出侧的**严格超集**、gap 也更松,而 `getUnitPositionAtTime` 的 gap 只管接受/拒绝、不改变插得的值 —— 于是恒有 `gateMin ≤ producerMin`,门规的单边判据(只罚「声称得比物理观测更近」)正是这个方向关系的正确表达,不是兜底。反过来让产出侧吃门规的 gap 是**退步**:`INTERP_MAX_GAP_MS` 是 T3 grounding 守卫,当初就是它掐掉了跨采样空窗的中段插值(那条 0.4 码的假贴脸主张)。这层关系由 `predicateIndex.test.ts` 端到端钉住 —— 真产出器渲染出的主张必须过真门规,并配「窗口取错」的负对照。共享的只有采样**时刻集合**,即 `positionSampleInstants`。
- `promptQualityCheck.ts` 的 `HP_AGREEMENT_TOLERANCE_PP`(3 个百分点)是门规单侧、作用在渲染文本上的松弛量,分析侧没有对应物,绝不能与 `HP_SAMPLE_RADIUS_MS` 划等号。
- `quality/coverageManifest.ts` 刻意拒绝复用分析管线:共用会让这道检查变成循环论证。它只共享静态表(`ccSpellIds`、`trinketSpellIds`、`getEnglishSpellName`、`specToString`)。

## 怎么保证这页不腐烂

`packages/eval/test/predicateIndex.test.ts` 是这个页面可执行的另一半。它会:

- 按文件路径 import 上面列出的每一个谓词,少一个或改了名就挂;
- 从两个语言版本里解析出表格,两版列的谓词不一致、或任一版与测试自己的清单不一致就挂;
- 断言那些无法共享 export 的配对:门规的 LoS 容差、CC 上限、贴脸定义仍然是从分析侧 export **派生**的而不是手抄的字面量,以及 `matchDateKey` 仍然经 `dateKeyOf` 格式化;
- 断言 `makeRng` 与 `IndexEntry` 在整个 `packages/eval` 树里各只有一处声明 —— 类型被编译期擦除,这是唯一钉得住它的办法;
- 端到端断言各组「产出方 / 门规」互逆关系——经 `fmtTime` + `renderedWindowSeconds` 渲染出的窗口必须通过 `checkWindowSpanConsistency`,取自 `toSortedFinite` 的百分位必须通过 `checkPercentileMonotonicity`,真 `computeOwnerPositionEvents` 产出、真 formatter 渲染的 `HEALER_TRAINED` 主张必须通过真门规——每组都配了反向对照,保证断言不会空转。

跑法:`npm test --workspace=packages/eval`。
