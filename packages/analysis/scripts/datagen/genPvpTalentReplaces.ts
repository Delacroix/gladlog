/**
 * PvP 天赋替换表(正式数据):DB2 PvpTalent.OverridesSpellID —— 选中天赋 X
 * 时技能 Y 不复存在。消费方 cooldowns.ts 用它把被替换技能挡在
 * 「整场未用」台账外(2026-07-25 用户实测:灼热凝视 vs Blinding Light)。
 *
 * 同名 id 桥接:静态表(classSpells)历史上用光环 id(如 105421),官方
 * override 给的是施法 id(115750)——按 spellEffectGenerated 的名字把同名
 * id 并进替换集,两条入账路径(静态表/天赋动态发现)都挡住。
 */
import { spellEffectData } from "../../src/data/spellEffectData";
import { classMetadata } from "../../src/data/classSpells";
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
  const parsed = parseCsv(await fetchTable("PvpTalent", build, cacheDir));
  assertColumns(parsed.header, ["SpellID", "OverridesSpellID"], "PvpTalent");

  // 名字 → 我方静态表里的 id 集(桥接光环 id 别名)
  const staticIdsByName = new Map<string, Set<string>>();
  for (const cls of classMetadata) {
    for (const a of cls.abilities ?? []) {
      const s = staticIdsByName.get(a.name) ?? new Set<string>();
      s.add(a.spellId);
      staticIdsByName.set(a.name, s);
    }
  }

  const out: Record<string, string[]> = {};
  for (const row of parsed.rows) {
    const talent = row.SpellID;
    const overridden = row.OverridesSpellID;
    if (!talent || !overridden || overridden === "0") continue;
    const set = new Set(out[talent] ?? []);
    set.add(overridden);
    const name = spellEffectData[overridden]?.name;
    if (name) for (const alias of staticIdsByName.get(name) ?? []) set.add(alias);
    out[talent] = [...set].sort((a, b) => Number(a) - Number(b));
  }

  const outPath = new URL(
    "../../src/data/pvpTalentReplacesGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Source: DB2 PvpTalent.OverridesSpellID(官方替换关系)+ classSpells 同名 id 桥接\n * Pairs: ${Object.keys(out).length}\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `export const PVP_TALENT_REPLACES_GENERATED: Record<string, string[]> = ${JSON.stringify(out, Object.keys(out).sort((a, b) => Number(a) - Number(b)), 2)};\n`,
  );
  console.log(
    `pvpTalentReplacesGenerated.ts: ${Object.keys(out).length} talents with overrides (build ${build})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
