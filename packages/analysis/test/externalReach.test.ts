import { describe, expect, it } from "vitest";

import { externalReachYards } from "../src/utils/deathOutcomeAnalysis";

// GH #34 ②: reach comes from the generated official table, not a single 40.
describe("externalReachYards (official reach table)", () => {
  it("targeted externals are 40, Time Dilation is 30", () => {
    expect(externalReachYards("33206")).toBe(40); // Pain Suppression
    expect(externalReachYards("357170")).toBe(30); // Time Dilation
  });
  it("placed areas add their radius, auras use their radius", () => {
    expect(externalReachYards("51052")).toBe(38); // Anti-Magic Zone 30 + 8
    expect(externalReachYards("97462")).toBe(40); // Rallying Cry radius
    expect(externalReachYards("31821")).toBe(40); // Aura Mastery via Devotion Aura
    expect(externalReachYards("374227")).toBe(20); // Zephyr radius
  });
  it("Darkness is the one hand value (8 yd zone), unknown ids fall back to 40", () => {
    expect(externalReachYards("196718")).toBe(8);
    expect(externalReachYards("0")).toBe(40);
  });
});
