import { computeDampeningTimeline } from "@gladlog/analysis";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

/**
 * dampening 1s 网格序列(backlog #11a)。输出形状不变(每秒一点),但内部
 * 换成 computeDampeningTimeline(#10 T2):此前逐秒调 getDampeningPercentage,
 * 每次调用内部都重新 buildDampeningEvents 建表 = O(events × seconds);
 * computeDampeningTimeline 只建一次事件表、按 30s 网格找变化点,再在此处
 * 前向填充展开回稠密的每秒序列,复杂度降到建表一次 + 稀疏采样。
 * 代价:dampening 的阶跃时刻被取整到最近的 30s 网格点(而非精确秒),
 * 这条泳道零下游消费者(纯展示),可接受。
 * dampening 字段是 0-1 小数,这里换算回 0-100 整数百分比(单位转换封在
 * derive 内部,不外溢)。
 */
export function deriveDampeningSeries(
  source: ReportSource,
): Array<{ tS: number; pct: number }> {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    if (players.length === 0) return [];
    const bracket = (source as { bracket?: string }).bracket ?? "3v3";
    const durationS = Math.max(
      1,
      Math.floor((legacy.endTime - legacy.startTime) / 1000),
    );
    const timeline = computeDampeningTimeline(
      bracket,
      players,
      legacy.startTime,
      legacy.endTime,
    );
    const out: Array<{ tS: number; pct: number }> = [];
    let idx = 0;
    let cur = timeline.length > 0 ? timeline[0]!.dampening : 0;
    for (let s = 0; s <= durationS; s++) {
      while (idx < timeline.length && timeline[idx]!.atSeconds <= s) {
        cur = timeline[idx]!.dampening;
        idx++;
      }
      out.push({ tS: s, pct: Math.round(cur * 100) });
    }
    return out;
  } catch {
    return [];
  }
}

/** 播放时钟处的当前 dampening(最近不晚于 t 的采样)。 */
export function dampeningAt(
  series: Array<{ tS: number; pct: number }>,
  tS: number,
): number | null {
  if (series.length === 0) return null;
  let cur = series[0]!.pct;
  for (const p of series) {
    if (p.tS > tS) break;
    cur = p.pct;
  }
  return cur;
}
