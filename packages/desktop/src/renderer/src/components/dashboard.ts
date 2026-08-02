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
  /** 敌方阵容签名:specId 升序;仅富行(有 teams)。 */
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
  /** 胜率口径(1e):shuffle 按回合计(roundStats),普通对局按场计;
   * 旧 shuffle 行(无 roundStats)回退按场。场次 KPI 仍用 games(按局)。 */
  rateGames: number;
  rateWins: number;
  /** 时长中位数(秒);无 durationS 的旧行不计。 */
  medianDurationS: number | null;
  ratingSeries: RatingSeries[];
  comps: CompRow[];
  zones: ZoneRow[];
  /** 无 teams 字段的旧行数(comp 表覆盖缺口提示)。 */
  legacyRows: number;
  /** 最近对局(第二轮 P0 右列第四卡):按角色过滤、**不按时间段** ——
   * 「最近」就是最近,切到「今天/7天」没打过也不该让卡消失(P0 的本意
   * 就是填空态)。按时间降序前 8。 */
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
 * 战绩仪表盘聚合(纯函数;数据源 = 全量 meta 索引,零额外 IO)。
 * shuffle 行的 result 是整局结果,与普通对局同权计入。
 */
export function deriveDashboard(
  metas: StoredMatchMeta[],
  period: DashPeriod,
  now = Date.now(),
  /** 角色名筛选(undefined = 全部角色)。 */
  character?: string,
): Dashboard {
  const from = periodStart(period, now);
  const byChar = metas.filter((m) => !character || m.playerName === character);
  const rows = byChar
    .filter((m) => m.startTime >= from)
    .sort((a, b) => a.startTime - b.startTime);

  const wins = rows.filter(isWin).length;

  // 胜率按回合(1e):shuffle 一局 6 回合逐一计入,普通对局 1 场 = 1
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
    // 曲线优先记录者本人评分(队均在多角色/组排下跳来跳去);旧行回退队均
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
    // 对位维度(1e):shuffle 每回合换边,按回合敌组计(win 也按回合)——
    // meta.teams 只有 R1 名单,整局粒度在 shuffle 下语义失真。
    if (m.kind === "shuffle" && m.roundStats && m.roundStats.length > 0) {
      let counted = false;
      for (const r of m.roundStats) {
        if (r.enemySpecIds.length === 0) continue; // 退化行(缺 teamId)
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
 * 评分涨跌:同 bracket+角色+评分源(本人 CR / 队均 MMR 不混比)的相邻两场
 * 差值;首场/无评分 → null 不显示箭头。App 对局列表与战绩「最近对局」卡
 * 共用这一份(单源,防两处各算各的漂移)。
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

/** 角色清单(按场次降序);旧行无 playerName 归入 undefined,不出现在清单。 */
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
  /** 与时间范围起点前最近一场(同 bracket)的差;无基线 → null。 */
  delta: number | null;
}

/** 总览带「当前评分与变化」(1h):最近一场有评分对局的 bracket 为准。 */
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
  // delta 只在 latest 落在时间范围内才有意义;基线排除 latest 本身,
  // 且评分源同类相比(本人 CR vs CR,队均 MMR vs MMR),不混比。
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
