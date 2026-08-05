# 时刻级深挖(深挖此刻)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepDive/windowAnalysis 管线新增密集时刻快照(冷却台账/DR/光环/距离 LoS/空窗/HP)+ 回放「深挖此刻」入口 + 自动轮设置开关。

**Architecture:** 全部复用现有 deepDive 管线(`windowOverride`、占位符零数字纪律、`auditDeepDives`、windowAnalysis 缓存)。新增 `momentSnapshot.ts` 提供快照 item 收集器(纯函数,只组合既有谓词);`buildWindowPack`/`buildDeepenPacks` 加 `snapshot` 开关;手动入口恒开快照,自动 deepen 轮由设置 `deepDiveSnapshot` 决定(默认关 = 现状字节不变)。

**Tech Stack:** TypeScript monorepo(packages/analysis 纯函数 + vitest;packages/desktop Electron main/renderer;packages/eval 门规)。

**Spec:** `docs/superpowers/specs/2026-08-05-moment-deep-dive-design.md`(含 debate 结论)。

## Global Constraints

- 门规谓词即规范(CLAUDE.md):HP 用 `getHpPercentAtTime`/`HP_SAMPLE_RADIUS_MS`;位置插值 `getUnitPositionAtTime`;LoS 必须 `getUnitRawPositionAtTime` + `hasLineOfSight`(**null 当「未知」,绝不当 false**);距离 `distanceBetween`;冷却 `cdAvailableAt`;DR `analyzeOutgoingCCChains`;治疗空窗 `detectHealingGaps`。**新文件里绝不手写第二套判定**。
- facts 里的时刻先 floor 到渲染网格(`Math.floor`,与 `fmtTime` 同网格)再写入;数字经 `fmtFactNum`(deepDive.ts 现有做法,见 `hp` item 的写法)。
- 正文零数字纪律不放松:所有可引用数字必须在 facts 里;施法流水只作上下文段落。
- 光环**不放剩余时长**(inferredEnd 语义坑,spec 非目标);法力/资源不做(parser 恒空)。
- `PACK_MAX_ITEMS = 14` 不动;快照模式独立 `MOMENT_PACK_MAX = 32`。
- typecheck 用 `npm run typecheck`,绝不 `tsc -b`;push 前 `npm run presubmit`(仓库根)。
- 提交直接进 main,每个 task 一个 commit;commit message 末尾带 Co-Authored-By(见仓库近期 commit 样式)。
- 所有新增共享谓词登记 `docs/predicate-index.md`(配套一致性测试在 `packages/eval/test/predicateIndex.test.ts`)。
- 工作目录必须是 `/Users/mingjianliu/code/gladlog`(主 checkout,无 worktree)。

---

### Task 1: momentSnapshot 收集器(analysis 包)

**Files:**

- Create: `packages/analysis/src/analysis/momentSnapshot.ts`
- Create: `packages/analysis/src/analysis/momentSnapshot.test.ts`
- Modify: `packages/analysis/src/analysis/deepDive.ts`(PackItem kind 联合 + PACK_ITEM_KIND_ZH,行 ~57-70 与 ~1110-1126)

**Interfaces:**

- Consumes(全部既有 export):
  - `extractMajorCooldowns(unit, combat): IMajorCooldownInfo[]`、`cdAvailableAt(cd, tSeconds): boolean`、`getUnitHpAtTimestamp`、`HP_SAMPLE_RADIUS_MS`、`fmtTime`(`../utils/cooldowns`)
  - `getHpPercentAtTime(unit, atSeconds, matchStartMs)`、`getLowestHpPercentInWindow(unit, fromS, toS, matchStartMs)`(`../utils/killWindowTargetSelection`)
  - `buildAuraIntervals(unit, combat)`(**`../utils/auraIntervals`,不是 `../utils/utils` 的同名函数**)
  - `getUnitPositionAtTime`、`getUnitRawPositionAtTime`、`hasLineOfSight`、`distanceBetween`(`../utils/losAnalysis`);`INTERP_MAX_GAP_MS`、`LOS_SWEEP_GAP_MS`(`../utils/positionSampling`)
  - `analyzeOutgoingCCChains(friends, enemies, combat)`(`../utils/drAnalysis`)
  - `detectHealingGaps(healer, friends, enemies, combat): IHealingGap[]`(`../utils/healingGaps`)
  - `isHealerSpec`、`specToString`
- Produces(Task 2/4 依赖,签名逐字):
  - `export function buildMomentSnapshotItems(combat: any, fromS: number, toS: number, ownerName?: string): Omit<PackItem, "key">[]`
  - `export function buildCastFlowLines(combat: any, fromS: number, toS: number): string[]`(每行 `M:SS Name(Spec) → 技能名`,时刻 `fmtTime(Math.floor(relS))`,按时间升序,上限 90 行,超限尾部丢弃并在最后一行追加 `…(+N more)`)
  - `export function aurasActiveAt(unit: any, combat: any, t: number): string[]`(在身光环名列表,≤10 个;内部 `buildAuraIntervals(unit, combat).filter(iv => iv.fromS <= t && t <= iv.toS)`)
  - `export function largestCastGap(unit: any, fromS: number, toS: number, matchStartMs: number): { fromT: number; toT: number; gapS: number } | null`(窗口内相邻 SPELL_CAST_SUCCESS 间隔取最大,窗口边界算端点;<4s 返回 null——阈值常量 `export const ACTIVITY_GAP_MIN_S = 4`)
  - `export const MOMENT_PACK_MAX = 32;`
  - deepDive.ts 的 `PackItem["kind"]` 联合新增 7 个:`"cd-ledger" | "aura-snap" | "pos-snap" | "dr-state" | "healing-gap" | "activity-gap" | "hp-snap"`;`PACK_ITEM_KIND_ZH` 新增:cd-ledger→"冷却台账"、aura-snap→"光环快照"、pos-snap→"站位快照"、dr-state→"DR 档位"、healing-gap→"治疗空窗"、activity-gap→"输出空窗"、hp-snap→"HP 快照"

**item 构造规格(facts 全部 string;时刻 `String(Math.floor(s))`;名字用 deepDive 的 `sn()` 同样式短名——本文件内复制一个私有 `sn`,一行,不算谓词):**

| kind           | 每条                                                                         | facts                                                                                    | label(chip)            |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| `cd-ledger`    | 每玩家 1 条                                                                  | `t, unit, role, ready, onCd`(ready/onCd 为「、」连接的技能名串,空则 "无")                | `${sn(name)} 冷却台账` |
| `aura-snap`    | 每玩家 1 条(无在身光环则跳过)                                                | `t, unit, role, auras`                                                                   | `${sn(name)} 光环`     |
| `pos-snap`     | owner↔其余每玩家 1 条(位置任一侧取不到则跳过)                                | `t, unit, role, dist`(整数码);LoS 三态时加 `los`("有"/"被挡";null 不写该字段)            | `与 ${sn(name)} 距离`  |
| `dr-state`     | 窗口内每次落地 CC 1 条                                                       | `t, caster, target, spell, drLevel, durationS`(drLevel 用 `ap.drInfo?.level` 原样字符串) | `${spell} DR`          |
| `healing-gap`  | 每个我方治疗的窗口内空窗(gap 与 [fromS,toS] 相交)1 条                        | `unit, fromT, toT, gapS, pressured`(pressured=mostDamagedName 短名)                      | `${sn(name)} 治疗空窗` |
| `activity-gap` | 每玩家 1 条(largestCastGap 非 null 才生成;治疗已有 healing-gap 时跳过该治疗) | `unit, role, fromT, toT, gapS`                                                           | `${sn(name)} 施法空窗` |
| `hp-snap`      | 每玩家 1 条(三值全 null 则跳过)                                              | `t0, t1, unit, role, hpStart, hpEnd, hpMin`(取不到的字段不写)                            | `${sn(name)} HP`       |

role 判定与 deepDive 相同:owner / teammate / enemy(按 `ownerName` 与 `reaction`)。`t` 一律 = `Math.floor` 后的采样时刻;cd-ledger/aura-snap/pos-snap 的采样时刻 = 窗口中点 `Math.floor((fromS+toS)/2)`(死亡锚点入口会让中点≈锚点)。pos-snap 的 LoS:两侧都用 `getUnitRawPositionAtTime(u, atMs, LOS_SWEEP_GAP_MS)`,任一侧 null 则不写 los 字段;位置/距离用 `getUnitPositionAtTime(u, atMs, INTERP_MAX_GAP_MS)`。

- [ ] **Step 1: 写失败测试**(`momentSnapshot.test.ts`;fixture 用 analysis 包既有测试的造数惯例——先 `grep -rn "buildAuraIntervals\|analyzeOutgoingCCChains" packages/analysis/src --include='*.test.ts' -l` 找一个现成造 unit 的样板照抄其最小 unit 构造)。至少覆盖:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_GAP_MIN_S,
  aurasActiveAt,
  buildCastFlowLines,
  buildMomentSnapshotItems,
  largestCastGap,
  MOMENT_PACK_MAX,
} from "./momentSnapshot";

describe("momentSnapshot", () => {
  it("largestCastGap:窗口边界算端点,最大间隔达阈值才返回", () => {
    // unit 造两次施法 t=12s 与 t=20s,窗口 [10,30] → 最大 gap 是 20→30 的 10s
    // 断言 {fromT:20, toT:30, gapS:10};窗口 [10,21] → gap 8s(12→20);全间隔 <ACTIVITY_GAP_MIN_S → null
  });
  it("aurasActiveAt:只取 t 时刻在身的光环名,≤10", () => {});
  it("buildMomentSnapshotItems:每 kind 的 facts 字段齐且数字全为整数串(零小数点纪律)", () => {
    // 断言所有 facts 值 match /^[^.]*$|^\d+$/ 里数字字段无小数点;t 为 floor 后整数串
  });
  it("buildCastFlowLines:升序、上限 90、超限有 (+N more) 尾标", () => {});
});
```

- [ ] **Step 2: 跑测试确认红**:`npm test --workspace=packages/analysis -- momentSnapshot`(期望 module not found)
- [ ] **Step 3: 实现** `momentSnapshot.ts` + deepDive.ts 的 kind 联合与 ZH 表扩充。文件头注释写明:「快照收集器只组合既有谓词,本文件不得出现任何采样半径/距离阈值/DR 常量的字面量(门规谓词即规范)」。
- [ ] **Step 4: 跑测试确认绿**;顺跑 `npm test --workspace=packages/analysis`(全包不回归)+ `npm run typecheck`
- [ ] **Step 5: Commit**:`feat(analysis): momentSnapshot 快照收集器 —— 7 类快照 item + aurasActiveAt/largestCastGap 谓词`

---

### Task 2: pack/prompt 接线(snapshot 开关,默认路径字节不变)

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`:
  - `buildDeepDivePack(..., windowOverride?, opts?: { snapshot?: boolean })`(行 ~124 签名尾部加 opts)
  - `buildWindowPack(combat, fromS, toS, candidates, ownerName?, opts?: { snapshot?: boolean })`(行 ~1062)
  - `DeepDivePack` 加可选字段 `castFlow?: string[]`
  - `buildDeepDivePrompt`(行 ~884):pack 有 `castFlow` 时,在该 pack 小节的 item 清单后追加固定段落
- Test: `packages/analysis/src/analysis/deepDive.test.ts`(已存在则追加;不存在则建)

**Interfaces:**

- Consumes: Task 1 的 `buildMomentSnapshotItems` / `buildCastFlowLines` / `MOMENT_PACK_MAX`
- Produces: Task 4/5 依赖的 `opts.snapshot` 开关语义:**不传/false = 现状字节级不变**;true = items 追加快照类、上限换 `MOMENT_PACK_MAX`、pack.castFlow 填充。

**实现要点:**

1. `buildDeepDivePack` 里现有截断处(`PACK_MAX_ITEMS`,行 ~489-493):snapshot 时 push `buildMomentSnapshotItems(combat, anchorFrom, anchorTo, ownerName)` 到 raw,再按配额截断:快照 kind 内部按「cd-ledger/hp-snap/activity-gap 每单位保 1 条 → pos-snap ≤5 → 其余按时间距 focusT 排序」填到 `MOMENT_PACK_MAX`;非 snapshot 分支一行都不动。
2. `buildWindowPack` 透传 opts 给 `buildDeepDivePack`;survival 门 `hasCoachableSignal` 判定**只看非快照 kind**(快照是状态不是信号,不能让「有台账」就过门)——加一个 `const SNAPSHOT_KINDS = new Set<PackItem["kind"]>([...7 个])` export,门里 filter 掉。
3. `buildDeepDivePrompt`:pack.castFlow 存在时,在 item 清单后追加:

```
CAST FLOW (context only — for understanding the sequence; you may describe order
in words, but every number in your prose MUST still come from a {{pN.field}}
placeholder; numbers appearing only in this flow are NOT citable):
  <castFlow 每行缩进两格>
```

同时 HARD RULES 列表在 castFlow 存在时追加一行:`- The cast flow section is context only: no number from it may appear in prose unless the same number exists as a {{pN.field}} fact.`

- [ ] **Step 1: 失败测试**:

```ts
it("snapshot 关(默认):对同输入 buildWindowPack 输出与改动前深度相等(字节不变回归)", () => {
  // 构造最小 combat + candidates;JSON.stringify(buildWindowPack(c,f,t,cands,owner))
  // 与 snapshot:false / 不传 opts 两种调用结果 deep-equal
});
it("snapshot 开:items 含快照 kind、总数 ≤ MOMENT_PACK_MAX、facts 并入 pack.facts、castFlow 非空", () => {});
it("survival 门不被纯快照 items 骗过:只有快照、无事件信号 → buildWindowPack 返回 null", () => {});
it("prompt:castFlow 段与 context-only HARD RULE 只在 snapshot pack 出现", () => {});
```

- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** + `npm test --workspace=packages/analysis` + typecheck
- [ ] **Step 5: Commit**:`feat(analysis): deepDive pack/prompt 接入快照开关 —— 默认路径字节不变,castFlow 仅上下文`

---

### Task 3: 谓词索引登记 + eval 第 6 类 hardFailure

**Files:**

- Modify: `docs/predicate-index.md`(+ 同步 `docs/predicate-index.zh-CN.md`,双语成对规则!)
- Modify: `packages/eval/src/quality/promptQualityCheck.ts`
- Test: `packages/eval/test/predicateIndex.test.ts`(既有一致性测试跟上)+ promptQualityCheck 的既有测试文件追加用例

**Interfaces:**

- Produces: `export function checkSnapshotFactsConsistency(promptText: string): string[]`(违规描述数组,空=过),并加入 `hardFailures` 组装(promptQualityCheck.ts:460-469 一带)。

**实现要点:**

- 登记新谓词:`aurasActiveAt`、`largestCastGap`、`ACTIVITY_GAP_MIN_S`、`MOMENT_PACK_MAX`、`SNAPSHOT_KINDS`(条目风格照抄现有「Cooldown availability」节)。
- 「尚未统一」节登记存量重复:`utils/utils.ts` 与 `utils/auraIntervals.ts` 的同名 `buildAuraIntervals`(两个消费方判「光环区间」这一事实;本计划不合并,只登记)。
- `checkSnapshotFactsConsistency`:解析深挖 prompt 文本中 `kind=hp-snap facts={...}` 与 `kind=hp facts={...}` 行,同渲染秒同单位的 HP 值差 > 3pp(复用既有 `HP_AGREEMENT_TOLERANCE_PP` 常量,别新写 3)即违规;`kind=cd-ledger` 的 ready 列表与同 prompt `kind=immunity-available`/`external-available` 的 spell 矛盾(available item 的 spell 不在该单位 ready 串里)即违规。无快照行时返回 [](旧 prompt 天然过)。
- 双语:predicate-index 两个语言版都加;若 zh-CN 版不存在此文件则确认后跳过(以 `ls docs/predicate-index*` 为准)。

- [ ] **Step 1: 失败测试**(手造两段 prompt 文本:一致的过、HP 差 5pp 的违规)
- [ ] **Step 2: 跑红**:`npm test --workspace=packages/eval`
- [ ] **Step 3: 实现** → **Step 4: 跑绿**(eval 全包 + predicateIndex 一致性测试)+ typecheck
- [ ] **Step 5: Commit**:`feat(eval): 深挖快照 facts 一致性第 6 类 hardFailure + 谓词索引登记`

---

### Task 4: renderer 请求构建接线

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/analysisInput.ts`:
  - `buildWindowAnalysisRequest(source, fromS, toS, opts?: { snapshot?: boolean })`(行 154;透传给 `buildWindowPack` 第 6 参)返回对象加 `snapshot: boolean`
  - `buildDeepenPacks(source, findings, candidates, ownerName?, opts?: { snapshot?: boolean })`(行 104;透传给 `buildDeepDivePack`/`buildOffensiveDeepDivePack`——后者若无 opts 参数则同样加,签名与 buildDeepDivePack 对齐)
- Modify: `packages/analysis/src/analysis/deepDive.ts` 若 `buildOffensiveDeepDivePack` 在 Task 2 未覆盖 opts,在此补齐(offensive 路径 snapshot 时同样追加快照 items)
- Test: analysisInput 的既有测试文件追加(没有则在 `packages/desktop/src/renderer/src/report/derive/analysisInput.test.ts` 建,fixture 用 `test/fixtures/real-match-sample.json` + 克隆注入死亡的既有惯例,样板见 `report.deathrecap.test`)

**Interfaces:**

- Produces: Task 5/6 消费的 `buildWindowAnalysisRequest(..., { snapshot: true })` → `{ pack, kind, spec, ownerName, fromS, toS, snapshot }`。

- [ ] **Step 1: 失败测试**:`snapshot:true 时返回对象 snapshot=true 且 pack.items 含快照 kind;不传时与现状 deep-equal`
- [ ] **Step 2: 跑红**(`npm test --workspace=packages/desktop -- analysisInput`)→ **Step 3: 实现** → **Step 4: 跑绿** + typecheck
- [ ] **Step 5: Commit**:`feat(desktop): 窗口/深挖请求构建接入 snapshot 开关`

---

### Task 5: main 侧(缓存键/设置/PROMPT_VERSION/preload)

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` analyzeWindow(行 ~842-990):input 加 `snapshot?: boolean`;`windowKey` 在 snapshot 时追加 `:snap` 段;`max_tokens: input.snapshot ? 3072 : 2048`
- Modify: `packages/desktop/src/shared/promptVersion.ts`:`PROMPT_VERSION` 15 → 16(pack 形状变更,旧窗口缓存全失效——这是既定语义)
- Modify: `packages/desktop/src/main/settingsStore.ts`:`GladlogSettings` 加 `deepDiveSnapshot: boolean`,默认 `false`(默认值对象行 ~62 一带);sanitize 对非 boolean 丢弃(照抄 aiLanguage 的校验样式,行 ~139)
- Modify: `packages/desktop/src/preload/api.ts`:analyzeWindow input 类型加 `snapshot?: boolean`;settings 类型如有显式列举则同步
- Test: `packages/desktop/src/main/analysis.test.ts` + `settingsStore` 既有测试文件

**Interfaces:**

- Produces: `bridge().analysis.analyzeWindow({ ..., snapshot: true })`;`settings.deepDiveSnapshot`(Task 6 消费)。

- [ ] **Step 1: 失败测试**:

```ts
it("windowKey:同窗口 snapshot 开/关是两个缓存条目,互不污染", async () => {
  // 同 fromS/toS 先 snapshot:false 跑出缓存,再 snapshot:true → 不命中、二次调用模型
});
it("settings:deepDiveSnapshot 默认 false;patch 非 boolean 被丢弃", () => {});
```

- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**(desktop 全包)+ typecheck
- [ ] **Step 5: Commit**:`feat(desktop): analyzeWindow snapshot 缓存键/额度 + deepDiveSnapshot 设置 + PROMPT_VERSION 16`

---

### Task 6: UI 入口(回放「深挖此刻」+ 手动恒快照 + 自动轮开关 + 设置页)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`:
  - `runWindowAi`(行 448)构建请求时传 `{ snapshot: true }`(手动入口恒密集),IPC payload 带 `snapshot: req.snapshot`
  - 新增回调 prop 传给 ReplayView:`onMomentDive={(tSeconds) => { const range = { from: Math.max(0, Math.floor(tSeconds) - 10), to: Math.floor(tSeconds) + 10 }; setTimeRange(range); setView("report"); void runWindowAi(range); }}`(照抄行 517-527 的「设窗+触发」一次点击惯例,包括其 ref 时序注释说的先 set 后跑)
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx`:控制条加按钮 `深挖此刻`(`data-testid="moment-dive"`),onClick 取**当前回放时钟**换算的相对秒调 `props.onMomentDive?.(tSeconds)`;回放时钟是 ReplayView 局部 state(绝不提升!),换算沿用该文件内已有的 绝对ms↔相对秒 现成换算处
- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`:deepen 触发 effect(行 ~513-556)读 settings(组件已有 aiSettings)——`buildDeepenPacks(source, findings, candidates, ownerName, { snapshot: aiSettings?.deepDiveSnapshot === true })`
- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`:AI 区加开关「深挖用密集快照(token 约 2-4 倍)」绑 `deepDiveSnapshot`(照抄 autoAnalyzeNew 开关的行样式)
- Test: ReplayView/MatchReport 既有组件测试追加:`moment-dive 按钮存在且点击后触发 onMomentDive`;StructuredAnalysisPanel 的 deepen 传参断言(mock buildDeepenPacks 或经 bridge 桩观测)

**Interfaces:**

- Consumes: Task 4 的 `buildWindowAnalysisRequest(..., {snapshot})`、Task 5 的 `settings.deepDiveSnapshot` 与 `analyzeWindow({snapshot})`。

- [ ] **Step 1: 失败测试**(组件测试,bridge 桩照 `__gladlogFixture` 惯例,访问必须 try/catch+optional)
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** + typecheck + `npx eslint . --quiet`
- [ ] **Step 5: 本地全门禁**:`npm run presubmit` 绿
- [ ] **Step 6: Commit**:`feat(desktop): 回放「深挖此刻」入口 + 手动窗口恒快照 + 自动轮 deepDiveSnapshot 开关`
- [ ] **Step 7: 视觉基线**:push 后按 desktop-dev 配方跑 `gh workflow run visual-baseline.yml --ref main` → 下载 → 逐张人审(预期只有 replay 控制条相关基线变)→ 覆盖 commit

---

### Task 7: 验收跑数(spec §6,前后数字)

**Files:**

- Create: `packages/eval/scripts/momentDiveAb.ts`(常驻脚本,注释里写基线数字——不留一次性脚本是仓库纪律)

**实现要点:** 从本机对局库(`~/Library/Application Support/gladlog/matches`)取最近 N(默认 10)个带死亡锚点的场次;对每个锚点 ±10s:A=`buildWindowPack` 非 snapshot,B=snapshot;各走 `buildDeepDivePrompt` + claude -p sonnet(与 2026-08-05 实验同参),输出经 `auditDeepDives`;打印表:锚点 | A 条数/审计通过 | B 条数/审计通过 | B 快照 item 数;末行汇总均值。静音率抽查:打印 B 组被审计丢弃的条目原文供人工归因。

- [ ] **Step 1: 写脚本**(装载/构造照 `packages/desktop/scripts/verify-production.ts` 的 toLegacySafe 惯例;跨包依赖注意脚本放 eval 包内时 `@gladlog/analysis` 可解析,desktop 的 toLegacySafe 不可 import——**用 `@gladlog/analysis` 侧等价装载**:eval 既有脚本怎么装对局就怎么装,先 `ls packages/eval/scripts/` 找样板)
- [ ] **Step 2: 跑**:`npx tsx packages/eval/scripts/momentDiveAb.ts 10`(20 次 sonnet 调用,约 5-10 分钟)
- [ ] **Step 3: 数字进 commit + spec**:把汇总数字(A/B 平均条数、审计通过率、静音率)追加到 spec 的验收节;不达预期(B 均值 ≤ A)则停下报告,不硬发。
- [ ] **Step 4: Commit**:`test(eval): momentDiveAb 验收脚本 + 首轮数字 —— A x.x 条/场 vs B y.y 条/场`
- [ ] **Step 5: 全仓收尾**:`npm run presubmit` 绿后 push;CI 按 headSha 盯绿。

---

## Self-Review 记录

- Spec 覆盖:§1 七类 kind→Task 1;流水段落+HARD RULE→Task 2;§1b activity-gap→Task 1;§2 上限→Task 1/2;§3 main/设置/版本→Task 5;§4 UI→Task 6;§5 谓词索引/第 6 类→Task 3;§6 验收→Task 7;P1=Task 1-5,P2=Task 6(+7)。
- 类型一致:`opts?: { snapshot?: boolean }` 贯穿 buildDeepDivePack/buildWindowPack/buildOffensiveDeepDivePack/buildDeepenPacks/buildWindowAnalysisRequest;`castFlow?: string[]` 在 DeepDivePack;`deepDiveSnapshot` 在 settings。
- 已知留白(刻意):momentSnapshot.test 的最小 unit 造数样板由实现者从既有测试抄(仓库有成熟惯例,照抄比在计划里复制一份更不易漂移)。
