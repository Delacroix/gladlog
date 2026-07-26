/**
 * 确定性筛(spec §2):台账对局视图 → 稳定模式。
 *
 * 谓词即规范:这里的常量与谓词是唯一权威 —— 退役(learning.ts)、徽章
 * (matchRules.ts)、报告页全部 import 本文件,别复制数值。
 */
import type {
  GroupStats,
  LedgerFinding,
  LedgerMatch,
  PatternCondition,
  StablePattern,
} from "./types";

export const PATTERN_WINDOW_MATCHES = 20;
export const PATTERN_MIN_HITS = 5;
export const RULE_RETIRE_MAX_HITS = 2;
export const TREND_BUCKET_MATCHES = 5;
/** 条件切片显著性(spec §2):子集命中 ≥4 且命中率 ≥ 全集 2 倍。 */
export const SLICE_MIN_HITS = 4;
export const SLICE_RATE_FACTOR = 2;

export function patternId(
  category: string,
  eventTypes: string[],
  cond: PatternCondition | null,
): string {
  let id = `cat:${category}`;
  for (const t of [...eventTypes].sort()) id += `|type:${t}`;
  if (cond?.enemySpec !== undefined) id += `|spec:${cond.enemySpec}`;
  if (cond?.zoneId !== undefined) id += `|zone:${cond.zoneId}`;
  return id;
}

/** finding 命中分组:category 相等且分组 type 全部被引用。 */
export function findingMatchesGroup(
  f: LedgerFinding,
  category: string,
  eventTypes: string[],
): boolean {
  if (f.category !== category) return false;
  return eventTypes.every((t) => f.eventTypes.includes(t));
}

/** 对局是否满足条件 —— 筛选与应用(徽章)共用的**同一个**谓词。
 * 条件字段在对局侧未知(如 renderer 拿不到 zoneId)→ 保守判不满足。 */
export function matchInCondition(
  m: { zoneId?: string; enemySpecs: number[] },
  cond: PatternCondition | null,
): boolean {
  if (!cond) return true;
  if (cond.enemySpec !== undefined && !m.enemySpecs.includes(cond.enemySpec))
    return false;
  if (cond.zoneId !== undefined && m.zoneId !== cond.zoneId) return false;
  return true;
}

const hitsIn = (m: LedgerMatch, category: string, eventTypes: string[]) =>
  m.findings.some((f) => findingMatchesGroup(f, category, eventTypes));

export function measureGroup(
  all: LedgerMatch[],
  category: string,
  eventTypes: string[],
  condition: PatternCondition | null,
): GroupStats {
  const eligible = all
    .filter((m) => matchInCondition(m, condition))
    .sort((a, b) => b.startTime - a.startTime); // 新→旧
  const window = eligible.slice(0, PATTERN_WINDOW_MATCHES);
  const hitFlags = window.map((m) => hitsIn(m, category, eventTypes));
  const hits = hitFlags.filter(Boolean).length;

  const half = Math.floor(window.length / 2);
  const newerHits = hitFlags.slice(0, half).some(Boolean);
  const olderHits = hitFlags.slice(half).some(Boolean);

  // trend 旧→新分桶
  const oldFirst = [...window].reverse();
  const trend: number[] = [];
  for (let i = 0; i < oldFirst.length; i += TREND_BUCKET_MATCHES) {
    trend.push(
      oldFirst
        .slice(i, i + TREND_BUCKET_MATCHES)
        .filter((m) => hitsIn(m, category, eventTypes)).length,
    );
  }

  const allHits = eligible.filter((m) => hitsIn(m, category, eventTypes));
  return {
    windowMatches: window.length,
    hits,
    firstSeen: allHits.length
      ? Math.min(...allHits.map((m) => m.startTime))
      : 0,
    lastSeen: allHits.length ? Math.max(...allHits.map((m) => m.startTime)) : 0,
    trend,
    exampleMatchIds: window
      .filter((_, i) => hitFlags[i])
      .slice(0, 3)
      .map((m) => m.matchId),
    spansBothHalves: newerHits && olderHits,
  };
}

/** 退役/复活(spec §5):滞回 —— 阈值间空档保持现状,防边界抖动。 */
export function nextRuleStatus(
  prev: "active" | "improved",
  hits: number,
): "active" | "improved" {
  if (hits <= RULE_RETIRE_MAX_HITS) return "improved";
  if (hits >= PATTERN_MIN_HITS) return "active";
  return prev;
}

const qualifies = (g: GroupStats) =>
  g.hits >= PATTERN_MIN_HITS && g.spansBothHalves;

export function scanPatterns(all: LedgerMatch[]): StablePattern[] {
  if (all.length === 0) return [];
  const window = [...all]
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, PATTERN_WINDOW_MATCHES);

  // 候选分组域:窗口内出现过的 category 与 category+type
  const cats = new Set<string>();
  const typesByCat = new Map<string, Set<string>>();
  for (const m of window)
    for (const f of m.findings) {
      cats.add(f.category);
      const s = typesByCat.get(f.category) ?? new Set<string>();
      for (const t of f.eventTypes) s.add(t);
      typesByCat.set(f.category, s);
    }

  const out: StablePattern[] = [];
  const emit = (
    category: string,
    eventTypes: string[],
    condition: PatternCondition | null,
    g: GroupStats,
  ) =>
    out.push({
      patternId: patternId(category, eventTypes, condition),
      category,
      eventTypes,
      condition,
      windowMatches: g.windowMatches,
      hits: g.hits,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      trend: g.trend,
      exampleMatchIds: g.exampleMatchIds,
    });

  // 条件切片域:窗口内出现过的敌方 spec / zoneId
  const specs = new Set<number>();
  const zones = new Set<string>();
  for (const m of window) {
    for (const s of m.enemySpecs) specs.add(s);
    if (m.zoneId) zones.add(m.zoneId);
  }
  const emitSlices = (
    category: string,
    eventTypes: string[],
    base: GroupStats,
  ) => {
    const baseRate = base.windowMatches ? base.hits / base.windowMatches : 0;
    const conds: PatternCondition[] = [
      ...[...specs].map((s) => ({ enemySpec: s })),
      ...[...zones].map((z) => ({ zoneId: z })),
    ];
    for (const cond of conds) {
      const g = measureGroup(all, category, eventTypes, cond);
      const rate = g.windowMatches ? g.hits / g.windowMatches : 0;
      if (
        g.hits >= SLICE_MIN_HITS &&
        g.spansBothHalves &&
        rate >= SLICE_RATE_FACTOR * baseRate
      )
        emit(category, eventTypes, cond, g);
    }
  };

  for (const cat of cats) {
    const catStats = measureGroup(all, cat, [], null);
    const typeStats = [...(typesByCat.get(cat) ?? [])].map((t) => ({
      t,
      g: measureGroup(all, cat, [t], null),
    }));
    const qualifyingTypes = typeStats.filter(({ g }) => qualifies(g));
    for (const { t, g } of qualifyingTypes) {
      emit(cat, [t], null, g);
      emitSlices(cat, [t], g);
    }
    // category 级只在比最好的 type 级多带信息(命中更多)时才出,避免
    // 「survival」与「survival+death」100% 重合的双规则。
    const bestType = Math.max(0, ...qualifyingTypes.map(({ g }) => g.hits));
    if (qualifies(catStats) && catStats.hits > bestType) {
      emit(cat, [], null, catStats);
      emitSlices(cat, [], catStats);
    } else if (!qualifyingTypes.length) {
      // category 级不满足 qualifies 但没有 type 级模式时,仍尝试条件切片
      emitSlices(cat, [], catStats);
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}
