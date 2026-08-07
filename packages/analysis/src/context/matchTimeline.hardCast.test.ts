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
 * F170 regression anchor (2026-07-29): `[ENEMY HARD CAST]` used to read
 * `enemy.spellCastEvents` and filter for SPELL_CAST_START -- but the new L3
 * parser splits START out into a separate `castStartEvents`, leaving only
 * SUCCESS in `spellCastEvents`, so the filter always came up empty (measured:
 * 0 of 178 matches produced the line across a 60-match sample; investigation in
 * /tmp/f170-investigation.md).
 * These two tests lock down the post-fix field source: a whitelisted START
 * event produces the line only when it is in castStartEvents, and a SUCCESS
 * event sitting alone in spellCastEvents produces nothing.
 */

const CHAOS_BOLT_ID = "116858";

function mkUnit(
  id: string,
  name: string,
  reaction: CombatUnitReaction,
  spec: CombatUnitSpec,
  overrides: Partial<ICombatUnit> = {},
): ICombatUnit {
  return {
    id,
    name,
    ownerId: "",
    isWellFormed: true,
    type: CombatUnitType.Player,
    class: CombatUnitClass.Mage,
    spec,
    reaction,
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

const MATCH_START_MS = 0;
const MATCH_END_MS = 60_000;

function baseParams(
  owner: ICombatUnit,
  enemy: ICombatUnit,
): BuildMatchTimelineParams {
  return {
    owner,
    ownerSpec: "Priest_Discipline",
    ownerCDs: [],
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
    enemies: [enemy],
    matchStartMs: MATCH_START_MS,
    matchEndMs: MATCH_END_MS,
    isHealer: true,
    criticalWindowSeconds: new Set<number>(),
  };
}

describe("F170 [ENEMY HARD CAST]", () => {
  it("白名单技能出现在 castStartEvents(START)时产出该行", () => {
    const owner = mkUnit(
      "o",
      "Healer-Area52",
      CombatUnitReaction.Friendly,
      CombatUnitSpec.Priest_Discipline,
      { class: CombatUnitClass.Priest },
    );
    const enemy = mkUnit(
      "e",
      "Emage-Area52",
      CombatUnitReaction.Hostile,
      CombatUnitSpec.Warlock_Destruction,
      {
        class: CombatUnitClass.Warlock,
        spellCastEvents: [],
        castStartEvents: [
          {
            spellId: CHAOS_BOLT_ID,
            spellName: "Chaos Bolt",
            timestamp: MATCH_START_MS + 5_000,
            srcUnitFlags: 0,
            destUnitFlags: 0,
            srcUnitId: "e",
            srcUnitName: "Emage-Area52",
            destUnitId: "o",
            destUnitName: "Healer-Area52",
            logLine: {
              event: LogEvent.SPELL_CAST_START,
              timestamp: MATCH_START_MS + 5_000,
              parameters: [],
              lineIndex: 0,
            },
          },
        ],
      },
    );

    const timeline = buildMatchTimeline(baseParams(owner, enemy));

    expect(timeline).toContain("[ENEMY HARD CAST]");
    expect(timeline).toContain("Chaos Bolt");
  });

  it("同一法术只在 spellCastEvents(SUCCESS)里、没有 castStartEvents 时不产出", () => {
    const owner = mkUnit(
      "o",
      "Healer-Area52",
      CombatUnitReaction.Friendly,
      CombatUnitSpec.Priest_Discipline,
      { class: CombatUnitClass.Priest },
    );
    const enemy = mkUnit(
      "e",
      "Emage-Area52",
      CombatUnitReaction.Hostile,
      CombatUnitSpec.Warlock_Destruction,
      {
        class: CombatUnitClass.Warlock,
        castStartEvents: [],
        spellCastEvents: [
          {
            spellId: CHAOS_BOLT_ID,
            spellName: "Chaos Bolt",
            timestamp: MATCH_START_MS + 5_000,
            srcUnitFlags: 0,
            destUnitFlags: 0,
            srcUnitId: "e",
            srcUnitName: "Emage-Area52",
            destUnitId: "o",
            destUnitName: "Healer-Area52",
            logLine: {
              event: LogEvent.SPELL_CAST_SUCCESS,
              timestamp: MATCH_START_MS + 5_000,
              parameters: [],
              lineIndex: 0,
            },
          },
        ],
      },
    );

    const timeline = buildMatchTimeline(baseParams(owner, enemy));

    expect(timeline).not.toContain("[ENEMY HARD CAST]");
  });
});
