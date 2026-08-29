import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  CRISIS_HP_PCT,
  crisisDecisionPoints,
  RESPONSE_WINDOW_MS,
} from "./crisisDecisionPoints";

const T0 = 1_000_000;
const hp = (t: number, cur: number, max = 100, x = 0, y = 0) => ({
  timestamp: T0 + t,
  advancedActorCurrentHp: cur,
  advancedActorMaxHp: max,
  advancedActorPositionX: x,
  advancedActorPositionY: y,
});
function unit(over: Record<string, unknown> = {}) {
  return {
    id: "H",
    name: "Heals-R",
    reaction: CombatUnitReaction.Friendly,
    info: { teamId: "0" },
    advancedActions: [hp(0, 100), hp(1000, 70), hp(2000, 38), hp(3000, 35)],
    damageIn: [
      {
        timestamp: T0 + 1500,
        srcUnitId: "E1",
        amount: -30,
        effectiveAmount: -30,
      },
    ],
    healIn: [],
    healOut: [],
    spellCastEvents: [],
    auraEvents: [],
    actionIn: [],
    deathRecords: [],
    ...over,
  };
}
function combat(owner: any, others: any[] = []) {
  const units: Record<string, any> = { [owner.id]: owner };
  for (const u of others) units[u.id] = u;
  return {
    startTime: T0,
    endTime: T0 + 60_000,
    units,
    startInfo: { bracket: "3v3" },
  };
}
const enemy = (id = "E1", extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  reaction: CombatUnitReaction.Hostile,
  info: { teamId: "1" },
  spellCastEvents: [],
  advancedActions: [],
  ...extra,
});

describe("crisisDecisionPoints", () => {
  it("emits one point at the downward crossing of CRISIS_HP_PCT with dmg2s and attackers", () => {
    const o = unit();
    const pts = crisisDecisionPoints(o, combat(o, [enemy()]));
    expect(pts).toHaveLength(1);
    expect(pts[0]!.hpPct).toBe(38);
    expect(pts[0]!.tSec).toBe(2);
    expect(pts[0]!.dmg2s).toBe(0.3);
    expect(pts[0]!.attackers2s).toBe(1);
    expect(CRISIS_HP_PCT).toBe(0.4);
  });

  it("merges a second crossing inside CRISIS_WINDOW_GAP_MS, keeps one after it", () => {
    const o = unit({
      advancedActions: [
        hp(0, 100),
        hp(1000, 38),
        hp(2000, 45),
        hp(3000, 39),
        hp(9000, 60),
        hp(10000, 30),
      ],
    });
    expect(crisisDecisionPoints(o, combat(o))).toHaveLength(2);
  });

  it("selfHeal response: owner heals self ≥15% maxHP inside the window", () => {
    const o = unit({
      healIn: [
        {
          timestamp: T0 + 2500,
          srcUnitId: "H",
          amount: 20,
          effectiveAmount: 20,
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.responses.selfHeal).toBe(true);
    expect(p.selfHealPct).toBe(20);
    expect(p.responded).toBe(true);
  });

  it("wall response counts only bigDefensiveSpellIds (Desperate Prayer yes, Divine Hymn no)", () => {
    const yes = unit({
      spellCastEvents: [{ timestamp: T0 + 2500, spellId: "19236" }],
    });
    const no = unit({
      spellCastEvents: [{ timestamp: T0 + 2500, spellId: "64843" }],
    });
    expect(crisisDecisionPoints(yes, combat(yes))[0]!.responses.wall).toBe(
      true,
    );
    expect(crisisDecisionPoints(no, combat(no))[0]!.responses.wall).toBe(false);
  });

  it("control response: owner casts a CC / root / interrupt on an enemy", () => {
    const o = unit({
      spellCastEvents: [
        { timestamp: T0 + 2800, spellId: "8122", destUnitId: "E1" },
      ],
    }); // Psychic Scream
    expect(
      crisisDecisionPoints(o, combat(o, [enemy()]))[0]!.responses.control,
    ).toBe(true);
  });

  it("peel: a teammate casts CC on the owner's attacker (does not count as responded)", () => {
    const mate = {
      ...enemy("M1"),
      reaction: CombatUnitReaction.Friendly,
      info: { teamId: "0" },
      spellCastEvents: [
        { timestamp: T0 + 2600, spellId: "8122", destUnitId: "E1" },
      ],
    };
    const o = unit();
    const p = crisisDecisionPoints(o, combat(o, [enemy(), mate]))[0]!;
    expect(p.responses.peel).toBe(true);
    expect(p.responded).toBe(false);
  });

  it("kite: distance to nearest attacker grows ≥ 8 yd over the window", () => {
    const o = unit({
      advancedActions: [
        hp(0, 100, 100, 0, 0),
        hp(1000, 70, 100, 0, 0),
        hp(2000, 38, 100, 0, 0),
        hp(5000, 35, 100, 12, 0),
      ],
    });
    const e = enemy("E1", {
      advancedActions: [hp(2000, 100, 100, 1, 0), hp(5000, 100, 100, 1, 0)],
    });
    expect(crisisDecisionPoints(o, combat(o, [e]))[0]!.responses.kite).toBe(
      true,
    );
  });

  it("gate 1: crossing inside enemy hard CC → inCC=true, feasible=false", () => {
    const o = unit({
      auraEvents: [
        {
          timestamp: T0 + 1200,
          spellId: "408",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_APPLIED" },
        },
        {
          timestamp: T0 + 6000,
          spellId: "408",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_REMOVED" },
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.inCC).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("gate 2: SPELL_INTERRUPT on the owner ≤1.5s before the crossing → lockedOut", () => {
    const o = unit({
      actionIn: [
        { timestamp: T0 + 1000, logLine: { event: LogEvent.SPELL_INTERRUPT } },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.lockedOut).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("gate 4: owner dies before t+3s → diedInWindow, feasible=false", () => {
    const o = unit({
      deathRecords: [{ timestamp: T0 + 2000 + RESPONSE_WINDOW_MS - 1 }],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.diedInWindow).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("enemyBurst: an enemy offensive major CD cast within 8s before the crossing", () => {
    const e = enemy("E1", {
      spellCastEvents: [{ timestamp: T0 + 500, spellId: "31884" }],
    }); // Avenging Wrath
    const o = unit();
    expect(crisisDecisionPoints(o, combat(o, [e]))[0]!.enemyBurst).toBe(true);
  });

  it("no advanced HP samples → no points", () => {
    const o = unit({ advancedActions: [] });
    expect(crisisDecisionPoints(o, combat(o))).toEqual([]);
  });

  it("attackers2s resolves pets/guardians to their owning player, ignores sources with no unit (measured 2026-08-29: a 3-enemy round rendered attackers=15, 13 of which were one warlock's imps/hounds)", () => {
    const o = unit({
      damageIn: [
        {
          timestamp: T0 + 1200,
          srcUnitId: "E1",
          amount: -10,
          effectiveAmount: -10,
        },
        {
          timestamp: T0 + 1400,
          srcUnitId: "P1",
          amount: -10,
          effectiveAmount: -10,
        },
        {
          timestamp: T0 + 1600,
          srcUnitId: "P2",
          amount: -10,
          effectiveAmount: -10,
        },
        {
          timestamp: T0 + 1700,
          srcUnitId: "GHOST", // no unit for this id at all
          amount: -10,
          effectiveAmount: -10,
        },
      ],
    });
    const e = enemy("E1");
    const p1 = {
      id: "P1",
      ownerId: "E1",
      info: undefined,
      reaction: CombatUnitReaction.Hostile,
      spellCastEvents: [],
      advancedActions: [],
    };
    const p2 = {
      id: "P2",
      ownerId: "E1",
      info: undefined,
      reaction: CombatUnitReaction.Hostile,
      spellCastEvents: [],
      advancedActions: [],
    };
    const p = crisisDecisionPoints(o, combat(o, [e, p1, p2]))[0]!;
    expect(p.attackers2s).toBe(1);
  });
});
