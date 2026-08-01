import { fileURLToPath } from "url";
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import * as Enums from "../src/enums";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(
  __dirname,
  "../data/legacy-enum-manifest.json",
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

function getEnumMemberNames(tsEnum: any): string[] {
  return Object.keys(tsEnum).filter((key) => isNaN(Number(key)));
}

describe("Legacy Enum Compatibility", () => {
  it("should match the manifest exactly for LogEvent", () => {
    const manifestEnum = manifest.LogEvent;
    const tsEnum = Enums.LogEvent;

    expect(getEnumMemberNames(tsEnum).length).toBe(51);

    for (const key of Object.keys(manifestEnum)) {
      const manifestVal = manifestEnum[key];
      expect((tsEnum as any)[key]).toBe(manifestVal);
    }
  });

  // CombatUnitSpec/CombatUnitClass 自 2026-08-01 起由暴雪 DB2 生成
  // (见 packages/analysis/scripts/datagen/genCombatUnitEnums.ts 与
  // docs/DATA-COMPLIANCE.md)。manifest 仍是旧运行时 dump 的历史记录,
  // 但担保口径变了:担保**取值**这一层暴雪事实,不再担保成员名与私有编号。

  it("covers every specId in the manifest (values are Blizzard facts)", () => {
    const manifestEnum = manifest.CombatUnitSpec;
    const tsEnum = Enums.CombatUnitSpec;

    expect(getEnumMemberNames(tsEnum).length).toBe(41);

    // 按 specId 取值比对,不按成员名 —— 生成器用官方 Name_lang 拼名字,
    // 与旧 dump 差一个 Monk_BrewMaster/Monk_Brewmaster(暴雪写作 Brewmaster)。
    const ours = new Set(Object.values(tsEnum) as string[]);
    for (const key of Object.keys(manifestEnum)) {
      expect(ours.has(manifestEnum[key])).toBe(true);
    }
  });

  it("uses official ChrClasses IDs for CombatUnitClass (diverges from the legacy dump on purpose)", () => {
    const tsEnum = Enums.CombatUnitClass;

    expect(getEnumMemberNames(tsEnum).length).toBe(14);

    // 官方 ChrClasses.ID。旧 dump 是外部项目自造的编号(1=Warrior,2=Hunter…),
    // 已随枚举生成化弃用;此处钉的是暴雪事实,不是那套编号。
    // 差分预言机不比 class 字段(normalize.ts 的 NormUnit 只取 spec/reaction/type),
    // 所以这次改值不影响 parity 门。
    const official: Record<string, number> = {
      Warrior: 1,
      Paladin: 2,
      Hunter: 3,
      Rogue: 4,
      Priest: 5,
      DeathKnight: 6,
      Shaman: 7,
      Mage: 8,
      Warlock: 9,
      Monk: 10,
      Druid: 11,
      DemonHunter: 12,
      Evoker: 13,
    };
    for (const [name, id] of Object.entries(official)) {
      expect((tsEnum as any)[name]).toBe(id);
    }
    expect(tsEnum.None).toBe(0);

    // 旧编号不得悄悄复辟:Hunter 在旧 dump 里是 2,官方是 3。
    expect((tsEnum as any).Hunter).not.toBe(manifest.CombatUnitClass.Hunter);
  });

  it("should match the manifest exactly for CombatUnitReaction", () => {
    const manifestEnum = manifest.CombatUnitReaction;
    const tsEnum = Enums.CombatUnitReaction;

    for (const key of Object.keys(manifestEnum)) {
      const manifestVal = manifestEnum[key];
      expect((tsEnum as any)[key]).toBe(manifestVal);
    }
  });

  it("should match the manifest exactly for CombatUnitType", () => {
    const manifestEnum = manifest.CombatUnitType;
    const tsEnum = Enums.CombatUnitType;

    for (const key of Object.keys(manifestEnum)) {
      const manifestVal = manifestEnum[key];
      expect((tsEnum as any)[key]).toBe(manifestVal);
    }
  });

  it("should match the manifest exactly for CombatResult", () => {
    const manifestEnum = manifest.CombatResult;
    const tsEnum = Enums.CombatResult;

    for (const key of Object.keys(manifestEnum)) {
      const manifestVal = manifestEnum[key];
      expect((tsEnum as any)[key]).toBe(manifestVal);
    }
  });

  it("should match the manifest exactly for CombatUnitPowerType", () => {
    const manifestEnum = manifest.CombatUnitPowerType;
    const tsEnum = Enums.CombatUnitPowerType;

    expect(getEnumMemberNames(tsEnum).length).toBe(22);

    for (const key of Object.keys(manifestEnum)) {
      const manifestVal = manifestEnum[key];
      // Convert to number because manifest has string values for CombatUnitPowerType (e.g. "-2")
      const expectedVal = Number(manifestVal);
      expect((tsEnum as any)[key]).toBe(expectedVal);
    }
  });
});
