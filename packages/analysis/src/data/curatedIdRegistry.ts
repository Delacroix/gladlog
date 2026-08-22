/**
 * Registry of every HAND-MAINTAINED table keyed by (or containing) WoW spell
 * ids. Exists for one purpose: the Curated-List Completeness Rule's **reverse
 * pass** — intersect each list's own keys with the corpus-observed id set and
 * surface entries with zero occurrences. Spell ids are not stable across
 * expansions (GH #23: `DISPEL_PENALTY_SPELLS` knew Unstable Affliction only by
 * two ids that occur 0× in 1178 rounds while the live id had 1153
 * applications); an entry that was right when written stays in the file
 * looking authoritative forever, and nothing downstream can tell "the game
 * doesn't have that" from "the list is stale".
 *
 * Generated tables (official DB2 mining) are deliberately NOT here — they are
 * refreshed by datagen, not hand-kept, and their universe is the whole game.
 * Mixed tables (generated ∪ hand layer) list only the hand layer.
 *
 * Consumers: `packages/eval/scripts/curatedRotScan.ts` (report) and
 * `test/curatedIdRegistry.test.ts` (shape). When you add a new hand table of
 * spell ids anywhere in this package, add an entry — the registry is the
 * index, and the rule has never been the missing piece (CLAUDE.md).
 */
import { classMetadata } from "./classSpells";
import { CURATED_ABILITY_FACTS } from "./curatedAbilityFacts";
import { DISPEL_VERDICTS } from "./dispelVerdicts";
import { spellClassMap } from "./drCategories";
import { MITIGATION_OVERRIDES, NO_MITIGATION_IDS } from "./mitigationData";
import { MITIGATION_VERDICTS } from "./mitigationVerdicts";
import { RACIAL_ABILITIES, SHARED_CD_RACIAL_SPELL_IDS } from "./racialAbilities";
import { SPELL_CATEGORIES } from "./spellCategories";
import { DISPEL_TYPES, SPELL_EFFECT_OVERRIDES } from "./spellEffectOverrides";
import spellIdLists from "./spellIdLists";
import { trinketSpellIds } from "./spellTags";
import {
  HIGH_VALUE_PURGEABLE_BUFFS,
  PURGE_WHITELIST_DATA_BLOCKED,
} from "../context/matchTimeline";
import { DOT_SPELL_IDS } from "../context/matchTimelineSections";
import {
  CHANNELED_CD_SPELL_IDS,
  ENEMY_MAJOR_BUFF_SPELL_IDS,
  HEALER_CAST_SPELL_ID_TO_NAME,
  HEALING_AMPLIFIER_SPELL_IDS,
  SPELL_DURATION_OVERRIDES,
} from "../context/timelineHelpers";
import {
  BREAKABLE_CC_SPELL_IDS,
  CC_AVOIDANCE_BUFF_SPELLS,
  DRUID_FORM_BUFFS,
  GROUND_CC_SPELL_IDS,
  MAGIC_ONLY_IMMUNITY_IDS,
  PHYSICAL_CC_IDS,
  REPOSITIONING_SPELL_IDS,
  TARGETED_CC_DODGE_SPELLS,
  TREMOR_BREAKABLE_CC_IDS,
} from "../utils/ccTrinketAnalysis";
import { STASIS_STORABLE_HEAL_IDS } from "../utils/combatStates";
import {
  ADDITIONAL_OVERLAP_DEFENSIVE_IDS,
  AURA_ONLY_ACTIVATION_IDS,
  CD_ROLE_TAGS,
  FORBEARANCE_GATED_IDS,
  NON_SUBSTITUTE_DEFENSIVE_IDS,
  SELF_CAST_NOOP_EXTERNAL_IDS,
  SPEC_EXCLUSIVE_SPELLS,
  TEAM_HEAL_CD_IDS,
  THROUGHPUT_EMPOWER_DEFENSIVE_IDS,
  USABLE_WHILE_CC_CONDITIONAL,
  USABLE_WHILE_CC_GAP_IDS,
} from "../utils/cooldowns";
import {
  EXTERNAL_DEFENSIVE_SPELLS,
  IMMUNITY_SPELLS,
} from "../utils/deathOutcomeAnalysis";
import {
  BACKLASH_CC_SPELL_IDS,
  COMP_DEPENDENT_PURGE_TARGETS,
  DISPEL_COOLDOWNS_BY_SPELL,
  DISPEL_PENALTY_SPELLS,
  PURGE_BLOCKLIST,
  STELLAR_PROTECTION_PENALIZED_SPELLS,
} from "../utils/dispelAnalysis";
import { AOE_CC_SPELL_IDS } from "../utils/drAnalysis";
import { CLASS_INTERRUPTS } from "../utils/enemyInterrupts";
import { HEALER_AVOIDANCE_SPELLS } from "../utils/healerExposureAnalysis";
import { PVP_TRINKET_SPELL_IDS } from "../utils/killWindowTargetSelection";
import { SPELL_EFFECT_OVERRIDES as SPELL_DANGER_OVERRIDES } from "../utils/spellDanger";
import {
  OFFENSIVE_PURGE_TALENT_IDS,
  TALENT_BEHAVIORS,
} from "../utils/talentBehaviors";

/** What kind of id the list holds — decides which corpus event stream can vouch for it. */
export type CuratedIdKind = "cast" | "aura" | "talent" | "mixed";

export interface CuratedIdTable {
  /** Export name, unique. */
  name: string;
  /** Source file, repo-relative to packages/analysis/src. */
  file: string;
  kind: CuratedIdKind;
  /** All spell ids the table asserts anything about, as numeric strings. */
  ids: () => string[];
}

const keys = (o: object) => Object.keys(o);
const set = (s: Iterable<string | number>) => [...s].map(String);
const t = (
  name: string,
  file: string,
  kind: CuratedIdKind,
  ids: () => Array<string | number | undefined | null>,
): CuratedIdTable => ({
  name,
  file,
  kind,
  ids: () => [...new Set(ids().filter((x) => x != null).map(String))],
});

export const CURATED_ID_TABLES: readonly CuratedIdTable[] = [
  // data/
  t("SPELL_CATEGORIES", "data/spellCategories.ts", "mixed", () => keys(SPELL_CATEGORIES)),
  t("classMetadata", "data/classSpells.ts", "cast", () =>
    classMetadata.flatMap((c) => c.abilities.map((a) => a.spellId)),
  ),
  t("SPELL_EFFECT_OVERRIDES", "data/spellEffectOverrides.ts", "cast", () => keys(SPELL_EFFECT_OVERRIDES)),
  t("DISPEL_TYPES", "data/spellEffectOverrides.ts", "aura", () => keys(DISPEL_TYPES)),
  t("spellIdLists.bigDefensiveSpellIds", "data/spellIdLists.ts", "cast", () => spellIdLists.bigDefensiveSpellIds),
  t("spellIdLists.attributedMitigationSpellIds", "data/spellIdLists.ts", "cast", () => spellIdLists.attributedMitigationSpellIds),
  t("spellIdLists.externalDefensiveSpellIds", "data/spellIdLists.ts", "cast", () => spellIdLists.externalDefensiveSpellIds),
  t("RACIAL_ABILITIES", "data/racialAbilities.ts", "cast", () => keys(RACIAL_ABILITIES)),
  t("SHARED_CD_RACIAL_SPELL_IDS", "data/racialAbilities.ts", "cast", () => set(SHARED_CD_RACIAL_SPELL_IDS)),
  t("MITIGATION_OVERRIDES", "data/mitigationData.ts", "cast", () => keys(MITIGATION_OVERRIDES)),
  t("NO_MITIGATION_IDS", "data/mitigationData.ts", "cast", () => set(NO_MITIGATION_IDS)),
  t("MITIGATION_VERDICTS", "data/mitigationVerdicts.ts", "cast", () => keys(MITIGATION_VERDICTS)),
  t("DISPEL_VERDICTS", "data/dispelVerdicts.ts", "aura", () => keys(DISPEL_VERDICTS)),
  t("spellClassMap.disarm+knockback", "data/drCategories.ts", "aura", () =>
    [...spellClassMap.diminishingReturns.disarm, ...spellClassMap.diminishingReturns.knockback].map((e) => e.spellId),
  ),
  t("CURATED_ABILITY_FACTS", "data/curatedAbilityFacts.ts", "mixed", () => CURATED_ABILITY_FACTS.map((f) => f.id)),
  t("trinketSpellIds", "data/spellTags.ts", "cast", () => trinketSpellIds),
  // utils/cooldowns.ts
  t("CD_ROLE_TAGS", "utils/cooldowns.ts", "cast", () => keys(CD_ROLE_TAGS)),
  t("TEAM_HEAL_CD_IDS", "utils/cooldowns.ts", "cast", () => set(TEAM_HEAL_CD_IDS)),
  t("ADDITIONAL_OVERLAP_DEFENSIVE_IDS", "utils/cooldowns.ts", "cast", () => set(ADDITIONAL_OVERLAP_DEFENSIVE_IDS)),
  t("USABLE_WHILE_CC_GAP_IDS", "utils/cooldowns.ts", "cast", () => set(USABLE_WHILE_CC_GAP_IDS)),
  t("USABLE_WHILE_CC_CONDITIONAL", "utils/cooldowns.ts", "cast", () => keys(USABLE_WHILE_CC_CONDITIONAL)),
  t("FORBEARANCE_GATED_IDS", "utils/cooldowns.ts", "cast", () => set(FORBEARANCE_GATED_IDS)),
  t("SPEC_EXCLUSIVE_SPELLS", "utils/cooldowns.ts", "cast", () => keys(SPEC_EXCLUSIVE_SPELLS)),
  t("AURA_ONLY_ACTIVATION_IDS", "utils/cooldowns.ts", "mixed", () =>
    [...keys(AURA_ONLY_ACTIVATION_IDS), ...Object.values(AURA_ONLY_ACTIVATION_IDS).flat()],
  ),
  t("NON_SUBSTITUTE_DEFENSIVE_IDS", "utils/cooldowns.ts", "cast", () => set(NON_SUBSTITUTE_DEFENSIVE_IDS)),
  t("SELF_CAST_NOOP_EXTERNAL_IDS", "utils/cooldowns.ts", "cast", () => set(SELF_CAST_NOOP_EXTERNAL_IDS)),
  t("THROUGHPUT_EMPOWER_DEFENSIVE_IDS", "utils/cooldowns.ts", "cast", () => set(THROUGHPUT_EMPOWER_DEFENSIVE_IDS)),
  // utils/dispelAnalysis.ts
  t("DISPEL_PENALTY_SPELLS", "utils/dispelAnalysis.ts", "aura", () => set(DISPEL_PENALTY_SPELLS.keys())),
  t("BACKLASH_CC_SPELL_IDS", "utils/dispelAnalysis.ts", "aura", () =>
    [...BACKLASH_CC_SPELL_IDS.keys(), ...[...BACKLASH_CC_SPELL_IDS.values()].map((v) => v.backlashSpellId)],
  ),
  t("STELLAR_PROTECTION_PENALIZED_SPELLS", "utils/dispelAnalysis.ts", "aura", () => set(STELLAR_PROTECTION_PENALIZED_SPELLS.keys())),
  t("DISPEL_COOLDOWNS_BY_SPELL", "utils/dispelAnalysis.ts", "cast", () => set(DISPEL_COOLDOWNS_BY_SPELL.keys())),
  t("PURGE_BLOCKLIST", "utils/dispelAnalysis.ts", "aura", () => set(PURGE_BLOCKLIST)),
  t("COMP_DEPENDENT_PURGE_TARGETS", "utils/dispelAnalysis.ts", "aura", () => set(COMP_DEPENDENT_PURGE_TARGETS)),
  // utils/ccTrinketAnalysis.ts
  t("CC_AVOIDANCE_BUFF_SPELLS", "utils/ccTrinketAnalysis.ts", "aura", () => set(CC_AVOIDANCE_BUFF_SPELLS.keys())),
  t("DRUID_FORM_BUFFS", "utils/ccTrinketAnalysis.ts", "aura", () => set(DRUID_FORM_BUFFS.keys())),
  t("BREAKABLE_CC_SPELL_IDS", "utils/ccTrinketAnalysis.ts", "aura", () => set(BREAKABLE_CC_SPELL_IDS)),
  t("GROUND_CC_SPELL_IDS", "utils/ccTrinketAnalysis.ts", "cast", () => set(GROUND_CC_SPELL_IDS)),
  t("MAGIC_ONLY_IMMUNITY_IDS", "utils/ccTrinketAnalysis.ts", "aura", () => set(MAGIC_ONLY_IMMUNITY_IDS)),
  t("PHYSICAL_CC_IDS", "utils/ccTrinketAnalysis.ts", "aura", () => set(PHYSICAL_CC_IDS)),
  t("REPOSITIONING_SPELL_IDS", "utils/ccTrinketAnalysis.ts", "cast", () => set(REPOSITIONING_SPELL_IDS.keys())),
  t("TARGETED_CC_DODGE_SPELLS", "utils/ccTrinketAnalysis.ts", "cast", () => set(TARGETED_CC_DODGE_SPELLS)),
  t("TREMOR_BREAKABLE_CC_IDS", "utils/ccTrinketAnalysis.ts", "aura", () => set(TREMOR_BREAKABLE_CC_IDS)),
  // context/
  t("HIGH_VALUE_PURGEABLE_BUFFS", "context/matchTimeline.ts", "aura", () => set(HIGH_VALUE_PURGEABLE_BUFFS)),
  t("PURGE_WHITELIST_DATA_BLOCKED", "context/matchTimeline.ts", "aura", () => set(PURGE_WHITELIST_DATA_BLOCKED)),
  t("HEALER_CAST_SPELL_ID_TO_NAME", "context/timelineHelpers.ts", "cast", () => keys(HEALER_CAST_SPELL_ID_TO_NAME)),
  t("ENEMY_MAJOR_BUFF_SPELL_IDS", "context/timelineHelpers.ts", "aura", () => keys(ENEMY_MAJOR_BUFF_SPELL_IDS)),
  t("CHANNELED_CD_SPELL_IDS", "context/timelineHelpers.ts", "cast", () => set(CHANNELED_CD_SPELL_IDS)),
  t("SPELL_DURATION_OVERRIDES", "context/timelineHelpers.ts", "mixed", () => keys(SPELL_DURATION_OVERRIDES)),
  t("HEALING_AMPLIFIER_SPELL_IDS", "context/timelineHelpers.ts", "aura", () => set(HEALING_AMPLIFIER_SPELL_IDS)),
  t("DOT_SPELL_IDS", "context/matchTimelineSections.ts", "aura", () => set(DOT_SPELL_IDS)),
  // other utils/
  t("TALENT_BEHAVIORS", "utils/talentBehaviors.ts", "mixed", () =>
    TALENT_BEHAVIORS.flatMap((b) => [
      b.talentSpellId,
      b.buffSpellId,
      ...(b.triggerSpellIds ?? []),
      b.conditionAuraId,
      b.abilitySpellId,
    ]),
  ),
  t("OFFENSIVE_PURGE_TALENT_IDS", "utils/talentBehaviors.ts", "talent", () => set(OFFENSIVE_PURGE_TALENT_IDS)),
  t("AOE_CC_SPELL_IDS", "utils/drAnalysis.ts", "cast", () => set(AOE_CC_SPELL_IDS)),
  t("IMMUNITY_SPELLS", "utils/deathOutcomeAnalysis.ts", "mixed", () =>
    Object.entries(IMMUNITY_SPELLS).flatMap(([k, v]) => [k, v.lockoutSpellId, ...(v.resetSpellIds ?? [])]),
  ),
  t("EXTERNAL_DEFENSIVE_SPELLS", "utils/deathOutcomeAnalysis.ts", "cast", () => keys(EXTERNAL_DEFENSIVE_SPELLS)),
  t("CLASS_INTERRUPTS", "utils/enemyInterrupts.ts", "cast", () =>
    Object.values(CLASS_INTERRUPTS).map((d) => d?.spellId),
  ),
  t("PVP_TRINKET_SPELL_IDS", "utils/killWindowTargetSelection.ts", "cast", () => set(PVP_TRINKET_SPELL_IDS)),
  t("STASIS_STORABLE_HEAL_IDS", "utils/combatStates.ts", "cast", () => set(STASIS_STORABLE_HEAL_IDS)),
  t("HEALER_AVOIDANCE_SPELLS", "utils/healerExposureAnalysis.ts", "cast", () =>
    Object.values(HEALER_AVOIDANCE_SPELLS).flatMap((arr) => (arr ?? []).map((e) => e.spellId)),
  ),
  t("spellDanger.SPELL_EFFECT_OVERRIDES", "utils/spellDanger.ts", "aura", () => keys(SPELL_DANGER_OVERRIDES)),
];
