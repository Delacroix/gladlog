# 窗口深挖多条化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** window/moment 深挖输出从单段改为 1~4 条独立 finding(逐条过审计),UI 列表化,复测 A/B。

**Architecture:** 只动 window 模式契约;deepen 自动轮契约不变(测试钉死)。`auditDeepDives` 放开「同 findingIndex 多条(仅 window)」;`DeepDiveResult` 加 `title?`;main 的 analyzeWindow 结果/缓存改 `entries[]`;PROMPT_VERSION 18。

**Spec:** `docs/superpowers/specs/2026-08-05-window-multi-finding-design.md`

## Global Constraints

- 占位符零数字纪律不变;title ≤20 字且无数字(裸数字审计覆盖 title,占位符不进 title)。
- deepen(自动轮)行为与输出契约**字节级不变**——同 findingIndex 多条仅 window 模式放开,deepen 模式多余条丢弃计入 dropped。
- typecheck 用 `npm run typecheck`;push 前 `npm run presubmit`;commit 直接 main;工作目录 `/Users/mingjianliu/code/gladlog` 主 checkout。
- commit message 末尾两行:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01QjhGtTfR12CLySZNCg63w7`。

---

### Task 1: analysis 包契约多条化

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts`(就近追加)+ 既有 deepen 测试不动即回归钉

**Interfaces:**

- Produces: `DeepDiveResult` 增加 `title?: string`;`auditDeepDives(parsed, packs, opts?: { mode?: "deepen" | "window" })`——mode 默认 "deepen"(现状);"window" 时允许同 findingIndex 多条(≤4,超出丢弃),每条独立走完整审计链(占位符 key 校验→claimChecker→裸数字(含 title)→repairSpellNameZh→causalLint→interpolate+chips)。
- prompt:`buildDeepDivePrompt` window 模式的输出契约行改为 `Output ONLY a JSON array (1-4 entries; [] if nothing is defensible): [{ "findingIndex": number, "title": string, "deepDive": string, "citedKeys": string[] }]`,并追加一行 HARD RULE(仅 window):`Each entry must focus on ONE unit or ONE decision; fewer, better-grounded entries beat padding; title ≤20 chars, no digits.`(中文措辞可,与现有 HARD RULES 风格一致)。deepen 模式契约行原样。

- [ ] **Step 1: 失败测试**:window 模式下 (a) 同 index 3 条全过审计→3 条 DeepDiveResult(title 透传);(b) 3 条中 1 条裸数字→只丢那条,другие 2 条存活;(c) 第 5 条被丢弃;(d) title 含数字→该条整条丢;(e) deepen 模式同 index 2 条→仅首条保留(现状语义,若现状是丢弃后条则钉现状);(f) prompt:window 模式含新契约行与新 HARD RULE,deepen 模式不含。
- [ ] **Step 2: 跑红** `npm test --workspace=packages/analysis -- deepDive.window`
- [ ] **Step 3: 实现**(先读 auditDeepDives 现有同 index 处理逻辑再改,别破坏 deepen 路径)
- [ ] **Step 4: 跑绿** + analysis 全包 + typecheck
- [ ] **Step 5: Commit**:`feat(analysis): window 深挖输出多条化 —— 同锚点 1-4 条独立 finding 逐条审计`

### Task 2: main/preload/UI 接线

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`(analyzeWindow ok 分支 + WindowCacheEntry)
- Modify: `packages/desktop/src/shared/promptVersion.ts`(17→18,照惯例记注释)
- Modify: `packages/desktop/src/preload/api.ts`(analyzeWindow 返回类型)
- Modify: `packages/desktop/src/renderer/src/report/components/WindowAnalysisCard.tsx`(单段→列表)
- Test: `packages/desktop/src/main/analysis.test.ts` + `packages/desktop/test/windowAnalysis.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `auditDeepDives(..., { mode: "window" })` 与 `DeepDiveResult.title`。
- Produces: `WindowAnalyzeResult` ok 分支 = `{ status:"ok"; entries: Array<{ title: string|null; text: string; chips: DeepDiveResult["chips"] }>; fromCache: boolean }`;缓存条目同形(旧缓存因 PROMPT_VERSION 18 自然 miss,无迁移)。

- [ ] **Step 1: 失败测试**:analyzeWindow 多条结果落缓存并二次命中返回同 entries;WindowAnalysisCard 渲染 2 条(各自 title/text/chips)与 1 条(无 title 时不渲染标题行)两用例。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** + desktop 全包 + typecheck + eslint 全仓
- [ ] **Step 5: `npm run presubmit` 绿后 Commit**:`feat(desktop): 窗口深挖多条渲染 + entries 缓存 + PROMPT_VERSION 18`
- [ ] **Step 6(控制器做): push 后视觉基线流程**(WindowAnalysisCard 若入基线场景则更新)。

### Task 3: momentDiveAb 适配 + N=20 复测

**Files:**

- Modify: `packages/eval/scripts/momentDiveAb.ts`(两臂 entries[]:条数=entries.length;判优喂「全部条目 title+正文拼接」;其余机制不动)
- Modify: `docs/superpowers/specs/2026-08-05-window-multi-finding-design.md`(回填数字)

- [ ] **Step 1: 适配脚本**(typecheck/eslint 干净,N=2 冒烟通过)→ Commit `fix(eval): momentDiveAb 适配多条契约`
- [ ] **Step 2(控制器执行): N=20 正式跑**(nohup+监视,防污染机制在位)
- [ ] **Step 3: 数字回填 spec + commit**;决策规则:B 胜率 >50% 才翻转 deepDiveSnapshot 默认,否则维持弃用现状,多条化本身保留。

## Self-Review 记录

- 契约/审计/UI/评测四层各一处修改点,类型贯通(title?: string → entries[].title: string|null);deepen 回归由既有测试 + Task 1(e) 钉。
