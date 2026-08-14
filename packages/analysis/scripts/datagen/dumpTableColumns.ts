/**
 * One-off recon script (kept archived, not part of the regular datagen batch):
 * for the A2 official-effect-surface survey (docs/ability-fact-inventory.md),
 * fetch the CSV header row of each candidate DB2 table via wagoCsv and print
 * its full column list. Column names must come from a real fetch — never
 * typed from memory — so this script is the source of truth for the survey's
 * "column" rows.
 *
 * Usage: npx tsx packages/analysis/scripts/datagen/dumpTableColumns.ts [build]
 * (DATAGEN_BUILD / DATAGEN_CACHE env vars are honored via resolveBuild/fetchTable,
 * same convention as every other datagen script — see lib/wagoCsv.ts.)
 */
import { fetchTable, parseCsv, resolveBuild } from "./lib/wagoCsv";

const CANDIDATE_TABLES = [
  "SpellMisc",
  "SpellAuraOptions",
  "SpellInterrupts",
  "SpellShapeshift",
  "SpellCastingRequirements",
  "SpellCategories",
  "SpellEffect",
  "SpellAuraRestrictions",
  "SpellTargetRestrictions",
];

async function main() {
  const build = await resolveBuild(process.argv[2]);
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;
  console.log(`Build: ${build}\n`);

  for (const table of CANDIDATE_TABLES) {
    try {
      const csv = await fetchTable(table, build, cacheDir);
      const { header } = parseCsv(csv);
      console.log(`## ${table} (${header.length} columns)`);
      console.log(header.join(", "));
      console.log("");
    } catch (e) {
      console.log(`## ${table}`);
      console.log(`NOT FOUND: ${(e as Error).message}`);
      console.log("");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
