/**
 * Shared predicates for time-window linkage (phase four ①) — every window
 * decision comes from here; never hand-roll a comparison inside an individual
 * derive (single-source predicate). Window semantics:
 *  - instantaneous events (damage/heal/absorb/cast): counted when
 *    timestamp ∈ [from, to];
 *  - duration facts (CC segments): counted by the seconds overlapping the
 *    window (one that straddles the edge neither vanishes nor counts whole);
 *  - rate denominators: the window's duration, not the match's.
 */

export interface TimeRange {
  fromS: number;
  toS: number;
}

export const rangeDurationS = (
  m: { startTime: number; endTime: number },
  range?: TimeRange | null,
): number =>
  range
    ? Math.max(1e-6, range.toS - range.fromS)
    : Math.max(1e-6, (m.endTime - m.startTime) / 1000);

/** Filter predicate for instantaneous events; always true when range is empty.
 * Events without a timestamp are counted (every parser event carries one, so
 * this branch is purely defensive — better a slightly wide window than
 * silently dropping a whole category). */
export const eventInRange = (
  m: { startTime: number },
  range?: TimeRange | null,
): ((e: { timestamp?: number }) => boolean) => {
  if (!range) return () => true;
  const fromMs = m.startTime + range.fromS * 1000;
  const toMs = m.startTime + range.toS * 1000;
  return (e) =>
    e.timestamp === undefined || (e.timestamp >= fromMs && e.timestamp <= toMs);
};

/** Whether a relative-second instant falls inside the window (used for
 * fact-level filtering). */
export const tInRange = (tS: number, range?: TimeRange | null): boolean =>
  !range || (tS >= range.fromS && tS <= range.toS);

/** Seconds a duration fact overlaps the window (empty range = full length). */
export const overlapSeconds = (
  fromS: number,
  durationS: number,
  range?: TimeRange | null,
): number => {
  if (!range) return durationS;
  const from = Math.max(fromS, range.fromS);
  const to = Math.min(fromS + durationS, range.toS);
  return Math.max(0, to - from);
};
