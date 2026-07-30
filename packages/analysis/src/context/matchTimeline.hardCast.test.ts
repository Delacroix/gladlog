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
 * F170 回归锚(2026-07-29):`[ENEMY HARD CAST]` 曾读 `enemy.spellCastEvents`
 * 过滤 SPELL_CAST_START —— 但新 L3 parser 把 START 拆到了独立的
 * `castStartEvents`,`spellCastEvents` 只剩 SUCCESS,过滤器永远空转
 * (实测 60 场抽样 0/178 场产出;调查见 /tmp/f170-investigation.md)。
 * 这两条测试锁住修复后的字段来源:白名单 START 事件在 castStartEvents 里
 * 才产出该行,单独躺在 spellCastEvents 里的 SUCCESS 事件不产出。
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
