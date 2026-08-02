import { describe, expect, it } from "vitest";

import { buildCriticalWindowSet } from "./criticalWindows";
import { DMG_SPIKE_THRESHOLD } from "./timelineHelpers";

/**
 * Equivalence guardrail for the extraction refactor.
 *
 * buildCriticalWindowSet was lifted verbatim out of local code in
 * matchTimeline.ts. The sole purpose of the extraction is to let the several
 * HP consumers ([CD]/[DMG SPIKE]/[STATE], …) share one window set (see the
 * root-cause note in criticalWindows.ts) — **it must not change which second
 * belongs to the set**.
 *
 * The legacy implementation below is a verbatim copy of the old logic; the two
 * must produce exactly the same set.
 */

/** The original inline logic from matchTimeline.ts before extraction, copied
 * verbatim. */
function legacyBuild(inputs: {
  friendlyDeaths: Array<{ atSeconds: number }>;
  enemyDeaths: Array<{ atSeconds: number }>;
  pressureWindows: Array<{ fromSeconds: number; totalDamage: number }>;
  ccTrinketSummaries: Array<{ ccInstances: Array<{ atSeconds: number }> }>;
  matchDurationSeconds: number;
}): Set<number> {
  const {
    friendlyDeaths,
    enemyDeaths,
    pressureWindows,
    ccTrinketSummaries,
    matchDurationSeconds: matchDurationS,
  } = inputs;
  const criticalWindowSet = new Set<number>();
  for (const d of friendlyDeaths) {
    for (
      let t = Math.max(0, Math.ceil(d.atSeconds - 10));
      t <= Math.floor(d.atSeconds);
      t++
    ) {
      criticalWindowSet.add(t);
    }
  }
  for (const d of enemyDeaths) {
    for (
      let t = Math.max(0, Math.ceil(d.atSeconds - 10));
      t <= Math.floor(d.atSeconds);
      t++
    ) {
      criticalWindowSet.add(t);
    }
  }
  for (const pw of pressureWindows) {
    if (pw.totalDamage >= DMG_SPIKE_THRESHOLD) {
      const from = Math.max(0, Math.ceil(pw.fromSeconds - 5));
      const to = Math.min(
        Math.floor(matchDurationS),
        Math.floor(pw.fromSeconds + 5),
      );
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }
  for (const summary of ccTrinketSummaries) {
    for (const cc of summary.ccInstances) {
      const from = Math.max(0, Math.ceil(cc.atSeconds));
      const to = Math.min(
        Math.floor(matchDurationS),
        Math.floor(cc.atSeconds + 10),
      );
      for (let t = from; t <= to; t++) criticalWindowSet.add(t);
    }
  }
  return criticalWindowSet;
}

/** Deterministic pseudo-random source. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function randomInputs(seed: number) {
  const r = lcg(seed);
  const matchDurationSeconds = 60 + Math.round(r() * 300);
  const at = () => r() * matchDurationSeconds;
  return {
    matchDurationSeconds,
    friendlyDeaths: Array.from({ length: Math.floor(r() * 4) }, () => ({
      atSeconds: at(),
    })),
    enemyDeaths: Array.from({ length: Math.floor(r() * 4) }, () => ({
      atSeconds: at(),
    })),
    pressureWindows: Array.from({ length: Math.floor(r() * 12) }, () => ({
      fromSeconds: at(),
      // Straddle both sides of the threshold, so both filter branches are
      // covered
      totalDamage: Math.round(r() * 2 * DMG_SPIKE_THRESHOLD),
    })),
    ccTrinketSummaries: Array.from({ length: Math.floor(r() * 4) }, () => ({
      ccInstances: Array.from({ length: Math.floor(r() * 5) }, () => ({
        atSeconds: at(),
      })),
    })),
  };
}

describe("buildCriticalWindowSet:抽取必须行为等价", () => {
  it("**等价性**:200 组随机输入与抽取前的旧逻辑逐秒一致", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const inputs = randomInputs(seed);
      const extracted = buildCriticalWindowSet(inputs);
      const legacy = legacyBuild(inputs);
      expect([...extracted].sort((a, b) => a - b)).toEqual(
        [...legacy].sort((a, b) => a - b),
      );
    }
  });

  it("空输入 → 空集合", () => {
    expect(
      buildCriticalWindowSet({
        friendlyDeaths: [],
        enemyDeaths: [],
        pressureWindows: [],
        ccTrinketSummaries: [],
        matchDurationSeconds: 120,
      }).size,
    ).toBe(0);
  });

  it("低于阈值的 pressure window 不构成关键窗口", () => {
    const set = buildCriticalWindowSet({
      friendlyDeaths: [],
      enemyDeaths: [],
      pressureWindows: [
        { fromSeconds: 50, totalDamage: DMG_SPIKE_THRESHOLD - 1 },
      ],
      ccTrinketSummaries: [],
      matchDurationSeconds: 120,
    });
    expect(set.size).toBe(0);
  });

  it("刚好达到阈值即构成关键窗口(边界是 >=)", () => {
    const set = buildCriticalWindowSet({
      friendlyDeaths: [],
      enemyDeaths: [],
      pressureWindows: [{ fromSeconds: 50, totalDamage: DMG_SPIKE_THRESHOLD }],
      ccTrinketSummaries: [],
      matchDurationSeconds: 120,
    });
    expect(set.has(50)).toBe(true);
    expect(set.has(45)).toBe(true);
    expect(set.has(55)).toBe(true);
    expect(set.has(44)).toBe(false);
    expect(set.has(56)).toBe(false);
  });

  it("死亡窗口覆盖 [T-10, T],不含 T+1", () => {
    const set = buildCriticalWindowSet({
      friendlyDeaths: [{ atSeconds: 30 }],
      enemyDeaths: [],
      pressureWindows: [],
      ccTrinketSummaries: [],
      matchDurationSeconds: 120,
    });
    expect(set.has(20)).toBe(true);
    expect(set.has(30)).toBe(true);
    expect(set.has(19)).toBe(false);
    expect(set.has(31)).toBe(false);
  });
});
