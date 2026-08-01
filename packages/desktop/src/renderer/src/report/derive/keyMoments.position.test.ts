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
      // SPLIT_PUSH/HEALER_TRAINED:不在白名单内 → 不应进轴(复核加强覆盖:
      // 此前只测了 KITED 一个排除样例)。
      {
        type: "SPLIT_PUSH",
        atSeconds: 70,
        toSeconds: 80,
        nearestEnemyName: "PlayerA-Test",
        playersInvolved: ["PlayerD-Test"],
      },
      {
        type: "HEALER_TRAINED",
        atSeconds: 90,
        toSeconds: 100,
        nearestEnemyName: "PlayerA-Test",
        startDistanceYards: 4,
        playersInvolved: ["PlayerD-Test"],
      },
    ]),
  };
});

import fixture from "../../../../../test/fixtures/report-match.json";
import { POSITION_MISTAKES, type PositionEventType } from "@gladlog/analysis";
import type { ReportSource } from "./types";
import { deriveKeyMoments } from "./keyMoments";

const source = fixture as unknown as ReportSource;

// keyMoments.ts 的 title 是 POSITION_MISTAKES 三类各自唯一的字符串——反查
// 表只用于这一份测试,把「进轴的 title」倒推回「产生它的 PositionEventType」,
// 好去问真正的白名单单源(POSITION_MISTAKES)「这算不算数」。
const TITLE_TO_TYPE: Record<string, PositionEventType> = {
  顶着爆发硬扛: "STAYED_IN",
  该压没压: "MISSED_PUSH",
  "CD 距离外": "CD_OUT_OF_RANGE",
};

describe("deriveKeyMoments — position kind (#10 T4)", () => {
  it("STAYED_IN(有代价)/MISSED_PUSH/CD_OUT_OF_RANGE 进轴,KITED/SPLIT_PUSH/HEALER_TRAINED/无代价 STAYED_IN 不进", () => {
    const moments = deriveKeyMoments(source);
    const positions = moments.filter((m) => m.kind === "position");
    expect(positions.map((m) => m.t).sort((a, b) => a - b)).toEqual([
      5, 40, 60,
    ]);
    expect(positions.every((m) => m.weight === "minor")).toBe(true);
    expect(positions.every((m) => m.side === "friendly")).toBe(true);
    expect(positions.every((m) => m.jumpT === m.t)).toBe(true);
  });

  it("复核修复(等价保护):keyMoments 实际接受的类型集合 ⊆ POSITION_MISTAKES(单源白名单)", () => {
    const moments = deriveKeyMoments(source);
    const positions = moments.filter((m) => m.kind === "position");
    expect(positions.length).toBeGreaterThan(0); // 断言本身没退化成空跑
    for (const m of positions) {
      const type = TITLE_TO_TYPE[m.title];
      expect(type).toBeDefined(); // 每条进轴的都能倒查回一个已知类型
      expect(POSITION_MISTAKES.has(type!)).toBe(true);
    }
  });
});
