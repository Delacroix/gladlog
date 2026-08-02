import { describe, expect, it } from "vitest";

import { fmtTime, toRenderSecond } from "./cooldowns";

/**
 * Regression guard for the render-grid predicate.
 *
 * Measured on 2026-07-20 (class A, 26/50 matches, 33 occurrences): `[STATE]`
 * sampled on whole seconds while `[DMG SPIKE]` sampled at `pw.fromSeconds`
 * (fractional seconds), yet both rendered into the same displayed second — so
 * two HP numbers under one timestamp contradicted each other (median 7pp, max
 * 25pp).
 *
 * Key lesson: **this is not a sampling-radius problem**. getUnitHpAtTimestamp
 * picks the nearest sample first and only then uses the radius to accept or
 * reject it — changing the radius can only turn the value into null, it never
 * changes the value. The version that "unified the radius" measured
 * 26/50 → 26/50, not a single number moved; aligning the query instants is what
 * took it to 26/50 → 0/50. For any "two places disagree on a number" problem,
 * first ask whether they are querying the same instant.
 */
describe("toRenderSecond:采样网格必须与渲染网格一致", () => {
  it("与 fmtTime 同一取整规则 —— 这是它存在的全部意义", () => {
    for (const t of [0, 0.001, 0.4, 0.999, 1, 27.4, 59.9, 60, 108.6, 3599.99]) {
      expect(fmtTime(t)).toBe(fmtTime(toRenderSecond(t)));
    }
  });

  it("向下取整,不是四舍五入", () => {
    expect(toRenderSecond(27.9)).toBe(27);
    expect(toRenderSecond(27.1)).toBe(27);
    expect(toRenderSecond(27)).toBe(27);
  });

  it("已在网格上的整数秒是不动点(幂等)", () => {
    for (const t of [0, 1, 42, 300]) {
      expect(toRenderSecond(t)).toBe(t);
      expect(toRenderSecond(toRenderSecond(t))).toBe(t);
    }
  });

  it("**核心不变量**:渲染成同一秒的任意两个时刻,采样网格也必须相同", () => {
    // This is exactly the shape of the class-A defect: 27.0 and 27.9 both render
    // as "0:27", but sampling each at its raw value would hit a different
    // advancedAction.
    const pairs: Array<[number, number]> = [
      [27.0, 27.9],
      [108.2, 108.75],
      [59.0, 59.99],
    ];
    for (const [a, b] of pairs) {
      expect(fmtTime(a)).toBe(fmtTime(b));
      expect(toRenderSecond(a)).toBe(toRenderSecond(b));
    }
  });
});
