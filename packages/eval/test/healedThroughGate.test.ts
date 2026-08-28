import { describe, expect, it } from "vitest";

import { checkHealedThroughConsistency } from "../src/quality/promptQualityCheck";

const UP =
  "0:10–0:20  [DMG SPIKE]   2(AWarrior) (Arms Warrior): 0.50M in 10s (62% -> 71% HP, +1%/s — healed through)";
const DOWN =
  "0:30–0:40  [DMG SPIKE]   2(AWarrior) (Arms Warrior): 0.80M in 10s (71% -> 38% HP, -3%/s)";

describe("checkHealedThroughConsistency (GH #36 item 5 — 9th hardFailure class)", () => {
  it("word ⟺ Δ ≥ 0 on both shapes → passes", () => {
    expect(checkHealedThroughConsistency([UP, DOWN])).toEqual([]);
  });
  it("equal HP counts as healed through (Δ = 0 keeps the word)", () => {
    expect(
      checkHealedThroughConsistency([
        "0:10–0:20  [DMG SPIKE]   x (50% -> 50% HP, +0%/s — healed through)",
      ]),
    ).toEqual([]);
  });
  it("stray word on a negative delta → red", () => {
    const fails = checkHealedThroughConsistency([
      DOWN.replace(")", " — healed through)"),
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("Δ-33 < 0");
  });
  it("missing word on a non-negative delta → red (two-sided)", () => {
    const fails = checkHealedThroughConsistency([
      UP.replace(" — healed through", ""),
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("Δ9 ≥ 0");
  });
  it("lines without the HP pair and non-[DMG SPIKE] lines are out of scope", () => {
    expect(
      checkHealedThroughConsistency([
        "0:10–0:20  [DMG SPIKE]   x: 0.50M in 10s",
        "1:00  [KILL WINDOW] … healed through",
      ]),
    ).toEqual([]);
  });
});
