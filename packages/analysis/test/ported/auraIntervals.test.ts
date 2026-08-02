import { describe, expect, it } from "vitest";

import { buildAuraIntervals } from "../../src/utils/auraIntervals";
import type { ICombatUnit } from "@gladlog/parser-compat";

const T0 = 1_000_000;
const combat = { startTime: T0, endTime: T0 + 90_000 };

function unit(auraEvents: unknown[]): ICombatUnit {
  return { id: "u1", auraEvents } as unknown as ICombatUnit;
}
function ev(
  event: string,
  offsetMs: number,
  spellId: string,
  over: Record<string, unknown> = {},
) {
  return {
    spellId,
    spellName: `S${spellId}`,
    timestamp: T0 + offsetMs,
    srcUnitId: "src",
    srcUnitName: "Src",
    destUnitId: "u1",
    destUnitName: "U1",
    logLine: { event, timestamp: T0 + offsetMs, parameters: [] },
    ...over,
  };
}

describe("buildAuraIntervals(第四阶段④)", () => {
  it("APPLIED→REMOVED 配对成区间;多段互不串", () => {
    const iv = buildAuraIntervals(
      unit([
        ev("SPELL_AURA_APPLIED", 5_000, "100"),
        ev("SPELL_AURA_REMOVED", 15_000, "100"),
        ev("SPELL_AURA_APPLIED", 30_000, "100"),
        ev("SPELL_AURA_REMOVED", 42_000, "100"),
      ]),
      combat,
    );
    expect(iv.map((i) => [i.fromS, i.toS])).toEqual([
      [5, 15],
      [30, 42],
    ]);
    expect(iv.every((i) => !i.inferredStart && !i.inferredEnd)).toBe(true);
  });

  it("只见 REMOVED → 开局前已挂:from 0 且 inferredStart", () => {
    const iv = buildAuraIntervals(
      unit([ev("SPELL_AURA_REMOVED", 20_000, "200")]),
      combat,
    );
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ fromS: 0, toS: 20, inferredStart: true });
  });

  it("REFRESH 无开段 → 开局前已挂并延续;后续 REMOVED 收段", () => {
    const iv = buildAuraIntervals(
      unit([
        ev("SPELL_AURA_REFRESH", 10_000, "300"),
        ev("SPELL_AURA_REMOVED", 50_000, "300"),
      ]),
      combat,
    );
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ fromS: 0, toS: 50, inferredStart: true });
  });

  it("到场终未 REMOVED → 收在时长处且 inferredEnd", () => {
    const iv = buildAuraIntervals(
      unit([ev("SPELL_AURA_APPLIED", 60_000, "400")]),
      combat,
    );
    expect(iv[0]).toMatchObject({ fromS: 60, toS: 90, inferredEnd: true });
  });

  it("BROKEN/BROKEN_SPELL 也收段;dest 非本单位的事件被过滤", () => {
    const iv = buildAuraIntervals(
      unit([
        ev("SPELL_AURA_APPLIED", 5_000, "500"),
        ev("SPELL_AURA_BROKEN_SPELL", 9_000, "500"),
        ev("SPELL_AURA_APPLIED", 20_000, "600", { destUnitId: "other" }),
      ]),
      combat,
    );
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ spellId: "500", fromS: 5, toS: 9 });
  });

  it("重复 APPLIED(叠层错报)不重开段", () => {
    const iv = buildAuraIntervals(
      unit([
        ev("SPELL_AURA_APPLIED", 5_000, "700"),
        ev("SPELL_AURA_APPLIED", 8_000, "700"),
        ev("SPELL_AURA_REMOVED", 12_000, "700"),
      ]),
      combat,
    );
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ fromS: 5, toS: 12 });
  });
});

describe("2026-07-25 生产修正:双来源分键 / DOSE 开段 / 官方时长封顶", () => {
  const combat = { startTime: 0, endTime: 300_000 }; // 5 minutes
  const aura = (
    ev: string,
    t: number,
    spellId: string,
    srcUnitId: string,
  ) => ({
    logLine: { event: ev },
    timestamp: t,
    spellId,
    spellName: `S${spellId}`,
    srcUnitId,
    srcUnitName: srcUnitId,
    destUnitId: "me",
  });
  const unit = (evs: unknown[]) =>
    ({ id: "me", auraEvents: evs }) as never;

  it("双来源同法术:第二来源的 REMOVED 不再产生 0 秒起幻影虚线", () => {
    const ivs = buildAuraIntervals(
      unit([
        aura("SPELL_AURA_APPLIED", 10_000, "17", "priestA"),
        aura("SPELL_AURA_APPLIED", 12_000, "17", "priestB"),
        aura("SPELL_AURA_REMOVED", 16_000, "17", "priestA"),
        aura("SPELL_AURA_REMOVED", 18_000, "17", "priestB"),
      ]),
      combat,
    );
    expect(ivs).toHaveLength(2);
    expect(ivs.every((iv) => !iv.inferredStart && !iv.inferredEnd)).toBe(true);
    expect(ivs.map((iv) => [iv.fromS, iv.toS])).toEqual([
      [10, 16],
      [12, 18],
    ]);
  });

  it("APPLIED_DOSE 开段(叠层光环首事件)", () => {
    const ivs = buildAuraIntervals(
      unit([
        aura("SPELL_AURA_APPLIED_DOSE", 20_000, "17", "a"),
        aura("SPELL_AURA_REMOVED", 30_000, "17", "a"),
      ]),
      combat,
    );
    expect(ivs).toEqual([
      expect.objectContaining({ fromS: 20, toS: 30, inferredStart: false }),
    ]);
  });

  it("无 APPLIED 的 REMOVED:回推至多官方时长(122 冰霜新星 6s),非 0 起", () => {
    // 116 Frostbolt has a short duration in spellEffectGenerated; assert the
    // interval does not start at 0
    const ivs = buildAuraIntervals(
      unit([aura("SPELL_AURA_REMOVED", 200_000, "122", "mage")]),
      combat,
    );
    expect(ivs).toHaveLength(1);
    expect(ivs[0]!.inferredStart).toBe(true);
    expect(ivs[0]!.fromS).toBe(194); // 200s − the official 6s
  });

  it("无官方时长的 REMOVED 维持旧行为(0 起,真·开局前已挂语义)", () => {
    const ivs = buildAuraIntervals(
      unit([aura("SPELL_AURA_REMOVED", 200_000, "999999", "x")]),
      combat,
    );
    expect(ivs[0]!.fromS).toBe(0);
    expect(ivs[0]!.inferredStart).toBe(true);
  });

  it("未见 REMOVED:延至多官方时长,短光环不再虚到比赛结束", () => {
    const ivs = buildAuraIntervals(
      unit([aura("SPELL_AURA_APPLIED", 10_000, "122", "mage")]),
      combat,
    );
    expect(ivs[0]!.inferredEnd).toBe(true);
    expect(ivs[0]!.toS).toBe(16); // 10s + the official 6s, not 300s
  });
});
