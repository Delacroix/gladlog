# Defensive Counterfactual 17a+17b (Merged Cycle) Design

2026-07-30 · Origin: Bilibili warrior thread "I don't know if Spell Reflection's 20% is enough" + "You can't just judge that my Overpower was fine". Foundations are fully in place (School coverage 100% / DR table officialized / MITIGATION_TABLE 28 keys); for feasibility quantification see `docs/reports/2026-07-30-counterfactual-feasibility.md` — the original "usable but unpressed" primary form was overturned (5.6% opening rate), pivot is approved. 17c (timeline rearrangement) is deferred, not in this cycle.

## Decision Record (All User Approved)

1. **Slicing**: 17a+17b merged into one cycle (user approved, overturning the phased suggestion);
2. **17b Form**: A. Accounting of submitted defensive effects as primary (33.2% opening rate) + B. Teammate external usable but not given as secondary (23.0%) + Original "self usable but unpressed" downgraded to narrow gate (1.3%, almost certainly true);
3. **Mechanic class does not expand table**: High-frequency off-table skills like Blessing of Sacrifice (transfer) / Touch of Karma (reflect) will not have pct modeled this cycle; if form A encounters them, label truthfully "Special mechanic, does not participate in gap arithmetic";
4. **Output Surface**: 17b = Deterministic display on Death Recap card + [DEATH] prompt facts dual surface (same arithmetic, single source predicate); 17a = New candidate `questionable-external` + MISTAKE_RULES dual registration;
5. **Darkness positional does not enter 17b arithmetic** (Conditional checks are not modeled this cycle, keep comment for record).

## 17a: Unnecessary External Determination

### Criteria (All using existing predicates, zero new computation)

For each cast of the 14 whitelist externals (`externalDefensiveSpellIds`), if it simultaneously satisfies:

- **No Burst Alignment**: The cast time is not within any aligned burst window, and not within the PRE_WALL_SECONDS front window / LATE_WINDOW_SECONDS rear window (i.e., further subdividing the part that missed all existing 5 tiers and fell into Unknown);
- **No Damage Spike**: The damage curve for TIMING_DAMAGE_WINDOW_S around the cast has no Reactive level signal (reusing the reverse of the existing Reactive criteria);
- **Beneficiary Target High HP**: Target HP ≥ threshold at cast time (HP sampling uses `HP_SAMPLE_RADIUS_MS` single source; threshold determined by corpus empirics, a priori candidate 80%);

→ `annotateDefensiveTimings` marks a 6th tier **`Unnecessary`** (timingContext carries the three reasons).

### Landing Chain

`Unnecessary` cast → New candidate `questionable-external` (facts: t/spell/caster/target/targetHp/distance to nearest burst window, all rendered in fmtTime grid) → MISTAKE_RULES new entry (anti-corruption test forced registration) → Naturally citeable in AI findings menu.

### Whitelist Discipline (Pre-implementation)

Corpus empirical occurrence rate (arenacoach first batch same process, full db fixed seed): If occurrence rate ≈ 0 (criteria too strict, no signal) or > 50% (too loose, noise), stop and report back to tune thresholds; do not ship with disease.

## 17b-A (Primary): Submitted Defensive Effect Accounting

### Arithmetic

Whitelist defensives active on the deceased within the death window (10s before death, same basis as quantification report) (aura applied→removed interval overlaps with window, `buildAuraIntervals` single source predicate):

- **Arithmetic-capable Entries** (Hits MITIGATION_TABLE and non-positional, covers 71%):
  Amount Blocked = Total observed damage hitting schoolMask within (active interval ∩ window) × pct/(100−pct) — The observed value is post-discount, back-calculating the pre-discount blocked portion;
- **Immunity Entries** (pct=100): Do not back-calculate (division by zero), output truthfully "Immunity covered X.Xs, damage taken during this time 0";
- **Mechanic / Off-table Entries**: Truthfully label "Special mechanic (transfer/reflect), does not participate in gap arithmetic", do not invent numbers;
- **Gap** = Absolute HP at window start (i.e., net HP loss, healing is naturally factored in — same basis as quantification report);
  Output "<Skill> blocked X (≈N% max HP); window gap Y".

### Semantic Boundaries

Only state factual amounts (how much was blocked / what the gap is), **do not** make extrapolations like "if its pct were higher, they would have lived" (that is for 17c/future); multiple defensives in the same window will not have their stacking interactions modeled; calculate each independently and annotate "Independent basis, same-window stacking not modeled".

## 17b-B (Secondary): Teammate External Usable But Not Given

### Two Prerequisite Fixes (Discovered during quantification, blocking B's correctness)

1. **Whitelist Convergence**: `buildDeathOutcomeSummary`'s internal 7-item external list converges to `externalDefensiveSpellIds` 14 items (cascading whitelist rot fix; corpus before/after metrics: missedExternals occurrence rate under 7-item vs 14-item scope);
2. **Verify and Fix zoneId Shape Bug**: `deathRecap.ts` constructs `combatLike` setting only `startInfo.zoneId` while consumers read top-level `zoneId` → production path external LoS filtering was likely always passing through. Reproduce first to confirm, provide before/after numbers under same criteria after fix (change in missedExternals count before/after LoS filtering takes effect).

### Arithmetic

For each missedExternal (arithmetic-capable, 80% coverage): Amount Saved = damage matching external's schoolMask in window × pct% → 3-tier evaluation; **only "Clearly Survives" speaks up**, others remain silent (marginal/still dead not shown — honesty ethics: do not assert what is uncertain).

## 17b-Narrow Gate: Self Usable But Unpressed

Productize quantification script framework (candidates = `extractMajorCooldowns` × `cdAvailableAt` × non-positional in table, CC lockout filtering uses `wasLockedOutThroughWindow`); same 3-tier gate, only "Clearly Survives" speaks up. Honestly accept known limitations: candidate pool has class bias (extractMajorCooldowns filters out zero-cast spells), speaks up in ~1.3% of cases but almost certainly true.

## Three-Tier Predicate (Single Source)

```
Clearly Survives: Amount Saved > Net HP Loss + 15% maxHp
Marginal:         Amount Saved ∈ (0.5 × Net HP Loss, Clearly Survives threshold]
Still Dies:        All others
```

Single export (`counterfactualTiers`), matching quantification report scope; shared across Death Recap card, prompt facts, B/narrow gate. CC lockout deaths (5.2%) do not speak up overall.

## Output Surfaces

- **Death Recap Card** (`DeathRecapCard`): Accounting rows from A (one row per active mitigation: blocked X / N% maxHp; truthful representations for immunities/mechanics) + "Clearly Survives" rows from B/narrow gate (if triggered); all deterministic numbers, bypasses LLM;
- **[DEATH] Prompt Facts**: Same arithmetic results enter [DEATH] block as facts (fmtTime render grid, gatekeeping predicates as spec — facts values floored before entering text); possibility framing ("If X were stacked in the same window, this damage segment would be roughly reduced below the lethal threshold"), compatible with causalLint causal claim prohibition without modifying gates.

## Boundaries (Deliberately Out of Scope)

- 17c timeline rearrangement enumeration; mechanic expansion to table; positional checks (Darkness does not enter arithmetic);
- "Higher pct would survive" parameter extrapolation; multi-mitigation stacking interaction modeling;
- Behavioral counterfactuals such as healer behavior change / enemy target switching (arithmetically feasible, simulation infeasible — original backlog quote, relies on 3 tiers to convey confidence);
- Cross-match aggregation.

## Testing and Verification

- Pure arithmetic unit tests: reverse deduction formula (`observed × pct / (100 - pct)`), division-by-zero protection for immunities, schoolMask filtering, mechanic skips, multi-entry independent scopes;
- Consistency assertions between 3-tier predicate and quantification report (same synthetic inputs produce same verdicts on both sides);
- 17a: Unnecessary tier determination unit tests (three conditions independently veto) + corpus empirical occurrence rate (pre-implementation prerequisite) + MISTAKE_RULES registration anti-corruption;
- B prerequisite fixes: whitelist convergence and zoneId fix each provide before/after corpus numbers;
- Prompt facts are a new surface: real model smoke test after landing (lesson from deep dive, unit tests have blind spots for placeholder discipline);
- Presubmit before push; Death Recap card changes → visual baseline CI update.

## Risks

| Risk | Mitigation |
| --- | --- |
| Reverse deduction formula overestimation due to absorb/armor mix | Output wording labeled "Deducted from table values"; sanity direction verified (PS 3/3 in same direction); do not pursue precision |
| Arbitrary 17a thresholds | Pre-implementation corpus empirical check, stop if occurrence rate is abnormal |
| zoneId bug fix changes missedExternals surface | Before/after numbers + regression anchor for existing deathRecap tests |
| Prompt facts introduces new audit surface | Facts are all deterministic numbers, follow existing placeholder discipline; closed out with real model smoke test |
