import {
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  ICombatUnit,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import { buildMatchTimeline, BuildMatchTimelineParams } from "./matchTimeline";

/**
 * `[EMPOWER L?]` on the owner's empowered casts (BACKLOG #39 wiring of
 * SPELL_EMPOWER_END). S2 archive: Dream Breath releases at L1 87% of the time
 * (774/20/104) — without the tag every release renders identically. All owner
 * render paths are pinned (ledger + general loop), per the Innervate lesson:
 * a note wired into one path passes unit tests and never fires in production.
 */

const DREAM_BREATH = "355936";
const MATCH_START_MS = 0;
const MATCH_END_MS = 120_000;

function mkUnit(
  id: string,
  name: string,
  overrides: Partial<ICombatUnit> = {},
): ICombatUnit {
  return {
    id,
    name,
    ownerId: "",
    isWellFormed: true,
    type: CombatUnitType.Player,
    class: CombatUnitClass.Evoker,
    spec: CombatUnitSpec.Evoker_Preservation,
    reaction: CombatUnitReaction.Friendly,
    damageIn: [],
    damageOut: [],
    healIn: [],
    healOut: [],
    absorbsIn: [],
    absorbsOut: [],
    auraEvents: [],
    spellCastEvents: [],
    castStartEvents: [],
    petSpellCastEvents: [],
    actionIn: [],
    actionOut: [],
    deathRecords: [],
    advancedActions: [],
    ...overrides,
  };
}

const cast = (spellId: string, spellName: string, t: number) => ({
  spellId,
  spellName,
  timestamp: t,
  srcUnitFlags: 0,
  destUnitFlags: 0,
  srcUnitId: "o",
  srcUnitName: "Voker-Realm",
  destUnitId: "o",
  destUnitName: "Voker-Realm",
  logLine: {
    event: LogEvent.SPELL_CAST_SUCCESS,
    timestamp: t,
    parameters: [],
  },
});

const empowerEnd = (
  spellId: string,
  spellName: string,
  t: number,
  level: number,
) => ({
  spellId,
  spellName,
  timestamp: t,
  srcUnitFlags: 0,
  destUnitFlags: 0,
  srcUnitId: "o",
  srcUnitName: "Voker-Realm",
  destUnitId: "",
  destUnitName: "",
  level,
  logLine: {
    event: "SPELL_EMPOWER_END" as LogEvent,
    timestamp: t,
    parameters: [],
  },
});

function baseParams(
  owner: ICombatUnit,
  ownerCDs: BuildMatchTimelineParams["ownerCDs"] = [],
): BuildMatchTimelineParams {
  return {
    owner,
    ownerSpec: "Evoker_Preservation",
    ownerCDs,
    teammateCDs: [],
    enemyCDTimeline: { players: [], alignedBurstWindows: [] },
    ccTrinketSummaries: [],
    dispelSummary: {
      allyCleanse: [],
      ourPurges: [],
      hostilePurges: [],
      missedCleanseWindows: [],
      lateCleanseWindows: [],
      ccEfficiency: [],
      missedPurgeWindows: [],
    },
    friendlyDeaths: [],
    enemyDeaths: [],
    pressureWindows: [],
    healingGaps: [],
    friends: [owner],
    enemies: [],
    matchStartMs: MATCH_START_MS,
    matchEndMs: MATCH_END_MS,
    isHealer: true,
    criticalWindowSeconds: new Set<number>(),
  };
}

describe("[EMPOWER L?] on the owner's empowered casts", () => {
  it("cooldown-ledger path carries the release level", () => {
    const owner = mkUnit("o", "Voker-Realm", {
      // END fires ~0.8s before the cast completes in real logs; same-instant
      // here, the window is ±1.5s either way.
      empowerEnds: [
        empowerEnd(DREAM_BREATH, "Dream Breath", 30_000, 3),
      ] as never,
    });
    const timeline = buildMatchTimeline(
      baseParams(owner, [
        {
          spellId: DREAM_BREATH,
          spellName: "Dream Breath",
          tag: "Heal",
          cooldownSeconds: 30,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 30 }],
          availableWindows: [],
          neverUsed: false,
        },
      ]),
    );
    expect(timeline).toContain("[EMPOWER L3]");
  });

  it("general cast path (no ledger entry): tagged, and the tag breaks the fold", () => {
    const owner = mkUnit("o", "Voker-Realm", {
      spellCastEvents: [
        cast(DREAM_BREATH, "Dream Breath", 30_000),
        cast(DREAM_BREATH, "Dream Breath", 45_000),
      ] as never,
      empowerEnds: [
        empowerEnd(DREAM_BREATH, "Dream Breath", 29_400, 1),
        empowerEnd(DREAM_BREATH, "Dream Breath", 44_400, 3),
      ] as never,
    });
    const timeline = buildMatchTimeline(baseParams(owner));
    expect(timeline).toContain("[EMPOWER L1]");
    expect(timeline).toContain("[EMPOWER L3]");
  });

  it("a cast with no matching END gets no tag; one END is consumed once", () => {
    const owner = mkUnit("o", "Voker-Realm", {
      spellCastEvents: [
        cast(DREAM_BREATH, "Dream Breath", 30_000),
        cast(DREAM_BREATH, "Dream Breath", 31_200), // within 1.5s of the same END
      ] as never,
      empowerEnds: [
        empowerEnd(DREAM_BREATH, "Dream Breath", 30_000, 2),
      ] as never,
    });
    const timeline = buildMatchTimeline(baseParams(owner));
    const tagged = timeline
      .split("\n")
      .filter((l) => l.includes("[EMPOWER")).length;
    expect(tagged).toBe(1);
  });
});
