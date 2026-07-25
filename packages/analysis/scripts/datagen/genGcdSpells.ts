/**
 * 玩家按键表(正式数据,GCD 泳道显示门):
 *   SkillLineAbility.Spell(官方技能书)∪ talentIdMap(天赋树)∪
 *   PvpTalent.SpellID/ActionBarSpellID
 * 真按键必在其一;触发型子法术/引擎内部 id(DH 吞噬双 id、灵魂残片、
 * 赞美诗治疗效果 id、冲锋位移 id)全不在 —— 2026-07-25 已知样例 13/13 验证。
 * 已知缺口:物品法术(PvP 饰品 336126)不在技能书,消费方用 curated
 * SPELL_CATEGORIES 并集兜底。
 */
import talentIdMap from "../../src/data/talentIdMap.json";
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

function collectTalentSpellIds(o: unknown, out: Set<string>): void {
  if (Array.isArray(o)) {
    for (const x of o) collectTalentSpellIds(x, out);
  } else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if ((k === "spellId" || k === "spellID") && v) out.add(String(v));
      else collectTalentSpellIds(v, out);
    }
  }
}

async function main() {
  let build = process.argv[2];
  if (!build) {
    build = await fetchLatestBuild();
  }
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

  const slaParsed = parseCsv(
    await fetchTable("SkillLineAbility", build, cacheDir),
  );
  assertColumns(slaParsed.header, ["Spell"], "SkillLineAbility");
  const ids = new Set<string>();
  for (const row of slaParsed.rows) if (row.Spell) ids.add(row.Spell);
  const bookN = ids.size;

  collectTalentSpellIds(talentIdMap, ids);

  const pvpParsed = parseCsv(await fetchTable("PvpTalent", build, cacheDir));
  assertColumns(pvpParsed.header, ["SpellID"], "PvpTalent");
  for (const row of pvpParsed.rows) {
    if (row.SpellID && row.SpellID !== "0") ids.add(row.SpellID);
    if (row.ActionBarSpellID && row.ActionBarSpellID !== "0")
      ids.add(row.ActionBarSpellID);
  }

  const sorted = [...ids].map(Number).sort((a, b) => a - b).map(String);
  const outPath = new URL(
    "../../src/data/gcdSpellsGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Source: SkillLineAbility(${bookN}) ∪ talentIdMap ∪ PvpTalent = ${sorted.length} 玩家按键 id\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `export const PLAYER_BUTTON_SPELL_IDS: ReadonlySet<string> = new Set(\n  ${JSON.stringify(sorted)},\n);\n`,
  );
  console.log(
    `gcdSpellsGenerated.ts: ${sorted.length} player-button ids (build ${build})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
