import { CombatUnitClass, LogEvent } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  cdWasteEvents,
  ccAvoidableEvents,
  ccAvoidanceOptionsAt,
  ccHeldEvents,
  deathSetupEvents,
  deathUnusedDefensiveEvents,
  externalUnusedEvents,
  extractCandidateFindings,
  healingGapEvents,
  LEGACY_TOPIC_TYPES,
  missedCleanseEvents,
  missedPurgeEvents,
  ccLockedEvents,
  kickEatenEvents,
  positionMistakeEvents,
  wastedTrinketEvents,
  trinketTeamMinHpPctAt,
} from "./candidateFindings";
import {
  FORBEARANCE_GATED_IDS,
  USABLE_WHILE_CC_SPELL_IDS,
  type IMajorCooldownInfo,
} from "../utils/cooldowns";

// Synthetic combat: one Friendly death + one Hostile death. spec "256" is
// Priest_Discipline (a healer) with reaction 1 (Friendly).
function combat(): any {
  return {
    startTime: 0,
    endTime: 60000,
    units: {
      a: {
        id: "a",
        name: "Me-R",
        type: 1,
        reaction: 1,
        spec: "256",
        deathRecords: [{ timestamp: 30000 }],
        spellCastEvents: [],
        advancedActions: [],
        info: { teamId: "0" },
      },
      b: {
        id: "b",
        name: "Enemy-R",
        type: 1,
        reaction: 2,
        spec: "577",
        deathRecords: [{ timestamp: 45000 }],
        spellCastEvents: [],
        advancedActions: [],
        info: { teamId: "1" },
      },
    },
  };
}

describe("extractCandidateFindings", () => {
  it("emits a death CandidateEvent with a stable id, time, unit, and facts", () => {
    const evts = extractCandidateFindings(combat());
    const death = evts.find((e) => e.id === "death:a:30");
    expect(death).toBeTruthy();
    expect(death!.t).toBe(30);
    expect(death!.unitNames).toContain("Me-R");
    expect(death!.type).toBe("death");
    expect(death!.facts["t"]).toBe("30");
  });
  it("tags each death friendly/enemy so the LLM knows a kill from a loss", () => {
    const evts = extractCandidateFindings(combat());
    const mine = evts.find((e) => e.id === "death:a:30");
    const theirs = evts.find((e) => e.id === "death:b:45");
    expect(mine!.facts["side"]).toBe("friendly");
    expect(theirs!.facts["side"]).toBe("enemy");
  });
  it("excludes pet/guardian deaths (no COMBATANT_INFO) — players only", () => {
    const c = combat();
    // A warlock pet dies too, but has no `info` (not a real player).
    c.units.pet = {
      id: "pet",
      name: "Gzaadym",
      type: 3,
      reaction: 1,
      spec: "0",
      deathRecords: [{ timestamp: 20000 }],
      spellCastEvents: [],
      advancedActions: [],
    };
    const evts = extractCandidateFindings(c);
    expect(evts.some((e) => e.unitNames.includes("Gzaadym"))).toBe(false);
    // The two real player deaths are still present.
    expect(evts.filter((e) => e.type === "death")).toHaveLength(2);
  });
  it("returns [] for an empty combat without throwing", () => {
    expect(
      extractCandidateFindings({ startTime: 0, endTime: 1000, units: {} }),
    ).toEqual([]);
  });

  it("agy flash 复核采纳:不传 ownerId(缺省回退友方治疗)时,治疗自己死亡且有可用保命技 → death-unused-defensive 仍出现(此前原始 ownerId 被直接转发给 extractDeathSetups,isOwner 恒 false,该类型永不产出)", () => {
    // Priest_Holy (a healer, the fallback target), with Ultimate Penitence
    // (421453, 240s CD, Defensive and not throughput — the second spell that
    // extractMajorCooldowns dynamically appends for Priest, not in the talent
    // tree) never pressed all match, and not under any CC at death → free=yes.
    // Hitting info.pvpTalents is what gets it into the majorSpells ledger (the
    // existing rule that "a baseline spell is filtered out unless it was picked
    // as a PvP talent or was actually cast", see cooldowns.ts lines 617-629) —
    // purely a test-fixture device to make this never-used defensive show up in
    // the stats; it does not mean the player really picked that PvP talent.
    const c: any = {
      startTime: 0,
      endTime: 60000,
      startInfo: { zoneId: "0" },
      units: {
        h: {
          id: "h",
          name: "Healer-R",
          type: 1,
          reaction: 1,
          spec: "257", // Priest_Holy
          class: CombatUnitClass.Priest,
          deathRecords: [{ timestamp: 30000 }],
          spellCastEvents: [],
          advancedActions: [],
          auraEvents: [],
          actionIn: [],
          info: { teamId: "0", pvpTalents: ["421453"] },
        },
        e: {
          id: "e",
          name: "Enemy-R",
          type: 1,
          reaction: 2,
          spec: "577",
          class: CombatUnitClass.Warrior,
          deathRecords: [],
          spellCastEvents: [],
          advancedActions: [],
          auraEvents: [],
          actionIn: [],
          info: { teamId: "1" },
        },
      },
    };
    const evts = extractCandidateFindings(c); // no ownerId passed
    const found = evts.find((ev) => ev.type === "death-unused-defensive");
    expect(found).toBeTruthy();
    expect(found!.facts["unit"]).toBe("Healer-R");
    expect(found!.facts["walls"]).toContain("Ultimate Penitence");
    expect(found!.facts["free"]).toBe("yes");
  });

  it("信号扩容批 1(2026-08-06)接线冒烟:无位置数据 + 无 CC 大招 kit 的普通治疗轮 → position-mistake/cc-held 零产出,不崩溃(三态兑现在整条流水线上,不只在纯函数里)", () => {
    const c: any = {
      startTime: 0,
      endTime: 60000,
      startInfo: { zoneId: "0" },
      units: {
        h: {
          id: "h",
          name: "Healer-R",
          type: 1,
          reaction: 1,
          spec: "257", // Priest_Holy
          class: CombatUnitClass.Priest,
          deathRecords: [],
          spellCastEvents: [],
          healOut: [],
          advancedActions: [], // no position data → three-state
          auraEvents: [],
          actionIn: [],
          actionOut: [],
          damageIn: [],
          info: { teamId: "0" },
        },
        e: {
          id: "e",
          name: "Enemy-R",
          type: 1,
          reaction: 2,
          spec: "577",
          class: CombatUnitClass.Warrior,
          deathRecords: [],
          spellCastEvents: [],
          advancedActions: [],
          auraEvents: [],
          actionIn: [],
          actionOut: [],
          damageIn: [],
          info: { teamId: "1" },
        },
      },
    };
    const evts = extractCandidateFindings(c, "h");
    expect(evts.some((e) => e.type === "position-mistake")).toBe(false);
    expect(evts.some((e) => e.type === "cc-held")).toBe(false);
  });

  /**
   * cc-avoidable (DEFENSIVE-001, 2026-08-07) end-to-end fixture: the owner
   * eats a real full-DR Cheap Shot (physical, targeted, DR category falls
   * back to its own spellId — first application of the match, so
   * getDRLevel resolves "Full") lasting 4s (>= CC_AVOIDABLE_MIN_S), presses
   * the PvP trinket at t=0 (puts it on_cooldown by the time the CC lands at
   * t=50, so the dedupe gate does NOT exclude this instance), and casts
   * Divine Shield (642, cd 300s) once AFTER the CC at t=60 — proving kit
   * evidence while leaving the CC-time availability check untouched (no
   * cast strictly before t=50 → treated as available then, same semantics
   * ccAvoidanceOptionsAt's own unit tests pin down).
   */
  function ccAvoidableFixture(ownerSpec: string): any {
    const cheapShotApplied = {
      logLine: { event: "SPELL_AURA_APPLIED", timestamp: 50_000 },
      timestamp: 50_000,
      spellId: "1833",
      spellName: "Cheap Shot",
      srcUnitId: "e",
      srcUnitName: "Enemy-R",
      destUnitId: "h",
      destUnitName: "Healer-R",
    };
    const cheapShotRemoved = {
      ...cheapShotApplied,
      logLine: { event: "SPELL_AURA_REMOVED", timestamp: 54_000 },
      timestamp: 54_000,
    };
    const trinketPress = {
      logLine: { event: "SPELL_CAST_SUCCESS", timestamp: 0 },
      timestamp: 0,
      spellId: "336126", // Gladiator's Medallion
      spellName: "Gladiator's Medallion",
      srcUnitId: "h",
      srcUnitName: "Healer-R",
      destUnitId: "h",
      destUnitName: "Healer-R",
    };
    const divineShieldCast = {
      logLine: { event: "SPELL_CAST_SUCCESS", timestamp: 60_000 },
      timestamp: 60_000,
      spellId: "642", // Divine Shield
      spellName: "Divine Shield",
      srcUnitId: "h",
      srcUnitName: "Healer-R",
      destUnitId: "h",
      destUnitName: "Healer-R",
    };
    return {
      startTime: 0,
      endTime: 120_000,
      startInfo: { zoneId: "0" },
      units: {
        h: {
          id: "h",
          name: "Healer-R",
          type: 1,
          reaction: 1,
          spec: ownerSpec,
          class: CombatUnitClass.Priest,
          deathRecords: [],
          spellCastEvents: [trinketPress, divineShieldCast],
          healOut: [],
          advancedActions: [],
          // Aura events are recorded on the unit that RECEIVED the debuff
          // (the owner, here), not the caster — this is what
          // analyzePlayerCCAndTrinket(player, …) reads as `player.auraEvents`.
          auraEvents: [cheapShotApplied, cheapShotRemoved],
          actionIn: [],
          actionOut: [],
          damageIn: [],
          info: { teamId: "0" },
        },
        e: {
          id: "e",
          name: "Enemy-R",
          type: 1,
          reaction: 2,
          spec: "577",
          class: CombatUnitClass.Warrior,
          deathRecords: [],
          spellCastEvents: [],
          advancedActions: [],
          auraEvents: [],
          actionIn: [],
          actionOut: [],
          damageIn: [],
          info: { teamId: "1" },
        },
      },
    };
  }

  it("cc-avoidable(DEFENSIVE-001,2026-08-07)端到端:治疗 owner 吃满 Full-DR Cheap Shot(4s)+ Divine Shield 落地前可用未用(饰品已在冷却,不触发去重门)→ 产出一条,facts 齐全", () => {
    const evts = extractCandidateFindings(ccAvoidableFixture("256"), "h"); // Priest_Discipline (healer)
    const found = evts.find((e) => e.type === "cc-avoidable");
    expect(found).toBeTruthy();
    expect(found!.facts["spell"]).toBe("Cheap Shot");
    expect(found!.facts["durationS"]).toBe("4");
    expect(found!.facts["avoidableWith"]).toContain("Divine Shield");
  });

  it("cc-avoidable:非治疗 owner(判据=owner(治疗))→ 零产出,即便同一场景下 CC 本身满足条件", () => {
    const evts = extractCandidateFindings(ccAvoidableFixture("577"), "h"); // Warrior_Fury (not a healer)
    expect(evts.some((e) => e.type === "cc-avoidable")).toBe(false);
  });
});

describe("cdWasteEvents", () => {
  const healer = { id: "a", name: "Me-R" };

  it("emits a cd-waste event for a never-used survival cooldown", () => {
    const evts = cdWasteEvents(
      [
        {
          spellId: "33206",
          spellName: "Pain Suppression",
          neverUsed: true,
          isThroughput: false,
        },
      ],
      healer,
      null,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0].id).toBe("cd-waste:a:33206");
    expect(evts[0].type).toBe("cd-waste");
    expect(evts[0].spell).toBe("Pain Suppression");
    expect(evts[0].facts).toEqual({ spell: "Pain Suppression", unit: "Me-R" });
  });
  it("skips a cooldown that was used", () => {
    const evts = cdWasteEvents(
      [
        {
          spellId: "33206",
          spellName: "Pain Suppression",
          neverUsed: false,
          isThroughput: false,
        },
      ],
      healer,
      null,
    );
    expect(evts).toEqual([]);
  });
  it("skips a never-used THROUGHPUT cooldown (not a survival wall)", () => {
    const evts = cdWasteEvents(
      [
        {
          spellId: "10060",
          spellName: "Power Infusion",
          neverUsed: true,
          isThroughput: true,
        },
      ],
      healer,
      null,
    );
    expect(evts).toEqual([]);
  });
});

describe("deathSetupEvents(死亡前因链,纯函数)", () => {
  const victim = { id: "v1", name: "Victim-R" };

  it("healer-locked:治疗 CC 覆盖死亡前窗口且 ≥3s → 前因事件在 CC 时刻", () => {
    const evts = deathSetupEvents({
      deathT: 150,
      victim,
      healerCC: {
        healerName: "Healer-R",
        ccInstances: [
          // Covers the [138,150] window: 5s of CC starting at 143
          {
            atSeconds: 143,
            durationSeconds: 5,
            spellName: "Fear",
            sourceName: "E",
          },
        ],
      },
    });
    expect(evts).toHaveLength(1);
    const e = evts[0]!;
    expect(e.type).toBe("death-setup");
    expect(e.t).toBe(143);
    expect(e.facts["kind"]).toBe("healer-locked");
    expect(e.facts["deathT"]).toBe("150");
    expect(e.facts["healer"]).toBe("Healer-R");
    expect(e.unitNames).toEqual(["Healer-R", "Victim-R"]);
  });

  it("healer CC 过短(<3s)或在窗口外 → 不出", () => {
    const short = deathSetupEvents({
      deathT: 150,
      victim,
      healerCC: {
        healerName: "H",
        ccInstances: [
          {
            atSeconds: 145,
            durationSeconds: 2,
            spellName: "Kick",
            sourceName: "E",
          },
        ],
      },
    });
    expect(short).toHaveLength(0);
    const outside = deathSetupEvents({
      deathT: 150,
      victim,
      healerCC: {
        healerName: "H",
        ccInstances: [
          // 120+8=128 < 150-12=138 → outside the window
          {
            atSeconds: 120,
            durationSeconds: 8,
            spellName: "Fear",
            sourceName: "E",
          },
        ],
      },
    });
    expect(outside).toHaveLength(0);
  });

  it("trinket-early:死亡窗口内被控且饰品 CD 中 → 前因在更早的饰品施放时刻;超 90s 回溯不出", () => {
    const base = {
      deathT: 150,
      victim,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 146,
            durationSeconds: 6,
            spellName: "Stun",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [80],
      },
    };
    const evts = deathSetupEvents(base);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.t).toBe(80);
    expect(evts[0]!.facts["kind"]).toBe("trinket-early");
    expect(evts[0]!.facts["ccAtDeath"]).toBe("Stun");
    expect(evts[0]!.facts["gapS"]).toBe("70");
    // Look-back beyond 90s (death 150, trinket 40 → gap 110) emits nothing
    const tooOld = deathSetupEvents({
      ...base,
      victimCC: { ...base.victimCC, trinketUseTimes: [40] },
    });
    expect(tooOld).toHaveLength(0);
  });

  it("defensive-early:死亡时 ON COOLDOWN 且上次使用被审计标 Early;Optimal/可用则不出", () => {
    const cd = (
      timingLabel: string,
      timeSeconds: number,
      cooldownSeconds = 120,
    ) => ({
      spellId: "1",
      spellName: "Wall",
      tag: "Defensive",
      cooldownSeconds,
      neverUsed: false,
      casts: [{ timeSeconds, timingLabel: timingLabel as never }],
    });
    const early = deathSetupEvents({
      deathT: 150,
      victim,
      victimCDs: [cd("Early", 100)], // ready at 220 > 150 → still on cooldown
    });
    expect(early).toHaveLength(1);
    expect(early[0]!.facts["kind"]).toBe("defensive-early");
    expect(early[0]!.t).toBe(100);
    expect(early[0]!.facts["gapS"]).toBe("50");
    // An Optimal usage emits nothing
    expect(
      deathSetupEvents({
        deathT: 150,
        victim,
        victimCDs: [cd("Optimal", 100)],
      }),
    ).toHaveLength(0);
    // Back up by the time of death (available-but-unpressed belongs to
    // death-trace, not to the used-too-early chain) emits nothing
    expect(
      deathSetupEvents({
        deathT: 150,
        victim,
        victimCDs: [cd("Early", 20, 60)],
      }),
    ).toHaveLength(0);
  });

  it("每死亡至多 2 条,优先 healer-locked > trinket-early > defensive-early", () => {
    const evts = deathSetupEvents({
      deathT: 150,
      victim,
      healerCC: {
        healerName: "H",
        ccInstances: [
          {
            atSeconds: 143,
            durationSeconds: 5,
            spellName: "Fear",
            sourceName: "E",
          },
        ],
      },
      victimCC: {
        ccInstances: [
          {
            atSeconds: 146,
            durationSeconds: 6,
            spellName: "Stun",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [80],
      },
      victimCDs: [
        {
          spellId: "1",
          spellName: "Wall",
          tag: "Defensive",
          cooldownSeconds: 120,
          neverUsed: false,
          casts: [{ timeSeconds: 100, timingLabel: "Early" as never }],
        },
      ],
    });
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["kind"])).toEqual([
      "healer-locked",
      "trinket-early",
    ]);
  });
});

describe("death-unused-defensive(死亡时保命技可用未按)", () => {
  const wall = (over: Partial<IMajorCooldownInfo> = {}) => ({
    spellId: "108271", // Astral Shift
    spellName: "Astral Shift",
    tag: "Defensive",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const base = {
    deathT: 100,
    victim: { id: "p1", name: "Me-R" },
    victimCDs: [wall()],
    victimCC: { ccInstances: [], trinketUseTimes: [] },
  };

  it("可用保命技 + 死亡时不在 CC → 发一条,facts 列技能与 free=yes", () => {
    const ev = deathUnusedDefensiveEvents(base, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("death-unused-defensive");
    expect(ev[0]!.facts.walls).toContain("Astral Shift");
    expect(ev[0]!.facts.free).toBe("yes");
  });

  it("非 owner 的死亡 → 不发(指摘只对 owner)", () => {
    expect(deathUnusedDefensiveEvents(base, { isOwner: false })).toEqual([]);
  });

  it("保命技死亡时在 CD → 不发", () => {
    const p = {
      ...base,
      victimCDs: [wall({ casts: [{ timeSeconds: 50 }], neverUsed: false })],
    }; // readyAt=140 > deathT=100
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("死亡时在 CC 且饰品在 CD → 不自由,不发", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [40],
      },
    };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("死亡时在 CC 但饰品可用 → 仍发(free=trinket_in_hand)", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "available_unused",
          },
        ],
        trinketUseTimes: [],
      },
    };
    const ev = deathUnusedDefensiveEvents(p, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.facts.free).toBe("trinket_in_hand");
  });

  it("死亡时在 CC 且饰品为被动饰品(Relentless passive_trinket)→ 不自由,不发(回归:此前 !== on_cooldown 误把被动饰品当 trinket_in_hand,假指摘玩家没解一个不存在的主动饰品)", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "passive_trinket",
          },
        ],
        trinketUseTimes: [],
      },
    };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("死亡时在 CC 且饰品已用(used)→ 不自由,不发", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "used",
          },
        ],
        trinketUseTimes: [40],
      },
    };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("victimCC 缺席(摘要不可算)→ 不发(宁缺勿假指摘,不能默认 free=yes)", () => {
    const p = { ...base, victimCC: undefined };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("throughput 型不算保命技 → 不发", () => {
    const p = { ...base, victimCDs: [wall({ isThroughput: true })] };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  // Take the id from the real whitelist (do not mock the set itself): we need an
  // id that is in USABLE_WHILE_CC_SPELL_IDS but NOT in FORBEARANCE_GATED_IDS, so
  // this case does not interfere with the Forbearance case below.
  const usableInCcOnlyId = [...USABLE_WHILE_CC_SPELL_IDS].find(
    (id) => !FORBEARANCE_GATED_IDS.has(id),
  )!;

  it("死亡时在 CC 且饰品在 CD,但技能在 CC 中可用清单里 → 仍发,free=usable_in_cc", () => {
    // The freeState=null branch (under CC with trinketState=on_cooldown) may
    // only pass on a hit in USABLE_WHILE_CC_SPELL_IDS — this is the one path in
    // the whole package that emits the "usable_in_cc" string, without which a
    // flipped freeState===null && !has(...) condition (||/&& written the wrong
    // way round) would be caught by no test at all.
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [],
      },
      victimCDs: [
        wall({ spellId: usableInCcOnlyId, spellName: "UsableInCC-Wall" }),
      ],
    };
    const ev = deathUnusedDefensiveEvents(p, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.facts.free).toBe("usable_in_cc");
    expect(ev[0]!.facts.walls).toContain("UsableInCC-Wall");
  });

  it("Forbearance 期内的圣盾类:自施 30s 内即使裸 CD 显示可用也要排除,不发", () => {
    // Divine-Shield-class spells physically cannot be pressed inside the
    // Forbearance window; if this exclusion regresses, the coach would falsely
    // accuse the player of not pressing a button they could not press — exactly
    // the false accusation this predicate exists to prevent, and until now no
    // test could catch that regression.
    const forbearanceGatedId = [...FORBEARANCE_GATED_IDS][0]!;
    const forbUnit = {
      id: "p1",
      spellCastEvents: [
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS },
          spellId: forbearanceGatedId,
          // matchStartMs=0 → 80s; deathT=100 → 20s earlier, inside the 30s window
          timestamp: 80_000,
          destUnitId: "p1",
        },
      ],
    };
    const p = {
      ...base,
      victimCDs: [
        wall({
          spellId: forbearanceGatedId,
          spellName: "Forbearance-Gated-Wall",
        }),
      ],
    };
    const ev = deathUnusedDefensiveEvents(
      p,
      { isOwner: true, unit: forbUnit },
      { startTime: 0, units: { p1: forbUnit } },
    );
    expect(ev).toEqual([]);
  });
});

describe("external-unused(队友阵亡时 owner 外减可用未给)", () => {
  const ext = (over = {}) => ({
    spellId: "102342", // Ironbark
    spellName: "Ironbark",
    tag: "External",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const owner = { id: "h1", name: "Healer-R" };
  const victim = { id: "p2", name: "Mate-R" };

  it("外减可用 + owner 死亡前窗口有空档 → 发一条", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [], // free the whole time
      ownerAliveAt: () => true,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("external-unused");
    expect(ev[0]!.facts.external).toBe("Ironbark");
  });

  it("外减在 CD → 不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext({ casts: [{ timeSeconds: 60 }], neverUsed: false })], // readyAt=150
      ownerCC: [],
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("owner 死亡前窗口 [95,100] 全被 CC 覆盖 → 不自由,不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 94, durationSeconds: 7 }], // covers [94,101]
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("窗口内有 ≥1.5s 空档(CC 只盖 [95,99])→ 发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      // gap [99,100] is only 1s… plus [0s before 95]?
      ownerCC: [{ atSeconds: 95, durationSeconds: 4 }],
      ownerAliveAt: () => true,
    });
    // Window [95,100]: CC covers [95,99] → largest gap 1.0s < 1.5 → no event
    expect(ev).toEqual([]);
    const ev2 = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 3 }], // gap [98,100] = 2s ≥ 1.5
      ownerAliveAt: () => true,
    });
    expect(ev2).toHaveLength(1);
  });

  it("owner 在 deathT 已死亡 → 不发", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [],
      ownerAliveAt: () => false,
    });
    expect(ev).toEqual([]);
  });
});

describe("团队协作候选映射(2026-07-24 覆盖面扩充)", () => {
  // Priest_Discipline (256) is a MAGIC_REMOVERS spec, so windows tagged
  // dispelType "Magic" leave this owner's capability gate untouched — this
  // fixture exercises the pre-existing priority/CD/cap behavior only.
  const dispelOwner = { id: "owner", spec: "256" };
  it("missed-cleanse:只报 Critical/High 且解控可用;按承伤排序截 2(TEMPORARY 上限,BACKLOG #22)", () => {
    const w = (p: string, dmg: number, onCD = false) => ({
      timeSeconds: 30,
      durationSeconds: 5,
      targetName: "Ally",
      spellName: "Fear",
      spellId: "5782",
      priority: p as never,
      postCcDamage: dmg,
      cleanseWasOnCD: onCD,
      // Feasibility gates default to fully open (the gates' own behavior is
      // covered separately in dispelGates.test.ts)
      dispellersLockedOut: false,
      losReachable: null,
      drChainRisk: false,
      dispelType: "Magic" as const,
    });
    const evts = missedCleanseEvents(
      [
        w("Critical", 100_000),
        w("High", 50_000),
        w("Medium", 999_999), // low priority, not reported
        w("Critical", 80_000, true), // cleanse on cooldown, not reported
        w("High", 70_000), // the 3rd-heaviest qualifying entry, truncated away
        w("High", 60_000), // the 4th entry, also truncated away
      ],
      dispelOwner,
      [dispelOwner],
      false,
    );
    expect(evts).toHaveLength(2);
    expect(evts[0]!.facts["postCcDamageK"]).toBe("100");
    expect(evts[1]!.facts["postCcDamageK"]).toBe("70");
    expect(evts.every((e) => e.type === "missed-cleanse")).toBe(true);
    expect(evts.every((e) => e.facts["ownerCanDispel"] === undefined)).toBe(
      true,
    );
  });

  it("missed-cleanse(DISPEL-002,2026-08-06):lateDispelSeconds 有值 → facts 带整数串 latencyS;无值 → 该键不存在", () => {
    const base = {
      timeSeconds: 30,
      durationSeconds: 5,
      targetName: "Ally",
      spellName: "Fear",
      spellId: "5782",
      priority: "Critical" as const,
      postCcDamage: 50_000,
      cleanseWasOnCD: false,
      dispellersLockedOut: false,
      losReachable: null,
      drChainRisk: false,
      dispelType: "Magic" as const,
    };
    const evts = missedCleanseEvents(
      [
        { ...base, lateDispelSeconds: 4.6 },
        { ...base, postCcDamage: 40_000 }, // no lateDispelSeconds → key absent
      ],
      dispelOwner,
      [dispelOwner],
      false,
    );
    expect(evts).toHaveLength(2);
    expect(evts[0]!.facts["latencyS"]).toBe("5");
    expect(evts[1]!.facts["latencyS"]).toBeUndefined();
  });

  describe("missed-cleanse:owner 派系能力门(2026-08-05,37/200 场审计)", () => {
    // Holy Paladin (65) cannot remove Curse (CURSE_REMOVERS omits it) — the
    // exact bug reported: owner got handed "you should have dispelled the
    // Curse" candidates for an ability their class does not have.
    const holyPaladin = { id: "owner", spec: "65" };
    const arcaneMage = { id: "mage", spec: "62" }; // CURSE_REMOVERS
    const curseWindow = {
      timeSeconds: 30,
      durationSeconds: 5,
      targetName: "Ally",
      spellName: "Curse of Tongues",
      spellId: "1714",
      priority: "Critical" as const,
      postCcDamage: 50_000,
      cleanseWasOnCD: false,
      dispellersLockedOut: false,
      losReachable: null,
      drChainRisk: false,
      dispelType: "Curse" as const,
    };

    it("solo shuffle:owner 驱不了该派系 → 候选直接不进菜单", () => {
      const evts = missedCleanseEvents(
        [curseWindow],
        holyPaladin,
        [holyPaladin],
        true, // isShuffle
      );
      expect(evts).toHaveLength(0);
    });

    it("组队(3v3):owner 驱不了该派系 → 候选保留,facts 带 ownerCanDispel/eligibleDispellers", () => {
      const evts = missedCleanseEvents(
        [curseWindow],
        holyPaladin,
        [holyPaladin, arcaneMage],
        false, // isShuffle
      );
      expect(evts).toHaveLength(1);
      expect(evts[0]!.facts["ownerCanDispel"]).toBe("no");
      expect(evts[0]!.facts["eligibleDispellers"]).toContain("Arcane Mage");
    });

    it("owner=Resto Druid(能驱 Curse):照常产出,无守护字段", () => {
      const restoDruid = { id: "owner", spec: "105" };
      const evts = missedCleanseEvents(
        [curseWindow],
        restoDruid,
        [restoDruid],
        false,
      );
      expect(evts).toHaveLength(1);
      expect(evts[0]!.facts["ownerCanDispel"]).toBeUndefined();
      expect(evts[0]!.facts["eligibleDispellers"]).toBeUndefined();
      // owner-can-dispel path: existing fields/rendering are byte-identical
      expect(evts[0]!.facts["dispelType"]).toBe("Curse");
    });
  });

  it("missed-purge:击杀窗口内的 Medium 也报;purge 在 CD 不报", () => {
    const w = (p: string, kw: boolean, onCD = false, dur = 10) => ({
      timeSeconds: 20,
      durationSeconds: dur,
      enemyName: "Enemy",
      spellName: "PI",
      spellId: "10060",
      priority: p as never,
      purgeWasOnCD: onCD,
      duringKillWindow: kw,
      purgersLockedOut: false,
      losReachable: null,
    });
    const evts = missedPurgeEvents([
      w("Medium", true), // inside the kill window → reported
      w("Medium", false), // outside the window, low priority → not reported
      w("High", false, true), // on cooldown → not reported
      w("High", false),
    ]);
    expect(evts).toHaveLength(2);
    // in-window entries sort first
    expect(evts[0]!.facts["inKillWindow"]).toBe("yes");
  });

  it("cc-locked:≥4s 才报,trinketState 进 facts", () => {
    const cc = (dur: number, state: string, dmg: number) => ({
      atSeconds: 40,
      durationSeconds: dur,
      spellName: "Polymorph",
      spellId: "118",
      sourceName: "Mage",
      trinketState: state as never,
      damageTakenDuring: dmg,
    });
    const evts = ccLockedEvents(
      [cc(3.9, "available_unused", 999_999), cc(6, "on_cooldown", 50_000)],
      { id: "P1", name: "Me" },
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.facts["trinketState"]).toBe("on_cooldown");
    expect(evts[0]!.facts["damageTakenK"]).toBe("50");
  });

  it("kick-eaten:按锁定时长排序截 2", () => {
    const k = (lock: number) => ({
      atSeconds: 10,
      lockoutDurationSeconds: lock,
      kickSpellName: "Kick",
      interruptedSpellName: "Chain Heal",
      sourceName: "Rogue",
    });
    const evts = kickEatenEvents([k(3), k(5), k(4)], {
      id: "P1",
      name: "Me",
    });
    expect(evts).toHaveLength(2);
    expect(evts[0]!.facts["lockout"]).toBe("5.0");
  });
});

describe("healingGapEvents(HEAL-001,2026-08-06 信号扩容批 1)", () => {
  const owner = { id: "h1", name: "Me-R" };
  const gap = (freeS: number, dmg: number, name = "Ally") => ({
    fromSeconds: 30.7,
    toSeconds: 40,
    durationSeconds: 9.3,
    freeCastSeconds: freeS,
    mostDamagedName: name,
    mostDamagedSpec: "Warrior_Arms",
    mostDamagedAmount: dmg,
  });

  it("freeCastSeconds < HEAL_GAP_FREE_MIN_S(4s) → 不报", () => {
    expect(healingGapEvents([gap(3.9, 50_000)], owner)).toEqual([]);
  });

  it("mostDamagedAmount === 0(没人真的挨打)→ 不报", () => {
    expect(healingGapEvents([gap(10, 0)], owner)).toEqual([]);
  });

  it("过门槛 → 报;t floor 到渲染网格,durationS/freeS 为整数串", () => {
    const evts = healingGapEvents([gap(4, 50_000)], owner);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe("healing-gap");
    expect(evts[0]!.t).toBe(30); // toRenderSecond(30.7) === 30
    expect(evts[0]!.facts["t"]).toBe("30");
    expect(evts[0]!.facts["durationS"]).toBe("9");
    expect(evts[0]!.facts["freeS"]).toBe("4");
    expect(evts[0]!.facts["pressured"]).toBe("Ally");
    expect(evts[0]!.facts["pressuredSpec"]).toBe("Warrior_Arms");
  });

  it("按 mostDamagedAmount 降序排,截 cap=2(HEALING_GAP_CAP)", () => {
    const evts = healingGapEvents(
      [gap(5, 10_000, "A"), gap(5, 40_000, "B"), gap(5, 30_000, "C")],
      owner,
    );
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["pressured"])).toEqual(["B", "C"]);
  });
});

describe("positionMistakeEvents(POSITION-001,2026-08-06 信号扩容批 1)", () => {
  const owner = { id: "p1", name: "Me" };

  it("STAYED_IN 无真实代价(stayedInHadRealCost=false)→ 不报", () => {
    const evts = positionMistakeEvents(
      [
        {
          type: "STAYED_IN" as const,
          atSeconds: 10,
          ownerHpStartPct: 100,
          ownerHpMinPct: 95, // >=85 且降幅<15 → 无真实代价
        },
      ],
      owner,
    );
    expect(evts).toEqual([]);
  });

  it("STAYED_IN 有真实代价 → 报,facts 带 kind/hpStart/hpMin/enemy", () => {
    const evts = positionMistakeEvents(
      [
        {
          type: "STAYED_IN" as const,
          atSeconds: 10.4,
          nearestEnemyName: "Rogue",
          ownerHpStartPct: 90,
          ownerHpMinPct: 40,
        },
      ],
      owner,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe("position-mistake");
    expect(evts[0]!.t).toBe(10); // floor
    expect(evts[0]!.facts["kind"]).toBe("stayed-in");
    expect(evts[0]!.facts["hpStart"]).toBe("90");
    expect(evts[0]!.facts["hpMin"]).toBe("40");
    expect(evts[0]!.facts["enemy"]).toBe("Rogue");
  });

  it("MISSED_PUSH 无 real-cost 门,直接报;facts.dist 取整", () => {
    const evts = positionMistakeEvents(
      [
        {
          type: "MISSED_PUSH" as const,
          atSeconds: 20,
          startDistanceYards: 44.6,
        },
      ],
      owner,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.facts["kind"]).toBe("missed-push");
    expect(evts[0]!.facts["dist"]).toBe("45");
  });

  it("CD_OUT_OF_RANGE 直接报,facts.spell/顶层 spell 都带技能名", () => {
    const evts = positionMistakeEvents(
      [
        {
          type: "CD_OUT_OF_RANGE" as const,
          atSeconds: 30,
          spellName: "Divine Storm",
        },
      ],
      owner,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.facts["kind"]).toBe("cd-out-of-range");
    expect(evts[0]!.facts["spell"]).toBe("Divine Storm");
    expect(evts[0]!.spell).toBe("Divine Storm");
  });

  it("KITED/SPLIT_PUSH/HEALER_TRAINED 不在 POSITION_MISTAKES 允许列表 → 不报", () => {
    expect(
      positionMistakeEvents([{ type: "KITED" as const, atSeconds: 10 }], owner),
    ).toEqual([]);
  });

  it("按 hpMin 升序(越低越重)排,截 cap=2(POSITION_MISTAKE_CAP)", () => {
    const mk = (hpMin: number) => ({
      type: "STAYED_IN" as const,
      atSeconds: 10,
      ownerHpStartPct: 100,
      ownerHpMinPct: hpMin,
    });
    const evts = positionMistakeEvents([mk(50), mk(10), mk(30)], owner);
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["hpMin"])).toEqual(["10", "30"]);
  });

  it("空输入(无位置数据轮的三态兑现:computeOwnerPositionEvents 本身已对此返回 [])→ 零产出", () => {
    expect(positionMistakeEvents([], owner)).toEqual([]);
  });
});

describe("ccHeldEvents(COOLDOWN-001,2026-08-06 信号扩容批 1)", () => {
  const owner = { id: "p1", name: "Me" };
  const cd = (
    spellId: string,
    spellName: string,
    windows: Array<{
      fromSeconds: number;
      toSeconds: number;
      durationSeconds: number;
    }>,
  ) => ({ spellId, spellName, availableWindows: windows });

  it("不在 ccSpellIds 里的技能 → 不报,即便窗口很长", () => {
    const evts = ccHeldEvents(
      [
        cd("100", "Not A CC", [
          { fromSeconds: 0, toSeconds: 200, durationSeconds: 200 },
        ]),
      ],
      owner,
    );
    expect(evts).toEqual([]);
  });

  it("CC 技能但窗口 < CC_HELD_MIN_S(90s)→ 不报", () => {
    const evts = ccHeldEvents(
      [
        cd("118", "Polymorph", [
          { fromSeconds: 0, toSeconds: 80, durationSeconds: 80 },
        ]),
      ],
      owner,
    );
    expect(evts).toEqual([]);
  });

  it("CC 技能且窗口 >= 90s → 报;facts 带 t(floor)/spell/heldS/windowEndT(均整数串)", () => {
    const evts = ccHeldEvents(
      [
        cd("118", "Polymorph", [
          { fromSeconds: 10.4, toSeconds: 105.9, durationSeconds: 95.5 },
        ]),
      ],
      owner,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe("cc-held");
    expect(evts[0]!.t).toBe(10);
    expect(evts[0]!.spell).toBe("Polymorph");
    expect(evts[0]!.facts["t"]).toBe("10");
    expect(evts[0]!.facts["heldS"]).toBe("96");
    expect(evts[0]!.facts["windowEndT"]).toBe("105");
  });

  it("多个超阈值窗口按时长降序排,截 cap=2(CC_HELD_CAP)", () => {
    const evts = ccHeldEvents(
      [
        cd("118", "Polymorph", [
          { fromSeconds: 0, toSeconds: 95, durationSeconds: 95 },
          { fromSeconds: 200, toSeconds: 320, durationSeconds: 120 },
          { fromSeconds: 400, toSeconds: 500, durationSeconds: 100 },
        ]),
      ],
      owner,
    );
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["heldS"])).toEqual(["120", "100"]);
  });

  it("owner kit 里没有被追踪的 CC 大招 → 零产出(三态)", () => {
    expect(ccHeldEvents([], owner)).toEqual([]);
  });
});

describe("ccAvoidableEvents(DEFENSIVE-001,2026-08-07 信号扩容批 1)", () => {
  const owner = { id: "h1", name: "Me-R" };
  const cc = (
    dur: number,
    drLevel: "Full" | "50%" | "Immune",
    trinketState: string,
    atSeconds = 40,
  ) => ({
    atSeconds,
    durationSeconds: dur,
    spellName: "Cheap Shot",
    spellId: "1833",
    trinketState: trinketState as never,
    drInfo: { level: drLevel } as never,
  });

  it("< CC_AVOIDABLE_MIN_S(3s)→ 不报,即便有规避手段可用", () => {
    const evts = ccAvoidableEvents(
      [cc(2.9, "Full", "on_cooldown")],
      owner,
      () => ["Divine Shield"],
    );
    expect(evts).toEqual([]);
  });

  it("非 Full DR(50%/Immune)→ 不报", () => {
    expect(
      ccAvoidableEvents([cc(5, "50%", "on_cooldown")], owner, () => [
        "Divine Shield",
      ]),
    ).toEqual([]);
    expect(
      ccAvoidableEvents([cc(5, "Immune", "on_cooldown")], owner, () => [
        "Divine Shield",
      ]),
    ).toEqual([]);
  });

  it("trinketState=available_unused → 不报(去重门,已由 cc-locked/wasted-trinket 覆盖 64.3% 重叠)", () => {
    expect(
      ccAvoidableEvents([cc(5, "Full", "available_unused")], owner, () => [
        "Divine Shield",
      ]),
    ).toEqual([]);
  });

  it("trinketState=passive_trinket/used/on_cooldown 均不触发去重门(只排除 available_unused)", () => {
    for (const state of ["passive_trinket", "used", "on_cooldown"]) {
      const evts = ccAvoidableEvents([cc(5, "Full", state)], owner, () => [
        "Divine Shield",
      ]);
      expect(evts).toHaveLength(1);
    }
  });

  it("无可用规避手段(probe 返回空数组)→ 不报", () => {
    expect(
      ccAvoidableEvents([cc(5, "Full", "on_cooldown")], owner, () => []),
    ).toEqual([]);
  });

  it("Full DR + >=3s + trinket 非 available_unused + 有规避手段 → 报;facts 带 t(floor)/spell/durationS/avoidableWith(顿号连)", () => {
    const evts = ccAvoidableEvents(
      [cc(4.6, "Full", "on_cooldown", 40.9)],
      owner,
      () => ["Divine Shield", "Blessing of Protection"],
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe("cc-avoidable");
    expect(evts[0]!.t).toBe(40);
    expect(evts[0]!.facts["t"]).toBe("40");
    expect(evts[0]!.facts["spell"]).toBe("Cheap Shot");
    expect(evts[0]!.facts["durationS"]).toBe("5");
    expect(evts[0]!.facts["avoidableWith"]).toBe(
      "Divine Shield、Blessing of Protection",
    );
  });

  it("多条按 CC 时长降序排,截 cap=2(CC_AVOIDABLE_CAP)", () => {
    const evts = ccAvoidableEvents(
      [
        cc(3, "Full", "on_cooldown", 10),
        cc(8, "Full", "on_cooldown", 20),
        cc(5, "Full", "on_cooldown", 30),
      ],
      owner,
      () => ["Divine Shield"],
    );
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["durationS"])).toEqual(["8", "5"]);
  });
});

describe("ccAvoidanceOptionsAt(DEFENSIVE-001 wiring helper,2026-08-07)", () => {
  const cast = (
    spellId: string,
    timestamp: number,
    event: string = LogEvent.SPELL_CAST_SUCCESS,
  ) => ({ spellId, logLine: { event, timestamp } });
  const cc = { atSeconds: 40, spellId: "1833", spellName: "Cheap Shot" };

  it("owner 全场从未施放过该规避技(kit 无证据)→ 不计入", () => {
    const owner = { spellCastEvents: [] };
    expect(ccAvoidanceOptionsAt(owner, cc, 0)).toEqual([]);
  });

  it("owner 施放过该技能,但落地前(t=40s)最近一次施放仍在冷却内 → 不计入", () => {
    // Divine Shield (642, cd 300s) cast at t=10s — still on cooldown at t=40s.
    const owner = { spellCastEvents: [cast("642", 10_000)] };
    expect(ccAvoidanceOptionsAt(owner, cc, 0)).not.toContain("Divine Shield");
  });

  it("owner 落地前从未按过该技能,证据来自落地后的一次施放 → 计入(落地前视为一直可用)", () => {
    // Divine Shield cast AFTER the CC (t=60s) — proves the kit has it; the
    // pre-CC availability check (t=40s) finds no earlier cast, so it counts
    // as available at the CC.
    const owner = { spellCastEvents: [cast("642", 60_000)] };
    expect(ccAvoidanceOptionsAt(owner, cc, 0)).toContain("Divine Shield");
  });

  it("非 SPELL_CAST_SUCCESS 事件不算证据(例如 SPELL_CAST_START)", () => {
    const owner = {
      spellCastEvents: [cast("642", 60_000, LogEvent.SPELL_CAST_START)],
    };
    expect(ccAvoidanceOptionsAt(owner, cc, 0)).toEqual([]);
  });

  it("多个可用技能:返回顺序确定(跟随 applicableCCAvoidanceIds 的固定迭代顺序)", () => {
    const owner = {
      spellCastEvents: [cast("642", 60_000), cast("1022", 60_000)],
    };
    expect(ccAvoidanceOptionsAt(owner, cc, 0)).toEqual([
      "Divine Shield",
      "Blessing of Protection",
    ]);
  });
});

describe("wasted-trinket(中立局面浪费 PvP 饰品)", () => {
  const probes = {
    // lowest HP% on the team (null = no sample available)
    friendlyHpPctAt: (_t: number) => 95,
    healerInCCAt: (_t: number) => false,
    enemyOffensiveActiveAt: (_t: number) => false,
  };
  const owner = { id: "p1", name: "Me-R" };

  it("全队高血 + 治疗自由 + 无敌方爆发 → 中立,发一条", () => {
    const ev = wastedTrinketEvents([42.4], owner, probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("wasted-trinket");
    expect(ev[0]!.facts.teamMinHpPct).toBe("95");
  });

  it("有人低血(<80%)→ 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => 60,
      }),
    ).toEqual([]);
  });

  it("HP 采不到样 → 保守不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => null,
      }),
    ).toEqual([]);
  });

  it("治疗在 CC 中 → 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, { ...probes, healerInCCAt: () => true }),
    ).toEqual([]);
  });

  it("敌方进攻 CD buff 生效中 → 非中立,不发", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        enemyOffensiveActiveAt: () => true,
      }),
    ).toEqual([]);
  });

  it("agy flash 复核采纳:同一次按压的脏重复记录(近邻,含跨秒)只留最早一条", () => {
    // 42.1 and 42.4 fall in the same second (same id after Math.round, which
    // previously made them silently overwrite each other in auditFindings' byId
    // Map); 42.1 vs 43.2 cross a second boundary and would produce two coaching
    // entries nagging about the same action.
    const ev = wastedTrinketEvents([42.1, 42.4, 43.2], owner, probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.t).toBe(42.1);
  });

  it("间隔 ≥ TRINKET_DEDUPE_GAP_S 的两次独立开饰品,但 per-round 上限(TEMPORARY,BACKLOG #22)只保留 1 条", () => {
    // Before the 2026-08-06 throttle both survived (see git history); the
    // WASTED_TRINKET_CAP=1 truncation is exercised end-to-end in the dedicated
    // describe block below.
    const ev = wastedTrinketEvents([42.1, 100], owner, probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.t).toBe(42.1);
  });
});

describe("驱散/徽章类候选 per-round 上限(TEMPORARY,2026-08-06,BACKLOG #22——信号扩容批落地后移除;截断前先按各自严重度字段排序,保住最重的)", () => {
  it("cc-locked ≤2/round:4 条超阈值 CC 按承伤降序,只保留最重的 2 条", () => {
    const cc = (dmg: number) => ({
      atSeconds: 40,
      durationSeconds: 5, // >= CC_LOCKED_MIN_S
      spellName: "Polymorph",
      spellId: "118",
      sourceName: "Mage",
      trinketState: "on_cooldown" as never,
      damageTakenDuring: dmg,
    });
    const evts = ccLockedEvents(
      [cc(10_000), cc(40_000), cc(30_000), cc(20_000)],
      { id: "P1", name: "Me" },
    );
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["damageTakenK"])).toEqual(["40", "30"]);
  });

  it("missed-purge ≤2/round:4 条 High 优先级窗口按时长降序,只保留最重的 2 条", () => {
    const w = (dur: number) => ({
      timeSeconds: 20,
      durationSeconds: dur,
      enemyName: "Enemy",
      spellName: "PI",
      spellId: "10060",
      priority: "High" as never,
      purgeWasOnCD: false,
      duringKillWindow: false,
      purgersLockedOut: false,
      losReachable: null,
    });
    const evts = missedPurgeEvents([w(10), w(40), w(30), w(20)]);
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["duration"])).toEqual(["40.0", "30.0"]);
  });

  it("missed-cleanse ≤2/round:4 条 High 优先级窗口按承伤降序,只保留最重的 2 条", () => {
    const owner = { id: "owner", spec: "256" }; // Priest_Discipline, MAGIC_REMOVERS
    const w = (dmg: number) => ({
      timeSeconds: 30,
      durationSeconds: 5,
      targetName: "Ally",
      spellName: "Fear",
      spellId: "5782",
      priority: "High" as const,
      postCcDamage: dmg,
      cleanseWasOnCD: false,
      dispellersLockedOut: false,
      losReachable: null,
      drChainRisk: false,
      dispelType: "Magic" as const,
    });
    const evts = missedCleanseEvents(
      [w(10_000), w(40_000), w(30_000), w(20_000)],
      owner,
      [owner],
      false,
    );
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.facts["postCcDamageK"])).toEqual(["40", "30"]);
  });

  it("wasted-trinket ≤1/round:3 次中立按压(间隔均超去重窗)按 teamMinHpPct 降序,只保留最中立的 1 条", () => {
    const owner = { id: "p1", name: "Me-R" };
    const hpByT = new Map([
      [10, 82],
      [80, 99],
      [160, 90],
    ]);
    const probes = {
      friendlyHpPctAt: (t: number) => hpByT.get(t) ?? null,
      healerInCCAt: () => false,
      enemyOffensiveActiveAt: () => false,
    };
    const evts = wastedTrinketEvents([10, 80, 160], owner, probes);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.t).toBe(80);
    expect(evts[0]!.facts["teamMinHpPct"]).toBe("99");
  });

  it("防漂移(2026-08-11):LEGACY_TOPIC_TYPES 恰好覆盖本 describe 块的四个类型,不多不少 -- 挑选层多样性指令(buildFindingsPrompt)与审计层上限(auditFindings)都从这个 export 派生四族名单,漂移会让二者与这四个每-round-上限函数各说各话", () => {
    expect([...LEGACY_TOPIC_TYPES].sort()).toEqual(
      ["cc-locked", "missed-cleanse", "missed-purge", "wasted-trinket"].sort(),
    );
    // End-to-end: the actual `.type` string each capped function emits must
    // be a member of the set -- pins the association by real output, not by
    // two hand-typed string lists that merely happen to agree today.
    const cc = ccLockedEvents(
      [
        {
          atSeconds: 40,
          durationSeconds: 5,
          spellName: "Polymorph",
          spellId: "118",
          sourceName: "Mage",
          trinketState: "on_cooldown" as never,
          damageTakenDuring: 1000,
        },
      ],
      { id: "P1", name: "Me" },
    );
    const purge = missedPurgeEvents([
      {
        timeSeconds: 20,
        durationSeconds: 10,
        enemyName: "Enemy",
        spellName: "PI",
        spellId: "10060",
        priority: "High" as never,
        purgeWasOnCD: false,
        duringKillWindow: false,
        purgersLockedOut: false,
        losReachable: null,
      },
    ]);
    const cleanseOwner = { id: "owner", spec: "256" };
    const cleanse = missedCleanseEvents(
      [
        {
          timeSeconds: 30,
          durationSeconds: 5,
          targetName: "Ally",
          spellName: "Fear",
          spellId: "5782",
          priority: "High" as const,
          postCcDamage: 10_000,
          cleanseWasOnCD: false,
          dispellersLockedOut: false,
          losReachable: null,
          drChainRisk: false,
          dispelType: "Magic" as const,
        },
      ],
      cleanseOwner,
      [cleanseOwner],
      false,
    );
    const trinket = wastedTrinketEvents(
      [10],
      { id: "p1", name: "Me-R" },
      {
        friendlyHpPctAt: () => 90,
        healerInCCAt: () => false,
        enemyOffensiveActiveAt: () => false,
      },
    );
    for (const evts of [cc, purge, cleanse, trinket]) {
      expect(evts.length).toBeGreaterThan(0);
      for (const e of evts) expect(LEGACY_TOPIC_TYPES.has(e.type)).toBe(true);
    }
  });
});

describe("trinketTeamMinHpPctAt(HP 查询时刻先 floor 到渲染网格)", () => {
  // Review point (agy flash review): querying HP at trinketUseTimes' raw
  // fractional seconds would contradict the whole-second-tick [STATE] view (the
  // same bug as class A of the 2026-07-20 audit; see the toRenderSecond comment
  // in utils/cooldowns.ts). A spy that records its arguments pins down that "the
  // query instant is already toRenderSecond(t)*1000, not the raw t*1000".
  it("查询时刻是 toRenderSecond(t)*1000 + startTime,不是原始 t*1000", () => {
    const calls: number[] = [];
    const spyLookup = (_unit: any, timestampMs: number) => {
      calls.push(timestampMs);
      return 95;
    };
    trinketTeamMinHpPctAt([{ id: "f1" }], { startTime: 1000 }, 42.4, spyLookup);
    // toRenderSecond(42.4) = 42 → 1000 + 42*1000 = 43000; not 1000 + 42400 = 43400.
    expect(calls).toEqual([43000]);
  });

  it("多个友方都用同一个渲染网格时刻查询", () => {
    const calls: number[] = [];
    const spyLookup = (_unit: any, timestampMs: number) => {
      calls.push(timestampMs);
      return 90;
    };
    trinketTeamMinHpPctAt(
      [{ id: "f1" }, { id: "f2" }],
      { startTime: 0 },
      7.9,
      spyLookup,
    );
    // toRenderSecond(7.9) = 7, identical for both players
    expect(calls).toEqual([7000, 7000]);
  });

  it("任何人采不到样 → null(保守不发),仍走渲染网格时刻", () => {
    const spyLookup = (_unit: any, timestampMs: number) =>
      timestampMs === 5000 ? null : 100;
    expect(
      trinketTeamMinHpPctAt(
        [{ id: "f1" }, { id: "f2" }],
        { startTime: 0 },
        5.7,
        spyLookup,
      ),
    ).toBeNull();
  });
});
