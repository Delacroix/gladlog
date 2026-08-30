/**
 * Corpus-wide OUTCOME references for candidate types (2026-08-30 outcome
 * probe). Deliberately its own tiny module — the same role
 * `data/behaviorPrior.ts` plays for crisis-no-response, but one flat constant
 * pair per type instead of a cell table, and kept apart from the bigger data
 * modules so parallel branches adding their own reference do not collide.
 *
 * Shared-predicate contract (CLAUDE.md): the candidate producer renders these
 * numbers into `facts`, and packages/eval's promptQualityCheck
 * `checkOutcomeRefConsistency` re-parses the rendered facts and compares them
 * against THIS constant — one source, both sides. Never hand-copy a number
 * out of here into a prompt string, a doc, or the desktop renderer.
 *
 * Provenance: `signal-outcomes-2026-08-30` — the seven-signal outcome probe
 * over 3,000 archived matches
 * (gladlog-eval-private/reports/signal-outcomes-2026-08-30/report.md,
 * §"attempt-into-trinket"). Descriptive contrast only: an attempt opened into
 * a target whose trinket is down is not *proven* to be the cause of the kill.
 */

/**
 * attempt-into-trinket: over `n` = 48,335 kill attempts observed in the probe
 * (the denominator is ALL kill attempts it saw, not just the ones the
 * candidate accuses), split by whether the target's PvP trinket was ready at
 * the moment the attempt started:
 *
 *   · `killPctTrinketDown` = 6.8 % — of the 24,280 attempts opened while the
 *     target's trinket was NOT ready, the target died within 15 s of attempt
 *     start 1,659 times.
 *   · `killPctTrinketUp` = 3.8 % — of the 24,055 attempts opened while the
 *     target's trinket WAS ready, the target died within 15 s of attempt
 *     start 919 times.
 *
 * Both percentages therefore share one outcome definition ("the target died
 * within 15 s of attempt start") and differ only in the trinket-readiness
 * split. The direction (trinket down → higher kill rate) held in every
 * bracket and rating slice of the probe, +2.5 to +4.5 pp.
 */
export const ATTEMPT_INTO_TRINKET_OUTCOME_REF = {
  n: 48335,
  killPctTrinketDown: 6.8,
  killPctTrinketUp: 3.8,
  source: "signal-outcomes-2026-08-30",
} as const;
