import { SPELL_CATEGORIES } from "./spellCategories";
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

// ── CC full duration: one predicate ─────────────────────────────────────────
/**
 * Oppressing Roar (Evoker), the one effect that lengthens CC in arena: aura
 * 232 "mechanic duration mod" on every enemy within 30 yd for 10 s — DB2
 * SpellEffect@12.1.0.69404 EffectBasePointsF 50 × PvpMultiplier 0.6 = **+30 %
 * in PvP** while the debuff sits on the holder. User ruling 2026-09-02:
 * "羊本身永远是6秒 除非有龙给的加持续时间的debuff".
 */
export const OPPRESSING_ROAR_SPELL_ID = "372048";
export const OPPRESSING_ROAR_PVP_CC_DURATION_MULT = 1.3;

/**
 * Full, undiminished PvP duration of a CC / root aura in seconds — the fact the
 * "Xs of CC wasted" estimate in ccBreakAnalysis rests on. Reads the official
 * DB2 duration (`durationSeconds`: PvPDurationIndex when the spell has one,
 * spellEffectOverrides layered on top) and falls back to the hand
 * `SPELL_CATEGORIES[id].duration` only for ids DB2 leaves blank
 * (combo-point-scaled Kidney Shot, cast-side ids that never appear as auras).
 *
 * 2026-09-02 S2 corpus check (605 archive files, APPLIED→REMOVED lifetime mode
 * per id): of the 22 hard-CC / root ids where the hand table and DB2
 * disagreed, 21 sided with DB2 (Polymorph family 8→6, Hex 8→6, Freezing Trap
 * 8→6, Entangling Roots 8→6, Hammer of Justice 6→5, Cyclone 6→5, Blind 6→5,
 * Blinding Light 6→4, Leg Sweep 3→4, Freeze 6→8, Imprison 6→3, …); the one
 * that did not — Binding Shot 117526, DB2 2 s vs observed 3.0 s ×1084 — is
 * corrected in `CORPUS_DURATION_PATCHES` (spellEffectOverrides.ts) so this
 * accessor still has a single source. The hand durations that DB2 covers were
 * removed from SPELL_CATEGORIES the same day (pinned by
 * `test/ccFullDuration.test.ts`), so the fallback cannot silently disagree.
 */
export function ccFullDurationSeconds(spellId: string): number | undefined {
  return (
    spellEffectData[spellId]?.durationSeconds ??
    SPELL_CATEGORIES[spellId]?.duration
  );
}

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
