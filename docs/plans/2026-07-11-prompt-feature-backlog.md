# Prompt Feature Migration Backlog (4b A/B Loop Driven)

> This is a **backlog, not an SDD plan**: each feature runs through an independent `/eval-ab` cycle (control=main, treatment=+feature), consumed in the order listed here. Principles follow the 4b spec: deterministic metrics decide sufficiency/noise/labelBias, blind eval statistics decide the other four dimensions; ADOPTing an INCONCLUSIVE result based on deterministic rationale must be recorded in the ledger.

## Prerequisites (One-time, awaiting user)

1. Private repo `~/code/gladlog-eval-private/corpus/manifest.txt` stores the self-collected log list.
2. `/eval-baseline` builds the first run → `/calibrate-judge` passes the 80% detection gate → baseline ledger row.
3. (Optional, recommended) Prompt difference census: sample 50–200 matches using the old fork `scratch/parser-diff` harness to run dual-pipeline prompt diffs, bucketing differences (missing feature / data values / NEW_CORRECT / under investigation); the frequency × token proportion of the feature bucket serves to calibrate the priorities below.

## Migration Order and Rationale

### 1. KICK / Timeline Event Annotations ✅ (Closed 2026-07-11 along with timeline variant ADOPT)

> **Conclusion**: Timeline variant merged as production line default after three rounds of A/B (gladlog ed29c81). Interrupt coverage 1.3% → 100% (deterministic), blind eval 4 dimensions CI-improved, accuracy regression eliminated after two rounds of spec tag + density compression fixes. Collateral dividend: CRLF `\r` bug fixed (feign death misrecorded as real death, correcting win/loss inversions in 17/176 matches). Ledger: three rows in eval-private ledger A/B cycles.

- **Content**: `[KICK]` timeline lines for SPELL_INTERRUPT and related family annotations.
- **Old repo evidence**: F20 pilot (2026-07-04) —— deterministic interrupt coverage 12% → 100% (+88pp, 10/10 pairs), blind eval all seven dimensions inconclusive with zero regression, +1.4% tokens, ADOPT. Also served as empirical proof that "blind evaluation holds no verdict authority over sufficiency".
- **Dependencies**: No new dependencies (interrupts data, timeline pipeline already exist). **Perform gap inventory first**: 4a ported version of matchTimeline may already carry partial annotations, treatment only fills the gaps.
- **A/B target dimensions**: sufficiency (decided by quality-report interrupt coverage; blind eval rows displayed for reference only).

### 2. HEALER EXPOSURE (Port iter D inline final state directly) ✅ (Closed 2026-07-11 via inventory: 4a already ported inline final state)

> **Inventory Conclusion**: ENEMY CC KIT header once per match + `[HEALER EXPOSURE]` timestamp line inlined into timeline —— iter D final state was already brought in during 4a porting, not the initial append version. Old repo's regression dimension inferenceScaffolding was consecutively CI-improved (+0.79/+0.93/+0.86) across three rounds of timeline variant blind evals, equivalently passing A/B validation for this item. No separate cycle needed.

- **Content**: tag-prefixed exposure lines **inlined and merged into timeline** (mergeTimestampedLines) + once-per-match ENEMY CC KIT header.
- **Old repo evidence**: Append initial version caused **confirmed regression** in inferenceScaffolding (−0.33, sign p=.006, week-eval 2026-07-09); iter D inline version fixed it to 0.00 diff and tokens −66.6/match, ADOPT (0e5612d2).
- **Lessons (Hard constraint)**: Only port the inline final state, never port the append initial version — timeline colocation is where the regression root cause lay.
- **Dependencies**: enemyCDs util (already ported) + Subproject 5 spell data (already integrated).
- **A/B target dimensions**: inferenceScaffolding (repair target) + focusCalibration; deterministic token count comparison.

### 3. POSITIONING (Together with geometry scanner) ✅ (Closed 2026-07-11: scanner built + 0-violation hard gate passed)

- **Content**: POSITIONING section, missed-trinket distance/LoS hints, position legend.
- **Old repo evidence**: B124 judged INCONCLUSIVE (control ceiling 5.00) → ADOPTed based on factual correctness: 100-match scan showed POSITIONING completely clean; fake "LoS blocked" 142 → ~0 (after guards + geometry recalibration); impossible CC distance 3 → 0.
- **Dependencies**: arenaGeometry (4a already ported, calibrated version), coordinates (compat already provides), **geometry grounding scanner (not ported — prerequisite subtask for this item, including mutation testing)**.
- **Hard gate**: After rebuilding the scanner, run 0-violation verification across the entire corpus first before entering A/B; flag enabling forbidden if violations > 0.
- **Closure evidence (2026-07-11, gladlog f004d74)**: POSITIONING section / LoS hints were already incorporated into 4a with timeline variant and passed three rounds of blind eval; scanner (`packages/eval/scripts/positioningScan.ts`, 5 geometry claim categories × re-evaluating actual sampling timestamps × synthetic fixture mutation unit tests) achieved 0-violation across 2490 claims in full corpus. Scanner identified and fixed two real pipeline defects: hallucinated positions from interpolation across sampling gaps (melee Cheap Shot marked at 17-21yd; gap guard tightened from 8s → 1.5s), and mismatching TRAINED closest distance with named trainer (fixed to per-trainer min).
- **A/B target dimensions**: inferenceScaffolding / accuracy; deterministic = scanner violation count.

### 4. CONTESTED (healer offense V2) ✅ (Closed 2026-07-11: contract assertions fully clean + rubric clauses enrolled)

> **Inventory Conclusion**: V2_CONTESTED_TRADES enabled, `[CONTESTED]` lines appear in 34/176 corpus matches, containing F193 safety phrasing ("EV question, not a verdict", 70–85% bracket, DR Full, enemy interrupts ready). **Closure evidence**: `packages/eval/scripts/contestedContract.ts` assertions passed across full corpus (176 matches) —— 45 `[CONTESTED]` lines / 34 matches, 0 unanchored / 0 sub-70% bracket / 0 missing EV phrasing / 0 exceeding upper cap / 0 out of block; F193 rubric clause (anchored ≤Medium confidence trade discussions do not count as fabrication) added to eval-baseline.md accuracy dimension.

- **Content**: `[CONTESTED]` contest-style trade facts (70–85% bracket + CC ready at Full DR + enemyInterruptsReady) + rubric clause permitting ≤Medium confidence anchored trade findings.
- **Old repo evidence**: F193 (2026-07-09) —— 18 controlled calibration cases (12 stratified + 6 identical prompt negative controls), accuracy/labelBias CI no regression, deterministic safety contract 100% (0 unanchored / 0 above-Medium / 0 sub-70% / negative controls entirely clean), ADOPT.
- **Dependencies**: healerOffenseAnalysis, drAnalysis, enemyInterrupts (all ported).
- **Note**: Rubric text changes cannot be covered by A/B (prompt does not embed system prompt) —— follow old repo practice of per-arm roleplay overriding; rubric clauses enter `eval-baseline.md` along with feature.
- **A/B target dimensions**: focusCalibration; deterministic safety contracts replicated item-by-item as assertions.

### 5. Opportunity Item: Dispel Coverage ✅ (Closed 2026-07-11: A/B ADOPT, coverage 40.3% → 70.9%)

The 4b e2e smoke initial run measured 3v3 real matches with **0% dispel coverage** (4 dispels missing from prompt text) — very likely the top issue for first-round `/eval-baseline`. Fix belongs to prompt builder changes, also goes through `/eval-ab`, target dimension sufficiency (deterministic dispel coverage rate).

> **Closure evidence (2026-07-11, gladlog 154d38c, A/B ledger dispel-visibility row)**: `[CLEANSE]` named dispel spells, teammate `[PURGE]`/`[ENEMY PURGE]` lines, `[MINOR DISPELS]` folded, manifest pruned 12 displacement/shapeshift root-break pseudo-dispels. Deterministic: coverage 40.3% → 70.9% (+30.6pp), tokens +1.3%; blind eval 14 pairs all 7 dimensions inconclusive with zero regression → ADOPTed based on determinism (second isomorphic instance to F20).

---

## E2E Regression Investigation Findings (2026-07-11, dual engine on full corpus, see docs/reports/2026-07-11-e2e-old-vs-new-regression.md)

Three prompt regressions, all introduced by timeline variant ADOPT:

### R1 [High] Death outcome block missing in timeline path ✅ (Fixed 2026-07-11, commit 2ee7ee2)
`buildMatchContext.ts` timeline branch returned early at line 526, `deathOutcomeBlock` (line 992) never rendered —— teammate deaths with available unused rescue externals (Pain Suppression / Lay on Hands) + immunity at death. Analysis already calculated it; pure rendering gate. Fix: move block inside timeline branch. Old 139 matches → new 0. **Low risk, high value, recommend prioritizing.**

### R2 [Medium] NEVER USED cooldown explicit tag missing ✅ (Fixed 2026-07-11, same batch as R1)
Same root cause (line 813 `[UNUSED]` placed after line 526 return). Timeline loadout lists cooldowns but did not tag "never used all match". Old 1080 → new 47. Can be fixed together with R1.

### R3 [Medium] ABILITIES INTO IMMUNITY/DR Not Ported ⬜
Offensive wasted-GCD facts used into enemy full DR / immunities; gladlog has no equivalent feature (truly not ported, not a rendering gate). Old 228 → new 0. Requires building a new offensive-into-immunity scanner, passing through `/eval-ab` (targeting accuracy/focusCalibration).

Minor: Lay on Hands missing from extractMajorCooldowns loadout table (decorative; R1 fix restores its death annotation).

---

## Completion Status (2026-07-11)

**All five items closed**: #1 KICK (timeline variant ADOPT), #2 EXPOSURE inline (already present via inventory), #3 POSITIONING (scanner + 0-violation gate), #4 CONTESTED (contract assertions + rubric clauses), #5 Dispel coverage (A/B ADOPT). This backlog is ready for archiving to docs/reports/. Remaining opportunity item: token compression iteration (timeline variant +76% vs sparse, same topic as old repo iter A-D) —— independent of this backlog.

## Accounting Rules

At the close of each cycle: ledger A/B cycles row (following 4b protocol) + check off corresponding item in this document with a one-line conclusion. Once all complete, archive this backlog into docs/reports/.
