/* eslint-disable no-console */
import { parseCsv, resolveBuild, fetchTable } from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";
import talentIdMap from "../../src/data/talentIdMap.json";
import { CUSTOM_TALENT_MODIFIERS } from "./customTalentModifiers";

import { classMetadata } from "../../src/data/classSpells";
import spellIdLists from "../../src/data/spellIdLists";
import { SPELL_CATEGORIES } from "../../src/data/spellCategories";
import { spellClassMap } from "../../src/data/drCategories";
import { TEAM_HEAL_CD_IDS } from "../../src/utils/cooldowns";

const EFFECT_MOD_CHARGES = 121;
const EFFECT_MOD_COOLDOWN = 148;
const EFFECT_APPLY_AURA = 6;

const AURA_MOD_MAX_CHARGES = 411;
// 107/108 are TrinityCore's SPELL_AURA_ADD_FLAT_MODIFIER / SPELL_AURA_ADD_PCT_MODIFIER —
// generic "apply a SpellMod" auras, NOT dedicated cooldown auras. Which spell property
// they touch (cooldown, cast time, one numbered effect's value, ...) is selected by
// EffectMiscValue_0 acting as a SpellModOp code; only SPELLMOD_COOLDOWN (11) legitimately
// reduces a cooldown timer. Blindly treating every 107/108 hit as a cooldown reduction
// misclassified e.g. spellId 265187's Master Summoner modifier (MiscValue_0=10,
// SPELLMOD_CASTING_TIME — a 0.5s cast-time cut, not a CD cut) and spellId 1719's Reckless
// Abandon modifier (MiscValue_0=23, SPELLMOD_EFFECT3 — modifies Recklessness's rage-gain
// effect, not its CD) as ~500 *seconds* of cooldown reduction, driving cooldownSeconds
// negative (BACKLOG §29a). Gated below on `miscValue0 === SPELLMOD_COOLDOWN`.
const AURA_ADD_FLAT_MODIFIER = 107;
const AURA_ADD_PCT_MODIFIER = 108;
const SPELLMOD_COOLDOWN = 11; // TrinityCore SpellModOp code for "this SpellMod targets cooldown"
const AURA_MOD_CATEGORY_COOLDOWN = 453; // SPELL_AURA_CHARGE_RECOVERY_MOD — dedicated, MiscValue_0 is a ChargeCategory id (Path B below), not a SpellModOp code
const AURA_OVERRIDE_ACTION_SPELL = 332; // Replaces base spell with another

// Mapping of ClassID to SpellFamilyName (SpellClassSet)
const CLASS_ID_TO_FAMILY: Record<number, number> = {
  1: 4, // Warrior
  2: 10, // Paladin
  3: 9, // Hunter
  4: 8, // Rogue
  5: 6, // Priest
  6: 15, // Death Knight
  7: 11, // Shaman
  8: 3, // Mage
  9: 5, // Warlock
  10: 126, // Monk
  11: 7, // Druid
  12: 127, // Demon Hunter
  13: 128, // Evoker
};

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface ICDModifier {
  talentSpellId: string;
  // `reduce_cd` is a flat-seconds subtraction; `reduce_cd_pct` is a percentage
  // multiplier (`value: 30` means -30%, applied as `base *= (1 - 30/100)`).
  // The two must never be conflated: DB2 aura 108 (SPELL_AURA_ADD_PCT_MODIFIER)
  // stores a plain percentage in EffectBasePointsF, not a flat second count —
  // review of 2d5993c caught this being subtracted as flat seconds, wrong by
  // roughly an order of magnitude on long CDs (fix-29a-review.md finding #1).
  effect: "extra_charge" | "reduce_cd" | "reduce_cd_pct" | "replace_spell";
  value: number;
  isConditional?: boolean;
}

export function extractTalentModifiers(
  spellEffectRows: Record<string, string>[],
  spellClassOptionsRows: Record<string, string>[],
  spellCategoriesRows: Record<string, string>[],
  spellNameRows: Record<string, string>[],
  trackedSpellIds: Set<string>,
): Record<string, ICDModifier[]> {
  const spellNames = new Map<string, string>();
  for (const row of spellNameRows) {
    spellNames.set(row.ID, row.Name_lang || "");
  }

  // 1. Index all player talent spell IDs and their class IDs
  const talentClassMap = new Map<string, number>();
  for (const tree of talentIdMap) {
    const classId = tree.classId as number;
    const allNodes = [...(tree.classNodes || []), ...(tree.specNodes || [])];
    for (const node of allNodes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const entry of (node as any).entries || []) {
        const spellId = String(entry.spellId || entry.visibleSpellId || "");
        if (spellId && spellId !== "0") {
          talentClassMap.set(spellId, classId);
        }
      }
    }
  }

  // 2. Index target spells by their class mask
  const targetSpellMasks = new Map<
    string,
    { family: number; masks: number[] }
  >();
  for (const row of spellClassOptionsRows) {
    const spellId = row.SpellID;
    if (!spellId || spellId === "0") continue;
    targetSpellMasks.set(spellId, {
      family: toInt(row.SpellClassSet),
      masks: [
        toInt(row.SpellClassMask_0),
        toInt(row.SpellClassMask_1),
        toInt(row.SpellClassMask_2),
        toInt(row.SpellClassMask_3),
      ],
    });
  }

  // 3. Index target spells by their ChargeCategory
  const chargeCategorySpells = new Map<number, string[]>();
  for (const row of spellCategoriesRows) {
    const spellId = row.SpellID;
    const chargeCategory = toInt(row.ChargeCategory);
    if (!spellId || chargeCategory === 0) continue;

    if (!chargeCategorySpells.has(chargeCategory)) {
      chargeCategorySpells.set(chargeCategory, []);
    }
    const categoryTargets = chargeCategorySpells.get(chargeCategory);
    if (categoryTargets) {
      categoryTargets.push(spellId);
    }
  }

  const results: Record<string, ICDModifier[]> = {};

  function addModifier(targetSpellId: string, mod: ICDModifier) {
    if (!results[targetSpellId]) {
      results[targetSpellId] = [];
    }
    // Avoid duplicates. This dedup is intentionally keyed on (talentSpellId,
    // effect) only — a talent can hit a target spell via more than one
    // matched CSV row (Path A classmask, Path B chargeCategory, Path C
    // direct id, or two different EffectIndex rows on the same talent) and
    // those describe the same real-world modifier. But when two matched rows
    // for the same (talentSpellId, effect) pair carry *different* values,
    // "first CSV row wins" is order-dependent — not a principled choice, just
    // whichever row happened to appear first in the fetched table (BACKLOG:
    // 2026-08-15 review finding #3 of fix-29a-review.md). A values-level fix
    // needs per-talent tooltip verification (same standard as this file's
    // other fixes) to know which row is authoritative, which is out of scope
    // here — so this stays a loud warning, not a silent guess, keeping the
    // current (first-wins) behavior but making future collisions reviewable
    // instead of invisible.
    const existing = results[targetSpellId].find(
      (m) => m.talentSpellId === mod.talentSpellId && m.effect === mod.effect,
    );
    if (existing) {
      if (existing.value !== mod.value) {
        console.warn(
          `[genTalentModifiers] dedup collision: target=${targetSpellId} talent=${mod.talentSpellId} ` +
            `effect=${mod.effect} kept=${existing.value} dropped=${mod.value} (first-row-wins, order-dependent — see BACKLOG)`,
        );
      }
    } else {
      results[targetSpellId].push(mod);
    }
  }

  // 4. Scan SpellEffect for modifiers
  for (const row of spellEffectRows) {
    const talentSpellId = row.SpellID;
    const talentClassInfo = talentClassMap.get(talentSpellId);
    if (!talentClassInfo) continue;

    const classId = talentClassInfo;
    const familyId = CLASS_ID_TO_FAMILY[classId];
    if (familyId === undefined) continue;

    const effect = toInt(row.Effect);
    const aura = toInt(row.EffectAura);
    const miscValue0 = toInt(row.EffectMiscValue_0);

    let modifierType:
      "extra_charge" | "reduce_cd" | "reduce_cd_pct" | "replace_spell" | null =
      null;
    let value = toInt(row.EffectBasePointsF);

    if (
      effect === EFFECT_MOD_CHARGES ||
      (effect === EFFECT_APPLY_AURA && aura === AURA_MOD_MAX_CHARGES)
    ) {
      modifierType = "extra_charge";
      value = Math.abs(value);
    } else if (
      effect === EFFECT_APPLY_AURA &&
      aura === AURA_ADD_PCT_MODIFIER &&
      miscValue0 === SPELLMOD_COOLDOWN
    ) {
      // Percentage SpellMod (e.g. Unbreakable Spirit -30%, Righteous Protector
      // -50%). DB2 stores this as a plain percentage integer in
      // EffectBasePointsF (confirmed against real rows: 114154 → -30,
      // 204074 → -50, 391271 → -10 — no ms scaling, unlike the flat case
      // below) — applying the >500-implies-ms heuristic to it would be
      // wrong on its own terms even before considering unit; skip it.
      modifierType = "reduce_cd_pct";
      value = Math.abs(value);
    } else if (
      effect === EFFECT_MOD_COOLDOWN ||
      (effect === EFFECT_APPLY_AURA && aura === AURA_MOD_CATEGORY_COOLDOWN) ||
      (effect === EFFECT_APPLY_AURA &&
        aura === AURA_ADD_FLAT_MODIFIER &&
        miscValue0 === SPELLMOD_COOLDOWN)
    ) {
      modifierType = "reduce_cd";
      value = Math.abs(value);
      // DB2 stores some CD-reduction effects in ms and others in seconds with no unit
      // flag. Heuristic: no real talent reduces a cooldown by >500s, so any value >500
      // is assumed to be milliseconds and converted to seconds. If a future talent ever
      // legitimately reduces a CD by >500s, this would misclassify it — revisit then.
      if (value > 500) {
        value = Math.round(value / 1000);
      }
    } else if (
      effect === EFFECT_APPLY_AURA &&
      aura === AURA_OVERRIDE_ACTION_SPELL
    ) {
      modifierType = "replace_spell";
      // Replacement ID is in value
    }

    if (!modifierType) continue;

    const effectMasks = [
      toInt(row.EffectSpellClassMask_0),
      toInt(row.EffectSpellClassMask_1),
      toInt(row.EffectSpellClassMask_2),
      toInt(row.EffectSpellClassMask_3),
    ];

    const hasMask = effectMasks.some((m) => m !== 0);

    // Path A: Match via bitmask
    if (hasMask) {
      for (const [targetId, targetInfo] of targetSpellMasks.entries()) {
        if (targetInfo.family !== familyId) continue;

        const intersects =
          (effectMasks[0] & targetInfo.masks[0]) !== 0 ||
          (effectMasks[1] & targetInfo.masks[1]) !== 0 ||
          (effectMasks[2] & targetInfo.masks[2]) !== 0 ||
          (effectMasks[3] & targetInfo.masks[3]) !== 0;

        if (intersects) {
          addModifier(targetId, {
            talentSpellId,
            effect: modifierType,
            value,
          });
        }
      }
    }

    // Path B: Match via ChargeCategory (stored in MiscValue_0)
    const chargeTargets = chargeCategorySpells.get(miscValue0);
    if (miscValue0 > 0 && chargeTargets) {
      for (const targetId of chargeTargets) {
        addModifier(targetId, {
          talentSpellId,
          effect: modifierType,
          value,
        });
      }
    }

    // Path C: Direct Target Spell ID (stored in MiscValue_0)
    // Used for Effect 332 overrides (e.g. Ice Block -> Ice Cold)
    if (miscValue0 > 0 && !chargeCategorySpells.has(miscValue0)) {
      addModifier(String(miscValue0), {
        talentSpellId,
        effect: modifierType,
        value,
      });
    }
  }

  // 5. Merge Custom Modifiers
  for (const [targetId, mods] of Object.entries(CUSTOM_TALENT_MODIFIERS)) {
    mods.forEach((mod) => addModifier(targetId, mod));
  }

  // 6. Sanity filter: Only include modifiers for spells that are "important" enough to be tracked.
  const filteredResults: Record<string, ICDModifier[]> = {};
  for (const [targetId, mods] of Object.entries(results)) {
    if (trackedSpellIds.has(targetId)) {
      filteredResults[targetId] = mods;
    }
  }

  return filteredResults;
}

export async function main(): Promise<void> {
  const build = await resolveBuild();
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

  const [
    spellEffectRaw,
    spellClassOptionsRaw,
    spellCategoriesRaw,
    spellNameRaw,
  ] = await Promise.all([
    fetchTable("SpellEffect", build, cacheDir),
    fetchTable("SpellClassOptions", build, cacheDir),
    fetchTable("SpellCategories", build, cacheDir),
    fetchTable("SpellName", build, cacheDir),
  ]);

  const spellEffectRows = parseCsv(spellEffectRaw).rows;
  const spellClassOptionsRows = parseCsv(spellClassOptionsRaw).rows;
  const spellCategoriesRows = parseCsv(spellCategoriesRaw).rows;
  const spellNameRows = parseCsv(spellNameRaw).rows;

  const trackedSpellIds = new Set<string>();

  for (const c of classMetadata) {
    for (const a of c.abilities) {
      trackedSpellIds.add(a.spellId);
    }
  }
  for (const list of Object.values(spellIdLists)) {
    for (const id of list) {
      trackedSpellIds.add(String(id));
    }
  }
  for (const key of Object.keys(SPELL_CATEGORIES)) {
    trackedSpellIds.add(key);
  }
  if (spellClassMap.diminishingReturns) {
    for (const catList of Object.values(spellClassMap.diminishingReturns)) {
      for (const item of catList) {
        trackedSpellIds.add(item.spellId);
      }
    }
  }
  for (const id of TEAM_HEAL_CD_IDS) {
    trackedSpellIds.add(id);
  }

  const extraKeys = [
    "1044",
    "49028",
    "50322",
    "55342",
    "93985",
    "102543",
    "102558",
    "114052",
    "185422",
    "192249",
    "194249",
    "198067",
    "199448",
    "204021",
    "264735",
    "305395",
    "361175",
    "383410",
    "386071",
    "387278",
    "389539",
    "389722",
    "390414",
    "403876",
    "410358",
    "414658",
    "454351",
    "454373",
    "466772",
    "1219480",
    "1236574",
    "1250646",
    "1261559",
  ];
  for (const id of extraKeys) {
    trackedSpellIds.add(id);
  }

  const filteredResults = extractTalentModifiers(
    spellEffectRows,
    spellClassOptionsRows,
    spellCategoriesRows,
    spellNameRows,
    trackedSpellIds,
  );

  console.log(
    `Generated talent modifiers for ${Object.keys(filteredResults).length} tracked spells.`,
  );

  const outputPath = new URL(
    "../../src/data/talentModifiers.json",
    import.meta.url,
  ).pathname;

  writeArtifact(outputPath, `${JSON.stringify(filteredResults, null, 2)}\n`);
  console.log(`Wrote generated talent modifiers to ${outputPath}`);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genTalentModifiers.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
