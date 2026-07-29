/**
 * datagen-manifest.json 汇总:记录 build 与各产物规模,
 * 供 update-wow-data 工作流做"是否需要更新"判断。
 */
import { readFileSync, statSync } from "fs";
import { fetchLatestBuild } from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

export async function main(): Promise<void> {
  const build = await fetchLatestBuild();
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;

  const readJson = (f: string) =>
    JSON.parse(readFileSync(dataDir + f, "utf-8"));
  const generatedEntries = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    return Object.keys(
      JSON.parse(t.slice(t.indexOf("= {") + 2, t.lastIndexOf(";"))),
    ).length;
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
