# DEFENSIVE-001 Landing + DEFENSIVE-002 Data Rejection

Date: 2026-08-07 · BACKLOG #18 Batch 2 Item 3 · Empirical evidence first (`.defensive-rates-report.md`,
probe `packages/desktop/scripts/tmp-defensive-rates.mts` — deleted after evaluation).

## DEFENSIVE-001 (cc-avoidable)

**Criteria (all existing predicates, zero new tables)**: owner is a healer; an entry in `ccInstances` from `analyzePlayerCCAndTrinket` 
takes the full `durationSeconds >= 3` and `drInfo.level === "Full"`; before landing
at least one spell in `ccTrinketAnalysis.ts`'s existing `CC_AVOIDANCE_BUFF_SPELLS`/`REPOSITIONING_SPELL_IDS` (gated by
`GROUND_CC_SPELL_IDS`/`TARGETED_CC_DODGE_SPELLS`/`MAGIC_ONLY_IMMUNITY_IDS` ×
`PHYSICAL_CC_IDS`/`DRUID_FORM_BUFFS`, semantics share the same origin as `ccAvoidedInstances`, extracted as a newly
exported `applicableCCAvoidanceIds`) satisfies both: ① kit evidence (successfully cast at least
once this match) ② `cdAvailableAt` determines it was off cooldown at the moment of landing.

**Deduplication gate (hard)**: Exclude instances where `trinketState === "available_unused"` —— this state is already
covered by the two existing candidates `cc-locked`/`wasted-trinket`, a single instance is never doubly incriminated.

**cap**: 2/round, descending order by CC duration (same sorting philosophy as `cc-locked`: keep the heaviest).

**facts**: `t` (floor to render seconds), `spell` (the CC taken), `durationS`, `avoidableWith` (available
avoidance spell names, joined by comma `, `; multiple spells take the fixed Map iteration order of `applicableCCAvoidanceIds`,
deterministic). Does not include `trinketState`/`trinketNote` —— excluded by the deduplication gate, not needed.

**Legend wording (prevents causal assertion)**: "Before landing X was available —— could be used to avoid this type of CC", do not write "could have been avoided" /
"therefore". Reason: whether to use an avoidance skill might itself be a reasonable resource tradeoff (saving it for a bigger threat), the gate rule cannot
directly translate "available but unused" to "would have been avoided if used".

### Empirical Numbers (200 matches / 635 healer owner rounds, `.defensive-rates-report.md` original investigation + this re-scan using final implementation code, both independently match)

```
Original criteria (trinket overlap not excluded):
  Full-DR >=3s CC events: 2398
  Hit events: 269 (11.2%)      Hit rounds: 105/635 (16.5%)
  Overlap with trinketState=available_unused: 173/269 (64.3%)

Final criteria (exclude overlap + cap 2/round, calling real ccAvoidableEvents/ccAvoidanceOptionsAt re-scan):
  Original deduped events (uncapped): 96   ——  sanity check: 269 − 173 = 96, matches
  Actual output entries (capped): 78
  Hit rounds: 59/635 (9.3%)
```

Distribution by avoidance skill (original 269 hit events): Divine Shield 168 (62%), Blessing of Protection 46,
Blessing of Spellwarding 43, Angel's Feather 42, the rest (Chi Torpedo/Rescue/Spirit
Walk/Blessing of Freedom/Divine Steed/Tiger's Lust) total 22. Three Paladin skills
(Divine Shield + Blessing of Protection + Blessing of Spellwarding) total 257/269
= **96%** —— recorded as-is, not a bug.

Hit rounds by specialization (final criteria, after dedup + cap): Holy Paladin 33/98 (33.7%), Discipline Priest
14/194 (7.2%), Mistweaver Monk 6/88 (6.8%), Restoration Shaman 2/58 (3.4%),
Holy Priest 2/60 (3.3%), Preservation Evoker 2/62 (3.2%), Restoration Druid 0/75
(0% —— the only potentially applicable Stampeding Roar displacement in the kit never simultaneously met "off cooldown before CC lands +
landing is a displaceable dodgeable type" in this sample). Holy Paladin concentration is high but not pathological: this spec has Divine Shield +
Blessing of Protection + Blessing of Spellwarding, three powerful avoidance tools, while other specs generally only have displacement
skills (narrower applicability, see `applicableCCAvoidanceIds`'s targeted CC gating).

## DEFENSIVE-002 (low HP non-cycled minor mitigation) —— Data Rejection

**Table source**: 100% derived from the existing `MITIGATION_TABLE` (subset of `pct<=30` or `cooldownSeconds<=60`,
14 items), zero newly created.

**Rejection reasons (three points, any one is enough, stacked makes it more solid)**:

1. **Occurrence rate bottomed out**: Under HP<50% (the widest of the three thresholds), the entire database only had **3 hit rounds / 264 evaluable rounds
   = 1.1%** —— lower than the `healing-gap` precedent line (5.3% rounds) which is the lowest among the four landed categories in `signal-expansion-batch1`,
   and there is no room to relax further (HP<35%/40% two tiers are even lower, 0.4%/0.8%).
2. **Two specializations structurally zero applicable**: Discipline Priest (194/194 rounds, 100%) and Holy Priest
   (60/60 rounds, 100%) will **never possibly** produce DEFENSIVE-002 under the definition of minor mitigation —— Holy Priest is a
   hard structural problem with zero applicable entries in `MITIGATION_TABLE`; Discipline Priest nominally has 1 applicable
   Power Word: Barrier, but the next point's numbers show it is practically equal to zero.
3. **Discipline's only entry is practically non-existent**: Power Word: Barrier in the entire **808 matches** database globally only
   had successful casts in **8 matches** (regardless of whether the owner is a Discipline spec) —— hit probability approaches
   0, it is not a problem that can be adjusted back by thresholds.

**Conclusion**: Do not add a new type, do not dimensionally upgrade fields (unlike the DISPEL-002 precedent —— that time was "has volume but not enough to
warrant a standalone type", this time is "the volume itself does not exist"). BACKLOG #18 Item 3 is hereby marked "Data Rejection" and closed,
no longer waiting for user to approve thresholds; if `MITIGATION_TABLE` is expanded in the future to cover Holy Priest/Mistweaver, it can be
re-evaluated.

## Acceptance

- Unit tests (TDD, `packages/analysis/src/analysis/candidateFindings.test.ts` +
  `packages/analysis/test/ported/ccTrinketAnalysis.test.ts`): `applicableCCAvoidanceIds`
  school gate / Druid form gate / landing type vs targeted type gate boundaries; `ccAvoidanceOptionsAt` kit evidence gate
  + CD available gate (including the non-intuitive branch "evidence comes from a cast after landing"); `ccAvoidableEvents`
  full-DR gate / `>=3s` gate / trinket overlap dedup gate / cap keep heaviest; end-to-end (`extractCandidateFindings`)
  healer-only gate (non-healer owner yields zero output in the same scenario). Existing tests all green (analysis 1106, desktop 1167).
- Corpus re-scan (same 200 match criteria, calling real implementation): 96 entries (deduped uncapped) / 78 entries (capped) /
  59/635 rounds (9.3%), consistent with the numbers in this document.
- `PROMPT_VERSION` 20→21 (`packages/desktop/src/shared/promptVersion.ts`).
- Desktop anti-corruption tests (`packages/desktop/test/report.mistakes.test.tsx`) forced two registrations:
  `MISTAKE_RULES` (`mistakes.ts`, label "Avoidance available but unused", severity minor, same
  "opportunity cost" framework as `cc-held`), `TYPE_LABEL` (`findingDisplay.ts`).
