/**
 * Rating percentile within (bracket, ISO week) — the house rank convention
 * for corpus studies (established by `scripts/behaviorPriorScan.ts`,
 * 2026-08-28). Rank is NOT absolute rating: a season's ratings inflate as it
 * goes on (measured 2026-08-28: week-32 Solo Shuffle median 2158 → week-34
 * median 1729), so a match's rating is only comparable within its own
 * (bracket, ISO week of startTime) population, and "rank" is the percentile
 * inside that group.
 *
 * Extracted verbatim from `behaviorPriorScan.ts` on 2026-09-02 so the
 * burst-window skill gradient (`scripts/burstWindowScan.ts gradient`)
 * consumes the SAME ranking and the SAME report bands instead of a hand copy
 * (CLAUDE.md shared-predicate rule — one fact, one predicate).
 */

export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk =
    1 +
    Math.round(
      ((d.getTime() - firstThu.getTime()) / 86400000 -
        3 +
        ((firstThu.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

/** percentile of each ledger row's rating within (bracket, week) */
export function rankLedger(ledger: Map<string, any>): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of ledger.values()) {
    if (!r.playerTeamRating || !r.startTime) continue;
    const k = `${r.bracket}|${isoWeek(r.startTime)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r.playerTeamRating);
  }
  for (const v of groups.values()) v.sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const [id, r] of ledger) {
    if (!r.playerTeamRating || !r.startTime) continue;
    const v = groups.get(`${r.bracket}|${isoWeek(r.startTime)}`)!;
    // rank = share of rows strictly below (midpoint for ties)
    let lo = 0,
      hi = v.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (v[m]! < r.playerTeamRating) lo = m + 1;
      else hi = m;
    }
    let lo2 = lo,
      hi2 = v.length;
    while (lo2 < hi2) {
      const m = (lo2 + hi2) >> 1;
      if (v[m]! <= r.playerTeamRating) lo2 = m + 1;
      else hi2 = m;
    }
    out.set(id, (100 * ((lo + lo2) / 2)) / v.length);
  }
  return out;
}

/** The report band convention: ≥90 ("top10") / 60–90 / 30–60 / <30. */
export function bandOfPct(p: number): string {
  if (p >= 90) return "top10";
  if (p >= 60) return "60-90";
  if (p >= 30) return "30-60";
  return "<30";
}

/** Band display order, lowest first. */
export const PCT_BANDS = ["<30", "30-60", "60-90", "top10"];
