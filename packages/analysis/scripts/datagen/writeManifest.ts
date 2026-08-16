/**
 * datagen-manifest.json summary: records the build and the size of each
 * artifact, so the update-wow-data workflow can decide whether an update is
 * needed.
 */
import { readFileSync, statSync } from "fs";
import { fetchLatestBuild } from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

export async function main(): Promise<void> {
  // DATAGEN_BUILD pins the build number: stay on the same build as every
  // generator script, so the manifest never records a build newer than the
  // artifacts actually generated, which would make the next update-wow-data
  // wrongly conclude "already up to date".
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;

  const readJson = (f: string) =>
    JSON.parse(readFileSync(dataDir + f, "utf-8"));
  const generatedEntries = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    return Object.keys(
      JSON.parse(t.slice(t.indexOf("= {") + 2, t.lastIndexOf(";"))),
    ).length;
  };
  // Same as generatedEntries, but returns member counts grouped by key (the
  // per-category counts of drCategoriesGenerated's five categories, rather
  // than the number of categories itself).
  const generatedGroupCounts = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    const obj = JSON.parse(
      t.slice(t.indexOf("= {") + 2, t.lastIndexOf(";")),
    ) as Record<string, unknown[]>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, v.length]),
    );
  };
  // These artifacts are `new Set([...])` literals (offGcd and dispelObserved),
  // and some carry per-entry `// ×N` comments that make them invalid JSON —
  // counting the quoted numeric ids is actually the most robust approach.
  const countQuotedIds = (f: string) => {
    const t = readFileSync(dataDir + f, "utf-8");
    return (t.match(/"\d+"/g) ?? []).length;
  };

  // The enum artifact lives in another package and is a TS enum, not JSON —
  // count member lines, do not try to JSON.parse it.
  const countEnumMembers = () => {
    const p = new URL(
      "../../../parser-compat/src/enumsGenerated.ts",
      import.meta.url,
    ).pathname;
    const text = readFileSync(p, "utf-8");
    const count = (enumName: string) => {
      const body = text.match(
        new RegExp(`export enum ${enumName} \\{([^}]*)\\}`),
      )?.[1];
      return body ? body.split("\n").filter((l) => l.includes("=")).length : 0;
    };
    return {
      specs: count("CombatUnitSpec"),
      classes: count("CombatUnitClass"),
      bytes: statSync(p).size,
    };
  };

  const manifest = {
    build,
    generatedAt: new Date().toISOString(),
    artifacts: {
      "talentIdMap.json": { specs: readJson("talentIdMap.json").length },
      "spellNames.json": {
        entries: Object.keys(readJson("spellNames.json")).length,
        bytes: statSync(dataDir + "spellNames.json").size,
      },
      "spellNamesZhGenerated.json": {
        entries: Object.keys(readJson("spellNamesZhGenerated.json")).length,
        bytes: statSync(dataDir + "spellNamesZhGenerated.json").size,
      },
      // Same as spellIconsGenerated: the .ts is now just an import shell, so
      // count from the .json
      "spellEffectGenerated.ts": {
        entries: Object.keys(readJson("spellEffectGenerated.json")).length,
        bytes: statSync(dataDir + "spellEffectGenerated.json").size,
      },
      "spellClassMapGenerated.ts": {
        entries: generatedEntries("spellClassMapGenerated.ts"),
      },
      // Count from the .json (we used to count the .ts `= {` literal; once
      // that file became an import shell the count froze at 3568 while the
      // true value was 41707 — the monitoring measure went blind for a whole
      // release and nobody noticed).
      // The .json is dictionary-encoded {names, ids}: entries = number of ids
      // keys, distinct = length of names.
      "spellIconsGenerated.ts": {
        entries: Object.keys(readJson("spellIconsGenerated.json").ids).length,
        distinctIcons: readJson("spellIconsGenerated.json").names.length,
        bytes: statSync(dataDir + "spellIconsGenerated.json").size,
      },
      "trinketItemIds.json": {
        adaptation: readJson("trinketItemIds.json").adaptationItemIds.length,
        relentless: readJson("trinketItemIds.json").relentlessItemIds.length,
      },
      "talentModifiers.json": {
        trackedSpells: Object.keys(readJson("talentModifiers.json")).length,
      },
      "mitigationGenerated.json": {
        entries: Object.keys(readJson("mitigationGenerated.json").entries)
          .length,
        unresolved: readJson("mitigationGenerated.json").unresolved.length,
        bytes: statSync(dataDir + "mitigationGenerated.json").size,
      },
      "offGcdGenerated.ts": {
        entries: countQuotedIds("offGcdGenerated.ts"),
      },
      "drCategoriesGenerated.ts": {
        byCategory: generatedGroupCounts("drCategoriesGenerated.ts"),
      },
      "pvpTalentReplacesGenerated.ts": {
        pairs: generatedEntries("pvpTalentReplacesGenerated.ts"),
      },
      "pvpTalentPoolGenerated.ts": {
        specs: generatedEntries("pvpTalentPoolGenerated.ts"),
      },
      "specIconsGenerated.ts": {
        entries: generatedEntries("specIconsGenerated.ts"),
      },
      // The producers of the next two are NOT in this directory
      // (scripts/datagen/) but in packages/eval/scripts/ — they are
      // corpus-driven (empirical, from the full match-log corpus), not driven
      // by the wago.tools DB2 build; do not look for their generators under
      // datagen.
      "dispelObservedGenerated.ts": {
        entries: countQuotedIds("dispelObservedGenerated.ts"),
        producer: "packages/eval/scripts/confidenceAudit.ts --emit-table",
      },
      "observedSpellIdsGenerated.json": {
        entries: readJson("observedSpellIdsGenerated.json").length,
        producer: "packages/eval/scripts/observedSpellIds.ts",
      },
      // "Usable while stunned" (B1, task-3): only the stunned dimension
      // resolves to a unique SpellMisc bit combo; feared/confused are a
      // documented gap (see the artifact's own file header and
      // task-3-report.md) with NO ground-truth layer as of Task 5's shim
      // migration — cooldowns.ts USABLE_WHILE_CC_SPELL_IDS is now
      // stunned-only (generated 468 ∪ unconditional gap layer), not a
      // hand-written fallback for all three dimensions; consumers gate
      // feared/disorient/incapacitate lockouts by CC type instead (finding
      // #1, 2026-08-14 final review) rather than consulting this table. Only
      // stunned is counted here.
      "usableWhileCcGenerated.ts": {
        stunned: countQuotedIds("usableWhileCcGenerated.ts"),
      },
      // BACKLOG #26 Task 4 (raw-streams plan): per-spell mana cost table
      // (genSpellManaCost.ts), scoped to observedSpellIdsGenerated's
      // mana-type (PowerType=0) spells. Entries with spec-conditional rows
      // (bySpec present) are counted separately so a manifest diff shows
      // when the spec-aura mapping's coverage shifts, not just total count.
      "spellManaCostGenerated.json": {
        entries: Object.keys(readJson("spellManaCostGenerated.json").entries)
          .length,
        bySpecEntries: Object.values(
          readJson("spellManaCostGenerated.json").entries as Record<
            string,
            { bySpec?: unknown }
          >,
        ).filter((e) => e.bySpec).length,
        bytes: statSync(dataDir + "spellManaCostGenerated.json").size,
      },
      // The only artifact that does not live under analysis/src/data (the
      // enums belong to parser-compat). It is recorded here so that
      // update-wow-data also re-runs genCombatUnitEnums — the symptom of
      // skipping it is that a new expansion's new specs are absent from the
      // enum, and absence raises no error, it just silently drops data.
      "parser-compat/enumsGenerated.ts": countEnumMembers(),
    },
  };

  writeArtifact(
    dataDir + "datagen-manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`manifest written (build ${build})`);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("writeManifest.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
