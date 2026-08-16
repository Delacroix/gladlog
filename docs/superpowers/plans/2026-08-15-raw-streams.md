# raw 双流(法力值 + SPELL_CAST_FAILED)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分析层直读 raw.txt 的两条被 parser 丢弃的流(逐事件法力 + SPELL_CAST_FAILED),落地单源 `rawStreams` 模块、意图守护(cd-hoarded 冤枉修正,直接生效)、两个新候选类型(mana-pressure / mana-efficiency,开关默认关,走标定+独立 A/B)、深挖子命令。

**Architecture:** 零 parser 改动零库迁移;`packages/analysis/src/utils/rawStreams.ts` 是 raw 行解析唯一点(eval 的 uwcObserved 原有行解析重构为消费它);候选/守护/深挖/标定全部消费同一模块。Spec: `docs/superpowers/specs/2026-08-15-raw-streams-design.md`。

**Tech Stack:** 既有(vitest、candidateFindings 惯例、CANDIDATE_TYPE_FLAGS、eval corpus 工具、wagoCsv datagen)。

## Global Constraints

- raw 缺失优雅降级:所有消费方在 `available:false` 时静默保持原行为,绝不 throw(红线测试)。
- 渲染网格:进 prompt facts 的时刻/时长先 `toRenderSecond` floor 再派生;fixture 用小数时刻。
- 谓词单源:raw 行解析/时间戳换算只在 rawStreams;uwcObserved 重构消费之,不留第二份;谓词索引双语登记 + predicateIndex.test.ts。
- 新候选默认开关关(`CANDIDATE_TYPE_FLAGS` 扩 `manaPressure`/`manaEfficiency`),开关全关生产零变化(负断言测试);阈值常量标 `<标定定稿>`。
- 意图守护无开关直接生效(只加事实/降误报,不加输出面)。
- eval 批量 responder/judge 固定 sonnet;判官参考,主判据确定性指标。
- 子代理执行纪律第一条:长命令/扫描一律前台分批(10-15 场/批,timeout 550000),批间落盘续跑,**绝不后台等通知**。
- 修复给前后数字;commit 直提 main 每 task 一个,push 后验证输出;全量门 `npm test --workspaces && npm run typecheck && npx eslint . --quiet`。
- 标定/A/B 报告落 `$GLADLOG_EVAL_HOME/reports/`(默认 `~/code/gladlog-eval-private`)。

## 数据契约(全计划共用)

```ts
// packages/analysis/src/utils/rawStreams.ts(Task 1)
export interface ManaSample { tSeconds: number; unitGuid: string; mana: number; manaMax: number }
export interface CastFailedEvent { tSeconds: number; unitGuid: string; spellId: number; spellName: string; reason: string }
export interface RawStreams { available: boolean; manaSamples: ManaSample[]; castFailed: CastFailedEvent[] }
export function parseRawStreams(rawText: string | null, baseMs: number): RawStreams
// baseMs = 对局/轮起点 epoch ms(与 legacy 事件时间基一致);rawText null/空 → {available:false, [], []}
export function manaAt(s: RawStreams, unitGuid: string, tSeconds: number): { mana: number; manaMax: number } | null
export function oomWindows(s: RawStreams, unitGuid: string, thresholdPct: number): Array<{ fromS: number; toS: number; minMana: number }>
export function castFailedInWindow(s: RawStreams, unitGuid: string, fromS: number, toS: number, spellId?: number): CastFailedEvent[]
export function drinkingSegments(s: RawStreams, unitGuid: string): Array<{ fromS: number; toS: number; manaGained: number }>

// packages/analysis/src/analysis/candidateFindings.ts(Task 3/4)
export function manaPressureEvents(...): CandidateEvent[]   // type: "mana-pressure"
export function manaEfficiencyEvents(...): CandidateEvent[] // type: "mana-efficiency"

// candidateTypeFlags.ts(Task 3/4 各自扩键):manaPressure / manaEfficiency,默认 false
```

raw 行格式实测锚点(2026-08-15,库内真实行):

```
SPELL_CAST_FAILED,Player-57-0DAA1122,"Bumbiing-Illidan-US",0x511,0x80000000,0000000000000000,nil,0x80000000,0x80000000,1044,"自由祝福",0x2,"尚未恢复"
  → 逗号分列(引号感知):[9]=spellId,[10]=spellName,[12]=reason(本地化字符串,原样存)
SPELL_CAST_SUCCESS,...,101643,"魂体双分",0x8,Player-…,0000000000000000,490460,490460,2730,2625,852,2683,0,0,0,273000,273000,0,1288.74,…
  → advanced 块从固定列开始(块首=GUID 自校验),块内含 curHP/maxHP 与 curPower/maxPower(273000/273000 即蓝)
```

**advanced 列偏移不许拍脑袋**:实现前先 grep packages/parser 里 advanced 参数的既有偏移表(parser 解析 HP 用过同一块);对齐后在 rawStreams 写 parity 注释;powerType 多值(`a|b` 形态)取 mana(type 0)项;块首字段非 GUID(不以 Player-/Creature-/Pet- 开头)→ 该行跳过。时间戳解析:提取 `uwcObserved.ts` 既有 raw 时间戳换算逻辑为共享(单源迁入 rawStreams,uwcObserved 改 import)。

---

### Task 1: rawStreams 单源模块

**Files:** Create `packages/analysis/src/utils/rawStreams.ts`;Test `packages/analysis/test/rawStreams.test.ts`;Modify `packages/eval/src/explore/uwcObserved.ts`(时间戳/行解析改消费 rawStreams 的共享 helper,行为平价测试钉住)、`docs/predicate-index.md`+`.zh-CN.md`+`packages/eval/test/predicateIndex.test.ts`(登记)。

**Interfaces:** Produces 数据契约全部符号。Consumes parser 的 advanced 偏移常量(读后镜像+注释,不 import parser 包)。

- [ ] Step 1: 失败测试——合成 raw 片段(真实行格式,含:两条 CAST_FAILED、三条带 advanced 的 CAST_SUCCESS 构成蓝量下降、一条畸形行、一条块首非 GUID 行):`parseRawStreams` 出 2 条 castFailed(reason 原样)+3 条 manaSample,畸形行静默跳过;`rawText=null → available:false`;`manaAt` 取最近一条 ≤t 的样本;`oomWindows` 对 <10% 连续段出窗;`castFailedInWindow` 按窗过滤;`drinkingSegments` 对连续回升段出段。fixture 时刻用小数秒。
- [ ] Step 2: RED → 实现(流式逐行,引号感知 CSV 拆分,不整文件 split)→ GREEN。
- [ ] Step 3: uwcObserved 重构消费共享 helper,eval 既有测试全绿(平价);谓词索引双语登记 rawStreams 行,predicateIndex 测试绿。
- [ ] Step 4: 真机锚点验收:60ab1e8f 终局治疗蓝 545/273000、神圣震击(20473 或实测 id)CAST_FAILED ≥15 次——与深挖实验数字对上(复现脚本参照 gladlog-eval-private/review-sessions/freeform-60ab-scripts/);实测 parseRawStreams 耗时(3 场:小/中/大 raw),>2s/场则 BACKLOG 立缓存项。数字进 commit message。
- [ ] Step 5: analysis+eval 套件、typecheck、scoped eslint;commit `feat(analysis): rawStreams 单源模块——法力/意图双流直读 raw.txt(#26)` + trailers;push 验证。

### Task 2: 意图守护(cd-hoarded 冤枉修正,直接生效)

**Files:** Modify `packages/analysis/src/analysis/candidateFindings.ts`(`cdHoardedEvents`、`deathUnusedDefensiveEvents`)、分析入口装配(先读 extractCandidateFindings 现签名,加可选 `rawStreams?: RawStreams`)、`packages/desktop/src/main/analysis.ts`(读 match 目录 raw.txt 传入,失败传 null);Test 各扩展。

**Interfaces:** Consumes Task 1 `castFailedInWindow`。Produces:候选 facts 新字段 `attempted`(如 `"曾尝试施放被拒(尚未恢复×3)"`,reason 聚合计数)。

- [ ] Step 1: 失败测试三红线:①合成「hoard 窗内该技能 CAST_FAILED×3」→ 候选带 attempted 注且 severity 降一档;②「真没按」→ 原行为逐字段不变;③`rawStreams` 缺省/available:false → 原行为不变。deathUnusedDefensiveEvents 同三条。
- [ ] Step 2: RED → 实现 → GREEN;现有候选测试全绿(attempted 是加字段,不许改动既有断言语义)。
- [ ] Step 3: 全库量化冤枉面(前后数字):分批前台扫描,统计 cd-hoarded 候选中带 attempted 的占比(N/M 场均);数字进 commit message + 深挖手册加「无响应类结论必须先查 CAST_FAILED 意图流」一句。
- [ ] Step 4: commit `feat(analysis): 意图守护——按了被拒不算屯 CD(cd-hoarded/死亡未用防御,冤枉面 N/M)` + trailers;push 验证。

### Task 3: mana-pressure 候选(开关关)

**Files:** Modify `candidateFindings.ts`(builder + 装配 flag-gated)、`candidateTypeFlags.ts`(+manaPressure:false)、`buildFindingsPrompt.ts`(图例 flag-gated);Test 扩展。

**Interfaces:** Consumes `oomWindows`/`castFailedInWindow`/`manaAt` + 既有 `isHealerSpec`、承压谓词(threatActiveAt 可复用作接敌判定)。Produces `manaPressureEvents`,id `mana-pressure:<healerName>:<t>`,facts:OOM 窗起止/时长、窗内最低蓝与蓝量关键点、被拒次数与首因、期间威胁事实。

- [ ] Step 1: 失败测试:①60ab 形态 fixture(治疗蓝 <阈值连续 ≥窗长 × 窗内被拒 ≥门)→ 1 条,facts 齐;②蓝低但零被拒且无接敌 → 0 条;③开关关 → 不入装配输出(负断言),单开 → 只该类型入;④raw 不可用 → 0 条不崩。常量 `MANA_PRESSURE_LOW_PCT`/`MANA_PRESSURE_MIN_WINDOW_S`/`MANA_PRESSURE_MIN_FAILED` 标 `<标定定稿>`(占位 10%/8s/3)。
- [ ] Step 2: RED → 实现(镜像 P1P2 builder 惯例:纯映射+探针注入,渲染网格)→ GREEN;全量门三绿(开关关零变化)。
- [ ] Step 3: commit `feat(analysis): mana-pressure 候选——OOM 窗×被拒意图(开关默认关)` + trailers;push 验证。

### Task 4: mana-efficiency 候选(开关关)+ 耗蓝数据源

**Files:** 先探查 `packages/analysis/src/data/` 生成物有无法术 mana cost;无则 Create `scripts/datagen/genSpellManaCost.ts` + 生成物 + manifest 注册(锚定清单:圣光术/闪光治疗/神圣震击等 3-5 个治疗法术 tooltip 耗蓝,锚点对不上 → 停并报告);Modify `candidateFindings.ts`、`candidateTypeFlags.ts`(+manaEfficiency:false)、`buildFindingsPrompt.ts`(图例注明资源运营信号);Test 扩展。

**Interfaces:** Consumes 生成耗蓝表 + 既有有效治疗统计(healing 谓词族,过量治疗剔除口径复用不重算)。Produces `manaEfficiencyEvents`(全场聚合,一场至多 1 条),facts:逐法术「耗蓝占比/有效治疗占比」top 表 + 最差法术例证。

- [ ] Step 1: 失败测试:①合成聚合 fixture(法术 A 耗蓝 29% 有效治疗 11%,总施法数 ≥样本门)→ 1 条 facts 含 A 行;②效率高于地板 → 0;③样本不足 → 0;④开关/raw/负断言同 Task 3 模式。常量 `MANA_EFF_FLOOR`/`MANA_EFF_MIN_CASTS` 标 `<标定定稿>`(占位 0.5 比率/10 次)。
- [ ] Step 2: datagen(如需):七步法,锚定测试红→绿;RED → builder 实现 → GREEN;全量门三绿。
- [ ] Step 3: commit `feat(analysis): mana-efficiency 候选——蓝效审计聚合型(开关默认关)+ SpellPower datagen` + trailers;push 验证。

### Task 5: 深挖工具(matchExplore 子命令)

**Files:** Modify `packages/eval/src/explore/matchExplore.ts`(+2 query kinds)、`packages/eval/scripts/matchExplore.ts`(CLI 接线)、`docs/commands/deepdive-probe.md`(机制纪律句,Task 2 若已加则跳过);Test `packages/eval/test/` 扩展。

**Interfaces:** Consumes Task 1 全部谓词(经 storeAccess 拿 match 目录 raw.txt 与轮起点)。

- [ ] Step 1: 失败测试:`mana --unit X --from --to` 输出蓝量关键点+OOM 窗+被拒清单(fixture);`drink` 输出双方治疗回升段表(时刻/回蓝量/是否被一跳伤害打断)。
- [ ] Step 2: RED → 实现 → GREEN;真机验收:60ab `mana` 重建法力死亡叙事,76ea 或另场 `drink` 出敌治疗喝水段(数字进报告)。
- [ ] Step 3: commit `feat(eval): matchExplore mana/drink 子命令——深挖双流工具(#26)` + trailers;push 验证。

### Task 6: 语料标定(两类型)

**Files:** Modify `packages/eval/src/explore/candidateCalibration.ts`(扩两类型,选样必须走生产 buildInput 路径——P1P2 owner 幻影教训,谓词同源)+ 薄壳脚本;报告 `$GLADLOG_EVAL_HOME/reports/raw-streams-calibration.md`。

- [ ] Step 1: 扫描扩展 + fixture 测试;n≥500 分批前台(raw.txt 逐场读,批间落盘)。
- [ ] Step 2: 输出:两类型发生率/场均(per-round 与 per-match 双口径标明)/阈值敏感性表(mana-pressure 低蓝%∈{5,10,15}×窗长∈{5,8,12}s;mana-efficiency 地板∈{0.4,0.5,0.6}),目标场均 0.5-2;每阈值双向误差注;定稿写回常量+测试更新。
- [ ] Step 3: commit(标定数字进 message)+ 报告(eval-private 也 commit);push 验证。阈值表呈用户过目(非阻塞)。

### Task 7: 两类型独立 A/B(→ PAUSE)

**Files:** 复用 `packages/desktop/scripts/p1p2Ab.ts` harness(读它,已参数化则只加类型);报告 `$GLADLOG_EVAL_HOME/reports/raw-streams-ab.md`。

- [ ] Step 1: 评估集=各类型生产路径验证过的触发场 n≥30(不足全取如实报);两组:{manaPressure 单开} vs 全关、{manaEfficiency 单开} vs 全关。
- [ ] Step 2: responder/judge=sonnet;确定性主指标(采纳率含分母/候选覆盖/门规审计通过率/filler 代理注明是代理/整体审计通过);分批前台,raw 项落盘可复算。
- [ ] Step 3: 报告逐类型结论(事实为主,一边倒才给建议);commit + push 验证;**PAUSE:结果呈用户逐类型定开关**。

### Task 8: 按裁决收尾

- [ ] 胜出类型翻 true(A/B 数字进 commit),败类型留关注明;BACKLOG #26 结案注记(含各 task 数字);inventory/谓词索引/深挖手册同步;全量门三绿;push 验证。

## 完成定义

rawStreams 单源在册可复用;意图守护带冤枉面前后数字上线;两候选各有标定+独立 A/B 数字与用户终批;60ab 法力死亡叙事可由工具一键重建;红线测试(优雅降级×3、守护注×3、负断言)常绿。
