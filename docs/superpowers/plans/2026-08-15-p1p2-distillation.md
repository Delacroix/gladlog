# P1/P2 蒸馏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四个新候选类型(missed-sync-window / unsynced-burst / cd-hoarded / cd-spent-idle)落进产品候选层,经语料标定 + **每类型独立 A/B** 后按结果逐类型上线;附约束预算审计臂。

**Architecture:** 检测器进 `candidateFindings.ts`(与 22 既有 builder 同构,消费既有谓词);威胁谓词单源新 export;特性开关照 `dispelFeatureFlags.ts` 先例;评估走既有 eval 基建(corpus/responder=sonnet/确定性指标优先)。

**Tech Stack:** 既有(analysis 谓词族、eval corpus 工具、vitest)。

**Spec:** `docs/superpowers/specs/2026-08-15-p1p2-distillation-design.md`(判据红线节为硬约束)

## Global Constraints

- **判据红线(spec)逐条配测试**:同步无血线门(B8)/威胁门生效(B6)/cost_norm 附注/被控判定走 shim+CC 感知赦免/事实-建议分离措辞。
- 谓词单源:敌治疗硬控窗提取、威胁谓词各一处 export;谓词索引双语登记;不重写任何既有采样。
- eval 批量 responder/judge 固定 **sonnet**(既定偏好);判官只作参考,主判据确定性指标。
- 特性开关默认全关;A/B 各臂只翻开关。
- 长扫描/评估分批前台,批间落盘,timeout 550000/批;**子代理不得等待自己的后台命令**。
- commit 直提 main 每 task 一个,push 后验证输出;全量门 `npm test --workspaces && npm run typecheck && npx eslint . --quiet`。
- 修复给前后数字;标定与 A/B 报告落 `$GLADLOG_EVAL_HOME/reports/`。

## 数据契约(全计划共用)

```ts
// packages/analysis/src/utils/threatAssessment.ts(Task 1)
export function threatActiveAt(enemies: ICombatUnit[], owner側承伤源, tSeconds: number): boolean;
// 实现:敌方进攻大 CD 光环活跃(extractMajorCooldowns 的 Offensive 类 casts 推窗)∨ 己方承伤速率超阈
export function matchThreatLevel(...): "low" | "med" | "high"; // 全场承压峰值分级
export const THREAT_DAMAGE_RATE_PCT_PER_S = <标定占位,Task 5 定稿>;

// packages/analysis/src/analysis/candidateFindings.ts(Task 2/3)
export function missedSyncWindowEvents(...): CandidateEvent[];  // type: "missed-sync-window"
export function unsyncedBurstEvents(...): CandidateEvent[];     // type: "unsynced-burst"
export function cdHoardedEvents(...): CandidateEvent[];         // type: "cd-hoarded"
export function cdSpentIdleEvents(...): CandidateEvent[];       // type: "cd-spent-idle"

// packages/analysis/src/data/candidateTypeFlags.ts(Task 4)
export const CANDIDATE_TYPE_FLAGS: Record<"missedSyncWindow"|"unsyncedBurst"|"cdHoarded"|"cdSpentIdle", boolean>; // 默认全 false
```

敌治疗硬控窗提取:复用 `analyzeOutgoingCCChains(friends, enemies)` 的 applications(目标=敌治疗 by isHealerSpec)——不新写 CC 采样。进攻大 CD 集合:`extractMajorCooldowns` 的 `isThroughput`/Offensive 标签既有判定。

---

### Task 1: 威胁谓词

**Files:** Create `packages/analysis/src/utils/threatAssessment.ts`;Test `packages/analysis/test/threatAssessment.test.ts`;Modify `docs/predicate-index.md`+`.zh-CN.md`+`packages/eval/test/predicateIndex.test.ts`(登记)。

- [ ] Step 1: 先读 `counterfactual.ts`/`mitigationData` 的既有压力判定,能复用的复用并在文件头注明;失败测试(合成 fixture:敌方翅膀光环活跃时刻 → true;全静默时刻 → false;matchThreatLevel 三档各一例)。
- [ ] Step 2: RED → 实现 → GREEN;谓词索引双语加行 + predicateIndex 测试登记跑绿。
- [ ] Step 3: analysis 套件 + typecheck 绿;commit `feat(analysis): 威胁谓词 threatActiveAt/matchThreatLevel(P2 门,单源)` + trailers;push 验证。

### Task 2: P1 双检测器(missed-sync-window + unsyncedBurst)

**Files:** Modify `packages/analysis/src/analysis/candidateFindings.ts`;Test `packages/analysis/test/candidateFindings.test.ts` 扩展。

- [ ] Step 1: 共享的「敌治疗硬控窗」提取 helper(文件内私有,消费 analyzeOutgoingCCChains 输出过滤 isHealerSpec 目标);失败测试:①合成 60ab-7:19 形态 fixture(敌治疗被睡 8s + 我方锤 ready + 无起爆)→ missed-sync-window 1 条,facts 含被控技能/时长/ready 清单/窗内敌方最低血;②**红线测试:敌方全员满血同 fixture → 仍出候选**(无血线门,B8);③unsynced-burst:爆发施放 + 窗内敌治疗零硬控 → 1 条;有硬控 → 0 条。
- [ ] Step 2: RED → 实现(id 形态/fmt/严重度照 healingGapEvents 等既有 builder 惯例;措辞事实-建议分离进 facts 设计)→ GREEN;既有测试全绿。
- [ ] Step 3: commit `feat(analysis): P1 候选检测器——missed-sync-window/unsynced-burst(同步为门,无血线门)` + trailers;push 验证。

### Task 3: P2 双检测器(cdHoarded + cdSpentIdle)

**Files:** 同 Task 2 结构。

- [ ] Step 1: 失败测试:①cd-hoarded 合成 60ab-AW 形态(6:20 ready、6:30 己方 34%、6:54 才施放)→ 1 条 facts 含晚 N 秒/危机时刻;转好后立刻按 → 0 条;②**红线:642 命中时 facts 带 costNorm**(costNormPhrase 管线);③cd-spent-idle 合成圣佑盲发形态(施放时刻 threatActiveAt=false)→ 1 条;**红线:matchThreatLevel="low" 整场 → 0 条**(B6 门);威胁活跃时施放 → 0 条。
- [ ] Step 2: RED → 实现(阈值常量集中定义,标 `<Task 5 标定定稿>` 注释)→ GREEN。
- [ ] Step 3: commit `feat(analysis): P2 候选检测器——cd-hoarded/cd-spent-idle(威胁分级门+costNorm 联动)` + trailers;push 验证。

### Task 4: 特性开关 + 菜单装配 + prompt 图例

**Files:** Create `packages/analysis/src/data/candidateTypeFlags.ts`;Modify `candidateFindings.ts` 菜单装配处(先读 extractCandidateFindings 的装配结构)、`buildFindingsPrompt.ts`(四条图例,flag-gated 渲染);Test 各扩展。

- [ ] Step 1: 失败测试:开关全关 → 四类型候选不进菜单、图例不渲染;单开一个 → 只该类型进。
- [ ] Step 2: RED → 实现 → GREEN;全量门三绿(开关全关=产品零变化,现有测试必须原样绿)。
- [ ] Step 3: commit `feat(analysis): 候选类型特性开关——四新类型默认关,A/B 逐类启用` + trailers;push 验证。

### Task 5: 语料标定

**Files:** Create `packages/eval/src/explore/candidateCalibration.ts` + `packages/eval/scripts/candidateCalibrationScan.ts`(薄壳);报告落 `$GLADLOG_EVAL_HOME/reports/p1p2-calibration.md`。

- [ ] Step 1: 扫描逻辑(逐场装载 legacy → 四检测器直调(绕开开关)→ 计数)+ fixture 测试;n≥500 场分批前台跑。
- [ ] Step 2: 输出:每类型发生率/场均条数/阈值敏感性表(cd-hoarded 的 H∈{10,20,30,45}s、危机血线∈{35,45}%、威胁承伤阈三档——每格一个场均数);目标区间=场均 0.5-2 条(参照既有类型量级);阈值定稿写回 Task 1/3 的常量 + 常量测试更新;**双向误差注**每阈值一句。
- [ ] Step 3: commit(标定数字进 message)+ 报告;push 验证。控制器将阈值表呈用户过目(非阻塞——用户可事后否决)。

### Task 6: P1 两类型独立 A/B

**Files:** 评估脚本按 `/eval-ab` 既有流程组织(先读 docs/commands/eval-ab.md);报告 `$GLADLOG_EVAL_HOME/reports/p1p2-ab-p1.md`。

- [ ] Step 1: 评估集:从 Task 5 扫描取该类型**有触发**的对局各 n≥30(不足全取);两组配置:{missedSyncWindow 单开} vs 全关、{unsyncedBurst 单开} vs 全关。
- [ ] Step 2: 每组:构建两臂 prompts → responder(sonnet)→ 确定性主指标:①新类型候选采纳率(finding.eventIds 命中该类型候选 id);②被采纳 finding 的门规审计通过率;③filler 率变化;判官(sonnet)七维作参考注明噪声底。分批前台。
- [ ] Step 3: 报告逐类型结论(采纳率/审计率/filler 前后数字);commit + push 验证。
- [ ] Step 4: **PAUSE:P1 两类型结果呈用户**(开/不开各自定)。

### Task 7: P2 两类型独立 A/B

同 Task 6 结构,配置 {cdHoarded} / {cdSpentIdle};报告 `p1p2-ab-p2.md`;**PAUSE:结果呈用户**。

### Task 8: 约束预算审计臂

**Files:** 报告 `$GLADLOG_EVAL_HOME/reports/constraint-budget-audit.md`。

- [ ] Step 1: 盘点输出空间类约束清单(候选门/守护注/压频闸/严重度限制等,每条注当年租金收据与机制风险评级)——文档节进报告;控制器选 2-3 个**低机制风险**候选放松项(如话题压频闸、severity 上限类;绝不放松机制正确性门如驱散能力门),放松方式=配置/最小 patch(不合入 main,评估臂内临时)。
- [ ] Step 2: A/B:基线 vs 放松臂,n≥40 场;判据:验真新发现率(金标集口径:属实+此前管线未覆盖的具体发现计数,确定性近似=新增非重复 finding 数×审计通过)vs 机制错误率(门规 hardFailures + causalLint 命中);判官参考。
- [ ] Step 3: 帕累托数据表 + 逐约束结论呈报;commit(报告)+ push;**PAUSE:数据呈用户裁决**(收/放各约束)。

### Task 9: 按裁决收尾

- [ ] 用户裁决后:胜出类型开关翻 true(带 A/B 数字进 commit);败类型留关注明;约束裁决落地(若用户决定放松某门,走正式修改+测试);inventory/BACKLOG/谓词索引同步;全量门三绿;push 验证。

## 完成定义

四类型各有独立 A/B 数字与用户终批;标定报告在案;约束审计帕累托表在案且用户已裁;全部红线测试常绿。
