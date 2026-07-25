/**
 * DR(收益递减)分类表(正式数据):DB2 SpellCategories.DiminishType。
 * 锚点实证(2026-07-25):1=root 4=stun 16=incapacitate 32=disorient
 * 64=silence;DR 挂光环 id(Fear 施法 5782 无值、光环 118699=32),与
 * 战斗日志 SPELL_AURA_APPLIED 记的 id 一致(用户 10 场:118699 ×189、
 * 5782 ×0)。disarm/knockback 官方无 DiminishType,仍由 drCategories.ts
 * 手工层提供(官方缺口,勿删)。
 */
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

const DIM_TO_CATEGORY: Record<number, string> = {
  1: "root",
  4: "stun",
  16: "incapacitate",
  32: "disorient",
  64: "silence",
};

async function main() {
  let build = process.argv[2];
  if (!build) {
    build = await fetchLatestBuild();
  }
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;
  const parsed = parseCsv(
    await fetchTable("SpellCategories", build, cacheDir),
  );
  assertColumns(
    parsed.header,
    ["SpellID", "DifficultyID", "DiminishType"],
    "SpellCategories",
  );
  const byCat: Record<string, number[]> = {};
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    if (row.DifficultyID !== "0" || !row.SpellID || seen.has(row.SpellID))
      continue;
    seen.add(row.SpellID);
    const cat = DIM_TO_CATEGORY[Number(row.DiminishType)];
    if (!cat) continue;
    (byCat[cat] ??= []).push(Number(row.SpellID));
  }
  for (const c of Object.keys(byCat)) byCat[c]!.sort((a, b) => a - b);

  const outPath = new URL(
    "../../src/data/drCategoriesGenerated.ts",
    import.meta.url,
  ).pathname;
  const counts = Object.entries(byCat)
    .map(([c, ids]) => `${c}:${ids.length}`)
    .join(" ");
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Source: DB2 SpellCategories.DiminishType(1=root 4=stun 16=incap 32=disorient 64=silence)\n * ${counts}\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `export const DR_CATEGORIES_GENERATED: Record<string, string[]> = ${JSON.stringify(
        Object.fromEntries(
          Object.entries(byCat).map(([c, ids]) => [c, ids.map(String)]),
        ),
        Object.keys(byCat).sort(),
        2,
      )};\n`,
  );
  console.log(`drCategoriesGenerated.ts: ${counts} (build ${build})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
