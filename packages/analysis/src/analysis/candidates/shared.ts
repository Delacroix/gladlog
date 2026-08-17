/**
 * Helpers shared by more than one candidate producer.
 *
 * Split out of `candidateFindings.ts` on 2026-08-16 (mechanical split by
 * theme). Nothing here decides whether a candidate fires — these only format
 * facts once a producer has already decided to emit one.
 */
import type { CastFailedEvent } from "../../utils/rawStreams";

/**
 * Intent guard (BACKLOG #26 Task 2, 意图守护 — "pressed but rejected ≠ never
 * pressed"): formats the `CastFailedEvent`s `castFailedInWindow` returns into
 * the `attempted` fact both `cdHoardedEvents` and `deathUnusedDefensiveEvents`
 * attach when the player actually pressed the button and the game rejected
 * the cast (stun/silence/oom/GCD/etc). Aggregated by the localized `reason`
 * string kept verbatim (rawStreams.ts's own rule — never translated or
 * normalized), most-frequent reason first; ties keep first-seen order (`Map`
 * preserves insertion order and `Array.prototype.sort` is stable, so no
 * separate tie-break is needed). `undefined` for zero hits so call sites can
 * spread `...(attempted ? { attempted } : {})` without a second presence
 * check — matches this file's existing `costNorm` optional-fact idiom.
 */
/** The reason-aggregation convention itself (Task 2): group `CastFailedEvent`s
 * by their verbatim `reason` string, most-frequent first (ties keep
 * first-seen order — `Map` preserves insertion order and `Array.prototype.sort`
 * is stable). Factored out of `formatAttemptedFact` so mana-pressure (Task 3)
 * can reuse the exact same aggregation instead of a second copy — the two
 * differ only in wrapper text (Task 2's is a negation-guard sentence, Task
 * 3's is a bare fact), never in HOW reasons get counted/ordered. `undefined`
 * for zero hits, matching this file's existing optional-fact idiom.
 */
export function aggregateReasonCounts(events: CastFailedEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}×${n}`)
    .join("、");
}

export function formatAttemptedFact(events: CastFailedEvent[]): string | undefined {
  const agg = aggregateReasonCounts(events);
  return agg === undefined ? undefined : `曾尝试施放被拒(${agg})`;
}