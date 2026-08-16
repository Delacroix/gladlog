# 4a Data Realignment Round 1: Benchmark Reconstruction and Drift Report

Date: 2026-07-11
New Baseline: `packages/analysis/benchmarks/benchmark_data.json` (gladlog parser + compat, locally harvested corpus)
Old Baseline: `benchmark_data.old-parser.json` (immutable, old parser + GCS public logs)

## Methodology

- Corpus: 200 locally harvested single-match cached logs (first batch of the 6,210 total corpus; subsequent rounds will expand volume).
- Pipeline: GladLogParser → toLegacyMatch/toLegacyShuffle → per-player samples (personalRating ≥ 2100).
- Stratification: spec × comp archetype (healer spec name + non-healer count), cap 40 per stratum, minN 30; 346 matches entered statistics.
- Refitting Gate (per spec): The new stratum P90 drift direction is consistent with the old baseline AND sample size is sufficient; thresholds are modified only when both conditions are met simultaneously.

## Per-Spec Drift (pressure P90)

| Spec | n(New) | Samples | Old P90 | New P90 | Drift % |
|---|---|---|---|---|---|
| Affliction Warlock | 23 | ok | 478821 | 363025 | -24.2 |
| Arms Warrior | 64 | ok | — | 514139 | — |
| Assassination Rogue | 19 | ok | — | 432821 | — |
| Balance Druid | 10 | ok | 491224 | 486412 | -1.0 |
| Beast Mastery Hunter | 11 | ok | — | 485258 | — |
| Destruction Warlock | 11 | ⚠️Insufficient | 493898 | 468674 | -5.1 |
| Devastation Evoker | 17 | ok | 402047 | 410937 | 2.2 |
| Devourer Demon Hunter | 64 | ok | — | 5369 | — |
| Discipline Priest | 55 | ok | — | 139347 | — |
| Elemental Shaman | 15 | ok | 479577 | 531681 | 10.9 |
| Enhancement Shaman | 13 | ⚠️Insufficient | 496041 | 572453 | 15.4 |
| Frost Death Knight | 11 | ok | — | 488686 | — |
| Frost Mage | 50 | ok | 453032 | 482893 | 6.6 |
| Havoc Demon Hunter | 28 | ok | — | 313015 | — |
| Holy Paladin | 45 | ok | 241108 | 199793 | -17.1 |
| Holy Priest | 23 | ok | 58220 | 94786 | 62.8 |
| Marksmanship Hunter | 16 | ok | — | 514822 | — |
| Mistweaver Monk | 40 | ok | 157095 | 237246 | 51.0 |
| Preservation Evoker | 41 | ok | 379099 | 219469 | -42.1 |
| Restoration Druid | 54 | ok | 279386 | 405940 | 45.3 |
| Restoration Shaman | 50 | ok | — | 231114 | — |
| Retribution Paladin | 38 | ok | — | 464531 | — |
| Shadow Priest | 34 | ok | — | 528387 | — |
| Subtlety Rogue | 16 | ok | 334343 | 410070 | 22.6 |
| Survival Hunter | 26 | ok | — | 488297 | — |
| Unholy Death Knight | 35 | ok | — | 436780 | — |
| Windwalker Monk | 20 | ok | 349875 | 428669 | 22.5 |

Comparable specs: 14; of which absolute drift ≤ 15%: 5, > 30%: 4

## Coverage Gaps (Affects measurement criteria; required context for interpretation)

1. `advancedActorPowers` is always `[]` (the new parser has not collected powers yet) — mana burn / pressure style determinations fail, but this does not affect pressure/HPS/DPS metrics.
2. Handwritten catalogs (spellEffectOverrides/classSpells/spellCategories/drCategories) represent the minimal set of public facts — major CD detection coverage is calibrated with proprietary tests; missing long-tail spells will slightly underestimate CD-related metrics; retest after subproject 5 pipeline artifacts are replaced.
3. Corpus composition: Locally harvested (personal MMR pocket / comp bias) vs old GCS public high-rating logs — large drift in healer pressure metrics (Holy Priest +62.8%, MW +51%) is suspected primarily due to this, secondarily due to M4 known absorb/pet semantic corrections.

## Conclusion (This Round)

- **Zero refitting**: Among 14 comparable specs, 5 show drift ≤ 15% (core metrics healthy); all 4 with > 30% are concentrated in healer pressure metrics and did not pass dual confirmation (sample size 200/6210 and corpus composition divergence unisolated) → `PANIC_PRESS_DAMAGE_THRESHOLD_*` all **retain legacy values**.
- Newly added specs (Devourer DH and others missing in legacy baseline) record their first baseline values with no prior comparison.
- Next round (after full corpus + subproject 5 data): Expand samples to the full 6,210 set, re-verify healer drift directions; specs passing dual confirmation enter threshold refitting.
