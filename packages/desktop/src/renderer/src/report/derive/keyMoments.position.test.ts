import { describe, expect, it, vi } from "vitest";

// #10 T4: position kind 三类过滤——STAYED_IN 且 stayedInHadRealCost() / MISSED_PUSH /
// CD_OUT_OF_RANGE 进轴;KITED 与「无代价」的 STAYED_IN 不进(谓词与深挖
// hasCoachableSignal 同源,见 packages/analysis/src/utils/positionAnalysis.ts 的
// stayedInHadRealCost)。真实几何(advancedActions)不在本文件覆盖范围——
// 只 mock computeOwnerPositionEvents 的返回值,其余 analysis 函数吃真实 fixture。
vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gladlog/analysis")>();
  return {
    ...actual,
    computeOwnerPositionEvents: vi.fn(() => [
      // 有代价:100% → 40%,stayedInHadRealCost(40,100) = true → 应进轴
      {
        type: "STAYED_IN",
        atSeconds: 5,
        toSeconds: 10,
        startDistanceYards: 3,
        endDistanceYards: 4,
        nearestEnemyName: "PlayerA-Test",
        dangerLabel: "High",
        ownerHpStartPct: 100,
        ownerHpMinPct: 40,
      },
      // 无代价:100% → 95%(跌 5 < 15 且 min ≥ 85)→ stayedInHadRealCost = false → 不应进轴
      {
        type: "STAYED_IN",
        atSeconds: 20,
        toSeconds: 25,
        startDistanceYards: 3,
        endDistanceYards: 4,
        nearestEnemyName: "PlayerA-Test",
        dangerLabel: "Low",
        ownerHpStartPct: 100,
        ownerHpMinPct: 95,
      },
      // KITED:不在三类白名单内 → 不应进轴
      {
        type: "KITED",
        atSeconds: 30,
        toSeconds: 35,
        startDistanceYards: 3,
        endDistanceYards: 20,
        nearestEnemyName: "PlayerA-Test",
        dangerLabel: "High",
      },
      {
        type: "MISSED_PUSH",
        atSeconds: 40,
        toSeconds: 55,
        startDistanceYards: 30,
      },
      {
        type: "CD_OUT_OF_RANGE",
        atSeconds: 60,
        startDistanceYards: 25,
        nearestEnemyName: "PlayerA-Test",
        spellName: "Wild Charge",
      },
    ]),
  };
});

import fixture from "../../../../../test/fixtures/report-match.json";
import type { ReportSource } from "./types";
import { deriveKeyMoments } from "./keyMoments";

const source = fixture as unknown as ReportSource;

describe("deriveKeyMoments — position kind (#10 T4)", () => {
  it("STAYED_IN(有代价)/MISSED_PUSH/CD_OUT_OF_RANGE 进轴,KITED/无代价 STAYED_IN 不进", () => {
    const moments = deriveKeyMoments(source);
    const positions = moments.filter((m) => m.kind === "position");
    expect(positions.map((m) => m.t).sort((a, b) => a - b)).toEqual([
      5, 40, 60,
    ]);
    expect(positions.every((m) => m.weight === "minor")).toBe(true);
    expect(positions.every((m) => m.side === "friendly")).toBe(true);
    expect(positions.every((m) => m.jumpT === m.t)).toBe(true);
  });
});
