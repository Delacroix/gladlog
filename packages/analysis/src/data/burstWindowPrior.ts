/**
 * Enemy-burst-window reference (corpus-derived, GENERATED json) — GH #60
 * phase 1. "When the enemy opened THIS cooldown in THIS bracket, how often
 * did a friendly die inside the window if the team answered within 8 s, and
 * how often if it did not — and what did the teams that answered actually
 * press?"
 *
 * Keyed `${bracket}|${leadCdSpellId}` with a `${bracket}|*` fallback and a
 * global `*|*` one. Rating is NOT in the key: the crisis-no-response
 * precedent (user ruling 2026-08-29, 「不要用分数界定」) — the reference is an
 * outcome reference, not a skill reference.
 *
 * Regenerate (REQUIRED after any change to analysis/burstWindowDecisionPoints.ts):
 *   npx tsx packages/eval/scripts/burstWindowScan.ts scan … then
 *   npx tsx packages/eval/scripts/burstWindowScan.ts emit-table --in <scan.jsonl> \
 *     --out packages/analysis/src/data/burstWindowPriorGenerated.json
 * (emit-table writes a temp file and copies it in — never redirect `>` into
 * the imported json.)
 *
 * NOT WIRED YET: phase 1 is engine + table + value-gate examples only. No
 * candidate and no prompt builder reads this module; wiring waits on the
 * user's approval of the examples (Value-Gate rule 1).
 */
import { BEHAVIOR_PRIOR_N_FLOOR } from "./behaviorPrior";
import raw from "./burstWindowPriorGenerated.json";

/** Same n floor as the crisis reference — one number for "is this cell big
 * enough to quote", imported rather than re-typed. */
export const BURST_WINDOW_PRIOR_N_FLOOR = BEHAVIOR_PRIOR_N_FLOOR;

interface Cell {
  nResp: number;
  deathResp: number;
  nNoResp: number;
  deathNoResp: number;
  topResponses: [string, number][];
}

const CELLS = (raw as unknown as { cells: Record<string, Cell | undefined> })
  .cells;
export const BURST_WINDOW_PRIOR_META = (
  raw as unknown as { meta: Record<string, unknown> }
).meta;

export interface BurstWindowPriorRef {
  cellKey: string;
  /** true when the lead-CD cell was too small and a fallback cell was used */
  fellBack: boolean;
  nResp: number;
  deathRespPct: number;
  nNoResp: number;
  deathNoRespPct: number;
  topResponses: [string, number][];
}

const pct = (f: number) => Math.round(f * 100);

function wellFormed(c: Cell | undefined): c is Cell {
  return (
    !!c &&
    Number.isFinite(c.nResp) &&
    Number.isFinite(c.deathResp) &&
    Number.isFinite(c.nNoResp) &&
    Number.isFinite(c.deathNoResp) &&
    Array.isArray(c.topResponses)
  );
}

/**
 * Look up the reference for one burst window. Falls back
 * `bracket|spellId` → `bracket|*` → `*|*`, taking the first cell whose
 * NO-RESPONSE population reaches the n floor (that is the population the
 * product would be quoting against a player).
 */
export function lookupBurstWindowPrior(
  bracket: string,
  leadCdSpellId: string,
): BurstWindowPriorRef | null {
  const keys = [`${bracket}|${leadCdSpellId}`, `${bracket}|*`, `*|*`];
  let chosen: { key: string; cell: Cell } | null = null;
  for (const k of keys) {
    const c = CELLS[k];
    if (!wellFormed(c)) continue;
    if (c.nNoResp >= BURST_WINDOW_PRIOR_N_FLOOR) {
      chosen = { key: k, cell: c };
      break;
    }
  }
  if (!chosen) return null;
  return {
    cellKey: chosen.key,
    fellBack: chosen.key !== keys[0],
    nResp: chosen.cell.nResp,
    deathRespPct: pct(chosen.cell.deathResp),
    nNoResp: chosen.cell.nNoResp,
    deathNoRespPct: pct(chosen.cell.deathNoResp),
    topResponses: chosen.cell.topResponses.map(
      ([k, f]) => [k, pct(f)] as [string, number],
    ),
  };
}
