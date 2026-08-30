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

/**
 * Render-grid-safe time fact (CLAUDE.md Shared-Predicate Rule, kick-eaten
 * render-grid fix, 2026-08-30): for `t`-type facts that are printed alongside
 * -- and must agree with -- a `fmtTime`-rendered timeline marker for the same
 * instant (`[KICK]`, `[DEATH]`, `[UNCLEANSED DEBUFF]`, …).
 *
 * `fmtFactNum` rounds to one decimal (`toFixed(1)`); `fmtTime` floors to the
 * whole second. Those two rules silently disagree whenever the raw value's
 * fractional part lands in the last twentieth of a second: `fmtFactNum(9.96)`
 * -> `"10.0"` (rounds up into the NEXT second) while `fmtTime(9.96)` ->
 * `"0:09"` (floors into the second still in progress) -- so a menu line reads
 * `t=10.0s` right next to a `[KICK]` timeline entry timestamped `0:09`, and a
 * reader (human or model) sees a contradiction between two renderings of one
 * instant. Measured on the 2026-08-30 A/B corpus: 20/209 kick-eaten lines
 * (9.6%) hit exactly this, always an x.95-x.99 raw value rounding up.
 *
 * `fmtFactTime` truncates to one decimal instead of rounding
 * (`Math.floor(n*10)/10`), which guarantees `Math.floor(parseFloat(result))
 * === Math.floor(n)` -- i.e. it always floors onto the SAME whole-second grid
 * `fmtTime` uses (`toRenderSecond` in `../utils/renderGrid`), just rendered at
 * one-decimal precision instead of `fmtTime`'s `m:ss`. Use this instead of
 * `fmtFactNum` for any time fact that is compared, in the rendered prompt
 * text, against a `fmtTime`-floored timeline marker -- not for other decimal
 * facts (duration, damage, …), which are not render-grid quantities and stay
 * on `fmtFactNum`.
 */
export const fmtFactTime = (seconds: number): string =>
  fmtFactNum(Math.floor(seconds * 10) / 10);
