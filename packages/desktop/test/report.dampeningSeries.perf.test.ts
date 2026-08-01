import { describe, expect, it, vi } from "vitest";

// #10 T2 correction: deriveDampeningSeries has a LIVE consumer
// (ReplayView.tsx's 回放页「衰减 N%」scrub display, via dampeningAt —
// backlog #11). The first version of this fix swapped the internals to
// computeDampeningTimeline's 30s change-point sampling, which is fine for
// its original AI-summary consumer but regressed the replay scrub to
// up-to-29s-stale. Correct fix: build the per-second series directly from
// buildDampeningEvents (raw sorted 110310 dose events, exported, same
// source getDampeningPercentage itself uses) + getInitialDampening (same
// initial-value rule, exported so this file doesn't fork a second copy),
// forward-filled with a single monotonic pointer — event-time-exact AND
// O(events) (build once) + O(seconds) (fill), not O(events × seconds).
const state = vi.hoisted(() => ({ buildCalls: 0, getPctCalls: 0 }));

vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gladlog/analysis")>();
  return {
    ...actual,
    buildDampeningEvents: (
      ...args: Parameters<typeof actual.buildDampeningEvents>
    ) => {
      state.buildCalls++;
      return actual.buildDampeningEvents(...args);
    },
    getDampeningPercentage: (
      ...args: Parameters<typeof actual.getDampeningPercentage>
    ) => {
      state.getPctCalls++;
      return actual.getDampeningPercentage(...args);
    },
  };
});

import { deriveDampeningSeries } from "../src/renderer/src/report/derive/dampeningSeries";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

type NativeUnit = { auraEvents: Array<Record<string, unknown>> };

function pushDoseEvent(
  clone: ReturnType<typeof loadRealMatchFixture>,
  timestamp: number,
  stacks: number,
): void {
  const anyUnit = Object.values(clone.units)[0] as unknown as NativeUnit;
  anyUnit.auraEvents.push({
    timestamp,
    eventName: "SPELL_AURA_APPLIED_DOSE",
    spellId: 110310,
    spellName: "Dampening",
    srcId: "src",
    srcName: "src",
    destId: "dst",
    destName: "dst",
    auraType: "DEBUFF",
    params: [...Array(12).fill("0"), String(stacks)], // index 12 = dose stacks
  });
}

describe("deriveDampeningSeries — O(events×seconds) → O(events), event-time exact (#10 T2 correction)", () => {
  it("只建一次事件表(buildDampeningEvents),完全不再逐秒调 getDampeningPercentage", () => {
    const base = loadRealMatchFixture();
    state.buildCalls = 0;
    state.getPctCalls = 0;
    const series = deriveDampeningSeries(base as unknown as ReportSource);
    expect(series.length).toBeGreaterThan(30); // 90s fixture,确认真跑了逻辑
    expect(state.buildCalls).toBe(1);
    expect(state.getPctCalls).toBe(0);
  });

  it("精确到秒:t=37s 的 dose 事件必须在 s=37 就反映出来(30s 网格会漏到 s=60 才变,此断言能抓住那个回归)", () => {
    const base = loadRealMatchFixture();
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    pushDoseEvent(clone, clone.startTime + 37_000, 42);
    const series = deriveDampeningSeries(clone as unknown as ReportSource);
    const fallback = series[0]!.pct;
    expect(fallback).not.toBe(42);
    expect(series.find((p) => p.tS === 36)!.pct).toBe(fallback);
    expect(series.find((p) => p.tS === 37)!.pct).toBe(42);
    expect(series.find((p) => p.tS === 38)!.pct).toBe(42);
  });

  it("末尾 <1s 余量窗口内的变化也要反映在最后一格(durationS 是 floor 过的整数秒,比赛可能在整秒后还有零头)", () => {
    const base = loadRealMatchFixture();
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    // fixture 原本 startTime→endTime 恰好 90000ms(90s 整),人为加 500ms
    // 余量,制造一个「整秒边界之后、真正 endTime 之前」的窗口。
    clone.endTime = base.endTime + 500;
    const durationS = Math.floor((clone.endTime - clone.startTime) / 1000); // 仍是 90
    expect(durationS).toBe(90);
    // 事件落在 90000ms(=第 90 秒整数边界)之后、90500ms(=endTime)之前
    pushDoseEvent(clone, clone.startTime + 90_250, 77);
    const series = deriveDampeningSeries(clone as unknown as ReportSource);
    const fallback = series[0]!.pct;
    expect(series.find((p) => p.tS === 89)!.pct).toBe(fallback); // 整秒边界前,还没发生
    expect(series.find((p) => p.tS === 90)!.pct).toBe(77); // 最后一格用精确 endTime 查询,抓到了
  });
});
