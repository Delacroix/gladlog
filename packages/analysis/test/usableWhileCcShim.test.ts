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

  it("the conditional layer is empty for now (data lands at Task 6, structure lands here)", () => {
    expect(Object.keys(USABLE_WHILE_CC_CONDITIONAL)).toHaveLength(0);
  });

  it("conditional-layer hit without talent context is conservative (false) — direction documented once the layer gets data", () => {
    // Structural check: since the layer is empty today, no id maps to a
    // conditional entry, so every lookup falls through to the false branch
    // regardless of pvpTalentIds. This pins the fallthrough behavior itself.
    expect(usableWhileStunned("119996")).toBe(false);
    expect(usableWhileStunned("119996", new Set())).toBe(false);
  });
});
