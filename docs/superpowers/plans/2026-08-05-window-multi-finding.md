# Window Deep Dive Multi-Finding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change window/moment deep dive output from a single paragraph to 1~4 independent findings (audited individually), list them in UI, and re-test A/B.

**Architecture:** Only modify the window mode contract; deepen automatic round contract remains unchanged (fixed by tests). `auditDeepDives` allows "multiple entries for the same findingIndex (only in window mode)"; `DeepDiveResult` adds `title?`; main's analyzeWindow result/cache changes to `entries[]`; PROMPT_VERSION 18.

**Spec:** `docs/superpowers/specs/2026-08-05-window-multi-finding-design.md`

## Global Constraints

- Placeholder zero-digit discipline remains unchanged; title ≤20 characters with no digits (raw digit audit covers title, placeholders are not included in title).
- deepen (automatic round) behavior and output contract **byte-level unchanged** — multiple entries for the same findingIndex are only allowed in window mode, redundant entries in deepen mode are dropped and counted as dropped.
- Use `npm run typecheck` for typecheck; `npm run presubmit` before push; commit directly to main; working directory `/Users/mingjianliu/code/gladlog` main checkout.
- commit message bottom two lines: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QjhGtTfR12CLySZNCg63w7`.

---

### Task 1: analysis Package Contract Multi-Itemization

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts` (append locally) + existing deepen tests untouched as regression pins

**Interfaces:**

- Produces: `DeepDiveResult` adds `title?: string`; `auditDeepDives(parsed, packs, opts?: { mode?: "deepen" | "window" })` — mode defaults to "deepen" (current status quo); "window" mode allows multiple entries for the same findingIndex (≤4, excess discarded), each running through the full audit pipeline independently (placeholder key validation → claimChecker → bare digits (including title) → repairSpellNameZh → causalLint → interpolate + chips).
- prompt: `buildDeepDivePrompt` output contract line in window mode changed to `Output ONLY a JSON array (1-4 entries; [] if nothing is defensible): [{ "findingIndex": number, "title": string, "deepDive": string, "citedKeys": string[] }]`, and appends a line of HARD RULE (window only): `Each entry must focus on ONE unit or ONE decision; fewer, better-grounded entries beat padding; title ≤20 chars, no digits.` (matching existing HARD RULES style). deepen mode contract line remains as-is.

- [ ] **Step 1: Failing tests**: In window mode: (a) 3 entries with the same index all pass audit → 3 `DeepDiveResult` items (title passed through); (b) 1 out of 3 entries contains bare digits → only that entry is dropped, other 2 survive; (c) 5th entry is discarded; (d) title containing digits → whole entry is dropped; (e) 2 entries with the same index in deepen mode → only the first entry is retained (current status quo semantics; pinned if existing behavior drops subsequent entries); (f) prompt: window mode contains new contract line and new HARD RULE, deepen mode does not.
- [ ] **Step 2: Run red** `npm test --workspace=packages/analysis -- deepDive.window`
- [ ] **Step 3: Implementation** (read existing auditDeepDives same-index handling logic before changing, avoid breaking deepen path)
- [ ] **Step 4: Run green** + analysis workspace full test + typecheck
- [ ] **Step 5: Commit**: `feat(analysis): window deep dive output multi-itemization —— 1-4 independent findings per anchor audited individually`

### Task 2: main / preload / UI Wiring

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` (analyzeWindow ok branch + WindowCacheEntry)
- Modify: `packages/desktop/src/shared/promptVersion.ts` (17→18, document note per convention)
- Modify: `packages/desktop/src/preload/api.ts` (analyzeWindow return type)
- Modify: `packages/desktop/src/renderer/src/report/components/WindowAnalysisCard.tsx` (single paragraph → list)
- Test: `packages/desktop/src/main/analysis.test.ts` + `packages/desktop/test/windowAnalysis.test.tsx`

**Interfaces:**

- Consumes: Task 1's `auditDeepDives(..., { mode: "window" })` and `DeepDiveResult.title`.
- Produces: `WindowAnalyzeResult` ok branch = `{ status: "ok"; entries: Array<{ title: string|null; text: string; chips: DeepDiveResult["chips"] }>; fromCache: boolean }`; cache entries share same shape (old cache naturally misses due to PROMPT_VERSION 18, no migration needed).

- [ ] **Step 1: Failing tests**: analyzeWindow multi-item result written to cache and second hit returns same entries; WindowAnalysisCard renders 2 entries (respective title/text/chips) and 1 entry (omits title row when title is absent).
- [ ] **Step 2: Run red** → **Step 3: Implementation** → **Step 4: Run green** + desktop full test suite + typecheck + repo-wide eslint
- [ ] **Step 5: Commit after `npm run presubmit` is green**: `feat(desktop): window deep dive multi-item rendering + entries cache + PROMPT_VERSION 18`
- [ ] **Step 6 (Performed by Controller): Push followed by visual baseline workflow** (update WindowAnalysisCard if included in baseline scenarios).

### Task 3: momentDiveAb Adaptation + N=20 Retest

**Files:**

- Modify: `packages/eval/scripts/momentDiveAb.ts` (both arms entries[]: item count = entries.length; judge fed "concatenation of all entries' title + body"; remainder of mechanism untouched)
- Modify: `docs/superpowers/specs/2026-08-05-window-multi-finding-design.md` (backfill metrics)

- [ ] **Step 1: Adapt script** (clean typecheck/eslint, N=2 smoke test passes) → Commit `fix(eval): momentDiveAb adapted for multi-item contract`
- [ ] **Step 2 (Executed by Controller): Official N=20 run** (nohup + monitoring, anti-contamination mechanisms in place)
- [ ] **Step 3: Backfill metrics to spec + commit**; decision rule: flip deepDiveSnapshot default only if B win rate > 50%, otherwise maintain deprecated status quo, keeping multi-itemization itself.

## Self-Review Notes

- One modification point across each of four layers: contract / audit / UI / eval, with end-to-end type propagation (`title?: string → entries[].title: string|null`); deepen regression pinned by existing tests + Task 1(e).
