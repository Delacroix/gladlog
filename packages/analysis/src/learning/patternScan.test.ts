import { describe, expect, it } from "vitest";

import {
  matchInCondition,
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  patternId,
  RULE_RETIRE_MAX_HITS,
  scanPatterns,
} from "./patternScan";
import type { LedgerMatch } from "./types";

/** Larger i = more recent; hit=true attaches one survival finding. */
const mk = (
  i: number,
  hit: boolean,
  opts: { type?: string; enemySpecs?: number[]; zoneId?: string } = {},
): LedgerMatch => ({
  matchId: `m${i}`,
  startTime: 1_000_000 + i * 60_000,
  win: false,
  zoneId: opts.zoneId,
  enemySpecs: opts.enemySpecs ?? [],
  findings: hit
    ? [
        {
          category: "survival",
          severity: "high",
          eventTypes: opts.type ? [opts.type] : [],
        },
      ]
    : [],
});

describe("patternId", () => {
  it("确定性拼接,type 升序、条件按 spec→zone", () => {
    expect(patternId("survival", ["death"], { enemySpec: 62 })).toBe(
      "cat:survival|type:death|spec:62",
    );
    expect(patternId("cooldowns", [], null)).toBe("cat:cooldowns");
  });
});

describe("scanPatterns 稳定判定", () => {
  it("窗口内 5 命中且横跨两半 → 产出;4 命中 → 不产出", () => {
    // 20 matches, hits at i=1,5,10,15,19 (spanning both halves)
    const hits = new Set([1, 5, 10, 15, 19]);
    const m5 = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m5).some((p) => p.patternId === "cat:survival")).toBe(
      true,
    );
    const m4 = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i) && i !== 10),
    );
    expect(scanPatterns(m4)).toEqual([]);
  });

  it("命中挤在窗口一半(连败尖峰)→ 不产出", () => {
    const hits = new Set([15, 16, 17, 18, 19]); // all in the most recent half
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("窗口只取最近 20 场:第 21 场以前的命中不算", () => {
    // 30 matches with every hit in the oldest 10 → 0 hits inside the window
    // (the most recent 20)
    const m = Array.from({ length: 30 }, (_, i) => mk(i, i < 10));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("type 级完全覆盖 category 级时只出 type 级", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i), { type: "death" }),
    );
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|type:death");
    expect(ids).not.toContain("cat:survival");
  });

  it("条件切片:子集命中率 ≥2× 全集且 ≥4 场 → 额外产出条件模式", () => {
    // 20 matches: 8 against mages (spec 62), 6 of which hit; the other 12 have
    // 0 hits. Full set 6/20 = 0.3, subset 6/8 = 0.75 >= 2 x 0.3 ✓
    const m = Array.from({ length: 20 }, (_, i) => {
      const vsMage = i < 8;
      // Hits span both halves: i ∈ {0,1,2,5,6,7}
      const hit = vsMage && i !== 3 && i !== 4;
      return mk(i, hit, { enemySpecs: vsMage ? [62] : [71] });
    });
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|spec:62");
  });
});

describe("measureGroup", () => {
  it("trend 按 5 场分桶(旧→新),example 取最近命中 ≤3", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    const g = measureGroup(m, "survival", [], null);
    expect(g.hits).toBe(5);
    expect(g.windowMatches).toBe(20);
    expect(g.trend).toEqual([1, 1, 1, 2]); // buckets [0-4], [5-9], [10-14], [15-19]
    expect(g.exampleMatchIds).toEqual(["m19", "m15", "m10"]);
    expect(g.spansBothHalves).toBe(true);
  });

  it("不足 20 场时窗口取实际场数", () => {
    const m = Array.from({ length: 6 }, (_, i) => mk(i, i % 2 === 0));
    const g = measureGroup(m, "survival", [], null);
    expect(g.windowMatches).toBe(6);
    expect(g.hits).toBe(3);
  });
});

describe("退役/复活谓词(滞回)", () => {
  it("≤RETIRE 退役,≥MIN_HITS 复活,中间保持", () => {
    expect(nextRuleStatus("active", RULE_RETIRE_MAX_HITS)).toBe("improved");
    expect(nextRuleStatus("improved", PATTERN_MIN_HITS)).toBe("active");
    expect(nextRuleStatus("active", 3)).toBe("active");
    expect(nextRuleStatus("improved", 3)).toBe("improved");
  });
});

describe("matchInCondition(应用侧同一谓词)", () => {
  it("null 恒真;enemySpec 要求包含;zoneId 要求相等", () => {
    expect(matchInCondition({ enemySpecs: [] }, null)).toBe(true);
    expect(matchInCondition({ enemySpecs: [62, 71] }, { enemySpec: 62 })).toBe(
      true,
    );
    expect(matchInCondition({ enemySpecs: [71] }, { enemySpec: 62 })).toBe(
      false,
    );
    expect(
      matchInCondition({ zoneId: "1552", enemySpecs: [] }, { zoneId: "1552" }),
    ).toBe(true);
    expect(matchInCondition({ enemySpecs: [] }, { zoneId: "1552" })).toBe(
      false,
    ); // zoneId unknown → conservatively does not match
  });
});
