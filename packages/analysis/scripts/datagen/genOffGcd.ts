/**
 * off-GCD 主动技能表(正式数据):DB2 SpellCooldowns 有行且
 * StartRecoveryTime == 0 —— 玩家可按、不占 GCD(饰品/打断/冲锋/种族技)。
 * GCD 泳道折叠用:同刻多技能折叠时,on-GCD 者为主 chip,off-GCD 折为
 * 小图标。限观测宇宙(observedSpellIdsGenerated),表极小。
 */
import fs from "fs-extra";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

async function main() {
  let build = process.argv[2];
  if (!build) {
    build = await fetchLatestBuild();
  }
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;
  const observed = new Set(
    (
      JSON.parse(
        fs.readFileSync(
          new URL(
            "../../src/data/observedSpellIdsGenerated.json",
            import.meta.url,
          ).pathname,
          "utf8",
        ),
      ) as number[]
    ).map(String),
  );
  const parsed = parseCsv(await fetchTable("SpellCooldowns", build, cacheDir));
  assertColumns(
    parsed.header,
    ["SpellID", "DifficultyID", "StartRecoveryTime"],
    "SpellCooldowns",
  );
  const off: number[] = [];
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    if (row.DifficultyID !== "0" || !row.SpellID || seen.has(row.SpellID))
      continue;
    seen.add(row.SpellID);
    if (!observed.has(row.SpellID)) continue;
    if (Number(row.StartRecoveryTime) === 0) off.push(Number(row.SpellID));
  }
  off.sort((a, b) => a - b);
  const outPath = new URL(
    "../../src/data/offGcdGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Source: SpellCooldowns 有行且 StartRecoveryTime==0(off-GCD 玩家主动技),限观测宇宙\n * ids: ${off.length}\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `export const OFF_GCD_SPELL_IDS: ReadonlySet<string> = new Set(\n  ${JSON.stringify(off.map(String))},\n);\n`,
  );
  console.log(`offGcdGenerated.ts: ${off.length} off-GCD ids (build ${build})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
