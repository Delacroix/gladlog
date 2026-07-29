import { describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD } from "@gladlog/analysis";

import realMatch from "./fixtures/real-match-sample.json";
import { derivePressureLanes } from "../src/renderer/src/report/derive/pressureLanes";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

const src = realMatch as unknown as ReportSource;

describe("derivePressureLanes", () => {
  it("spike 全部过阈值门,时刻为相对秒且在场内", () => {
    const { spikes } = derivePressureLanes(src);
    const durS = (src.endTime - src.startTime) / 1000;
    for (const s of spikes) {
      expect(s.totalDamage).toBeGreaterThanOrEqual(DMG_SPIKE_THRESHOLD);
      expect(s.fromS).toBeGreaterThanOrEqual(0);
      expect(s.toS).toBeLessThanOrEqual(durS + 10); // 窗口右缘=起点+10s,允许贴边
      expect(s.dpsK).toBeGreaterThan(0);
    }
  });

  it("dpsK 与 [DMG SPIKE] 行同口径(Math.round(total/max(1,round(to-from))/1000))", () => {
    const { spikes } = derivePressureLanes(src);
    for (const s of spikes) {
      const windowSec = Math.round(s.toS - s.fromS);
      expect(s.dpsK).toBe(
        Math.round(s.totalDamage / Math.max(1, windowSec) / 1000),
      );
    }
  });

  it("裁剪 fixture(无 advancedActions 剥留与否皆可)不抛;exposures 是数组", () => {
    const { exposures } = derivePressureLanes(src);
    expect(Array.isArray(exposures)).toBe(true);
    for (const e of exposures) {
      expect(["Critical", "Exposed", "Pressured"]).toContain(e.label);
      expect(e.title.length).toBeGreaterThan(0);
    }
  });

  it("空 source(units 空)→ 双空数组不抛", () => {
    const empty = { ...src, units: {} } as unknown as ReportSource;
    expect(derivePressureLanes(empty)).toEqual({ spikes: [], exposures: [] });
  });
});
