import { describe, expect, it, vi } from "vitest";

// #10 T4 agy 复核实锤:ownerCds/ownerCcSummary 是在 defensive/cc 两个块的
// `for (const u of friends)` 循环里顺手捕获的——若 friends 里排在 owner 前面
// 的队友让该块提前 throw,循环会在到达 owner 之前中止,两个变量永远停在
// undefined/[]。position 块必须兜底现算,不能假设前面的块跑到了 owner。
//
// 复现手法:用 deriveKeyMoments 的 ownerId 覆盖参数把 owner 定成 fixture 里
// 排第二的友方单位(Player-57-0DFFA9C4),再让排第一的友方
// (Player-57-0DA725E3)在 extractMajorCooldowns/analyzePlayerCCAndTrinket 里
// 抛错——真实实现对 owner 自己不会抛,兜底路径才会算出非空值。

const boomState = vi.hoisted(() => ({ armed: false }));

vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gladlog/analysis")>();
  return {
    ...actual,
    extractMajorCooldowns: vi.fn((u: { id: string }, l: unknown) => {
      if (boomState.armed && u.id === "Player-57-0DA725E3") {
        throw new Error("boom-cds");
      }
      return actual.extractMajorCooldowns(
        u as Parameters<typeof actual.extractMajorCooldowns>[0],
        l as Parameters<typeof actual.extractMajorCooldowns>[1],
      );
    }),
    analyzePlayerCCAndTrinket: vi.fn(
      (u: { id: string }, e: unknown, l: unknown, p: unknown) => {
        if (boomState.armed && u.id === "Player-57-0DA725E3") {
          throw new Error("boom-cc");
        }
        return actual.analyzePlayerCCAndTrinket(
          u as Parameters<typeof actual.analyzePlayerCCAndTrinket>[0],
          e as Parameters<typeof actual.analyzePlayerCCAndTrinket>[1],
          l as Parameters<typeof actual.analyzePlayerCCAndTrinket>[2],
          p as Parameters<typeof actual.analyzePlayerCCAndTrinket>[3],
        );
      },
    ),
    computeOwnerPositionEvents: vi.fn(() => []),
  };
});

import fixture from "../../../../../test/fixtures/report-match.json";
import {
  analyzePlayerCCAndTrinket,
  computeOwnerPositionEvents,
} from "@gladlog/analysis";
import type { ReportSource } from "./types";
import { deriveKeyMoments } from "./keyMoments";

const source = fixture as unknown as ReportSource;

describe("deriveKeyMoments — position 块 owner CD/CC 兜底(#10 T4 agy 复核)", () => {
  it("排第一的友方在 defensive/cc 块抛错,position 仍拿到 owner 自己的 CD/CC(不因中途 throw 退化成 []/undefined)", () => {
    boomState.armed = true;
    try {
      deriveKeyMoments(source, "Player-57-0DFFA9C4");
    } finally {
      boomState.armed = false;
    }
    const posMock = vi.mocked(computeOwnerPositionEvents);
    expect(posMock).toHaveBeenCalledTimes(1);
    const call = posMock.mock.calls[0]![0];
    // 兜底真算了一遍 analyzePlayerCCAndTrinket(owner, ...)——不是循环里顺手
    // 捕获的那份(那份因为友方 1 先抛错而从未写入)。
    expect(vi.mocked(analyzePlayerCCAndTrinket)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Player-57-0DFFA9C4" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(call.ownerCCSummary).toBeDefined();
    expect(call.ownerCooldowns).toBeDefined();
  });
});
