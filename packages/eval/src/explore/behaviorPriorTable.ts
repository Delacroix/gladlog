/**
 * behaviorPriorTable.ts — aggregates `behaviorPriorScan.ts` scan rows (each
 * one a `DecisionPoint` from the shared crisis predicate,
 * `packages/analysis/src/analysis/crisisDecisionPoints.ts`) into the top-10%
 * reference table: "what do top-ranked healers actually do in this state?"
 *
 * Only top-percentile, feasible decision points enter — a gated point (in CC,
 * locked out, or died in the window) was never a fair test of the player's
 * response, so it is excluded from the reference the same way the product's
 * `crisis-no-response` candidate excludes it from an accusation.
 */
import type { DecisionPoint } from "@gladlog/analysis/src/analysis/crisisDecisionPoints";
import { dmgBinOf } from "@gladlog/analysis/src/data/behaviorPrior";

export interface BehaviorPriorRow {
  bracket: string;
  pct: number | null;
  point: DecisionPoint;
}
export interface BehaviorPriorCell {
  n: number;
  respondRate: number;
  top: [string, number][];
  selfHealMedianPct: number;
}
export interface BehaviorPriorTable {
  meta: {
    generatedAt: string;
    corpus: string;
    weeks: string[];
    command: string;
    predicateVersion: number;
    topPercentile: number;
  };
  cells: Record<string, BehaviorPriorCell>;
}
export const TOP_PERCENTILE = 90;
const RESPONSE_KEYS = [
  "selfHeal",
  "wall",
  "external",
  "control",
  "kite",
] as const;

export { dmgBinOf };
const r2 = (x: number) => Math.round(x * 100) / 100;
function cellOf(points: DecisionPoint[]): BehaviorPriorCell {
  const n = points.length;
  const counts = RESPONSE_KEYS.map(
    (k) => [k, points.filter((p) => p.responses[k]).length] as const,
  )
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, c]) => [k, r2(c / n)] as [string, number]);
  const sh = points
    .filter((p) => p.responses.selfHeal)
    .map((p) => p.selfHealPct)
    .sort((a, b) => a - b);
  return {
    n,
    respondRate: r2(points.filter((p) => p.responded).length / n),
    top: counts,
    selfHealMedianPct: sh.length ? sh[Math.floor(sh.length / 2)]! : 0,
  };
}
export function buildBehaviorPriorTable(
  rows: BehaviorPriorRow[],
  meta: BehaviorPriorTable["meta"],
): BehaviorPriorTable {
  const groups = new Map<string, DecisionPoint[]>();
  for (const r of rows) {
    if (r.pct == null || r.pct < TOP_PERCENTILE || !r.point.feasible) continue;
    for (const key of [
      `${r.bracket}|healer|${dmgBinOf(r.point.dmg2s)}`,
      `${r.bracket}|healer|*`,
    ])
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r.point);
  }
  const cells: Record<string, BehaviorPriorCell> = {};
  for (const [k, v] of [...groups].sort()) cells[k] = cellOf(v);
  return { meta: { ...meta, topPercentile: TOP_PERCENTILE }, cells };
}
