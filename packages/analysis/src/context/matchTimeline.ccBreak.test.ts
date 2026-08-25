import {
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  ICombatUnit,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import { buildMatchTimeline, BuildMatchTimelineParams } from "./matchTimeline";

/**
 * `[CC BROKEN]` (BACKLOG #36(e)): our damage breaking CC our side had landed.
 * `analyzeCcBreaks` carried the full attribution since 2026-08-02 — the log's
 * own ground truth, SPELL_AURA_BROKEN_SPELL's src IS the breaker — but only the
 * desktop dashboard consumed it. The prompt showed the CC landing and then
 * silently ending, so the model could not tell "the sheep ran its course" from
 * "your teammate cleaved it".
 */

const MATCH_START_MS = 0;
const MATCH_END_MS = 120_000;

function mkUnit(
  id: string,
  name: string,
  reaction: CombatUnitReaction,
): ICombatUnit {
  return {
    id,
    name,
    ownerId: "",
    isWellFormed: true,
    type: CombatUnitType.Player,
    class: CombatUnitClass.Mage,
    spec: CombatUnitSpec.Mage_Frost,
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
  };
}

function paramsWith(
  ccBreakEvents: BuildMatchTimelineParams["ccBreakEvents"],
): BuildMatchTimelineParams {
  const owner = mkUnit("o", "Me-Realm", CombatUnitReaction.Friendly);
  const mate = mkUnit("m", "Mate-Realm", CombatUnitReaction.Friendly);
  const enemy = mkUnit("e", "Enemy-Realm", CombatUnitReaction.Hostile);
  return {
    owner,
    ownerSpec: "Mage_Frost",
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
    friends: [owner, mate],
    enemies: [enemy],
    matchStartMs: MATCH_START_MS,
    matchEndMs: MATCH_END_MS,
    isHealer: true,
    criticalWindowSeconds: new Set<number>(),
    ccBreakEvents,
  };
}

const breakEvent = (remainingSeconds: number | null) => ({
  atSeconds: 42,
  ccSpellId: "118",
  ccSpellName: "Polymorph",
  holderName: "Enemy-Realm",
  holderIsFriendly: false,
  casterName: "Me-Realm",
  breakerName: "Mate-Realm",
  breakerIsFriendly: true,
  breakSpellId: "1464",
  breakSpellName: "Slam",
  heldSeconds: 1.8,
  remainingSeconds,
  isRoot: false,
});

describe("[CC BROKEN] — squandered CC reaches the prompt", () => {
  it("renders breaker, break spell, CC, holder and the wasted time", () => {
    const timeline = buildMatchTimeline(paramsWith([breakEvent(3.2)]));
    const line = timeline.split("\n").find((l) => l.includes("[CC BROKEN]"));
    expect(line).toBeDefined();
    expect(line).toContain("Slam");
    expect(line).toContain("Polymorph");
    expect(line).toContain("3.2s of CC wasted");
  });

  it("unknown remaining time renders without a fabricated number", () => {
    const timeline = buildMatchTimeline(paramsWith([breakEvent(null)]));
    const line = timeline.split("\n").find((l) => l.includes("[CC BROKEN]"));
    expect(line).toBeDefined();
    expect(line).not.toContain("wasted");
  });

  it("no events → no section", () => {
    const timeline = buildMatchTimeline(paramsWith([]));
    expect(timeline).not.toContain("[CC BROKEN]");
  });
});
