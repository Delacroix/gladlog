/** Cache keyed on the first argument (Map's SameValueZero semantics, equivalent
 * to lodash MapCache) — the bundle used to pull in 215KB of CJS lodash for just
 * 4 functions; this is the stand-in for its memoize.
 *
 * With a readiness gate: the data tables load in the background (see the design
 * notes in data/spellEffectData.ts), so calls made before loading completes can
 * only produce empty-table degraded results — those results are **computed but
 * never cached**, because once cached they would persist forever and the real
 * values would never be seen after loading finishes (memoize stuck on an empty
 * result). */
export function memoizeWhenReady<A, R>(
  isReady: () => boolean,
  fn: (arg: A) => R,
): (arg: A) => R {
  const cache = new Map<A, R>();
  return (arg: A) => {
    if (!isReady()) return fn(arg);
    if (cache.has(arg)) return cache.get(arg)!;
    const r = fn(arg);
    cache.set(arg, r);
    return r;
  };
}
