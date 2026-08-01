# BACKLOG #10 补全:结构化信号全面出面 设计

2026-08-01 · 用户拍板设计表(八项)。原则:全部消费既有谓词零新计算,纯 derive+UI;
出面形态沿用既有卡片/泳道/轴心家族的成熟形制。

## 1. Dampening 泳道 + CC 条目 DR 标注

- Timeline 增 `dampening?: Array<{tS; pct}>` prop(镜像 pressure prop 形制),数据源
  `deriveDampeningSeries`(现成零消费方;内部换 `computeDampeningTimeline` 采样修
  O(n²),0–1→0–100 单位换算收敛在 derive 内);渲染为 pressure 泳道上方第二条细带
  (新 LANE_GAP 常量,渐变透明度=浓度),title 悬浮显示百分比。
- KeyMomentAxis 的 cc 条目 detail 追加 DR 档位:`ICCInstance.drInfo` 已在
  `analyzePlayerCCAndTrinket` 输出里,keyMoments.ts 纯格式化(`DR_LEVEL_LABEL` 单源)。

## 2. 击杀窗目标选择 → 爆发账本卡

- `deriveBurstLedger` 返回增 team 级 `targetSelection: IKillWindowTargetEval[]`
  (复用 :45 已算好的 windows,一次调用);
- BurstLedgerCard「窗口目标纪律」节按 `windowFromSeconds` join:`betterTargetExists`
  时行尾加 `<Chip kind="bad">该打 {betterTargetName}({spec})</Chip>`,否则
  `<Chip kind="good">目标合理</Chip>`。

## 3. 治疗空窗 → KeyMomentAxis + 指标格

- keyMoments 新 kind `heal-gap`(minor):owner 为治疗时调 `detectHealingGaps`,
  每条 gap 一个时刻点(t=fromSeconds,toT=toSeconds,detail=时长+受伤最重者);
  KIND_ICON/KIND_ZH 补全(TS Record 强制);
- healerMetrics 增 `healingGapSeconds: number`、`healingGapCount: number` 标量字段
  (compare/corpus 消费方类型同步),ProComparison 面板顺带显示。

## 4. 比赛节奏 → 战报头部行

- 新 `buildMatchArcStructured(同 buildMatchArc 入参): Array<{phase: "early"|"mid"|
  "late"; fromS; toS; prose; jumpT?}>`——把 buildMatchArc 内部已算好的丢弃值
  (firstDefensive/firstBurst/firstDeath/相位边界)结构化;buildMatchArc 改为
  消费它再格式化(单源防漂移,现有 prompt 文本逐字节不变=既有测试防腐);
- MatchReport 头部行下方新一行紧凑「比赛节奏」条(三相位横排,相位内转折点
  可点 onSeek);renderer 侧 derive 复用 keyMoments 的 enemyCDTimeline/majorCooldowns
  组装模式。

## 5. 走位事件 → KeyMomentAxis

- keyMoments 新 kind `position`(minor):`computeOwnerPositionEvents` deepDive.ts:411
  最小参数集模板;仅收 STAYED_IN(有实际代价:`stayedInHadRealCost` 单源谓词)/
  MISSED_PUSH/CD_OUT_OF_RANGE 三类(HEALER_TRAINED 已由治疗暴露泳道覆盖,KITED 是
  正面事件不进轴)。positionAnalysis 需入 analysis barrel(index.ts export *)。

## 6. panic/更廉价替代 → 死亡回顾+KeyMomentAxis 注记

- deathRecap 的 `def_used` 事件行:join `detectPanicDefensives`(键
  spellId+|tS−timeSeconds|<1)加「恐慌性使用」徽标;
- keyMoments defensive 条目:KeyMoment 增可选 `spellId`,同键 join 加 detail 注记;
- `findCheaperDefensiveAlternatives`:death recap 的 unused-defensive 行(已有
  availableImmunities/missedExternals 结构)对 owner 的每个 cast 时点补
  「更省替代:X」(需 extractMajorCooldowns,keyMoments:149 同模式)。

## 7. CC 链面板

- 新 derive `ccChainDash.ts` + 组件 `CCChainPanel.tsx`,镜像 Kick/Dispel 面板全套
  惯例(EMPTY 兜底/range 只过滤结果/classColor 行头/展开行/▶ seek/空态保卡壳);
- 行=每敌方目标一链(`analyzeOutgoingCCChains` 直连):链长、总控时、
  `hasWastedApplications` 徽标,展开=逐 application(时刻/技能/施法者/DR 档位,
  25%/Immune 行标红);挂 MatchReport 打断/驱散面板之后。

## 8. 死码清理

- 删 `detectFriendlyCDOverlaps` + `IOverlapCast`/`IFriendlyCDOverlapGroup`/
  `formatFriendlyCDOverlapsForContext`(零调用已证)。

## 边界(不做)

- extractMatchDynamics 出面(聚类特征向量非叙事,无 UI 价值);buildMatchFlow
  已 deprecated 不动;AoE CC 事件独立出面(链面板展开已覆盖);dampening 泳道
  不做点击交互(纯读)。

## 测试与基线

- 每项:derive 单测(红→绿)+ 组件断言;buildMatchArcStructured 与 buildMatchArc
  输出一致性断言(单源防腐);healerMetrics 新字段的 compare/corpus 类型链全绿;
- 视觉基线:report-battle/synth/window(泳道+账本+CC 面板+头部行)、report-ai
  (轴新 kinds+指标格)全会变——CI 重生成人审;头部行影响全部 report-* 场景;
- 新交互元素带 accessible name(axe 门)。
