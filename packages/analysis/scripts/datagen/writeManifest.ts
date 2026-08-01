/**
 * datagen-manifest.json 汇总:记录 build 与各产物规模,
 * 供 update-wow-data 工作流做"是否需要更新"判断。
 */
import { readFileSync, statSync } from "fs";
import { fetchLatestBuild } from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

export async function main(): Promise<void> {
  // DATAGEN_BUILD 钉住 build 号:与各生成脚本保持同一 build,避免
  // manifest 记的 build 比实际生成物新,让下次 update-wow-data 误判"已最新"。
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;

  const readJson = (f: string) =>
    JSON.parse(readFileSync(dataDir + f, "utf-8"));
  const generatedEntries = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    return Object.keys(
      JSON.parse(t.slice(t.indexOf("= {") + 2, t.lastIndexOf(";"))),
    ).length;
  };
  // 同 generatedEntries,但返回按 key 分组的成员数(drCategoriesGenerated 的
  // 五大类各自条数,而非类别数本身)。
  const generatedGroupCounts = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    const obj = JSON.parse(
      t.slice(t.indexOf("= {") + 2, t.lastIndexOf(";")),
    ) as Record<string, unknown[]>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, v.length]),
    );
  };
  // 产物是 `new Set([...])` 字面量(offGcd/dispelObserved 两处),部分还带
  // 逐条 `// ×N` 注释导致不是合法 JSON —— 数引号里的数字 id 反而最稳。
  const countQuotedIds = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    return (t.match(/"\d+"/g) ?? []).length;
  };

  // 枚举产物在另一个包里,且是 TS enum 而非 JSON —— 数成员行,别去 JSON.parse。
  const countEnumMembers = () => {
    const p = new URL(
      "../../../parser-compat/src/enumsGenerated.ts",
      import.meta.url,
    ).pathname;
    const text = readFileSync(p, "utf-8");
    const count = (enumName: string) => {
      const body = text.match(
        new RegExp(`export enum ${enumName} \\{([^}]*)\\}`),
      )?.[1];
      return body ? body.split("\n").filter((l) => l.includes("=")).length : 0;
    };
    return {
      specs: count("CombatUnitSpec"),
      classes: count("CombatUnitClass"),
      bytes: statSync(p).size,
    };
  };

  const manifest = {
    build,
    generatedAt: new Date().toISOString(),
    artifacts: {
      "talentIdMap.json": { specs: readJson("talentIdMap.json").length },
      "spellNames.json": {
        entries: Object.keys(readJson("spellNames.json")).length,
        bytes: statSync(dataDir + "spellNames.json").size,
      },
      "spellNamesZhGenerated.json": {
        entries: Object.keys(readJson("spellNamesZhGenerated.json")).length,
        bytes: statSync(dataDir + "spellNamesZhGenerated.json").size,
      },
      // 同 spellIconsGenerated:.ts 已是 import 壳,从 .json 数
      "spellEffectGenerated.ts": {
        entries: Object.keys(readJson("spellEffectGenerated.json")).length,
        bytes: statSync(dataDir + "spellEffectGenerated.json").size,
      },
      "spellClassMapGenerated.ts": {
        entries: generatedEntries("spellClassMapGenerated.ts"),
      },
      // 从 .json 数(过去数 .ts 的 `= {` 字面量,该文件改成 import 壳后
      // 计数冻在 3568,真值 41707 —— 监控口径瞎了一版没人发现)。
      // .json 是字典编码 {names, ids},entries=ids 键数,distinct=names 长度。
      "spellIconsGenerated.ts": {
        entries: Object.keys(readJson("spellIconsGenerated.json").ids).length,
        distinctIcons: readJson("spellIconsGenerated.json").names.length,
        bytes: statSync(dataDir + "spellIconsGenerated.json").size,
      },
      "trinketItemIds.json": {
        adaptation: readJson("trinketItemIds.json").adaptationItemIds.length,
        relentless: readJson("trinketItemIds.json").relentlessItemIds.length,
      },
      "talentModifiers.json": {
        trackedSpells: Object.keys(readJson("talentModifiers.json")).length,
      },
      "mitigationGenerated.json": {
        entries: Object.keys(readJson("mitigationGenerated.json").entries)
          .length,
        unresolved: readJson("mitigationGenerated.json").unresolved.length,
        bytes: statSync(dataDir + "mitigationGenerated.json").size,
      },
      "offGcdGenerated.ts": {
        entries: countQuotedIds("offGcdGenerated.ts"),
      },
      "drCategoriesGenerated.ts": {
        byCategory: generatedGroupCounts("drCategoriesGenerated.ts"),
      },
      "pvpTalentReplacesGenerated.ts": {
        pairs: generatedEntries("pvpTalentReplacesGenerated.ts"),
      },
      "specIconsGenerated.ts": {
        entries: generatedEntries("specIconsGenerated.ts"),
      },
      // 以下两条的生产者不在本目录(scripts/datagen/),而在
      // packages/eval/scripts/ —— 语料驱动(全量对局日志实证),不是
      // wago.tools DB2 build 驱动,别去 datagen 里找生成器。
      "dispelObservedGenerated.ts": {
        entries: countQuotedIds("dispelObservedGenerated.ts"),
        producer: "packages/eval/scripts/confidenceAudit.ts --emit-table",
      },
      "observedSpellIdsGenerated.json": {
        entries: readJson("observedSpellIdsGenerated.json").length,
        producer: "packages/eval/scripts/observedSpellIds.ts",
      },
      // 唯一一个不落在 analysis/src/data 的产物(枚举属于 parser-compat)。
      // 记进来是为了让 update-wow-data 也会重跑 genCombatUnitEnums —— 漏跑的
      // 表现是新资料片的新专精在枚举里缺席,而缺席不会报错,只会静默漏数据。
      "parser-compat/enumsGenerated.ts": countEnumMembers(),
    },
  };

  writeArtifact(
    dataDir + "datagen-manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`manifest written (build ${build})`);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("writeManifest.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
