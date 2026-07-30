# 减伤 {百分比, 学派} 表(#17 地基)设计

2026-07-30 · backlog #17.2 的地基件:每个主要减伤的 {百分比, 作用学派},
判据走 DB2 官方字段([[official-data-over-heuristics]]),官方表也要实测。
前置量化已毕:死亡窗口 damageIn 学派字段覆盖率 100%(148/148 窗口 ≥90%
可归因,seed=20260729,n=302 判定单元);DR 表官方化已于 2026-07-25 完成,
无需重做。

## 目标与判据

`packages/analysis/src/data/mitigationData.ts` 导出:

```ts
export interface IMitigationEntry {
  /** 减伤百分比,0-100;免疫类=100。 */
  pct: number;
  /** 作用学派掩码,与日志 spellSchoolId 同位义(0x7F 全学派/0x7E 仅魔法/0x1 仅物理…)。 */
  schoolMask: number;
  /**
   * 可选,条件减伤(条件=站位)标注:仅对处于技能区域内的单位生效;#17
   * 消费方必须结合 advanced 坐标数据判定该单位是否处于区域内,不判定不得
   * 计入该条减伤——漏读会把黑暗(196718)这类条件减伤当无条件 40% 方向性
   * 高估。仅当条件维度本身在日志中可判(如站位)才允许标此字段并给值;
   * 条件维度日志不可判(如伤害是否为 AoE,见 374227 Zephyr)的条目维持
   * no-mitigation 宁缺,不进本表。
   */
  positional?: true;
}
export const MITIGATION_TABLE: Record<string, IMitigationEntry>;
```

范围 = `bigDefensiveSpellIds ∪ externalDefensiveSpellIds`(~35 条,#17 的
全部消费面)。**本期不建任何消费者**——纯地基:表 + datagen + 测试 + 工作流登记。

验收判据:35 条白名单 id 每条要么在合并表有条目,要么在显式的
`NO_MITIGATION_IDS` 登记表里(纯免疫吸收/纯治疗类,带注释说明为何无减伤
属性)——**不许有第三种状态**(静默缺席即防腐测试红)。

## 决策记录(brainstorm 拍板)

1. **双层:生成底 + 策展覆盖**(spellEffectData 同款先例)——DB2 挖得动的
   进 `mitigationGenerated.json`,挖不动/挖错的 `MITIGATION_OVERRIDES` 人工
   校准值恒赢。否决:纯策展(违背 official-data 拍板)、纯生成(减伤 aura
   语义多样,挖错无人兜底)。
2. 免疫类语义:`pct: 100, schoolMask` 照实;与 burstLedger 的 isImmunity
   二元判定不冲突,消费方自行区分。
3. 范围钉白名单 35 条,不做全表(消费面之外的减伤条目无人查,白名单腐烂
   教训:表大不等于对)。
4. **2026-07-30 用户改判 196718(黑暗)**:实现期原拍板 no-mitigation 被
   用户推翻,改判 `{ pct: 40, schoolMask: 0x7f, positional: true }`(大技能
   不能算 0,但必须计算位置——不站在黑暗里不计)。由此确立可判性分野:
   条件维度本身在日志中**可判**(黑暗=站位,advanced 坐标数据可查)时给值
   并标 `positional: true`,判定责任下放消费方;条件维度**不可判**(和风
   374227=是否 AoE,`{pct, schoolMask}` 模式无条件维度表达能力)时维持
   no-mitigation 宁缺。后续同类条件减伤按此分野分类,不必逐条回问。

## 架构

### 生成层(datagen 新脚本 genMitigation.ts)

- 拉 `SpellEffect` 表(`fetchTable("SpellEffect", build, cacheDir)`,
  genTalentModifiers.ts:252 先例),按白名单 id 过滤;
- 识别减伤 aura:主打 `EffectAura === 87`(AURA_MOD_DAMAGE_PERCENT_TAKEN,
  `EffectBasePointsF` = 负百分比,`EffectMiscValue_0` = school mask——DB2
  标准语义,**脚本内对已知锚点断言验证**:如 Barkskin 应挖出 {20, 0x7F}
  一类,锚点值以实现期实查为准写死进断言);
- 多效果歧义(同 spell 多条 87 行/条件型 aura)或挖不出的条目**不猜**:
  写进生成报告的 `unresolved` 清单,由策展层接;
- 产物 `mitigationGenerated.json`(小表,不涉大 JSON 纪律);
  `datagen-manifest.json` 登记;`docs/commands/update-wow-data.md` 加步骤。

### 策展层与合并

- `MITIGATION_OVERRIDES: Record<string, IMitigationEntry>`(每条带注释:
  来源=游戏事实/tooltip,为何覆盖);
- `NO_MITIGATION_IDS: ReadonlySet<string>`(白名单内确无减伤属性的条目,
  每条注释原因);
- 合并:`MITIGATION_TABLE = { ...generated, ...overrides }`,覆盖层恒赢。

### 实测验收(official-data 纪律:官方表也要实测)

1. 生成后 35 条逐条人审对照游戏事实(tooltip 百分比/学派),错/缺进
   overrides——人审记录进实现报告;
2. 语料 sanity:抽 2-3 个带明确减伤窗的真实对局(如盾墙/防御姿态激活期),
   比对 buff 激活期 damageIn 相对基线的实际折减与表值同量级(±10pp 级
   容差,防系统性挖错,不追求精确——吸收盾/护甲/韧性等混杂因素不建模)。

## 边界(刻意不做)

- 任何消费者接入(#17 主体的活);
- 白名单外的减伤条目;条件型减伤(如仅对 AoE)的条件建模——照实标
  基础值,条件语义留 #17 设计时决定;
- 叠乘/加算交互(多减伤同窗)——表只记单技能值,叠加规则是 #17 的算术层。

## 测试

- 防腐:白名单全覆盖断言(TABLE ∪ NO_MITIGATION_IDS ⊇ 白名单,无第三态);
  值域断言 pct∈(0,100]、schoolMask∈(0,0x7F];overrides 键必须在白名单内
  (防表外漂移);
- datagen transform 纯函数单测(87 行识别/负值取绝对/mask 透传/歧义进
  unresolved);
- 锚点断言:2-3 个知名技能的 {pct, schoolMask} 精确值(实现期实查后写死)。

## 风险

| 风险                                           | 处置                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| 减伤 aura 类型不止 87(如 mod school absorb 类) | 生成层只认 87,其余进 unresolved 由策展接;不扩挖(YAGNI,35 条人审兜底) |
| SchoolMask 语义与日志 spellSchoolId 位义不一致 | 锚点断言 + 语料 sanity 双保险;不一致即停,回报再定                    |
| 策展层腐烂(赛季改动)                           | update-wow-data 工作流步骤 + 生成/覆盖 diff 在刷新时天然暴露         |
