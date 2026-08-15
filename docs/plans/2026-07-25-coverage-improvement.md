# Test Coverage Improvement Plan (Driven by 2026-07-25 Audit)

> **For agentic workers:** Execute task-by-task following the workflow: "agy exec implementation → Claude review (diff + gates + before/after coverage numbers) → commit". Steps tracked via checkboxes.

**Goal:** Fill unit test gaps discovered during the 2026-07-25 coverage audit in production path blindspots (four files in `analysis/src/context`, eval auditors), and establish reproducible coverage measurement infrastructure.

**Architecture:** Follow existing testing patterns throughout — clone real fixtures (`loadLegacyMatchFixture`) + inject synthetic events (precedent in deathrecap), feed synthetic inputs directly to pure functions; no modifications to production logic (sole exception: exporting pure functions in calibrateAuditor). Each task accepted with before/after coverage numbers using the same criteria (repo rule: fixes must provide before/after numbers).

**Tech Stack:** vitest ^2 + @vitest/coverage-v8@^2 (v8 provider).

## Global Constraints

- Unified coverage criteria: `(cd packages/<pkg> && npx vitest run --coverage --coverage.reporter=json-summary)` reading `coverage/coverage-summary.json`'s lines.pct — before and after must use the identical criteria.
- CI tsc includes test files; lint is repo-wide `eslint .` (error-level no-unused-vars blocks merge). Task wrap-up command: `npm run typecheck && npx eslint . --quiet && npm test --workspace=packages/<pkg>`.
- parser's `parseBudget.test.ts` will inevitably fail under coverage instrumentation (performance budget); coverage configuration must exclude it or omit coverage CI gates on parser.
- Never `cd` in compound commands (use `(cd … && …)` subshells); never add piping to clip gate output.
- Commit method: direct commit to main (established repo workflow), one commit per task.
- agy exec can write files but may hallucinate success — always read back files + run tests locally to verify after each implementation, do not trust agy's self-reporting.
- Do not add tests for `@deprecated` code (buildMatchFlow); do not test CLI `main()` (eval scripts, abCompareStats.main, log-pipeline entry points) — YAGNI.

## Before/After Numbers Baseline (2026-07-25 measured, v8 lines)

| Target File | Pre-fix | Target | Measured (2026-07-25 completion) |
| --- | --- | --- | --- |
| analysis/src/context/criticalMoments.ts | 7.61% (51/670) | ≥60% | **83.13%** ✓ (477f473) |
| analysis/src/context/matchTimelineSections.ts | 53.46% (270/505) | ≥80% | **97.62%** ✓ (64011c6) |
| analysis/src/context/resourceSnapshot.ts | 58.11% (340/585) | ≥80% | **91.96%** ✓ (460c3ee) |
| analysis/src/context/matchNarrative.ts | 20.65% (38/184) | full buildMatchArc coverage (file ≥55%) | 47.28%, Arc body 100%; uncovered lines 18–132 are entirely @deprecated buildMatchFlow, deleting it achieves target (f5d3055) |
| eval/src/provenance/judgeSpotAudit.ts | 0% (0/112) | ≥80% | **100%** ✓ (3df3e1e) |
| eval/src/provenance/calibrateAuditor.ts | 0% (0/180) | Pure function part ≥40% | 21.11%; corrupt() pure function 100%, remainder is deliberately untested agy subprocess orchestration (3df3e1e) |

Package-level changes: analysis 84.83% → 89.5%+, eval 28.25% → 73.57%, desktop nominal 9.11% → true 84.05% (Task 0 removes dilution).

---

### Task 0: Coverage Measurement Infrastructure

**Files:**

- Modify: `package.json` (root, add devDep and `coverage` script)
- Modify: `packages/{analysis,parser,desktop,eval,parser-compat}/vitest.config.ts` (add coverage exclude)

**Interfaces:**

- Produces: Each package running `npx vitest run --coverage` yields clean numbers (desktop no longer diluted by out/; eval/analysis no longer diluted by scripts/). Subsequent tasks all use this for before/after comparisons.

- [x] Root `package.json` devDependencies adds `"@vitest/coverage-v8": "^2.1.9"`, scripts adds `"coverage": "npm run coverage --workspaces --if-present"`; each package (except optional corpus-tools/log-pipeline) adds `"coverage": "vitest run --coverage"`.
- [x] Each package vitest.config.ts `test` block adds:

```ts
coverage: {
  provider: "v8",
  reporter: ["text-summary", "json-summary"],
  include: ["src/**"],
  exclude: ["src/**/*.d.ts"],
},
```

desktop additionally confirms include is only `src/**` (excluding out/, dev/, qa/, scripts/); parser vitest.config explicitly notes in config comments that parseBudget is incompatible with coverage instrumentation.

- [x] Verification: `(cd packages/desktop && npx vitest run --coverage 2>&1 | tail -8)` total line coverage jumps from 9% to ~80% (dilution eliminated), `git status` shows no unexpected files.
- [x] Commit: `chore(test): coverage measurement infrastructure -- v8 provider + include src/** per package, exclude build artifacts/scripts from denominator`

### Task 1: criticalMoments Test Coverage (Largest Blindspot)

**Files:**

- Create: `packages/analysis/test/context.criticalMoments.test.ts`

**Interfaces:**

- Consumes: `identifyCriticalMoments(isHealer, cooldowns, enemyCDTimeline, friendlyDeaths, healingGaps, panicDefensives, overlappedDefensives, ccTrinketSummaries, peakDamagePressure5s, durationSeconds, friends, matchStartMs, owner?)`, `buildDeathRootCauseTrace`, `getEnemyStateAtTime`, `getOwnerCDsAvailable`, `findContributingDeath`, `buildKillMomentFields`, `DEATH_CC_LOOKBACK_S` (all exported from `src/context/criticalMoments.ts`); `loadLegacyMatchFixture()` (`test/helpers/legacyFixture`).
- Produces: Line coverage for this file ≥60%.

- [x] Test skeleton (agy expands this; synthetic inputs minimally constructed per interface):

```ts
import { loadLegacyMatchFixture } from "./helpers/legacyFixture";
import {
  identifyCriticalMoments,
  buildDeathRootCauseTrace,
  getEnemyStateAtTime,
  getOwnerCDsAvailable,
} from "../src/context/criticalMoments";

const match = loadLegacyMatchFixture();
const friends = Object.values(match.units).filter(
  (u) => u.reaction === 1 && u.info,
);

// Fixture has no player deaths -> synthetic friendlyDeaths array drives death moments
describe("identifyCriticalMoments", () => {
  it("no deaths and no gaps -> empty moments, constrainedTrade=false", () => {
    /* All-empty input */
  });
  it("injected 1 friendlyDeath -> produces death moment, time aligned on rendering grid", () => {
    /* … */
  });
  it("death + matching healingGap/panicDefensive -> character attribution correct", () => {
    /* … */
  });
  it("ConstrainedTrade gate: burst>=5 + CD trade + short match + followed by death -> true", () => {
    /* … */
  });
});
describe("buildDeathRootCauseTrace / getEnemyStateAtTime / getOwnerCDsAvailable", () => {
  it("death lookback window = DEATH_CC_LOOKBACK_S, out-of-bound events excluded from trace", () => {
    /* … */
  });
  it("getEnemyStateAtTime returns empty state instead of throwing when no data at timestamp", () => {
    /* … */
  });
});
```

- [x] agy exec implementation (run from repo root; prompt supplies skeleton above + file paths + "read criticalMoments.ts and testHelpers.ts before writing; run `npm test --workspace=packages/analysis` until green").
- [x] Claude review: read back entire file; verify assertions are not trivial pass-throughs (must anchor on concrete values/structures); run full analysis tests + coverage, record before/after numbers for criticalMoments.ts (7.61% → ___).
- [x] `npm run typecheck && npx eslint . --quiet`.
- [x] Commit: `test(analysis): criticalMoments injection test coverage -- 7.61% -> <measured>%`

### Task 2: matchTimelineSections Five Emitters Test Coverage

**Files:**

- Create: `packages/analysis/test/context.timelineSections.test.ts`

**Interfaces:**

- Consumes: `emitRotPressureEntries` / `emitDmgSpikeEntries` / `emitManaMarkerEntries` / `emitFriendlyDeathEntries<S>` / `emitEnemyDeathEntries<S>` (all params-object pure emitters exported from `src/context/matchTimelineSections.ts`).
- Produces: Line coverage for this file ≥80%.

- [x] At least three cases per emitter: empty input → empty output; single event → assert entry fields one by one (timestamps using fmtTime rendering grid values); threshold boundaries (rot pressure exactly at threshold / crossing threshold). The two death emitters with generic `<S>` use minimal S stub.
- [x] agy exec implementation → Claude review (same criteria as Task 1) → gates → record before/after numbers (53.46% → ___).
- [x] Commit: `test(analysis): timelineSections emitters test coverage -- 53.46% -> <measured>%`

### Task 3: resourceSnapshot Test Coverage

**Files:**

- Create: `packages/analysis/test/context.resourceSnapshot.test.ts`

**Interfaces:**

- Consumes: `countActiveAtonements`, `buildPlayerLoadout`, `chargesReadyCount`, `computeReadyNames`, `computeOnCDDisplayNames`, `buildResourceSnapshot(ResourceSnapshotParams)`, `buildJsonSituationSnapshot` (exported from `src/context/resourceSnapshot.ts`).
- Produces: Line coverage for this file ≥80%.

- [x] Pure counting functions (atonement/charges/ready) directly test boundaries with synthetic aura/cast inputs (0 items, expired, concurrent); `buildResourceSnapshot` and `buildJsonSituationSnapshot` driven with units from real fixtures + assert snapshots contain HP/resource fields consistent with same-second rendering grid (rule predicate as specification: sampling timestamp must floor to rendering second).
- [x] agy exec implementation → Claude review → gates → before/after numbers (58.11% → ___).
- [x] Commit: `test(analysis): resourceSnapshot test coverage -- 58.11% -> <measured>%`

### Task 4: matchNarrative.buildMatchArc Test Coverage (Do Not Touch Deprecated buildMatchFlow)

**Files:**

- Create: `packages/analysis/test/context.matchNarrative.test.ts`

**Interfaces:**

- Consumes: `buildMatchArc` (exported from `src/context/matchNarrative.ts`; `buildMatchFlow` is @deprecated, untested, recommended for separate deletion later).
- Produces: All-branch coverage for buildMatchArc; file coverage ≥55%.

- [x] Test cases: no burst no death → output still has MATCH skeleton; single burst + CD trade → causal order (Opening→Post-Trade) asserted; burst followed by death → death section attributed to corresponding burst section; timestamps all on fmtTime grid.
- [x] agy exec implementation → Claude review → gates → before/after numbers (20.65% → ___).
- [x] Commit: `test(analysis): buildMatchArc test coverage -- 20.65% -> <measured>% (buildMatchFlow omitted, pending deletion)`

### Task 5: eval Auditors Test Coverage (judgeSpotAudit + calibrateAuditor Pure Parts)

**Files:**

- Create: `packages/eval/test/provenance.test.ts` already exists → Create `packages/eval/test/auditors.test.ts`
- Modify: `packages/eval/src/provenance/calibrateAuditor.ts` (only export internal claim corruption pure functions like `corruptClaim`; do not touch agy subprocess orchestration)

**Interfaces:**

- Consumes: `extractSpotAuditCases(...)` (judgeSpotAudit.ts); timeShift/numberDistort/semantic-inversion corruption functions inside calibrateAuditor.ts (exported in this task).
- Produces: judgeSpotAudit ≥80%; calibrateAuditor ≥40% (subprocess orchestration explicitly untested, documented in comments).

- [x] Corruption function testing serves as the unit version of planted defect calibration: `"HP dropped at 1:22"` → timeShift produces `2:22` with note explanation; text-only claims without numbers → semantic inversion fallback without throwing (final audit F3 behavior); numberDistort only alters numeric tokens. `extractSpotAuditCases` driven by synthetic judge archive directory (minimal file tree created in tmp dir).
- [x] agy exec implementation → Claude review (focus: export refactor causes no behavioral change — `git diff` in production files only permits `function` → `export function`) → gates → before/after numbers (0%/0% → ___/___).
- [x] Commit: `test(eval): auditor pure functions test coverage -- judgeSpotAudit 0-><measured>%, calibrateAuditor 0-><measured>%`

---

## Explicitly Out of Scope (YAGNI, Ruled by Audit)

- eval `scripts/` (37 CLIs, executed per workflow run), `abCompareStats.main()`, log-pipeline CLI entry points, corpus-tools scripts, desktop `preload` (thin wrapper, covered by E2E).
- desktop main process (index/ipc/workerHost/exportImage): Covered by E2E + electron-vite build layer, electron mocking has high cost and low yield, left in backlog.
- timelineHelpers.ts (61.6%) / matchTimeline.ts (64.7%): Low marginal returns; if boosted incidentally by Tasks 1–4, take the win, but do not list separately.
- Coverage threshold CI gate: Accumulate stable numbers over two weeks before setting thresholds; not added in this plan.

## Self-Review Notes

- Six tasks map one-to-one with audit recommendations (infra/criticalMoments/sections/snapshot/narrative/eval auditors); no TBDs; interface signatures verified against source code (criticalMoments.ts:445, resourceSnapshot.ts:304, matchNarrative.ts:17/150, calibrateAuditor.ts:74).
- Known risk: identifyCriticalMoments input consists of upstream analysis artifacts (IMajorCooldownInfo etc.) with high synthetic construction cost — when implementing via agy, prioritize reusing existing constructors in `test/ported/testHelpers.ts`.
