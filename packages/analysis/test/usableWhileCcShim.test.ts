import { describe, expect, it } from "vitest";

import { USABLE_WHILE_CC_GENERATED } from "../src/data/usableWhileCcGenerated";
import {
  USABLE_WHILE_CC_CONDITIONAL,
  USABLE_WHILE_CC_SPELL_IDS,
  usableWhileStunned,
} from "../src/utils/cooldowns";

// Task 5 (2026-08-14): USABLE_WHILE_CC_SPELL_IDS stopped being a fully
// hand-written 6-entry list and became a shim: the official generated
// "stunned" table (USABLE_WHILE_CC_GENERATED.stunned, 468 ids from DB2
// SpellMisc.Attributes) unioned with a small unconditional hand-written gap
// layer for known-usable spells the generated table hasn't captured yet.
// Style mirrors drCategories.ts (generated spread + hand gap + doc comments).
describe("USABLE_WHILE_CC_SPELL_IDS shim", () => {
  it("is a superset of the generated stunned table (union semantics)", () => {
    for (const id of USABLE_WHILE_CC_GENERATED.stunned) {
      expect(USABLE_WHILE_CC_SPELL_IDS.has(id), id).toBe(true);
    }
  });

  it("contains the unconditional gap-layer entry: Divine Protection 498/403876 (wowhead flag + 748 corpus casts-in-stun + user's own-class confirmation, 2026-08-14)", () => {
    expect(USABLE_WHILE_CC_SPELL_IDS.has("498")).toBe(true);
    expect(USABLE_WHILE_CC_SPELL_IDS.has("403876")).toBe(true);
  });

  it("contains the unconditional gap-layer entry: Thunderstorm 51490 (wowhead flag on the base spell + 321 corpus casts-in-stun + negative-result gating-talent search, Task 6 2026-08-14 user sign-off)", () => {
    expect(USABLE_WHILE_CC_SPELL_IDS.has("51490")).toBe(true);
  });

  // Old hand-written 6-entry list, per user's 2026-08-14 final ruling: 5 of 6
  // are confirmed IN the generated 468 and must survive the shim unchanged.
  it.each([
    ["642", "Divine Shield"],
    ["33206", "Pain Suppression"],
    ["22812", "Barkskin"],
    ["47585", "Dispersion"],
    ["48792", "Icebound Fortitude"],
  ])("keeps old member %s (%s) usable while stunned", (id) => {
    expect(USABLE_WHILE_CC_GENERATED.stunned.has(id), id).toBe(true);
    expect(USABLE_WHILE_CC_SPELL_IDS.has(id), id).toBe(true);
  });

  // User ruling 2026-08-14: 55233 Vampiric Blood is NOT usable while stunned
  // ("都不行"), and the corpus shows 0 casts-in-stun. The old hand list
  // wrongly included it; the shim must NOT carry that error forward.
  it("does NOT carry forward Vampiric Blood 55233 (user-ruled correction, 2026-08-14)", () => {
    expect(USABLE_WHILE_CC_GENERATED.stunned.has("55233")).toBe(false);
    expect(USABLE_WHILE_CC_SPELL_IDS.has("55233")).toBe(false);
  });
});

describe("usableWhileStunned", () => {
  it("returns true for an unconditional (generated) member, no talent context needed", () => {
    expect(usableWhileStunned("642")).toBe(true);
  });

  it("returns true for an unconditional gap-layer member, no talent context needed", () => {
    expect(usableWhileStunned("498")).toBe(true);
  });

  it("returns false for a spell in neither the unconditional set nor the conditional layer", () => {
    expect(usableWhileStunned("55233")).toBe(false);
    expect(usableWhileStunned("55233", new Set(["119996"]))).toBe(false);
  });

  it("returns true for the unconditional gap-layer member 51490 (Thunderstorm), no talent context needed", () => {
    expect(usableWhileStunned("51490")).toBe(true);
  });

  // Task 6 (2026-08-14, user-signed): 119996 (转世:转移 Transcendence: Transfer)
  // is the first real occupant of the conditional layer, gated on the
  // Mistweaver PvP talent Eminence (353584). 51490 was the other Task-5
  // placeholder candidate but research found it has no gating talent (it
  // moved to the unconditional gap layer instead, tested above) — so the
  // conditional layer is no longer empty, but still has exactly one member.
  it("conditional layer has exactly the signed 119996 entry", () => {
    expect(Object.keys(USABLE_WHILE_CC_CONDITIONAL)).toEqual(["119996"]);
    expect(USABLE_WHILE_CC_CONDITIONAL["119996"].requiresTalent).toBe("353584");
  });

  it("conditional-layer hit without talent context is conservative (false)", () => {
    expect(usableWhileStunned("119996")).toBe(false);
    expect(usableWhileStunned("119996", new Set())).toBe(false);
  });

  it("conditional-layer hit with a different talent (not the gating one) is still false", () => {
    expect(usableWhileStunned("119996", new Set(["999999"]))).toBe(false);
  });

  it("conditional-layer hit WITH the gating talent (Eminence 353584) is true", () => {
    expect(usableWhileStunned("119996", new Set(["353584"]))).toBe(true);
  });
});
