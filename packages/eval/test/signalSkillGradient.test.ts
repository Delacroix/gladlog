import { describe, expect, it } from "vitest";

import {
  aggregateGradient,
  formatStratifiedReport,
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
    enemyHighValuePurgeables: 0,
    friendlyDeaths: 0,
    ownerHardCasts: 0,
    friendlyDamageSpikes: 0,
    crisisWindows: 0,
    ownerMajorCdCasts: 0,
    ownerMajorCdsInKit: 0,
    ownerExternalCasts: 0,
    teamOffensiveCdCasts: 0,
    enemyCyclones: 0,
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
    expect(row.byBucket["<1600"]).toEqual({
      triggered: 1,
      exposed: 2,
      rate: 0.5,
    });
  });

  it("reports the per-opportunity gradient, not the per-round one", () => {
    // Low bucket: few opportunities, converts on all of them (bad play).
    // High bucket: many opportunities, converts on half (better play) — a
    // per-ROUND rate would call the high bucket worse; per-opportunity does not.
    const low = Array.from({ length: MIN_BUCKET_N }, () =>
      rec(1500, ["cc-locked"], { ccOnOwner: 1 }),
    );
    const high = Array.from({ length: MIN_BUCKET_N }, (_, i) =>
      rec(2500, i % 2 === 0 ? ["cc-locked"] : [], { ccOnOwner: 5 }),
    );
    const row = aggregateGradient([...low, ...high]).find(
      (r) => r.type === "cc-locked",
    )!;
    expect(row.byBucket["<1600"]!.rate).toBe(1);
    expect(row.byBucket["2400+"]!.rate).toBe(0.5);
    expect(row.gradientPp).toBeCloseTo(-50, 5);
  });

  it("refuses a gradient when fewer than two buckets clear MIN_BUCKET_N", () => {
    const records = [
      ...Array.from({ length: MIN_BUCKET_N }, () =>
        rec(1500, ["cc-locked"], { ccOnOwner: 1 }),
      ),
      ...Array.from({ length: 5 }, () => rec(2500, [], { ccOnOwner: 1 })),
    ];
    const row = aggregateGradient(records).find((r) => r.type === "cc-locked")!;
    expect(row.byBucket["2400+"]!.exposed).toBe(5);
    expect(row.gradientPp).toBeNull();
  });

  it("keeps a type with no honest denominator on `rounds` and marks it", () => {
    // cc-held still has none: it needs "offensive windows where a CC was worth
    // pressing", which no cheap event tally gives.
    expect(DENOMINATOR_OF["cc-held"] ?? "rounds").toBe("rounds");
    const records = Array.from({ length: 2 }, () => rec(1500, ["cc-held"]));
    const row = aggregateGradient(records).find((r) => r.type === "cc-held")!;
    expect(row.byBucket["<1600"]).toEqual({
      triggered: 2,
      exposed: 2,
      rate: 1,
    });
  });

  it("normalises cd-hoarded by crisis windows, not by rounds (first-run defect)", () => {
    // The 2026-08-22 first pass reported cd-hoarded +11.3pp measured against
    // rounds — i.e. against nothing. A round with no crisis is no evidence.
    expect(DENOMINATOR_OF["cd-hoarded"]).toBe("crisisWindows");
    const records = [
      rec(1500, ["cd-hoarded"], { crisisWindows: 2 }),
      rec(1500, [], { crisisWindows: 1 }),
      ...Array.from({ length: 20 }, () => rec(1500, [], { crisisWindows: 0 })),
    ];
    const row = aggregateGradient(records).find(
      (r) => r.type === "cd-hoarded",
    )!;
    expect(row.byBucket["<1600"]).toEqual({
      triggered: 1,
      exposed: 2,
      rate: 0.5,
    });
  });

  it("cd-waste is rated per cooldown owned, not per round (a per-round rate degrades to `rounds`)", () => {
    // First pass measured cd-waste at +5.2pp against ownerMajorCdsInKit, which
    // is nonzero for every healer every round — i.e. against nothing. Per-unit
    // mode divides EVENTS by cooldowns owned instead.
    const records = [
      {
        ...rec(1500, ["cd-waste"], { ownerMajorCdsInKit: 6 }),
        counts: { "cd-waste": 3 },
      },
      {
        ...rec(1500, ["cd-waste"], { ownerMajorCdsInKit: 4 }),
        counts: { "cd-waste": 1 },
      },
    ];
    const row = aggregateGradient(records).find((r) => r.type === "cd-waste")!;
    // 4 wasted cooldowns out of 10 owned — not "2 of 2 rounds fired"
    expect(row.byBucket["<1600"]).toEqual({
      triggered: 4,
      exposed: 10,
      rate: 0.4,
    });
  });

  it("falls back to the fired flag when a record predates per-type counts", () => {
    const row = aggregateGradient([
      rec(1500, ["cd-waste"], { ownerMajorCdsInKit: 5 }),
    ]).find((r) => r.type === "cd-waste")!;
    expect(row.byBucket["<1600"]).toEqual({
      triggered: 1,
      exposed: 5,
      rate: 0.2,
    });
  });

  it("missed-purge is normalised by high-value purgeables, not by every dispellable buff", () => {
    expect(DENOMINATOR_OF["missed-purge"]).toBe("enemyHighValuePurgeables");
  });

  it("emits a row for every known signal type even when it never fired", () => {
    const rows = aggregateGradient([rec(1500, [])]);
    for (const t of Object.keys(DENOMINATOR_OF))
      expect(
        rows.some((r) => r.type === t),
        t,
      ).toBe(true);
  });
});

describe("stratification (Simpson's paradox guard)", () => {
  // 2026-08-22, the first real run: death-unused-defensive was −9.6pp pooled and
  // +0.1pp inside Rated Solo Shuffle, because the bracket mix moves with rating
  // and the signal fires ~3x more in 2v2/3v3. This pins the shape of that trap.
  const mk = (bracket: string, rating: number, fired: string[]) => ({
    ...rec(rating, fired, { friendlyDeaths: 1 }),
    bracket,
  });
  const records = [
    // Shuffle: flat 10% at both ends
    ...Array.from({ length: 1000 }, (_, i) =>
      mk(
        "Rated Solo Shuffle",
        1500,
        i % 10 === 0 ? ["death-unused-defensive"] : [],
      ),
    ),
    ...Array.from({ length: 1000 }, (_, i) =>
      mk(
        "Rated Solo Shuffle",
        2500,
        i % 10 === 0 ? ["death-unused-defensive"] : [],
      ),
    ),
    // 2v2: also flat, but at 50% — and it is nearly all low-rated
    ...Array.from({ length: 1000 }, (_, i) =>
      mk("2v2", 1500, i % 2 === 0 ? ["death-unused-defensive"] : []),
    ),
    ...Array.from({ length: 100 }, (_, i) =>
      mk("2v2", 2500, i % 2 === 0 ? ["death-unused-defensive"] : []),
    ),
  ];
  it("pooling invents a negative gradient that neither bracket has", () => {
    const pooled = aggregateGradient(records).find(
      (r) => r.type === "death-unused-defensive",
    )!;
    expect(pooled.gradientPp!).toBeLessThan(-10); // the artifact
    for (const bracket of ["Rated Solo Shuffle", "2v2"]) {
      const within = aggregateGradient(
        records.filter((r) => r.bracket === bracket),
      ).find((r) => r.type === "death-unused-defensive")!;
      expect(within.gradientPp!, bracket).toBeCloseTo(0, 5);
    }
  });
  it("the stratified report never prints a pooled row and skips thin strata", () => {
    const md = formatStratifiedReport(records, "meta", 1000);
    expect(md).toContain("## Rated Solo Shuffle");
    expect(md).toContain("## 2v2");
    expect(md).not.toContain("pooled row");
    const thin = formatStratifiedReport(
      records.filter((r) => r.bracket === "2v2"),
      "meta",
      5000,
    );
    expect(thin).toContain("skipped");
  });
});
