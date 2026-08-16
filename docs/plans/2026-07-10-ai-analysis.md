# Subproject 4a: In-App AI Review + Data Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port proprietary AI analysis system (24-file closure + buildMatchContext) to `@gladlog/analysis`, connect main process Anthropic streaming + match report AI panel, rebuild benchmark from local stratified corpus + generate realignment report.

**Architecture:** Porting tasks follow the **controller extraction + implementer mechanical transformation** model: Claude (controller) extracts CLEAN source files from the old fork into final paths (implementer never touches the old fork); agy adjusts imports / modifies data integration points according to rewriting rules, guarded by contract tests. New code (main process ai / panel / benchmark stratification) follows standard TDD. Spec: `docs/specs/2026-07-10-ai-analysis-design.md`.

**Tech Stack:** TypeScript ESM, vitest, `@gladlog/parser-compat` (legacy shapes), lodash, `@anthropic-ai/sdk` (desktop main only), React (panel).

## Global Constraints

- **Compliance (Hard)**: Implementer (agy) must not access `/Users/mingjianliu/code/wowarenalogs`; all old fork source files are copied into gladlog by controller before delivery. Ported files are audited CLEAN (`discoveryRules.ts` L11, `ccCoverage.test.ts` L1 are NEEDS_SCRUB; controller rewrites those lines according to audit line numbers during copy).
- **Zero Logic Change Porting Principle**: Batch porting tasks only permit (a) rewriting import specifiers `@wowarenalogs/parser` -> `@gladlog/parser-compat`, `lodash` retained; (b) adjusting relative paths to match new layout; (c) data integration modifications named in plan (spellEffectData). Any other behavioral changes = breach of contract, report BLOCKED.
- ESM, TS strict, vitest globals, tests inside package `test/`; root `npm test --workspaces --if-present` all green.
- `benchmark_data.json` refitting threshold: stratified sampling + per-spec n disclosure + min n (default 30) + move thresholds only when new/old drift direction is consistent (spec already decided).
- API key in main process only; model defaults to `claude-sonnet-5`.
- TDD, one commit per task.

## Extraction List (Controller only; target path = under `packages/analysis/src/`)

```
Old packages/shared/src/utils/{binarySearch,utils,dampening,talents,talentBehaviors,
  spellDanger,enemyInterrupts,losAnalysis,cooldowns,enemyCDs,offensiveWindows,
  drAnalysis,ccTrinketAnalysis,dispelAnalysis,dispelFeatureFlags,discoveryRules,
  talentModifiers,healingGaps,healerOffenseAnalysis,killWindowTargetSelection}.ts
    -> src/utils/ same name
Old packages/shared/src/data/{spellTags,arenaGeometry,spellEffectData}.ts -> src/data/
Old packages/shared/src/data/{talentModifiers,trinketItemIds,spellNames}.json -> src/data/ (only if actually used, verified in T2)
Old packages/shared/src/components/CombatReport/CombatPlayers/talentStrings.ts -> src/data/talentStrings.ts
Old packages/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext.ts -> src/context/buildMatchContext.ts
Old packages/shared/src/utils/__tests__/ proprietary tests dependent only on modules within closure -> test/ported/
Reference (not copied into repo, read by controller and described to implementer): CombatAIAnalysis/index.tsx (panel logic), web/pages/api/analyze.ts (streaming backend logic)
```

---

### Task 1: `packages/analysis` Scaffold

**Files:** Create `packages/analysis/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,test/smoke.test.ts}`

**Interfaces:** Produces package skeleton: `@gladlog/analysis`, deps `{"@gladlog/parser-compat":"0.0.1","lodash":"^4.17.21"}`, devDeps `{"@types/lodash":"^4.17.0","typescript":"^5.5.0","vitest":"^2.0.0","@types/node":"^26.1.1"}`, scripts test/typecheck follow parser conventions (`vitest run --passWithNoTests`); tsconfig references parser-compat (strict, ESM, noEmit); `src/index.ts` starts with empty export `export {};`.

- [ ] Step 1: Create five files per above (tsconfig/vitest copied verbatim from corresponding packages/parser-compat files); smoke.test.ts asserts `import * as pkg from "../src/index"` does not throw.
- [ ] Step 2: In root directory run `npm install`; `npm test -w @gladlog/analysis && npm run typecheck -w @gladlog/analysis` PASS.
- [ ] Step 3: Commit `feat(analysis): package scaffold`.

---

### Task 2: Data Layer Batch (Controller Extraction + spellEffectData Refactor)

**Files:** Create `src/data/{spellTags.ts,arenaGeometry.ts,talentStrings.ts,discoveryRules.ts,dispelFeatureFlags.ts,talentModifiers.ts (util moved into data? keep in utils/ original location),spellEffectOverrides.ts,spellEffectData.ts}` + JSONs actually used; Test `test/data.test.ts`

**Workflow:**

- [ ] Step 1 (Controller): Copy spellTags/arenaGeometry/talentStrings/discoveryRules (rewrite L11 into semantically equivalent original expression)/dispelFeatureFlags into place; grep all call sites inside closure for `spellEffectData`/`getEnglishSpellName`/JSONs, produce a list of "referenced spell ID set + required fields" written to `.superpowers/sdd/spelleffect-usage.md`; verify whether talentModifiers.json/trinketItemIds.json/spellNames.json are imported by closure, copy only if referenced.
- [ ] Step 2 (Controller): Write `src/data/spellEffectOverrides.ts` by hand based on usage list —— `export const SPELL_EFFECT_OVERRIDES: Record<string, IMinedSpell>`, containing only referenced spells, durations/cooldowns sourced from Blizzard public facts, header comment documenting source and Subproject 5 replacement plan.
- [ ] Step 3 (agy): Refactor `spellEffectData.ts`: delete `import rawMinedData from './spellEffects.json'`, switch data source to `SPELL_EFFECT_OVERRIDES`; preserve `IMinedSpell` interface and all exported function signatures (`spellEffectData`, `getEnglishSpellName`, etc.) unchanged; other files only adjust import paths.
- [ ] Step 4 (Contract, Claude writes first): `test/data.test.ts` —— (a) each spellId in usage list has an entry in `SPELL_EFFECT_OVERRIDES` and at least one of `durationSeconds ?? cooldownSeconds` has a value; (b) `getEnglishSpellName` returns non-empty for first ID on list; (c) `ccSpellIds` (spellTags) is a non-empty set; (d) discoveryRules/dispelFeatureFlags are importable and shape is unchanged (existence of named exports).
- [ ] Step 5: `npm test -w @gladlog/analysis && npm run typecheck -w @gladlog/analysis` PASS -> Commit `feat(analysis): data layer port with curated spell-effect overrides`.

---

### Task 3: Base Utils Batch

**Files:** Create `src/utils/{binarySearch,utils,dampening,talents,talentBehaviors,spellDanger,enemyInterrupts,losAnalysis}.ts`; Test `test/base-utils.test.ts` + `test/ported/` (applicable proprietary tests)

- [ ] Step 1 (Controller): Copy 8 files into place; port proprietary tests from `__tests__` dependent only on this batch + T2 modules to `test/ported/` (import paths adjusted by agy).
- [ ] Step 2 (agy): Adjust imports (rules per Global Constraints); do not change logic.
- [ ] Step 3 (Contract): `test/base-utils.test.ts` —— `computeDampening` synthetic assertions (0s->0%, known duration->monotonically increasing), `binarySearchClosest` three exact assertion cases, `getSpecTalentTreeSpellIds` returns non-empty for any healer spec (depends on talentStrings/talentModifiers).
- [ ] Step 4: All green -> Commit `feat(analysis): base utils port`.

---

### Task 4: Core Analysis Batch A (cooldowns / enemyCDs / offensiveWindows) + Legacy Fixture Bridge

**Files:** Create `src/utils/{cooldowns,enemyCDs,offensiveWindows}.ts`, `test/helpers/legacyFixture.ts`; Test `test/core-a.test.ts`

- [ ] Step 1 (Controller): Copy 3 files.
- [ ] Step 2 (agy): Adjust imports; create `test/helpers/legacyFixture.ts`: read `packages/desktop/test/fixtures/report-match.json` -> backfill empty `rawLines: []` -> `toLegacyMatch` (from `@gladlog/parser-compat`; exact signature per compat source, report BLOCKED if shape mismatches) -> export `loadLegacyMatchFixture(): IArenaMatch`.
- [ ] Step 3 (Contract): `test/core-a.test.ts` —— fixture smoke: `extractMajorCooldowns` (or actual main export from cooldowns.ts, agy reports exact name) returns array with timing tag fields on elements; `specToString(CombatUnitSpec)` non-empty for all fixture units; enemyCDs timeline produced for fixture in ascending chronological order; offensiveWindows state machine does not throw on fixture and windows have start < end.
- [ ] Step 4: All green -> Commit `feat(analysis): core analysis batch A (cooldowns/enemyCDs/offensiveWindows)`.

---

### Task 5: Core Analysis Batch B (drAnalysis / ccTrinketAnalysis / dispelAnalysis)

**Files:** Create 3 files; Test `test/core-b.test.ts` + port proprietary tests like ccCoverage (controller rewrites NEEDS_SCRUB line)

- [ ] Workflow identical to Task 4 (controller copies -> agy adjusts imports -> contract: getDRLevel synthetic DR chain exact assertions 0/25/50/75; fixture smoke ccTrinket/dispel do not throw and shaped fields exist) -> Commit `feat(analysis): core analysis batch B (dr/ccTrinket/dispel)`.

---

### Task 6: Core Analysis Batch C + buildMatchContext

**Files:** Create `src/utils/{healingGaps,healerOffenseAnalysis,killWindowTargetSelection}.ts`, `src/context/buildMatchContext.ts`, `src/index.ts` consolidated exports; Test `test/context.test.ts`

- [ ] Step 1-2: Controller copies 4 files; agy adjusts imports; `src/index.ts` exports all public APIs (utils + context + data types).
- [ ] Step 3 (Contract): `test/context.test.ts` —— `buildMatchContext(loadLegacyMatchFixture(), ...)` (exact signature reported by agy from source) returns string: non-empty, contains player name, contains "dampening" or corresponding section header, length > 2000; healerOffense returns disabled state for fixture variant without advanced logs (spec: completely disabled without advanced).
- [ ] Step 4: All green -> Commit `feat(analysis): batch C + buildMatchContext; public API assembled`.

---

### Task 7: Desktop Main Process AI Module + Bridge

**Files:** Create `packages/desktop/src/main/ai.ts`; Modify `src/main/index.ts` (register), `src/main/ipc.ts`, `src/preload/{index.ts,api.ts}`; deps `@anthropic-ai/sdk`; Test `packages/desktop/test/ai.test.ts`

**Interfaces (bridge delta):**

```ts
ai: {
  analyze(matchId: string, context: string): Promise<void>;   // trigger; results via events
  cancel(): Promise<void>;
  getCached(matchId: string): Promise<{ content: string; model: string; createdAt: number } | null>;
  onDelta(cb: (d: { matchId: string; text: string }) => void): () => void;
  onDone(cb: (d: { matchId: string; content: string }) => void): () => void;
  onError(cb: (d: { matchId: string; message: string }) => void): () => void;
}
```

**ai.ts Contract**: `createAiService(deps: { getSettings: () => GladlogSettings; clientFactory?: (key: string) => AnthropicLike; matchesDir: string; emit: (channel, payload) => void })`; `AnthropicLike = { stream(params): AsyncIterable<{ delta?: string }> }` dependency injected; missing key -> emit error `NO_API_KEY`; stream deltas emitted individually; on completion write `matchesDir/<matchId>/analysis.json` envelope `{ schemaVersion:1, model, promptVersion: PROMPT_VERSION, createdAt, content }`; `cancel()` aborts current stream; only one analysis active at a time (new requests cancel old). Real client adapted to AnthropicLike with `new Anthropic({ apiKey }).messages.stream({ model, max_tokens: 4096, messages: [{role:'user', content: context}] })`.

- [ ] Step 1 (Contract first, Claude writes): Fake client (controllable delta sequence / errors / hanging) injected, asserting: missing key error; delta ordering; done writes envelope to disk; no further emits after cancel; new analyze cancels old.
- [ ] Step 2 (agy): Implement ai.ts + wire ipc/preload (channel `gladlog:ai:*`).
- [ ] Step 3: Desktop full tests + typecheck + build green -> Commit `feat(desktop): main-process Anthropic streaming ai service`.

---

### Task 8: AI Panel (Logic Port + Reskin) + Match Report Page Mounting

**Files:** Create `packages/desktop/src/renderer/src/report/components/AIAnalysisPanel.tsx`; Modify `MatchReport.tsx` (right column tabs: Unit Details | AI Analysis), `styles.css`; Test `test/report.ai-panel.test.tsx`

- [ ] Step 1 (Controller): Read old `CombatAIAnalysis/index.tsx`, translate state machine logic (idle/streaming/done/error, cache-first, re-analyze) into precise behavior checklist for agy; prompt assembly point = `buildMatchContext` (from `@gladlog/analysis`), bridge `StoredMatch -> toLegacyMatch` in useMemo within panel.
- [ ] Step 2 (Contract): jsdom tests (mock bridge ai surface): missing key -> setup instructions; click analyze -> onDelta injects two text chunks progressively appearing; getCached hit -> displays cache directly + "Re-analyze" button.
- [ ] Step 3 (agy): Implement panel (slate dark tokens, markdown rendered with `<pre>` whitelist fallback, no md library in v1) + tabify MatchReport right column.
- [ ] Step 4: All green + fixture mode manual smoke (controller screenshot confirms visuals) -> Commit `feat(desktop): AI analysis panel wired to report page`.

---

### Task 9: Benchmark Rebuild CLI (Stratified Sampling)

**Files:** Create `packages/analysis/scripts/collectBenchmarks.ts`, `src/benchmark/{stratify.ts,metrics.ts}`; Test `test/benchmark.test.ts`

- [ ] Step 1 (Controller): Copy metrics calculation part from old `collectBenchmarks.ts` as `src/benchmark/metrics.ts` base (strip GCS/download logic, change input to IArenaMatch[]); team archetype categorization: simplified rule `healerSpec + meleeCount/rangedCount` combo string.
- [ ] Step 2 (Contract): `stratify.ts` pure function tests —— given meta list (spec, rating, archetype), stratified sampling by spec × archetype, respecting minN (take all if insufficient and mark insufficient), balanced upper limit per stratum; `metrics.ts` emits all fields on fixture single match (pressure P90/HPS/DPS/timing distribution/never-used/purge/dampening at death).
- [ ] Step 3 (agy): Implement CLI: `--manifest <path-list> --min-rating 2100 --min-n 30 --out benchmarks/benchmark_data.json`; workflow = file by file parse with new parser+compat -> rating filter -> stratify -> aggregate metrics -> output containing `{ generatedAt, parser: 'gladlog', sampleSizes: perSpec }`; old `benchmark_data.json` copied by controller to `benchmarks/benchmark_data.old-parser.json` (immutable baseline).
- [ ] Step 4: 10-match small manifest end-to-end + all green -> Commit `feat(analysis): local-corpus benchmark rebuild with stratified sampling`.

---

### Task 10: Data Realignment First Round + Real API Smoke + Finalization (Controller Led)

- [ ] Step 1: Controller runs `collectBenchmarks` on full corpus (caffeinate, background); emits comparison script (new vs old per-spec table + drift% + direction) -> report `docs/reports/2026-07-XX-benchmark-realignment.md`, providing PANIC threshold conclusions per spec dual-confirmation rules; agy verify cross-checks report conclusions.
- [ ] Step 2: Controller real key smoke test: run full analysis flow on real match in app (requires user to provide key in settings or execute with user present — does not block other steps).
- [ ] Step 3: Final whole-branch review (pro) -> close findings loop; repo-wide test + typecheck; package macOS smoke test.
- [ ] Step 4: Ledger + README (Subproject 4 not checked off since 4b not done; README can add "4a ✅ (4b eval toolchain pending)" note) -> Commit `docs: sub-project 4a complete`.

---

## Self-Review (Plan Verification)

- **Spec Coverage**: analysis package (T1-6), spellEffectOverrides (T2), main process streaming + cache + cancellation (T7), panel + mounting (T8), benchmark stratification + immutable baseline (T9), realignment report + dual confirmation (T10), API forward compatibility (index.ts export layer does not lock shape, T6). All sections have corresponding tasks.
- **Placeholders**: The "content" of ported batch tasks is the old CLEAN files themselves, supplied by controller extraction steps — not placeholders; contracts and new code interfaces are provided. Exact function signatures (cooldowns main exports, buildMatchContext, toLegacyMatch) are annotated with "agy reports from source / BLOCKED escalation" mechanism, avoiding fabricated signatures in the plan.
- **Type Consistency**: bridge ai surface (T7) matches panel consumption (T8); legacyFixture (T4) shared across T4-6; stratify/metrics (T9) self-consistent.
- **Risks**: If compat types miss isolated exports like `CombatExtraSpellAction` -> escalate BLOCKED from T4, controller adds re-export in parser-compat (zero behavior). lodash ESM compatibility (`import _ from 'lodash'` works in vitest).
