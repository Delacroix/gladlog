# 多模型 AI 分析对比 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一场对局可保留多个 AI 后端/模型的分析结果(分槽互不覆盖),面板 tab 切换对比,分析按钮带「选用其他模型分析」临时切换入口。

**Architecture:** `analysis-v2.<lang>.json` 信封升 `schemaVersion: 2`(`slots` 按 `backend:model` 键 + `lastSlotKey`),读时懒迁移 v1;全部下游消费方经单源 `resolveActiveSlot` 读 lastSlotKey 槽(行为与今日一致);renderer 经扩展的 `getState` 拿槽摘要渲染 tab;split 按钮用 `backendOverride` 一次性覆盖 run 的后端/模型。

**Tech Stack:** TypeScript / Electron main+renderer / React / vitest。

## Global Constraints

- 槽键 = `` `${backend}:${model}` ``,来源与实际调用同源(`settings.aiBackend ?? "anthropic"` + `resolveAiModel(settings)`,单点计算)——与 analyzeWindow 的 windowKey 前缀同构(analysis.ts:491-506 先例)。
- 下游消费口径 = **`lastSlotKey` 指向的槽**,写成共享 helper `resolveActiveSlot(doc)`,所有消费方 import,不许各自摸 `slots`(门规谓词即规范)。
- 写槽只 upsert 当前槽 + 更新 `lastSlotKey`,其他槽字节不动。
- promptVersion 按槽存;槽内不匹配只影响该槽(miss),不影响其他槽。
- 临时模型选择不写全局设置(设置页默认不动)。
- 单槽时不渲染 tab;≥2 槽才渲染。
- k=1 现状兼容:改造后单槽场景的一切现有行为(getCached 返回值、aggregate/notebook/learning 读数、E2E 种子)必须与改造前一致——用现有测试全绿证明。
- **对 spec 的一处偏离(计划级决定,执行者照此办)**:finding 标记(findingFlags.json)**不**下沉槽内——它是独立文件、按语言/模型无关的 findingKey 键控,表达用户对「该发现内容」的判断;不同模型产出不同 finding 自然不同键,同键即同内容、同判断适用。spec 第 1 节「finding 标记槽内隔离」按此修正。
- 提交纪律:每任务独立 commit(中文信息 + trailers),不 push(控制器统一推);测试跑 workspace 口径;typecheck 用 `npm run typecheck`(绝不 `tsc -b`)。

## 计划期已核实的事实(执行者直接引用,勿再考古)

- `AnalysisCacheDoc<T>` 现形:`{schemaVersion: 1; promptVersion; language; createdAt; result: T}`(shared/analysisCache.ts:6-12);`schemaVersion` 今日**只写不读**——本计划启用它做形状判别。
- 写点:run()→finish() analysis.ts:228-262(`analysisCacheDoc(lang, result)` + tmp/rename);**deepenInner 用硬编码字面量路径**(analysis.ts:394-398,不走 `analysisCachePath`)——Task 2 顺带收敛。
- 读点(全清单):getCached(:976-993,含 en-only legacy `analysis-v2.json` 回退)、getState(:969-975)、listAnalyzed(:944-968,经 getCached)、aggregate(:676-784,三候选文件 + promptVersion 门)、notebook(:789-901 同)、learning.ts collectExamples(:159-191,无版本门)与 runBackfill(:335-395,刻意无版本门)、scripts/learningScan.ts:39-57、qa/support/seedAnalysis.ts:30-47(E2E 播种)。
- backend/model 解析先例:analyzeWindow analysis.ts:491-506;`resolveAiModel` 在 shared/aiModels.ts;`resolveAiClient(settings)` main/ai.ts:65-82,吃 `{anthropicApiKey, deepseekApiKey?, aiBackend?, aiBackendCommand?}`。
- 按钮在 StructuredAnalysisPanel.tsx:350-376(`handleAnalyze`→`bridge().analysis.run(input)`;`rpt-ai-primary`;容器 `rpt-ai-actions`);面板经 `getState(matchId)` 单点加载(:179-211);自动深挖触发 :291-321。
- 可用性信号:本地 CLI 经 IPC `gladlog:ai:detectCli`(preload `ai.detectCli(backend)` → `{path: string|null}`,无批量接口);API key 存在性 = settings 哨兵串真值(`API_KEY_REDACTED`/`DEEPSEEK_KEY_REDACTED`,shared/protocol.ts)。
- `AI_MODELS`/`AI_DEFAULT_MODEL`/`BACKEND_CLI_TOOL`/`AiBackend` 全在 shared/aiModels.ts。
- 迁移先例:missing-field-implies-miss(窗口缓存 promptVersion,analysis.ts:109-120)、read-side legacy 回退不重写(:979-985)。
- 测试先例:analysis.test.ts `svc()`/`langSvc()` helper、legacy 文档手写用例(:184-203)、aggregate/notebook fixture 写法;StructuredAnalysisPanel.test.tsx 用 `window.__gladlogFixture` 桩;visual `report-ai` 场景锚 `[data-testid=finding-deepdive]`,fixture 桩 `getState` 返回单结果(dev/main.tsx:116-152)——Task 4 会改按钮外观 → report-ai 基线 CI 重生成。

---

### Task 1: 存储层 —— 分槽信封与单源槽谓词

**Files:**

- Modify: `packages/desktop/src/shared/analysisCache.ts`
- Test: `packages/desktop/src/shared/analysisCache.test.ts`(新建)

**Interfaces:**

- Produces(后续任务全部依赖,签名逐字):

```ts
export interface AnalysisSlot<T> {
  promptVersion: number;
  createdAt: number;
  result: T;
}
export interface AnalysisCacheDocV2<T> {
  schemaVersion: 2;
  language: string;
  slots: Record<string, AnalysisSlot<T>>;
  lastSlotKey: string;
}
/** 读侧统一入口:v2 原样;v1/无版本旧单结果懒包装成单槽(不写盘)。null 入 null 出。 */
export function toSlottedDoc<T>(
  raw: unknown,
  legacySlotKey: string,
): AnalysisCacheDocV2<T> | null;
/** 消费口径单源:lastSlotKey 指向的槽;槽缺失(文件损坏等)返回 null。 */
export function resolveActiveSlot<T>(
  doc: AnalysisCacheDocV2<T> | null,
): AnalysisSlot<T> | null;
/** 写侧:在(可能为 null 的)现有 doc 上 upsert 一个槽并置 lastSlotKey。 */
export function upsertSlot<T>(
  existing: AnalysisCacheDocV2<T> | null,
  lang: string,
  slotKey: string,
  result: T,
  createdAt?: number,
): AnalysisCacheDocV2<T>;
export function slotKeyOf(backend: string, model: string): string; // `${backend}:${model}`
```

- 保留现有 `analysisCachePath`/`AnalysisCacheDoc`(v1 类型仍被迁移路径引用)与 `analysisCacheDoc`(E2E 播种在 Task 2 改走新形状后删除旧引用,函数保留 deprecated 注释)。

- [ ] **Step 1: 失败测试**(analysisCache.test.ts):

```ts
import { describe, expect, it } from "vitest";
import {
  resolveActiveSlot,
  slotKeyOf,
  toSlottedDoc,
  upsertSlot,
} from "./analysisCache";

const R = (n: number) => ({ findings: [], dropped: n, hadNarration: true });

describe("slotted analysis cache", () => {
  it("v1 旧单结果懒迁移成单槽,legacySlotKey 归属", () => {
    const v1 = {
      schemaVersion: 1,
      promptVersion: 13,
      language: "zh",
      createdAt: 5,
      result: R(1),
    };
    const doc = toSlottedDoc(v1, "anthropic:claude-sonnet-5")!;
    expect(doc.schemaVersion).toBe(2);
    expect(doc.lastSlotKey).toBe("anthropic:claude-sonnet-5");
    expect(doc.slots["anthropic:claude-sonnet-5"]).toEqual({
      promptVersion: 13,
      createdAt: 5,
      result: R(1),
    });
  });
  it("v2 原样通过;垃圾/缺 slots 返回 null", () => {
    const v2 = {
      schemaVersion: 2,
      language: "zh",
      slots: { "a:b": { promptVersion: 13, createdAt: 1, result: R(2) } },
      lastSlotKey: "a:b",
    };
    expect(toSlottedDoc(v2, "x:y")).toEqual(v2);
    expect(toSlottedDoc(null, "x:y")).toBeNull();
    expect(toSlottedDoc({ schemaVersion: 2 }, "x:y")).toBeNull();
  });
  it("upsertSlot 只动目标槽与 lastSlotKey,他槽字节不动", () => {
    const base = upsertSlot(null, "zh", "a:m1", R(1), 10);
    const two = upsertSlot(base, "zh", "b:m2", R(2), 20);
    expect(Object.keys(two.slots).sort()).toEqual(["a:m1", "b:m2"]);
    expect(two.lastSlotKey).toBe("b:m2");
    expect(two.slots["a:m1"]).toBe(base.slots["a:m1"]); // 引用不变=未重建
    const over = upsertSlot(two, "zh", "a:m1", R(3), 30);
    expect(over.slots["a:m1"].result).toEqual(R(3));
    expect(over.slots["b:m2"]).toBe(two.slots["b:m2"]);
  });
  it("resolveActiveSlot 走 lastSlotKey;悬空键返回 null", () => {
    const doc = upsertSlot(
      upsertSlot(null, "zh", "a:m1", R(1), 1),
      "zh",
      "b:m2",
      R(2),
      2,
    );
    expect(resolveActiveSlot(doc)!.result).toEqual(R(2));
    expect(resolveActiveSlot({ ...doc, lastSlotKey: "ghost:x" })).toBeNull();
    expect(resolveActiveSlot(null)).toBeNull();
  });
  it("slotKeyOf 拼接", () =>
    expect(slotKeyOf("deepseek", "deepseek-chat")).toBe(
      "deepseek:deepseek-chat",
    ));
});
```

- [ ] **Step 2: 跑测试确认红**:`npm run test --workspace=packages/desktop -- analysisCache`,期望 import 失败/断言失败。
- [ ] **Step 3: 实现**(analysisCache.ts 追加;`toSlottedDoc` 判别:`raw.schemaVersion === 2 && raw.slots && raw.lastSlotKey` → v2;`raw.result` 存在 → v1 包装 `{promptVersion: raw.promptVersion ?? 0, createdAt: raw.createdAt ?? 0, result: raw.result}`;否则 null。`upsertSlot` 浅拷贝 slots,`promptVersion: PROMPT_VERSION`)。
- [ ] **Step 4: 跑测试确认绿**;`npm run typecheck`。
- [ ] **Step 5: Commit** `feat(desktop): 分析缓存分槽信封 v2 + 槽谓词单源(多模型对比存储层)`。

### Task 2: 主进程接线 —— run/deepen 写槽、消费方走单源、backendOverride

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`(run/finish、deepenInner、getCached、getState、aggregate、notebook)
- Modify: `packages/desktop/src/main/learning.ts:159-191, 335-395`
- Modify: `packages/desktop/scripts/learningScan.ts:39-57`
- Modify: `packages/desktop/qa/support/seedAnalysis.ts:30-47`
- Modify: `packages/desktop/src/preload/api.ts`(run input、getState 返回类型)
- Test: `packages/desktop/src/main/analysis.test.ts`

**Interfaces:**

- Consumes: Task 1 全部导出。
- Produces:
  - `AnalysisInput` 增 `backendOverride?: { backend: AiBackend; model: string }`;
  - `getState(matchId)` 返回 `{ cached: AnalysisResult|null; running: boolean; slots: Array<{ key: string; createdAt: number; stale: boolean }>; activeKey: string|null }`(`slots` 仅摘要不含 result;`stale` = 槽 promptVersion ≠ 当前;按 createdAt 升序);
  - `getCached(matchId, slotKey?)`:无 slotKey 走 resolveActiveSlot(现行为);传 slotKey 读指定槽(版本门同样适用)。

要点(全部在既有代码位上改,先例已在「已核实事实」注明):

1. run():settings 快照处并排计算 `const backend = input.backendOverride?.backend ?? settings.aiBackend ?? "anthropic"; const model = input.backendOverride?.model ?? resolveAiModel(settings); const slotKey = slotKeyOf(backend, model);`;`resolveAiClient` 调用改传 `{...settings, aiBackend: backend, aiModels: { ...settings.aiModels, [backend]: model }}`(override 融入快照,单点);finish() 写盘改:读现有文件 → `toSlottedDoc(raw, slotKey)` → `upsertSlot(...)` → tmp/rename。**注意**:legacySlotKey 用当前 slotKey(spec 拍板的尽力归属)。
2. deepenInner:路径改用 `analysisCachePath`(收敛 :394-398 硬编码);merge 改写 **lastSlotKey 槽**的 result(深挖归属最近分析),同样 toSlottedDoc→改槽→写回。
3. getCached:读文件 → `toSlottedDoc(raw, currentSlotKey())`(currentSlotKey= settings 派生,单点 helper)→ 指定槽或 activeSlot → 槽内 `promptVersion !== PROMPT_VERSION → null`。en-only legacy `analysis-v2.json` 回退保留(回退物也过 toSlottedDoc)。
4. aggregate/notebook:三候选文件循环体内,`JSON.parse` 后统一 `const doc2 = toSlottedDoc(doc, "legacy:unknown"); const slot = resolveActiveSlot(doc2); if (!slot || slot.promptVersion !== PROMPT_VERSION) continue;` 后续 `doc.result`→`slot.result`、`doc.createdAt`→`slot.createdAt`。
5. learning.ts 两处 + learningScan.ts:同上但**保持原版本门语义**(collectExamples/runBackfill 原本不检查 promptVersion 就继续不检查,只换取值路径)。
6. seedAnalysis.ts:改写 v2 形状(`upsertSlot(null, "zh", "anthropic:claude-sonnet-5", {...})`)。

- [ ] **Step 1: 失败测试**(analysis.test.ts 追加;沿用 `svc()` helper 风格):

```ts
it("分槽:换 backendOverride 重分析不覆盖旧槽,getState 列两槽", async () => {
  const { service, dir } = langSvc("zh"); // stream 返回固定 findings JSON
  await service.run({
    matchId: "m1",
    candidates: [C],
    richContext: "ctx",
    spec: "s",
  });
  await service.run({
    matchId: "m1",
    candidates: [C],
    richContext: "ctx",
    spec: "s",
    backendOverride: { backend: "deepseek", model: "deepseek-chat" },
  });
  const st = await service.getState("m1");
  expect(st.slots.map((s) => s.key).sort()).toEqual([
    "anthropic:claude-sonnet-5",
    "deepseek:deepseek-chat",
  ]);
  expect(st.activeKey).toBe("deepseek:deepseek-chat");
  expect(
    await service.getCached("m1", "anthropic:claude-sonnet-5"),
  ).not.toBeNull();
});
it("旧 v1 文件读取:getCached 照常返回结果(懒迁移),再分析后升 v2 且保留迁移槽", async () => {
  /* 手写 v1 文件(:184-203 先例)→ getCached 命中 → run() → 文件 schemaVersion===2 且两槽 */
});
it("deepen 写进 lastSlotKey 槽,不碰其他槽", async () => {
  /* 两槽后 deepen → 仅 activeKey 槽 result.deepened===true */
});
it("aggregate/notebook 在 v1 与 v2 文件混布下数字与改前一致", async () => {
  /* 现有 fixture 写法各写一场 v1、一场 v2 单槽,断言输出与单结果时代相同 */
});
```

(deepseek 槽的 run 需要 client:测试 settings 桩给 `deepseekApiKey`,或 override 用 `claudeCli` + 注入 Runner——按 `svc()` 现有注入面选最省的,实现者定,报告里说明。)

- [ ] **Step 2: 确认红**(workspace 口径跑 analysis.test.ts 所在包)。
- [ ] **Step 3: 实现上述 6 点。**
- [ ] **Step 4: 全绿**:`npm run test --workspace=packages/desktop`(既有 aggregate/notebook/listAnalyzed/legacy 用例是「行为不变」的防腐网,必须全绿)+ typecheck + eslint。
- [ ] **Step 5: Commit** `feat(desktop): 分析分槽落盘 + backendOverride + 消费方收敛 resolveActiveSlot(多模型对比主进程)`。

### Task 3: 面板 tab 切换

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css`(tab 条样式,复用 `rpt-` 前缀与现有 segmented 控件观感)
- Test: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 的 `getState` 摘要 + `getCached(matchId, slotKey)`。
- Produces: `slotLabel(key: string): string` 导出(拆首个 `:`;后端显示名映射 `{anthropic:"Claude API", claudeCli:"Claude CLI", agy:"agy", codex:"Codex", deepseek:"DeepSeek"}`;模型 label 查 `AI_MODELS`,未知 id 用原串)——Task 4 菜单复用。

要点:面板加 `selectedSlotKey: string|null` 状态(null=跟随 activeKey);`slots.length >= 2` 时在结果区顶部渲染 tab 条(`data-testid="analysis-slot-tabs"`,当前槽高亮);点击 tab → `getCached(matchId, key)` → setResult(带 resultForRef 守卫,复用现有 matchId 归属模式);新分析完成(onDone)重置 selectedSlotKey=null 回到最新;**自动深挖触发(:291-321)只对 activeKey 槽生效**(查看旧槽不触发 deepen);stale 槽 tab 加「旧版」小标。

- [ ] **Step 1: 失败测试**(fixture 桩扩 `getState` 返回 slots/activeKey、`getCached(matchId, key)`):单槽无 tab;双槽有 tab 且默认显示 activeKey;点另一 tab 显示该槽 findings 且不发 run/deepen;onDone 后回到新槽。
- [ ] **Step 2: 确认红。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 全绿** + typecheck + eslint。
- [ ] **Step 5: Commit** `feat(desktop): 分析面板多模型槽 tab 切换(≥2 槽才显示)`。

### Task 4: split 按钮「选用其他模型分析」

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`(按钮区 :366-376)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `StructuredAnalysisPanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 `run({...input, backendOverride})`;Task 3 `slotLabel`;`bridge().ai.detectCli(backend)`;settings 哨兵(`settings.get()` 的 `anthropicApiKey`/`deepseekApiKey` 真值)。

要点:`rpt-ai-primary` 右侧贴一个窄箭头按钮(`data-testid="analysis-model-picker"`,aria-label「选用其他模型分析」);点开下拉菜单:分组列出可用后端×模型(`slotLabel` 文案),不可用后端不出现(CLI= `detectCli(backend).path !== null`,首开菜单时并发探测三个 CLI 一次并缓存到组件态;API= key 哨兵真值);当前全局默认项后缀「(默认)」;选中 → `handleAnalyze` 变体带 `backendOverride`,**不写 settings**。菜单关闭on选中/点外/Esc。运行中禁用整个 split。

- [ ] **Step 1: 失败测试**:桩 `ai.detectCli`(agy 有 path,claude/codex null)+ settings 只配 anthropic key → 菜单项 = anthropic 全模型 +「(默认)」标 + agy 全模型,无 deepseek/codex/claudeCli;选 agy:flash → `run` 收到 `backendOverride:{backend:"agy",model:"flash"}` 且 `settings.save` 未被调用。
- [ ] **Step 2: 确认红。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 全绿** + typecheck + eslint。**报告注明**:report-ai 视觉基线将变(按钮多箭头),走 CI 重生成人审,不本地跑 test:visual。
- [ ] **Step 5: Commit** `feat(desktop): 分析按钮 split 箭头「选用其他模型分析」(临时切换不写全局)`。

### Task 5: 收尾 —— 门禁、push、基线、收账

**Files:**

- Modify: `docs/BACKLOG.md`(#20 附近记「多模型对比已落地」一行 + 真机点验交接项)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/report-ai.png`(CI 生成人审)

- [ ] **Step 1**: `npm run presubmit` 全绿(红了如实报告不自修)。
- [ ] **Step 2**: BACKLOG 收账 commit;fetch/rebase 后 push;按 headSha 盯 test.yml。
- [ ] **Step 3**: frontend-qa 若仅 report-ai 红 → 预期,`gh workflow run visual-baseline.yml --ref main` → 下载 artifact → cmp → 人审 PNG(差异必须仅按钮区箭头/菜单不入镜)→ 提交推送盯绿;其他红如实报告。
- [ ] **Step 4**: 汇报:分槽行为前后对照(单槽行为不变证据=既有测试全绿)、真机点验清单(双模型分析同场→tab 对比→临时菜单)。

## Self-Review 记录

1. **Spec 覆盖**:§1 存储=T1+T2;§2 消费口径=T2(helper 单源+防腐);§3 tab=T3;§4 split=T4;§5 边界无任务(正确);§6 测试映射各任务 Step 1 + T5 基线。finding 标记条目按 Global Constraints 的偏离决定处理(需用户知情)。
2. **占位符**:T2 Step 1 后三用例为注释体,均已写明构造方法与断言目标,按首例样式补全——符合本仓 17a+17b 计划先例;无 TBD。
3. **类型一致**:`AnalysisSlot/AnalysisCacheDocV2/toSlottedDoc/resolveActiveSlot/upsertSlot/slotKeyOf` T1 定义、T2-4 消费;`backendOverride` 形状 T2 定义 T4 消费;`slotLabel` T3 定义 T4 消费。
