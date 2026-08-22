import { describe, expect, it } from "vitest";

import { CURATED_ID_TABLES } from "../src/data/curatedIdRegistry";

// The registry is the index the Curated-List Completeness Rule's reverse pass
// runs over. A table that yields nothing, or yields non-ids, would be silently
// "100% healthy" in the scan — pin the shape so the scan cannot lie by omission.
describe("CURATED_ID_TABLES", () => {
  it("has unique names and every table yields at least one numeric id", () => {
    const names = CURATED_ID_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CURATED_ID_TABLES) {
      const ids = t.ids();
      expect(ids.length, t.name).toBeGreaterThan(0);
      for (const id of ids) expect(id, `${t.name}: ${id}`).toMatch(/^\d+$/);
    }
  });
  it("covers the lists that have already rotted once (GH #23 class)", () => {
    // Each of these silently swallowed official data or went stale in 2026-07/08.
    for (const n of ["DISPEL_PENALTY_SPELLS", "TALENT_BEHAVIORS", "SPELL_CATEGORIES", "RACIAL_ABILITIES"])
      expect(CURATED_ID_TABLES.some((t) => t.name === n), n).toBe(true);
  });
});
