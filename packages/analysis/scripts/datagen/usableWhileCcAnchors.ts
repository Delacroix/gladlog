/**
 * 「被控(晕/恐惧/混乱)下能否主动施放」锚定清单提案 —— 技能事实地基 Task 2。
 *
 * 目的:Task 3 用官方 SpellMisc/Spell.db2 位字段做全量位搜索时,需要一批
 * "已知真值"锚点来判定候选位是否就是"usable while stunned/feared/confused"
 * 三个位。本文件只是**提案**,尚未经用户逐条签字批准 —— 不得被 Task 3 消费,
 * 直到控制器把 `approvedBy` 常量(用户签字后由控制器代填,记录批准日期与
 * 每条被改判的裁决)补齐。
 *
 * 判断维度:三维度分别对应"该技能在玩家处于晕(Stun)/恐惧(Horror/Fear 类
 * 机制)/混乱(Disorient 类机制)状态下,能否被玩家主动吟唱/施放出去",不是
 * "该技能能否驱散/免疫这类控制"(两者不同 —— 例如角斗士的勋章既能在晕中
 * 被按下,也能驱散晕本身;但很多"移除控制"的技能本身在控制状态下反而
 * 按不出来,这正是 642 冲突的核心)。
 *
 * 出处方法论:2026-08-14 对每条锚点用 WebFetch 抓取 wowhead.com 对应
 * spell 页面的 "Flags" 栏(该栏是 wowhead 对 Blizzard Spell.db2 相关
 * AttributesEx 位的可读渲染,和 Task 3 要找的官方位是同一数据源的不同
 * 呈现形式,但**不是**该位本身 —— 因此仍标注为"较高置信度的人工核对"而非
 * "官方位实测",Task 3 跑通位搜索后仍需交叉验证)。三条关键措辞:
 *   - "Can be used while stunned" / "Usable while feared" / "Usable while
 *     confused"(Medallion/Barkskin/Dispersion/Unending Resolve 都有)——
 *     这才是"真.可用"位。
 *   - "Allow While Stunned By Stun Mechanic" / "...By Horror Mechanic"
 *     (Pain Suppression)—— 按机制分别授权,与上面语义等价,只是措辞不同。
 *   - "No Client Fail While Stunned, Fleeing, Confused"(Divine Shield /
 *     Ice Block 都有)—— 这是**另一个位**:只抑制客户端"你不能这么做"的
 *     报错文案,不代表技能真的会生效。Divine Shield 和 Ice Block 恰好是
 *     一对极佳的正反对照:两者 flags 栏一模一样,而 Ice Block "晕中按不出
 *     寒冰屏障"是 WoW PvP 界公认常识 —— 强烈支持"这个位不等于可用位"的
 *     判断,也支持用户对 642 的裁决。Task 3 的位搜索必须把这两类位分开,
 *     不能把 "No Client Fail" 误当成候选真位。
 *
 * 手写表出处:packages/analysis/src/utils/cooldowns.ts:127
 * USABLE_WHILE_CC_SPELL_IDS(6 条,原始意图见其上方注释:避免把"被控锁死
 * 而没用防御技能"误判为"该用没用"的假指控)。
 */

export interface UwcAnchor {
  spellId: string;
  /** 中文技能名,核对自 spellNamesZhGenerated.json / spellNames.json,仅供人工审阅用。 */
  name: string;
  /** 晕(Stun 机制)下能否主动施放;null=本次不作锚定。 */
  stunned: boolean | null;
  /** 恐惧(Horror/Fear 机制)下能否主动施放;null=本次不作锚定。 */
  feared: boolean | null;
  /** 混乱(Disorient 机制)下能否主动施放;null=本次不作锚定。 */
  confused: boolean | null;
  /** 一句话理由。 */
  rationale: string;
  /** 一条出处(手写表行号 / wowhead 抓取 / 用户裁决日期 / brief 语料实证)。 */
  source: string;
}

/**
 * 12-16 条锚点提案,待用户逐条批准。Task 3 消费的最小契约是
 * `{ spellId, name, stunned, feared, confused, rationale }`(本文件多出的
 * `source` 字段是结构超集,不影响该契约的结构兼容性)。
 */
export const UWC_ANCHORS: UwcAnchor[] = [
  // ---- 现手写表 6 条(逐一核验/标注冲突)----
  {
    spellId: "33206",
    name: "痛苦压制",
    stunned: true,
    feared: true,
    confused: null,
    rationale:
      "手写表原有条目(戒律牧外置减伤,设计用途是在队友被控死亡边缘也能开出);wowhead flags 栏同时给出 stun 与 horror(恐惧类)机制的授权位,confused 未见对应旗标故不判定。",
    source:
      "cooldowns.ts:128 + wowhead.com/spell=33206 Flags 栏「Allow While Stunned by Stun Mechanic」「Allow While Stunned By Horror Mechanic」(2026-08-14 抓取)",
  },
  {
    spellId: "22812",
    name: "树皮术",
    stunned: true,
    feared: true,
    confused: null,
    rationale:
      "手写表原有条目(德鲁伊自我减伤,同一设计意图);wowhead flags 栏明确「Can be used while stunned」+「Usable while feared」,confused 未见对应旗标故不判定。",
    source:
      "cooldowns.ts:129 + wowhead.com/spell=22812 Flags 栏(2026-08-14 抓取)",
  },
  {
    spellId: "47585",
    name: "消散",
    stunned: true,
    feared: true,
    confused: null,
    rationale:
      "手写表原有条目(暗牧自我减伤);wowhead flags 栏同 Barkskin 模式明确「Can be used while stunned」+「Usable while feared」,confused 不判定。",
    source:
      "cooldowns.ts:130 + wowhead.com/spell=47585 Flags 栏(2026-08-14 抓取)",
  },
  {
    spellId: "642",
    name: "圣盾术",
    stunned: false,
    feared: null,
    confused: null,
    rationale:
      "一号分歧:手写表(cooldowns.ts:131)把它列为被控下可用,但与用户 2026-08-14 裁决「圣盾晕中开不出」正面冲突 —— 本条按用户裁决把 stunned 判 false。wowhead flags 栏显示的是「No Client Fail While Stunned, Fleeing, Confused」而不是 Pain Suppression/Barkskin 等真正拥有的「Can be used while stunned」/「Usable while feared」旗标;这很可能正是手写表当年误收的根源(把「不报错」误读成「能生效」)。feared/confused 用户未裁决且缺乏「真可用位」证据,留 null 待 Task 3 官方位与语料仲裁,不代表已认定为 false。",
    source:
      "用户 2026-08-14 裁决「圣盾晕中开不出」+ cooldowns.ts:131 + wowhead.com/spell=642 Flags 栏(2026-08-14 抓取)",
  },
  {
    spellId: "55233",
    name: "吸血鬼之血",
    stunned: null,
    feared: null,
    confused: null,
    rationale:
      "二号分歧:手写表(cooldowns.ts:132)把它列为被控下可用,但本次 wowhead flags 栏完整核对未见任何 stunned/feared/confused 相关旗标(与 Pain Suppression/Barkskin/消散/勋章/不灭决心形成对比)——三维度均判 null,既不附和手写表也不推翻它,留 Task 3 官方位裁定;wowhead 渲染完整度本身未 100% 确证(不排除该位存在但未被此渲染栏捕捉),故不判 false。",
    source:
      "cooldowns.ts:132 + wowhead.com/spell=55233 Flags 栏完整核对(2026-08-14 抓取,未见相关旗标)",
  },
  {
    spellId: "48792",
    name: "冰封之韧",
    stunned: null,
    feared: null,
    confused: null,
    rationale:
      "三号分歧:同吸血鬼之血,手写表(cooldowns.ts:133)列为被控下可用,但 wowhead flags 栏只见「Remove auras on immunity」(描述的是它授予的免疫效果本身,不是「被控下可被吟唱」),未见「usable/allow while stunned」类旗标 —— 三维度判 null,留 Task 3 裁定。",
    source:
      "cooldowns.ts:133 + wowhead.com/spell=48792 Flags 栏完整核对(2026-08-14 抓取,未见相关旗标)",
  },

  // ---- brief 指定锚点:角斗士的勋章(语料实证,三维度全中)----
  {
    spellId: "336126",
    name: "角斗士的勋章",
    stunned: true,
    feared: true,
    confused: true,
    rationale:
      "brief 指定锚点:勋章的设计用途就是在被控时按下来解控,2026-08-14 语料实证 5 次晕中施放;wowhead flags 栏三项旗标齐全「Can be used while stunned」「Usable while feared」「Usable while confused」,是本清单唯一三维度同时高置信度确认的条目,建议作为 Task 3 位搜索的主锚点。",
    source:
      "brief 2026-08-14 语料实证(5 次晕中施放)+ wowhead.com/spell=336126 Flags 栏(2026-08-14 抓取)",
  },

  // ---- brief 指定反例:圣光术 / 制裁之锤 ----
  {
    spellId: "82326",
    name: "圣光术",
    stunned: false,
    feared: false,
    confused: false,
    rationale:
      "brief 指定反例:硬读条治疗技能,读条类技能在任一控制类型下都应被打断/无法开始吟唱,这是通用机制常识而非该技能专属位;wowhead flags 栏未见任何 usable/allow while 类旗标,与常识一致。",
    source:
      "brief 反例要求 + wowhead.com/spell=82326 Flags 栏(2026-08-14 抓取,未见相关旗标)",
  },
  {
    spellId: "853",
    name: "制裁之锤",
    stunned: false,
    feared: false,
    confused: false,
    rationale:
      "brief 指定反例:瞬发控制技能(晕别人用的,不是防御技能),未标记任何被控下可用旗标 —— 用于验证「瞬发」本身不是可用位的充分条件,必须专门授权。",
    source:
      "brief 反例要求 + wowhead.com/spell=853 Flags 栏(2026-08-14 抓取,未见相关旗标)",
  },

  // ---- 恐惧维度锚点:"不灭意志类" ----
  {
    spellId: "104773",
    name: "不灭决心",
    stunned: true,
    feared: true,
    confused: null,
    rationale:
      "推测为 brief「不灭意志类」的实指(中文名「不灭决心」与「不灭意志」高度近似,术士版外置减伤,与 Pain Suppression/Barkskin/消散同属「外置减伤 CD 家族」);wowhead flags 栏明确「Can be used while stunned」+「Usable while feared」,confused 未见对应旗标。作为手写表之外的扩展锚点,加强该家族的正例密度。",
    source:
      "brief「不灭意志类」+ wowhead.com/spell=104773 Flags 栏(2026-08-14 抓取)",
  },
  {
    spellId: "7744",
    name: "被遗忘者的意志",
    stunned: null,
    feared: null,
    confused: null,
    rationale:
      "「不灭意志类」第二条(种族技能,亡灵专属,玩家共识/设计意图是「恐惧/沉睡/魅惑中可按下用来解控」,这也是它存在的唯一理由);但本次 wowhead flags 栏抓取只看到它授予的免疫光环效果(Fleeing/Asleep/Charmed/Turned 四种免疫),未见与勋章同款的「usable while feared」旗标 —— 不足以确证,也不能排除种族技能走了不同代码路径、未被这次渲染栏捕捉到。三维度均判 null,不可当作已证伪,留 Task 3 官方位裁定。",
    source:
      "玩家共识/技能设计意图 + wowhead.com/spell=7744 Flags 栏完整核对(2026-08-14 抓取,未见相关旗标)",
  },

  // ---- 恐惧维度锚点:「小鬼献祭」—— 未能定位到确切技能,存疑占位条 ----
  {
    spellId: "89808",
    name: "烧灼驱魔(小鬼技能,俗称「焦化魔法」)",
    stunned: null,
    feared: null,
    confused: null,
    rationale:
      "未解析条目,需用户核实原意:brief 要求的「小鬼献祭」锚点未能在 spellNames.json/spellNamesZhGenerated.json 中定位到字面对应的技能 —— 搜索「小鬼」×「献祭」交集为空;JSON 里「献祭」实际对应的是灼烧(Immolate)系法术,与「小鬼/牺牲」无关(疑似生成表翻译巧合重名,而非同一技能);「魔典:献祭」(Grimoire of Sacrifice)与恐惧维度也无已知关联。本条暂用玩家社区确有讨论的「小鬼版徽章」(小鬼的焦化魔法,可为术士驱散一层魔法类负面效果,含恐惧在内的部分控制)占位,但焦化魔法是宠物施放而非玩家本人主动施放,与本清单「玩家能否主动施放」的判据不同轴,因此三维度均判 null、不建议直接采纳为锚点。请用户确认「小鬼献祭」具体指哪个技能(或该条从清单中删除)。",
    source:
      'WebSearch 2026-08-14("小鬼献祭 恐惧 魔兽世界"等 2 次检索,均未命中字面同名技能)+ spellNamesZhGenerated.json 交叉核对',
  },

  // ---- 反例扩展:寒冰屏障(与 642 同旗标模式,交叉印证"No Client Fail" ≠ 可用位)----
  {
    spellId: "45438",
    name: "寒冰屏障",
    stunned: false,
    feared: false,
    confused: false,
    rationale:
      "扩展反例,用于交叉印证 642 的判断依据:寒冰屏障与圣盾术 flags 栏一模一样,都只有「No Client Fail While Stunned, Fleeing, Confused」而没有「Can be used while stunned」类旗标;「法师晕中开不出寒冰屏障」是 WoW PvP 界公认常识(与圣盾术情形高度类比),独立支持「No Client Fail 位 ≠ 可用位」这一判断,降低 642 判断只有单一来源的风险。",
    source:
      "WoW PvP 公认常识(寒冰屏障晕中开不出)+ wowhead.com/spell=45438 Flags 栏(2026-08-14 抓取,与 642 同款「No Client Fail」旗标,无「Can be used while stunned」)",
  },

  // ---- 反例扩展:保护祝福(纯粹无任何 CC 相关旗标的对照组)----
  {
    spellId: "1022",
    name: "保护祝福",
    stunned: false,
    feared: false,
    confused: false,
    rationale:
      "扩展反例,补一个 flags 栏彻底「干净」(既没有真可用位也没有 No Client Fail 位)的对照组,与 642/45438 那种「有 No Client Fail 但仍不可用」的情形区分开,帮 Task 3 的位搜索排除「任何 CC 相关旗标都算数」的误判路径。",
    source:
      "wowhead.com/spell=1022 Flags 栏(2026-08-14 抓取,未见任何 CC 相关旗标)",
  },
];
