import { describe, expect, it } from "vitest";

import raw from "./behaviorPriorGenerated.json";
import {
  BEHAVIOR_PRIOR_N_FLOOR,
  dmgBinOf,
  lookupBehaviorPrior,
} from "./behaviorPrior";

describe("behaviorPrior lookup", () => {
  it("every bracket has a star cell with n ≥ floor (table health — regenerate when red)", () => {
    for (const b of ["Rated Solo Shuffle", "2v2", "3v3"]) {
      const c = (raw as any).cells[`${b}|healer|*`];
      expect(c, b).toBeDefined();
      expect(c.n).toBeGreaterThanOrEqual(BEHAVIOR_PRIOR_N_FLOOR);
    }
  });
  it("returns the fine cell when n ≥ floor, integer percentages", () => {
    const ref = lookupBehaviorPrior("Rated Solo Shuffle", "healer", 0.3)!;
    expect(ref.cellKey).toBe("Rated Solo Shuffle|healer|>=20%");
    expect(Number.isInteger(ref.respondPct)).toBe(true);
    expect(ref.top.every(([, p]) => Number.isInteger(p))).toBe(true);
  });
  it("falls back to the star cell when the fine cell is thin, and says so", () => {
    const fine = (raw as any).cells["3v3|healer|<10%"];
    const ref = lookupBehaviorPrior("3v3", "healer", 0.05)!;
    if (fine && fine.n >= BEHAVIOR_PRIOR_N_FLOOR)
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
});
