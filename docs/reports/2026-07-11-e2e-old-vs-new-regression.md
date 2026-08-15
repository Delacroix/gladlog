# E2E Full Regression Comparison: Legacy vs New Software (User Self-Collected Corpus)

Date: 2026-07-11
Corpus: `~/code/gladlog-eval-private/corpus/manifest-full.txt` (70 log files, 6.8GB, user 1000+ matches)
Methodology: Dual engine parallel run — legacy fork (legacy parser + legacy pipeline buildMatchContext) vs gladlog (new parser + compat + timeline variant pipeline), (file, index) death signature LCS alignment.
Harness: `wowarenalogs/scratch/parser-diff/{runFullLevel1.sh,runFullPrompts.sh,runPrompts.ts}` + `scratchpad/e2e/{compareLevel1,comparePrompts}.mjs`.

## A. Level-1 Core Facts (1190 Aligned Matches) — Zero Fact Regression

| Dimension | Result |
| --- | --- |
| Structural fields (segmentation / roster / spec / team / win-loss) | Unit set mismatch 0; win/loss flips **4** |
| 4 Flip adjudications | **agy (Gemini) cross-family arbitration: 4/4 new correct vs legacy wrong** — 2 cases where legacy treated feign death (unconscious=1) as first death and marked loss, 2 cases of sub-second double death order mismatch. Ruling evidence attached at `scratchpad/e2e/flip-evidence/`. |
| Extra salvaged on new side | +55 matches (unclosed shuffle rounds / disconnected matches salvaged via new salvage path) |
| Extra on legacy side | 2 matches (actually legacy missed 1 player leading to key mismatch, M4 #1-5 legacy defect class) |
| Total healing | Median 0.00%, p90 0.00% (exact alignment) |
| Total damage | Median 2.98%, p90 12.4% (within M4 #14/#19 adjudicated envelope; outliers are all legacy missing pet merges, legacy was low) |

**Conclusion**: The M4 sample (200 logs) conclusion of "599/600, zero unadjudicated differences" was reproduced across the full 1190 matches. Core fact layer has no regression in new parser, and 4 win/loss corrections directly benefit the user (more accurate match record determination).

## B. Prompt Layer Comparison (1192 Pairs) — 3 Regressions, All Introduced by Timeline Variant ADOPT

Token count: legacy 3165 / new 5313 (timeline variant richer). Result string difference in 92 places = owner perspective calculation (solo shuffle legacy chose recorder, new chose coached healer) + above 4 flips, not regressions.

Paragraph census (present in legacy, missing in new, occurring ≥ 5 times) identified three **true regressions**, root causes falling into two classes:

### R1 [High] Complete Loss of Death Outcome Block (`DEATHS WITH MISSED OPTIONS` + Immunities Available at Death)

- Present in 139 legacy matches, **0** in new.
- Content: Teammate **available but uncast external defensives** at the time of your death (Pain Suppression / Lay on Hands, etc.), and the deceased's own available immunities.
- Root cause: The `useTimelinePrompt` branch in `buildMatchContext.ts` **returns early at line 526**, while `deathOutcomeBlock` (`formatDeathOutcomeForContext`) is appended at **line 992**. Analysis already computes it (line 246 `buildDeathOutcomeSummary`, including LoH via `EXTERNAL_DEFENSIVE_SPELLS`), but the timeline path never rendered it.
- **Fix**: Move deathOutcomeBlock inside timeline branch (or before return). Low risk, high value — core fact for coaching "how to avoid this turnaround".
- Note: New `[DEATH]` line has `(Unused: X)`, but only lists the **deceased's own** cooldowns, without enumerating teammate externals — covers 62/139.

### R2 [Medium] Explicit `NEVER USED` Cooldown Tag Missing

- Present in 1080 legacy matches (`STATUS: NEVER USED` / `[X]: NEVER USED — available all match`), only 47 in new (edge sparse fallback).
- Root cause same as R1: `[UNUSED]` tag logic (line 813 `if (cd.neverUsed)`) is after line 526 return. Timeline loadout lists cooldowns without tagging "never used all match".
- Impact: Model can only implicitly infer from "spell did not appear on timeline", weaker than explicit tagging.

### R3 [Medium] `ABILITIES INTO IMMUNITY/DR` Not Ported

- Present in 228 legacy matches, **0** in new; no equivalent feature in non-death paths in gladlog code.
- Content: Offensive abilities cast into enemy full DR / active immunities (e.g., "Judgment + Blade of Justice into enemy DK's Pain Suppression") — GCD waste coaching point for target selection.
- Unlike R1: This is **truly unported**, not a rendering gate. Requires building a new feature (offensive-into-immunity scan).

Minor: Lay on Hands not in `extractMajorCooldowns` general loadout list (decoration gap; already in death external table, R1 fix restores its death annotation).

## C. Meta-eval (agy / Gemini 3.1 Pro, Cross-Family Role-Play)

Blind comparison between legacy and new on death-containing pair 214211#003 (teammate 1:49 death turnaround), independently reproducing:

- Confirmed R1 (LoH/teammate externals missing at death on new side), R3 (casting into immunity missing).
- **Additionally found a self-contradiction on legacy side**: Line 40 in legacy prompt "No major defensive CDs available" directly conflicts with Line 165 "Pain Suppression available" — legacy hardcoded human-readable summaries mislead the LLM into excusing the healer; new side resolves this contradiction with raw `[RES] rdy:Pain Suppression[2/2]` snapshots.
- **Net judgment: New prompt is strictly superior on core coaching questions** — timeline cast sequences + exact [RES] status snapshots + positioning (DK in melee range 0.6 yards from 1:42) enable coaches to reconstruct realistic scenarios of "panicked under melee pressure, forgot to use externals"; legacy flat data cannot do this. R1/R3 are patchable gaps on top of net superiority.

## Action Items

- R1 + R2 share root cause (early return at line 526 drops two sparse-only blocks) → fix together, add to app/prompt backlog.
- R3 new feature → route through `/eval-ab` (target dimensions: accuracy / focusCalibration), add to prompt feature backlog.
- 4 win/loss corrections, 55 extra salvaged matches = new side net gains, no action needed.

## Fix Confirmation (2026-07-11, commit 2ee7ee2)

R1 + R2 fixed (same root cause: timeline branch early return missed rendering two sparse-only blocks):
- R1 death outcome block moved into timeline branch; R2 `buildPlayerLoadout` tags `[UNUSED]` for cooldowns uncast all match (owner + teammates, strict superset of legacy owner-only).
- Full re-verification (1245 prompts regenerated): R1 coverage 139 → **150**, R2 1080 → **1106**, both restored and slightly exceeding legacy; token +12/match (+0.2%). analysis 491 tests green.
- Turnaround match 214211#003 verified: restores "teammate Pain Suppression / Lay on Hands available at death" fact + exposes healer holding two charges of Pain Suppression uncast.

R3 (offensive into immunity) pending: `buildOffensiveWasteSummary` / `formatOffensiveWasteForContext` already imported and computed in builder, suspected to be a similar rendering gate rather than truly unported — to be verified and addressed separately.
