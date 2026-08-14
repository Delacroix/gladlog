# 技能事实地基(ability-fact grounding)设计

日期:2026-08-14 · 状态:待用户审阅
用户拍板:立项;**官方数据能用尽用;非官方的、拿不准的事实必须经用户签字**。

## 背景与动机

深挖实验的全量规范审计(58 条规范性断言,10 条实质嫌疑,~17% 规范层错误率)暴露了结构性病灶:管线只核事实腿(预筛重放证据行),从不核规范腿。错误母题高度集中:

- 6 条机制级错误里 **3 条 = 「被控状态下能按什么」**(无敌挡晕、悬空消化晕、法防解锤);
- 2 例天赋效果张冠李戴(破蛹化蝶的茧减 CD 被安到静心织魂头上,连翻案环节都因此翻错);
- 1 例名表歧义(活化烈焰 cd 台账 casts 恒空,施放与「ready」并存)。

现状盘点(2026-08-14 探查):技能事实断言分三档——

1. **官方背书**:DR 表(genDrCategories,2026-07-25 官方化)、法术效果/耗时/CD(spellEffectGenerated 4909 条)、减伤系数(mitigationGenerated)、offGcd、图标/职业映射等 16 个 datagen 脚本产物,有 manifest 防腐测试;
2. **手工白名单**:cooldowns.ts 一族(MAJOR_DEFENSIVE_IDS 39/EXTERNAL 14/CD_ROLE_TAGS 7 无测试/TEAM_HEAL 8/…)、spellIdLists、SPELL_CATEGORIES 163 条、classSpells 132 条 D/O/C 手工标签、驱散能力五套 spec 集合;
3. **纯先验、零数据背书**:**`USABLE_WHILE_CC_SPELL_IDS` 仅 6 个手写 id**(cooldowns.ts:127)——而 SpellMisc 的 `Attributes_*` 标志列(官方 usable-while-stunned/feared/confused 位)全仓从未拉取;天赋效果因果(除 talentBehaviors.ts 23 条注明来源的条目外)散落在模型先验里。

模板先例:**DR 官方化 commit 028e625** 的七步法(实证锚定枚举 → 确立键空间 → 官方 vs 手表 diff → 承认无官方字段的缺口保手写 → 修正层恒在其上 → 同 commit 清理可退休表 → 官方≠免验的语料双向误差核查)。本项目照抄此法。

## 目标 / 非目标

**目标**

1. **A. 断言清册落档 + 官方效果面普查**(2026-08-14 用户扩范围):
   - A1 把探查产出的三档分类清册写成 `docs/ability-fact-inventory.md`(每表:文件:行、条数、档位、测试覆盖、消费方),作为敞口台账;后续每次官方化/签字都更新它;
   - A2 **普查官方效果数据面本身**:枚举与战斗分析相关的 DB2 效果承载表/列(SpellMisc 的 Attributes_0..15 全部标志族、SpellAuraOptions、SpellInterrupts、SpellShapeshift、SpellEffect 未挖的 aura 类型、SpellCategories 其余字段等),逐项标「管线已挖 / 未挖」,对未挖项写一行「能解锁什么分析 + 建议进管道与否」——覆盖地图并入 inventory 文档,作为后续 datagen 扩展的候选池。
2. **B1. 被控可用表官方化(最高优先)**:新 datagen 脚本挖 SpellMisc Attributes 标志位 → `usableWhileCcGenerated.ts`(按控制类别分集:晕中可用/恐惧中可用/迷惑中可用);`USABLE_WHILE_CC_SPELL_IDS` 降级为 DR 式薄 shim(生成层 ∪ 手工缺口层)。
3. **B2. 非官方事实册(签字机制)**:扩展 talentBehaviors.ts 模式为正式制度——凡无官方字段背书的技能/天赋事实断言,进带批准标记的 curated 条目:`{claim, source, approved: "<日期> user"}`;一致性测试强制:**无 approved 字段的条目 CI 红**。破蛹化蝶/静心织魂修正作为首批条目入册。
4. **B3. 名表歧义修复**:活化烈焰类「cd 台账 casts 恒空」的施法/光环双 id 断链,按 rotScan 惯例逐条喂回 extractMajorCooldowns 的 cast 匹配;至少修复已实证的活化烈焰例。
5. **B4. 消费方接线**:深挖手册的机制纪律、规范审计层、候选层守护注改为引用新表(「被控能按什么」从模型先验变成机器可查)。

**非目标**

- 不审计全部 4909 法术的完整语义——只覆盖管线**实际断言过**的事实面;
- 不做天赋效果的全量建模(talentModifiers 已覆盖 CD 修正类;效果语义只进签字册,按需增补);
- SPELL_CATEGORIES 163 条与 classSpells 132 条 D/O/C 标签**不要求用户逐条签字**——登记为「遗留未审」档,靠官方 diff 与语料扫描按消费方影响排序逐步烧减;签字义务只覆盖**新增条目与被审计标记的存量条目**(否则签字制度第一天就把用户淹死);
- POSITION_MISTAKES(事件分类学,非游戏数据断言)不在范围。

## 设计

### B1 被控可用表(照 DR 七步法)

1. **实证锚定标志位**:SpellMisc 的 Attributes 列序与位含义不做假设——先拉表,对**锚定清单**验证解读:角斗士勋章(336126)晕中可用=真、圣盾术(642)晕中不可用=真(2026-08-14 用户裁决)、冰脉护腕类… 锚定清单本身经用户签字。位解读对不上锚点 → 停,报告,不出表。
2. **键空间**:与 log 施法事件对齐用 cast spellId;与 DR 表不同(那边是 aura id),此表消费方(候选层/深挖)判「能不能按」,键=施放 id。
3. **三线证据**:官方标志位 ∪ 语料观测(raw 的 SPELL_CAST_SUCCESS 发生在硬控光环活跃期内 = 实证晕中可用——我们独有的第三条证据线,自由臂管线现成)∪ 现手写 6 条;三方 diff,分歧逐条列给用户裁决。
4. **缺口保手写**:官方位覆盖不到的类别(如缴械中可用)保持手写层,注明。
5. **修正层恒在生成层之上**(DB2 怪癖修正不写进生成器)。
6. 输出:`usableWhileCcGenerated.ts`(`{ stunned: Set<id>, feared: Set<id>, confused: Set<id> }`)+ shim 改造 `cooldowns.ts:127` + manifest 注册 + 谓词索引登记(双语)。
7. **官方≠免验**:上线前跑语料双向误差(官方说可用但语料从未见晕中施放的样本量、官方说不可用但语料出现过的矛盾例——后者必须为 0 或逐条解释)。

### B2 签字机制

- 文件形态:扩展 `talentBehaviors.ts` 同款结构(或并列新文件 `curatedAbilityFacts.ts`),每条:`{ id, claim, kind, source, approved }`。
- 测试:`test/curatedFacts.test.ts` 断言每条有 `approved`;新增未签字条目 → CI 红;签字流程 = 用户在 PR/会话里逐条「批」,日期入档(先例:MITIGATION_OVERRIDES 每条带来源+用户拍板日期)。
- 首批条目:破蛹化蝶(202424,茧 -45s)、静心织魂(353313,不修正茧 CD)、圣盾晕中不可施放(若 B1 官方位覆盖则归 B1)。

### B3/B4

- B3:以活化烈焰为实证样本,定位 extractMajorCooldowns 的 cast 归集为何漏(id 断链/名表歧义),修复 + 单测;顺带跑一次全量 cd 台账「ready 与施放并存」扫描(rotScan 式)量化同类敞口。
- B4:深挖手册「被控可用」段改引新表;规范审计提示词加「先查 usableWhileCc 表再引机制」;候选层 1816 行的 usable_in_cc 事实改为 shim 供数。

## 验收(修复要给前后数字)

- 被控可用表:手写 6 → 官方+语料 N;三方 diff 的分歧清单及裁决记录;语料双向误差数字;候选层/深挖消费方切换后现有测试全绿。
- 名表修复:活化烈焰 casts 空 → 非空(该场重放);同类扫描的敞口计数。
- 签字册:0 条无批准条目(CI 强制)。
- 审计清册落档,谓词索引与双语对更新。

## 测试

- datagen 脚本:锚定清单断言测试(锚点解读错 → 红);
- shim:生成 ∪ 手工的并集语义与 DR shim 同款测试;
- 签字册:approved 强制测试;
- 消费方:candidateFindings usable_in_cc 分支既有行为测试保持绿。
