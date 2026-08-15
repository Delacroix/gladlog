# Moment-Level Deep Dive (Deep Dive This Moment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dense moment snapshot to the deepDive/windowAnalysis pipeline (cooldown ledger / DR / auras / distance and LoS / gaps / HP) + a "Deep Dive This Moment" entry point in the replay + an auto-round settings toggle.

**Architecture:** Fully reuse the existing deepDive pipeline (`windowOverride`, zero raw numbers discipline, `auditDeepDives`, windowAnalysis cache). Add `momentSnapshot.ts` providing a snapshot item collector (pure function, only composing existing predicates); add a `snapshot` flag to `buildWindowPack`/`buildDeepenPacks`; manual entry point always enables snapshot, auto deepen round is determined by the `deepDiveSnapshot` setting (default off = byte-for-byte identical to status quo).

**Tech Stack:** TypeScript monorepo (packages/analysis pure functions + vitest; packages/desktop Electron main/renderer; packages/eval gate rules).

**Spec:** `docs/superpowers/specs/2026-08-05-moment-deep-dive-design.md` (includes debate conclusions).

## Global Constraints

- Gate predicate as specification (CLAUDE.md): Use `getHpPercentAtTime`/`HP_SAMPLE_RADIUS_MS` for HP; `getUnitPositionAtTime` for position interpolation; LoS MUST use `getUnitRawPositionAtTime` + `hasLineOfSight` (**null means "unknown", NEVER treat as false**); `distanceBetween` for distance; `cdAvailableAt` for cooldowns; `analyzeOutgoingCCChains` for DR; `detectHealingGaps` for healing gaps. **NEVER manually write a second set of checks in the new file**.
- Timestamps in facts must be floored to the rendering grid (`Math.floor`, same grid as `fmtTime`) before writing; numbers must go through `fmtFactNum` (existing practice in deepDive.ts, see how the `hp` item is written).
- Zero numbers discipline in prose is not relaxed: all citable numbers must be in facts; cast flow is only for context paragraphs.
- Auras **must NOT include remaining duration** (inferredEnd semantic pitfalls, not a spec target); mana/resources are not done (parser is always empty).
- `PACK_MAX_ITEMS = 14` remains unchanged; snapshot mode independently uses `MOMENT_PACK_MAX = 32`.
- Use `npm run typecheck` for type checking, never `tsc -b`; before pushing, run `npm run presubmit` (repo root).
- Commits go directly into main, one commit per task; commit message ends with Co-Authored-By (see recent commit styles in the repo).
- Register all newly added shared predicates in `docs/predicate-index.md` (matching consistency tests in `packages/eval/test/predicateIndex.test.ts`).
- Working directory must be `/Users/mingjianliu/code/gladlog` (main checkout, no worktree).

---

### Task 1: momentSnapshot Collector (analysis package)

**Files:**

- Create: `packages/analysis/src/analysis/momentSnapshot.ts`
- Create: `packages/analysis/src/analysis/momentSnapshot.test.ts`
- Modify: `packages/analysis/src/analysis/deepDive.ts` (PackItem kind union + PACK_ITEM_KIND_ZH, lines ~57-70 and ~1110-1126)

**Interfaces:**

- Consumes (all existing exports):
  - `extractMajorCooldowns(unit, combat): IMajorCooldownInfo[]`, `cdAvailableAt(cd, tSeconds): boolean`, `getUnitHpAtTimestamp`, `HP_SAMPLE_RADIUS_MS`, `fmtTime` (`../utils/cooldowns`)
  - `getHpPercentAtTime(unit, atSeconds, matchStartMs)`, `getLowestHpPercentInWindow(unit, fromS, toS, matchStartMs)` (`../utils/killWindowTargetSelection`)
  - `buildAuraIntervals(unit, combat)` (**`../utils/auraIntervals`, NOT the same-named function in `../utils/utils`**)
  - `getUnitPositionAtTime`, `getUnitRawPositionAtTime`, `hasLineOfSight`, `distanceBetween` (`../utils/losAnalysis`); `INTERP_MAX_GAP_MS`, `LOS_SWEEP_GAP_MS` (`../utils/positionSampling`)
  - `analyzeOutgoingCCChains(friends, enemies, combat)` (`../utils/drAnalysis`)
  - `detectHealingGaps(healer, friends, enemies, combat): IHealingGap[]` (`../utils/healingGaps`)
  - `isHealerSpec`, `specToString`
- Produces (Task 2/4 depend on these, verbatim signatures):
  - `export function buildMomentSnapshotItems(combat: any, fromS: number, toS: number, ownerName?: string): Omit<PackItem, "key">[]`
  - `export function buildCastFlowLines(combat: any, fromS: number, toS: number): string[]` (each line `M:SS Name(Spec) → SpellName`, timestamp `fmtTime(Math.floor(relS))`, ascending in time, capped at 90 lines, tails beyond limit dropped and appended with `…(+N more)` on last line)
  - `export function aurasActiveAt(unit: any, combat: any, t: number): string[]` (list of active aura names on unit, ≤10; internally `buildAuraIntervals(unit, combat).filter(iv => iv.fromS <= t && t <= iv.toS)`)
  - `export function largestCastGap(unit: any, fromS: number, toS: number, matchStartMs: number): { fromT: number; toT: number; gapS: number } | null` (largest interval between adjacent SPELL_CAST_SUCCESS in window, window boundaries count as endpoints; returns null if <4s — threshold constant `export const ACTIVITY_GAP_MIN_S = 4`)
  - `export const MOMENT_PACK_MAX = 32;`
  - deepDive.ts `PackItem["kind"]` union adds 7 new members: `"cd-ledger" | "aura-snap" | "pos-snap" | "dr-state" | "healing-gap" | "activity-gap" | "hp-snap"`; `PACK_ITEM_KIND_ZH` adds: cd-ledger→"CD Ledger", aura-snap→"Aura Snapshot", pos-snap→"Position Snapshot", dr-state→"DR Tier", healing-gap→"Healing Gap", activity-gap→"Cast Gap", hp-snap→"HP Snapshot"

**Item Construction Specs (facts all strings; timestamps `String(Math.floor(s))`; names use deepDive's `sn()` same-style short name — duplicate a private 1-line `sn` in this file, does not count as a predicate):**

| kind | per item | facts | label(chip) |
| --- | --- | --- | --- |
| `cd-ledger` | 1 per player | `t, unit, role, ready, onCd` (ready/onCd joined by ", ", or "none" if empty) | `${sn(name)} CD Ledger` |
| `aura-snap` | 1 per player (skipped if no active auras) | `t, unit, role, auras` | `${sn(name)} Auras` |
| `pos-snap` | 1 per owner↔every other player (skipped if pos unavailable on either side) | `t, unit, role, dist` (integer yards); adds `los` ("clear"/"blocked"; null omits this field) under 3-state LoS | `Dist to ${sn(name)}` |
| `dr-state` | 1 per landed CC in window | `t, caster, target, spell, drLevel, durationS` (drLevel uses `ap.drInfo?.level` raw string) | `${spell} DR` |
| `healing-gap` | 1 per window gap (gap intersects [fromS,toS]) for each friendly healer | `unit, fromT, toT, gapS, pressured` (pressured=mostDamagedName short name) | `${sn(name)} Healing Gap` |
| `activity-gap` | 1 per player (generated only when largestCastGap is non-null; skipped for healers already having healing-gap) | `unit, role, fromT, toT, gapS` | `${sn(name)} Cast Gap` |
| `hp-snap` | 1 per player (skipped if all three values are null) | `t0, t1, unit, role, hpStart, hpEnd, hpMin` (omits unavailable fields) | `${sn(name)} HP` |

Role determination identical to deepDive: owner / teammate / enemy (per `ownerName` and `reaction`). `t` is always sampled at `Math.floor` timestamp; sampling timestamp for cd-ledger/aura-snap/pos-snap = window midpoint `Math.floor((fromS+toS)/2)` (death anchor entry point makes midpoint ≈ anchor). LoS for pos-snap: both sides use `getUnitRawPositionAtTime(u, atMs, LOS_SWEEP_GAP_MS)`, omit `los` field if either side is null; position/distance uses `getUnitPositionAtTime(u, atMs, INTERP_MAX_GAP_MS)`.

- [ ] **Step 1: Write failing test** (`momentSnapshot.test.ts`; fixture uses analysis package test construction convention — first `grep -rn "buildAuraIntervals\|analyzeOutgoingCCChains" packages/analysis/src --include='*.test.ts' -l` to find an existing minimal unit construction template to copy). Cover at minimum:

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
  it("largestCastGap: window boundaries count as endpoints, returns only when largest gap reaches threshold", () => {
    // unit casts twice at t=12s and t=20s, window [10,30] -> largest gap is 20->30 (10s)
    // assert {fromT:20, toT:30, gapS:10}; window [10,21] -> gap 8s (12->20); all gaps <ACTIVITY_GAP_MIN_S -> null
  });
  it("aurasActiveAt: only takes active aura names at timestamp t, <=10", () => {});
  it("buildMomentSnapshotItems: facts fields complete for every kind and all numbers are integer strings (zero decimal place discipline)", () => {
    // assert all facts values match /^[^.]*$|^\d+$/ with no decimals in numeric fields; t is floored integer string
  });
  it("buildCastFlowLines: ascending, capped at 90, (+N more) tail marker when exceeded", () => {});
});
```

- [ ] **Step 2: Run test to confirm red**: `npm test --workspace=packages/analysis -- momentSnapshot` (expected module not found)
- [ ] **Step 3: Implement** `momentSnapshot.ts` + deepDive.ts kind union and ZH table expansion. File header comment: "Snapshot collector only composes existing predicates; no literals for sampling radius / distance thresholds / DR constants may appear in this file (gatekeeper predicates serve as specifications)."
- [ ] **Step 4: Run test to confirm green**; run `npm test --workspace=packages/analysis` (full package regression-free) + `npm run typecheck`
- [ ] **Step 5: Commit**: `feat(analysis): momentSnapshot collector -- 7 snapshot item types + aurasActiveAt/largestCastGap predicates`

---

### Task 2: pack/prompt Wiring (Snapshot Toggle, Default Path Byte-for-Byte Unchanged)

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`:
  - `buildDeepDivePack(..., windowOverride?, opts?: { snapshot?: boolean })` (line ~124 add opts to signature tail)
  - `buildWindowPack(combat, fromS, toS, candidates, ownerName?, opts?: { snapshot?: boolean })` (line ~1062)
  - `DeepDivePack` adds optional field `castFlow?: string[]`
  - `buildDeepDivePrompt` (line ~884): when pack has `castFlow`, append fixed paragraph after item list in that pack subsection
- Test: `packages/analysis/src/analysis/deepDive.test.ts` (append if exists; create if not)

**Interfaces:**

- Consumes: Task 1's `buildMomentSnapshotItems` / `buildCastFlowLines` / `MOMENT_PACK_MAX`
- Produces: `opts.snapshot` toggle semantics relied upon by Task 4/5: **omitted / false = status quo byte-for-byte unchanged**; true = items appends snapshot kinds, cap switches to `MOMENT_PACK_MAX`, pack.castFlow populated.

**Implementation Points:**

1. In existing truncation point in `buildDeepDivePack` (`PACK_MAX_ITEMS`, lines ~489-493): when snapshot, push `buildMomentSnapshotItems(combat, anchorFrom, anchorTo, ownerName)` to raw, then truncate by quota: within snapshot kinds, fill to `MOMENT_PACK_MAX` following "cd-ledger/hp-snap/activity-gap keep 1 per unit -> pos-snap <=5 -> rest sorted by time distance to focusT"; non-snapshot branch untouched by a single line.
2. `buildWindowPack` passes opts through to `buildDeepDivePack`; survival gate `hasCoachableSignal` determination **only looks at non-snapshot kinds** (snapshots are state, not signals; "having ledger" cannot pass gate alone) — export a `const SNAPSHOT_KINDS = new Set<PackItem["kind"]>([...7 kinds])` and filter them out in gate.
3. `buildDeepDivePrompt`: when pack.castFlow exists, append after item list:

```
CAST FLOW (context only — for understanding the sequence; you may describe order
in words, but every number in your prose MUST still come from a {{pN.field}}
placeholder; numbers appearing only in this flow are NOT citable):
  <castFlow each line indented 2 spaces>
```

At the same time, HARD RULES list adds a line when castFlow exists: `- The cast flow section is context only: no number from it may appear in prose unless the same number exists as a {{pN.field}} fact.`

- [ ] **Step 1: Failing tests**:

```ts
it("snapshot off (default): buildWindowPack output for same input is deep-equal to pre-change output (byte-for-byte unchanged regression)", () => {
  // Construct minimal combat + candidates; JSON.stringify(buildWindowPack(c,f,t,cands,owner))
  // deep-equal with both snapshot:false / omitted opts calls
});
it("snapshot on: items contain snapshot kinds, total <= MOMENT_PACK_MAX, facts merged into pack.facts, castFlow non-empty", () => {});
it("survival gate not fooled by pure snapshot items: only snapshots, no event signals -> buildWindowPack returns null", () => {});
it("prompt: castFlow section and context-only HARD RULE only appear in snapshot pack", () => {});
```

- [ ] **Step 2: Run red** → **Step 3: Implement** → **Step 4: Run green** + `npm test --workspace=packages/analysis` + typecheck
- [ ] **Step 5: Commit**: `feat(analysis): connect snapshot toggle to deepDive pack/prompt -- default path byte-for-byte unchanged, castFlow context-only`

---

### Task 3: Predicate Index Registration + eval Category 6 hardFailure

**Files:**

- Modify: `docs/predicate-index.md` (+ sync `docs/predicate-index.zh-CN.md`, bilingual pair rule!)
- Modify: `packages/eval/src/quality/promptQualityCheck.ts`
- Test: `packages/eval/test/predicateIndex.test.ts` (existing consistency test follows) + append test cases to promptQualityCheck existing test file

**Interfaces:**

- Produces: `export function checkSnapshotFactsConsistency(promptText: string): string[]` (array of violation descriptions, empty = pass), and added to `hardFailures` assembly (around promptQualityCheck.ts:460-469).

**Implementation Points:**

- Register new predicates: `aurasActiveAt`, `largestCastGap`, `ACTIVITY_GAP_MIN_S`, `MOMENT_PACK_MAX`, `SNAPSHOT_KINDS` (entry style copies existing "Cooldown availability" section).
- Register existing duplication under "Not Yet Unified" section: same-named `buildAuraIntervals` in `utils/utils.ts` and `utils/auraIntervals.ts` (two consumers determining the fact of "aura intervals"; not merged in this plan, only registered).
- `checkSnapshotFactsConsistency`: parses `kind=hp-snap facts={...}` and `kind=hp facts={...}` lines in deep dive prompt text; HP difference > 3pp for same unit at same rendered second is a violation (reuse existing `HP_AGREEMENT_TOLERANCE_PP` constant, do not introduce new 3); contradiction between `kind=cd-ledger` ready list and same prompt's `kind=immunity-available`/`external-available` spell (available item's spell not in that unit's ready string) is a violation. Returns [] when no snapshot lines (legacy prompts pass naturally).
- Bilingual: add to both language versions of predicate-index; if zh-CN version does not exist, verify and skip (follow `ls docs/predicate-index*`).

- [ ] **Step 1: Failing test** (handcrafted prompt text: matching passes, 5pp HP difference violates)
- [ ] **Step 2: Run red**: `npm test --workspace=packages/eval`
- [ ] **Step 3: Implement** → **Step 4: Run green** (eval full package + predicateIndex consistency test) + typecheck
- [ ] **Step 5: Commit**: `feat(eval): deep dive snapshot facts consistency category 6 hardFailure + predicate index registration`

---

### Task 4: Renderer Request Construction Wiring

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/analysisInput.ts`:
  - `buildWindowAnalysisRequest(source, fromS, toS, opts?: { snapshot?: boolean })` (line 154; passed to `buildWindowPack` 6th arg) return object adds `snapshot: boolean`
  - `buildDeepenPacks(source, findings, candidates, ownerName?, opts?: { snapshot?: boolean })` (line 104; passed to `buildDeepDivePack`/`buildOffensiveDeepDivePack` — if latter lacks opts arg, add it as well, aligning signature with buildDeepDivePack)
- Modify: `packages/analysis/src/analysis/deepDive.ts` if `buildOffensiveDeepDivePack` was not covered with opts in Task 2, complete here (offensive path snapshot also appends snapshot items)
- Test: Append to analysisInput existing test file (if none, create in `packages/desktop/src/renderer/src/report/derive/analysisInput.test.ts`, fixture uses `test/fixtures/real-match-sample.json` + cloned injected deaths per established convention, template in `report.deathrecap.test`)

**Interfaces:**

- Produces: Consumed by Task 5/6: `buildWindowAnalysisRequest(..., { snapshot: true })` → `{ pack, kind, spec, ownerName, fromS, toS, snapshot }`.

- [ ] **Step 1: Failing test**: `snapshot:true returns object with snapshot=true and pack.items containing snapshot kinds; omitted is deep-equal to status quo`
- [ ] **Step 2: Run red** (`npm test --workspace=packages/desktop -- analysisInput`) → **Step 3: Implement** → **Step 4: Run green** + typecheck
- [ ] **Step 5: Commit**: `feat(desktop): connect snapshot toggle to window/deep-dive request construction`

---

### Task 5: Main Process (Cache Key / Settings / PROMPT_VERSION / Preload)

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` analyzeWindow (lines ~842-990): input adds `snapshot?: boolean`; `windowKey` appends `:snap` segment when snapshot; `max_tokens: input.snapshot ? 3072 : 2048`
- Modify: `packages/desktop/src/shared/promptVersion.ts`: `PROMPT_VERSION` 15 → 16 (pack shape change, all old window caches invalidated — intended semantics)
- Modify: `packages/desktop/src/main/settingsStore.ts`: `GladlogSettings` adds `deepDiveSnapshot: boolean`, default `false` (default object around line ~62); sanitize drops non-boolean (copy aiLanguage validation style, line ~139)
- Modify: `packages/desktop/src/preload/api.ts`: analyzeWindow input type adds `snapshot?: boolean`; sync settings type if explicitly listed
- Test: `packages/desktop/src/main/analysis.test.ts` + `settingsStore` existing test files

**Interfaces:**

- Produces: `bridge().analysis.analyzeWindow({ ..., snapshot: true })`; `settings.deepDiveSnapshot` (consumed by Task 6).

- [ ] **Step 1: Failing tests**:

```ts
it("windowKey: same window with snapshot on/off are two separate cache entries, no mutual pollution", async () => {
  // Same fromS/toS: run snapshot:false to populate cache, then snapshot:true -> cache miss, second model call
});
it("settings: deepDiveSnapshot defaults to false; non-boolean patches dropped", () => {});
```

- [ ] **Step 2: Run red** → **Step 3: Implement** → **Step 4: Run green** (desktop full package) + typecheck
- [ ] **Step 5: Commit**: `feat(desktop): analyzeWindow snapshot cache key/quota + deepDiveSnapshot setting + PROMPT_VERSION 16`

---

### Task 6: UI Entry Point (Replay "Deep Dive This Moment" + Manual Always Snapshot + Auto Round Toggle + Settings Page)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`:
  - `runWindowAi` (line 448) passes `{ snapshot: true }` when building request (manual entry point always dense), IPC payload carries `snapshot: req.snapshot`
  - New callback prop passed to ReplayView: `onMomentDive={(tSeconds) => { const range = { from: Math.max(0, Math.floor(tSeconds) - 10), to: Math.floor(tSeconds) + 10 }; setTimeRange(range); setView("report"); void runWindowAi(range); }}` (reusing single-click convention from lines 517-527, including ref timing comments about set-before-run)
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx`: control bar adds button "Deep Dive This Moment" (`data-testid="moment-dive"`), onClick takes relative seconds converted from **current playback clock** to call `props.onMomentDive?.(tSeconds)`; playback clock is local state in ReplayView (never lift!), conversion follows existing absolute ms ↔ relative seconds conversions in that file
- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`: deepen trigger effect (lines ~513-556) reads settings (component already has aiSettings) — `buildDeepenPacks(source, findings, candidates, ownerName, { snapshot: aiSettings?.deepDiveSnapshot === true })`
- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`: AI section adds toggle "Use dense snapshot for deep dives (approx. 2-4x tokens)" bound to `deepDiveSnapshot` (copy row style from autoAnalyzeNew toggle)
- Test: ReplayView/MatchReport component tests: `moment-dive button exists and triggers onMomentDive when clicked`; StructuredAnalysisPanel deepen argument assertions (mock buildDeepenPacks or observe via bridge stub)

**Interfaces:**

- Consumes: Task 4's `buildWindowAnalysisRequest(..., {snapshot})`, Task 5's `settings.deepDiveSnapshot` and `analyzeWindow({snapshot})`.

- [ ] **Step 1: Failing tests** (component tests, bridge stubs follow `__gladlogFixture` convention, access must use try/catch+optional)
- [ ] **Step 2: Run red** → **Step 3: Implement** → **Step 4: Run green** + typecheck + `npx eslint . --quiet`
- [ ] **Step 5: Local full gate**: `npm run presubmit` green
- [ ] **Step 6: Commit**: `feat(desktop): replay "Deep Dive This Moment" entry point + manual window always snapshot + auto round deepDiveSnapshot toggle`
- [ ] **Step 7: Visual baseline**: after push, run `gh workflow run visual-baseline.yml --ref main` per desktop-dev recipe -> download -> human review each image (expected only replay control bar baseline changes) -> overwrite commit

---

### Task 7: Acceptance Evaluation (spec §6, Before/After Metrics)

**Files:**

- Create: `packages/eval/scripts/momentDiveAb.ts` (resident script, baseline numbers documented in comments — no throwaway scripts is repo discipline)

**Implementation Points:** Fetch latest N (default 10) matches with death anchors from local match library (`~/Library/Application Support/gladlog/matches`); for each anchor ±10s: A = `buildWindowPack` non-snapshot, B = snapshot; each runs `buildDeepDivePrompt` + claude -p sonnet (same params as 2026-08-05 experiment), outputs pass through `auditDeepDives`; prints table: Anchor | A count/audit pass | B count/audit pass | B snapshot item count; last line summarizes averages. Silence rate spot check: print raw text of items discarded by audit in Group B for manual attribution.

- [ ] **Step 1: Write script** (loading/construction follows `packages/desktop/scripts/verify-production.ts` toLegacySafe convention; note cross-package dependencies: when script is in eval package, `@gladlog/analysis` resolves, but desktop's toLegacySafe cannot be imported — **use `@gladlog/analysis` side equivalent loader**: load matches the same way existing eval scripts do, check `ls packages/eval/scripts/` for patterns)
- [ ] **Step 2: Run**: `npx tsx packages/eval/scripts/momentDiveAb.ts 10` (20 sonnet calls, approx. 5-10 minutes)
- [ ] **Step 3: Numbers into commit + spec**: append summary numbers (A/B average counts, audit pass rate, silence rate) to acceptance section of spec; if expectations not met (B mean ≤ A), halt and report, do not force
- [ ] **Step 4: Commit**: `test(eval): momentDiveAb acceptance script + initial numbers -- A x.x items/match vs B y.y items/match`
- [ ] **Step 5: Full repo wrap-up**: push after `npm run presubmit` passes green; watch CI green by headSha.

---

## Self-Review Records

- Spec coverage: §1 7 item kinds -> Task 1; stream paragraph + HARD RULE -> Task 2; §1b activity-gap -> Task 1; §2 cap -> Task 1/2; §3 main/settings/version -> Task 5; §4 UI -> Task 6; §5 predicate index/category 6 -> Task 3; §6 acceptance -> Task 7; P1 = Task 1-5, P2 = Task 6(+7).
- Type consistency: `opts?: { snapshot?: boolean }` spans buildDeepDivePack/buildWindowPack/buildOffensiveDeepDivePack/buildDeepenPacks/buildWindowAnalysisRequest; `castFlow?: string[]` in DeepDivePack; `deepDiveSnapshot` in settings.
- Known intentional omission: minimal unit sample construction in momentSnapshot.test copied by implementer from existing tests (established repo convention, copying is less prone to drift than duplicating in plan).
