/**
 * genSpellIcons — spellId → icon base name (the common zamimg/wow.tools naming:
 * lowercase, no extension).
 *
 * Data chain: SpellMisc.SpellIconFileDataID → ManifestInterfaceData (FileDataID
 * → interface/icons/<name>.blp). The candidate set is the same as
 * genSpellEffects (curated catalog ∪ classMetadata ∪ spellIdLists ∪ talents ∪
 * PvpTalent) — lane chip icons (backlog #9) cover the vast majority of player
 * casts; entries missing from the table fall back to the SpellIcon initial.
 *
 * Build comes from datagen-manifest.json (same build as the other artifacts);
 * only without a manifest does it fetch the latest.
 */
import fs from "fs-extra";

import { collectCandidateIds } from "./lib/candidates";
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
  candidates: Set<string> | null, // null = the whole table
): Record<string, string> {
  // FileDataID → icon base name (only take rows under interface/icons/; the
  // table is huge)
  const iconByFileData = new Map<string, string>();
  for (const row of csv.manifestInterfaceData) {
    if (!row.ID) continue;
    // FilePath uses backslashes (Interface\ICONS\) — normalise to forward
    // slashes before comparing
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

  // 2026-07-25, universe finalised: the original candidate universe (3.5k) was
  // missing 89% of the icons for events actually visible in the match UI, while
  // the full SpellMisc table (408k rows / 13.8MB) blew the first-paint budget
  // (caught for real by the firstPaint budget CI). Final answer = the union of
  // three sources (~40k, 1.4MB):
  //   ids empirically observed in the corpus (observedSpellIdsGenerated,
  //   including the local store)
  //   ∪ every id with a SpellCooldowns row (cover for future abilities)
  //   ∪ the original candidates.
  const observed = JSON.parse(
    fs.readFileSync(
      new URL("../../src/data/observedSpellIdsGenerated.json", import.meta.url)
        .pathname,
      "utf8",
    ),
  ) as number[];
  const scParsed = parseCsv(
    await fetchTable("SpellCooldowns", build, cacheDir),
  );
  const pvpTalentParsed = parseCsv(
    await fetchTable("PvpTalent", build, cacheDir),
  );
  const universe = collectCandidateIds(pvpTalentParsed.rows);
  for (const id of observed) universe.add(String(id));
  for (const row of scParsed.rows)
    if (row.DifficultyID === "0" && row.SpellID) universe.add(row.SpellID);

  const icons = mineSpellIcons(
    {
      spellMisc: spellMiscParsed.rows,
      manifestInterfaceData: midParsed.rows,
    },
    universe,
  );

  const jsonPath = new URL(
    "../../src/data/spellIconsGenerated.json",
    import.meta.url,
  ).pathname;
  // Dictionary encoding: icon names repeat heavily (41.7k entries / ~7.1k
  // distinct), so in a flat Record nearly half the bytes are duplicate strings.
  // Store {names: deduped and sorted, ids: id → index into names}, and expand it
  // back in the .ts shell.
  const sortedIds = Object.keys(icons).sort((a, b) => Number(a) - Number(b));
  const names = [...new Set(sortedIds.map((k) => icons[k]!))].sort();
  const nameIndex = new Map(names.map((n, i) => [n, i]));
  const ids: Record<string, number> = {};
  for (const k of sortedIds) ids[k] = nameIndex.get(icons[k]!)!;
  fs.writeFileSync(jsonPath, JSON.stringify({ names, ids }));
  const outPath = new URL(
    "../../src/data/spellIconsGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Mined: ${Object.keys(icons).length}(宇宙=语料实证∪SpellCooldowns∪候选)\n * 数据在同名 .json(vite json.stringify → JSON.parse 装载,大 JSON 教训)。\n * .json 是字典编码 {names, ids}:图标名重复率极高,平铺 Record 近半字节\n * 是重复字符串;此处展开回 Record,消费方 API 不变。\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `import rawIcons from "./spellIconsGenerated.json";\n\n` +
      `const { names, ids } = rawIcons as unknown as {\n  names: string[];\n  ids: Record<string, number>;\n};\n\n` +
      `const expanded: Record<string, string> = {};\nfor (const id in ids) expanded[id] = names[ids[id]!]!;\n\n` +
      `export const SPELL_ICONS_GENERATED: Record<string, string> = expanded;\n`,
  );
  console.log(
    `spellIconsGenerated: ${Object.keys(icons).length}/${universe.size} universe mined (build ${build})`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("genSpellIcons.ts")) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
