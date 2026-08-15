# Ability Fact Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "what can be pressed while CC'd" from 6 hand-written priors into a SpellMisc flag-driven generated table (three-line evidence cross-verification), establish a user sign-off system for unofficial facts, survey the official effect data surface, and fix broken links in the name table — eliminating the largest source of the 17% spec layer error rate exposed by the spec audit.

**Architecture:** Copy the DR officialization (commit 028e625) seven-step method: empirical anchoring → official mining → three-party diff → retain gaps by hand → shim consumption → two-way error check on corpus. The new datagen script enters the existing pipeline (manifest registration + anti-corruption tests), consumers switch via a thin shim, and behavior tests remain green.

**Tech Stack:** 既有 datagen 基建(`packages/analysis/scripts/datagen/lib/wagoCsv.ts` 的 CSV 拉取/列断言/resolveBuild)、tsx、vitest。

**Spec:** `docs/superpowers/specs/2026-08-14-ability-fact-grounding-design.md`

## Global Constraints

- **官方数据能用尽用;非官方的、拿不准的事实必须经用户签字**(带 `approved: "<日期> user"` 字段,无签字条目 CI 红)。
- **标志位解读不做假设**:锚定清单驱动搜索,对不上锚点 → 停,报告,不出表(spec B1 第 1 步)。
- 遗留大表(SPELL_CATEGORIES/classSpells)不逐条签字——登记「遗留未审」;签字义务只覆盖新增与被审计标记条目。
- datagen 惯例全守:build 经 `resolveBuild()` 单源;生成物三标记惯例之一(文件名 Generated/头注释/generatedAt 字段)+ `datagen-manifest.json.artifacts` 注册(否则 `datagenManifest.test.ts` 红);修正层恒在生成层之上;「官方 ≠ 免验」——上线前语料双向误差数字。
- 谓词索引双语成对:`docs/predicate-index.md` 与 `.zh-CN.md` 必须同改等价;`predicateIndex.test.ts` 按既有模式登记新符号。
- 类型检查 `npm run typecheck`(绝不 tsc -b);push 前 `npm test --workspaces && npm run typecheck && npx eslint . --quiet`。
- 提交直接 commit+push main;每 task 一个 commit。
- **两个用户签字暂停点**(plan 内标注 PAUSE):Task 2 后(锚定清单)、Task 4 后(三方 diff 分歧清单)。控制器负责呈报,用户批准前后续 task 不开工。

## 数据契约(全计划共用)

```ts
// packages/analysis/src/data/usableWhileCcGenerated.ts(Task 3 产出;生成文件,勿手改)
// 2026-08-14 范围修订:feared 经穷举被结构性证伪(SpellMisc 纯 OR 位任意组合无解)、
// confused 锚点不足——两维度按 spec「缺口保手写」条款留手写层,生成表只出 stunned。
export const USABLE_WHILE_CC_GENERATED: {
  stunned: ReadonlySet<string>; // 晕中可施放的 cast spellId
};

// packages/analysis/src/data/curatedAbilityFacts.ts(Task 6 产出;签字册)
export interface ICuratedAbilityFact {
  id: string; // spellId 或 talent spellId
  claim: string; // 一句中文事实断言
  kind: "talent_effect" | "usable_while_cc_gap" | "usable_while_cc_conditional" | "mechanic" | "cost_norm";
  requiresTalent?: string; // conditional 类:授权 PvP 天赋 spellId(2026-08-14 用户设计:被控可用可为天赋条件性)
  source: string; // 出处(官方 tooltip/wowhead 链接/裁决记录)
  approved: string; // "YYYY-MM-DD user" —— 无此字段的条目测试红
}
export const CURATED_ABILITY_FACTS: ICuratedAbilityFact[];
```

---

### Task 1: A1+A2 —— 断言清册落档 + 官方效果面普查

**Files:**

- Create: `docs/ability-fact-inventory.md`
- Create: `packages/analysis/scripts/datagen/dumpTableColumns.ts`(一次性侦察工具,归档保留)

**Interfaces:**

- Consumes: `lib/wagoCsv.ts` 的表拉取助手(先读该文件与 `genDrCategories.ts` 学调用方式;列名断言惯例照抄)。
- Produces: inventory 文档(后续每 task 更新它);A2 普查出的「未挖效果候选池」章节。

- [ ] **Step 1: 写侦察脚本**——`dumpTableColumns.ts`:对候选表列表(`SpellMisc`、`SpellAuraOptions`、`SpellInterrupts`、`SpellShapeshift`、`SpellCastingRequirements`、`SpellCategories`、`SpellEffect`、`SpellAuraRestrictions`、`SpellTargetRestrictions`)逐个经 wagoCsv 拉当前 build(`resolveBuild()`)的 CSV 头行,打印每表全部列名。**列名必须来自真实拉取,不许凭记忆写**。跑一遍,输出存档到文档。

- [ ] **Step 2: 写 `docs/ability-fact-inventory.md`**,两大章:
  1. **断言清册(A1)**:三档分类表,内容以 2026-08-14 探查为底(cooldowns.ts 一族逐表:MAJOR_DEFENSIVE_IDS 39 / EXTERNAL 14 / CD_ROLE_TAGS 7·无测试 / TEAM_HEAL 8 / ADDITIONAL_OVERLAP 12 / USABLE_WHILE_CC 6 / FORBEARANCE 4 / PASSIVE_BLOCKLIST 8·按名匹配 / SPEC_EXCLUSIVE / NON_SUBSTITUTE / SELF_CAST_NOOP / THROUGHPUT_EMPOWER;spellIdLists 三表;SPELL_CATEGORIES 163;classSpells 132 D/O/C;驱散五套 spec 集合;talentBehaviors 23;spellEffectOverrides 22;racialAbilities 41;drCategories 手写 disarm/knockback;mitigationData overrides 12 + NO_MITIGATION 15;spellCategories 的 kickLockoutSeconds)——每行:文件:行、条数、档位(官方背书/手工/纯先验)、测试覆盖、消费方。逐条与源码核对行号,不照抄旧探查。
  2. **官方效果面普查(A2)**:Step 1 拉到的每表每列(Attributes 族按列列出),标「管线已挖(哪个脚本)/ 未挖」;未挖项一行评估:「能解锁什么分析 + 建议进管道(是/否/待议)」。重点评估:Attributes 标志族(被控可用/免疫类/不可打断类)、SpellInterrupts(打断锁定学派)、SpellAuraOptions(proc 概率/层数)、SpellShapeshift(形态限制)。

- [ ] **Step 3: 自查**——文档内每个「文件:行」抽 5 处用 Read 核对仍准确;A2 列名与 Step 1 输出一致。

- [ ] **Step 4: Commit**

```bash
git add docs/ability-fact-inventory.md packages/analysis/scripts/datagen/dumpTableColumns.ts
git commit -m "docs(analysis): 技能事实断言清册 + 官方效果面普查(A1+A2)"
```

---

### Task 2: 锚定清单提案(→ PAUSE 用户签字)

**Files:**

- Create: `packages/analysis/scripts/datagen/usableWhileCcAnchors.ts`

**Interfaces:**

- Produces: `export const UWC_ANCHORS: Array<{ spellId: string; name: string; stunned: boolean | null; feared: boolean | null; confused: boolean | null; rationale: string }>`(`null`=该维度不作锚定)。Task 3 的搜索算法消费它;`approvedBy` 常量待用户批准后由控制器代填。

- [ ] **Step 1: 起草锚定清单**(12-16 条,覆盖正反例与三个维度),必须包含:
  - 角斗士的勋章 336126:stunned=true(勋章设计用途;2026-08-14 语料实证 5 次晕中施放);
  - 圣盾术 642:**stunned=false**(2026-08-14 用户裁决「圣盾晕中开不出」——注意:现手写表 `USABLE_WHILE_CC_SPELL_IDS` 含 642,与裁决正面冲突,rationale 里写明这是待官方位/语料仲裁的一号分歧);
  - 现手写表其余 5 条(33206 痛苦压制 / 22812 树皮术 / 47585 消散 / 55233 吸血鬼之血 / 48792 冰固坚韧)各自的预期值与出处;
  - 反例:圣光术(硬读条治疗,stunned=false)、制裁之锤(stunned=false);
  - 恐惧维度锚点:小鬼献祭/不灭意志类各 1-2 条,出处写明;拿不准的维度填 null,别硬填。
    每条 rationale 一句、出处一条。
- [ ] **Step 2: typecheck 过**(`npm run typecheck`),commit:

```bash
git add packages/analysis/scripts/datagen/usableWhileCcAnchors.ts
git commit -m "feat(datagen): 被控可用锚定清单提案(待用户签字)"
```

- [ ] **Step 3: PAUSE** —— 报告控制器:锚定清单全文 + 642 冲突说明,呈用户逐条批。**Task 3 在用户批准前不开工**;用户改判的条目按其裁决改后再 commit(message 注明裁决日期)。

---

### Task 3: B1 —— genUsableWhileCc 官方挖掘(锚定驱动的位搜索)

**Files:**

- Create: `packages/analysis/scripts/datagen/genUsableWhileCc.ts`
- Create: `packages/analysis/src/data/usableWhileCcGenerated.ts`(脚本产出)
- Modify: `packages/analysis/src/data/datagen-manifest.json`(artifacts 注册)
- Modify: `docs/commands/update-wow-data.md`(脚本清单加一行,按既有顺序表格式)
- Test: `packages/analysis/test/datagen/usableWhileCc.test.ts`

**Interfaces:**

- Consumes: `UWC_ANCHORS`(已签字版);wagoCsv 助手;`resolveBuild()`。
- Produces: `USABLE_WHILE_CC_GENERATED`(数据契约签名);生成文件带 `Generated at:` 头注释。

- [ ] **Step 1: 写失败测试**——锚点一致性(核心安全网):

```ts
// packages/analysis/test/datagen/usableWhileCc.test.ts
import { describe, expect, it } from "vitest";
import { USABLE_WHILE_CC_GENERATED } from "../../src/data/usableWhileCcGenerated";
import { UWC_ANCHORS } from "../../scripts/datagen/usableWhileCcAnchors";

describe("usableWhileCcGenerated anchors", () => {
  it("every signed anchor matches the generated sets", () => {
    for (const a of UWC_ANCHORS) {
      if (a.stunned !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.stunned.has(a.spellId),
          `${a.name} stunned`,
        ).toBe(a.stunned);
      if (a.feared !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.feared.has(a.spellId),
          `${a.name} feared`,
        ).toBe(a.feared);
      if (a.confused !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.confused.has(a.spellId),
          `${a.name} confused`,
        ).toBe(a.confused);
    }
  });
  it("sets are non-trivial (each has >20 spells at current build)", () => {
    expect(USABLE_WHILE_CC_GENERATED.stunned.size).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: RED**(模块不存在)。
- [ ] **Step 3: 实现 `genUsableWhileCc.ts`**。算法(锚定驱动,不假设列位):
  1. 拉 `SpellMisc` 全部 `Attributes_N` 列(先经 Task 1 的列名存档确认实际列名)+ `SpellID`/`DifficultyID`,`DifficultyID==="0"` 过滤;
  2. **搜索**(2026-08-14 修订:实测单一位对 13 锚全维度 0 候选——真值疑为多授权路径并集):对每维度先搜单一 (列 N, 位 b) 100% 一致候选;无 → 升级搜 **≤2 位并集**(位A ∪ 位B 的覆盖集与全部非 null 锚点一致);采纳准则=最小位数的一致并集;同尺寸多解 → 优先跨维度共享位的解(家族一致性),仍歧义 → `console.error` 报告全部候选与失配锚点,`process.exit(1)` 不出表。生成文件头注明每维度采用的位组合与其锚点覆盖账。
  3. 生成 `usableWhileCcGenerated.ts`:头注释含 build、采用的 (列,位)、锚点数;三个 ReadonlySet;
  4. 与 `spellNames.json` 交叉:集合成员打名字进头注释统计(便于人工抽查),名字缺失的计数警告。
- [ ] **Step 4: 跑脚本 → GREEN**(锚点测试过;记录三集合大小)。manifest 注册 + `datagenManifest.test.ts` 绿。update-wow-data.md 加行。
- [ ] **Step 5: 全量检查**(`npm test --workspace=@gladlog/analysis && npm run typecheck`),commit:

```bash
git add packages/analysis/scripts/datagen/genUsableWhileCc.ts packages/analysis/src/data/usableWhileCcGenerated.ts packages/analysis/src/data/datagen-manifest.json packages/analysis/test/datagen/usableWhileCc.test.ts docs/commands/update-wow-data.md
git commit -m "feat(datagen): 被控可用表官方化——SpellMisc 标志位锚定搜索(手写 6 → 官方 N)"
```

---

### Task 4: 语料观测线 + 三方 diff(→ PAUSE 用户裁决分歧)

**Files:**

- Create: `packages/eval/scripts/uwcCorpusScan.ts`(薄壳)+ `packages/eval/src/explore/uwcObserved.ts`(逻辑)
- Test: `packages/eval/test/explore.uwcObserved.test.ts`

**Interfaces:**

- Consumes: 本地对局库 raw.txt(`DEFAULT_MATCH_DIR`;`loadIndex` 选 N≥50 场);`DR_CATEGORIES_GENERATED.stun`(晕类 aura id 集,来自 `@gladlog/analysis/src/data/drCategories`);`USABLE_WHILE_CC_GENERATED`。
- Produces: `observedCastsWhileStunned(rawText: string, stunAuraIds: ReadonlySet<string>): Map<string, number>`——解析 raw 行,维护每单位活跃晕 aura 区间(SPELL_AURA_APPLIED/REMOVED,spellId ∈ stun 集),统计区间内该单位 `SPELL_CAST_SUCCESS` 的 spellId 计数。

- [ ] **Step 1: 失败单测**——手工构造 6 行 raw 文本 fixture(APPLIED 晕 → CAST_SUCCESS 两条(一在晕内一在晕外)→ REMOVED),断言 Map 恰含晕内那条 spellId 计数 1。照 raw 行真实格式写 fixture(从任一 matches/*/raw.txt 抄一行改字段)。
- [ ] **Step 2: RED → 实现 → GREEN**。
- [ ] **Step 3: 薄壳跑全库**(N≥50 场,含 shuffle 整把),输出三方 diff 报告(stdout + 写 `$GLADLOG_EVAL_HOME/reports/uwc-diff.md`):
  - 观测集 ∩/− 官方集;**「官方说不可用但语料晕中施放过」逐条**(必须为 0 或逐条解释——瞬发豁免/晕后 0.x 秒时序误差等);
  - 官方集内语料从未观测的样本量说明(双向误差,官方≠免验);
  - 手写 6 条(含 642)在官方位与语料下的终判建议。
- [ ] **Step 4: Commit**:

```bash
git add packages/eval/scripts/uwcCorpusScan.ts packages/eval/src/explore/uwcObserved.ts packages/eval/test/explore.uwcObserved.test.ts
git commit -m "feat(eval): 被控可用语料观测线——晕中施放扫描 + 三方 diff 报告"
```

- [ ] **Step 5: PAUSE** —— 分歧清单呈用户裁决(尤其 642 终判)。用户裁决落 Task 6 签字册。

---

### Task 5: shim 化消费 + 谓词索引

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts:127` 区域(`USABLE_WHILE_CC_SPELL_IDS`)
- Modify: `docs/predicate-index.md` + `docs/predicate-index.zh-CN.md`(双语等价)
- Modify: `packages/eval/test/predicateIndex.test.ts`(登记符号)
- Test: `packages/analysis/test/usableWhileCcShim.test.ts`

**Interfaces:**

- Produces(2026-08-14 PAUSE 2 修订:条件层设计,用户确认):
  - `USABLE_WHILE_CC_SPELL_IDS` 语义改为 `stunned 生成集 ∪ 无条件手工缺口层`(导出名与消费方 `matchTimelineSections.ts:685` / `candidateFindings.ts:1816` 不变——shim 内换血,外部零改动;缺口层首条=圣佑术 498+403876,注 wowhead 旗标+语料 748 次+用户本职业三线源);
  - 新增导出 `usableWhileStunned(spellId: string, pvpTalentIds?: ReadonlySet<string>): boolean`(谓词索引登记):无条件集命中 → true;条件层 `USABLE_WHILE_CC_CONDITIONAL: Record<string, { requiresTalent: string; source: string }>`(首批候选=转世:转移 119996、雷霆风暴 51490,授权天赋 id 查证后经用户签字才生效)命中且 pvpTalentIds 含 requiresTalent → true;条件层命中但未传天赋上下文 → false(保守,函数注释写明方向);
  - 条件层在授权天赋 id 未签字前为空 Record(结构先落地,数据走 Task 6)。

- [ ] **Step 1: 失败测试**:shim = 生成 ∪ 缺口层(并集语义,照 drCategories shim 测试样式);旧 6 条中经 Task 4 终判仍成立的成员依然 `has`===true;642 按用户终判断言。
- [ ] **Step 2: RED → 实现**(cooldowns.ts 内 shim 化,DR 式注释:生成层来源、缺口层理由)→ GREEN;消费方既有行为测试(`candidateFindings.test.ts:673-704`、`context.timelineSections.test.ts:1076`)全绿——若 Ironbark(不在晕中可用)被官方位收入导致 1076 行红,按官方+语料证据与用户终判处理,不许静默改断言。
- [ ] **Step 3: 谓词索引双语加行(格式照既有行)+ predicateIndex.test.ts 登记;跑该测试绿。**
- [ ] **Step 4: 全量检查 + commit**:

```bash
git add packages/analysis/src/utils/cooldowns.ts packages/analysis/test/usableWhileCcShim.test.ts docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "feat(analysis): USABLE_WHILE_CC shim 化——生成层∪缺口层,usableWhileStunned 谓词入索引"
```

---

### Task 6: B2 —— 签字册与强制测试

**Files:**

- Create: `packages/analysis/src/data/curatedAbilityFacts.ts`
- Test: `packages/analysis/test/curatedFacts.test.ts`

**Interfaces:**

- Produces: 数据契约里的 `ICuratedAbilityFact` / `CURATED_ABILITY_FACTS`。

- [ ] **Step 1: 失败测试**:

```ts
import { describe, expect, it } from "vitest";
import { CURATED_ABILITY_FACTS } from "../src/data/curatedAbilityFacts";

describe("curated ability facts sign-off", () => {
  it("every entry carries a user approval stamp", () => {
    for (const f of CURATED_ABILITY_FACTS) {
      expect(f.approved, `${f.id} ${f.claim}`).toMatch(
        /^\d{4}-\d{2}-\d{2} user$/,
      );
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = CURATED_ABILITY_FACTS.map(
      (f) => `${f.kind}:${f.id}:${f.claim}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: RED → 实现**。首批条目(approved 填用户实际裁决日期):破蛹化蝶 202424「使复苏之茧冷却缩短 45 秒」(2026-08-14 裁决,来源=官方天赋数据+审计报告);静心织魂 353313「不修正复苏之茧冷却」(同);Task 4 用户终判的缺口层条目(如 642 终判)。文件头注释:签字流程说明(新增条目须经用户批,填日期;CI 强制)。
- [ ] **Step 3: GREEN + commit**:

```bash
git add packages/analysis/src/data/curatedAbilityFacts.ts packages/analysis/test/curatedFacts.test.ts
git commit -m "feat(analysis): 非官方技能事实签字册——approved 强制 CI,首批天赋效果条目"
```

---

### Task 7: B3 —— 活化烈焰名表断链修复 + 同类敞口扫描

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts`(`extractMajorCooldowns` 的 cast 归集处;先读代码定位)
- Create: `packages/eval/scripts/cdLedgerRotScan.ts`(薄壳)+ `packages/eval/src/explore/cdLedgerRot.ts`(逻辑)
- Test: `packages/analysis/test/` 内新增或扩展既有 cooldowns 测试

**Interfaces:**

- Consumes: match 76ea5f90(实证样本:Girlbye 的活化烈焰 flow 有施放而 cd 台账 casts 空)。
- Produces: 修复后该场重放 `cd` 查询,活化烈焰不再恒 ready;扫描脚本输出全库「flow 有施放 ∧ 台账 neverUsed」矛盾对计数。

- [ ] **Step 1: 复现**——写失败测试前先用 76ea5f90 真数据定位断链根因(cast spellId 与台账表键不一致?名表歧义?),报告根因再动手;若根因在生成表键空间,修法走数据层不走逻辑层(谓词规范)。
- [ ] **Step 2: 失败测试**(按根因形态:合成 fixture 断言该 spellId 的 casts 归集非空)→ RED → 修 → GREEN;76e 重放前后对比数字记 commit message。
- [ ] **Step 3: 扫描脚本跑全库**,矛盾对计数落 `$GLADLOG_EVAL_HOME/reports/cd-ledger-rot.md`(修复前后两个数字);residual 矛盾逐条列(下批修)。
- [ ] **Step 4: Commit**(message 带前后数字)。

---

### Task 8: B4 —— 消费方接线收尾 + 文档 + 全量门

**Files:**

- Modify: `docs/commands/deepdive-probe.md`(「被控可用」段改引 `usableWhileStunned` 谓词/生成表;规范来源纪律段加「机制级断言先查表」)
- Modify: `docs/ability-fact-inventory.md`(USABLE_WHILE_CC 迁档为官方背书;签字册/修复项登记)
- Modify: `docs/BACKLOG.md`(#26/#27 若被本项目部分覆盖则加注记;A2 普查候选池指针)

**Interfaces:** 纯文档接线;代码消费方已在 Task 5 完成。

- [ ] **Step 1: 三份文档改好**(手册的机制纪律段落把「被控能按什么」从模型先验改为「先跑谓词查表,表没有的才标先验」)。
- [ ] **Step 2: 全量门**:`npm test --workspaces && npm run typecheck && npx eslint . --quiet` 全绿(timeouts 600000ms)。
- [ ] **Step 3: Commit + push**:

```bash
git add docs/commands/deepdive-probe.md docs/ability-fact-inventory.md docs/BACKLOG.md
git commit -m "docs: 技能事实地基收尾——深挖纪律接线查表,清册迁档"
git push
```

---

## 完成定义

- 被控可用:手写 6 → 官方 N(+语料观测线),三方分歧全部经用户裁决,双向误差数字在案;
- 签字册 CI 强制生效,首批条目入册;
- 活化烈焰断链修复带前后数字,同类敞口计数在案;
- inventory 文档成为常设敞口台账;A2 候选池待用户挑选下批 datagen 扩展。
