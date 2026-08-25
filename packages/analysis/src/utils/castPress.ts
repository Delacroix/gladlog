/**
 * castPress.ts — "one press ≠ one SPELL_CAST_SUCCESS" (BACKLOG #36(a)).
 *
 * Three record shapes inflate every per-spellId press counter
 * (`extractRotations`, the corpus reference_vectors, the cooldown ledger's
 * cast lists, prompt cast lines):
 *
 *   1. Echo copies / set procs — a cast that only ever fires alongside the
 *      real press (research: 1265980 Twin Flames is 100% same-instant with
 *      Disintegrate; 360995 Verdant Embrace echo 86% same-instant with
 *      361195). Without the cut a Preservation Evoker's per-round cast count
 *      nearly doubles.
 *   2. Channel ticks under their own cast id — Divine Hymn ticks (64844)
 *      arrive at 1.00s spacing, 5–6 per round, inflating the "press" count
 *      5× (18,504 → 3,583 real presses corpus-wide); the press is 64843.
 *   3. The same press recorded twice at the SAME instant — Power Infusion on
 *      an ally logs "on ally" + "on self" 0.00s apart (n=90,269).
 *
 * ⚠ Threshold discipline (research, three failed statistical attempts before
 * a player's spoken walkthrough settled it):
 *   - the tick gap must NOT be loosened to 1.4s — real filler casts (Wrath,
 *     Supplication) sit exactly there;
 *   - low standalone-occurrence alone is NOT a verdict — Chain Heal (0.8%)
 *     and Divine Hymn (0.0%) are real presses that always coincide with
 *     something; the copy list requires "single companion" + manual reading.
 *   - exact-instant dedupe is safe against real double presses: at GCD floor
 *     (~0.75–1s under haste) two genuine presses land ~900ms apart, never at
 *     the identical millisecond (verified: 40 archive files, 405 Rejuvenation
 *     casts, zero same-instant pairs).
 */

/** Cast ids that are copies/procs/ticks of another press, never a press of
 * their own. Ported from the research registry (healer-study/copy_ids.json)
 * with its per-id evidence; registered in curatedIdRegistry so the corpus rot
 * scans watch it. */
export const COPY_CAST_IDS: ReadonlyMap<string, string> = new Map([
  ["360995", "Verdant Embrace echo (86% same-instant with 361195)"],
  ["355941", "Dream Breath echo copy"],
  ["361509", "Living Flame proc copy (75% same-instant with Chrono Flames)"],
  ["1265980", "Twin Flames set proc (100% same-instant with Disintegrate)"],
  ["1265991", "Twin Flames set proc (0.1% standalone)"],
  ["157982", "Tranquility channel tick (0.80s spacing; the press is 740)"],
  ["64844", "Divine Hymn channel tick (1.00s spacing; the press is 64843)"],
  ["450215", "Void Blast channel tick (1.00s spacing)"],
]);

/** Same-spellId events closer than this are ticks of one channel, not two
 * presses. 1.05s clears the observed tick spacings (0.80–1.00s) while staying
 * under the 1.4s cadence of real filler spam — do not loosen. */
export const CHANNEL_TICK_MAX_GAP_S = 1.05;

/**
 * Reduce a SPELL_CAST_SUCCESS list to actual button presses:
 * drop copy ids, collapse identical-instant duplicates, and collapse
 * same-spell runs at tick spacing to their first event. Input order is
 * preserved for the surviving events.
 */
export function filterRealPresses<
  T extends { spellId?: string; logLine: { timestamp: number } },
>(events: T[]): T[] {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.logLine.timestamp - b.e.logLine.timestamp || a.i - b.i);
  const keep = new Set<number>();
  // Chain anchor per spellId: the timestamp of the PREVIOUS event, kept or
  // dropped. A tick run is contiguous sub-threshold gaps between successive
  // events — anchoring only on kept events would re-admit every other tick of
  // a 1s-spaced channel (1s, 2s, 3s: gap-to-kept alternates 1s/2s).
  const prevEventBySpell = new Map<string, number>();
  for (const { e, i } of sorted) {
    const id = String(e.spellId ?? "");
    if (COPY_CAST_IDS.has(id)) continue;
    const t = e.logLine.timestamp;
    const prev = prevEventBySpell.get(id);
    prevEventBySpell.set(id, t);
    if (prev !== undefined && t - prev < CHANNEL_TICK_MAX_GAP_S * 1000) {
      continue; // identical instant (form 3) or tick spacing (form 2)
    }
    keep.add(i);
  }
  return events.filter((_, i) => keep.has(i));
}
