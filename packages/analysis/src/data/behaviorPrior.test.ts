import { describe, expect, it } from "vitest";

// I4 (test-only import): `dmgBinOf`'s "10%" boundary is a hardcoded 0.1 in
// behaviorPrior.ts (a data/ → analysis/ import would cycle), coupled to
// `crisisDecisionPoints.ts`'s CRISIS_MIN_DMG2S by convention, not by import.
// This test is the only thing that would go red if the two drifted apart.
import { CRISIS_MIN_DMG2S } from "../analysis/crisisDecisionPoints";
import {
  BEHAVIOR_PRIOR_N_FLOOR,
  dmgBinOf,
  lookupBehaviorPrior,
} from "./behaviorPrior";
import raw from "./behaviorPriorGenerated.json";

describe("behaviorPrior lookup", () => {
  it("every bracket has a star cell with nNoResp ≥ floor (table health — regenerate when red)", () => {
    for (const b of ["Rated Solo Shuffle", "2v2", "3v3"]) {
      const c = (raw as any).cells[`${b}|healer|*`];
      expect(c, b).toBeDefined();
      expect(c.nNoResp).toBeGreaterThanOrEqual(BEHAVIOR_PRIOR_N_FLOOR);
    }
  });

  it("returns the fine cell when nNoResp ≥ floor, integer death%/top%", () => {
    const ref = lookupBehaviorPrior("Rated Solo Shuffle", "healer", 0.3)!;
    expect(ref.cellKey).toBe("Rated Solo Shuffle|healer|>=20%");
    expect(Number.isInteger(ref.deathNoRespPct)).toBe(true);
    expect(Number.isInteger(ref.deathRespPct)).toBe(true);
    expect(ref.top.every(([, p]) => Number.isInteger(p))).toBe(true);
  });
  it("falls back to the star cell when the fine cell's nNoResp is thin, and says so", () => {
    const fine = (raw as any).cells["3v3|healer|<10%"];
    const ref = lookupBehaviorPrior("3v3", "healer", 0.05)!;
    if (fine && fine.nNoResp >= BEHAVIOR_PRIOR_N_FLOOR)
      expect(ref.fellBack).toBe(false);
    else {
      expect(ref.fellBack).toBe(true);
      expect(ref.cellKey).toBe("3v3|healer|*");
    }
  });
  it("unknown bracket → null", () => {
    expect(lookupBehaviorPrior("Skirmish", "healer", 0.3)).toBeNull();
  });
  it("dmgBinOf boundaries", () => {
    expect(dmgBinOf(0.099)).toBe("<10%");
    expect(dmgBinOf(0.1)).toBe("10-20%");
    expect(dmgBinOf(0.2)).toBe(">=20%");
  });
  it("I4: dmgBinOf's floor is coupled to CRISIS_MIN_DMG2S — below the floor never enters the danger bins, and the '<10%' bin label spells out the floor's value", () => {
    expect(dmgBinOf(CRISIS_MIN_DMG2S)).not.toBe("<10%");
    expect("<10%").toBe(`<${CRISIS_MIN_DMG2S * 100}%`);
  });
});
