# Multi-Model AI Analysis Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep analysis results from multiple AI backends/models for the same match (slots don't overwrite each other), switch and compare via panel tabs, and add a "Use another model for analysis" temporary switch entry to the analysis button.

**Architecture:** `analysis-v2.<lang>.json` envelope upgrades to `schemaVersion: 2` (`slots` keyed by `backend:model` + `lastSlotKey`), lazy migration of v1 on read; all downstream consumers read the lastSlotKey slot via a single source of truth `resolveActiveSlot` (behavior identical to today); renderer uses expanded `getState` to get slot summaries for rendering tabs; split button uses `backendOverride` to one-time override the backend/model of the run.

**Tech Stack:** TypeScript / Electron main+renderer / React / vitest.

## Global Constraints

- Slot key = `` `${backend}:${model}` ``, derived from the same source as the actual invocation (`settings.aiBackend ?? "anthropic"` + `resolveAiModel(settings)`, computed in a single place) — isomorphic to the windowKey prefix of analyzeWindow (analysis.ts:491-506 precedent).
- Downstream consumption basis = **the slot pointed to by `lastSlotKey`**, written as a shared helper `resolveActiveSlot(doc)`, imported by all consumers; direct access to `slots` is forbidden (gatekeeper predicates serve as specifications).
- Writing a slot only upserts the current slot + updates `lastSlotKey`, leaving other slots byte-for-byte untouched.
- promptVersion is stored per slot; a mismatch inside a slot only affects that slot (miss), without affecting other slots.
- Temporary model selection does not write to global settings (settings page defaults remain untouched).
- Do not render tabs when there is only a single slot; only render tabs when ≥2 slots exist.
- k=1 status quo compatibility: All existing behaviors in single-slot scenarios after refactoring (getCached return value, aggregate/notebook/learning readings, E2E seed) must match pre-refactoring behavior — proven by all existing tests passing green.
- **One deviation from spec (plan-level decision, implementers follow this)**: Finding flags (findingFlags.json) are **not** sunken into slots — it is an independent file, keyed by language/model-agnostic findingKey, expressing the user's judgment on "the content of this finding"; different models producing different findings naturally have different keys, and identical keys imply identical content with the same judgment applicable. Spec section 1 "finding flag slot-internal isolation" is amended accordingly.
- Commit discipline: Each task has an independent commit (commit message + trailers), do not push (controller pushes uniformly); tests run workspace scope; typecheck uses `npm run typecheck` (never `tsc -b`).

## Verified Facts from Planning Phase (implementers cite directly, no need to re-investigate)

- Current shape of `AnalysisCacheDoc<T>`: `{schemaVersion: 1; promptVersion; language; createdAt; result: T}` (shared/analysisCache.ts:6-12); `schemaVersion` is currently **write-only, never read** — this plan enables it for shape discrimination.
- Write sites: run()→finish() analysis.ts:228-262 (`analysisCacheDoc(lang, result)` + tmp/rename); **deepenInner uses hardcoded literal path** (analysis.ts:394-398, does not use `analysisCachePath`) — Task 2 converges this along the way.
- Read sites (complete list): getCached (:976-993, including en-only legacy `analysis-v2.json` fallback), getState (:969-975), listAnalyzed (:944-968, via getCached), aggregate (:676-784, three candidate files + promptVersion gate), notebook (:789-901 ditto), learning.ts collectExamples (:159-191, no version gate) and runBackfill (:335-395, deliberately no version gate), scripts/learningScan.ts:39-57, qa/support/seedAnalysis.ts:30-47 (E2E seeding).
- backend/model resolution precedent: analyzeWindow analysis.ts:491-506; `resolveAiModel` in shared/aiModels.ts; `resolveAiClient(settings)` main/ai.ts:65-82, accepts `{anthropicApiKey, deepseekApiKey?, aiBackend?, aiBackendCommand?}`.
- Button in StructuredAnalysisPanel.tsx:350-376 (`handleAnalyze`→`bridge().analysis.run(input)`; `rpt-ai-primary`; container `rpt-ai-actions`); panel loads via single point `getState(matchId)` (:179-211); auto-deep-dive trigger :291-321.
- Availability signals: Local CLI via IPC `gladlog:ai:detectCli` (preload `ai.detectCli(backend)` → `{path: string|null}`, no batch interface); API key existence = settings sentinel string truthiness (`API_KEY_REDACTED`/`DEEPSEEK_KEY_REDACTED`, shared/protocol.ts).
- `AI_MODELS`/`AI_DEFAULT_MODEL`/`BACKEND_CLI_TOOL`/`AiBackend` all in shared/aiModels.ts.
- Migration precedent: missing-field-implies-miss (window cache promptVersion, analysis.ts:109-120), read-side legacy fallback without rewrite (:979-985).
- Test precedent: analysis.test.ts `svc()`/`langSvc()` helper, legacy document handwritten test cases (:184-203), aggregate/notebook fixture pattern; StructuredAnalysisPanel.test.tsx stubs with `window.__gladlogFixture`; visual `report-ai` scene anchor `[data-testid=finding-deepdive]`, fixture stubs `getState` returning single result (dev/main.tsx:116-152) — Task 4 will alter button appearance → report-ai baseline CI regeneration.

---

### Task 1: Storage Layer — Slotted Envelope and Single-Source Slot Predicates

**Files:**

- Modify: `packages/desktop/src/shared/analysisCache.ts`
- Test: `packages/desktop/src/shared/analysisCache.test.ts` (new)

**Interfaces:**

- Produces (subsequent tasks depend entirely on this, exact signatures):

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
/** Read-side unified entry: v2 as-is; v1/unversioned legacy single result lazily wrapped into single slot (no disk write). null in null out. */
export function toSlottedDoc<T>(
  raw: unknown,
  legacySlotKey: string,
): AnalysisCacheDocV2<T> | null;
/** Single source of consumption: slot pointed to by lastSlotKey; missing slot (corrupted file, etc.) returns null. */
export function resolveActiveSlot<T>(
  doc: AnalysisCacheDocV2<T> | null,
): AnalysisSlot<T> | null;
/** Write side: upserts a slot on (potentially null) existing doc and sets lastSlotKey. */
export function upsertSlot<T>(
  existing: AnalysisCacheDocV2<T> | null,
  lang: string,
  slotKey: string,
  result: T,
  createdAt?: number,
): AnalysisCacheDocV2<T>;
export function slotKeyOf(backend: string, model: string): string; // `${backend}:${model}`
```

- Retain existing `analysisCachePath`/`AnalysisCacheDoc` (v1 type still referenced by migration path) and `analysisCacheDoc` (remove old references in Task 2 after E2E seed switches to new shape; function kept with deprecated comment).

- [ ] **Step 1: Failing tests** (analysisCache.test.ts):

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
  it("v1 legacy single result lazily migrates to single slot, attributed to legacySlotKey", () => {
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
  it("v2 passes through as-is; junk/missing slots returns null", () => {
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
  it("upsertSlot only touches target slot and lastSlotKey, leaving other slots byte-for-byte untouched", () => {
    const base = upsertSlot(null, "zh", "a:m1", R(1), 10);
    const two = upsertSlot(base, "zh", "b:m2", R(2), 20);
    expect(Object.keys(two.slots).sort()).toEqual(["a:m1", "b:m2"]);
    expect(two.lastSlotKey).toBe("b:m2");
    expect(two.slots["a:m1"]).toBe(base.slots["a:m1"]); // Reference unchanged = not rebuilt
    const over = upsertSlot(two, "zh", "a:m1", R(3), 30);
    expect(over.slots["a:m1"].result).toEqual(R(3));
    expect(over.slots["b:m2"]).toBe(two.slots["b:m2"]);
  });
  it("resolveActiveSlot uses lastSlotKey; dangling key returns null", () => {
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
  it("slotKeyOf concatenation", () =>
    expect(slotKeyOf("deepseek", "deepseek-chat")).toBe(
      "deepseek:deepseek-chat",
    ));
});
```

- [ ] **Step 2: Run test to confirm red**: `npm run test --workspace=packages/desktop -- analysisCache`, expect import failure / assertion failure.
- [ ] **Step 3: Implement** (append to analysisCache.ts; `toSlottedDoc` discrimination: `raw.schemaVersion === 2 && raw.slots && raw.lastSlotKey` → v2; `raw.result` exists → v1 wrap `{promptVersion: raw.promptVersion ?? 0, createdAt: raw.createdAt ?? 0, result: raw.result}`; otherwise null. `upsertSlot` shallow copies slots, `promptVersion: PROMPT_VERSION`).
- [ ] **Step 4: Run test to confirm green**; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(desktop): slotted analysis cache envelope v2 + single-source slot predicates (multi-model comparison storage layer)`.

### Task 2: Main Process Wiring — run/deepen Slot Writing, Consumers Using Single Source, backendOverride

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` (run/finish, deepenInner, getCached, getState, aggregate, notebook)
- Modify: `packages/desktop/src/main/learning.ts:159-191, 335-395`
- Modify: `packages/desktop/scripts/learningScan.ts:39-57`
- Modify: `packages/desktop/qa/support/seedAnalysis.ts:30-47`
- Modify: `packages/desktop/src/preload/api.ts` (run input, getState return type)
- Test: `packages/desktop/src/main/analysis.test.ts`

**Interfaces:**

- Consumes: All Task 1 exports.
- Produces:
  - `AnalysisInput` adds `backendOverride?: { backend: AiBackend; model: string }`;
  - `getState(matchId)` returns `{ cached: AnalysisResult|null; running: boolean; slots: Array<{ key: string; createdAt: number; stale: boolean }>; activeKey: string|null }` (`slots` contains summaries only, no result; `stale` = slot promptVersion ≠ current; sorted ascending by createdAt);
  - `getCached(matchId, slotKey?)`: without slotKey uses resolveActiveSlot (current behavior); passing slotKey reads specified slot (version gate still applies).

Key points (all modified at existing code sites; precedents noted in "Verified Facts"):

1. run(): Beside settings snapshot, compute side-by-side `const backend = input.backendOverride?.backend ?? settings.aiBackend ?? "anthropic"; const model = input.backendOverride?.model ?? resolveAiModel(settings); const slotKey = slotKeyOf(backend, model);`; change `resolveAiClient` call to pass `{...settings, aiBackend: backend, aiModels: { ...settings.aiModels, [backend]: model }}` (override merged into snapshot at single point); finish() disk write changed to: read existing file → `toSlottedDoc(raw, slotKey)` → `upsertSlot(...)` → tmp/rename. **Note**: legacySlotKey uses current slotKey (best-effort attribution decided by spec).
2. deepenInner: Path changed to use `analysisCachePath` (converging :394-398 hardcoding); merge rewrites result of the **lastSlotKey slot** (deep dive attributed to most recent analysis), likewise toSlottedDoc → mutate slot → write back.
3. getCached: Read file → `toSlottedDoc(raw, currentSlotKey())` (currentSlotKey = settings-derived, single-point helper) → specified slot or activeSlot → inside slot `promptVersion !== PROMPT_VERSION → null`. en-only legacy `analysis-v2.json` fallback preserved (fallback item also passes through toSlottedDoc).
4. aggregate/notebook: Inside three-candidate file loop, after `JSON.parse`, unify as `const doc2 = toSlottedDoc(doc, "legacy:unknown"); const slot = resolveActiveSlot(doc2); if (!slot || slot.promptVersion !== PROMPT_VERSION) continue;` followed by `doc.result`→`slot.result`, `doc.createdAt`→`slot.createdAt`.
5. Two places in learning.ts + learningScan.ts: Same as above, but **preserve original version gate semantics** (collectExamples/runBackfill originally did not check promptVersion, so continue not checking; only change access path).
6. seedAnalysis.ts: Rewrite to v2 shape (`upsertSlot(null, "zh", "anthropic:claude-sonnet-5", {...})`).

- [ ] **Step 1: Failing tests** (analysis.test.ts append; following `svc()` helper style):

```ts
it("slotted: re-analyzing with backendOverride does not overwrite old slot, getState lists two slots", async () => {
  const { service, dir } = langSvc("zh"); // stream returns fixed findings JSON
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
it("legacy v1 file reading: getCached returns result as normal (lazy migration), re-analysis upgrades to v2 and preserves migrated slot", async () => {
  /* Handwrite v1 file (:184-203 precedent) → getCached hit → run() → file schemaVersion===2 and two slots */
});
it("deepen writes into lastSlotKey slot without touching other slots", async () => {
  /* deepen after two slots → only activeKey slot result.deepened===true */
});
it("aggregate/notebook numbers match pre-refactoring under mixed v1 and v2 files", async () => {
  /* Existing fixture approach writes one v1 match, one v2 single-slot match, assert output identical to single-result era */
});
```

(deepseek slot run needs client: test settings stubs `deepseekApiKey`, or override uses `claudeCli` + injected Runner — choose most economical from existing `svc()` injection surface, implementer decides, explain in report.)

- [ ] **Step 2: Confirm red** (run analysis.test.ts package under workspace scope).
- [ ] **Step 3: Implement the 6 points above.**
- [ ] **Step 4: All green**: `npm run test --workspace=packages/desktop` (existing aggregate/notebook/listAnalyzed/legacy test cases are anti-corruption net for "behavior unchanged", must all pass green) + typecheck + eslint.
- [ ] **Step 5: Commit** `feat(desktop): persist slotted analysis + backendOverride + consumers converge to resolveActiveSlot (multi-model comparison main process)`.

### Task 3: Panel Tab Switching

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css` (tab bar styles, reusing `rpt-` prefix and existing segmented control appearance)
- Test: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 `getState` summary + `getCached(matchId, slotKey)`.
- Produces: `slotLabel(key: string): string` export (splits at first `:`; backend display name mapping `{anthropic:"Claude API", claudeCli:"Claude CLI", agy:"agy", codex:"Codex", deepseek:"DeepSeek"}`; model label looks up `AI_MODELS`, unknown id uses raw string) — reused by Task 4 menu.

Key points: Panel adds `selectedSlotKey: string|null` state (null = follow activeKey); when `slots.length >= 2`, render tab bar at top of results area (`data-testid="analysis-slot-tabs"`, current slot highlighted); click tab → `getCached(matchId, key)` → setResult (with resultForRef guard, reusing existing matchId attribution pattern); new analysis completion (onDone) resets selectedSlotKey=null back to latest; **auto-deep-dive trigger (:291-321) only takes effect on activeKey slot** (viewing older slot does not trigger deepen); stale slot tab adds "Legacy" badge.

- [ ] **Step 1: Failing tests** (fixture stub expands `getState` returning slots/activeKey, `getCached(matchId, key)`): single slot has no tabs; dual slots have tabs and default to activeKey; clicking other tab displays that slot's findings without sending run/deepen; onDone returns to new slot.
- [ ] **Step 2: Confirm red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: All green** + typecheck + eslint.
- [ ] **Step 5: Commit** `feat(desktop): multi-model slot tab switching on analysis panel (only shown when ≥2 slots)`.

### Task 4: Split Button "Use Another Model for Analysis"

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx` (button area :366-376)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `StructuredAnalysisPanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 `run({...input, backendOverride})`; Task 3 `slotLabel`; `bridge().ai.detectCli(backend)`; settings sentinel (`settings.get()` `anthropicApiKey`/`deepseekApiKey` truthiness).

Key points: Narrow arrow button attached to right side of `rpt-ai-primary` (`data-testid="analysis-model-picker"`, aria-label "Use another model for analysis"); click opens dropdown menu: lists available backends × models grouped (`slotLabel` copy), unavailable backends do not appear (CLI = `detectCli(backend).path !== null`, concurrently probe 3 CLIs once on first opening menu and cache in component state; API = key sentinel truthiness); current global default item suffixed with "(default)"; selection → `handleAnalyze` variant with `backendOverride`, **does not write settings**. Menu closes on select / outside click / Esc. Split button fully disabled while running.

- [ ] **Step 1: Failing tests**: stub `ai.detectCli` (agy has path, claude/codex null) + settings only configures anthropic key → menu items = anthropic all models + "(default)" tag + agy all models, no deepseek/codex/claudeCli; selecting agy:flash → `run` receives `backendOverride:{backend:"agy",model:"flash"}` and `settings.save` is not called.
- [ ] **Step 2: Confirm red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: All green** + typecheck + eslint. **Note in report**: report-ai visual baseline will change (button has added arrow), CI re-generates for human review, do not run test:visual locally.
- [ ] **Step 5: Commit** `feat(desktop): analysis split button arrow 'Use another model for analysis' (temporary switch does not write global settings)`.

### Task 5: Wrap-up — Gates, Push, Baseline, Accounting

**Files:**

- Modify: `docs/BACKLOG.md` (record one line "Multi-model comparison landed" near #20 + real-device verification handoff items)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/report-ai.png` (CI generated for human review)

- [ ] **Step 1**: `npm run presubmit` all green (report honestly if red, do not self-patch).
- [ ] **Step 2**: BACKLOG accounting commit; push after fetch/rebase; watch test.yml by headSha.
- [ ] **Step 3**: If frontend-qa is red only on report-ai → expected, `gh workflow run visual-baseline.yml --ref main` → download artifact → cmp → human review PNG (diff must be only arrow in button area / menu not captured) → commit, push, watch green; report other failures honestly.
- [ ] **Step 4**: Report: Before/after comparison of slotted behavior (single-slot unchanged behavior evidence = all existing tests green), real-device verification checklist (dual-model analysis on same match → tab comparison → temporary menu).

## Self-Review Records

1. **Spec Coverage**: §1 Storage = T1+T2; §2 Consumption Basis = T2 (helper single-source + anti-corruption); §3 Tabs = T3; §4 Split = T4; §5 Boundaries has no tasks (correct); §6 Testing maps each task's Step 1 + T5 baseline. Finding flag item follows Global Constraints deviation decision (requires user awareness).
2. **Placeholders**: The last three test cases in T2 Step 1 are comment blocks, all with construction methods and assertion targets clearly specified, following the first example style — conforming to repo 17a+17b plan precedent; no TBDs.
3. **Type Consistency**: `AnalysisSlot/AnalysisCacheDocV2/toSlottedDoc/resolveActiveSlot/upsertSlot/slotKeyOf` defined in T1, consumed in T2-4; `backendOverride` shape defined in T2, consumed in T4; `slotLabel` defined in T3, consumed in T4.
