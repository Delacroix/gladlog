# What Else Can We Do for Healers — Brainstorm (2026-07-16)

> Healing is currently the product's primary focus (prompt/eval/UI are all centered around healer owner), with a solid foundation:
> `healingGaps`, `exposure/LoS`, `healer_offense`, dispel coverage, CC/trinket, death recap, kill windows, HPS benchmarks.
> This document answers: on top of this foundation, what are healer players still missing?
> Companion doc: `2026-07-18-dps-direction-brainstorm.md` (DPS direction).

## 0. Two Data Facts (Verified)

1. **Mana values exist in raw logs, but the parser discards them.** Advanced parameter lines carry `powerType`/`currentPower`/`maxPower` (the section between `maxHp` and `x/y`); `decodeAdvanced` (`packages/parser/src/l1/decoders.ts:139`) currently only decodes `hp`/`maxHp` and sweeps straight to coordinates. Adding 3 fields + L3 sampling pipeline + re-importing is sufficient to get an event-by-event mana curve for the owner.
   **[Ruling 2026-07-16] Mana direction shelved: No one runs out of mana in the current meta, so mana management holds little review value. Field decoding is reserved for future meta shifts (if OOM ever becomes a win condition again, these notes serve as an implementation blueprint).**
2. **Overheal is decoded in L1 but discarded in L3.** `decodeHeal` already parses `overheal`/`absorbed`, but it is not surfaced in `GladUnit`'s heal events. A minor plumb-through fix — this **still needs to be done**, as it feeds triage "panic major CD" detection (high overheal on big CDs).

Parser modifications must pass the differential oracle gate (additive new fields, diff rules permit new keys).

## 1. Next-Level Healer Review Questions (Currently Unanswered)

1. **Did I heal the right person?** (Triage Quality)
   - Snapshot comparison: When each large heal landed, who was the lowest HP teammate? — "You healed a 90% DPS while a teammate was at 30%"; HP sampling + `healOut` by target data already exists;
   - Overheal rate broken down by spell (relies on Fact 0.2): Big CD resulted in 80% overheal = panic button press;
   - Complementary to `healingGaps`: gaps highlight "you didn't heal", triage highlights "you healed, but the wrong target".

2. **How was my cast discipline?** (Killer healer app for `castStarts`, data already landed)
   - Interrupt audit: Of the casts that were kicked, how many were high-value spells hard-cast while enemy kicks were visibly available? (Lockout stats by spell school exist, but lack attribution);
   - Fake cast: cast start → manual cancel → enemy kick whiffs → real cast finishes = textbook juke/fake cast, deserves praise (the inverse of the "highlight even if not done" logic in `[VULNERABLE]`);
   - Shares the same event geometry with the DPS `kickAudit`, sharing predicates across both.

3. **How fast did I react when enemies popped CDs?** (Burst Response Latency)
   - Enemy offensive CD activated (`enemyCDs` exists) → seconds until your first defensive / big heal GCD;
   - Target focused / damage spike → seconds until breaking LoS (`positions` + `LoS` predicates exist; the inverse of healer exposure: exposure says you stood in the open, response latency says whether you corrected quickly).

4. **Dispel Quality (Not Just Coverage)**
   - Median latency from critical debuff applied → dispelled (dispelling CC/debuff after 8s ≈ not dispelling);
   - Dispel priority errors: dispelling low-value trash debuffs while lethal magic CC is active;
   - The coverage gate has locked down "whether dispels happened" (<80% matches 104 → 4), next layer is "how fast and whether prioritized correctly".

5. **Preparation Before Entering CC** (Getting CC'd is inevitable; preparation is skill)
   - HoT / shield snapshot on the team at the moment of entering CC: unprotected team entering Polymorph vs fully HoT'd team entering Polymorph, compared against damage outcomes over the next 5s; aura intervals + CC instances data are all available.

## 2. Priority and Phasing

- **H1 (Minor parser addition, single PR)**: Overheal plumb-through (mana fields shelved, see ruling); pass oracle gate; re-import. Feeds triage panic-CD detection; triage snapshot comparisons do not depend on it and can proceed in parallel.
- **H2 (Deterministic Analysis + UI, no prompt changes)**:
  - Combat report "Healing Ledger" card: Triage snapshot table + dispel latency + cast discipline, every row clickable to seek replay (isomorphic to DPS Burst Ledger, shared card framework);
  - Dashboard healer trend: Interrupted count / dispel latency cross-match curves.
- **H3 (AI Layer, via `/eval-ab`)**: Triage / dispel latency evidence lines fed into prompt;
  New `candidateFindings` kinds: `late-dispel`, `wrong-target-heal`, `panic-cd`, `good-fake-cast` (produced by deterministic predicates, reusing audit pipeline). Healer prompt is mature; run isolated A/B evaluations per block rather than bundling.

## 3. Decisions Needed

1. Healer Ledger vs DPS Burst Ledger: which to build first? (Card framework is shared; building one makes the other cheaper).
2. Plumb overheal now? (One small modification + pass gate; if not urgent, merge into the next parser change).
