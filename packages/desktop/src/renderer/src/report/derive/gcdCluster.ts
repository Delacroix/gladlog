import { OFF_GCD_SPELL_IDS } from "@gladlog/analysis";

import type { CastRow } from "./casts";

/**
 * GCD 泳道折叠(2026-07-25 用户设计):同一时刻窗口内的多个施法折叠成
 * 一行 —— 主 chip = 该窗口第一个 **on-GCD** 施法(占 GCD 的"这一拍做了
 * 什么"),off-GCD 主动技(饰品/打断/种族技,官方 SpellCooldowns
 * StartRecoveryTime==0,offGcdGenerated)与后续挤进同窗的施法折为小图标。
 * 行锚定窗口首施法的真实时刻:纵向零漂移由窗口宽度封顶(≤ windowS)。
 */
export interface GcdCluster {
  /** 行锚点 = 窗口内首施法的时刻(绝对 ms)。 */
  t: number;
  primary: CastRow;
  minis: CastRow[];
}

export function clusterGcdCasts(
  casts: CastRow[],
  windowMs: number,
): GcdCluster[] {
  const out: GcdCluster[] = [];
  let cur: CastRow[] = [];
  let curStart = -Infinity;
  const flush = () => {
    if (cur.length === 0) return;
    const primary =
      cur.find((c) => !OFF_GCD_SPELL_IDS.has(String(c.spellId))) ?? cur[0]!;
    out.push({
      t: cur[0]!.t,
      primary,
      minis: cur.filter((c) => c !== primary),
    });
    cur = [];
  };
  for (const c of casts) {
    if (c.t >= curStart + windowMs) {
      flush();
      curStart = c.t;
    }
    cur.push(c);
  }
  flush();
  return out;
}
