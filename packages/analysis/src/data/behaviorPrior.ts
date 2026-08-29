/**
 * Behavior-prior reference (corpus-derived, GENERATED json): what top-10%
 * healers actually do at a crisis decision point, per bracket × damage bin.
 * Consumed by candidates/crisisNoResponse.ts (the rendered reference) AND by
 * packages/eval promptQualityCheck's checkBehaviorPriorConsistency (the gate
 * that re-parses the rendered numbers) — one lookup, both sides.
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
interface Cell {
  n: number;
  respondRate: number;
  top: [string, number][];
  selfHealMedianPct: number;
}
const CELLS = (raw as unknown as { cells: Record<string, Cell> }).cells;
export const BEHAVIOR_PRIOR_META = (
  raw as unknown as { meta: Record<string, unknown> }
).meta;

export interface BehaviorPriorRef {
  cellKey: string;
  n: number;
  respondPct: number;
  top: [string, number][];
  selfHealMedianPct: number;
  fellBack: boolean;
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
  const cell = fine && fine.n >= BEHAVIOR_PRIOR_N_FLOOR ? fine : CELLS[starKey];
  if (!cell) return null;
  const fellBack = cell !== fine;
  return {
    cellKey: fellBack ? starKey : fineKey,
    n: cell.n,
    respondPct: pct(cell.respondRate),
    top: cell.top.map(([k, f]) => [k, pct(f)] as [string, number]),
    selfHealMedianPct: cell.selfHealMedianPct,
    fellBack,
  };
}
