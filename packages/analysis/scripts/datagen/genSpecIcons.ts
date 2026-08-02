/**
 * genSpecIcons -- specId -> icon base name (same naming convention as
 * genSpellIcons: lowercase, no extension).
 *
 * Data chain: ChrSpecialization.SpellIconFileID -> ManifestInterfaceData
 * (FileDataID -> interface/icons/<name>.blp), the same mapping table
 * genSpellIcons uses.
 *
 * Why this table exists: spec icons used to hotlink
 * images.wowarenalogs.com/specs/<slug>.jpg directly -- a third-party volunteer
 * project's CDN, meaning the shipped app spent their bandwidth every time it
 * rendered the match list, on Blizzard artwork they merely rehosted. With icon
 * base names the renderer goes through the existing SpellIcon / main-process
 * iconCache (with its permanent disk cache and per-session budget), the same
 * path as spell icons. See docs/DATA-COMPLIANCE.md.
 *
 * The build comes from datagen-manifest.json (same build as the other
 * artifacts); only without a manifest do we fetch the latest.
 */
import fs from "fs-extra";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

/** The same player-spec predicate as genCombatUnitEnums -- if the two diverge,
 * icons silently go missing. */
function isPlayerSpec(r: Record<string, string>): boolean {
  return r.ClassID !== "0" && Number(r.OrderIndex) <= 3;
}

export function mineSpecIcons(csv: {
  chrSpecialization: Record<string, string>[];
  manifestInterfaceData: Record<string, string>[];
}): Record<string, string> {
  const iconByFileData = new Map<string, string>();
  for (const row of csv.manifestInterfaceData) {
    if (!row.ID) continue;
    const dir = (row.FilePath ?? "").toLowerCase().replace(/\\/g, "/");
    if (!dir.includes("interface/icons")) continue;
    const base = (row.FileName ?? "").toLowerCase().replace(/\.blp$/, "");
    if (base) iconByFileData.set(row.ID, base);
  }

  const result: Record<string, string> = {};
  for (const row of csv.chrSpecialization) {
    if (!isPlayerSpec(row)) continue;
    const icon = iconByFileData.get(row.SpellIconFileID ?? "");
    if (icon) result[row.ID] = icon;
  }
  return result;
}

export async function main(): Promise<void> {
  const manifestPath = new URL(
    "../../src/data/datagen-manifest.json",
    import.meta.url,
  ).pathname;
  const build =
    process.env.DATAGEN_BUILD ??
    (fs.existsSync(manifestPath)
      ? fs.readJsonSync(manifestPath).build
      : await fetchLatestBuild());

  const spec = parseCsv(await fetchTable("ChrSpecialization", build));
  const mid = parseCsv(await fetchTable("ManifestInterfaceData", build));
  assertColumns(
    spec.header,
    ["ID", "ClassID", "OrderIndex", "SpellIconFileID"],
    "ChrSpecialization",
  );
  assertColumns(
    mid.header,
    ["ID", "FilePath", "FileName"],
    "ManifestInterfaceData",
  );

  const icons = mineSpecIcons({
    chrSpecialization: spec.rows,
    manifestInterfaceData: mid.rows,
  });

  const playerSpecs = spec.rows.filter(isPlayerSpec).length;
  // One missing icon means one missing portrait in the list, silently degraded
  // to a glyph dot -- better to blow up at generation time.
  if (Object.keys(icons).length !== playerSpecs) {
    throw new Error(
      `resolved ${Object.keys(icons).length}/${playerSpecs} spec icons; every player spec must resolve`,
    );
  }

  const out = new URL("../../src/data/specIconsGenerated.ts", import.meta.url)
    .pathname;
  writeArtifact(
    out,
    `// 生成文件 —— 勿手改。由 packages/analysis/scripts/datagen/genSpecIcons.ts 生成。\n` +
      `// build: ${build}\n` +
      `// specId → 图标基名(zamimg/wow.tools 通用命名)。\n\n` +
      `export const SPEC_ICONS: Record<string, string> = ${JSON.stringify(icons, null, 2)};\n`,
  );
  console.log(
    `specIconsGenerated.ts: ${Object.keys(icons).length} spec icons (build ${build})`,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genSpecIcons.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
