import { describe, expect, it } from "vitest";

import { consequenceGatedPriority } from "../src/utils/dispelAnalysis";

/**
 * BACKLOG #39 — user ruling A (2026-08-25): a Critical missed/late-cleanse
 * accusation must be backed by an actual consequence (postCcDamage > 0 or the
 * target dying around the window); measured-zero-consequence Critical demotes
 * to High. Paired-corpus baseline: 22/125 Critical (17.6%) carried zero
 * follow-up damage — one in five of the sternest accusations was about a
 * moment that cost nothing.
 */
describe("consequenceGatedPriority (#39 ruling A)", () => {
  it("Critical + zero damage + survived → demoted to High, marked", () => {
    expect(consequenceGatedPriority("Critical", 0, false)).toEqual({
      priority: "High",
      consequenceDemoted: true,
    });
  });

  it("Critical + real damage stays Critical", () => {
    expect(consequenceGatedPriority("Critical", 12_000, false)).toEqual({
      priority: "Critical",
      consequenceDemoted: false,
    });
  });

  it("Critical + zero damage but the target died → stays Critical (the CC secured a kill)", () => {
    expect(consequenceGatedPriority("Critical", 0, true)).toEqual({
      priority: "Critical",
      consequenceDemoted: false,
    });
  });

  it("non-Critical tiers pass through untouched — the gate only guards the top tier", () => {
    expect(consequenceGatedPriority("High", 0, false)).toEqual({
      priority: "High",
      consequenceDemoted: false,
    });
    expect(consequenceGatedPriority("Low", 0, false)).toEqual({
      priority: "Low",
      consequenceDemoted: false,
    });
  });
});
