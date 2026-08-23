import {
  CombatUnitClass,
  CombatUnitPowerType,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  ICombatUnit,
  LogEvent,
} from "@gladlog/parser-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureAnalysisData } from "../data/ensure";
import { buildMatchTimeline, BuildMatchTimelineParams } from "./matchTimeline";

/**
 * Innervate (29166) is a MANA cooldown, and until 2026-08-23 it sat in
 * `HEALING_AMPLIFIER_SPELL_IDS` next to Power Infusion and Ascendance. That
 * path scores an amplifier's casts by `overhealPct*1000 - maxBucketHps` and
 * surfaces the WORST one, so the prompt was telling the model that a low-HPS
 * Innervate window is the mistake worth looking at — when low HPS is exactly
 * when a healer drinks.
 *
 * Measured on 200 archive files: Innervate ticks mana back through
 * SPELL_PERIODIC_ENERGIZE (258 hits) and the target's mana rises in 55 of 58
 * windows (0 fell, median +9.5pp).
 */

const INNERVATE = "29166";
const MATCH_START_MS = 0;
const MATCH_END_MS = 120_000;

function advSample(
  id: string,
  timestamp: number,
  manaCur: number,
  manaMax: number,
) {
  return {
    advancedActorPowers: [
      { type: CombatUnitPowerType.Mana, current: manaCur, max: manaMax },
    ],
    advancedActorCurrentHp: 100,
    advancedActorMaxHp: 100,
    advancedActorPositionX: 0,
    advancedActorPositionY: 0,
    advanced: true as const,
    timestamp,
    advancedActorId: id,
    logLine: { event: "ADVANCED_SAMPLE" as const, timestamp },
  };
}

function mkOwner(overrides: Partial<ICombatUnit> = {}): ICombatUnit {
  return {
    id: "o",
    name: "Druid-Ravencrest",
    ownerId: "",
    isWellFormed: true,
    type: CombatUnitType.Player,
    class: CombatUnitClass.Druid,
    spec: CombatUnitSpec.Druid_Restoration,
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

function paramsWith(owner: ICombatUnit): BuildMatchTimelineParams {
  return {
    owner,
    ownerSpec: "Druid_Restoration",
    ownerCDs: [
      {
        spellId: INNERVATE,
        spellName: "Innervate",
        tag: "Utility",
        cooldownSeconds: 180,
        maxChargesDetected: 1,
        casts: [{ timeSeconds: 30 }],
        availableWindows: [],
        neverUsed: false,
      },
    ],
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

describe("Innervate is reported as resource, not throughput", () => {
  beforeAll(async () => {
    // durationSeconds comes from the dynamically loaded official table.
    await ensureAnalysisData();
  });

  it("emits [MANA] with the before → after swing across the 8s window", () => {
    const owner = mkOwner({
      advancedActions: [
        advSample("o", MATCH_START_MS + 30_000, 22_000, 100_000), // 22%
        advSample("o", MATCH_START_MS + 38_000, 41_000, 100_000), // 41%
      ],
    });
    const timeline = buildMatchTimeline(paramsWith(owner));
    expect(timeline).toContain("[MANA]");
    expect(timeline).toContain("22% -> 41% mana (+19pp over 8s)");
  });

  it("never scores the cast on healing throughput", () => {
    const owner = mkOwner({
      advancedActions: [
        advSample("o", MATCH_START_MS + 30_000, 22_000, 100_000),
        advSample("o", MATCH_START_MS + 38_000, 41_000, 100_000),
      ],
    });
    const timeline = buildMatchTimeline(paramsWith(owner));
    const innervateBlock = timeline
      .split("\n")
      .filter((l) => /Innervate|\[MANA\]|\[HEALING\]/.test(l))
      .join("\n");
    expect(innervateBlock).not.toContain("[HEALING]");
    expect(innervateBlock).not.toContain("Overheal");
  });

  it("says so plainly when the window has no resource reading", () => {
    const timeline = buildMatchTimeline(paramsWith(mkOwner()));
    expect(timeline).toContain("[MANA]");
    expect(timeline).toContain("no resource reading");
  });
  it("PRODUCTION SHAPE: fires through the B38 promotion path, with an empty ledger", () => {
    // Innervate is normally absent from extractMajorCooldowns, so the real
    // prompt renders it from spellCastEvents via the CD>=30s promotion branch.
    // Wiring only the ledger loop passed the tests above and produced nothing
    // on any real match — this case is the one that reflects production.
    const owner = mkOwner({
      spellCastEvents: [
        {
          spellId: INNERVATE,
          spellName: "Innervate",
          timestamp: MATCH_START_MS + 30_000,
          srcUnitFlags: 0,
          destUnitFlags: 0,
          srcUnitId: "o",
          srcUnitName: "Druid-Ravencrest",
          destUnitId: "o",
          destUnitName: "Druid-Ravencrest",
          logLine: {
            event: LogEvent.SPELL_CAST_SUCCESS,
            timestamp: MATCH_START_MS + 30_000,
            parameters: [],
          },
        },
      ],
      advancedActions: [
        advSample("o", MATCH_START_MS + 30_000, 22_000, 100_000),
        advSample("o", MATCH_START_MS + 38_000, 41_000, 100_000),
      ],
    });
    const params = paramsWith(owner);
    params.ownerCDs = [];
    const timeline = buildMatchTimeline(params);
    expect(timeline).toContain("[YOU] [CD]");
    expect(timeline).toContain("Innervate");
    expect(timeline).toContain("22% -> 41% mana (+19pp over 8s)");
  });
});
