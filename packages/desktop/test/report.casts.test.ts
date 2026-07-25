import {
  auraCategory,
  deriveAuraEvents,
  deriveCasts,
  deriveUnitTimeline,
} from "../src/renderer/src/report/derive/casts";
import { loadMatchFixture } from "./fixtures/loadFixture";

describe("deriveCasts / deriveAuraEvents", () => {
  const m = loadMatchFixture();
  const anyPlayer = Object.values(m.units).find(
    (u) => u.kind === "Player" && u.casts.length > 0,
  )!;
  it("施法序列升序合并,数量=casts+petCasts", () => {
    const rows = deriveCasts(m, anyPlayer.id);
    expect(rows).toHaveLength(
      anyPlayer.casts.length + anyPlayer.petCasts.length,
    );
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.t).toBeGreaterThanOrEqual(rows[i - 1]!.t);
    expect(rows.every((r) => r.spellName.length > 0)).toBe(true);
  });
  it("光环序列:applied 标记与 REMOVED 事件名互补", () => {
    const withAuras = Object.values(m.units).find(
      (u) => u.kind === "Player" && u.auraEvents.length > 0,
    )!;
    const rows = deriveAuraEvents(m, withAuras.id);
    expect(rows).toHaveLength(withAuras.auraEvents.length);
    const removed = withAuras.auraEvents.filter((e) =>
      e.eventName.includes("REMOVED"),
    ).length;
    expect(rows.filter((r) => !r.applied)).toHaveLength(removed);
  });
  it("未知 unitId → 空数组", () => {
    expect(deriveCasts(m, "nope")).toEqual([]);
    expect(deriveAuraEvents(m, "nope")).toEqual([]);
  });
});

describe("deriveUnitTimeline(合并施法+重要光环)", () => {
  const m = loadMatchFixture();
  const player = Object.values(m.units).find(
    (u) =>
      u.kind === "Player" && (u.casts.length > 0 || u.auraEvents.length > 0),
  )!;

  it("= 施法 + curated 分类内光环,按时间升序", () => {
    const timeline = deriveUnitTimeline(m, player.id);
    const casts = deriveCasts(m, player.id);
    const importantAuras = deriveAuraEvents(m, player.id).filter((a) =>
      auraCategory(a.spellId),
    );
    expect(timeline).toHaveLength(casts.length + importantAuras.length);
    for (let i = 1; i < timeline.length; i++)
      expect(timeline[i]!.t).toBeGreaterThanOrEqual(timeline[i - 1]!.t);
  });

  it("aura 事件都带有效分类;cast 事件带目标", () => {
    const timeline = deriveUnitTimeline(m, player.id);
    for (const e of timeline) {
      if (e.kind === "aura") {
        expect(e.category.length).toBeGreaterThan(0);
        expect(auraCategory(e.spellId)).toBe(e.category);
      } else {
        expect(e.kind).toBe("cast");
        expect(typeof e.targetName).toBe("string");
      }
    }
  });

  it("过滤掉未分类光环(杂噪 proc 不入流)", () => {
    const timeline = deriveUnitTimeline(m, player.id);
    const auraEvents = timeline.filter((e) => e.kind === "aura");
    expect(auraEvents.every((e) => auraCategory(e.spellId))).toBe(true);
  });

  it("未知 unitId → 空数组", () => {
    expect(deriveUnitTimeline(m, "nope")).toEqual([]);
  });
});

describe("filterGcdNoise(GCD 泳道滤噪,2026-07-25 用户实测 44.5% 折叠)", () => {
  const row = (t: number, spellId: number, byPet = false) => ({
    t,
    spellId,
    spellName: `S${spellId}`,
    targetName: "",
    byPet,
  });
  it("两层门:表外 proc 丢、表内 tick 刷屏丢、正常节奏保留", async () => {
    const { filterGcdNoise } = await import(
      "../src/renderer/src/report/derive/casts"
    );
    const rows = [
      // 官方表外的 proc id(无 SpellCooldowns 行)→ 第一层门丢
      ...[0, 1500, 3000].map((t) => row(t, 999001)),
      // 官方表内真按键(2061 快速治疗)tick 刷屏:间隔 300ms → 物理层丢
      ...[0, 300, 600, 900, 1200].map((t) => row(t, 2061)),
      // 官方表内 + 正常 GCD 节奏(19750 圣光闪现)→ 保留
      ...[0, 1500, 3000, 4500, 6000].map((t) => row(t, 19750)),
    ];
    const kept = filterGcdNoise(rows);
    expect(kept.every((r) => r.spellId === 19750)).toBe(true);
    expect(kept).toHaveLength(5);
  });
  it("双 id 交替刷屏(DH 吞噬型)按名聚合抓住", async () => {
    const { filterGcdNoise } = await import(
      "../src/renderer/src/report/derive/casts"
    );
    const mk = (t: number, spellId: number) => ({
      t,
      spellId,
      spellName: "Devour",
      targetName: "",
      byPet: false,
    });
    // 两个表内 id 交替、各自间隔 1200ms 但合并后 600ms → 物理层按名抓
    const rows = [0, 600, 1200, 1800, 2400, 3000].map((t, i) =>
      mk(t, i % 2 === 0 ? 2061 : 19750),
    );
    expect(filterGcdNoise(rows)).toHaveLength(0);
  });

  it("宠物填充剔除;curated 分类的宠物施法保留(断法 19647)", async () => {
    const { filterGcdNoise } = await import(
      "../src/renderer/src/report/derive/casts"
    );
    const rows = [
      row(0, 999003, true), // 未分类宠物填充
      row(1000, 19647, true), // Spell Lock,SPELL_CATEGORIES 内
    ];
    const kept = filterGcdNoise(rows);
    expect(kept.map((r) => r.spellId)).toEqual([19647]);
  });
});
