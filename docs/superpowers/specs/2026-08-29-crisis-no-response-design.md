# crisis-no-response — 行为先验驱动的「危机无应对」候选(设计)

日期:2026-08-29 · 状态:待用户审阅 · 关联:GH #58、`eval-private/reports/behavior-prior-2026-08-28/`

## 1. 目标与结论句

**问题**:`death-unused-defensive` 指控「你死时减伤是好的却没按」。四轮语料实验(18,134 场新赛季归档)
证明这条指控描述的是高手多数时候也不做的事:自由态下前 10% 治疗按个人减伤只有 19–36%;
他们的主要应对是自疗(60–76%),而**分段之间真正有梯度的错误是「三秒内什么都没做」**
(3v3 自由态:后 30% 32% → 前 10% 12%;「一个主动应对都没有」40% → 14%)。

**产品形态**(用户 2026-08-29 拍板):新候选 `crisis-no-response`,不以死亡为锚;
`death-unused-defensive` 本次不动,退役/降级由 GH #58 单独裁。

**视角(2026-08-29 第二次裁定):第一版只覆盖治疗。** DPS 视角的中间数据(5,613 场、33,930 个决策点)显示
「危机无应对」在 DPS 各分段**持平**(单排 28→25%、2v2 39→39%、3v3 29→25%),DPS 几乎从不空手(零施法 1–5%),
高分段活下来靠队友治疗(中位 18→28% 血)和自己对敌方施控(+8–10pp)。没有梯度的指控不发;DPS 另立项(§9)。

**目标结论句**(用户已批准,数字查表填):

> 3:12 你血量跌到 38%(对方刚开爆发,2 人集火),接下来 3 秒你没有任何应对——没自疗、没减伤、没施控、没拉开。
> 同赛制前 10% 的治疗在这个状态下 88% 会在 3 秒内出手:76% 先把自己奶回来(中位 +37% 血),36% 开个人减伤,16% 对敌方施控。

模型只能引用这些数字;不得据此推断玩家「应该按某个具体技能」。

## 2. 决策点谓词(分析与扫描共享)

新文件 `packages/analysis/src/analysis/crisisDecisionPoints.ts`,纯函数:

```ts
crisisDecisionPoints(owner, combat): DecisionPoint[]   // v1 healer-only; role 维度留给 DPS 立项
```

一个决策点 = owner 自身 HP **向下穿过** `CRISIS_HP_PCT`(0.40,从 `packages/eval/src/explore/signalSkillGradient.ts`
搬到 analysis 并由 eval 反向 import),`CRISIS_WINDOW_GAP_MS`(5000)内合并。字段:

| 字段               | 含义                         | 来源                                                |
| ------------------ | ---------------------------- | --------------------------------------------------- |
| `t`, `hpPct`       | 穿越时刻(ms)与血量           | `advancedActions`                                   |
| `dmg2s`            | 前 2s 承伤 / maxHP           | `damageIn`                                          |
| `attackers2s`      | 前 2s 打 owner 的敌方数      | `damageIn.srcUnitId`                                |
| `enemyBurst`       | 前 8s 敌方施放过进攻大 CD    | `classMetadata` Offensive tag                       |
| `inCC`             | 硬控光环在身                 | `ccSpellIds`                                        |
| `lockedOut`        | 见门 2                       | `SPELL_INTERRUPT` / `spells` 表 `interrupts` 型光环 |
| `diedBefore(t+3s)` | 见门 4                       | `deathRecords`                                      |
| `toolsReady`       | 见门 3                       | `extractMajorCooldowns` + `cdAvailableAt`(现有单源) |
| `responses`        | [−1.5s, +3s] 内的多标签      | 见下                                                |
| `responded`        | `responses` 里任一主动项为真 |                                                     |

**应对多标签**(与 `behaviorPriorScan.ts` v4 一致,搬入本文件):
`selfHeal`(自己对自己治疗 ≥15% maxHP)、`wall`(`bigDefensiveSpellIds` 内就绪减伤施放)、
`external`(`externalDefensiveSpellIds` 施放,给自己或队友)、`control`(对敌方施放 `ccSpellIds ∪ rootSpellIds ∪ interrupts`)、
`peel`(队友对 owner 的攻击者施控)、`kite`(与最近攻击者距离 +8 码)。
**主动应对** = selfHeal ∨ wall ∨ external ∨ control ∨ kite(peel 是队友的行为,不算 owner 出手,但进参照表供渲染)。

**可行性门**(四条,「当时做得到吗」):

1. **未被硬控**:`inCC` → 不出面(被控本身另有信号)。
2. **未被锁学派**:窗口起点前 1.5s 内被 `SPELL_INTERRUPT` 打断,或沉默类光环在身 → 不出面。
   用户裁定:被打断后没出手是另一种错误,**移交现有 `kick-eaten`**,本条不重复指控。
3. **有工具**:治疗 = 恒真(自疗总在)。v1 只有治疗,本门不需要 id 表;DPS 立项时再定工具集并在 `curatedIdRegistry` 注册。
4. **窗口完整**:owner 在 t+3s 前死亡 → 不出面(不是后视,是没有 3 秒可用)。用户裁定 3 秒。

`packages/eval/scripts/behaviorPriorScan.ts` 改为调用这同一个函数,自己只保留分段与聚合逻辑。
**红线**:改谓词的 PR 必须附带重生成的参照表(§3),否则「你没出手」与「高手出手率」是两把尺子。

## 3. 参照表 `behaviorPriorGenerated.json`

`packages/analysis/src/data/behaviorPriorGenerated.json`,由 `behaviorPriorScan.ts --emit-table` 生成,
惯例同 `observedSpellIdsGenerated.json` / `dispelObservedGenerated.ts`(语料派生表,表头带命令与快照)。

```jsonc
{
  "meta": { "generatedAt": "...", "corpus": "archive 2026/08 新赛季 N 场", "weeks": ["2026-W33", "2026-W34"],
            "command": "npx tsx packages/eval/scripts/behaviorPriorScan.ts --emit-table ...", "predicateVersion": 1 },
  "cells": {
    "Rated Solo Shuffle|healer|>=20%": { "n": 172, "respondRate": 0.87, "top": [["selfHeal", 0.65], ["wall", 0.33], ["control", 0.07]], "selfHealMedianPct": 23 },
    "Rated Solo Shuffle|healer|*":     { "n": 285, "respondRate": 0.85, "top": [...], "selfHealMedianPct": 23 }
  }
}
```

- **参照人群固定 top10**:同(赛制, ISO 周)内分数百分位 ≥90。不改成 top20——「前 10%」是对用户的承诺。
- **格子维度**:赛制 × 角色(v1 只有 `healer`,键位保留)× 前 2s 承伤三档(`<10% / 10–20% / ≥20%`)。**不含**专精(3v3 各专精 3–57,不够)、
  **不含**爆发维(把样本切碎到 4–59)。爆发只留在事实行里。
- **回退**:格子 `n < 50` 时用 `bracket|role|*` 汇总;渲染时附 `(n=…)`。
- **分段口径**:绝不用绝对分(赛季通胀:W32 单排中位 2158 → W34 1729)。
- **刷新**:`docs/commands/update-wow-data.md` 新增一步(与 6b-pre `observedSpellIds` 同位置);新 build 上线后跑,
  赛季中期数据翻倍可再跑。单测钉「每个赛制 × 角色的 `*` 格子 n ≥ 50」。
- 当前样本量(治疗、自由态、前 10%):单排 285 / 2v2 350 / 3v3 105;承伤 ≥20% 格:172 / 149 / 81。3v3 部分格子会回退。

## 4. 候选产出

新文件 `packages/analysis/src/analysis/candidates/crisisNoResponse.ts`,注入式(同 `cooldownTiming.ts`,不在 mapper 里遍历原始事件):

- 输入:`crisisDecisionPoints(...)` 结果 + `lookupBehaviorPrior(bracket, role, cell)`。
- 出面条件:四门全过 ∧ `responded === false`。
- **每回合上限 2 条**,按危险度排:`enemyBurst` → `attackers2s` → `dmg2s`,**不看结果**(不以死亡/存活排序)。
- facts:`{ t, hpPct, dmg2s, attackers, burst, refN, refRespond, refTop, refSelfHealMedian, cellKey }`。
- 挂在 `extractCandidateFindings` 的 try/catch 链上(「算不出 → 类型缺席」惯例)。
- **与 `death-unused-defensive` 的关系**:同回合内本条 t 之后 10s 内若有 `death-unused-defensive`,给后者加 `facts.precededBy = "crisis-no-response"`,
  不删——留给用户看两条并存的真实输出再决定 GH #58。

## 5. 渲染与门规

- `buildFindingsPrompt.ts` `CHAIN_LEGENDS["crisis-no-response"]`:说明各 fact;守护注(同 `[UNUSED]` 教训):
  「refRespond/refTop 是同赛制前 10% 在同状态下的实测分布;**只能引用,不得据此推断玩家应该按某个具体技能**」。
- `promptQualityCheck.ts` 新增 hardFailure `checkBehaviorPriorConsistency`:重解析渲染行里的百分比与 n,
  与 `lookupBehaviorPrior` 返回逐字比对。查表函数从 analysis 导出,门 import(共享谓词规则)。
- `docs/predicate-index.md`(+ `.zh-CN`)加两行:`crisisDecisionPoints`、`lookupBehaviorPrior`。

## 6. 接线清单

| 位置                                                                       | 改动                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `candidates/crisisNoResponse.ts`                                           | 新 producer                                                     |
| `candidateFindings.ts`                                                     | re-export + 菜单挂载 + `CRISIS_NO_RESPONSE_CAP = 2`             |
| `buildFindingsPrompt.ts`                                                   | legend                                                          |
| `data/behaviorPriorGenerated.json` + `data/behaviorPrior.ts`(查表 wrapper) | 新                                                              |
| `eval/scripts/behaviorPriorScan.ts`                                        | 改为消费共享谓词;加 `--emit-table`                              |
| `eval/src/explore/signalSkillGradient.ts`                                  | 分母 = 决策点数;`CRISIS_*` 常量改为从 analysis import           |
| `eval/src/quality/promptQualityCheck.ts`                                   | `checkBehaviorPriorConsistency`                                 |
| desktop `mistakes.ts` / `findingDisplay.ts`                                | `MISTAKE_RULES` 条目(severity major,source candidate)+ 中文标签 |
| desktop `promptVersion.ts`                                                 | `PROMPT_VERSION` +1                                             |
| `packages/analysis/README.md` + `.zh-CN`                                   | 类型清单 +1                                                     |
| `docs/predicate-index.md` + `.zh-CN`                                       | +2 行                                                           |
| `docs/commands/update-wow-data.md`                                         | 刷表步骤                                                        |

## 7. 验证(价值门在前)

1. **价值门**:接线后先在 3 场真实对局(含用户库 1 场)上产出完整 prompt + 模型输出,给用户看,批准后才做后面的。
2. **确定性验证**:全库候选计数(`candidateFindings` 逐类)+ prompt 哈希,前后对比;新类型触发率与每场条数。
3. **门规**:`checkBehaviorPriorConsistency` 在 50 场上 0 失败;植入一处错百分比必须被抓。
4. **梯度**:`signalSkillGradientScan` 加分母后,新类型按赛制分层的转化率梯度应为负(3v3 预期 ≈ −20pp)。
5. **去重**:统计同回合 `crisis-no-response` 与 `death-unused-defensive` 并存的比例,交 GH #58。
6. `npm run presubmit` 绿。

## 8. 不做的事

- 不训模型;不做「高你一档」参照;不做专精维度;不改 `death-unused-defensive` 的谓词或措辞(GH #58)。
- 被打断/沉默后无应对不在本条(移交 `kick-eaten`)。
- 不用用户自己的库当参照(赛季初 64 场,不够)。

## 9. 后续(不在本 spec)

- **DPS 视角另立项**:数据里唯一有梯度的 DPS 行为是「承压时对敌方施控/打断」(单排 22→29%、3v3 23→33%),
  那是另一条信号(「被集火时没有用控制打断对方」),等 DPS 全量扫描完成后单独设计;`crisisDecisionPoints` 的 role 维度届时加。

同一套「决策点 → 高手分布 → 参照表」推广到 `external-unused` / `missed-cleanse` / `cd-spent-idle`,每条换决策点定义与应对集。
