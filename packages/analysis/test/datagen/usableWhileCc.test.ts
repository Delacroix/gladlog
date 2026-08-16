import { describe, expect, it } from "vitest";

import { UWC_ANCHORS } from "../../scripts/datagen/usableWhileCcAnchors";
import { USABLE_WHILE_CC_GENERATED } from "../../src/data/usableWhileCcGenerated";

// Scope decision, 2026-08-14 (task-3-report.md): only "stunned" resolves to
// a unique (<=2-bit) SpellMisc.Attributes union. "feared" is structurally
// impossible via <=2-bit OR-union (exhaustive search, 0 solutions -- a
// consequence of pure union semantics, not missing search effort).
// "confused" has 35 tied 2-bit solutions narrowing only to 10 -- the 13
// signed anchors are insufficient to disambiguate further. Both remain a
// documented gap on the hand-written layer (cooldowns.ts
// USABLE_WHILE_CC_SPELL_IDS) pending Task 4's corpus-driven evidence; their
// anchor cells stay in UWC_ANCHORS for that future work, so this test does
// not assert against them (there is nothing generated to assert against).
describe("usableWhileCcGenerated anchors", () => {
  it("every signed stunned anchor matches the generated set", () => {
    for (const a of UWC_ANCHORS) {
      if (a.stunned !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.stunned.has(a.spellId),
          `${a.name} stunned`,
        ).toBe(a.stunned);
    }
  });
  it("the stunned set is non-trivial (>20 spells at current build)", () => {
    expect(USABLE_WHILE_CC_GENERATED.stunned.size).toBeGreaterThan(20);
  });
});
