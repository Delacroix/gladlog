import type { StoredMatchMeta } from "../../../main/matchStore";

export type DashPeriod = "today" | "week" | "all";

export interface RatingPoint {
  t: number; // startTime ms
  rating: number;
}
export interface RatingSeries {
  bracket: string;
  points: RatingPoint[];
}
export interface CompRow {
  /** Enemy comp signature: specIds ascending; rich rows only (those with
   * `teams`). */
  specIds: number[];
  games: number;
  wins: number;
}
export interface ZoneRow {
  zoneId: string;
  games: number;
  wins: number;
}

export interface Dashboard {
  games: number;
  wins: number;
  /** Win-rate denominator (1e): shuffle counts per round (roundStats),
   * regular matches count per match; old shuffle rows (no roundStats) fall
   * back to per-match. The match-count KPI still uses `games` (per match). */
  rateGames: number;
  rateWins: number;
  /** Median duration (seconds); old rows without durationS are excluded. */
  medianDurationS: number | null;
  ratingSeries: RatingSeries[];
  comps: CompRow[];
  zones: ZoneRow[];
  /** Number of old rows lacking a `teams` field (surfaced as the comp table's
   * coverage gap). */
  legacyRows: number;
  /** Recent matches (second round, P0, fourth card in the right column):
   * filtered by character but **not by period** -- "recent" means recent, and
   * switching to "today"/"7 days" with no games played should not make the
   * card disappear (filling the empty state is the whole point of P0).
   * Descending by time, first 8. */
  recent: StoredMatchMeta[];
}

const isWin = (m: StoredMatchMeta): boolean => m.result.toLowerCase() === "win";

export function periodStart(period: DashPeriod, now: number): number {
  if (period === "all") return 0;
  if (period === "week") return now - 7 * 24 * 3600_000;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Record-dashboard aggregation (pure function; data source = the full meta
 * index, zero extra IO). A shuffle row's `result` is the whole-lobby result
 * and is counted with the same weight as a regular match.
 */
export function deriveDashboard(
  metas: StoredMatchMeta[],
  period: DashPeriod,
  now = Date.now(),
  /** Character-name filter (undefined = all characters). */
  character?: string,
): Dashboard {
  const from = periodStart(period, now);
  const byChar = metas.filter((m) => !character || m.playerName === character);
  const rows = byChar
    .filter((m) => m.startTime >= from)
    .sort((a, b) => a.startTime - b.startTime);

  const wins = rows.filter(isWin).length;

  // Win rate per round (1e): a shuffle lobby's 6 rounds count individually,
  // a regular match counts as 1
  let rateGames = 0;
  let rateWins = 0;
  for (const m of rows) {
    if (m.kind === "shuffle" && m.roundStats && m.roundStats.length > 0) {
      rateGames += m.roundStats.length;
      rateWins += m.roundStats.filter((r) => r.win).length;
    } else {
      rateGames++;
      if (isWin(m)) rateWins++;
    }
  }

  const durations = rows
    .map((m) => m.durationS)
    .filter((d): d is number => typeof d === "number")
    .sort((a, b) => a - b);
  const medianDurationS = durations.length
    ? durations[Math.floor(durations.length / 2)]!
    : null;

  const byBracket = new Map<string, RatingPoint[]>();
  for (const m of rows) {
    // The curve prefers the recorder's own rating (the team average jumps
    // around across multiple characters / premade groups); old rows fall back
    // to the team average
    const rating =
      typeof m.playerRating === "number" && m.playerRating > 0
        ? m.playerRating
        : m.avgRating;
    if (typeof rating !== "number" || rating <= 0) continue;
    const list = byBracket.get(m.bracket) ?? [];
    list.push({ t: m.startTime, rating });
    byBracket.set(m.bracket, list);
  }
  const ratingSeries = [...byBracket.entries()]
    .map(([bracket, points]) => ({ bracket, points }))
    .filter((s) => s.points.length >= 2)
    .sort((a, b) => b.points.length - a.points.length);

  const compMap = new Map<string, CompRow>();
  let legacyRows = 0;
  const bumpComp = (specIds: number[], win: boolean) => {
    const key = specIds.join("+");
    const row = compMap.get(key) ?? { specIds, games: 0, wins: 0 };
    row.games++;
    if (win) row.wins++;
    compMap.set(key, row);
  };
  for (const m of rows) {
    // Matchup dimension (1e): shuffle reshuffles sides every round, so the
    // enemy group is counted per round (and so is the win) -- meta.teams only
    // holds the R1 roster, and whole-lobby granularity is semantically wrong
    // for shuffle.
    if (m.kind === "shuffle" && m.roundStats && m.roundStats.length > 0) {
      let counted = false;
      for (const r of m.roundStats) {
        if (r.enemySpecIds.length === 0) continue; // degraded row (missing teamId)
        bumpComp(
          [...r.enemySpecIds].sort((a, b) => a - b),
          r.win,
        );
        counted = true;
      }
      if (!counted) legacyRows++;
      continue;
    }
    const foe = m.teams?.[1];
    if (!foe || foe.length === 0) {
      legacyRows++;
      continue;
    }
    bumpComp(
      foe.map((p) => p.specId).sort((a, b) => a - b),
      isWin(m),
    );
  }
  const comps = [...compMap.values()].sort(
    (a, b) => b.games - a.games || b.wins - a.wins,
  );

  const zoneMap = new Map<string, ZoneRow>();
  for (const m of rows) {
    const row = zoneMap.get(m.zoneId) ?? {
      zoneId: m.zoneId,
      games: 0,
      wins: 0,
    };
    row.games++;
    if (isWin(m)) row.wins++;
    zoneMap.set(m.zoneId, row);
  }
  const zones = [...zoneMap.values()].sort((a, b) => b.games - a.games);

  return {
    games: rows.length,
    wins,
    rateGames,
    rateWins,
    medianDurationS,
    ratingSeries,
    comps,
    zones,
    legacyRows,
    recent: [...byChar].sort((a, b) => b.startTime - a.startTime).slice(0, 8),
  };
}

/**
 * Rating delta: the difference between two adjacent matches sharing the same
 * bracket + character + rating source (personal CR and team-average MMR are
 * never compared against each other); the first match, or one with no rating,
 * yields null and shows no arrow. The app's match list and the record page's
 * "recent matches" card share this one implementation (single-source, so the
 * two can't drift apart computing it separately).
 */
export function deriveRatingDeltas(
  metas: StoredMatchMeta[],
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  const last = new Map<string, number>();
  for (const m of [...metas].sort((a, b) => a.startTime - b.startTime)) {
    const personal = typeof m.playerRating === "number" && m.playerRating > 0;
    const r = personal ? m.playerRating! : (m.avgRating ?? null);
    if (r == null) {
      map.set(m.id, null);
      continue;
    }
    const key = `${m.bracket}|${m.playerName ?? ""}|${personal ? "cr" : "mmr"}`;
    const prev = last.get(key);
    map.set(m.id, prev != null ? r - prev : null);
    last.set(key, r);
  }
  return map;
}

/** Character list (descending by match count); old rows without playerName
 * fall under undefined and never appear in the list. */
export function listCharacters(
  metas: StoredMatchMeta[],
): Array<{ name: string; games: number }> {
  const byName = new Map<string, number>();
  for (const m of metas) {
    if (!m.playerName) continue;
    byName.set(m.playerName, (byName.get(m.playerName) ?? 0) + 1);
  }
  return [...byName.entries()]
    .map(([name, games]) => ({ name, games }))
    .sort((a, b) => b.games - a.games);
}

const ratingOf = (m: StoredMatchMeta): number | null =>
  typeof m.playerRating === "number" && m.playerRating > 0
    ? m.playerRating
    : typeof m.avgRating === "number" && m.avgRating > 0
      ? m.avgRating
      : null;

export interface CurrentRating {
  bracket: string;
  rating: number;
  /** Difference against the nearest match (same bracket) before the start of
   * the period; no baseline -> null. */
  delta: number | null;
}

/** "Current rating and change" strip on the overview (1h): anchored on the
 * bracket of the most recent rated match. */
export function deriveCurrentRating(
  metas: StoredMatchMeta[],
  from: number,
  character?: string,
): CurrentRating | null {
  const rated = metas
    .filter((m) => !character || m.playerName === character)
    .filter((m) => ratingOf(m) != null)
    .sort((a, b) => b.startTime - a.startTime);
  const latest = rated[0];
  if (!latest) return null;
  const rating = ratingOf(latest)!;
  // The delta only means anything when `latest` falls inside the period; the
  // baseline excludes `latest` itself and compares like with like (personal
  // CR vs CR, team-average MMR vs MMR), never mixing the two.
  const personal = (m: StoredMatchMeta): boolean =>
    typeof m.playerRating === "number" && m.playerRating > 0;
  const baseline =
    latest.startTime >= from
      ? rated.find(
          (m) =>
            m !== latest &&
            m.bracket === latest.bracket &&
            m.startTime < from &&
            personal(m) === personal(latest),
        )
      : undefined;
  return {
    bracket: latest.bracket,
    rating,
    delta: baseline ? rating - ratingOf(baseline)! : null,
  };
}
