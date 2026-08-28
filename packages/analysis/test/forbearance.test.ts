import { describe, expect, it } from "vitest";

import { spellEffectData } from "../src/data/spellEffectData";
import {
  FORBEARANCE_FALLBACK_SECONDS,
  FORBEARANCE_SECONDS,
} from "../src/utils/cooldowns";

// GH #34 batch 4: FORBEARANCE_SECONDS is an official read (DB2 25771 duration).
// If the generated table loses the row or the value moves in a patch, this
// goes red so a human re-reads the Forbearance gate instead of silently
// inheriting a new lockout length.
describe("FORBEARANCE_SECONDS (official read)", () => {
  it("reads Forbearance 25771's official duration and it equals the fallback", () => {
    expect(spellEffectData["25771"]?.durationSeconds).toBe(
      FORBEARANCE_FALLBACK_SECONDS,
    );
    expect(FORBEARANCE_SECONDS).toBe(30);
  });
});
