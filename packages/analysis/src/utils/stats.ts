/**
 * Shared predicate for order statistics.
 *
 * **Anywhere that indexes into sorted data for a percentile or median MUST go
 * through toSortedFinite first — do not sort locally.**
 *
 * Origin (2026-07-20, a 50-match healer eval): the `INCOMING DAMAGE BASELINES`
 * table showed p50 > p90 in 11 matches (e.g. MM Hunter `p50 214k | p90 65k`).
 * The root cause was not the percentile algorithm — NaN had leaked into the
 * sample pool: `(a, b) => a - b` returns NaN for NaN, and V8 does not error on
 * such a comparator; it silently leaves a **partially unsorted** array, so
 * indexing into it picks out-of-order samples.
 *
 * This class of bad data is especially insidious: NaN becomes null through
 * JSON.stringify and may not even land on the selected indices, so the output
 * looks like "all normal numbers" — just in the wrong order.
 */

/** Sorts numbers ascending, dropping non-finite values (NaN / ±Infinity).
 *  Does not mutate the input. */
export function toSortedFinite(values: readonly number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  finite.sort((a, b) => a - b);
  return finite;
}

/** Median; returns 0 when there is no finite sample. */
export function medianFinite(values: readonly number[]): number {
  const sorted = toSortedFinite(values);
  if (sorted.length === 0) return 0;
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[half];
  return (sorted[half - 1] + sorted[half]) / 2;
}
