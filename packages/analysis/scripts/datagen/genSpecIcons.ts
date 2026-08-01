/**
 * genSpecIcons — specId → 图标基名(与 genSpellIcons 同一命名口径:小写、无扩展名)。
 *
 * 数据链:ChrSpecialization.SpellIconFileID → ManifestInterfaceData(FileDataID →
 * interface/icons/<name>.blp),与 genSpellIcons 用的是同一张映射表。
 *
 * 为什么要有这份表:专精图标此前直接热链 images.wowarenalogs.com/specs/<slug>.jpg,
 * 那是第三方志愿者项目的 CDN —— 出货 App 每次渲染对局列表都在花他们的带宽,而且
 * 那些图是暴雪美术经他们二次托管的。改成图标基名后,渲染侧走既有的 SpellIcon /
 * main 进程 iconCache(带永久磁盘缓存与会话预算),与技能图标同一条路。
 * 见 docs/DATA-COMPLIANCE.md。
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

/** 与 genCombatUnitEnums 同一条玩家专精判据 —— 两处若分叉会静默漏图标。 */
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
  // 图标缺一个就是列表里少一个头像,静默降级成字形点 —— 宁可生成期炸。
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
