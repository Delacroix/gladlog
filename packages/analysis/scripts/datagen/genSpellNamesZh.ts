import { readFileSync } from "fs";
import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertMinRows,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

/** zhCN 技能名表:仅收「有图标 且 与 enUS 名不同」的条目。
 * wago 未翻译条目同列回落英文 → 与 enMap 相等即未翻译,丢弃(运行时
 * 兜底链 本场日志名 > 本表 > 英文原样,缺项天然落英文)。 */
export function transformSpellNamesZh(
  csvText: string,
  iconIds: ReadonlySet<string>,
  enMap: Record<string, string>,
): Record<string, string> {
  const { rows } = parseCsv(csvText);
  const map: Record<string, string> = {};
  for (const row of rows) {
    const id = row.ID;
    const zh = row.Name_lang;
    if (!iconIds.has(id)) continue;
    if (!zh || zh === enMap[id]) continue;
    map[id] = zh;
  }
  return map;
}

export async function main(): Promise<void> {
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;
  const icons = JSON.parse(
    readFileSync(dataDir + "spellIconsGenerated.json", "utf8"),
  ) as { ids: Record<string, number> };
  const enMap = JSON.parse(
    readFileSync(dataDir + "spellNames.json", "utf8"),
  ) as Record<string, string>;

  const build = await fetchLatestBuild();
  const csv = await fetchTable(
    "SpellName",
    build,
    process.env.DATAGEN_CACHE,
    "zhCN",
  );
  const map = transformSpellNamesZh(
    csv,
    new Set(Object.keys(icons.ids)),
    enMap,
  );
  // 图标集 4.2 万,绝大多数玩家技能有真翻译;跌破 1 万说明 locale 参数
  // 或过滤逻辑坏了,宁可红。
  assertMinRows(Object.keys(map), 10000, "SpellName(zhCN)");
  writeArtifact(dataDir + "spellNamesZhGenerated.json", JSON.stringify(map));
  console.log(Object.keys(map).length, build);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genSpellNamesZh.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
