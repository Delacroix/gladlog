/**
 * 非官方技能事实签字册(B2,2026-08-14 起正式制度)。
 *
 * 背景:2026-08-14 全量规范审计(58 条断言,~17% 规范层错误率)发现错误母题集中在
 * 「无官方字段背书、靠模型/文档先验断言的技能事实」——2 例天赋效果张冠李戴(破蛹化蝶的
 * 复苏之茧减 CD 效果被安到静心织魂头上)、3 例「被控状态下能按什么」机制误判。B1(见
 * `usableWhileCcGenerated.ts`/`cooldowns.ts`)把「能按什么」尽量官方化;本文件收官方数据
 * 覆盖不到、必须靠人工裁决的剩余事实面。
 *
 * 签字流程:
 * 1. 凡无官方 DB2 字段背书的技能/天赋事实断言(效果因果、代价规范、机制限制……)要写进
 *    分析/深挖消费方前,先在此登记一条 `ICuratedAbilityFact`。
 * 2. 新增条目必须附 `source`(官方 tooltip / wowhead 链接 / 审计报告 / 用户裁决记录)与
 *    `approved`(格式 "YYYY-MM-DD user"——裁决当天由用户在会话里逐条「批」,不是自封)。
 * 3. `CURATED_ABILITY_FACTS` 的每一条被 `test/curatedFacts.test.ts` 强制检查:没有
 *    `approved` 字段、或格式不是 `/^\d{4}-\d{2}-\d{2} user$/` → CI 红。这是 CLAUDE.md
 *    「修复要给前后数字」纪律在登记侧的配套——没有签字戳的断言不许悄悄进正册。
 * 4. `PROPOSED_FACTS` 是待签暂存区:研究已完成、来源已附,但尚未获用户批准的条目放这里
 *    (类型故意去掉 `approved` 字段,不许伪造日期占位)。它**不受**上面的 CI 强制测试
 *    覆盖,只是暂存;获批后把条目连同补上的 `approved` 戳迁入 `CURATED_ABILITY_FACTS`,
 *    并**从这里删除**——晋升即移除,`PROPOSED_FACTS` 任一时刻只应装着"还没批"的条目,
 *    不装"已经批过、留个副本"的条目(否则两处各存一份,后续任一处漏更新就是悄悄分叉)。
 *    任何消费方都不应该直接 import `PROPOSED_FACTS`(见下方边界测试)。
 *
 * 先例:`packages/analysis/src/utils/mitigationData.ts` 的 MITIGATION_OVERRIDES(每条带
 * 来源 + 用户拍板日期)、`talentBehaviors.ts`「仅收录经验证的天赋」纪律。
 */

export interface ICuratedAbilityFact {
  id: string; // spellId 或 talent spellId
  claim: string; // 一句中文事实断言
  kind:
    | "talent_effect"
    | "usable_while_cc_gap"
    | "usable_while_cc_conditional"
    | "mechanic"
    | "cost_norm";
  /** conditional 类:授权 PvP 天赋 spellId(2026-08-14 用户设计:被控可用可为天赋条件性) */
  requiresTalent?: string;
  source: string; // 出处(官方 tooltip/wowhead 链接/裁决记录)
  approved: string; // "YYYY-MM-DD user" —— 无此字段的条目测试红
}

export const CURATED_ABILITY_FACTS: ICuratedAbilityFact[] = [
  {
    id: "202424",
    claim:
      "破蛹化蝶(Metamorphosis,秘法师天赋):使复苏之茧(Life Cocoon, 116849)冷却缩短 45 秒",
    kind: "talent_effect",
    source:
      "官方天赋数据 talentModifiers.json(116849 → [{talentSpellId: 202424, effect: reduce_cd, value: 45}]) " +
      "+ 规范审计报告 2026-08-14(纠正此前把该效果错安到静心织魂头上的张冠李戴)",
    approved: "2026-08-14 user",
  },
  {
    id: "353313",
    claim:
      "静心织魂(Peaceweaver,秘法师天赋):不修正复苏之茧(116849)冷却——此前审计曾误将破蛹化蝶的减 CD 效果安到它头上",
    kind: "talent_effect",
    source:
      "官方天赋数据 talentModifiers.json(116849 的 reduce_cd 修正条目里只有 202424 一条,不含 353313)" +
      "+ 规范审计报告 2026-08-14",
    approved: "2026-08-14 user",
  },
  {
    id: "642",
    claim:
      "圣盾术(Divine Shield):机制上任何被控状态可施放,但代价过高,不得被推荐为常规挡控手段(仅致死威胁下的最后手段)",
    kind: "cost_norm",
    source:
      "用户裁决 2026-08-14(见 task-4-report.md §4:与官方 usable-while-stunned 位判定不冲突,教练规范层单独裁决)",
    approved: "2026-08-14 user",
  },
  {
    id: "45438",
    claim:
      "寒冰屏障(Ice Block):同圣盾——机制可用、代价禁止常规使用,仅别无选择时",
    kind: "cost_norm",
    source: "用户补充裁决 2026-08-14",
    approved: "2026-08-14 user",
  },
  {
    id: "55233",
    claim:
      "吸血鬼之血(Vampiric Blood):任何被控状态下均不可施放(旧手写表误收,已从 USABLE_WHILE_CC shim 清除)",
    kind: "mechanic",
    source:
      "用户裁决 2026-08-14(“都不行”)+ 语料 1028 场 0 次晕中施放成功佐证(task-4-report.md §4)" +
      "+ 官方 usable-while-stunned 468 集不含此 id(task-5-report.md)",
    approved: "2026-08-14 user",
  },
  {
    id: "119996",
    claim:
      "转世:转移(Transcendence: Transfer):基线在被控(晕)状态下不可施放;携带秘法师 " +
      "PvP 天赋「明心 / Eminence」(353584,秘法师专精池 spec 270)时可在晕中施放,且非晕中" +
      "施放额外减 15 秒冷却",
    kind: "usable_while_cc_conditional",
    requiresTalent: "353584",
    source:
      "wowhead spell=119996 Flags 栏「Allow While Stunned by Stun Mechanic」+「Allow While " +
      "Stunned By Horror Mechanic」(2026-08-14 WebFetch 逐条核实,与 task-4-report.md §3.1 " +
      "同一证据;该报告把此位判定为官方 468 集的覆盖缺口而非规则本身有误)+ Icy Veins " +
      "《Mistweaver Monk PvP Talents and Builds》(2026-08-14 抓取)原文「Eminence allows you " +
      "to use Transcendence: Transfer while stunned」+ Blizzard 9.1.0 (2021-06-29) 补丁说明" +
      "原文「Transcendence: Transfer can now be cast if you are stunned. Cooldown reduced by " +
      "15 sec if you are not.」+ `pvpTalentPoolGenerated.ts`(build 12.1.0.69273)spec 270 " +
      "(Mistweaver)天赋池含 353584,确认该天赋在当前 build 仍存在。2026-08-14 用户批准晋升。",
    approved: "2026-08-14 user",
  },
  {
    id: "498",
    claim:
      "圣佑术(Divine Protection,圣骑士):被控(晕)状态下可无条件施放——wowhead 位标志" +
      "「Allow While Stunned by Stun Mechanic」直接标在本技能上,属官方 468 集 ≤2 位并集" +
      "搜索的覆盖缺口而非规则本身有误",
    kind: "usable_while_cc_gap",
    source:
      "wowhead spell=498 Flags 栏「Allow While Stunned by Stun Mechanic」" +
      "(2026-08-14 WebFetch 核实)+ 语料 341 次晕中施放成功(与 403876 合计 748 次," +
      "task-4-report.md §3.1)+ 用户本职业确认(2026-08-14,PAUSE 2 裁决)。" +
      "Shim 总数:470 → 471(与 51490 同批并入)。",
    approved: "2026-08-14 user",
  },
  {
    id: "403876",
    claim:
      "圣佑术(Divine Protection,圣骑士,天赋克隆 id):同 498——被控(晕)状态下可无条件" +
      "施放,官方 468 集覆盖缺口",
    kind: "usable_while_cc_gap",
    source:
      "wowhead spell=403876 Flags 栏「Allow While Stunned by Stun Mechanic」" +
      "(2026-08-14 WebFetch 核实)+ 语料 407 次晕中施放成功(与 498 合计 748 次," +
      "task-4-report.md §3.1)+ 用户本职业确认(2026-08-14,PAUSE 2 裁决)。",
    approved: "2026-08-14 user",
  },
  {
    id: "51490",
    claim:
      "雷霆风暴(Thunderstorm):被控(晕)状态下可无条件施放——基线法术自带的位,不依赖任何 " +
      "PvP 天赋(搜遍萨满全三专精 PvP 天赋池与攻略站均未找到 gating 天赋,负结果查证)",
    kind: "usable_while_cc_gap",
    source:
      "wowhead spell=51490 Flags 栏「Allow While Stunned by Stun Mechanic」直接标在基础技能上" +
      "(2026-08-14 WebFetch 核实;与 498/403876 同款证据形态——散位族未被官方 468 集的" +
      "≤2 位并集采纳组合收录,属覆盖缺口而非规则本身有误)+ 语料 321 次晕中施放成功" +
      "(task-4-report.md §3.1)+ 授权天赋负结果查证(`pvpTalentPoolGenerated.ts` spec " +
      "262/263/264 萨满三专精 PvP 天赋池逐条核对、Icy Veins《Elemental Shaman PvP Talents " +
      "and Builds》全文均无 gating 天赋线索,该效果实为 WotLK 3.1.0(2009-04-14)起的基线" +
      "改动)。2026-08-14 用户批准以无条件缺口层形式入册。",
    approved: "2026-08-14 user",
  },
];

/**
 * 待签暂存区(见文件头 §4)。当前为空——2026-08-14 唯二曾在此暂存过的候选(119996 转世:
 * 转移 / 51490 雷霆风暴,均为 Task 6 的研究产出)已获用户批准,按「晋升即移除」纪律迁入
 * `CURATED_ABILITY_FACTS`(见上方对应条目及其 source 里的完整证据链),不在此重复留档。
 */
export const PROPOSED_FACTS: Array<Omit<ICuratedAbilityFact, "approved">> = [];
