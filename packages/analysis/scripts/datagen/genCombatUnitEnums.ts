/**
 * Generates CombatUnitSpec and CombatUnitClass from Blizzard's official DB2
 * (ChrSpecialization / ChrClasses).
 *
 * Why generate instead of hand-writing: these two enums were previously copied
 * line by line from wowarenalogs' packages/parser/src/types.ts, and that repo
 * is CC BY-NC-ND 4.0 as a whole (no commercial use, no derivatives), which is
 * incompatible with this repo's MIT redistribution. The values themselves
 * (specId/classId) are Blizzard game facts and not copyrightable; what IS
 * protected is the expression of "how to lay them out as an enum" -- so the fix
 * is to **derive them independently from the official data** using our own
 * hard-coded naming rule, not to bolt an attribution comment onto a copied
 * table. See docs/DATA-COMPLIANCE.md.
 *
 * The output is written to packages/parser-compat/src/enumsGenerated.ts. The
 * generator lives in analysis/scripts/datagen because all of the DB2
 * fetch/parse infrastructure is here (lib/wagoCsv); parser-compat does not
 * depend on analysis, and this write direction only exists at build time.
 */
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

/** Enum member names keep alphanumerics only: "Beast Mastery" -> "BeastMastery". */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Player-spec predicate: ClassID != 0 excludes pet specs (Ferocity / Cunning /
 * Tenacity, whose ClassID is always 0), and OrderIndex <= 3 excludes the one
 * "Initial" template row per class plus ClassID=14 "Adventurer" (both have
 * OrderIndex 4). Real specs are 3 per class (4 for druid) and their OrderIndex
 * is always 0..3 -- filtering by index rather than by name keeps localized text
 * from affecting the result.
 */
export function selectPlayerSpecs(
  specRows: Record<string, string>[],
): Record<string, string>[] {
  return specRows.filter((r) => r.ClassID !== "0" && Number(r.OrderIndex) <= 3);
}

export interface SpecEntry {
  id: string;
  member: string;
  classId: string;
}

/**
 * Naming rule (defined by this repo, not inherited from anywhere):
 * `<ClassName><underscore><SpecName>`, each segment stripped of non-alphanumeric
 * characters, casing taken verbatim from the official Name_lang. Sorted by
 * ascending numeric specId -- a deterministic order unrelated to any existing
 * implementation.
 */
export function buildSpecEntries(
  specRows: Record<string, string>[],
  classRows: Record<string, string>[],
): SpecEntry[] {
  const className = new Map(classRows.map((r) => [r.ID, r.Name_lang]));
  const entries = selectPlayerSpecs(specRows).map((r) => {
    const cn = className.get(r.ClassID);
    if (!cn) {
      throw new Error(
        `spec ${r.ID} (${r.Name_lang}) references unknown ClassID ${r.ClassID}`,
      );
    }
    return {
      id: r.ID,
      member: `${sanitize(cn)}_${sanitize(r.Name_lang)}`,
      classId: r.ClassID,
    };
  });
  entries.sort((a, b) => Number(a.id) - Number(b.id));

  const seen = new Map<string, string>();
  for (const e of entries) {
    const prior = seen.get(e.member);
    if (prior) {
      // Duplicate member names would silently drop a spec; better to blow up at
      // generation time.
      throw new Error(
        `duplicate enum member ${e.member} for specIds ${prior} and ${e.id}`,
      );
    }
    seen.set(e.member, e.id);
  }
  return entries;
}

/**
 * Playable class = a class that has at least one player spec, derived back from
 * the specs rather than a hand-written allowlist -- it follows a newly shipped
 * class automatically and never pulls in non-player entries like Adventurer.
 * The values are the official ChrClasses.ID (a Blizzard fact); no numbering of
 * our own.
 */
export function buildClassEntries(
  specRows: Record<string, string>[],
  classRows: Record<string, string>[],
): { id: string; member: string }[] {
  const playable = new Set(selectPlayerSpecs(specRows).map((r) => r.ClassID));
  return classRows
    .filter((r) => playable.has(r.ID))
    .map((r) => ({ id: r.ID, member: sanitize(r.Name_lang) }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export function renderEnums(
  specs: SpecEntry[],
  classes: { id: string; member: string }[],
  build: string,
): string {
  const specLines = specs.map((e) => `  ${e.member} = "${e.id}",`).join("\n");
  const classLines = classes.map((e) => `  ${e.member} = ${e.id},`).join("\n");
  return `// GENERATED — do not hand-edit. Produced by
// packages/analysis/scripts/datagen/genCombatUnitEnums.ts from Blizzard DB2
// (ChrSpecialization / ChrClasses).
// build: ${build}
//
// Both the specId and classId values are Blizzard game-data facts; see the
// generator's doc comment for the member naming rules.
// Regenerate: cd packages/analysis && npx tsx scripts/datagen/genCombatUnitEnums.ts

/** Specialization. Values are Blizzard specId strings (exactly the number that
 * appears in COMBATANT_INFO). */
export enum CombatUnitSpec {
  None = "0",
${specLines}
}

/** Class. Values are Blizzard's official ChrClasses.ID — identical to the
 * classId in the log, no conversion needed. */
export enum CombatUnitClass {
  None = 0,
${classLines}
}
`;
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const specCsv = parseCsv(await fetchTable("ChrSpecialization", build));
  const classCsv = parseCsv(await fetchTable("ChrClasses", build));
  assertColumns(
    specCsv.header,
    ["ID", "ClassID", "Name_lang", "OrderIndex"],
    "ChrSpecialization",
  );
  assertColumns(classCsv.header, ["ID", "Name_lang"], "ChrClasses");

  const specs = buildSpecEntries(specCsv.rows, classCsv.rows);
  const classes = buildClassEntries(specCsv.rows, classCsv.rows);

  // Lower-bound guard: fail early on an empty fetch / renamed column instead of
  // writing an empty enum into the source tree. No upper bound -- Blizzard
  // adding classes and specs is normal evolution, and following that
  // automatically is the whole point of generating.
  if (specs.length < 39) {
    throw new Error(`only ${specs.length} player specs parsed; expected >= 39`);
  }
  if (classes.length < 13) {
    throw new Error(`only ${classes.length} playable classes; expected >= 13`);
  }

  const out = new URL(
    "../../../parser-compat/src/enumsGenerated.ts",
    import.meta.url,
  ).pathname;
  writeArtifact(out, renderEnums(specs, classes, build));
  console.log(
    `wrote ${specs.length} specs / ${classes.length} classes (build ${build}) → ${out}`,
  );
}

// Run main only when executed directly (not when imported by unit tests) --
// the same guard style as the other generators in this directory.
if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genCombatUnitEnums.ts")
) {
  main().catch((e) => {
    console.error("genCombatUnitEnums failed:", e);
    process.exit(1);
  });
}
