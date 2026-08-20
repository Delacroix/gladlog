import { SPELL_EFFECT_OVERRIDES } from "./spellEffectOverrides";
import { SPELL_EFFECTS_GENERATED } from "./spellEffectGenerated";

/*
 Interface and export for data mined from the WOW spells db itself
*/

export interface IMinedSpell {
  spellId: string;
  name: string;
  cooldownSeconds?: number;
  charges?: {
    charges?: number;
    chargeCooldownSeconds?: number;
  };
  durationSeconds?: number;
  /** Dispel type from SpellCategories.db2. null or undefined means the aura cannot be dispelled. */
  dispelType?: "Magic" | "Curse" | "Disease" | "Poison" | "Bleed" | null;
}

// Two layers: a generated base layer (raw DB2 values) plus a curated override
// layer that takes precedence (hand-calibrated values such as PvP adjustments
// always win).
//
// dispelType exception (2026-08-19, caught by 12.1 live logs — Ice Block
// mass-dispelled 30× in 147 matches while getDispelType said "not
// dispellable"): the override layer calibrates cooldown/duration/charges by
// hand, but NO `e()` entry ever sets dispelType — it is official-only data.
// A whole-object spread therefore silently DELETED the generated dispelType
// for every overridden id (7 ids: Divine Shield / Silence / Ice Block /
// Counter Shot / Blessing of Spellwarding / Apocalypse = Magic, Deathmark =
// Bleed). This is the SAME shadowing bug the DISPEL_TYPES patch loop in
// spellEffectOverrides.ts fixed for itself on 2026-07-25 — that fix never
// reached the main table. Field-restore dispelType only: the calibration
// fields (cd/duration/charges) stay override-authoritative as written, since
// their silence is itself a hand-modeling choice (e.g. generated
// charges 2×30s for Empower Rune Weapon contradicts the calibrated 120s —
// restoring charges wholesale would mix the two models).
export const spellEffectData = (() => {
  const merged = {
    ...SPELL_EFFECTS_GENERATED,
    ...SPELL_EFFECT_OVERRIDES,
  } as Record<string, IMinedSpell>;
  for (const id of Object.keys(SPELL_EFFECT_OVERRIDES)) {
    const gen = (SPELL_EFFECTS_GENERATED as Record<string, IMinedSpell>)[id];
    if (gen?.dispelType != null && merged[id]!.dispelType === undefined)
      merged[id] = { ...merged[id]!, dispelType: gen.dispelType };
  }
  return merged;
})();

// Loaded in the background rather than via a top-level await: TLA would make
// the entire module graph (including the renderer's first paint) serialize
// behind the 12MB table finishing its load — and the first screen (the match
// list) never looks up spell names at all. Evaluating this module kicks off
// the load and returns immediately; until it completes, getEnglishSpellName
// falls back down the fallback chain.
// The prompt path may NOT degrade: you must await ensureSpellNames() before
// building a prompt (the aggregate entry point is in data/ensure.ts).
let spellNamesMap: Record<string, string> = {};
let spellNamesLoaded = false;
const spellNamesLoad = import("./spellNames.json").then((m) => {
  spellNamesMap = (m.default ?? m) as unknown as Record<string, string>;
  spellNamesLoaded = true;
});

export const ensureSpellNames = (): Promise<void> => spellNamesLoad;

/** Whether spellNames has finished loading in the background (the gate for
 * spellNameLookup to build its index; do NOT test emptiness with Object.keys —
 * that counts 410k keys every single time). */
export const spellNamesReady = (): boolean => spellNamesLoaded;
export function getSpellNamesSnapshot(): Record<string, string> {
  return spellNamesMap;
}

export function getEnglishSpellName(
  spellId: string,
  fallback?: string | null,
): string {
  return (
    spellNamesMap[spellId] ??
    spellEffectData[spellId]?.name ??
    fallback ??
    spellId
  );
}
