import {
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_GAP_MIN_S,
  aurasActiveAt,
  buildCastFlowLines,
  buildMomentSnapshotItems,
  largestCastGap,
  MOMENT_PACK_MAX,
} from "./momentSnapshot";
import type { PackItem } from "./deepDive";

// Copies the mkUnit style used by deepDive.window.test.ts (~24-49): a plain
// object literal shaped like ICombatUnit, cast through `as any` at call sites
// (buildMomentSnapshotItems takes `combat: any`) — the minimal fields each
// consumed predicate actually reads.
const mkUnit = (
  id: string,
  name: string,
  friendly: boolean,
  spec: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name,
  info: { specId: spec },
  spec,
  class: CombatUnitClass.None,
  type: CombatUnitType.Player,
  reaction: friendly ? CombatUnitReaction.Friendly : CombatUnitReaction.Hostile,
  advancedActions: [],
  damageOut: [],
  damageIn: [],
  healOut: [],
  healIn: [],
  absorbsOut: [],
  absorbsIn: [],
  auraEvents: [],
  spellCastEvents: [],
  castStartEvents: [],
  deathRecords: [],
  ...overrides,
});

const advAt = (
  id: string,
  timestamp: number,
  posX: number,
  posY: number,
  currentHp: number,
  maxHp = 100,
) => ({
  // getUnitPositionAtTime/getUnitRawPositionAtTime read the top-level
  // `timestamp`; getUnitHpAtTimestamp reads `logLine.timestamp` — production
  // CombatAdvancedAction carries both (see testHelpers.ts's makeAdvancedAction).
  timestamp,
  logLine: { timestamp },
  advancedActorId: id,
  advancedActorPositionX: posX,
  advancedActorPositionY: posY,
  advancedActorCurrentHp: currentHp,
  advancedActorMaxHp: maxHp,
});

const castEvent = (
  timestamp: number,
  spellId = "1",
  spellName = "TestSpell",
) => ({
  logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp, parameters: [] },
  timestamp,
  spellId,
  spellName,
});

const auraEvent = (
  event: LogEvent,
  timestamp: number,
  spellId: string,
  destUnitId: string,
  srcUnitId: string,
  spellName = spellId,
  srcUnitName = srcUnitId,
) => ({
  logLine: { event, timestamp, parameters: [] },
  timestamp,
  spellId,
  spellName,
  srcUnitId,
  srcUnitName,
  destUnitId,
  destUnitName: destUnitId,
});

const dmgEvent = (timestamp: number, effectiveAmount: number) => ({
  logLine: { event: LogEvent.SPELL_DAMAGE, timestamp, parameters: [] },
  timestamp,
  effectiveAmount,
});

describe("largestCastGap", () => {
  const unit = (times: number[]) => ({
    spellCastEvents: times.map((s) => castEvent(s * 1000)),
  });

  it("窗口边界算端点,最大间隔达阈值才返回", () => {
    const u = unit([12, 20]);
    expect(largestCastGap(u, 10, 30, 0)).toEqual({
      fromT: 20,
      toT: 30,
      gapS: 10,
    });
    expect(largestCastGap(u, 10, 21, 0)).toEqual({
      fromT: 12,
      toT: 20,
      gapS: 8,
    });
  });

  it("全部间隔 < ACTIVITY_GAP_MIN_S → null", () => {
    const u = unit([11, 12, 13]);
    expect(largestCastGap(u, 10, 14, 0)).toBeNull();
    // sanity: the constant really is what the null case relies on
    expect(ACTIVITY_GAP_MIN_S).toBe(4);
  });
});

describe("aurasActiveAt", () => {
  const combat = { startTime: 0, endTime: 100_000 };

  it("只取 t 时刻在身的光环名", () => {
    const u = mkUnit(
      "o",
      "Owner-Area52",
      true,
      CombatUnitSpec.Priest_Discipline,
      {
        auraEvents: [
          auraEvent(
            LogEvent.SPELL_AURA_APPLIED,
            5_000,
            "17",
            "o",
            "o",
            "Shield",
          ),
          auraEvent(
            LogEvent.SPELL_AURA_REMOVED,
            15_000,
            "17",
            "o",
            "o",
            "Shield",
          ),
        ],
      },
    );
    expect(aurasActiveAt(u, combat, 10)).toEqual(["Shield"]);
    expect(aurasActiveAt(u, combat, 20)).toEqual([]);
  });

  it("在身光环 > 10 个时截断到 10", () => {
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      // Out-of-range spell ids: no official-duration data exists for them, so
      // buildAuraIntervals' "no REMOVED seen" branch extends to the full match
      // duration and every aura is still up at t=50 — a real spell id could
      // coincidentally carry a short official duration and close early.
      const spellId = `${9_000_000 + i}`;
      events.push(
        auraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          0,
          spellId,
          "o",
          "o",
          `Buff${i}`,
        ),
      );
    }
    const u = mkUnit(
      "o",
      "Owner-Area52",
      true,
      CombatUnitSpec.Priest_Discipline,
      {
        auraEvents: events,
      },
    );
    expect(aurasActiveAt(u, combat, 50)).toHaveLength(10);
  });
});

describe("buildCastFlowLines", () => {
  it("升序、上限 90、超限有 (+N more) 尾标", () => {
    const a = mkUnit("a", "Alpha-Area52", true, CombatUnitSpec.Warrior_Arms, {
      spellCastEvents: [
        castEvent(20_000, "1", "Charge"),
        castEvent(10_000, "2", "Slam"),
      ],
    });
    const combat = { startTime: 0, endTime: 100_000, units: { a } };
    const lines = buildCastFlowLines(combat, 0, 30);
    expect(lines).toEqual([
      "0:10 Alpha(Arms Warrior) → Slam",
      "0:20 Alpha(Arms Warrior) → Charge",
    ]);
  });

  it("超过 90 次施法:保留前 89 行 + 追加 (+N more)", () => {
    const times = Array.from({ length: 95 }, (_, i) => i * 1000);
    const a = mkUnit("a", "Alpha-Area52", true, CombatUnitSpec.Warrior_Arms, {
      spellCastEvents: times.map((t) => castEvent(t)),
    });
    const combat = { startTime: 0, endTime: 200_000, units: { a } };
    const lines = buildCastFlowLines(combat, 0, 200);
    expect(lines).toHaveLength(90);
    expect(lines[89]).toBe("…(+6 more)");
  });
});

describe("buildMomentSnapshotItems", () => {
  // Fixture: 3-player match (owner healer + teammate + enemy), window [10,30]
  // (midT = 20). Every kind is engineered to fire at least once so the facts
  // shape can be checked kind-by-kind; hp-snap additionally exercises the
  // "field omitted when unreachable" path (warr/mage only sample at t=20, so
  // hpStart/hpEnd at the window edges fall outside HP_SAMPLE_RADIUS_MS).
  const owner = mkUnit(
    "o",
    "Owner-Area52",
    true,
    CombatUnitSpec.Priest_Discipline,
    {
      advancedActions: [
        advAt("o", 10_000, 0, 0, 80),
        advAt("o", 20_000, 0, 0, 50),
        advAt("o", 30_000, 0, 0, 90),
      ],
      // Owner has activity right at the window edges (6s/40s) — largestCastGap
      // alone would find a real [10,30] gap, but the healing-gap this healer
      // produces in-window must suppress the activity-gap duplicate.
      spellCastEvents: [
        castEvent(6_000, "9", "Flash Heal"),
        castEvent(40_000, "9", "Flash Heal"),
      ],
      healOut: [castEvent(6_000), castEvent(40_000)],
      auraEvents: [
        auraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          15_000,
          "17",
          "o",
          "o",
          "TestBuff",
        ),
        auraEvent(
          LogEvent.SPELL_AURA_REMOVED,
          25_000,
          "17",
          "o",
          "o",
          "TestBuff",
        ),
      ],
    },
  );
  const warr = mkUnit("w", "Warr-Area52", true, CombatUnitSpec.Warrior_Arms, {
    advancedActions: [advAt("w", 20_000, 3, 4, 70)],
    spellCastEvents: [castEvent(12_000), castEvent(14_000)],
    damageIn: [dmgEvent(20_000, 50)],
  });
  const mage = mkUnit("e", "Emage-Area52", false, CombatUnitSpec.Mage_Frost, {
    advancedActions: [advAt("e", 20_000, 30, 40, 60)],
    spellCastEvents: [castEvent(15_000)],
    auraEvents: [
      auraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        15_000,
        "118",
        "e",
        "o",
        "Polymorph",
        "Owner-Area52",
      ),
      auraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        20_000,
        "118",
        "e",
        "o",
        "Polymorph",
        "Owner-Area52",
      ),
    ],
  });
  const combat = {
    startTime: 0,
    endTime: 200_000,
    zoneId: "1505",
    units: { o: owner, w: warr, e: mage },
  };

  const items = buildMomentSnapshotItems(combat, 10, 30, "Owner-Area52");
  const byKind = <K extends PackItem["kind"]>(kind: K) =>
    items.filter((it) => it.kind === kind);
  const byKindUnit = (kind: PackItem["kind"], unit: string) =>
    items.find((it) => it.kind === kind && it.facts.unit === unit);

  it("数字纪律:facts 里每个纯数字字符串值都不带小数点", () => {
    for (const it of items) {
      for (const v of Object.values(it.facts)) {
        if (/^\d+\.\d+$/.test(v)) {
          throw new Error(`facts value "${v}" carries a decimal point`);
        }
      }
    }
  });

  it("cd-ledger:每玩家 1 条,ready/onCd 用「、」连接,空为「无」", () => {
    const cds = byKind("cd-ledger");
    expect(cds).toHaveLength(3);
    for (const it of cds) {
      expect(it.facts.t).toBe("20");
      expect(it.facts.ready).toBe("无");
      expect(it.facts.onCd).toBe("无");
      expect(it.label).toBe(`${it.facts.unit} 冷却台账`);
    }
    expect(byKindUnit("cd-ledger", "Owner")!.facts.role).toBe("owner");
    expect(byKindUnit("cd-ledger", "Warr")!.facts.role).toBe("teammate");
    expect(byKindUnit("cd-ledger", "Emage")!.facts.role).toBe("enemy");
  });

  it("aura-snap:在身光环的 Owner/Emage 产出,无光环的 Warr 跳过", () => {
    // aurasActiveAt has no buff/debuff distinction (the brief's spec is "any
    // aura up at t") — Emage's incoming Polymorph interval [15,20] is still
    // active at the window midpoint t=20 (inclusive boundary), so Emage gets
    // an aura-snap item too; only Warr (no aura events at all) is skipped.
    const auras = byKind("aura-snap");
    expect(auras.map((it) => it.facts.unit).sort()).toEqual(["Emage", "Owner"]);
    expect(byKindUnit("aura-snap", "Owner")!.facts).toEqual({
      t: "20",
      unit: "Owner",
      role: "owner",
      auras: "TestBuff",
    });
    expect(byKindUnit("aura-snap", "Emage")!.facts).toEqual({
      t: "20",
      unit: "Emage",
      role: "enemy",
      auras: "Polymorph",
    });
  });

  it("pos-snap:owner 对每个其余玩家各 1 条,距离整数,近距离必然有 LoS", () => {
    const pos = byKind("pos-snap");
    expect(pos).toHaveLength(2);
    const vsWarr = pos.find((it) => it.facts.unit === "Warr")!;
    expect(vsWarr.facts.dist).toBe("5"); // (0,0)-(3,4)
    expect(vsWarr.facts.los).toBe("有"); // < 8yd near-range LoS exemption
    const vsMage = pos.find((it) => it.facts.unit === "Emage")!;
    expect(vsMage.facts.dist).toBe("50"); // (0,0)-(30,40)
    expect(vsMage.facts.role).toBe("enemy");
    expect(vsMage.label).toBe("与 Emage 距离");
  });

  it("dr-state:落地的 Polymorph 记一条,drLevel 原样字符串", () => {
    const dr = byKind("dr-state");
    expect(dr).toHaveLength(1);
    expect(dr[0]!.facts).toEqual({
      t: "15",
      caster: "Owner",
      target: "Emage",
      spell: "Polymorph",
      drLevel: "Full",
      durationS: "5",
    });
    expect(dr[0]!.label).toBe("Polymorph DR");
  });

  it("healing-gap:与窗口相交的空窗各 1 条", () => {
    const gaps = byKind("healing-gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.facts).toEqual({
      unit: "Owner",
      fromT: "6",
      toT: "40",
      gapS: "34",
      pressured: "Warr",
    });
    expect(gaps[0]!.label).toBe("Owner 治疗空窗");
  });

  it("activity-gap:Warr/Emage 各 1 条;Owner 因已有 healing-gap 而跳过", () => {
    const act = byKind("activity-gap");
    expect(act.map((it) => it.facts.unit).sort()).toEqual(["Emage", "Warr"]);
    expect(byKindUnit("activity-gap", "Owner")).toBeUndefined();
    const warrGap = byKindUnit("activity-gap", "Warr")!;
    expect(warrGap.facts).toEqual({
      unit: "Warr",
      role: "teammate",
      fromT: "14",
      toT: "30",
      gapS: "16",
    });
  });

  it("hp-snap:三值全取到的字段齐全;只采到中点的单位省略 hpStart/hpEnd", () => {
    const ownerHp = byKindUnit("hp-snap", "Owner")!;
    expect(ownerHp.facts).toEqual({
      t0: "10",
      t1: "30",
      unit: "Owner",
      role: "owner",
      hpStart: "80",
      hpEnd: "90",
      hpMin: "50",
    });
    const warrHp = byKindUnit("hp-snap", "Warr")!;
    expect(warrHp.facts).toEqual({
      t0: "10",
      t1: "30",
      unit: "Warr",
      role: "teammate",
      hpMin: "70",
    });
    expect(warrHp.facts.hpStart).toBeUndefined();
    expect(warrHp.facts.hpEnd).toBeUndefined();
  });

  it("MOMENT_PACK_MAX 是导出的容量上限常量", () => {
    expect(MOMENT_PACK_MAX).toBe(32);
    expect(items.length).toBeLessThanOrEqual(MOMENT_PACK_MAX);
  });
});
