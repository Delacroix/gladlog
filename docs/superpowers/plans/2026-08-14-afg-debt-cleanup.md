# Ability Fact Foundation Pending Debt Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the six pending debts logged in the ability fact foundation project and deep-dive experiments (cd ledger rot / aura truncation / dr reverse / cost norm wiring / feared observation line / tsconfig debt), executing each according to the fixing direction determined in its review record, with before-and-after numbers.

**Architecture:** Everything is a reuse of existing patterns: Task 7's root cause diagnostic method, DR shim's single-source predicate method, uwcObserved's observation line method, and guardian notes. No new architecture. Out of scope: BACKLOG #26 (raw dual-stream into parser, separate project).

**Tech Stack:** Existing (tsx/vitest/datagen infrastructure/eval scanning tools).

## Global Constraints

- Predicate single-source iron rule; provide before-and-after numbers for fixes; non-official facts require user sign-off (candidate set generated from feared observations must be submitted for signature, PAUSE); bilingual pairs (predicate-index changes en/zh equivalent); product consumer behavior tests must remain green, report official data-driven assertion changes truthfully without silent edits; commit directly to main one per task, **verify output after push**; full gate `npm test --workspaces && npm run typecheck && npx eslint . --quiet`; long scans run in foreground batches with intermediate flushes to disk (timeout 550000/batch).

---

### Task A: CD Ledger Remaining 16 Abilities Root Cause Reconciliation

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts` (expand `AURA_ONLY_ACTIVATION_IDS` table for confirmed aura-only cases)
- Modify/Extend: `packages/analysis/test/cooldowns.auraOnlyActivation.test.ts`
- Create: Record per-ability diagnoses into `$GLADLOG_EVAL_HOME/reports/cd-ledger-rot-batch2.md`

**Interfaces:** Consumes existing `cdLedgerRot` scanning tool and the remaining list from `reports/cd-ledger-rot.md` (16 abilities, 121 entries: Stampeding Roar 75 / Cloak of Shadows 9 / Incarnation / Avenging Wrath / Trueshot / Ascendance / Shadow Blades / Power Infusion / Ironbark / Evasion / Aura Mastery / Survival Instincts / Icebound Fortitude / Ice Barrier / Arcane Surge / Adrenaline Rush).

- [ ] **Step 1:** For each ability, take 2-3 conflicting samples (scan report has match/timestamp), check against raw.txt: was there a SPELL_CAST_SUCCESS (cast id or talent clone id) at that timestamp? What is the relationship between aura id and cast id? Categorize: (a) aura-only / broken clone id chain -> add to `AURA_ONLY_ACTIVATION_IDS` or cast-id mapping; (b) pre-match aura setup (no cast within window) -> not a defect, record; (c) third-party aura (external grant, e.g. Power Infusion cast by another) -> attribution must assign to caster by srcGUID, check if current logic is correct, fix if wrong; (d) other, document item-by-item. **No guessing classifications; provide sample evidence lines for each ability.**
- [ ] **Step 2:** For confirmed category (a), update table item-by-item (noting source and samples), adding synthetic fixture tests for each; for category (c), if logic needs fixing, use TDD.
- [ ] **Step 3:** Re-run full corpus scan (foreground batches), include `121 -> N_after` in commit message; flush batch2 report to disk (per-ability disposition table).
- [ ] **Step 4:** analysis suite + typecheck green; commit `fix(analysis): cd ledger batch 2 reconciliation -- 121->N (per-ability root causes)` + trailers; push and verify.

### Task B: #27 aurasActiveAt Truncation Fix

**Files:**

- Modify: `packages/analysis/src/analysis/momentSnapshot.ts:72-77` (`aurasActiveAt`)
- Test: Extend momentSnapshot existing test files (or create `packages/analysis/test/momentSnapshot.aurasPriority.test.ts`)

**Interfaces:** Fix direction follows BACKLOG #27: sort by category priority before truncation —— hard CC (`DR_CATEGORIES_GENERATED` all category matching aura ids) > immunity / major CD auras (`MAJOR_DEFENSIVE_IDS` / `IMMUNITY` existing tables) > rest; cap remains 10 but sorting guarantees critical auras are always included; category judgments all reuse existing tables without creating new whitelists.

- [ ] **Step 1:** Failing test: synthesize 12 auras (1 stun + 1 immunity + 10 misc), assert stun and immunity are guaranteed in returned list (old implementation `slice(0, 10)` in traversal order pushed them out).
- [ ] **Step 2:** RED -> implement sorting -> GREEN; behavior tests for both consumers (auras query / deep-dive snapshot pack) pass; replay `auras --t 168` on 76ea5f90 shows Freezing Trap visible (was invisible before fix) —— before-and-after comparison in commit message.
- [ ] **Step 3:** BACKLOG #27 annotated with "Fixed (commit)"; if predicate is registered in predicate index, update bilingual notes. Commit `fix(analysis): aurasActiveAt priority sorting truncation -- hard CC / immunities always included (#27)` + trailers; push and verify.

### Task C: #24 DR Reverse Direction Fix

**Files:**

- Modify: `packages/analysis/src/utils/drAnalysis.ts:441` region (`analyzeOutgoingCCChains` target filtering)
- Test: `packages/analysis/test/` (extend existing drAnalysis tests)

**Interfaces:** Fix direction follows BACKLOG #24: target filtering changed from hardcoded `reaction === Hostile` to "player units belonging to the passed second parameter (enemies) set" —— product existing calls `(friends, enemies)` behavior unchanged (parity test pinned: existing DR tests all green + one new forward semantic invariant test); reverse calls `(enemies, friends)` restored to valid.

- [ ] **Step 1:** Failing test: reverse call synthetic fixture (enemy stuns friendly once), assert returns non-empty with correct fields (old implementation returned empty). Forward semantic parity test: same fixture forward call result matches pre-change snapshot.
- [ ] **Step 2:** RED -> fix -> GREEN; all drAnalysis / DR related tests green (registered symbols in predicate index, run predicateIndex test).
- [ ] **Step 3:** Real data verification: `matchExplore 76ea5f90 dr --from 0 --to 188` shows enemy -> friendly rows (0 rows before fix) —— before/after numbers in commit message; BACKLOG #24 marked fixed. Commit `fix(analysis): CC chain target filtering uses passed set -- dr reverse restored (#24)` + trailers; push and verify.

### Task D: #25 cost_norm Guardian Note Wiring

**Files:**

- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.ts` (usable_in_cc fact explanation text, inspect around line :34 first)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts` (`deathUnusedDefensiveEvents` / related facts production)
- Test: Extend corresponding test files

**Interfaces:** Fix direction follows precedent "candidate gates can be bypassed by rich context -> companion predicate guardian notes": whenever an ability appearing in facts matches a signed ledger `kind === "cost_norm"` entry (consuming `CURATED_ABILITY_FACTS`, single-source import, currently zero consumers), candidate facts attach `costNorm` fact (e.g. `costNorm: "Major cooldown, not recommended for routine counter-CC"` derived from ledger entry claim or defined short code), prompt explains field semantics (model refrains from suggesting "should use Divine Shield to stop Hammer of Justice"). Deep dive manual decision point card section adds a note: "'should use X' suggestions for cost_norm ledger abilities must include cost notes".

- [ ] **Step 1:** Failing test: synthetic candidate containing 642, assert facts include costNorm field; abilities not in ledger do not have this field.
- [ ] **Step 2:** RED -> implement (candidate layer + prompt explanation line) -> GREEN; existing candidate/prompt tests green.
- [ ] **Step 3:** BACKLOG #25 marked "Consumer wired (commit)"; add note to manual; commit `feat(analysis): cost_norm guardian note wiring -- first consumer for signed ledger (#25)` + trailers; push and verify.

### Task E: feared/disorient Corpus Observation Line (-> PAUSE Submit for Sign-off)

**Files:**

- Modify: `packages/eval/src/explore/uwcObserved.ts` (generalize: CC category parameterized)
- Modify: `packages/eval/scripts/uwcCorpusScan.ts` (`--category stun|fear|disorient|incapacitate` flags)
- Test: Extend `packages/eval/test/explore.uwcObserved.test.ts`

**Interfaces:** Existing `observedCastsWhileStunned(rawText, stunAuraIds)` already works by injected aura set —— generalize to accept any category from `DR_CATEGORIES_GENERATED` (fear corresponds to `disorient`? Note: **verify DR category name to game semantic mapping first** —— fear belongs to disorient category in DR table, incapacitate is a separate category; state category caliber clearly in report). Run across full corpus for fear category (N=1028, batched), produce "successful casts during active fear-type hard CC" observation set + comparison report against signed anchor feared dimension. **Submit candidate list for user sign-off (PAUSE)**: high-frequency, clean samples (mid-window, player-cast, non-proc evaluated item-by-item) of feared-usable candidates, added to signed ledger after sign-off (feared variant of `usable_while_cc_gap` kind —— if ledger schema needs expansion, add `usable_while_feared_gap`). **This task does not modify shim/consumers** (feared facts currently have no consumers; observation + sign-off first).

- [ ] **Step 1:** Failing test: generalized signature `observedCastsInCc(rawText, auraIds)` (renamed or parameterized, preserving old name as thin alias to prevent breaking eval consumers), fixtures reuse existing patterns.
- [ ] **Step 2:** RED -> generalize -> GREEN; run fear category across full corpus in batches; report written to `$GLADLOG_EVAL_HOME/reports/uwc-feared-diff.md` (observation set / anchor comparison / Barkskin-Dispersion dispute cell corpus evidence —— user opinions vs tooltips now have ruling data).
- [ ] **Step 3:** commit `feat(eval): generalize corpus observation line -- feared/disorient observations + report` + trailers; push and verify; **PAUSE: Submission materials** (candidate list + Barkskin/Dispersion ruling recommendations).

### Task F: tsconfig scripts/ Debt + Inventory Bilingual Decision Execution

**Files:**

- Modify: `packages/analysis/tsconfig.json` + `packages/eval/tsconfig.json` (add `scripts` to include)
- Modify: Fix exposed type errors file by file (existing files in datagen/eval scripts)
- Modify: `docs/ability-fact-inventory.md` (bilingual decision notes, executed per user reply at Task E PAUSE; if no reply, add header note "Monolingual Chinese, not enrolled in bilingual pairs for now (2026-08-14)")

**Interfaces:** Risks: dozens of files under scripts/ across both packages never passed typecheck, might expose a batch of errors —— **fix them one by one, do not gloss over with @ts-ignore**; if a file is an experimental relic with no consumers (after verification), it can be moved to eval-private archive instead of fixed. CI impact: root typecheck traverses each package tsconfig, expanding include takes effect in CI simultaneously —— all green locally is sufficient.

- [ ] **Step 1:** Add `scripts` to include in both packages, run `npm run typecheck`, collect all error lists into report.
- [ ] **Step 2:** Fix file by file (or archive, noting each); typecheck fully green.
- [ ] **Step 3:** Full gate all green; commit `chore: tsconfig covers scripts/ -- datagen/eval scripts enter typecheck` + trailers; push and verify.

---

## Definition of Done

All six pending debts have before/after numbers / disposition records; BACKLOG #24/#25/#27 marked fixed; feared candidates and Barkskin dispute cell signed off by user (or explicitly deferred); #26 initiated as the next independent project awaiting user launch.
