import { describe, expect, it } from "vitest";

import fixture from "../../../../../test/fixtures/report-match.json";
import type { ReportSource } from "./types";
import { deriveMatchArc } from "./matchArc";

// #10 T4: deriveMatchArc 只负责组装 buildMatchArcStructured 的入参
// (keyMoments.ts:129/:149 同款 legacy/owner/friends/enemies 组装模式)。
// report-match.json 是个 15.5s 的 2v2 fixture —— 天然落在 buildMatchArcStructured
// 的 <90s 折叠分支(early/late 两相位),顺带覆盖短局路径。
const source = fixture as unknown as ReportSource;

describe("deriveMatchArc", () => {
  it("短局(<90s)折叠为 early/late 两相位,边界与 fixture 时长对齐", () => {
    const phases = deriveMatchArc(source);
    expect(phases.map((p) => p.phase)).toEqual(["early", "late"]);
    expect(phases[0]!.fromS).toBe(0);
    const durationSeconds = (source.endTime - source.startTime) / 1000;
    expect(phases[phases.length - 1]!.toS).toBeCloseTo(durationSeconds, 1);
  });

  it("坏数据(缺 units)stub-safe 返回 []", () => {
    expect(deriveMatchArc({} as unknown as ReportSource)).toEqual([]);
  });
});
