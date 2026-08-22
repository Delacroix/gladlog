import { describe, expect, it } from "vitest";

import {
  aggregateGradient,
  bucketOf,
  DENOMINATOR_OF,
  MIN_BUCKET_N,
  type RoundRecord,
  wilson95,
} from "../src/explore/signalSkillGradient";

const rec = (
  bucketRating: number,
  fired: string[],
  exposure: Partial<RoundRecord["exposure"]> = {},
): RoundRecord => ({
  matchId: "m",
  seq: null,
  bracket: "3v3",
  startTime: 0,
  rating: bucketRating,
  bucket: bucketOf(bucketRating),
  win: null,
  ownerSpec: "Priest_Holy",
  durationS: 100,
  fired,
  exposure: {
    rounds: 1,
    ccOnOwner: 0,
    enemyCcOnTeam: 0,
    cleansableOnTeam: 0,
    enemyBuffsPurgeable: 0,
    friendlyDeaths: 0,
    ownerHardCasts: 0,
    friendlyDamageSpikes: 0,
    ...exposure,
  },
});

describe("bucketOf", () => {
  it("maps ratings to the feed's own tiers and rejects missing/zero", () => {
    expect(bucketOf(1400)).toBe("<1600");
    expect(bucketOf(1600)).toBe("1600-1999");
    expect(bucketOf(2399)).toBe("2000-2399");
    expect(bucketOf(3200)).toBe("2400+");
    expect(bucketOf(0)).toBeNull();
    expect(bucketOf(null)).toBeNull();
    expect(bucketOf(undefined)).toBeNull();
  });
});

describe("wilson95", () => {
  it("stays inside [0,1] at the extremes where a normal approximation would not", () => {
    const [lo, hi] = wilson95(0, 10)!;
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    const [lo2, hi2] = wilson95(10, 10)!;
    // exactly 1 in exact arithmetic; 0.999…9 in floating point
    expect(hi2).toBeCloseTo(1, 12);
    expect(lo2).toBeGreaterThan(0.6);
    expect(wilson95(0, 0)).toBeNull();
  });
});

describe("aggregateGradient — opportunity normalisation", () => {
  it("excludes zero-opportunity rounds from BOTH numerator and denominator", () => {
    // 2 rounds with CC exposure (1 fired), plus 50 rounds with no CC at all.
    const records = [
      rec(1500, ["cc-locked"], { ccOnOwner: 3 }),
      rec(1500, [], { ccOnOwner: 2 }),
      ...Array.from({ length: 50 }, () => rec(1500, [], { ccOnOwner: 0 })),
    ];
    const row = aggregateGradient(records).find((r) => r.type === "cc-locked")!;
    expect(row.denominator).toBe("ccOnOwner");
    expect(row.byBucket["<1600"]).toEqual({ triggered: 1, exposed: 2, rate: 0.5 });
  });

  it("reports the per-opportunity gradient, not the per-round one", () => {
    // Low bucket: few opportunities, converts on all of them (bad play).
    // High bucket: many opportunities, converts on half (better play) — a
    // per-ROUND rate would call the high bucket worse; per-opportunity does not.
    const low = Array.from({ length: MIN_BUCKET_N }, () => rec(1500, ["cc-locked"], { ccOnOwner: 1 }));
    const high = Array.from({ length: MIN_BUCKET_N }, (_, i) =>
      rec(2500, i % 2 === 0 ? ["cc-locked"] : [], { ccOnOwner: 5 }),
    );
    const row = aggregateGradient([...low, ...high]).find((r) => r.type === "cc-locked")!;
    expect(row.byBucket["<1600"]!.rate).toBe(1);
    expect(row.byBucket["2400+"]!.rate).toBe(0.5);
    expect(row.gradientPp).toBeCloseTo(-50, 5);
  });

  it("refuses a gradient when fewer than two buckets clear MIN_BUCKET_N", () => {
    const records = [
      ...Array.from({ length: MIN_BUCKET_N }, () => rec(1500, ["cc-locked"], { ccOnOwner: 1 })),
      ...Array.from({ length: 5 }, () => rec(2500, [], { ccOnOwner: 1 })),
    ];
    const row = aggregateGradient(records).find((r) => r.type === "cc-locked")!;
    expect(row.byBucket["2400+"]!.exposed).toBe(5);
    expect(row.gradientPp).toBeNull();
  });

  it("keeps a type with no honest denominator on `rounds` and marks it", () => {
    expect(DENOMINATOR_OF["cd-hoarded"]).toBe("rounds");
    const records = Array.from({ length: 2 }, () => rec(1500, ["cd-hoarded"]));
    const row = aggregateGradient(records).find((r) => r.type === "cd-hoarded")!;
    expect(row.byBucket["<1600"]).toEqual({ triggered: 2, exposed: 2, rate: 1 });
  });

  it("emits a row for every known signal type even when it never fired", () => {
    const rows = aggregateGradient([rec(1500, [])]);
    for (const t of Object.keys(DENOMINATOR_OF))
      expect(rows.some((r) => r.type === t), t).toBe(true);
  });
});
