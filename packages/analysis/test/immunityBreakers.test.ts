import { describe, expect, it } from "vitest";
import { CombatUnitClass } from "@gladlog/parser-compat";
import {
  enemyHoldsImmunityBreakerAt,
  enemyImmunityBreakers,
  IMMUNITY_BREAKERS,
} from "../src/analysis/candidates/death";
import { bracketKey } from "../src/utils/bracketKey";

describe("immunity breakers (GH #18 ruling (c), 2026-08-30)", () => {
  it("an enemy warrior holds Shattering Throw until it is cast; it is back after the cooldown", () => {
    const warrior = {
      class: CombatUnitClass.Warrior,
      spellCastEvents: [{ spellId: "64382", timestamp: 100_000 + 50_000 }],
    };
    const br = enemyImmunityBreakers([warrior], 100_000);
    expect(br).toEqual([{ spellId: "64382", castTimesS: [50] }]);
    expect(enemyHoldsImmunityBreakerAt(br, 40)).toBe(true); // not yet spent
    expect(enemyHoldsImmunityBreakerAt(br, 60)).toBe(false); // spent 10 s ago
    expect(enemyHoldsImmunityBreakerAt(br, 50 + 180 + 1)).toBe(true); // back
  });
  it("a team without a warrior or priest holds nothing", () => {
    expect(
      enemyImmunityBreakers(
        [{ class: CombatUnitClass.Mage, spellCastEvents: [] }],
        0,
      ),
    ).toEqual([]);
    expect(enemyHoldsImmunityBreakerAt([], 10)).toBe(false);
  });
  it("table shape: two breakers, both with a class", () => {
    expect(IMMUNITY_BREAKERS.map((b) => b.spellId).sort()).toEqual([
      "32375",
      "64382",
    ]);
  });
});

describe("bracketKey (shared bracket predicate)", () => {
  it("maps the raw strings", () => {
    expect(bracketKey("2v2")).toBe("2v2");
    expect(bracketKey("3v3")).toBe("3v3");
    expect(bracketKey("Rated Solo Shuffle")).toBe("solo");
    expect(bracketKey("Rated BG Blitz")).toBeNull();
    expect(bracketKey(undefined)).toBeNull();
  });
});
