import { describe, expect, it, vi } from "vitest";

// #10 T2:deriveDampeningSeries 曾逐秒调 getDampeningPercentage(内部每次都
// buildDampeningEvents 重建事件表)= O(events × seconds)。改用一次性建表的
// computeDampeningTimeline 后,getDampeningPercentage 应该完全不再被调用,
// computeDampeningTimeline 只建一次表。用 partial mock 数调用次数,而不是
// 掐秒表——次数是确定性判据,不随机器快慢漂移。
const state = vi.hoisted(() => ({ getPctCalls: 0, timelineCalls: 0 }));

vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gladlog/analysis")>();
  return {
    ...actual,
    getDampeningPercentage: (
      ...args: Parameters<typeof actual.getDampeningPercentage>
    ) => {
      state.getPctCalls++;
      return actual.getDampeningPercentage(...args);
    },
    computeDampeningTimeline: (
      ...args: Parameters<typeof actual.computeDampeningTimeline>
    ) => {
      state.timelineCalls++;
      return actual.computeDampeningTimeline(...args);
    },
  };
});

import { deriveDampeningSeries } from "../src/renderer/src/report/derive/dampeningSeries";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

describe("deriveDampeningSeries — O(events×seconds) → O(events)(#10 T2)", () => {
  it("改用 computeDampeningTimeline 一次建表,不再逐秒调 getDampeningPercentage", () => {
    const base = loadRealMatchFixture();
    state.getPctCalls = 0;
    state.timelineCalls = 0;
    const series = deriveDampeningSeries(base as unknown as ReportSource);
    expect(series.length).toBeGreaterThan(30); // 90s fixture,确认真跑了逻辑
    expect(state.timelineCalls).toBe(1);
    expect(state.getPctCalls).toBe(0);
  });

  it("注入一次 110310 dose 事件(30s 网格点上)→ 输出在该秒起精确阶跃,此前维持 fallback", () => {
    const base = loadRealMatchFixture();
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const anyUnit = Object.values(clone.units)[0] as unknown as {
      auraEvents: Array<Record<string, unknown>>;
    };
    // 落在 computeDampeningTimeline 的 30s 网格点上(startTime+60_000ms =
    // atSeconds 60),避免网格粒度带来的过渡秒不确定性。
    anyUnit.auraEvents.push({
      timestamp: clone.startTime + 60_000,
      eventName: "SPELL_AURA_APPLIED_DOSE",
      spellId: 110310,
      spellName: "Dampening",
      srcId: (anyUnit as unknown as { id: string }).id ?? "src",
      srcName: "src",
      destId: (anyUnit as unknown as { id: string }).id ?? "dst",
      destName: "dst",
      auraType: "DEBUFF",
      params: [
        ...Array(12).fill("0"),
        "25", // index 12 = dose stacks → 25%
      ],
    });
    const series = deriveDampeningSeries(clone as unknown as ReportSource);
    const fallback = series[0]!.pct;
    expect(fallback).toBeLessThan(25);
    const before = series.find((p) => p.tS === 59)!;
    const at = series.find((p) => p.tS === 60)!;
    const after = series.find((p) => p.tS === 89)!;
    expect(before.pct).toBe(fallback);
    expect(at.pct).toBe(25);
    expect(after.pct).toBe(25);
  });
});
