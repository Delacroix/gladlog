import { LogEvent } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  cdWasteEvents,
  deathSetupEvents,
  deathUnusedDefensiveEvents,
  externalUnusedEvents,
  extractCandidateFindings,
  missedCleanseEvents,
  missedPurgeEvents,
  ccLockedEvents,
  kickEatenEvents,
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
          // 覆盖 [138,150] 窗口:143 起 5s 控
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
          // 120+8=128 < 150-12=138 → 窗口外
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
    // 回溯超 90s(死亡 150,饰品 40 → gap 110)不出
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
      victimCDs: [cd("Early", 100)], // ready at 220 > 150 → CD 中
    });
    expect(early).toHaveLength(1);
    expect(early[0]!.facts["kind"]).toBe("defensive-early");
    expect(early[0]!.t).toBe(100);
    expect(early[0]!.facts["gapS"]).toBe("50");
    // Optimal 用法不出
    expect(
      deathSetupEvents({
        deathT: 150,
        victim,
        victimCDs: [cd("Optimal", 100)],
      }),
    ).toHaveLength(0);
    // 死亡时已转好(可用未按归 death-trace,不是提前用掉的链)不出
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

  it("throughput 型不算保命技 → 不发", () => {
    const p = { ...base, victimCDs: [wall({ isThroughput: true })] };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  // 真实白名单里取 id(不 mock 集合本身):要一个只在 USABLE_WHILE_CC_SPELL_IDS
  // 而不在 FORBEARANCE_GATED_IDS 里的 id,避免与下面的 Forbearance 用例互相干扰。
  const usableInCcOnlyId = [...USABLE_WHILE_CC_SPELL_IDS].find(
    (id) => !FORBEARANCE_GATED_IDS.has(id),
  )!;

  it("死亡时在 CC 且饰品在 CD,但技能在 CC 中可用清单里 → 仍发,free=usable_in_cc", () => {
    // freeState=null 分支(在 CC 且 trinketState=on_cooldown)必须靠
    // USABLE_WHILE_CC_SPELL_IDS 命中才放行——这是全包唯一发出
    // "usable_in_cc" 字符串的路径,否则 freeState===null && !has(...) 的
    // 翻转(||/&& 写反)不会被任何测试抓到。
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
    // 圣盾类在 Forbearance 窗口内实际按不出来;若这条排除回归,教练会
    // 假指摘玩家没按一个物理上按不出来的技能——正是该谓词要防的误伤,
    // 且此前没有任何测试能抓住这个回归。
    const forbearanceGatedId = [...FORBEARANCE_GATED_IDS][0]!;
    const forbUnit = {
      id: "p1",
      spellCastEvents: [
        {
          logLine: { event: LogEvent.SPELL_CAST_SUCCESS },
          spellId: forbearanceGatedId,
          timestamp: 80_000, // matchStartMs=0 → 80s,deathT=100 → 20s 前,在 30s 窗口内
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
      ownerCC: [], // 全程自由
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
      ownerCC: [{ atSeconds: 94, durationSeconds: 7 }], // 覆盖 [94,101]
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
      ownerCC: [{ atSeconds: 95, durationSeconds: 4 }], // 空档 [99,100] 仅 1s… + [95 前 0s]?
      ownerAliveAt: () => true,
    });
    // 窗口 [95,100]:CC 盖 [95,99] → 最大空档 1.0s < 1.5 → 不发
    expect(ev).toEqual([]);
    const ev2 = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 3 }], // 空档 [98,100] = 2s ≥ 1.5
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
  it("missed-cleanse:只报 Critical/High 且解控可用;按承伤排序截 3", () => {
    const w = (p: string, dmg: number, onCD = false) => ({
      timeSeconds: 30,
      durationSeconds: 5,
      targetName: "Ally",
      spellName: "Fear",
      spellId: "5782",
      priority: p as never,
      postCcDamage: dmg,
      cleanseWasOnCD: onCD,
    });
    const evts = missedCleanseEvents([
      w("Critical", 100_000),
      w("High", 50_000),
      w("Medium", 999_999), // 低优先级不报
      w("Critical", 80_000, true), // 解控在 CD 不报
      w("High", 70_000),
      w("High", 60_000), // 第 4 条被截
    ]);
    expect(evts).toHaveLength(3);
    expect(evts[0]!.facts["postCcDamageK"]).toBe("100");
    expect(evts.every((e) => e.type === "missed-cleanse")).toBe(true);
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
    });
    const evts = missedPurgeEvents([
      w("Medium", true), // 击杀窗口内 → 报
      w("Medium", false), // 窗口外低优先级 → 不报
      w("High", false, true), // CD 中 → 不报
      w("High", false),
    ]);
    expect(evts).toHaveLength(2);
    expect(evts[0]!.facts["inKillWindow"]).toBe("yes"); // 窗口内排前
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

describe("wasted-trinket(中立局面浪费 PvP 饰品)", () => {
  const probes = {
    friendlyHpPctAt: (t: number) => 95, // 全队最低 HP%(null=采不到样)
    healerInCCAt: (t: number) => false,
    enemyOffensiveActiveAt: (t: number) => false,
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
});

describe("trinketTeamMinHpPctAt(HP 查询时刻先 floor 到渲染网格)", () => {
  // 复审要点(agy flash 复核):直接用 trinketUseTimes 的原始小数秒查 HP 会与
  // 整数秒 tick 的 [STATE] 视图打架(2026-07-20 审计 A 类同款 bug,见
  // utils/cooldowns.ts 的 toRenderSecond 注释)。用记录入参的 spy 钉住
  // "查询时刻已是 toRenderSecond(t)*1000,不是原始 t*1000"。
  it("查询时刻是 toRenderSecond(t)*1000 + startTime,不是原始 t*1000", () => {
    const calls: number[] = [];
    const spyLookup = (_unit: any, timestampMs: number) => {
      calls.push(timestampMs);
      return 95;
    };
    trinketTeamMinHpPctAt([{ id: "f1" }], { startTime: 1000 }, 42.4, spyLookup);
    // toRenderSecond(42.4) = 42 → 1000 + 42*1000 = 43000;不是 1000 + 42400 = 43400。
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
    expect(calls).toEqual([7000, 7000]); // toRenderSecond(7.9) = 7,两人一致
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
