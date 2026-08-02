/**
 * facts number rendering (single-source).
 *
 * The `facts` of both candidate events and deep-dive evidence packs are the
 * **values behind placeholders**: the model writes `{{p1.t}}`, claimChecker
 * compares against the output produced here, and interpolate substitutes it in.
 * So both sides must be character-for-character identical -- there once were
 * two identical implementations, one in candidateFindings.ts and one in
 * deepDive.ts, and changing one always missed the other (CLAUDE.md: export the
 * predicate from one place and import it on both sides).
 *
 * Note this is **not** `fmtTime`. Both render the same physical quantity
 * (seconds into the match) in different forms:
 *  - `fmtFactNum(83.5)` -> `"83.5"`, used in facts / findings and deep-dive body;
 *  - `fmtTime(83.5)`    -> `"1:23"`, used in context blocks like the timeline /
 *    burst ledger.
 * One report therefore carries two scales, a known surface inconsistency
 * (weekly review P2#7). Whether to unify them is a product decision -- it would
 * change prompt text and require an eval round, so do not change it casually.
 */
export const fmtFactNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);
