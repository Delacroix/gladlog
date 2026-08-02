import { describe, expect, it } from "vitest";

import { fmtTime } from "../utils/cooldowns";
import { fmtFactNum } from "./factFormat";

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
