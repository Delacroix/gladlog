import { buildDampeningEvents, getInitialDampening } from "@gladlog/analysis";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

/**
 * dampening 1s 网格序列(backlog #11a)。has a LIVE consumer:ReplayView 的
 * 回放页「衰减 N%」scrub 显示(经 dampeningAt),所以这里必须是事件时刻
 * 精确值,不能有取整/网格误差。
 *
 * 早前(#10 T2 第一版)误用了 computeDampeningTimeline 的 30s change-point
 * 采样当内部实现——那是为 AI 文本上下文摘要设计的稀疏采样,换到这里会把
 * 回放的实时衰减显示粗化到 30s 网格,是真实回归,已改回。
 *
 * 正确做法:直接消费 buildDampeningEvents(与 getDampeningPercentage 同一
 * 事件表来源,谓词单源)+ getInitialDampening(同一初值规则,不复制第二份
 * 规则表),自己用单调指针把已排序的事件表前向填充成每秒一点——只建表一次
 * (O(events)),整体 O(events + seconds),而不是旧实现「每秒都调
 * getDampeningPercentage,该函数内部又重新 buildDampeningEvents」的
 * O(events × seconds)。
 *
 * 最后一秒(tS === durationS)用精确的 legacy.endTime 而非
 * startTime + durationS*1000 作查询边界:durationS 是 floor 过的整数秒,
 * match 结尾可能有 <1s 的余量,若这段余量里发生了衰减变化(比如刚好在
 * 结束前触发一次 dose),用整秒边界会漏掉;用精确 endTime 保证这最后一格
 * 反映的是「比赛结束那一刻」的真实值。
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
    const events = buildDampeningEvents(players); // 排序好的事件表,只建一次
    const fallback = getInitialDampening(bracket, players);
    const out: Array<{ tS: number; pct: number }> = [];
    let idx = 0;
    let cur = fallback;
    for (let s = 0; s <= durationS; s++) {
      const boundary =
        s === durationS ? legacy.endTime : legacy.startTime + s * 1000;
      while (idx < events.length && events[idx]!.timestamp <= boundary) {
        cur = events[idx]!.stacks;
        idx++;
      }
      out.push({ tS: s, pct: cur });
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
