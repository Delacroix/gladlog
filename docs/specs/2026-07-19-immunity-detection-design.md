# Full-Immunity Burst Detection (burst-into-immunity blind spot) Design

**Objective:** Ensure that the "popping cooldowns while the enemy is invincible" flagship offensive mistake can be detected in its **most typical form** —
currently, it can only be caught if immunity is **applied mid-burst**, but it is completely invisible if immunity **covers the target before the burst begins**.

**Architecture:** Decouple immunity detection from `dominantTarget` (damage-derived) and re-attach it to the **spellcast target**.
Do not add a new analyzer, just modify the target derivation in `burstLedger.analyzeBurstLedger`;
the consumption side for `candidateFindings.dpsOwnerEvents` and the offensive deep dive pack remains unchanged.

**Tech Stack:** `packages/analysis/src/utils/burstLedger.ts` (main change),
`packages/analysis/src/analysis/candidateFindings.ts` (consumption side),
eval deterministic scanning in `packages/eval/scripts`, corpus in `$GLADLOG_EVAL_HOME`.

## Global Constraints

- **Single Source of Truth for Predicates Rule** (CLAUDE.md): Immunity intervals must continue to use `buildAuraIntervals(unit,
DEF_OR_IMMUNE_IDS, combat.endTime)`, and a separate aura scan must not be written. The rounding of `overlapSeconds`
  (`Math.round(ms/100)/10`) and `MIN_DEFENSIVE_OVERLAP_S` remain unchanged —
  the `overlap` facts of candidateFindings and gate rules are recalculated based on current values.
- Newly added predicates must always be exported, and consumers must import them; do not rely on comments for coupling (lesson from weekly review P2#6).
- `npm run typecheck` (absolutely no `tsc -b`).

---

## Background / Root Cause

In `analyzeBurstLedger`, immunity and defensive detection are **entirely embedded within the non-empty branch of `dominantTarget`**:

```ts
const top = damageByTarget[0];
if (top) {
  // defensivesHit / isImmunity are only calculated here
}
```

However, `damageByTarget` comes from `player.damageOut` — the parser side `record.damage` is only
populated when the event name ends with `_DAMAGE` (or SWING_DAMAGE) (via `l1/decoders.ts`'s
`hpTailSlice` and `l3/collect.ts:50`), and `SPELL_MISSED` (IMMUNE) does not produce any damage records.

Thus:

| Scenario | Record in damageOut? | dominantTarget | Immunity Visible? |
| --- | --- | --- | --- |
| Immunity applied mid-way (damage in first half) | Yes | = Immune unit | ✅ |
| Immunity covers entire duration, player still attacks it | **No** | `null` | ❌ |
| Immunity covers entire duration, player swaps to someone else | Yes (damage applied to someone else) | = **Someone else** | ❌ |

The missed second and third rows are exactly the tier that most needs coaching. The comments in `deepDive.ts` call
burst-into-immunity a "flagship offensive mistake," but it cannot be detected in its most typical form.

**Cross-AI review confirmed** (agy/Gemini flash independently traced three layers: `parseLine.ts` → `collect.ts`
→ `decoders.ts`): an immune miss will not be categorized as an `amount=0` damage record, so the blind spot is valid.

---

## Key Discovery: Cast Targets Are Still Recorded During Immunity

Immunity cancels out **damage**, not **spellcasts**. `ICombatUnit.spellCastEvents`
(converted from `unit.casts`, `convert.ts:383`) includes `destUnitId` / `destUnitName` for every entry,
meaning every ability thrown into an invulnerability bubble leaves a target record.

This turns the "intended burst target" from a design problem **requiring heuristic guessing** into a query
with **direct evidence** — this is a key difference between this design and the first draft of the weekly review report (which listed it as "requiring the definition of an intended target predicate, a design tradeoff", but now we don't have to guess).

---

## Design: Target Derivation Changed to "Damage First, Casts as Fallback"

Within each burst in `analyzeBurstLedger`:

1. **Maintain status quo**: Aggregate `damageByTarget` via `damageOut`, taking the `top` as the main target.
2. **New fallback**: When `damageByTarget` is empty (full duration immunity, player didn't swap target),
   fall back to using the unit with the most occurrences of `destUnitId` hitting enemy players in `spellCastEvents` within the window as the `dominantTarget`, with `damage: 0`.
3. **New corroborating evidence**: Even if `top` exists, still scan the set of cast targets within the window; if a **non-top**
   enemy unit is targeted by casts ≥ `INTENT_MIN_CASTS` times within the window and has immunity active the entire time,
   produce a separate `wastedOnImmuneTarget` record (covers the third row: popping cooldowns on an invincible target,
   realizing they take no damage, and then swapping to someone else).

The type of `dominantTarget` requires a source tag, so consumers and gate rules can discern the strength of the evidence:

```ts
dominantTarget: {
  ...
  /** damage = derived by aggregating damage; casts = zero damage entire time, fall back to cast target (immunity/fully blocked). */
  derivedFrom: "damage" | "casts";
}
```

### TBD (Must be decided before implementation, do not arbitrarily guess in code)

- The value for `INTENT_MIN_CASTS`. Suggestion is 2: a single cast might be a misclick/AoE splash, two consecutive casts represent intent.
  **Requires a deterministic scan for calibration** (see Validation).
- Self-buff cooldowns (Avenging Wrath / Combustion, etc.) have a `destUnitId` of self or
  `0000000000000000`, and must be **excluded** from intent derivation — only count casts where the target is an enemy player.
- Should pet casts (`petSpellCastEvents`) be included? Leaning towards **not including**: pet targets often lag behind the owner,
  which would dilute the intent signal.
- Full immunity but the player **only casts once** before swapping — this is actually **good play** (probing and immediately switching),
  and should not be reported. `INTENT_MIN_CASTS` is exactly the gate to prevent this from triggering, so the value cannot be too low.

---

## Impact Area

| Consumer | Impact |
| --- | --- |
| `burst-into-immunity` in `candidateFindings.dpsOwnerEvents` | Hit rate will increase (this is the goal). The `facts` structure remains unchanged. |
| `unconverted-burst` in the same location | Need to confirm: bursts with `derivedFrom: "casts"` and `damage: 0` **should not** report as unconverted anymore (it wasn't converted because of immunity, and is already covered by the immunity item; existing filtering `isBurstConverted` + `!defensivesHit.some(isImmunity)` should already exclude it, but a test must be added to pin this down and avoid double-reporting). |
| Offensive deep dive `hasOffensiveCoachableSignal` | `immunity` passes the gate by itself, logic already exists, no changes needed. |
| `formatBurstLedgerForContext` | When `damage: 0`, `fmtM` will print `0.00M`, which reads like a bug. Needs to be changed to phrasing like "Zero damage: fully blocked by immunity". |
| Report UI `BurstLedgerCard` | Same as above, the display of a zero-damage burst needs a human-readable explanation. |

---

## Validation (Must run before and after implementation)

1. **Deterministic Scan Calibration** (no model invocation, 4 corpora): Statistics on
   - Current `burst-into-immunity` candidate count;
   - Post-change candidate count, grouped by `derivedFrom`;
   - Candidate counts for `INTENT_MIN_CASTS ∈ {1,2,3}` respectively, and false positive counts for "only casting once then swapping".
     Goal: choose a value that squashes false positives to ~0 while recovering the blind spot.
2. **Unit Tests**: One for each of the three scenarios (applied mid-way / covers entire duration and player still attacks / covers entire duration and player swaps),
   plus a negative case for "probing with one cast then swapping is not reported".
3. **No Double Reporting**: The same burst must not produce both `unconverted-burst` and `burst-into-immunity`.
4. Full corpus `npm test --workspace=packages/analysis` + `typecheck` + `eslint`.

---

## Non-Goals

- Do not modify the parser to have `SPELL_MISSED` generate damage records. That would pollute all damage statistics
  (DPS, proportions, meters), the cost far outweighs the benefit, and it violates the semantics of "effectiveAmount equals true damage".
- Do not introduce the concept of "player's current target" (there are no target-change events in the logs, it can only be inferred from casts).
- Do not change `MIN_DEFENSIVE_OVERLAP_S` / `overlapSeconds` rounding — gate rules are recalculated based on current values.
