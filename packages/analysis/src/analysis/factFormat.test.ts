import { describe, expect, it } from "vitest";

import { fmtTime, toRenderSecond } from "../utils/renderGrid";
import { fmtFactNum, fmtFactTime } from "./factFormat";

describe("fmtFactNum(facts 数值渲染单源,周度复核 P2#7)", () => {
  it("整数直出、非整数一位小数 —— 占位符取值必须逐字符稳定", () => {
    expect(fmtFactNum(83)).toBe("83");
    expect(fmtFactNum(83.5)).toBe("83.5");
    expect(fmtFactNum(83.44)).toBe("83.4");
    expect(fmtFactNum(83.46)).toBe("83.5");
    expect(fmtFactNum(0)).toBe("0");
  });

  it("与 fmtTime 是两套刻度,不得混用(已知表层不一致,统一属产品决策)", () => {
    // Pin the difference: the day someone "unifies them while they're at it",
    // this goes red first and forces them to read the P2#7 conclusion
    expect(fmtFactNum(83)).toBe("83");
    expect(fmtTime(83)).toBe("1:23");
  });
});

describe("fmtFactTime(render-grid fix, 2026-08-30, kick-eaten 类 bug)", () => {
  it("截断而非四舍五入 —— x.95–x.99 不得进位到下一秒", () => {
    // The exact defect shape: fmtFactNum(9.96) rounds UP to "10.0" (a
    // different whole second than fmtTime(9.96) floors to), which is exactly
    // the class this function exists to prevent.
    expect(fmtFactNum(9.96)).toBe("10.0"); // pin the old (bad) behavior
    expect(fmtFactTime(9.96)).toBe("9.9");
    expect(fmtFactTime(208.96)).toBe("208.9");
  });

  it("floor(parseFloat(结果)) 必须等于 floor(原始值) —— 与 fmtTime/toRenderSecond 同一整秒", () => {
    for (const n of [0, 0.04, 9.9, 9.96, 9.999, 83.44, 83.46, 208.96, 209]) {
      expect(Math.floor(Number(fmtFactTime(n)))).toBe(toRenderSecond(n));
    }
  });

  it("整数直出、非整数一位小数(与 fmtFactNum 的显示约定一致)", () => {
    expect(fmtFactTime(83)).toBe("83");
    expect(fmtFactTime(83.5)).toBe("83.5");
    expect(fmtFactTime(0)).toBe("0");
  });
});
