# #17b Arithmetic Counterfactual Feasibility Quantification Report (2026-07-30)

**Key Takeaway: The primary form of the "usable but unpressed" counterfactual in the backlog was overturned by data (real trigger rate 5.6%, rough estimate 79.7% was a scope illusion); two alternative pivot forms have ample trigger opportunities — "Submitted Defensive Effect Accounting" at 33.2%, and "Teammate External Usable But Not Given" at 23.0%. The final form of 17b awaits user decision before designing.**

Method: Fixed seed 170170, full database of 794 directories / 2531 matches (rounds) / 0 parse failures, 1310 friendly death evaluation units (0 skipped); all reused production predicates (`extractMajorCooldowns` / `cdAvailableAt` / `MITIGATION_TABLE` / `wasLockedOutThroughWindow` / `buildAuraIntervals` / `buildDeathOutcomeSummary`), zero fabricated heuristics. Death window = 10s before death.

## 1. Original Form: Four-Tier Distribution of "Self Usable But Unpressed"

CC lockout isolated: 68/1310 (5.2%, `wasLockedOutThroughWindow` native 5s window; stretching to 10s becomes an empty criterion, 0/1310). Non-lockout N' = 1242:

| Tier | Share |
| --- | --- |
| No available defensive candidate | **94.0%** |
| Still dies | 1.7% |
| Marginal | 2.9% |
| Clearly survives | 1.4% |

- **Trigger rate (has candidate / all deaths) = 5.6%**; clearly survives hit rate (within candidate pool) = 23.0% → only **~1.3%** of all deaths can definitively say "clearly survives".
- Candidates are highly concentrated: Blessing of Spellwarding accounts for 64.9% (Paladin, 300s CD, talent tree confirms zero casts), followed by Cloak of Shadows 9.5% / Barkskin 6.8%, etc.

### Why the 79.7% Rough Estimate Was Off by an Order of Magnitude

An 80-match pilot used the same scope but **omitted `cdAvailableAt`** (only asking "is this spell in the class spell pool?", not asking whether the spell was off cooldown at the moment of death), yielding 71.3% — exactly the rough estimate magnitude. Adding back the availability check caused it to plummet to 2.2% (converging to 5.6% across the full dataset). Two sources for this discrepancy:

1. **Cooldowns have mostly already been used**: Defensive CDs are mostly 30–300s, with a high probability of having been spent earlier and still on cooldown before death — this is a real game mechanic, not a measurement flaw;
2. **`extractMajorCooldowns` intentionally silences and excludes spells with zero casts throughout the match** (cooldowns.ts ~617-630 comments: prevents "unselected talent" from being misjudged as "selected but unused"), retaining only those confirmed via talent tree parsing — candidate pool is biased by talent parsing success rate per class (Paladin 204018 happens to be easy to confirm, thus dominating top 1). 5.6% may therefore be slightly underestimated, but the order of magnitude remains unchanged.

## 2. Pivot Form Trigger Rates (Same 1310 Deaths)

| Form | Trigger Rate | Arithmetic-Capable Subset (In-table, non-positional) | Top Spells |
| --- | --- | --- | --- |
| **A. Submitted Defensive Effect Accounting** (Deceased had active whitelist defensive in death window) | **33.2%** (435/1310) | 71.3% | Pain Suppression 13.6% / Blessing of Sacrifice 10.8% (off-table) / Time Dilation 9.4% / Touch of Karma 7.1% (off-table) / Barkskin 6.9% |
| **B. Teammate External Usable But Not Given** (`buildDeathOutcomeSummary.missedExternals`) | **23.0%** (301/1310) | 80.4% | Lay on Hands 71.1% (pure heal, off-table) / Blessing of Protection 55.5% / Ironbark 20.6% |
| (Original) Self Usable But Unpressed | 5.6% | — | Spellwarding 64.9% |

Form A aligns directly with the user's scenario ("I don't know if Spell Reflection's 20% is enough" — quantifies that submitted mitigation blocked X, leaving gap Y); Form B is a core healer coaching scenario (Pain Suppression available but not given), and the `deathOutcome` ledger already exists. The original form can be retained as a narrow-gate supplement (1.3% trigger rate but almost certainly true).

## 3. Incidental Discoveries (Independent Findings, Do Not Discard)

1. **deathOutcome external whitelist of 7 spells ≠ spellIdLists external whitelist of 14 spells** — `buildDeathOutcomeSummary` embeds an earlier, narrower table; Form B's trigger rate is entirely dictated by these 7 spells (a form of cascading whitelist rot, candidate for convergence).
2. **Suspected Production Path Bug**: Renderer `deathRecap.ts` constructs `combatLike` setting only `startInfo.zoneId`, while `buildDeathOutcomeSummary` reads top-level `combat.zoneId` → production path external LoS filtering is likely passing through unconditionally (not taking effect). Needs verification and fix.
3. `extractMajorCooldowns` zero-cast exclusion creates class bias for "candidate-style" consumers (§1.2) — if a fair cross-class candidate pool is needed in the future, this requires a separate resolution.

## 4. Pending Decisions

Primary 17b form: Form A primary + Form B secondary + Original form as narrow gate, or another combination; and whether high-frequency off-table spells in A (Blessing of Sacrifice transfer / Touch of Karma) are worth expanding into the table. Proceed to spec/plan once decided. 17a (Unnecessary External Determination) is unaffected by this report, output surface already decided (new candidate type + `MISTAKE_RULES` dual registration).

—— Measurement script was one-off (deleted), original report content from `/tmp/counterfactual-tiers-report.md` has been incorporated here; evaluation unit enumeration was verified across two independent implementations (exact reproduction of N=1310).
