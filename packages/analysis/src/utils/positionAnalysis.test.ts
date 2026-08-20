import { describe, expect, it } from "vitest";

import {
  STAYED_IN_NEAR_DEATH_PCT,
  stayedInHadRealCost,
} from "./positionAnalysis";

/**
 * This predicate is **shared** between the context formatter's "(no real cost)"
 * label and the deep-dive teachable-signal gate (weekly review P1#1). Sharing
 * one source is a hard requirement: the gate side once relied on a comment
 * asserting "STAYED_IN already only fires when HP drops", while the source never
 * filtered on HP at all.
 *
 * 2026-08-20(GH #16 接地,用户裁定):判据收紧为 hpMin < 35 —— 全库唯一有
 * 剂量-反应支撑的切点(<35 桶 owner 15s 死亡率 15.6%/败率 62.5%,35–85 区间
 * 与基线无法区分);旧 85/15 豁免线退役,drop 半件不再消费(hpStartPct 仅为
 * 兼容保留在签名)。
 */
describe("stayedInHadRealCost(STAYED_IN 代价判据单源,hpMin<35 接地版)", () => {
  it("站到濒死(<35)→ 有代价", () => {
    expect(stayedInHadRealCost(12, 100)).toBe(true);
    expect(stayedInHadRealCost(34, 100)).toBe(true);
  });

  it("血线守在 35 以上 → 无代价(旧 85/15 判据会把 84/100 判有罪 —— 那正是被接地数据打掉的 91% 区间)", () => {
    expect(stayedInHadRealCost(84, 100)).toBe(false);
    expect(stayedInHadRealCost(60, 100)).toBe(false);
    expect(stayedInHadRealCost(98, 100)).toBe(false);
  });

  it("边界:恰在 35 上 → 无代价;35 下一格 → 有代价", () => {
    expect(stayedInHadRealCost(STAYED_IN_NEAR_DEATH_PCT, 100)).toBe(false);
    expect(stayedInHadRealCost(STAYED_IN_NEAR_DEATH_PCT - 1, 100)).toBe(true);
  });

  it("无 HP 数据 → 视为有代价(保守默认;接地语料实测 0/821 次走到本分支)", () => {
    expect(stayedInHadRealCost(null, 100)).toBe(true);
    expect(stayedInHadRealCost(undefined, undefined)).toBe(true);
  });

  it("hpStart 不再参与判定(drop 半件退役)", () => {
    expect(stayedInHadRealCost(80, null)).toBe(false);
    expect(stayedInHadRealCost(80, 100)).toBe(false);
    expect(stayedInHadRealCost(30, null)).toBe(true);
  });
});
