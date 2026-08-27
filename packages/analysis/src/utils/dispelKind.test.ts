import { describe, expect, it } from "vitest";

import {
  addCastToIndex,
  buildCastMatchIndex,
  classifyDispel,
  createCastMatchIndex,
  DISPEL_CAST_MATCH_WINDOW_MS,
  MOVEMENT_ROOT_BREAK_DISPEL_IDS,
} from "./dispelKind";

const PET = "Pet-0-1234";
const PLAYER = "Player-1-ABCD";

describe("classifyDispel (UI review 2026-08-21 #3)", () => {
  it("cast-matched by id within the window → deliberate", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PLAYER, "527", "Purify", 10_000);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "527",
        spellName: "Purify",
        timestamp: 10_400,
      }),
    ).toBe("deliberate");
  });

  it("no cast from that source → proc (Cleanse the Weak shape)", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PLAYER, "19750", "Flash of Light", 10_000);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "199427",
        spellName: "Cleanse the Weak",
        timestamp: 10_050,
      }),
    ).toBe("proc");
  });

  it("outside the ±window → proc", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PLAYER, "527", "Purify", 10_000);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "527",
        spellName: "Purify",
        timestamp: 10_000 + DISPEL_CAST_MATCH_WINDOW_MS + 1,
      }),
    ).toBe("proc");
  });

  it("name match covers the Mass Dispel effect id (32592 vs cast 32375)", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PLAYER, "32375", "Mass Dispel", 10_000);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "32592",
        spellName: "Mass Dispel",
        timestamp: 10_300,
      }),
    ).toBe("deliberate");
  });

  it("pet dispel matches the pet's own cast, not the owner's", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PET, "19505", "Devour Magic", 10_000);
    expect(
      classifyDispel(idx, {
        srcUnitId: PET,
        spellId: "19505",
        spellName: "Devour Magic",
        timestamp: 10_100,
      }),
    ).toBe("deliberate");
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "19505",
        spellName: "Devour Magic",
        timestamp: 10_100,
      }),
    ).toBe("proc");
  });

  it("cast-matched but a movement/form rider → rider", () => {
    const idx = createCastMatchIndex();
    addCastToIndex(idx, PLAYER, "768", "Cat Form", 10_000);
    expect(MOVEMENT_ROOT_BREAK_DISPEL_IDS.has("768")).toBe(true);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "768",
        spellName: "Cat Form",
        timestamp: 10_000,
      }),
    ).toBe("rider");
  });

  it("rider id without a cast is still rider, not proc (the list wins)", () => {
    const idx = createCastMatchIndex();
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "114239",
        spellName: "Phantasm",
        timestamp: 10_000,
      }),
    ).toBe("rider");
  });
});

describe("buildCastMatchIndex (GH #32 — shared by product and the corpus-gate generator)", () => {
  it("indexes only SPELL_CAST_SUCCESS, keyed on the raw source GUID with unit id as fallback", () => {
    const idx = buildCastMatchIndex([
      {
        id: PLAYER,
        spellCastEvents: [
          {
            logLine: { event: "SPELL_CAST_SUCCESS" },
            srcUnitId: PLAYER,
            spellId: "527",
            spellName: "Purify",
            timestamp: 10_000,
          },
          // a cast START must not count as a decision
          {
            logLine: { event: "SPELL_CAST_START" },
            srcUnitId: PLAYER,
            spellId: "527",
            spellName: "Purify",
            timestamp: 20_000,
          },
          // missing srcUnitId falls back to the unit id
          {
            logLine: { event: "SPELL_CAST_SUCCESS" },
            spellId: "19505",
            spellName: "Devour Magic",
            timestamp: 30_000,
          },
        ],
      },
    ]);
    expect(idx.byId.get(`${PLAYER}|527`)).toEqual([10_000]);
    expect(idx.byName.get(`${PLAYER}|Purify`)).toEqual([10_000]);
    expect(idx.byId.get(`${PLAYER}|19505`)).toEqual([30_000]);
    expect(
      classifyDispel(idx, {
        srcUnitId: PLAYER,
        spellId: "527",
        spellName: "Purify",
        timestamp: 20_300,
      }),
    ).toBe("proc");
  });
});
