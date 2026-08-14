# 技能事实地基挂账清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉技能事实地基项目与深挖实验在册的六件挂账(cd 台账残余/光环截断/dr 反向/代价规范接线/feared 观测线/tsconfig 债),每件按其审查记录里已定的修法方向执行,带前后数字。

**Architecture:** 全部是既有模式的复用:Task 7 的根因诊断法、DR shim 的谓词单源法、uwcObserved 的观测线法、守护注法。无新架构。范围外:BACKLOG #26(raw 双流进 parser,独立立项)。

**Tech Stack:** 既有(tsx/vitest/datagen 基建/eval 扫描工具)。

## Global Constraints

- 谓词单源铁律;修复给前后数字;非官方事实经用户签字(feared 观测产出的候选集必须呈签,PAUSE);双语对(predicate-index 改动 en/zh 等价);产品消费方行为测试保持绿,官方数据驱动的断言变化如实报不许静默改;commit 直提 main 每 task 一个,**push 后验证输出**;全量门 `npm test --workspaces && npm run typecheck && npx eslint . --quiet`;长扫描分批前台批间落盘(timeout 550000/批)。

---

### Task A: cd 台账残余 16 技能根因清账

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts`(`AURA_ONLY_ACTIVATION_IDS` 扩表,凡确诊 aura-only 类)
- Modify/Extend: `packages/analysis/test/cooldowns.auraOnlyActivation.test.ts`
- Create: 逐技能诊断记录进 `$GLADLOG_EVAL_HOME/reports/cd-ledger-rot-batch2.md`

**Interfaces:** Consumes 现有 `cdLedgerRot` 扫描工具与 `reports/cd-ledger-rot.md` 的残余清单(16 技能 121 条:Stampeding Roar 75 / Cloak of Shadows 9 / Incarnation / Avenging Wrath / Trueshot / Ascendance / Shadow Blades / Power Infusion / Ironbark / Evasion / Aura Mastery / Survival Instincts / Icebound Fortitude / Ice Barrier / Arcane Surge / Adrenaline Rush)。

- [ ] **Step 1:** 逐技能取 2-3 条矛盾样本(扫描报告里有 match/时刻),回 raw.txt 核对:该时刻有无 SPELL_CAST_SUCCESS(cast id 或天赋克隆 id)?光环 id 与 cast id 关系?分类:(a) aura-only/克隆 id 断链 → 补 `AURA_ONLY_ACTIVATION_IDS` 或 cast-id 映射;(b) 赛前预铺光环(无窗内施放)→ 非缺陷,记录;(c) 他源光环(外置授予,如 Power Infusion 他人施放)→ 归集须按 srcGUID 归施放者,查现逻辑是否已对,错则修;(d) 其他,逐条写明。**不许拍脑袋归类,每技能给样本证据行。**
- [ ] **Step 2:** 确诊 (a) 类逐条补表(注来源与样本),每条加合成 fixture 测试;(c) 类如需修逻辑,TDD。
- [ ] **Step 3:** 重跑全库扫描(分批前台),`121 → N_after` 进 commit message;batch2 报告落盘(逐技能处置表)。
- [ ] **Step 4:** analysis 套件 + typecheck 绿;commit `fix(analysis): cd 台账残余批二清账——121→N(逐技能根因)` + trailers;push 验证。

### Task B: #27 aurasActiveAt 截断修复

**Files:**

- Modify: `packages/analysis/src/analysis/momentSnapshot.ts:72-77`(`aurasActiveAt`)
- Test: momentSnapshot 现有测试文件扩展(或新建 `packages/analysis/test/momentSnapshot.aurasPriority.test.ts`)

**Interfaces:** 修法按 BACKLOG #27 已定方向:截断前按类别优先级排序——硬控(`DR_CATEGORIES_GENERATED` 全类别命中的 aura id)> 免疫/大 CD 光环(`MAJOR_DEFENSIVE_IDS`/`IMMUNITY` 类现有表)> 其余;上限保持 10 但排序保证关键光环恒入列;分类判定全部复用现有表,不新建白名单。

- [ ] **Step 1:** 失败测试:合成 12 个光环(1 个晕类 + 1 个免疫 + 10 个杂项),断言晕与免疫必在返回列表(旧实现 slice(0,10) 按遍历序会挤掉)。
- [ ] **Step 2:** RED → 实现排序 → GREEN;两个消费方(auras 查询 / deep-dive snapshot pack)行为测试绿;76ea5f90 重放 `auras --t 168` 冰冻陷阱可见(修前不可见)——前后对照进 commit message。
- [ ] **Step 3:** BACKLOG #27 注记「已修(commit)」;谓词索引若该谓词在册则双语注记更新。commit `fix(analysis): aurasActiveAt 优先级排序截断——硬控/免疫恒入列(#27)` + trailers;push 验证。

### Task C: #24 dr 反向修复

**Files:**

- Modify: `packages/analysis/src/utils/drAnalysis.ts:441` 区域(`analyzeOutgoingCCChains` 目标方过滤)
- Test: `packages/analysis/test/`(drAnalysis 现有测试扩展)

**Interfaces:** 修法按 BACKLOG #24 已定方向:目标过滤从硬编码 `reaction === Hostile` 改为「属于传入的第二参数(enemies)集合的玩家单位」——产品现有调用 `(friends, enemies)` 行为不变(平价测试钉住:现有 dr 测试全绿 + 新增一条正向语义不变测试);反向调用 `(enemies, friends)` 恢复有效。

- [ ] **Step 1:** 失败测试:反向调用合成 fixture(敌方晕友方一次),断言返回非空且字段正确(旧实现返回空)。正向语义平价测试:同 fixture 正向调用结果与改前快照一致。
- [ ] **Step 2:** RED → 修 → GREEN;全部 drAnalysis/dr 相关测试绿(谓词索引在册符号,跑 predicateIndex 测试)。
- [ ] **Step 3:** 真数据验收:`matchExplore 76ea5f90 dr --from 0 --to 188` 出现敌方→友方行(修前 0 条)——前后数字进 commit message;BACKLOG #24 注记已修。commit `fix(analysis): CC 链目标方按传参集合过滤——dr 反向恢复(#24)` + trailers;push 验证。

### Task D: #25 cost_norm 守护注接线

**Files:**

- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.ts`(usable_in_cc 事实的解释文案处,先读 :34 一带现状)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts`(`deathUnusedDefensiveEvents`/相关 facts 产出处)
- Test: 对应测试文件扩展

**Interfaces:** 修法按「候选门会被富上下文绕过→同谓词守护注」先例:凡 facts 里出现的技能命中签字册 `kind === "cost_norm"` 条目(消费 `CURATED_ABILITY_FACTS`,单源 import,现零消费方),候选 facts 附 `costNorm` 事实(如 `costNorm: "大技能,不推荐常规挡控"` 短语从册条 claim 派生或定短码),prompt 侧解释该字段含义(模型据此不产「该用圣盾挡锤」类建议)。深挖手册决策点卡一节加一句「cost_norm 在册技能的『该交 X』建议必须带代价注」。

- [ ] **Step 1:** 失败测试:合成候选含 642,断言 facts 带 costNorm 字段;不在册技能无该字段。
- [ ] **Step 2:** RED → 实现(候选层 + prompt 解释行)→ GREEN;现有候选/prompt 测试绿。
- [ ] **Step 3:** BACKLOG #25 注记「消费方已接线(commit)」;手册加句;commit `feat(analysis): cost_norm 守护注接线——签字册首个消费方(#25)` + trailers;push 验证。

### Task E: feared/disorient 语料观测线(→ PAUSE 呈签)

**Files:**

- Modify: `packages/eval/src/explore/uwcObserved.ts`(泛化:CC 类别参数化)
- Modify: `packages/eval/scripts/uwcCorpusScan.ts`(`--category stun|fear|disorient|incapacitate` 旗标)
- Test: `packages/eval/test/explore.uwcObserved.test.ts` 扩展

**Interfaces:** 现有 `observedCastsWhileStunned(rawText, stunAuraIds)` 已按注入的 aura 集工作——泛化为按 `DR_CATEGORIES_GENERATED` 任意类别注入(fear 对应 `disorient`?注意:**DR 类别名与游戏语义的映射先核对**——恐惧在 DR 表里属 disorient 类,incapacitate 是另一类;报告里写清类别口径)。跑 fear 系类别全库(N=1028,分批),产出「恐惧类硬控活跃期内的成功施放」观测集 + 与签字锚点 feared 维度对照报告。**产出候选清单呈用户签字(PAUSE)**:观测高频且样本干净(mid-window、玩家施放、非 proc 嫌疑逐条评)的 feared-usable 候选,签字后进签字册(kind usable_while_cc_gap 的 feared 变体——签字册 schema 若需扩 kind,加 `usable_while_feared_gap`)。**本 task 不改 shim/消费方**(feared 事实当前无消费方,观测+签字先行)。

- [ ] **Step 1:** 失败测试:泛化签名 `observedCastsInCc(rawText, auraIds)`(改名或参数化,旧名保薄别名防破坏 eval 内消费方),fixture 复用现有模式。
- [ ] **Step 2:** RED → 泛化 → GREEN;全库分批跑 fear 系;报告落 `$GLADLOG_EVAL_HOME/reports/uwc-feared-diff.md`(观测集/锚点对照/树皮-消散争议格的语料证据——用户意见 vs tooltip 这回有裁决数据了)。
- [ ] **Step 3:** commit `feat(eval): 语料观测线泛化——feared/disorient 类观测 + 报告` + trailers;push 验证;**PAUSE:呈签材料**(候选清单 + 树皮/消散争议格裁决建议)。

### Task F: tsconfig scripts/ 债 + 清册双语决定执行

**Files:**

- Modify: `packages/analysis/tsconfig.json` + `packages/eval/tsconfig.json`(include 补 `scripts`)
- Modify: 暴露的类型错逐个修(datagen/eval scripts 现存文件)
- Modify: `docs/ability-fact-inventory.md`(双语决定注记,按用户在 Task E PAUSE 一并给的答复执行;未答复则头部注「单语中文,暂不入双语对(2026-08-14)」)

**Interfaces:** 风险:两包 scripts/ 数十个文件从未过 typecheck,可能暴露一批错——**逐个修,不许 @ts-ignore 糊**;若某文件属实验遗留且无消费(核对后),可移 eval-private 归档代替修。CI 影响:root typecheck 走各包 tsconfig,include 扩大后 CI 同步生效——本地全绿即可。

- [ ] **Step 1:** 两包 include 加 `scripts`,跑 `npm run typecheck` 收集全部错误清单入报告。
- [ ] **Step 2:** 逐文件修(或归档,逐条注明);typecheck 全绿。
- [ ] **Step 3:** 全量门三绿;commit `chore: tsconfig 覆盖 scripts/——datagen/eval 脚本入类型检查` + trailers;push 验证。

---

## 完成定义

六件挂账各有前后数字/处置记录;BACKLOG #24/#25/#27 注记已修;feared 候选与树皮争议格经用户签字(或明确留待);#26 作为下一个独立项目立项待用户发起。
