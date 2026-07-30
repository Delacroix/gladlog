import { beforeAll, describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD, ensureAnalysisData } from "@gladlog/analysis";

import realMatch from "./fixtures/real-match-sample.json";
import { buildAnalysisInput } from "../src/renderer/src/report/derive/analysisInput";
import { derivePressureLanes } from "../src/renderer/src/report/derive/pressureLanes";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

const src = realMatch as unknown as ReportSource;

beforeAll(async () => {
  // prompt 法术名前置契约(analysisInput.test.ts 既有测试同款)——
  // buildAnalysisInput 内部渲染依赖前表就绪,否则法术名会降级。
  await ensureAnalysisData();
});

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

  it("泳道与 prompt 同谓词:spike 数 = [DMG SPIKE] 行数;exposure 数 = 非 Safe [HEALER EXPOSURE] 行数", async () => {
    await ensureAnalysisData(); // prompt 法术名前置契约(analysisInput 既有测试同款)
    const input = buildAnalysisInput(src, "parity-test");
    expect(input).not.toBeNull();
    // richContext 实测行前缀:`0:29–0:39  [DMG SPIKE]   …` / `0:13  [HEALER EXPOSURE]   … — ⚠ Exposed — …`
    // (图例行 "  [DMG SPIKE] `START–END` = …" 无时间戳前缀,trim 后不匹配 \d+:\d{2},天然被滤掉)。
    const spikeLines = input!.richContext
      .split("\n")
      .filter((l) => /^\d+:\d{2}/.test(l.trim()) && l.includes("[DMG SPIKE]"));
    const exposureLines = input!.richContext
      .split("\n")
      .filter(
        (l) =>
          /^\d+:\d{2}/.test(l.trim()) &&
          l.includes("[HEALER EXPOSURE]") &&
          !l.includes("Safe"),
      );
    const { spikes, exposures } = derivePressureLanes(src);
    expect(spikes.length).toBe(spikeLines.length); // 本 fixture 实测 2=2
    expect(exposures.length).toBe(exposureLines.length); // 本 fixture 实测 2=2
    expect(spikes.length).toBeGreaterThan(0); // 防空转
  });
});
