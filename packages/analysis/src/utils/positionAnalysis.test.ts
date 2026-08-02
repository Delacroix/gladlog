import { describe, expect, it } from "vitest";

import {
  STAYED_IN_NO_COST_MAX_DROP_PCT,
  STAYED_IN_NO_COST_MIN_HP_PCT,
  stayedInHadRealCost,
} from "./positionAnalysis";

/**
 * This predicate is **shared** between the context formatter's "(no real cost)"
 * label and the deep-dive teachable-signal gate (weekly review P1#1). Sharing
 * one source is a hard requirement: the gate side once relied on a comment
 * asserting "STAYED_IN already only fires when HP drops", while the source never
 * filtered on HP at all.
 */
describe("stayedInHadRealCost(STAYED_IN 代价判据单源)", () => {
  it("站到濒死 / 跌幅够大 → 有代价", () => {
    expect(stayedInHadRealCost(12, 100)).toBe(true);
    expect(stayedInHadRealCost(84, 100)).toBe(true); // drop of 16 ≥ 15
  });

  it("血线高且跌幅小 → 无代价(干净窗口,不该开深挖门)", () => {
    expect(stayedInHadRealCost(98, 100)).toBe(false);
    expect(stayedInHadRealCost(90, 100)).toBe(false); // drop of 10 < 15
  });

  it("边界正好落在阈值上", () => {
    // hpMin exactly 85 with a drop of exactly 14 → still counts as no cost
    expect(stayedInHadRealCost(STAYED_IN_NO_COST_MIN_HP_PCT, 99)).toBe(false);
    // A drop of exactly 15 → counts as a real cost (only < DROP is excused)
    expect(
      stayedInHadRealCost(
        STAYED_IN_NO_COST_MIN_HP_PCT,
        STAYED_IN_NO_COST_MIN_HP_PCT + STAYED_IN_NO_COST_MAX_DROP_PCT,
      ),
    ).toBe(true);
    // hpMin below the floor → a real cost no matter how small the drop
    expect(stayedInHadRealCost(STAYED_IN_NO_COST_MIN_HP_PCT - 1, 85)).toBe(
      true,
    );
  });

  it("无 HP 数据 → 视为有代价(保持改动前行为,便于 eval 归因)", () => {
    expect(stayedInHadRealCost(null, 100)).toBe(true);
    expect(stayedInHadRealCost(undefined, undefined)).toBe(true);
  });

  it("缺 hpStart 时按满血起算", () => {
    expect(stayedInHadRealCost(98, null)).toBe(false); // 100→98
    expect(stayedInHadRealCost(80, null)).toBe(true); // 100→80
  });
});
