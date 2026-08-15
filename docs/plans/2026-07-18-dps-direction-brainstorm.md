# DPS Player Direction — Brainstorming (2026-07-18)

> Current status: The AI review pipeline assumes owner is a healer (`StructuredAnalysisPanel` has
> `if (!healer) return null`; richContext in `buildMatchContext` features healer as the
> protagonist). DPS players — the vast majority of the player base — see an empty AI view.
> This document addresses: What does a DPS review actually need, which existing assets are directly reusable, what is missing, and how to stage implementation.

## 1. Four Core Questions in DPS Reviews (Jobs-To-Be-Done)

Healer reviews ask "did I save my teammate?"; DPS reviews ask four completely different questions:

1. **Did my burst hit thin air?** (Burst Alignment)
   Popped major cooldowns, but hit enemy defensives/immunities (Turtle/Ice Block/Obsidian Scales active),
   or failed to overlap with teammate burst windows, or target had full HP far from death threshold — all wasted.
   This is the costliest DPS mistake, with 2–4 opportunities per match.

2. **Did I swap when I should have?** (Target Selection)
   During the 6 seconds the enemy healer was polymorphed, 78% of your damage was still dealt to the tank — kill window was open,
   but damage didn't go into the window target. We have all the data (kill windows already compute team damage by target).

3. **Did I overlap/waste teammate CC on DR?** (DR Sequencing)
   Landing a Stun hammer midway through a teammate's Silence/Strangulate duration = wasting a 60s CD. `drAnalysis` DR chains
   are already calculated accurately; what is missing is **per-caster attribution**: "Your X was cast at 50% DR on the target,
   lasting 2s (instead of full 4s)".

4. **Was my interrupt baited/juked?** (Kick Management)
   Enemy fake-casted to bait your kick → completed free cast on real cast. **With castStarts in place, this becomes a
   killer application**: cast start → no success (manual cancel) + your kick missed within 0.5s of cancellation =
   juked; conversely, kicking an enemy's real cast = good kick. Previously impossible to evaluate without cast-start
   data.

Plus generic features (already ready): how death occurred (death recap covers both sides), CC/interrupt statistics (stat tables),
window color bands, cross-match aggregations.

## 2. Asset Inventory

**Directly reusable (perspective-agnostic)**: computeOffensiveWindows + bursts, drAnalysis,
ccTrinketAnalysis (after pet fix), dispelAnalysis bidirectional, deathOutcome / death recap,
stat tables, match dashboard, candidateFindings death/cd-waste event types.

**Healer-specific (not applicable to DPS version, left intact)**: healer_offense (slack-gated),
healingGaps, healer exposure, HPS benchmark.

**New analysis to build (all have data foundation)**:

- `burstAlignment.ts`: owner offensive CD casts × enemy defensive/immunity active intervals
  (SPELL_CATEGORIES buffs_defensive/immunities + aura intervals) × ally burst windows
  (mirror of enemyCDs, computed for allies) × target HP at the time. Outputs
  "3 bursts: 1 into Turtle (0 value), 1 solo-popped, 1 aligned with teammate → kill".
- `targetAudit.ts`: owner damage breakdown by target within each kill window vs window target.
- DR attribution: drAnalysis output adds casterName (chain data already present), referenced in findings.
- `kickAudit.ts`: castStarts × SPELL_INTERRUPT × cast-cancel determines juked vs good kick.
  (Note: legacy archives lack castStarts, analysis automatically absent for old matches — same precedent as cast bars.)

## 3. Architectural Refactor Points (One-time Generalization, Dual Benefits)

1. **Owner perspective generalization**: `buildMatchContext` changes healer-owner assumption to
   `ownerRole: "healer" | "dps"` branch — timeline/death/CC/DR/windows are all shared,
   simply swapping healer_offense block for DPS burst ledger block.
   `StructuredAnalysisPanel`'s `if (!healer) return null` updated to select perspective based on owner spec.
2. **candidateFindings expansion**: Add new event types `burst-into-immunity`,
   `off-target-in-window`, `dr-clipped-cc`, `juked-kick` (each produced by deterministic
   predicates; LLM only handles narrative — reusing findings audit pipeline, ungrounded claims auto-dropped).
3. **Prompt landscape**: PROMPT_VERSION bump (new blocks); healer prompt untouched,
   DPS prompt is a new variant — mutually isolated, evaluated separately.

## 4. Eval Side (Do Not Skip)

- Corpus: Existing 70 logs are recorded from healer perspective, but **owner can be changed** (who recorded the log
  does not affect deterministic parts analyzing other players; however, [YOU] perspective resource/intent information is only available
  for the recorder). Phase 1 cleanest with "recorder is DPS" logs — need to collect a batch of
  DPS-owner logs (or use owner's DPS teammates from existing logs for degraded validation).
- Rubric: 7 dimensions are generic, but sufficiency anchors need DPS adaptation (whether burst alignment data is present,
  whether DR attribution is present); judge-instructions produces DPS variant.
- Standard discipline: Deterministic gates come first (burst-into-immunity rate, off-target rate can all be gated),
  LLM judge only evaluates narrative quality.

## 5. Staging Recommendations

- **D1 (Pure UI, Zero Prompt Risk)**: burstAlignment/targetAudit/kickAudit three
  derives + "Burst Ledger" card on match report (one row per burst: timestamp / target / alignment state / outcome,
  clickable to jump replay). DPS players immediately get deterministic review UI without touching AI.
  **✅ 3 ledger parts completed 2026-07-16**: analysis `burstLedger.ts` (burst grouping reuses
  enemyCDs BURST_CLUSTER_SECONDS/CD predicates; immunity hit uses real aura intervals
  `buildAuraIntervals`) + `kickAudit.ts` (landed = SPELL_INTERRUPT mirror;
  juked uses castStartEvents, lookback constant asserted equal to CAST_BAR_MAX_MS);
  parser-compat adds optional `castStartEvents`; report card `BurstLedgerCard` (player pagination,
  three sections, row-by-row ▶ replay jump). Legacy archives mark kick as unknown, re-importing brings cast data.
  **✅ 2 replay visual items completed 2026-07-16**: enemy offensive CD active red pulsing ring
  (span = burstCastSpan, same interval as ledger audit) + same-second focus-fire golden dashed ring
  (2+ enemy players attacking same target in same whole second; pets attributed to owners). **D1 fully closed.**
- **D2 (AI Generalization)**: owner perspective generalization + 4 new candidate event types + DPS prompt
  variant; /eval-baseline DPS edition working.
  **✅ Completed 2026-07-16**: owner = log recorder (healer prompt byte-for-byte unchanged, pinned by unit test);
  DPS owner gets `<burst_ledger>` block + 4 new event types (legend dynamic by present types);
  PROMPT_VERSION 4. eval: `buildCorpus --owner dps` (degraded corpus 176 matches) +
  gate rule subject triple fixes + interpolation blindspot grid fill → geometric gate 0/2665; 6 sonnet smoke runs all
  anchored around ledger (runId 2026-07-16-dps-smoke).
  **✅ Formal DPS baseline completed 2026-07-16** (runId 2026-07-16-dps-public):
  60 real DPS recorder public matches (wowarenalogs public channel), DPS judge variant,
  all sonnet. acc 4.52 (on par with healer baseline) / suff 4.60 / focus 4.98 /
  outcome 4.97; hard flag 1; factAudit 166v/14r/0u; ledger used as 60/60 response spine.
  Top fix items (all deterministic): kickAudit pet kick src + teammate kick false-positive juke,
  off-target window clipped on target death, [HEALER EXPOSURE] trinket subject, stray CC coverage
  tail review. See eval-report.md for details.
- **D3 (Closed Loop)**: DPS findings enter "Most Common Mistakes" aggregation and "Match Objectives"
  (coach closed-loop in backlog #12–#19 holds true for DPS as well).

## Decisions to Make

1. D1 first (deterministic burst ledger, no AI) or jump directly to D2 (full generalization)?
2. DPS-owner corpus: Do you have DPS perspective logs, or start with teammate degraded validation?
3. First target spec (recommend picking a spec you frequently queue with, easier to write rubric anchors).
