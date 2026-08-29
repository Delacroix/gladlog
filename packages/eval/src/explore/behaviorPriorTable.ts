/**
 * behaviorPriorTable.ts — aggregates `behaviorPriorScan.ts` scan rows (each
 * one a `DecisionPoint` from the shared crisis predicate,
 * `packages/analysis/src/analysis/crisisDecisionPoints.ts`) into the
 * reference table for `crisis-no-response`.
 *
 * Task 10 / spec §1b (2026-08-29 amendment, after the value gate), further
 * amended same-day ("不管分数线" — the rating line is out entirely): the
 * reference is OUTCOME-based, not rank-based — "died within 10 s" for ALL
 * ranked (pct != null) players, split by whether they responded
 * (`nNoResp`/`death10NoResp` vs `nResp`/`death10Resp`). `top` (the most
 * common answers) is now ALSO computed over the full `nResp` population —
 * there is no rank filter anywhere in this table. `dangerous` (gate 5:
 * dmg2s >= CRISIS_MIN_DMG2S) and `feasible` are applied to every population —
 * a gated point (in CC, locked out, or died in the window) was never a fair
 * test of the player's response, and a sub-floor crossing showed no
 * death-rate gradient at all (measured: <10% dmg2s died 8.8% unresponded vs
 * 7.8% responded — flat; >=10% died 22–23%), so both are excluded from the
 * reference the same way the product's `crisis-no-response` candidate
 * excludes them from an accusation.
 */
import type { DecisionPoint } from "@gladlog/analysis/src/analysis/crisisDecisionPoints";
import { CRISIS_MIN_DMG2S } from "@gladlog/analysis/src/analysis/crisisDecisionPoints";
import { dmgBinOf } from "@gladlog/analysis/src/data/behaviorPrior";

export interface BehaviorPriorRow {
  bracket: string;
  pct: number | null;
  point: DecisionPoint;
}
export interface BehaviorPriorCell {
  /** ALL ranked players (pct != null), feasible && dangerous && !responded */
  nNoResp: number;
  death10NoResp: number;
  /** ALL ranked players, feasible && dangerous && responded — also `top`'s
   * denominator: share of nResp, 2 dp. */
  nResp: number;
  death10Resp: number;
  top: [string, number][];
}
export interface BehaviorPriorTable {
  meta: {
    generatedAt: string;
    corpus: string;
    weeks: string[];
    command: string;
    predicateVersion: number;
  };
  cells: Record<string, BehaviorPriorCell>;
}
const RESPONSE_KEYS = [
  "selfHeal",
  "wall",
  "external",
  "control",
  "kite",
] as const;

export { dmgBinOf };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Transitional (Task 10, spec §1b): older scan rows (v5 jsonl) predate the
 * `dangerous`/`diedWithin10s` fields — treat a missing `dangerous` as
 * `dmg2s >= CRISIS_MIN_DMG2S` and a missing `diedWithin10s` as `false`, so a
 * temp table can be regenerated from existing scan output before the next
 * corpus re-scan lands. */
function isDangerous(p: DecisionPoint): boolean {
  return p.dangerous ?? p.dmg2s >= CRISIS_MIN_DMG2S;
}
function diedWithin10s(p: DecisionPoint): boolean {
  return p.diedWithin10s ?? false;
}

function deathRate(points: DecisionPoint[]): number {
  if (!points.length) return 0;
  return r2(points.filter(diedWithin10s).length / points.length);
}

function cellOf(all: DecisionPoint[]): BehaviorPriorCell {
  const noResp = all.filter((p) => !p.responded);
  const resp = all.filter((p) => p.responded);
  const nResp = resp.length;
  const counts = RESPONSE_KEYS.map(
    (k) => [k, resp.filter((p) => p.responses[k]).length] as const,
  )
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, c]) => [k, nResp ? r2(c / nResp) : 0] as [string, number]);
  return {
    nNoResp: noResp.length,
    death10NoResp: deathRate(noResp),
    nResp,
    death10Resp: deathRate(resp),
    top: counts,
  };
}
export function buildBehaviorPriorTable(
  rows: BehaviorPriorRow[],
  meta: BehaviorPriorTable["meta"],
): BehaviorPriorTable {
  const groups = new Map<string, DecisionPoint[]>();
  for (const r of rows) {
    if (r.pct == null || !r.point.feasible || !isDangerous(r.point)) continue;
    for (const key of [
      `${r.bracket}|healer|${dmgBinOf(r.point.dmg2s)}`,
      `${r.bracket}|healer|*`,
    ])
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r.point);
  }
  const cells: Record<string, BehaviorPriorCell> = {};
  for (const k of [...groups.keys()].sort()) cells[k] = cellOf(groups.get(k)!);
  return { meta, cells };
}
