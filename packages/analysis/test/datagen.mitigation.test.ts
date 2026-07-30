import { describe, expect, test } from "vitest";
import { transformMitigation } from "../scripts/datagen/genMitigation";

// SpellEffect CSV 最小样:列名以真表为准(实现者先 fetchTable 抽真 CSV 头核对,
// 下面用 genTalentModifiers 已消费过的列名)
const HEADER =
  "ID,DifficultyID,EffectAura,EffectBasePointsF,EffectMiscValue_0,SpellID,Effect";
const row = (
  spellId: string,
  aura: string,
  points: string,
  misc: string,
  diff = "0",
) =>
  `${Math.random().toString().slice(2, 8)},${diff},${aura},${points},${misc},${spellId},6`;

describe("transformMitigation", () => {
  const WL = new Set(["22812", "33206", "642", "97462"]);

  test("87 行:负 points 取绝对值,mask 透传;非白名单/非 87 行忽略", () => {
    const csv = [
      HEADER,
      row("22812", "87", "-20", "127"), // Barkskin: 20% 全学派
      row("33206", "87", "-40", "127"), // Pain Suppression: 40%
      row("99999", "87", "-30", "127"), // 非白名单 → 忽略
      row("22812", "4", "-15", "1"), // 非 87 aura → 忽略
    ].join("\n");
    const r = transformMitigation(csv, WL);
    expect(r.entries).toEqual({
      "22812": { pct: 20, schoolMask: 127 },
      "33206": { pct: 40, schoolMask: 127 },
    });
    expect(r.unresolved).toEqual([]);
  });

  test("同 spell 多条 87 行且值不同 → 不猜,进 unresolved", () => {
    const csv = [
      HEADER,
      row("97462", "87", "-10", "127"),
      row("97462", "87", "-15", "127"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["97462"]));
    expect(r.entries["97462"]).toBeUndefined();
    expect(r.unresolved).toEqual([
      { id: "97462", reason: "multiple-conflicting-87-rows" },
    ]);
  });

  test("同 spell 多条 87 行但值相同 → 收敛为一条(非歧义)", () => {
    const csv = [
      HEADER,
      row("642", "87", "-20", "126"),
      row("642", "87", "-20", "126"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toEqual({ pct: 20, schoolMask: 126 });
  });

  test("白名单内零命中 87 行 → 不进 entries 也不进 unresolved(缺席由防腐测试在合并层抓)", () => {
    const csv = [HEADER, row("642", "4", "-20", "1")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries).toEqual({});
    expect(r.unresolved).toEqual([]);
  });

  test("DifficultyID 非 0 的行忽略(genDrCategories 同款去重口径)", () => {
    const csv = [HEADER, row("642", "87", "-20", "127", "1")].join("\n");
    expect(transformMitigation(csv, new Set(["642"])).entries).toEqual({});
  });

  test("正 points(非减伤语义)→ unresolved 而非收录", () => {
    const csv = [HEADER, row("642", "87", "25", "127")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toBeUndefined();
    expect(r.unresolved).toEqual([{ id: "642", reason: "positive-points" }]);
  });
});
