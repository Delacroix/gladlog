import { toLegacyMatch } from "@gladlog/parser-compat";
import type { GladMatch } from "@gladlog/parser";

import type { ReportSource } from "./types";

/** convert.ts 无条件迭代的单位事件数组(裁剪版 doc/fixture 可能缺项)。 */
const UNIT_ARRAYS = [
  "absorbsIn",
  "absorbsOut",
  "actionsIn",
  "actionsOut",
  "advancedSamples",
  "auraEvents",
  "casts",
  "damageIn",
  "damageOut",
  "deaths",
  "healIn",
  "healOut",
  "petCasts",
] as const;

/** 有界 LRU(2)而非 WeakMap:WeakMap 的「key 死则条目死」在 shuffle 场景
 * 失效 —— ShuffleReport 一直强引用全部 6 轮 round 对象,逐轮点开就攒 6 份
 * legacy 放大副本(每份 ≈ 原轮 2.5-3×,308MB 档逐轮点完 = GB 级,
 * 2026-07-26 审计),直到整个 doc 被换掉才释放。上限 2 =「当前轮 + 刚离开
 * 的轮」,来回切不抖,第 3 轮起最旧的立即可回收。 */
const CACHE_MAX = 2;
const cache = new Map<ReportSource, ReturnType<typeof toLegacyMatch>>();

/**
 * 安全版 toLegacyMatch:给缺失的单位事件数组补空数组再转换。
 * 渲染测试 fixture 为控体积剥掉了 healIn/absorbsIn/actionsIn/Out,裸转换会
 * 直接抛(fixture 模式下所有 analysis 派生 UI 就静默消失)。生产 doc 全量,
 * 此垫片零影响。
 */
export function toLegacySafe(source: ReportSource) {
  const cached = cache.get(source);
  if (cached) {
    // LRU touch:重插到末尾,让「最近用过的」活得久
    cache.delete(source);
    cache.set(source, cached);
    return cached;
  }
  const units = Object.fromEntries(
    Object.entries(source.units).map(([id, u]) => {
      const padded: Record<string, unknown> = { ...u };
      for (const k of UNIT_ARRAYS) {
        if (!Array.isArray(padded[k])) padded[k] = [];
      }
      return [id, padded];
    }),
  );
  const result = toLegacyMatch({
    ...source,
    units,
    rawLines: [],
  } as unknown as GladMatch);
  cache.set(source, result);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
  return result;
}
