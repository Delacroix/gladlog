/**
 * Per-spec PvP-talent pool (official data): DB2 PvpTalent — every SpellID a
 * spec can slot as a PvP talent, plus the rare distinct ActionBarSpellID
 * carrier (12.1: exactly one — 215982 Spirit of the Redeemer grants action
 * bar spell 215769).
 *
 * Consumer: utils/talentOwnership.ts (`talentOwnershipOf`) — "is spell X
 * PvP-talent-gated for this spec, and which talent SpellID carries it". The
 * COMBATANT_INFO `pvpTalents` array stores PvpTalent.SpellID values
 * (verified 2026-08-11 on the live corpus: 110/111 distinct observed ids
 * matched the SpellID column, 0 matched the ID column; the one outlier
 * 359053 is a pre-12.1 pvp talent from an older-build log).
 *
 * Shape: specId → { grantedSpellId → carrier talent SpellID }. For almost
 * every row the granted spell IS the talent spell (carrier === key).
 */
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
  assertColumns(
    parsed.header,
    ["SpecID", "SpellID", "ActionBarSpellID"],
    "PvpTalent",
  );

  const out: Record<string, Record<string, string>> = {};
  let rows = 0;
  for (const row of parsed.rows) {
    const spec = row.SpecID;
    const spell = row.SpellID;
    if (!spec || spec === "0" || !spell || spell === "0") continue;
    const bySpec = (out[spec] ??= {});
    bySpec[spell] = spell;
    // Distinct action-bar carrier: the talent grants a different castable.
    const ab = row.ActionBarSpellID;
    if (ab && ab !== "0" && ab !== spell) bySpec[ab] = spell;
    rows++;
  }
  // Deterministic ordering for stable diffs.
  const sorted: Record<string, Record<string, string>> = {};
  for (const spec of Object.keys(out).sort((a, b) => Number(a) - Number(b))) {
    sorted[spec] = {};
    for (const k of Object.keys(out[spec]).sort(
      (a, b) => Number(a) - Number(b),
    ))
      sorted[spec][k] = out[spec][k];
  }

  const outPath = new URL(
    "../../src/data/pvpTalentPoolGenerated.ts",
    import.meta.url,
  ).pathname;
  const header = `/**\n * Generated at: ${new Date().toISOString()}\n * Build: ${build}\n * Source: DB2 PvpTalent (SpecID / SpellID / ActionBarSpellID)\n * Rows: ${rows} across ${Object.keys(sorted).length} specs\n * Shape: specId -> { grantedSpellId -> carrier talent SpellID }\n */\n\n`;
  writeArtifact(
    outPath,
    header +
      `export const PVP_TALENT_POOL_GENERATED: Record<string, Record<string, string>> = ${JSON.stringify(
        sorted,
        null,
        2,
      )};\n`,
  );
  console.log(
    `pvpTalentPoolGenerated.ts: ${rows} pvp talents across ${Object.keys(sorted).length} specs (build ${build})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
