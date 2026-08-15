# Candidate Menu Signal Expansion Batch 1 (HEAL / POSITION / COOLDOWN + Dispel Dimension Upgrade) Design

Date: 2026-08-07 · Background: Healer-perspective menu dispel/trinket 4 categories accounted for 64% (#22 temporary frequency suppression only brought it down to 58.6%; fundamental cure = expansion); BACKLOG #18 Batch 2. Empirical incidence rates (200 matches / 899 sources, report `signal-rates-report.md`, script tmp-signal-rates.mts deleted after review) conducted first; numbers shown below.

## Three New Candidate Types + One Field Dimension Upgrade

| Candidate | Predicate (All Existing Predicates) | Empirical | Threshold / Cap | facts |
| --- | --- | --- | --- | --- |
| `healing-gap` (HEAL-001) | `detectHealingGaps`; owner is healer; `freeCastSeconds ≥ HEAL_GAP_FREE_MIN_S(4)` and `mostDamagedAmount > 0` | 5.3% rounds, 54 entries | cap 2 (descending by mostDamagedAmount) | t (fromSeconds floor), durationS, freeS, pressured (short name), pressuredSpec |
| `position-mistake` (POSITION-001) | `computeOwnerPositionEvents`; STAYED_IN requires `stayedInHadRealCost`; accepts all three kinds (MISSED_PUSH / CD_OUT_OF_RANGE currently 0 in healer corpus, targeted at future DPS owners) | 10.9% rounds, 118 entries | cap 2 (ascending by hpMin = heaviest loss) | t, kind (positioning event type), enemy?, hpStart?, hpMin?, spell?, dist? —— same field names as deepDive `position` item facts (single-source rendering convention) |
| `cc-held` (COOLDOWN-001) | owner's major CC cooldown (`ccSpellIds` ∩ `extractMajorCooldowns`) `availableWindows` continuously available `≥ CC_HELD_MIN_S(90)` | ≥90s 25.3% rounds, 259 entries (60s bracket has high false positive risk, discarded) | cap 2 (descending by window duration) | t (window start), spell, heldS, windowEndT |
| missed-cleanse upgrade (DISPEL-002) | Existing candidate adds `latencySeconds` (interval between CC landed → cleansed; empirical late cleanses account for only 7.1% of cleanses, not worth a new type) | 69 late cleanses | No new type added, cap unchanged | Existing facts + latencyS (only when present) |

- The three new types together are expected to account for **8–12%** of the menu (interim goal accepted; original 15–25% target relies on remaining candidates in #18).
- Coachable signal gate spirit: Threshold constants centrally declared, tunable at a single point; POSITION tri-state discipline (no position data produces zero output, never treated as 0); cc-held naturally produces zero output for owners without major CC cooldowns in their kit (present in 845/898 rounds).
- prompt: `buildFindingsPrompt` adds legend lines for the three new types (matching existing type prose; cc-held legend must guard against "causal assertion" phrasing — "unused for a long time" is fact, "lost because of this" is forbidden).
- `PROMPT_VERSION` routine +1 increment.
- **#22 is not reverted with this batch**: Share reduction insufficient to prevent regression, updated note: "To be evaluated after wave 2 (DEATH-002 / OFFENSIVE types)".

## Acceptance

- Unit tests: Per-type threshold boundaries / sorting preserving heaviest / cap; POSITION produces zero output on rounds without data; cc-held produces zero output without kit; upgraded field appears only when value is present.
- Corpus rescan (same 200 matches criterion): Entry counts for three new types match empirical data (54 / 118 / 259 ± threshold effects); dispel/trinket 4-category share changes faithfully recorded (expected 58.6% → ~52%).
- Presubmit all green; incidence report archived in the same directory as this spec without committing (.superpowers gitignored), key numbers already transcribed into table above.
