/**
 * The prompt's render grid — the single source for how an instant becomes text
 * and which instant a rendered value must be sampled at.
 *
 * Extracted from `cooldowns.ts` on 2026-08-16. These three functions have
 * nothing to do with cooldowns; they lived there for historical reasons, which
 * meant that anything needing to print a timestamp had to import a 2,258-line
 * cooldown module (fan-in 35 of 114 files in this package). The companion
 * regression guard `renderGrid.test.ts` already carried this module's name
 * before the module existed.
 *
 * Deliberately NOT moved here: `HP_SAMPLE_RADIUS_MS`. That constant is a data
 * freshness tolerance (how far from an instant we will accept a sample), not a
 * text-formatting rule; it stays next to the sampling logic in `cooldowns.ts`.
 *
 * This module must stay dependency-free — every layer imports it.
 */

/** Format seconds as m:ss string */
export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Snaps an arbitrary instant onto the **prompt's render grid** (whole seconds) —
 * the same rounding rule fmtTime uses.
 *
 * **Any sample that will be rendered together with a timestamp must go through
 * this function before the value is looked up.**
 *
 * Measured on 2026-07-20 (class A, 26/50 matches): `[STATE]` sampled on
 * whole-second ticks while `[DMG SPIKE]` sampled at `pw.fromSeconds` (fractional
 * seconds), yet both were rendered through fmtTime into the **same displayed
 * second** — so two HP numbers under one timestamp contradicted each other
 * (median 7pp, max 25pp). Note: this is NOT a sampling-radius problem —
 * getUnitHpAtTimestamp picks the nearest sample first and only then uses the
 * radius to accept or reject it, so changing the radius can only turn the value
 * into null, it **never changes the value**. The only way to make both sides
 * agree is to make them query the same instant.
 *
 * See CLAUDE.md, "a gate predicate IS the spec": fractional seconds inside the
 * analysis must be floored onto the render grid before any decision that will be
 * rendered or recomputed by a gate.
 */
export function toRenderSecond(seconds: number): number {
  return Math.floor(seconds);
}

/**
 * The width (in seconds) a time window **appears to have** in the prompt.
 *
 * Windows are generally rendered as `fmtTime(from)–fmtTime(to) (Ns)`. If N is
 * taken from the raw `toSeconds - fromSeconds` and then rounded, a reader
 * subtracting the displayed endpoints gets a different number (e.g.
 * `0:10–0:20 (9s)`) — classes E/G of the 2026-07-20 eval, "window duration
 * doesn't add up". The width must be derived from the **displayed** endpoints
 * for the rendered text to be self-consistent.
 */
export function renderedWindowSeconds(
  fromSeconds: number,
  toSeconds: number,
): number {
  return Math.max(0, toRenderSecond(toSeconds) - toRenderSecond(fromSeconds));
}
