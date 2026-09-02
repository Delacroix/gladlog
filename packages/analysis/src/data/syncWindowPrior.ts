/**
 * Sync-window reference (corpus-derived, GENERATED json) — the GH #13
 * resurrection (2026-09-02, user-approved redesign). "In THIS bracket, when
 * an eligible enemy-healer hard-CC window opened, how often did an enemy die
 * within 15 s if a friendly canonical offensive CD entered the window, and
 * how often if none did?"
 *
 * Keyed by bracket only (no spell key: the window's CC spell is not the
 * decision — the press is). Rating is NOT in the key (crisis-no-response
 * precedent, user ruling 2026-08-29 「不要用分数界定」).
 *
 * History: `missed-sync-window` was retired 2026-08-19 (GH #13) on the
 * win/loss axis (occurrence −4.4pp "fires more when winning", conversion
 * flat 26.7% vs 27.8%). The 2026-09-02 resurrection ruling rests on two
 * different axes measured by signalOutcomeProbe + syncWindowScan: kill
 * conversion per window (3v3 entered 17.8% vs unentered 7.6%) and the rank
 * gradient on the behaviour itself (pct>=90 enter 23.0% vs pct<30 16.2%).
 * The pooled corpus is 76% Solo Shuffle, whose contrast is flat — the
 * per-bracket door below is what keeps the resurrected type from refiring
 * exactly the flood #13 documented.
 *
 * Regenerate (REQUIRED after any change to the eligibility predicate in
 * candidates/cooldownTiming.ts's missedSyncWindowEvents):
 *   npx tsx packages/eval/scripts/syncWindowScan.ts scan …
 *   npx tsx packages/eval/scripts/syncWindowScan.ts emit-table --in <scan.jsonl> \
 *     > /tmp/table.json && cp /tmp/table.json packages/analysis/src/data/syncWindowPriorGenerated.json
 * (temp-then-cp — never `>` directly into the imported json.)
 */
import { BEHAVIOR_PRIOR_N_FLOOR } from "./behaviorPrior";
import raw from "./syncWindowPriorGenerated.json";

/** Same n floor as the crisis/burst references — imported, never re-typed. */
export const SYNC_WINDOW_PRIOR_N_FLOOR = BEHAVIOR_PRIOR_N_FLOOR;

/**
 * Minimum contrast door, same construction as burstWindowPrior's
 * `BURST_REF_MIN_CONTRAST_PP` (approved tightener, 2026-09-01): a bracket
 * whose entered/unentered kill contrast is under this floor produces NO
 * candidates at all — quoting a flat reference argues against the sentence
 * quoting it. On the probe's numbers this is the mechanism that keeps Rated
 * Solo Shuffle (+0.7pp) silent while 3v3 (+10.2pp) and 2v2 (+3.6pp) speak,
 * without hand-coding a bracket list.
 *
 * Anchored on the RENDERED integers (`killEnteredPct`/`killUnenteredPct`,
 * both already Math.rounded here) so the producer and the gate compare the
 * same two numbers (CLAUDE.md shared-predicate rule).
 */
export const SYNC_REF_MIN_CONTRAST_PP = 3;

export interface SyncWindowPriorRef {
  cellKey: string;
  nEntered: number;
  killEnteredPct: number;
  nUnentered: number;
  killUnenteredPct: number;
}

/** The rendered contrast of a reference cell, in percentage points. */
export function syncRefContrastPp(
  ref: Pick<SyncWindowPriorRef, "killEnteredPct" | "killUnenteredPct">,
): number {
  return ref.killEnteredPct - ref.killUnenteredPct;
}

/** The door itself — the one predicate. `missedSyncWindowEvents` calls it to
 * decide whether the bracket accuses at all; `checkSyncWindowRefConsistency`
 * calls it on the numbers it re-parsed out of the rendered line. */
export function syncRefClearsMinContrast(
  ref: Pick<SyncWindowPriorRef, "killEnteredPct" | "killUnenteredPct">,
): boolean {
  return syncRefContrastPp(ref) >= SYNC_REF_MIN_CONTRAST_PP;
}

interface Cell {
  nEntered: number;
  killEntered: number;
  nUnentered: number;
  killUnentered: number;
}

const CELLS = (raw as unknown as { cells: Record<string, Cell | undefined> })
  .cells;
export const SYNC_WINDOW_PRIOR_META = (
  raw as unknown as { meta: Record<string, unknown> }
).meta;

const pct = (f: number) => Math.round(f * 100);

function wellFormed(c: Cell | undefined): c is Cell {
  return (
    !!c &&
    Number.isFinite(c.nEntered) &&
    Number.isFinite(c.killEntered) &&
    Number.isFinite(c.nUnentered) &&
    Number.isFinite(c.killUnentered)
  );
}

/**
 * Look up the reference for one bracket. No fallback chain: an unlisted or
 * under-floor bracket returns null and the type stays silent there — the
 * whole point of the resurrection design. Both arms must reach the n floor
 * (the entered arm is the population the sentence holds up as the example).
 */
export function lookupSyncWindowPrior(
  bracket: string,
): SyncWindowPriorRef | null {
  const c = CELLS[bracket];
  if (!wellFormed(c)) return null;
  if (
    c.nEntered < SYNC_WINDOW_PRIOR_N_FLOOR ||
    c.nUnentered < SYNC_WINDOW_PRIOR_N_FLOOR
  )
    return null;
  return {
    cellKey: bracket,
    nEntered: c.nEntered,
    killEnteredPct: pct(c.killEntered),
    nUnentered: c.nUnentered,
    killUnenteredPct: pct(c.killUnentered),
  };
}
