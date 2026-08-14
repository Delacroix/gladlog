import { describe, expect, it } from "vitest";
import {
  CURATED_ABILITY_FACTS,
  PROPOSED_FACTS,
} from "../src/data/curatedAbilityFacts";

describe("curated ability facts sign-off", () => {
  it("every entry carries a user approval stamp", () => {
    for (const f of CURATED_ABILITY_FACTS) {
      expect(f.approved, `${f.id} ${f.claim}`).toMatch(
        /^\d{4}-\d{2}-\d{2} user$/,
      );
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = CURATED_ABILITY_FACTS.map(
      (f) => `${f.kind}:${f.id}:${f.claim}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("proposed ability facts (pending sign-off, not CI-enforced)", () => {
  it("carries no approval stamp yet (would be a lie if it did)", () => {
    for (const f of PROPOSED_FACTS) {
      expect("approved" in f, `${f.id} ${f.claim}`).toBe(false);
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = PROPOSED_FACTS.map((f) => `${f.kind}:${f.id}:${f.claim}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
