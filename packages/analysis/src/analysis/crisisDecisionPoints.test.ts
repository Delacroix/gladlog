import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  CRISIS_HP_PCT,
  CRISIS_MIN_DMG2S,
  crisisDecisionPoints,
  DEATH_LOOKAHEAD_MS,
  RESPONSE_WINDOW_MS,
  TEAM_DEATH_LOOKAHEAD_MS,
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

  it("C1: official DR silence category locks the school — Strangulate 47476 and Garrote-Silence 1330 (only 3/61 of the official category was covered by the hand `interrupts` set before this fix)", () => {
    for (const sid of ["47476", "1330"]) {
      const o = unit({
        auraEvents: [
          {
            timestamp: T0 + 1200,
            spellId: sid,
            srcUnitId: "E1",
            destUnitId: "H",
            auraType: "DEBUFF",
            logLine: { event: "SPELL_AURA_APPLIED" },
          },
          {
            timestamp: T0 + 6000,
            spellId: sid,
            srcUnitId: "E1",
            destUnitId: "H",
            auraType: "DEBUFF",
            logLine: { event: "SPELL_AURA_REMOVED" },
          },
        ],
      });
      const p = crisisDecisionPoints(o, combat(o))[0]!;
      expect(p.lockedOut).toBe(true);
    }
  });

  it("I2: an orphan REMOVED (aura already up before the round started, no APPLIED seen) still counts as inCC at a crossing before the REMOVED — pairing goes through auraIntervals.ts's official-duration backdating, not a private copy", () => {
    const o = unit({
      advancedActions: [hp(0, 100), hp(500, 70), hp(1000, 38), hp(1500, 35)],
      auraEvents: [
        {
          // orphan REMOVED at t+2s (t = combat start) for Kidney Shot (408,
          // no official duration data) — no matching APPLIED was ever logged
          timestamp: T0 + 2000,
          spellId: "408",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_REMOVED" },
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.tSec).toBe(1); // crossing at t+1s
    expect(p.inCC).toBe(true);
  });

  it("I2: a fear (5782) closed by SPELL_AURA_BROKEN does NOT count as inCC after the break — the old hand-rolled pairing only listened for SPELL_AURA_REMOVED and left this aura open until end-of-match+8s, a false positive", () => {
    const o = unit({
      advancedActions: [hp(0, 100), hp(500, 70), hp(1000, 38), hp(1500, 35)],
      auraEvents: [
        {
          timestamp: T0 + 200,
          spellId: "5782",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_APPLIED" },
        },
        {
          timestamp: T0 + 700,
          spellId: "5782",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_BROKEN" },
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.tSec).toBe(1); // crossing at t+1s, after the break at t+0.7s
    expect(p.inCC).toBe(false);
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

  it("gate 5 (spec §1b): dangerous is false below CRISIS_MIN_DMG2S, true at the boundary (inclusive)", () => {
    const low = unit({
      damageIn: [
        {
          timestamp: T0 + 1500,
          srcUnitId: "E1",
          amount: -5,
          effectiveAmount: -5,
        },
      ],
    }); // dmg2s = 0.05
    const boundary = unit({
      damageIn: [
        {
          timestamp: T0 + 1500,
          srcUnitId: "E1",
          amount: -10,
          effectiveAmount: -10,
        },
      ],
    }); // dmg2s = 0.10, exactly CRISIS_MIN_DMG2S
    expect(CRISIS_MIN_DMG2S).toBe(0.1);
    expect(
      crisisDecisionPoints(low, combat(low, [enemy()]))[0]!.dangerous,
    ).toBe(false);
    expect(
      crisisDecisionPoints(boundary, combat(boundary, [enemy()]))[0]!.dangerous,
    ).toBe(true);
  });

  it("diedWithin10s (table-only outcome, spec §1b): true when a deathRecords entry lies in (t, t+10000], false otherwise", () => {
    expect(DEATH_LOOKAHEAD_MS).toBe(10_000);
    const t = T0 + 2000; // the crossing timestamp for the default unit()
    const atEdge = unit({ deathRecords: [{ timestamp: t + 10_000 }] });
    const justPast = unit({ deathRecords: [{ timestamp: t + 10_001 }] });
    const atCrossing = unit({ deathRecords: [{ timestamp: t }] }); // (t, …] excludes t itself
    const none = unit({ deathRecords: [] });
    expect(
      crisisDecisionPoints(atEdge, combat(atEdge, [enemy()]))[0]!.diedWithin10s,
    ).toBe(true);
    expect(
      crisisDecisionPoints(justPast, combat(justPast, [enemy()]))[0]!
        .diedWithin10s,
    ).toBe(false);
    expect(
      crisisDecisionPoints(atCrossing, combat(atCrossing, [enemy()]))[0]!
        .diedWithin10s,
    ).toBe(false);
    expect(
      crisisDecisionPoints(none, combat(none, [enemy()]))[0]!.diedWithin10s,
    ).toBe(false);
  });

  it("friendDiedWithin15s (table-only outcome, spec §1c): true when any friendly player's deathRecords entry — owner's own death included — lies in (t, t+15000]; an enemy-only death does not count", () => {
    expect(TEAM_DEATH_LOOKAHEAD_MS).toBe(15_000);
    const t = T0 + 2000; // the crossing timestamp for the default unit()

    const mate = {
      ...enemy("M1"),
      reaction: CombatUnitReaction.Friendly,
      info: { teamId: "0" },
      deathRecords: [{ timestamp: t + 12_000 }],
    };
    const teammateDies = unit();
    expect(
      crisisDecisionPoints(
        teammateDies,
        combat(teammateDies, [enemy(), mate]),
      )[0]!.friendDiedWithin15s,
    ).toBe(true);

    const enemyDies = {
      ...enemy("E1"),
      deathRecords: [{ timestamp: t + 5000 }],
    };
    const noFriendDeath = unit();
    expect(
      crisisDecisionPoints(
        noFriendDeath,
        combat(noFriendDeath, [enemyDies]),
      )[0]!.friendDiedWithin15s,
    ).toBe(false);

    const ownerDies = unit({ deathRecords: [{ timestamp: t + 8000 }] });
    expect(
      crisisDecisionPoints(ownerDies, combat(ownerDies, [enemy()]))[0]!
        .friendDiedWithin15s,
    ).toBe(true);
  });

  it("feasible is unaffected by dangerous — gates 1/2/4 alone decide it", () => {
    const lowDmgFree = unit({
      damageIn: [
        {
          timestamp: T0 + 1500,
          srcUnitId: "E1",
          amount: -5,
          effectiveAmount: -5,
        },
      ],
    });
    const p1 = crisisDecisionPoints(
      lowDmgFree,
      combat(lowDmgFree, [enemy()]),
    )[0]!;
    expect(p1.dangerous).toBe(false);
    expect(p1.feasible).toBe(true);

    const highDmgCCd = unit({
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
    }); // default damageIn → dmg2s 0.3 → dangerous
    const p2 = crisisDecisionPoints(
      highDmgCCd,
      combat(highDmgCCd, [enemy()]),
    )[0]!;
    expect(p2.dangerous).toBe(true);
    expect(p2.feasible).toBe(false);
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
