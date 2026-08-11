import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertColumns,
} from "./lib/wagoCsv";
import { SPELL_CATEGORIES } from "../../src/data/spellCategories";
import { classMetadata } from "../../src/data/classSpells";
import spellIdLists from "../../src/data/spellIdLists";
import { spellClassMap } from "../../src/data/drCategories";
import { SPELL_EFFECT_OVERRIDES } from "../../src/data/spellEffectOverrides";

/** Spells removed from the current build that still show up in historical logs
 * — kept in the catalogs and waved through by validation.
 * Every entry must state the spell name and the date of the ruling. */
export const KNOWN_REMOVED_SPELLS: Record<string, string> = {
  // Mind Bomb (Priest PvP talent, removed; 12.1.0 SpellName has no such id.
  // Ruling 2026-07-11: analysis of historical logs still needs its DR/CC
  // classification, so it stays in the catalog)
  "226943": "Mind Bomb",
  // Ring of Fire (Mage PvP talent, removed in 12.1: SpellName 12.1.0.69273
  // dropped the id while SpellCategories still carries its DiminishType rows,
  // so genDrCategories keeps emitting it — an orphan row, not curated rot.
  // Ruling 2026-08-11: historical 12.0 logs cast it, DR classification stays)
  "363405": "Ring of Fire",
};

export function validateCatalogs(
  spellNameRows: Record<string, string>[],
  catalogs: Record<string, string[]>,
  opts?: { knownRemoved?: Record<string, string> },
): { missing: { catalog: string; id: string }[] } {
  const knownRemoved = opts?.knownRemoved ?? KNOWN_REMOVED_SPELLS;
  const ids = new Set<string>();
  for (const row of spellNameRows) {
    if (row.ID) {
      ids.add(row.ID);
    }
  }

  const missing: { catalog: string; id: string }[] = [];
  for (const [catalogName, catalogArray] of Object.entries(catalogs)) {
    for (const id of catalogArray) {
      if (!ids.has(id) && !(id in knownRemoved)) {
        missing.push({ catalog: catalogName, id });
      }
    }
  }

  return { missing };
}

export async function main(): Promise<void> {
  const build = await fetchLatestBuild();
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

  const spellNameRaw = await fetchTable("SpellName", build, cacheDir);
  const spellNameParsed = parseCsv(spellNameRaw);
  assertColumns(spellNameParsed.header, ["ID", "Name_lang"], "SpellName");

  const spellCategoriesIds = Object.keys(SPELL_CATEGORIES);

  const classMetadataIds: string[] = [];
  for (const metadata of classMetadata) {
    if (metadata.abilities) {
      for (const ability of metadata.abilities) {
        if (ability.spellId) {
          classMetadataIds.push(ability.spellId);
        }
      }
    }
  }

  const spellIdListsIds: string[] = [];
  for (const list of Object.values(spellIdLists)) {
    if (Array.isArray(list)) {
      for (const id of list) {
        if (typeof id === "string") {
          spellIdListsIds.push(id);
        } else if (typeof id === "number") {
          spellIdListsIds.push(String(id));
        }
      }
    }
  }

  const drCategoriesIds: string[] = [];
  if (spellClassMap.diminishingReturns) {
    for (const catList of Object.values(spellClassMap.diminishingReturns)) {
      if (Array.isArray(catList)) {
        for (const item of catList) {
          if (item && item.spellId) {
            drCategoriesIds.push(item.spellId);
          }
        }
      }
    }
  }

  const spellEffectOverridesIds = Object.keys(SPELL_EFFECT_OVERRIDES);

  const catalogs: Record<string, string[]> = {
    spellCategories: spellCategoriesIds,
    classMetadata: classMetadataIds,
    spellIdLists: spellIdListsIds,
    drCategories: drCategoriesIds,
    spellEffectOverrides: spellEffectOverridesIds,
  };

  const { missing } = validateCatalogs(spellNameParsed.rows, catalogs);

  if (missing.length > 0) {
    for (const entry of missing) {
      console.log(`${entry.catalog} ${entry.id}`);
    }
    process.exit(1);
  } else {
    for (const [name, arr] of Object.entries(catalogs)) {
      console.log(`OK: ${name} count = ${arr.length}`);
    }
  }
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("validateCatalogs.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
