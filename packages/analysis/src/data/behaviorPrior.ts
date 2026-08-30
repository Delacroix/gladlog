/**
 * Behavior-prior reference (corpus-derived, GENERATED json): outcome-based
 * reference for a crisis decision point, per bracket × damage bin (Task 10 /
 * spec §1b, 2026-08-29 amendment). Consumed by candidates/crisisNoResponse.ts
 * (the rendered reference) AND by packages/eval promptQualityCheck's
 * checkBehaviorPriorConsistency (the gate that re-parses the rendered
 * numbers) — one lookup, both sides.
 *
 * Regenerate (spec §3; REQUIRED after any change to crisisDecisionPoints.ts):
 *   npx tsx packages/eval/scripts/behaviorPriorScan.ts scan … && emit-table …
 *   > packages/analysis/src/data/behaviorPriorGenerated.json
 * Runbook: docs/commands/update-wow-data.md step 6b-pre-2.
 */
import raw from "./behaviorPriorGenerated.json";

export const BEHAVIOR_PRIOR_N_FLOOR = 50;
export type DmgBin = "<10%" | "10-20%" | ">=20%";
export function dmgBinOf(dmg2s: number): DmgBin {
  return dmg2s < 0.1 ? "<10%" : dmg2s < 0.2 ? "10-20%" : ">=20%";
}
/** Which death predicate a cell's death rates were computed under (spec
 * §1c): `ownDeath10s` = the owner's own death within 10 s;
 * `teamDeath15s` = ANY friendly player's death within 15 s (Rated Solo
 * Shuffle — a healer diving to 40% there usually isn't the kill target, the
 * cost lands on a teammate instead). Exported for
 * packages/eval/src/explore/behaviorPriorTable.ts (the table builder) to
 * import — one type, not two kept in sync by convention. */
export type BehaviorPriorOutcome = "ownDeath10s" | "teamDeath15s";
function isValidOutcome(v: unknown): v is BehaviorPriorOutcome {
  return v === "ownDeath10s" || v === "teamDeath15s";
}
interface Cell {
  nNoResp: number;
  deathNoResp: number;
  nResp: number;
  deathResp: number;
  top: [string, number][];
  outcome: BehaviorPriorOutcome;
}
// I5: a cell key existing in the JSON is not proof the cell itself is well
// formed — index access can still miss (unknown key) or hit a malformed
// entry, so the static type admits both.
const CELLS = (raw as unknown as { cells: Record<string, Cell | undefined> })
  .cells;
export const BEHAVIOR_PRIOR_META = (
  raw as unknown as { meta: Record<string, unknown> }
).meta;

export interface BehaviorPriorRef {
  cellKey: string;
  fellBack: boolean;
  /** ALL ranked players who did NOT respond, and their 10s death rate (int %) */
  nNoResp: number;
  deathNoRespPct: number;
  /** ALL ranked players who DID respond, and their 10s death rate (int %) */
  nResp: number;
  deathRespPct: number;
  /** among healers who DID respond, the most common answers, shares as int %
   * (no rank filter — the rating line is out entirely, 2026-08-29 amendment) */
  top: [string, number][];
  /** which death predicate deathNoRespPct/deathRespPct were computed under
   * (spec §1c) */
  outcome: BehaviorPriorOutcome;
}
const pct = (f: number) => Math.round(f * 100);

export function lookupBehaviorPrior(
  bracket: string,
  role: "healer",
  dmg2s: number,
): BehaviorPriorRef | null {
  const fineKey = `${bracket}|${role}|${dmgBinOf(dmg2s)}`;
  const starKey = `${bracket}|${role}|*`;
  const fine = CELLS[fineKey];
  const cell =
    fine && fine.nNoResp >= BEHAVIOR_PRIOR_N_FLOOR ? fine : CELLS[starKey];
  if (!cell) return null;
  // I5: a malformed cell (non-finite counts, or a missing/invalid `outcome`
  // — spec §1c) must fail closed, not render NaN/Infinity/undefined into the
  // prompt.
  if (
    !Number.isFinite(cell.nNoResp) ||
    !Number.isFinite(cell.deathNoResp) ||
    !Number.isFinite(cell.nResp) ||
    !Number.isFinite(cell.deathResp) ||
    !isValidOutcome(cell.outcome)
  )
    return null;
  const fellBack = cell !== fine;
  return {
    cellKey: fellBack ? starKey : fineKey,
    fellBack,
    nNoResp: cell.nNoResp,
    deathNoRespPct: pct(cell.deathNoResp),
    nResp: cell.nResp,
    deathRespPct: pct(cell.deathResp),
    top: cell.top.map(([k, f]) => [k, pct(f)] as [string, number]),
    outcome: cell.outcome,
  };
}
