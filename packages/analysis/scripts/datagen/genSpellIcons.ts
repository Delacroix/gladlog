/**
 * genSpellIcons — spellId → 图标基名(zamimg/wow.tools 通用命名,小写无扩展名)。
 *
 * 数据链:SpellMisc.SpellIconFileDataID → ManifestInterfaceData(FileDataID →
 * interface/icons/<name>.blp)。候选集与 genSpellEffects 相同(策展目录 ∪
 * classMetadata ∪ spellIdLists ∪ 天赋 ∪ PvpTalent)——泳道 chip 图标(backlog #9)
 * 覆盖绝大多数玩家施法;缺表项由 SpellIcon 首字母 fallback 兜底。
 *
 * Build 取 datagen-manifest.json(与其余产物同 build),无 manifest 时才拉最新。
 */
import fs from "fs-extra";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

export function mineSpellIcons(
  csv: {
    spellMisc: Record<string, string>[];
    manifestInterfaceData: Record<string, string>[];
  },
  candidates: Set<string> | null, // null = 全表
): Record<string, string> {
  // FileDataID → 图标基名(只吃 interface/icons/ 下的行,表很大)
  const iconByFileData = new Map<string, string>();
  for (const row of csv.manifestInterfaceData) {
    if (!row.ID) continue;
    // FilePath 用反斜杠(Interface\ICONS\)——统一成正斜杠再比对
    const dir = (row.FilePath ?? "").toLowerCase().replace(/\\/g, "/");
    if (!dir.includes("interface/icons")) continue;
    const base = (row.FileName ?? "").toLowerCase().replace(/\.blp$/, "");
    if (base) iconByFileData.set(row.ID, base);
  }

  const result: Record<string, string> = {};
  for (const row of csv.spellMisc) {
    if (row.DifficultyID !== "0") continue;
    const id = row.SpellID;
    if (!id || (candidates && !candidates.has(id))) continue;
    const icon = iconByFileData.get(row.SpellIconFileDataID ?? "");
    if (icon) result[id] = icon;
  }
  return result;
}

export async function main(): Promise<void> {
  const manifestPath = new URL(
    "../../src/data/datagen-manifest.json",
    import.meta.url,
  ).pathname;
  let build: string;
  try {
    build = (fs.readJsonSync(manifestPath) as { build: string }).build;
  } catch {
    build = await fetchLatestBuild();
  }
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

  const spellMiscParsed = parseCsv(
    await fetchTable("SpellMisc", build, cacheDir),
  );
  assertColumns(
    spellMiscParsed.header,
    ["SpellID", "DifficultyID", "SpellIconFileDataID"],
    "SpellMisc",
  );

  const midParsed = parseCsv(
    await fetchTable("ManifestInterfaceData", build, cacheDir),
  );
  assertColumns(
    midParsed.header,
    ["ID", "FilePath", "FileName"],
    "ManifestInterfaceData",
  );

  // 2026-07-25 全量化:候选宇宙挖法只覆盖 3.5k id,用户对局 UI 可见事件
  // 89% 无图标(光环/符文/专精变体全缺)。改挖 SpellMisc 全表;体积走
  // .json + vite json.stringify(=JSON.parse 装载,见 electron.vite.config
  // 的大 JSON 教训),与 41 万键的 spellNames.json 同模式同量级。
  const icons = mineSpellIcons(
    {
      spellMisc: spellMiscParsed.rows,
      manifestInterfaceData: midParsed.rows,
    },
    null,
  );

  const jsonPath = new URL(
    "../../src/data/spellIconsGenerated.json",
    import.meta.url,
  ).pathname;
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      icons,
      Object.keys(icons).sort((a, b) => Number(a) - Number(b)),
    ),
  );
  const outPath = new URL(
    "../../src/data/spellIconsGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Mined: ${Object.keys(icons).length}(SpellMisc 全表)\n * 数据在同名 .json(vite json.stringify → JSON.parse 装载,大 JSON 教训)。\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `import rawIcons from "./spellIconsGenerated.json";\n\nexport const SPELL_ICONS_GENERATED: Record<string, string> =\n  rawIcons as Record<string, string>;\n`,
  );
  console.log(
    `spellIconsGenerated: ${Object.keys(icons).length} ids mined, 全表 (build ${build})`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("genSpellIcons.ts")) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
