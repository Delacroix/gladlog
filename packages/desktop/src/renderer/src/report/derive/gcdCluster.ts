import { OFF_GCD_SPELL_IDS } from "@gladlog/analysis";

import type { CastRow } from "./casts";

/**
 * GCD lane clustering (user design, 2026-07-25): several casts within the same
 * time window collapse into one row — the primary chip is the window's first
 * ON-GCD cast (the "what did this beat do" that occupies the GCD), while
 * off-GCD actives (trinkets, interrupts, racials — official SpellCooldowns
 * StartRecoveryTime == 0, offGcdGenerated) and any later casts crowded into
 * the same window collapse into mini icons.
 * The row is anchored at the real timestamp of the window's first cast:
 * vertical drift is capped by the window width (<= windowS).
 */
export interface GcdCluster {
  /** Row anchor = timestamp of the window's first cast (absolute ms). */
  t: number;
  primary: CastRow;
  minis: CastRow[];
}

export function clusterGcdCasts(
  casts: CastRow[],
  windowMs: number,
): GcdCluster[] {
  const out: GcdCluster[] = [];
  let cur: CastRow[] = [];
  let curStart = -Infinity;
  const flush = () => {
    if (cur.length === 0) return;
    const primary =
      cur.find((c) => !OFF_GCD_SPELL_IDS.has(String(c.spellId))) ?? cur[0]!;
    out.push({
      t: cur[0]!.t,
      primary,
      minis: cur.filter((c) => c !== primary),
    });
    cur = [];
  };
  for (const c of casts) {
    if (c.t >= curStart + windowMs) {
      flush();
      curStart = c.t;
    }
    cur.push(c);
  }
  flush();
  return out;
}
