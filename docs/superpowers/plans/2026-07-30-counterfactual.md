# Damage Reduction Counterfactual 17a+17b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 17b: Damage reduction audit in death window (A already used/B external unused/narrow gate available but unpressed, three tiers predicate single source, only "obviously survivable" opens) dual-sided output (death recap card + [DEATH] prompt line); 17a: External `Unnecessary` sixth tier → `questionable-external` candidate + MISTAKE_RULES.

**Architecture:** analysis new module `counterfactual.ts` carries all arithmetic and three tiers predicates; B's two prerequisite fixes (deathOutcome external table 7→14 convergence, deathRecap zoneId two-point fix) go first; 17a adds tier in `annotateDefensiveTimings` (corpus validation prerequisite); desktop/prompt consume the same arithmetic on both sides.

**Tech Stack:** TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-counterfactual-design.md`
**Working Directory:** Always worktree `/Users/mingjianliu/code/gladlog-wt-17` (main; dependencies installed). Main checkout `/Users/mingjianliu/code/gladlog` is occupied by user, **absolutely do not touch**.

## Global Constraints

- 直接 commit 到 worktree main,最终 push;复合命令绝不裸 `cd`;门禁链绝不加管道;push 前 `npm run presubmit`;测试 workspace 口径。
- **三档谓词单处 export**,与量化报告同口径(明显能活 = 省下量 > 净掉血 + 15% maxHp;边缘 = (0.5×净掉血, 明显线];仍死 = 其余);窗口 = 死亡前 10s;净掉血 = 窗口起点绝对 HP;B/窄门**仅「明显能活」开口**。
- 反推公式:挡掉量 = 观测伤害 × pct/(100−pct);免疫(pct=100)不反推;机制类/表外如实标注不编数字;positional(黑暗)跳过;多条目独立口径不建模叠加。
- HP 采样一律 `HP_SAMPLE_RADIUS_MS`/`getUnitHpAtTimestamp` 单源(cooldowns.ts:348 注释明令禁止第二个半径常量)。
- 17a 判据全用现成谓词;**语料实证前置**(发生率 ≈0 或 >50% 即停下报告);新候选必须在 MISTAKE_RULES/IGNORED 表态(防腐测试强制)。
- prompt 新行数字先 fmt 到渲染网格(门规谓词即规范);措辞可能性框架,与 buildMatchContext.ts:966 既有「counterfactual unknown」免责行不矛盾(那是 availableWindows 压力相关性的免责,本功能的行**有数字**,措辞不得复用「unknown」字样)。

**计划期已核实的事实(executor 不必复查,直接引用)**:

- zoneId bug 实为两点:`deathRecap.ts:61` 读不存在的 `legacy.zoneId`(真值在 `legacy.startInfo.zoneId`,convert.ts:574)→ combatLike.startInfo.zoneId 恒 "";`deathRecap.ts:72` 把 `legacy` 直传 `buildDeathOutcomeSummary`,而其签名(deathOutcomeAnalysis.ts:292)读**顶层** `combat.zoneId` → 恒 undefined → LoS 门(:383)在 desktop 路径永不生效。analysis 侧 buildMatchContext 的调用是对的(传了顶层 zoneId),只有 desktop 路径断。
- `annotateDefensiveTimings` 的 Reactive 尖峰判定(cooldowns.ts:1010-1041)看**施法者**自己的 damageIn(代码注释自认:External 看的是骑士不是受益人)——17a 的「无伤害尖峰」条件必须查**受益目标**(`cast.targetName` → combat.units 反查)的 damageIn,目标不可解析时回退施法者并在 timingContext 注明。
- 第六档对 `TimingCounts`/spec baselines(benchmark/metrics.ts:29-35、specBaselines.ts:15-21)的波及:baselines 是离线预生成五档口径,不重生成——**metrics.ts 把 `Unnecessary` 计入 `unknown` 桶**(一行 + 注释),其余消费者(prompt/criticalMoments 的 `!== "Unknown"` 判据)会自动打印新档,无需改。
- `buildAuraIntervals` 有两个同名实现:**用公开导出的那个**(`utils/auraIntervals.ts:57`,签名 `(unit, {startTime,endTime}) → IAuraInterval[]`,相对秒、全量 aura 自行过滤白名单);burstLedger 用的私有版(utils.ts:62,绝对 ms)勿混。
- `EXTERNAL_DEFENSIVE_SPELLS` 7 条表在 deathOutcomeAnalysis.ts:69-120(条目带 spellName/cooldownSeconds 等元数据);`IMissedExternal` 字段 :128-134;`wasLockedOutThroughWindow`(:260,LETHAL_WINDOW_SECONDS=5/MIN_FREE_GAP_SECONDS=1)。
- 候选注册三件套先例:`externalUnusedEvents`(candidateFindings.ts:863-921,含 id 格式/facts/gate)、MISTAKE_RULES 条目形状(mistakes.ts:89-94)、防腐测试(test/report.mistakes.test.tsx:79-102);新类型不入 `OFFENSIVE_CANDIDATE_TYPES` 即默认路由 survival;category 复用现有 8 类(用 "cooldowns"),findingCategories 无需改。
- [DEATH] 块附加行先例:matchTimelineSections.ts:596-632 的 HP trajectory / Top damage 行(无独立时间戳、缩进对齐、同一 addEntry);`DeathRecap` 接口(deathRecap.ts:26-41)与卡片段落插入点(DeathRecapCard.tsx:108-131 判词段之后、table 之前)。
- 语料扫描骨架:`packages/eval/scripts/newCandidateScan.ts`(arenacoach 第一批同款:owner 判定镜像 analysisInput、applicable 分母、SAMPLE_CAP=5 抽检、rate 表)。

---

### Task 1: analysis — counterfactual.ts(三档谓词 + 三形态算术)

**Files:**

- Create: `packages/analysis/src/utils/counterfactual.ts`
- Modify: `packages/analysis/src/index.ts`(导出)
- Test: `packages/analysis/test/counterfactual.test.ts`(新)

**Interfaces:**

- Consumes: `MITIGATION_TABLE/IMitigationEntry`、`buildAuraIntervals`(utils/auraIntervals 公开版)、`cdAvailableAt`、`wasLockedOutThroughWindow`、`getUnitHpAtTimestamp`/`HP_SAMPLE_RADIUS_MS`、`spellIdLists`、`IMissedExternal`。
- Produces(Task 3/4 消费):

```ts
export const COUNTERFACTUAL_WINDOW_S = 10;
export const DECISIVE_MARGIN_PCT = 15; // 明显线余量:15% maxHp
export const MARGINAL_FLOOR_RATIO = 0.5; // 边缘档下界:0.5×净掉血

export type CounterfactualTier = "decisive" | "marginal" | "fatal";
/** 三档谓词单源(量化报告同口径)。savedAmount/netDamage/maxHp 同单位(绝对 HP 值)。 */
export function counterfactualTier(
  savedAmount: number,
  netDamage: number,
  maxHp: number,
): CounterfactualTier;

export interface IMitigationAuditRow {
  spellId: string;
  spellName: string;
  kind: "arith" | "immunity" | "mechanic";
  /** 激活区间∩死亡窗的秒数(一位小数)。 */
  activeOverlapS: number;
  /** kind=arith:挡掉量(绝对值)与占 maxHp 百分比。 */
  blockedAmount?: number;
  blockedPctMaxHp?: number;
  /** kind=immunity:免疫覆盖期内观测承伤(应≈0,如实报)。 */
  damageTakenDuringImmunity?: number;
}
/** A 形态:死亡窗内死者身上激活的白名单减伤逐条核算(独立口径)。 */
export function computeMitigationAudit(
  victim: ICombatUnit,
  combat: {
    startTime: number;
    endTime: number;
    units: Record<string, ICombatUnit>;
  },
  deathS: number,
): {
  rows: IMitigationAuditRow[];
  netDamage: number | null;
  maxHp: number | null;
};

export interface ICounterfactualHit {
  spellId: string;
  spellName: string;
  source: "unused-self" | "missed-external";
  casterName?: string; // missed-external 时
  savedAmount: number;
  savedPctMaxHp: number;
  tier: CounterfactualTier;
}
/** 窄门:自己可用未按(表内非 positional;CC 死锁返回空)。只返回 decisive。 */
export function computeUnusedSelfCounterfactuals(
  victim: ICombatUnit,
  victimCds: IMajorCooldownInfo[],
  victimCcSummary: Pick<IPlayerCCTrinketSummary, "playerName" | "ccInstances">,
  combat: { startTime: number; units: Record<string, ICombatUnit> },
  deathS: number,
): ICounterfactualHit[];

/** B 形态:missedExternals × 表 → 三档,只返回 decisive。 */
export function computeMissedExternalCounterfactuals(
  missedExternals: IMissedExternal[],
  victim: ICombatUnit,
  combat: { startTime: number },
  deathS: number,
): ICounterfactualHit[];
```

- [ ] **Step 1: 写失败测试**

`packages/analysis/test/counterfactual.test.ts`(合成 unit 构造抄 `deepDive.test.ts` 的 mkUnit 样式:damageIn 带 `{logLine:{timestamp}, effectiveAmount, spellSchoolId}`、auraEvents、advancedActions):

```ts
import { describe, expect, test } from "vitest";
import {
  COUNTERFACTUAL_WINDOW_S,
  DECISIVE_MARGIN_PCT,
  counterfactualTier,
  computeMitigationAudit,
  computeUnusedSelfCounterfactuals,
  computeMissedExternalCounterfactuals,
} from "../src/utils/counterfactual";

describe("counterfactualTier(三档谓词,量化报告同口径)", () => {
  const maxHp = 1000_000;
  test("decisive:saved > net + 15% maxHp", () => {
    expect(counterfactualTier(700_001 - 1 + 150_001, 700_000, maxHp)).toBe(
      "decisive",
    );
    expect(counterfactualTier(850_001, 700_000, maxHp)).toBe("decisive");
  });
  test("边界:恰等于明显线 → marginal(> 是严格的)", () => {
    expect(counterfactualTier(850_000, 700_000, maxHp)).toBe("marginal");
  });
  test("marginal 下界:saved ≤ 0.5×net → fatal", () => {
    expect(counterfactualTier(350_000, 700_000, maxHp)).toBe("fatal");
    expect(counterfactualTier(350_001, 700_000, maxHp)).toBe("marginal");
  });
});

describe("computeMitigationAudit(A 形态)", () => {
  // 合成:死亡 t=60s,窗口 [50,60];Barkskin(22812, 20%, 0x7f)激活 [52,58];
  // 窗内 damageIn:52.5s 100k(0x1 物理)、55s 200k(0x20 暗影)、59s 300k(0x4 火,在 aura 区间外)
  test("arith:反推只吃激活区间∩窗口∩schoolMask 命中的观测伤害", () => {
    const { rows } = computeMitigationAudit(victim, combat, 60);
    const bark = rows.find((r) => r.spellId === "22812")!;
    expect(bark.kind).toBe("arith");
    // (100k+200k) × 20/(100-20) = 75k;59s 那笔在区间外不计
    expect(bark.blockedAmount).toBe(75_000);
    expect(bark.activeOverlapS).toBe(6);
  });
  test("immunity(pct=100):不反推,报覆盖秒数与期内观测承伤", () => {
    // Divine Shield 642 激活 [54,56],期内观测 0
    const ds = rowsWithImmunity.find((r) => r.spellId === "642")!;
    expect(ds.kind).toBe("immunity");
    expect(ds.blockedAmount).toBeUndefined();
    expect(ds.damageTakenDuringImmunity).toBe(0);
  });
  test("机制类(白名单内但表外,如 6940)→ kind=mechanic 无数字", () => {
    const m = rowsWithMechanic.find((r) => r.spellId === "6940")!;
    expect(m.kind).toBe("mechanic");
    expect(m.blockedAmount).toBeUndefined();
  });
  test("positional(196718)跳过不出行", () => {
    expect(rowsWithDarkness.some((r) => r.spellId === "196718")).toBe(false);
  });
  test("netDamage=窗口起点绝对 HP;取不到 → null 且 rows 照出(挡掉量不依赖 netDamage)", () => {});
  test("schoolMask 过滤:0x7e 仅魔法条目不吃 0x1 物理伤害", () => {});
});

describe("computeUnusedSelfCounterfactuals(窄门)", () => {
  test("CC 死锁(wasLockedOutThroughWindow)→ 空数组", () => {});
  test("decisive 才返回;marginal/fatal 静默", () => {});
  test("positional 候选跳过", () => {});
});

describe("computeMissedExternalCounterfactuals(B)", () => {
  test("表内外置(如 33206 40%)→ saved = 窗内命中学派伤害×40%,decisive 才返回", () => {});
  test("表外外置(如 633 圣疗)跳过", () => {});
});
```

(注释体用例由实现者按首例完整样式补全,fixture 构造在文件内共享。)

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- counterfactual`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`counterfactual.ts` 要点(完整实现由实现者按签名与测试写,以下为必守细节):

- 白名单 = `bigDefensiveSpellIds ∪ externalDefensiveSpellIds`(单源派生);
- A:`buildAuraIntervals(victim, combat)`(公开版,相对秒)过滤白名单 id → 每条与窗口 `[deathS-10, deathS]` 求交;`MITIGATION_TABLE[spellId]` 命中且非 positional → arith/immunity 按 pct 分;表外/`NO_MITIGATION_IDS` → mechanic;positional → 跳过;
- 学派过滤:`Number.parseInt(d.spellSchoolId ?? "0x0", 16) & schoolMask`,伤害取 `Math.abs(effectiveAmount)`,时间过滤用 `d.logLine.timestamp` 与激活区间∩窗口的重叠(区间为相对秒,换算 `combat.startTime`);
- 反推:`blocked = observed × pct / (100 - pct)`(整数 round);immunity 分支绝不进该公式;
- netDamage/maxHp:`getUnitHpAtTimestamp(victim, startTime + (deathS-10)*1000, HP_SAMPLE_RADIUS_MS)` 与死亡时刻 maxHp(同函数返回的是 pct——**注意**:该函数返回百分比,绝对值需从 `advancedActions` 采样对 `advancedActorCurrentHp/advancedActorMaxHp` 直采;写一个模块内 helper `absHpAt(unit, tMs)` 返回 `{hp, maxHp} | null`,采样半径同 `HP_SAMPLE_RADIUS_MS`,别发明新半径);
- 窄门:候选 = victimCds 里 `cdAvailableAt(cd, deathS)` 且表内非 positional;saved = 窗内命中学派伤害 × pct%(未激活,不反推,直接打折口径——与量化报告一致);`wasLockedOutThroughWindow(ccSummary, deathS)` 真则整体空;`counterfactualTier` 过滤只留 decisive;
- B:同窄门打折口径,per missedExternal;表外跳过。

`index.ts` 导出全部新符号。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis` + `npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis): counterfactual 三档谓词单源 + 三形态减伤算术(17b 核心)"
```

---

### Task 2: analysis+desktop — B 前置修复(外置表收敛 + zoneId 双点)

**Files:**

- Modify: `packages/analysis/src/utils/deathOutcomeAnalysis.ts:69-120`(EXTERNAL_DEFENSIVE_SPELLS 7→14)
- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts:58-72`(zoneId 双点)
- Test: `packages/analysis/test/deathOutcome.whitelist.test.ts`(新)+ 既有 deathRecap/deathOutcome 测试回归

**Interfaces:**

- Produces: `EXTERNAL_DEFENSIVE_SPELLS` 键集 === `externalDefensiveSpellIds`(14 条,防漂移测试);desktop 路径 LoS 门生效。

- [ ] **Step 1: 写失败的防漂移测试**

```ts
import { describe, expect, test } from "vitest";
import { EXTERNAL_DEFENSIVE_SPELLS } from "../src/utils/deathOutcomeAnalysis";
import spellIdLists from "../src/data/spellIdLists";

describe("deathOutcome 外置表与主白名单收敛(串联腐烂修复)", () => {
  test("键集恒等于 externalDefensiveSpellIds(14 条)", () => {
    expect(Object.keys(EXTERNAL_DEFENSIVE_SPELLS).sort()).toEqual(
      [...spellIdLists.externalDefensiveSpellIds].sort(),
    );
  });
});
```

(若 `EXTERNAL_DEFENSIVE_SPELLS` 未导出,导出之;其为数组则断言 spellId 集合。)

- [ ] **Step 2: 跑测确认失败**(7≠14)

- [ ] **Step 3: 实现**

- 补 7 条缺失条目的元数据(spellName/cooldownSeconds 等,字段形状照既有 7 条;CD 值从 `spellEffectData` 查或游戏事实注明来源——**元数据值逐条注依据,不许拍**;新条目里 `633` 圣疗已在旧表,新增的是 `47788` 之外缺的那 7 条——以差集为准);
- `deathRecap.ts:61` → `startInfo: { zoneId: (legacy.startInfo as { zoneId?: string } | undefined)?.zoneId ?? "" }`;`:72` → `buildDeathOutcomeSummary({ startTime: legacy.startTime, zoneId: (legacy.startInfo as { zoneId?: string } | undefined)?.zoneId }, players, ccSummaries)`;
- **语料前后数字(修复必须给)**:一次性脚本(/tmp,跑完删)全库固定种子 ≥60 场:missedExternals 总条数在(旧 7 条表 × LoS 断)vs(新 14 条表 × LoS 通)两口径下的对比,并单独拆出两个因素各自的贡献(表扩张 +X 条;LoS 生效 −Y 条)。数字进 commit message 与报告。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis` + `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: 全绿(deathRecap 既有测试是 zoneId 修复的回归锚;若有测试固化了旧的 LoS-断行为需如实修正期望并逐个列出)。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "fix(analysis,desktop): deathOutcome 外置表 7→14 收敛 + deathRecap zoneId 双点修复(B 前置,前后数字见 body)"
```

---

### Task 3: analysis — 17a Unnecessary 档 + questionable-external 候选(语料实证前置)

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts`(DefensiveTimingLabel + annotateDefensiveTimings)
- Modify: `packages/analysis/src/benchmark/metrics.ts:230-236`(Unnecessary → unknown 桶)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts`(新候选)
- Modify: `packages/desktop/src/renderer/src/report/derive/mistakes.ts`(MISTAKE_RULES 条目)
- Test: `packages/analysis/test/ported/cooldowns.test.ts`(追加)、`packages/analysis/test/candidateFindings 相关`(追加)

**Interfaces:**

- Produces: `DefensiveTimingLabel` 加 `"Unnecessary"`;候选 `type: "questionable-external"`(id `questionable-external:${casterId}:${Math.round(t)}`,facts:t/spell/caster/target/targetHp/nearestBurstGapS,category 归 "cooldowns",不入 OFFENSIVE_CANDIDATE_TYPES=默认 survival 路由);MISTAKE_RULES 条目 `{ type: "questionable-external", label: "无压力窗口交出外减", severity: "average", source: "candidate" }`。

- [ ] **Step 0(前置门):语料实证发生率**

一次性脚本(`newCandidateScan.ts` 骨架,/tmp 或 eval/scripts 临时文件跑完删):全库固定种子,对外置 14 条的每次施放试判 Unnecessary 三条件(阈值 targetHp ≥80),输出:applicable 分母(有外置施放的场)、命中率、SAMPLE_CAP=5 抽检样本(人查合理性)。**发生率 ≈0(<0.5%)或 >50% → 停,报告 BLOCKED 等阈值裁决**;5%-30% 区间为健康预期。数字与抽检进报告。

- [ ] **Step 1: 写失败测试**

`cooldowns.test.ts` 追加(fixture 照既有五档用例):

```ts
it("Unnecessary:无爆发对齐 + 目标无尖峰 + 目标高血 → 第六档", () => {
  // 外置施放 t=30,无任何 burst window/单敌 CD 在 ±(PRE_WALL/LATE) 内;
  // 受益目标 damageIn 在 [27,33] 合计 < 50k;目标 HP 采样 92%
  expect(cast.timingLabel).toBe("Unnecessary");
  expect(cast.timingContext).toContain("no pressure");
});
it("三条件各自独立否决:有尖峰→不判;目标 78% 血→不判;窗口边缘(PRE_WALL 内)→仍是 Early", () => {});
it("目标不可解析 → 尖峰判定回退施法者 damageIn 且 context 注明", () => {});
it("非外置(自保墙)不进 Unnecessary 判定(仍走原五档)", () => {});
```

candidateFindings 测试:questionable-external 事件产出(facts 齐)+ mistakes 防腐测试自动覆盖注册。

- [ ] **Step 2: 跑测确认失败**

- [ ] **Step 3: 实现**

- `DefensiveTimingLabel` 加 `"Unnecessary"`;`annotateDefensiveTimings` 在三级 fallback 判 `Unknown` 之前插入第六档判定,**仅当** `EXTERNAL_DEFENSIVE_IDS.has(cd.spellId)`:
  - 无爆发对齐:能走到 fallback 本身即无对齐(阶段 1/2 未命中);
  - 目标尖峰:`cast.targetName` → `combat.units` 反查目标 unit(按 name 匹配),对**目标**的 damageIn 做与 Reactive 同式的 before/after 窗口检查(同 `TIMING_DAMAGE_WINDOW_S`,判据:before 与 after **都** < 50_000 即无尖峰);目标不可解析 → 用施法者 damageIn 回退并在 context 注明 "(caster-side fallback)";
  - 目标高血:`cast.targetHpPct !== undefined && cast.targetHpPct >= UNNECESSARY_TARGET_HP_PCT`(常量 export,取 Step 0 实证后的值,先验 80;targetHpPct 缺失 → 不判,落 Unknown——缺数据不定罪);
  - `timingContext`:三条依据一句话(含目标名/HP/最近爆发窗距离);
- `metrics.ts` TimingCounts 归桶:`case "Unnecessary": counts.unknown++`(注释:spec baselines 离线五档口径,不重生成);
- `candidateFindings`:`questionableExternalEvents(...)` 消费 annotate 后的 casts(`timingLabel === "Unnecessary"`),接线进 `extractCandidateFindings`(先例:external-unused 的接线位);facts 数值全 `fmt`;
- `MISTAKE_RULES` 条目如 Interfaces 所写。

- [ ] **Step 4: 跑测确认通过**

Run: analysis + desktop 全量 + typecheck(desktop 的 mistakes 防腐测试必须绿)。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis,desktop): 17a Unnecessary 第六档 + questionable-external 候选/MISTAKE 双注册(发生率实证见报告)"
```

---

### Task 4: 输出面 — 死亡回顾卡 + [DEATH] prompt 行

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/deathRecap.ts`(DeathRecap 加字段)
- Modify: `packages/desktop/src/renderer/src/report/components/DeathRecapCard.tsx`(新段落)
- Modify: `packages/analysis/src/context/matchTimelineSections.ts`(emitFriendlyDeathEntries 附加行)
- Modify: `packages/analysis/src/context/buildMatchContext.ts`(给 emit 传所需件,若缺)
- Test: `packages/desktop/test/deathRecap 相关`(追加)、`packages/analysis/test/context.timelineSections.test.ts`(追加)

**Interfaces:**

- Consumes: Task 1 全部导出、Task 2 修复后的 missedExternals。
- Produces:`DeathRecap` 加 `mitigationAudit: IMitigationAuditRow[]` 与 `counterfactuals: ICounterfactualHit[]`(仅 decisive,B+窄门合并)。

- [ ] **Step 1: 写失败测试**

- desktop:合成含 Barkskin 激活死亡窗的 source → `deriveDeathRecaps` 返回的 recap 带 `mitigationAudit`(blockedAmount 断言具体数);卡片渲染出「减伤核算」段(`data-testid="recap-mitigation"`)与 decisive 行(`data-testid="recap-counterfactual"`,无 decisive 时不渲染该段);
- analysis:timelineSections 测试断言 [DEATH] 块出现附加行(缩进先例格式):
  - `               Mitigation audit: Barkskin blocked ~75k (≈8% max HP) over 6.0s active`
  - decisive 时:`               Counterfactual (arithmetic, single-factor): Pain Suppression from <caster> would have cut window damage below lethal (margin >15% max HP)`
  - **无 decisive、无激活减伤时两行都不出现**(空即无行,不出占位)。

- [ ] **Step 2: 跑测确认失败**

- [ ] **Step 3: 实现**

- `deathRecap.ts`:对每个 recap 调 Task 1 三函数(victimCds 从既有 `extractMajorCooldowns` 结果取;ccSummary 既有;missedExternals 用 Task 2 修复后的 outcome),填两个新字段;
- `DeathRecapCard.tsx`:判词段之后插「减伤核算」段(每行:技能名 + 挡了 X(≈N% maxHp)/ 免疫覆盖 Xs / 机制特殊不参与算术)与 decisive 反事实行(可能性措辞:「若 <技能> 覆盖此窗,该段伤害约降至致死线下(余量 >15% 最大血量)——算术口径,单因素」);
- `matchTimelineSections.ts`:`emitFriendlyDeathEntries` 参数加 `counterfactualOf?: (victimName: string) => { auditLines: string[]; decisiveLines: string[] }`(可选,缺省不出行——老调用零破坏);`buildMatchContext` 接线传实现(调 Task 1 函数,数字先 `fmt`/`fmtTime` 渲染网格);行文措辞英文与卡片中文各自成文但**数字同源**(同一次函数调用的返回值);
- causalLint 兼容自查:行文避免 "led to/caused/resulted in"(用 "would have cut ... below lethal" 的假设式)。

- [ ] **Step 4: 跑测确认通过 + run-ui 真眼**

analysis + desktop 全量 + typecheck + eslint;dev:ui 找带死亡的 fixture 看死亡回顾卡新段落渲染(控制器统一亦可,实现者至少截图)。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-17 add packages/analysis packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-17 commit -m "feat(analysis,desktop): 减伤核算/反事实双面输出——死亡回顾卡 + [DEATH] prompt 行(同源算术)"
```

---

### Task 5: 门禁、push、CI、基线、收账

**Files:**

- Modify: `docs/BACKLOG.md`(#17.1/#17.3 注记)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png`(死亡回顾卡若入镜,CI 生成人审)

- [ ] **Step 1**: `(cd /Users/mingjianliu/code/gladlog-wt-17 && npm run presubmit)` 全绿(红了如实报告不自修)。
- [ ] **Step 2**: BACKLOG:#17 子件 1 加 ✅(questionable-external 落地 + 发生率数字);子件 3 加注记(A/B/窄门落地,17c 未做;spec 路径);commit + push(远端有新提交则 fetch+rebase+重跑 presubmit)。
- [ ] **Step 3**: 按 headSha 盯 CI;frontend-qa 若因死亡回顾卡基线红 → 预期,走 Step 4;否则红即异常如实报告。
- [ ] **Step 4**: 视觉基线 CI 重生成 → 人审(变化必须是回顾卡新段落可解释)→ 覆盖 commit push 盯绿。
- [ ] **Step 5**: 汇报:17a 发生率数字与抽检、Task 2 前后数字、A/B/窄门在真库抽样的开口实测(与量化报告 33.2%/23.0%/1.3% 对照)、**真模型 smoke 交接注记**(prompt 新行是新审计面,留真机)。

---

## Self-Review 记录(定稿前跑过)

1. **Spec 覆盖**:三档谓词单源+A/B/窄门算术(T1)、B 两前置修复(T2)、17a 全链+实证前置(T3)、双面输出+措辞纪律(T4)、收账与 smoke 交接(T5)。机制类不扩表=T1 mechanic 分支;positional 跳过=T1;免疫不反推=T1;CC 死锁不开口=T1 窄门。
2. **占位符**:T1/T3 有注释体用例,均已写明判据与断言目标,按首例样式补全;T3 阈值「实证后定,先验 80」是设计本体非 TBD。
3. **类型一致**:`ICounterfactualHit/IMitigationAuditRow/CounterfactualTier` T1 定义、T4 消费;`counterfactualOf` 回调形状 T4 内一致;`questionable-external` 字符串三处(候选/MISTAKE/测试)一致。
