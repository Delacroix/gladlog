# BACKLOG #10 Completion (Eight Surfacing Signals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose all eight sets of signals already computed by buildMatchContext but only passed to LLM text to the UI (spec: docs/superpowers/specs/2026-08-01-backlog10-surfacing-design.md).

**Architecture:** Consume existing analysis predicates with zero new calculation; renderer side derive (toLegacySafe mode) + expand existing card/lane/axis formats; the only new analysis side function is `buildMatchArcStructured` (structures existing internal values, prose version changed to consume it, output remains byte-for-byte identical).

**Tech Stack:** TypeScript / React / vitest。

## Global Constraints

- 门规谓词即规范:不复算任何条件;DR 档位文案用 `DR_LEVEL_LABEL`(drAnalysis.ts:433);STAYED_IN 代价判定用 `stayedInHadRealCost`(positionAnalysis.ts:72);buildMatchArc 的 prose 输出改造后必须与改造前**逐字节一致**(既有 prompt 测试 + 新增一致性断言双保)。
- 面板家族惯例(Kick/Dispel 精确形制):`try{}catch{return EMPTY}`;range 只过滤结果不过滤输入;空态保卡壳;行头 classColor 点;▶ seek = `onSeek(Math.max(0, t-3), [name])`。
- KeyMomentAxis 的 KIND_ICON/KIND_ZH 是 exhaustive Record——新 kind 必须同步补齐(TS 强制);图标用文字字形禁 emoji。
- 新交互元素必须带 accessible name(axe 门独立于像素门)。
- healerMetrics 新增字段必须是标量(ProComparison 经 `Record<string,number|null>` 扁平化);compare.ts/perMatchRecord/api.ts 类型链同步。
- 视觉基线本地绝不跑 test:visual;收尾统一 CI 重生成人审。
- 提交纪律:每任务独立 commit(中文+trailers),不 push;workspace 口径测试;`npm run typecheck`(绝不 tsc -b);desktop 改动跑 `npx eslint packages/desktop/src --quiet`;renderer 新 import 留意 bundle 卫生(收尾 presubmit 的 electron-vite build 是真门)。

## 计划期已核实的接口(执行者直接引用,勿再考古;全部 file:line 于 worktree 当前 HEAD)

- `deriveDampeningSeries(source): Array<{tS;pct}>`(derive/dampeningSeries.ts:10,pct 0–100,零消费方;内部逐秒调 `getDampeningPercentage` O(n²));`computeDampeningTimeline(bracket, players, startTime, endTime): IDampeningSnapshot[]`(dampening.ts:170,30s 变化点采样,`dampening` 为 0–1)。
- Timeline props 单对象 `pressure?: {spikes; exposures}`(Timeline.tsx:89),泳道渲染 :252-288,几何 `LANE_H=8`(:18),接线模式 MatchReport.tsx:124+:464。
- `ICCInstance.drInfo: IDRInfo|null`(ccTrinketAnalysis.ts:189);keyMoments cc 条目构造 :205-227(已调 `analyzePlayerCCAndTrinket`,弃 drInfo);`IDRInfo{category; level: DRLevel; sequenceIndex}`(drAnalysis.ts:155)。
- `analyzeKillWindowTargetSelection(windows, enemies, combat): IKillWindowTargetEval[]`(killWindowTargetSelection.ts:331;`IKillWindowTargetEval{windowFromSeconds; windowToSeconds; focusedTarget; otherTargets; betterTargetExists; betterTargetName?; betterTargetSpec?}` :66;enemies<2 返回 []);burstLedger.ts:45 已算 `windows = computeOffensiveWindows(...)`;`LedgerPlayer`(burstLedger.ts:16);BurstLedgerCard「窗口目标纪律」节 :161-186,行键 windowFromSeconds,`Chip({kind,children})` :13。
- `detectHealingGaps(healer, friends, enemies, combat): IHealingGap[]`(healingGaps.ts:150;`IHealingGap{fromSeconds; toSeconds; durationSeconds; freeCastSeconds; mostDamagedName; mostDamagedSpec; mostDamagedAmount}` :41;调用先例 buildMatchContext.ts:249-251 gated on owner is healer)。
- `IHealerMetrics`(healerMetrics.ts:52-62);`computeHealerMetrics(combat, playerName)` 单位不存在会 throw(:72);消费链 ProComparisonVerified.tsx:157-165(扁平化)、compare.ts、corpus-tools/perMatchRecord、preload/api.ts。
- `buildMatchArc(enemyCDTimeline, allTeamCooldownsWithPlayer, friendlyDeaths, durationSeconds, bracket): string[]`(matchNarrative.ts:200;内部丢弃值:firstDefensiveSeconds/Name/Spec :243-256、firstBurst.fromSeconds/toSeconds/dangerLabel、firstDeath.atSeconds、earlyEnd/midEnd/lateStart :258-271;唯一调用 buildMatchContext.ts:862,入参组装 :856-861);renderer 组装模式:keyMoments.ts:129 `reconstructEnemyCDTimeline(enemies, legacy, owner, friends)` + :149 `extractMajorCooldowns(u, legacy)` + :86 deaths。
- ReportHeader({source, roundLabel})(ReportHeader.tsx:21),挂载 MatchReport.tsx:382(rpt-head-row 右侧;左侧 :369-381 是视图 tab 条)。
- `computeOwnerPositionEvents(params 单对象)`(positionAnalysis.ts:200;**未入 barrel**,需 index.ts 加 `export * from "./utils/positionAnalysis"`;最小参数集模板=deepDive.ts:411:owner/enemies/combat/burstWindows/ownerCooldowns/ownerCCSummary/isHealer/ownerIsMelee/friends);`IPositionEvent`(:91,时间字段 **atSeconds/toSeconds**,无 severity);`PositionEventType`(:83)。
- `detectPanicDefensives(friends, enemies, combat): IPanicDefensive[]`(cooldowns.ts:1809;`IPanicDefensive{timeSeconds; casterSpec; casterName; spellName; spellId; targetName; targetSpec}` :1694);`findCheaperDefensiveAlternatives(cd, ownerCDs, atSeconds, opts): string[]`(cooldowns.ts:885,裸名字串);DeathRecapEvent `def_used` 已有 spellId+tS(deathRecap.ts:22-33);KeyMoment **无 spellId 字段**(keyMoments.ts:20-35),defensive 条目构造 :147-177。
- `analyzeOutgoingCCChains(friendlies, enemies, combat): IOutgoingCCChain[]`(drAnalysis.ts:320;`IOutgoingCCChain{targetName; targetSpec; applications: IOutgoingCCApplication[]; hasWastedApplications}` :302;`IOutgoingCCApplication{atSeconds; durationSeconds; spellId; spellName; casterName; casterSpec; drInfo}` :292;勿加 DR 过滤——:311-318 注释明令);Kick 面板形制:derive/kickDash.ts(`KickDashRow` :8-21,`deriveKickDash(source, range?)` :30)+ KickDashboard.tsx(props :14-20,空态保壳 :22-33);挂载点 MatchReport.tsx:501-502。
- 死码:`detectFriendlyCDOverlaps`(cooldowns.ts:1411)+ `IOverlapCast`(:1394)+ `IFriendlyCDOverlapGroup`(:1402)+ `formatFriendlyCDOverlapsForContext`(:1490),全仓零调用已证。
- KeyMomentKind(keyMoments.ts:17);MAJOR_KINDS(:37-40);KIND_ICON/KIND_ZH(KeyMomentAxis.tsx:26-40,exhaustive);nodeColor(:171-184);videoMoments.ts:13 的 kind 并集会自动放宽(新 kind 自然流入录像 strip/feed——预期行为,勿挡)。
- 视觉基线爆炸半径:泳道/账本/CC 面板 → report-battle/synth/window;轴/指标 → report-ai;头部行 → 全部 report-*;死码删除 → 零。

---

### Task 1: analysis 侧地基 —— buildMatchArcStructured + barrel + 死码清理

**Files:**

- Modify: `packages/analysis/src/context/matchNarrative.ts`
- Modify: `packages/analysis/src/index.ts`(+`export * from "./utils/positionAnalysis"`)
- Modify: `packages/analysis/src/utils/cooldowns.ts`(删死码四件)
- Test: `packages/analysis/test/matchNarrative.arc.test.ts`(新)

**Interfaces:**

- Produces:

```ts
export interface IMatchArcPhase {
  phase: "early" | "mid" | "late";
  fromS: number;
  toS: number;
  prose: string; // 该相位一句话(与 buildMatchArc 对应行的冒号后文本一致)
  turningPoint?: { tS: number; label: string }; // early=首个防御 CD;mid=首死或首爆发窗解决
}
export function buildMatchArcStructured(
  enemyCDTimeline: IEnemyCDTimeline,
  allTeamCooldownsWithPlayer: Array<{
    player: ICombatUnit;
    cd: IMajorCooldownInfo;
  }>,
  friendlyDeaths: Array<{ spec: string; atSeconds: number }>,
  durationSeconds: number,
  bracket: string,
): IMatchArcPhase[]; // durationSeconds<90 时两相位,与 prose 版同分支
```

- `buildMatchArc` 改为内部调 `buildMatchArcStructured` 再格式化;**输出逐字节不变**。

- [ ] **Step 1**: 写失败测试:①用合成输入断言 structured 相位边界/turningPoint 与手算一致;②一致性断言——对同一组输入,重构前后 `buildMatchArc` 输出数组深等(先在测试里内联旧实现的期望输出快照,重构后必须仍匹配);③barrel 导入 `computeOwnerPositionEvents` 编译通过;④`detectFriendlyCDOverlaps` 等四符号 import 失败(删除验证,用 `@ts-expect-error` 或直接断言 index 导出面不含)。
- [ ] **Step 2**: 跑 `npm run test --workspace=packages/analysis -- matchNarrative` 确认红。
- [ ] **Step 3**: 实现(structured 抽取内部丢弃值;prose 版消费之;barrel 加行;删死码四件与其测试残留)。
- [ ] **Step 4**: analysis workspace 全绿(既有 prompt/faithfulness 测试是逐字节防腐网)+ typecheck。
- [ ] **Step 5**: Commit `feat(analysis): buildMatchArcStructured 单源结构化 + positionAnalysis 入 barrel + CD 重叠死码清理(#10 T1)`。

### Task 2: Dampening 泳道 + CC DR 标注

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/dampeningSeries.ts`(内部换 computeDampeningTimeline 采样,输出形状不变)
- Modify: `packages/desktop/src/renderer/src/report/components/Timeline.tsx`(新 `dampening?` prop + 第二泳道)
- Modify: `packages/desktop/src/renderer/src/report/derive/keyMoments.ts` + `components/KeyMomentAxis.tsx`(cc detail 加 DR)
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(接线两行)
- Test: `packages/desktop/test/`(dampeningSeries 单测改造;Timeline 泳道渲染断言;keyMoments DR 文案断言)

**Interfaces:** Consumes T1 无;Produces Timeline `dampening?: Array<{tS: number; pct: number}>`。

- [ ] **Step 1**: 失败测试:dampeningSeries 在合成 110310 事件下输出正确且调用次数 O(events)(mock 计数);Timeline 传 dampening 渲染 `data-testid="rpt-damp-lane"` rect 数>0、不传无;cc KeyMoment detail 含「DR:½」(用 DR_LEVEL_LABEL 的实际文案)。
- [ ] **Step 2**: 确认红。
- [ ] **Step 3**: 实现(泳道 y 位 = 现 pressure 泳道上方,新 `LANE_GAP=2` 常量;透明度映射 pct/100;title 悬浮)。
- [ ] **Step 4**: desktop workspace 全绿 + typecheck + eslint。
- [ ] **Step 5**: Commit `feat(desktop): Timeline dampening 泳道 + CC 时刻 DR 档位标注(#10 T2)`。

### Task 3: 击杀窗目标选择 + 治疗空窗

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/burstLedger.ts`(返回增 team 级 targetSelection)
- Modify: `packages/desktop/src/renderer/src/report/components/BurstLedgerCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/derive/keyMoments.ts`(heal-gap kind)+ `KeyMomentAxis.tsx`(Record 补齐)
- Modify: `packages/analysis/src/utils/healerMetrics.ts`(+healingGapSeconds/healingGapCount 标量)及消费链类型(compare.ts / corpus-tools perMatchRecord / preload api.ts / ProComparisonVerified 展示格)
- Test: 对应各文件测试

**Interfaces:** `deriveBurstLedger` 返回改 `{ players: LedgerPlayer[]; targetSelection: IKillWindowTargetEval[] }`(**破坏性返回形状变更**——BurstLedgerCard 与既有调用点同步;搜全调用面)。

- [ ] **Step 1**: 失败测试:合成双敌场景 targetSelection 非空且 join 到卡片行(betterTargetExists → bad Chip 文案);单敌返回 [];heal-gap KeyMoment 出现于合成空窗场景、非治疗 owner 不出;healerMetrics 新字段数值断言 + 消费链 typecheck。
- [ ] **Step 2**: 确认红。
- [ ] **Step 3**: 实现。
- [ ] **Step 4**: analysis+desktop workspace 全绿 + typecheck + eslint。
- [ ] **Step 5**: Commit `feat(desktop,analysis): 爆发账本目标选择判定 + 治疗空窗出面(轴+指标)(#10 T3)`。

### Task 4: 比赛节奏头部行 + 走位事件

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/matchArc.ts`(renderer 组装 buildMatchArcStructured 入参,keyMoments:129/:149 模式)
- Create: `packages/desktop/src/renderer/src/report/components/MatchArcLine.tsx`
- Modify: `MatchReport.tsx`(头部行下挂载)+ `styles.css`
- Modify: `keyMoments.ts`(position kind,deepDive.ts:411 最小参数集,三类过滤:STAYED_IN 且 stayedInHadRealCost / MISSED_PUSH / CD_OUT_OF_RANGE)+ `KeyMomentAxis.tsx`
- Test: 对应各文件

**Interfaces:** Consumes T1 的 `buildMatchArcStructured`/`IMatchArcPhase` 与 barrel 化的 positionAnalysis。

- [ ] **Step 1**: 失败测试:MatchArcLine 渲染三相位与可点转折点(onSeek 收到 jumpT);短场两相位;position KeyMoment 三类进轴、KITED/无代价 STAYED_IN 不进。
- [ ] **Step 2**: 确认红。
- [ ] **Step 3**: 实现(arc 行紧凑单行,`data-testid="match-arc-line"`,转折点 button 带 aria-label)。
- [ ] **Step 4**: 全绿 + typecheck + eslint。
- [ ] **Step 5**: Commit `feat(desktop): 比赛节奏头部行(结构化转折点可点)+ 走位事件进时刻轴(#10 T4)`。

### Task 5: panic/替代注记 + CC 链面板

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts`(def_used join panic + unused 行加替代)与 `DeathRecapCard.tsx`
- Modify: `keyMoments.ts`(KeyMoment 增可选 spellId;defensive join panic)
- Create: `packages/desktop/src/renderer/src/report/derive/ccChainDash.ts` + `components/CCChainPanel.tsx`
- Modify: `MatchReport.tsx`(面板挂载 :501-502 之后)+ `styles.css`
- Test: 对应各文件

**Interfaces:** Consumes 无新;ccChainDash 输出 `{rows: Array<{targetName; targetSpec; chainLen: number; totalCcSeconds: number; wasted: boolean; apps: IOutgoingCCApplication[]}>}`,EMPTY 兜底。

- [ ] **Step 1**: 失败测试:panic join(同 spellId 同秒 → 徽标;异秒不 join);cheaper 替代文案出现在 unused 行;CC 链面板行/展开/空态保壳/25% 档标红;range 过滤只影响展示行。
- [ ] **Step 2**: 确认红。
- [ ] **Step 3**: 实现(全套 Kick 面板惯例)。
- [ ] **Step 4**: 全绿 + typecheck + eslint。
- [ ] **Step 5**: Commit `feat(desktop): 恐慌防御/更省替代注记 + 敌方 CC 链面板(#10 T5)`。

### Task 6: 收尾 —— presubmit、push、基线、收账

**Files:**

- Modify: `docs/BACKLOG.md`(§10 打 ✅ 收账)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png`(CI 生成人审)

- [ ] **Step 1**: `npm run presubmit` 全绿(红了如实报告不自修)。
- [ ] **Step 2**: BACKLOG §10 收账 commit;fetch/rebase;push;按 headSha 盯 test.yml。
- [ ] **Step 3**: frontend-qa 预期红(report-battle/synth/window/ai + 头部行波及的 report-replay/events)→ visual-baseline.yml 重生成 → cmp → 逐张人审(差异必须可归因:泳道/账本行/CC 面板/轴新点/头部行/指标格)→ 提交推送盯绿;不可解释差异即停。
- [ ] **Step 4**: 汇报:八项逐条落点 + 真机点验清单。

## Self-Review 记录

1. Spec 覆盖:spec §1→T2;§2→T3;§3→T3;§4→T4;§5→T4;§6→T5;§7→T5;§8→T1;边界节无任务(正确)。
2. 占位符:各 Step 1 均写明断言目标与构造方法;接口签名在「已核实接口」与任务 Interfaces 中逐字给出。
3. 类型一致:`IMatchArcPhase` T1 定义 T4 消费;`deriveBurstLedger` 新返回形状 T3 内闭环;KeyMoment.spellId T5 增改与 T3/T4 的新 kind 不冲突(可选字段)。
