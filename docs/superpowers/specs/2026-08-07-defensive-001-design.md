# DEFENSIVE-001 落地 + DEFENSIVE-002 数据否决

日期:2026-08-07 · BACKLOG #18 第二批第 3 项 · 实证先行(`.defensive-rates-report.md`,
探针 `packages/desktop/scripts/tmp-defensive-rates.mts` — 评估后已删)。

## DEFENSIVE-001(cc-avoidable)

**判据(全部既有谓词,零新表)**:owner 为治疗;`analyzePlayerCCAndTrinket` 的
`ccInstances` 里某条吃满 `durationSeconds >= 3` 且 `drInfo.level === "Full"`;落地前
`ccTrinketAnalysis.ts` 既有的 `CC_AVOIDANCE_BUFF_SPELLS`/`REPOSITIONING_SPELL_IDS`(经
`GROUND_CC_SPELL_IDS`/`TARGETED_CC_DODGE_SPELLS`/`MAGIC_ONLY_IMMUNITY_IDS`×
`PHYSICAL_CC_IDS`/`DRUID_FORM_BUFFS` 门控,语义与 `ccAvoidedInstances` 同源,提取为新增
导出 `applicableCCAvoidanceIds`)里至少一个技能同时满足:①kit 证据(本场至少成功施放过
一次)②`cdAvailableAt` 判定落地时刻已转好。

**去重门(硬性)**:排除 `trinketState === "available_unused"` 的实例——该状态已由
`cc-locked`/`wasted-trinket` 两个既有候选覆盖,同一实例绝不双重开罪。

**cap**:2/轮,按 CC 时长降序(与 `cc-locked` 同排序哲学:保住最重的)。

**facts**:`t`(floor 到渲染秒)、`spell`(吃的 CC)、`durationS`、`avoidableWith`(可用
规避技名,顿号 `、` 连接;多技能顺序取 `applicableCCAvoidanceIds` 的固定 Map 迭代序,
确定性)。不含 `trinketState`/`trinketNote`——已被去重门排除,不需要。

**图例措辞(防因果断定)**:「落地前 X 可用——可用于规避此类控制」,不写「本可避免」/
「因此」。理由:是否使用规避技本身可能是合理的资源取舍(留着应对更大威胁),门规不能
把「可用未用」直接翻译成「用了就能免」。

### 实证数字(200 场 / 635 治疗 owner 轮,`.defensive-rates-report.md` 原始调查 + 本次按最终实现代码复扫,两者独立吻合)

```
原始判据(未排除 trinket 重叠):
  Full-DR >=3s CC 事件: 2398
  命中事件: 269 (11.2%)      命中轮: 105/635 (16.5%)
  与 trinketState=available_unused 重叠: 173/269 (64.3%)

最终判据(排除重叠 + cap 2/轮,调用真实 ccAvoidableEvents/ccAvoidanceOptionsAt 复扫):
  原始去重后事件(未 cap): 96   ——  sanity check: 269 − 173 = 96,吻合
  实际会产出的条数(cap 后): 78
  命中轮: 59/635 (9.3%)
```

按规避技分布(原始 269 命中事件):Divine Shield 168(62%)、Blessing of Protection 46、
Blessing of Spellwarding 43、Angel's Feather 42、其余(Chi Torpedo/Rescue/Spirit
Walk/Blessing of Freedom/Divine Steed/Tiger's Lust)合计 22。Paladin 系三技能
(Divine Shield + Blessing of Protection + Blessing of Spellwarding)合计 257/269
= **96%**——如实记,不是 bug。

命中轮按专精(最终判据,去重+cap 后):Holy Paladin 33/98(33.7%)、Discipline Priest
14/194(7.2%)、Mistweaver Monk 6/88(6.8%)、Restoration Shaman 2/58(3.4%)、
Holy Priest 2/60(3.3%)、Preservation Evoker 2/62(3.2%)、Restoration Druid 0/75
(0%——kit 里唯一可能适用的 Stampeding Roar 位移,本样本从未同时满足"CC 落地前转好 +
落地是可位移躲开的类型")。Holy Paladin 浓度高但非病态:该专精拥有 Divine Shield +
Blessing of Protection + Blessing of Spellwarding 三件规避利器,其余专精普遍只有位移
技(适用面更窄,见 `applicableCCAvoidanceIds` 的定点 CC 门控)。

## DEFENSIVE-002(低血不循环小减伤)—— 数据否决

**表来源**:100% 派生自既有 `MITIGATION_TABLE`(`pct<=30` 或 `cooldownSeconds<=60` 子集,
14 条),零新建。

**否决理由(三点,任一都够,叠加更实锤)**:

1. **发生率触底**:HP<50%(三档阈值里最宽的一档)下全库仅 **3 个命中轮 / 264 可判定轮
   = 1.1%**——低于 `signal-expansion-batch1` 已落地四类里最低的 `healing-gap`
   (5.3% 轮)先例线,且没有再放宽的余地(HP<35%/40% 两档更低,0.4%/0.8%)。
2. **两专精结构性零适用**:Discipline Priest(194/194 轮,100%)与 Holy Priest
   (60/60 轮,100%)在小减伤定义下**永不可能**产出 DEFENSIVE-002——Holy Priest 是
   `MITIGATION_TABLE` 里零条目适用的硬结构问题;Discipline Priest 虽有 1 条
   Power Word: Barrier 名义适用,但下一条数字说明它实质等于零。
3. **戒律唯一条目形同虚设**:Power Word: Barrier 在整个 **808 场**库里全局仅
   **8 场**出现过成功施放(与 owner 是否 Discipline 专精无关)——命中概率趋近于
   0,不是门槛能调回来的问题。

**结论**:不新增类型,不做字段升维(不同于 DISPEL-002 的先例——那次是"有体量但不足以
单开类型",这次是"体量本身就不存在")。BACKLOG #18 第 3 项就此标记"数据否决"关闭,
不再等待用户拍板门槛;若未来 `MITIGATION_TABLE` 扩容覆盖 Holy Priest/Mistweaver,可
重新评估。

## 验收

- 单测(TDD,`packages/analysis/src/analysis/candidateFindings.test.ts` +
  `packages/analysis/test/ported/ccTrinketAnalysis.test.ts`):`applicableCCAvoidanceIds`
  的学派门/德鲁伊变形门/落地型-定点型门边界;`ccAvoidanceOptionsAt` 的 kit 证据门
  +CD 可用门(含"证据来自落地后一次施放"这一非直觉分支);`ccAvoidableEvents` 的
  full-DR 门/`>=3s` 门/trinket 重叠去重门/cap 保最重;端到端(`extractCandidateFindings`)
  治疗-only 门(非治疗 owner 同场景零产出)。既有全绿(analysis 1106、desktop 1167)。
- 语料复扫(同 200 场判据,调用真实实现):96 条(去重未 cap)/ 78 条(cap 后)/
  59/635 轮(9.3%),与本文档数字一致。
- `PROMPT_VERSION` 20→21(`packages/desktop/src/shared/promptVersion.ts`)。
- 桌面防腐测试(`packages/desktop/test/report.mistakes.test.tsx`)逼出的两处注册:
  `MISTAKE_RULES`(`mistakes.ts`,label「规避手段可用未用」,severity minor,与
  `cc-held` 同"机会成本"框架)、`TYPE_LABEL`(`findingDisplay.ts`)。
