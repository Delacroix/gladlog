import { describe, expect, it, vi } from "vitest";

// I5: lookupBehaviorPrior must fail closed (return null) when a cell's counts
// are not finite numbers, rather than rendering NaN/Infinity into the prompt.
// A malformed cell never happens in the real generated table (behaviorPrior.
// test.ts asserts real-data health separately) — this is a synthetic
// data-integrity probe, so it mocks the JSON module directly rather than
// reusing the real fixture, and lives in its own file so the mock doesn't
// shadow behaviorPrior.test.ts's real-data assertions.
vi.mock("./behaviorPriorGenerated.json", () => ({
  default: {
    meta: {},
    cells: {
      "3v3|healer|*": {
        nNoResp: NaN,
        deathNoResp: 0.1,
        nResp: 10,
        deathResp: 0.1,
        top: [],
        outcome: "ownDeath10s",
      },
      "3v3|healer|>=20%": {
        nNoResp: 999, // passes the n-floor check on its own…
        deathNoResp: Infinity, // …but this field is malformed
        nResp: 10,
        deathResp: 0.1,
        top: [],
        outcome: "ownDeath10s",
      },
      "3v3|healer|10-20%": {
        nNoResp: 999,
        deathNoResp: 0.1,
        nResp: 10,
        deathResp: 0.1,
        top: [],
        // outcome missing entirely (§1c: fail closed)
      },
      "2v2|healer|*": {
        nNoResp: 999,
        deathNoResp: 0.1,
        nResp: 10,
        deathResp: 0.1,
        top: [],
        outcome: "bogus", // §1c: fail closed on an invalid value
      },
    },
  },
}));

describe("lookupBehaviorPrior — malformed cell (I5)", () => {
  it("returns null when the star cell's nNoResp is NaN", async () => {
    const { lookupBehaviorPrior } = await import("./behaviorPrior");
    expect(lookupBehaviorPrior("3v3", "healer", 0.05)).toBeNull();
  });

  it("returns null when the fine cell passes the n-floor but another field is not finite", async () => {
    const { lookupBehaviorPrior } = await import("./behaviorPrior");
    expect(lookupBehaviorPrior("3v3", "healer", 0.3)).toBeNull();
  });

  it("returns null when the fine cell's outcome field is missing (spec §1c)", async () => {
    const { lookupBehaviorPrior } = await import("./behaviorPrior");
    expect(lookupBehaviorPrior("3v3", "healer", 0.15)).toBeNull();
  });

  it("returns null when the (star, fallback) cell's outcome field is not a valid literal (spec §1c)", async () => {
    const { lookupBehaviorPrior } = await import("./behaviorPrior");
    // 2v2 has only a star cell, no ">=20%" fine cell, so this falls back —
    // the fallback star cell's invalid outcome must still fail closed.
    expect(lookupBehaviorPrior("2v2", "healer", 0.3)).toBeNull();
  });
});
