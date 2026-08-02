import { CombatUnitSpec, ICombatUnit, LogEvent } from "@gladlog/parser-compat";

import { getEnglishSpellName, spellEffectData } from "../data/spellEffectData";
import spellIdListsData from "../data/spellIdLists";
import {
  isCastBlockingAuraType,
  kickLockoutSeconds,
  SPELL_CATEGORIES as spellsData,
} from "../data/spellCategories";
import { fmtTime, getPressureThreshold, specToString } from "./cooldowns";
import {
  buildCcCategoryHistory,
  getDRCategory,
  getDRLevelAtTime,
} from "./drAnalysis";
import {
  distanceBetween,
  getUnitPositionAtTime,
  hasLineOfSight,
} from "./losAnalysis";
import { DISPEL_MAX_RANGE_YARDS, LOS_SWEEP_GAP_MS } from "./positionSampling";
import { hasOffensivePurgeTalent } from "./talentBehaviors";
import {
  getPlayerTalentedSpellIds,
  getSpecTalentTreeSpellIds,
} from "./talents";

export type DispelPriority = "Critical" | "High" | "Medium" | "Low";
import { DISPEL_FEATURE_FLAGS } from "../data/dispelFeatureFlags";

type SpellEntry = { type: string; priority?: boolean };
const SPELLS = spellsData as Record<string, SpellEntry>;
const BIG_DEFENSIVE_IDS = new Set<string>(
  spellIdListsData.bigDefensiveSpellIds as string[],
);
const EXTERNAL_DEFENSIVE_IDS = new Set<string>(
  spellIdListsData.externalDefensiveSpellIds as string[],
);

const MISSED_CLEANSE_THRESHOLD_S = 3;
const MISSED_PURGE_THRESHOLD_S = 3;
const PENALTY_WINDOW_MS = 4000;

// Seconds after CC application to measure incoming damage for post-CC pressure weighting
const POST_CC_PRESSURE_WINDOW_S = 5;

// Spells that silence + damage the dispeller when removed.
// Only Unstable Affliction reliably has this mechanic in current WoW (TWW).
// VT dispel-damage was removed in Legion; Flame Shock has no dispel penalty.
// IDs 316099 and 342938 are confirmed present in BigDebuffs data for TWW.
const DISPEL_PENALTY_SPELLS = new Map<string, string>([
  ["316099", "Silences & damages the dispeller (Unstable Affliction)"],
  ["342938", "Silences & damages the dispeller (Unstable Affliction)"],
  ["34914", "Horrifies the dispeller (Vampiric Touch)"],
]);

const BACKLASH_CC_SPELL_IDS = new Map<string, { backlashSpellId: string }>([
  ["34914", { backlashSpellId: "34914" }],
  ["316099", { backlashSpellId: "196363" }],
  ["342938", { backlashSpellId: "196363" }],
]);

const DISPEL_COOLDOWNS_BY_SPELL = new Map<string, number>([
  ["374251", 60], // Cauterizing Flame (Preservation Evoker)
  ["475", 0], // Remove Curse (Mage)
  ["2782", 0], // Remove Corruption (Druid)
]);

// Static spec → dispel-type maps. These represent specs whose cleanse ability is treated as
// baseline (virtually always present in arena). A few cleanses are technically talent-gated
// in the class/spec tree but are skipped so universally that treating them as static avoids
// noise without meaningful accuracy loss:
//   - Paladin Cleanse Toxins (Poison/Disease): class tree node, skipped only by very niche builds
//   - Druid Remove Corruption (Poison/Curse): class tree node, universal in arena
//   - Resto Druid Nature's Cure / Resto Shaman Purify Spirit: spec tree, always taken in arena
// Shadow Priest Purify Disease is the only talent-gated cleanse handled dynamically
// (via canDefensiveCleanse) because it is a meaningful variance in typical Shadow builds.
const MAGIC_REMOVERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Paladin_Holy,
  CombatUnitSpec.Priest_Discipline,
  CombatUnitSpec.Priest_Holy,
  CombatUnitSpec.Druid_Restoration, // Nature's Cure — spec tree, always talented in arena
  CombatUnitSpec.Shaman_Restoration, // Purify Spirit — spec tree, always talented in arena
  CombatUnitSpec.Monk_Mistweaver, // Detox (also removes Poison/Disease)
  CombatUnitSpec.Evoker_Preservation, // Naturalize
]);

// Poison: all Paladins (Cleanse Toxins), all Druids (Remove Corruption), all Monks (Detox)
const POISON_REMOVERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Paladin_Holy,
  CombatUnitSpec.Paladin_Protection,
  CombatUnitSpec.Paladin_Retribution,
  CombatUnitSpec.Druid_Balance,
  CombatUnitSpec.Druid_Feral,
  CombatUnitSpec.Druid_Guardian,
  CombatUnitSpec.Druid_Restoration,
  CombatUnitSpec.Monk_Mistweaver,
  CombatUnitSpec.Monk_Windwalker,
  CombatUnitSpec.Monk_Brewmaster,
  CombatUnitSpec.Evoker_Preservation, // Naturalize / Expunge / Cauterizing Flame
  CombatUnitSpec.Evoker_Devastation, // Expunge / Cauterizing Flame
  CombatUnitSpec.Evoker_Augmentation, // Expunge / Cauterizing Flame
]);

// Curse: all Druids (Remove Corruption), all Mages (Remove Curse), Resto Shaman (Purify Spirit)
const CURSE_REMOVERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Druid_Balance,
  CombatUnitSpec.Druid_Feral,
  CombatUnitSpec.Druid_Guardian,
  CombatUnitSpec.Druid_Restoration,
  CombatUnitSpec.Mage_Arcane,
  CombatUnitSpec.Mage_Fire,
  CombatUnitSpec.Mage_Frost,
  CombatUnitSpec.Shaman_Restoration,
  CombatUnitSpec.Evoker_Preservation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Devastation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Augmentation, // Cauterizing Flame
]);

// Disease: all Paladins (Cleanse Toxins), Holy/Disc Priest (Purify), all Monks (Detox)
// Shadow Priest (Purify Disease) is talent-gated and handled in canDefensiveCleanse, not here.
const DISEASE_REMOVERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Paladin_Holy,
  CombatUnitSpec.Paladin_Protection,
  CombatUnitSpec.Paladin_Retribution,
  CombatUnitSpec.Priest_Discipline,
  CombatUnitSpec.Priest_Holy,
  CombatUnitSpec.Monk_Mistweaver,
  CombatUnitSpec.Monk_Windwalker,
  CombatUnitSpec.Monk_Brewmaster,
  CombatUnitSpec.Evoker_Preservation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Devastation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Augmentation, // Cauterizing Flame
]);

// Bleed: Evokers
const BLEED_REMOVERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Evoker_Preservation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Devastation, // Cauterizing Flame
  CombatUnitSpec.Evoker_Augmentation, // Cauterizing Flame
]);

// Specs capable of removing Magic buffs from enemies (offensive dispel / spellsteal / devour)
const OFFENSIVE_PURGERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Priest_Discipline, // Dispel Magic (offensive target)
  CombatUnitSpec.Priest_Holy, // Dispel Magic (offensive target)
  CombatUnitSpec.Priest_Shadow, // Dispel Magic (offensive target)
  CombatUnitSpec.Shaman_Restoration, // Purge
  CombatUnitSpec.Shaman_Elemental, // Purge
  CombatUnitSpec.Shaman_Enhancement, // Purge
  CombatUnitSpec.Mage_Arcane, // Spellsteal
  CombatUnitSpec.Mage_Fire, // Spellsteal
  CombatUnitSpec.Mage_Frost, // Spellsteal
  CombatUnitSpec.DemonHunter_Havoc, // Consume Magic
  CombatUnitSpec.DemonHunter_Vengeance, // Consume Magic
  CombatUnitSpec.Warlock_Affliction, // Devour Magic (Felhunter)
  CombatUnitSpec.Warlock_Demonology, // Devour Magic (Felhunter)
  CombatUnitSpec.Warlock_Destruction, // Devour Magic (Felhunter)
]);

// Purge specs whose purge ability has a meaningful cooldown (>= 8s).
// For these, only flag Critical priority missed purges — they can't freely spam purge
// every GCD so holding the ability for a better target is often correct.
const CD_GATED_PURGERS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Evoker_Preservation, // Naturalize: 10s CD
  CombatUnitSpec.Evoker_Devastation, // Naturalize: 10s CD
  CombatUnitSpec.Evoker_Augmentation, // Naturalize: 10s CD
  CombatUnitSpec.Warlock_Affliction, // Devour Magic: ~8s CD
  CombatUnitSpec.Warlock_Demonology,
  CombatUnitSpec.Warlock_Destruction,
  CombatUnitSpec.DemonHunter_Havoc, // Consume Magic: 8s CD
  CombatUnitSpec.DemonHunter_Vengeance,
]);

// Spell IDs that have Magic dispelType in the game DB but cannot actually be targeted
// by player offensive purge abilities in practice. Covers three categories:
//   1. Immunity shells — target is spell-immune while active, so purge cannot land
//   2. Passive/visual auras — registered as Magic but not dispel-targetable
//   3. Cross-team targeting issues — buff is on your ally, not an enemy
const PURGE_BLOCKLIST = new Set<string>([
  // ── Immunity shells (target is spell-immune; purge cannot land) ──────────────────
  "642", // Divine Shield (Paladin) — full spell immunity while active
  "45438", // Ice Block (Mage) — full spell immunity while active
  "186265", // Aspect of the Turtle (Hunter) — full spell + attack immunity
  // ── Passive / visual auras — registered as Magic but not dispel-targetable ───────
  "188501", // Spectral Sight (DH) — passive/visual, not purgeable
  "132158", // Nature's Swiftness — instant-cast buff, expires before purge lands
  // ── Cross-team targeting issues ──────────────────────────────────────────────────
  "29166", // Innervate — targeted at an ally, not an enemy; removed by defensive cleanse
  "605", // Mind Control — debuff on your ally, removed via defensive cleanse not offensive purge
]);

// Single source of truth — DispelType is derived from this array so adding a new type here
// automatically widens the union without needing a second edit.
const ALL_DISPEL_TYPES = [
  "Magic",
  "Poison",
  "Curse",
  "Disease",
  "Bleed",
] as const;
type DispelType = (typeof ALL_DISPEL_TYPES)[number];

// DH Consume Magic is in the TWW talent tree — only available if the player took the node.
const CONSUME_MAGIC_SPELL_ID = "278326";
// Warlock Felhunter: Summon Felhunter is in the talent tree; Devour Magic is a pet ability (not player talent).
// We use the Summon Felhunter talent as a proxy, falling back to cast evidence.
const SUMMON_FELHUNTER_SPELL_ID = "30146";
// Shadow Priest: Purify Disease is in the talent tree (not baseline like Holy/Disc).
// 213634 is confirmed in talentIdMap.json as both the talent node spellId and the cast spell ID,
// so it works for both talentedIds.has() checks and cast-evidence fallback.
const PURIFY_DISEASE_SPELL_ID = "213634";

const WARLOCK_SPECS = new Set<CombatUnitSpec>([
  CombatUnitSpec.Warlock_Affliction,
  CombatUnitSpec.Warlock_Demonology,
  CombatUnitSpec.Warlock_Destruction,
]);
const DH_SPECS = new Set<CombatUnitSpec>([
  CombatUnitSpec.DemonHunter_Havoc,
  CombatUnitSpec.DemonHunter_Vengeance,
]);

/** Returns the set of spell IDs the unit successfully cast during the match. */
function unitCastSpellIds(unit: ICombatUnit): Set<string> {
  return new Set<string>(
    unit.spellCastEvents
      .filter((e) => e.logLine.event === LogEvent.SPELL_CAST_SUCCESS)
      .map((e) => e.spellId)
      .filter((id): id is string => id !== null),
  );
}

/**
 * Extracts the BUFF/DEBUFF marker from an aura event's raw log line.
 * Combat-log parameter index 11 holds this for SPELL_AURA_APPLIED, SPELL_AURA_REMOVED,
 * and SPELL_AURA_BROKEN(_SPELL). Returns null when the marker is absent (older fixtures
 * or edge log lines) so callers can decide how to treat unknowns.
 */
function getAuraType(aura: {
  logLine: { parameters: (string | number)[] };
}): "BUFF" | "DEBUFF" | null {
  const raw = aura.logLine.parameters[11];
  if (raw === "BUFF" || raw === "DEBUFF") return raw;
  return null;
}

/**
 * Returns true if a talent-gated spell is confirmed available for the unit.
 * - Has talent data and took the talent → true
 * - Has talent data and didn't take it → false
 * - No talent data + has COMBATANT_INFO → fall back to cast evidence
 * - No COMBATANT_INFO at all → false (can't verify; avoid false positives)
 */
function hasTalentedAbility(unit: ICombatUnit, spellId: string): boolean {
  const specIdNum = parseInt(unit.spec, 10);
  const talentTreeIds = getSpecTalentTreeSpellIds(specIdNum);
  if (!talentTreeIds.has(spellId)) return false; // not a talent for this spec

  const talentedIds = unit.info?.talents
    ? getPlayerTalentedSpellIds(specIdNum, unit.info.talents)
    : null;
  if (talentedIds !== null) return talentedIds.has(spellId);

  // No parsed talent data — use cast evidence if COMBATANT_INFO was present
  if (unit.info !== undefined) return unitCastSpellIds(unit).has(spellId);

  return false; // no COMBATANT_INFO — can't verify
}

/**
 * Returns true if the unit can defensively cleanse the given debuff type from an ally,
 * accounting for talent-gated abilities (e.g. Shadow Priest Purify Disease).
 *
 * Note: Warlock Imp Singe Magic (party magic cleanse) is not tracked — it is a pet
 * ability with no reliable signal in player cast events.
 */
export function canDefensiveCleanse(
  unit: ICombatUnit,
  dispelType: DispelType,
): boolean {
  switch (dispelType) {
    case "Magic":
      return MAGIC_REMOVERS.has(unit.spec);
    case "Poison":
      return POISON_REMOVERS.has(unit.spec);
    case "Curse":
      return CURSE_REMOVERS.has(unit.spec);
    case "Disease":
      if (DISEASE_REMOVERS.has(unit.spec)) return true;
      // Shadow Priest can talent into Purify Disease — not in DISEASE_REMOVERS by default
      if (unit.spec === CombatUnitSpec.Priest_Shadow)
        return hasTalentedAbility(unit, PURIFY_DISEASE_SPELL_ID);
      return false;
    case "Bleed":
      return BLEED_REMOVERS.has(unit.spec);
  }
}

/**
 * Returns true if the unit can actually perform an offensive purge, accounting for
 * talent gating (DH Consume Magic) and pet requirements (Warlock Felhunter).
 */
export function canOffensivePurge(unit: ICombatUnit): boolean {
  // B139: some specs gain an offensive purge only from a PvP talent — Preservation Evoker has no baseline
  // offensive purge (Naturalize is a defensive ally-dispel), but Scouring Flame gives Fire Breath one.
  if (hasOffensivePurgeTalent(unit.info?.pvpTalents)) return true;
  if (!OFFENSIVE_PURGERS.has(unit.spec)) return false;

  const specIdNum = parseInt(unit.spec, 10);
  const talentTreeIds = getSpecTalentTreeSpellIds(specIdNum);
  const talentedIds = unit.info?.talents
    ? getPlayerTalentedSpellIds(specIdNum, unit.info.talents)
    : null;
  const hasCombatantInfo = unit.info !== undefined;
  // castSpellIds is computed lazily (only when talentedIds is null) to avoid iterating
  // potentially thousands of cast events on the hot path where COMBATANT_INFO is present.
  let castSpellIds: Set<string> | null = null;
  const getCastSpellIds = () => {
    if (castSpellIds === null) castSpellIds = unitCastSpellIds(unit);
    return castSpellIds;
  };

  // DH: Consume Magic is talent-gated.
  if (DH_SPECS.has(unit.spec) && talentTreeIds.has(CONSUME_MAGIC_SPELL_ID)) {
    if (talentedIds !== null && !talentedIds.has(CONSUME_MAGIC_SPELL_ID))
      return false;
    if (
      talentedIds === null &&
      hasCombatantInfo &&
      !getCastSpellIds().has(CONSUME_MAGIC_SPELL_ID)
    )
      return false;
  }

  // Warlock: Devour Magic requires an active Felhunter pet.
  // Summon Felhunter (30146) is in the talent tree; if the player has talent data and didn't
  // take it, they likely have a different pet. Fall back to cast evidence for the summon.
  if (WARLOCK_SPECS.has(unit.spec)) {
    if (talentTreeIds.has(SUMMON_FELHUNTER_SPELL_ID)) {
      if (talentedIds !== null && !talentedIds.has(SUMMON_FELHUNTER_SPELL_ID)) {
        // Didn't take Summon Felhunter talent — check cast evidence as final fallback
        // (they may have summoned it before the match started, so cast may not appear)
        if (!getCastSpellIds().has(SUMMON_FELHUNTER_SPELL_ID)) return false;
      }
    }
  }

  return true;
}

/**
 * DISPEL_TYPE_FALLBACK 墓碑(2026-07-25 双证据清除):曾有 8 条「实践确认
 * 可解」的手工补丁(Blind/Paralysis/Quaking Palm/Freezing Trap 203337/
 * Intimidating Shout ×3/Incapacitating Roar)。审计结果:8 条全部
 * (a) DB2 官方 dispelType 为 null,(b) 1245 场语料零次被观测解除。
 * 冰冻陷阱的**真光环 id 3355** 官方本就是 Magic 且语料有实证 —— 203337
 * 是从未出现在光环事件里的死 id(施法/天赋 id ≠ 日志光环 id,与 DR 表
 * 震荡波 46968 同病)。结论:官方 dispelType 即完整判据,不再留手工层。 */
const DISPEL_TYPE_FALLBACK: Record<string, DispelType> = {};

/** Returns the dispel type for a spell ID from game data, or null if the spell cannot be dispelled. */
function getDispelType(spellId: string): DispelType | null {
  const type = spellEffectData[spellId]?.dispelType;
  if (
    type === "Magic" ||
    type === "Poison" ||
    type === "Curse" ||
    type === "Disease" ||
    type === "Bleed"
  )
    return type;
  // Fall back to our curated map for CC spells missing from spellEffects.json.
  return DISPEL_TYPE_FALLBACK[spellId] ?? null;
}

function buildTeamDispelTypes(friends: ICombatUnit[]): Set<DispelType> {
  const types = new Set<DispelType>();
  for (const unit of friends) {
    for (const type of ALL_DISPEL_TYPES) {
      if (canDefensiveCleanse(unit, type)) types.add(type);
    }
  }
  return types;
}

/** Returns which friendly units can remove each dispel type. */
function buildTeamDispelCapability(
  friends: ICombatUnit[],
): Map<DispelType, ICombatUnit[]> {
  const map = new Map<DispelType, ICombatUnit[]>();
  const add = (type: DispelType, unit: ICombatUnit) => {
    const list = map.get(type) ?? [];
    list.push(unit);
    map.set(type, list);
  };
  for (const unit of friends) {
    for (const type of ALL_DISPEL_TYPES) {
      if (canDefensiveCleanse(unit, type)) add(type, unit);
    }
  }
  return map;
}

export interface IDispelEvent {
  timeSeconds: number;
  dispelSpellId: string;
  dispelSpellName: string;
  removedSpellId: string;
  removedSpellName: string;
  sourceName: string;
  sourceSpec: string;
  targetName: string;
  targetSpec: string;
  priority: DispelPriority;
  hasDispelPenalty: boolean;
  penaltyDescription?: string;
  /** Damage taken by the dispeller in the 4s after the dispel (only set when hasDispelPenalty) */
  penaltyDamageTaken?: number;
  /** Damage taken by the dispeller in the 4s before the dispel — baseline context */
  penaltyDamageBaseline?: number;
  isSpellSteal: boolean;
  /** True when the dispel was performed by a pet/NPC merged into the player's actionOut (e.g. Warlock Felhunter Devour Magic, Imp Singe Magic). */
  isPetDispel: boolean;
  wasFatal?: boolean;
  fatalUnitName?: string;
  fatalUnitSpec?: string;
  backlashCcSpellId?: string;
}

export interface IMissedCleanseWindow {
  timeSeconds: number;
  durationSeconds: number;
  targetName: string;
  targetSpec: string;
  spellName: string;
  spellId: string;
  priority: DispelPriority;
  dispelType: DispelType; // always set; null case is filtered before pushing
  /** Damage the target took in the first POST_CC_PRESSURE_WINDOW_S seconds after CC was applied */
  postCcDamage: number;
  /** True if the healer who could remove this dispelType had their cleanse on CD */
  cleanseWasOnCD: boolean;
  cdBurnedOn?: {
    spellName: string;
    priority: DispelPriority;
    secondsBefore: number;
  };
  /** 可行性门 b+c(2026-08-02 用户拍板):硬控/沉默光环 ∪ 踢锁,所有具备该
   * 解法的驱散者在窗口内的自由时间 < 反应阈值(MISSED_CLEANSE_THRESHOLD_S)
   * —— 被控着/被锁着没法解,不算漏。 */
  dispellersLockedOut: boolean;
  /** 可行性门 a(三态):true=至少一名驱散者在反应窗内够得着(≤40 码且 LoS
   * 不为 false);false=有位置数据且全员够不着;null=无位置数据,**不改判**
   * (无数据当不可行会吞掉全部非 advanced 语料的教学)。 */
  losReachable: boolean | null;
  /** 价值门 d:目标该 DR 类当时全新鲜,且窗口结束后 DR_CHAIN_LOOKAHEAD_S 内
   * 又吃了同类控制 —— 驱散换来的可能是满时长续控,注解降为谨慎建议,不拦。 */
  drChainRisk: boolean;
}

export interface ICCEfficiencyStat {
  targetName: string;
  targetSpec: string;
  /** Critical + High CC windows applied by enemies (that the team could have cleansed) */
  totalCCWindows: number;
  /** CC windows dispelled quickly (< threshold) or explicitly dispelled by a teammate */
  cleanseCount: number;
  /** CC windows that lasted > threshold without a friendly dispel */
  missedCount: number;
  /** CC windows that ended because of incoming damage (SPELL_AURA_BROKEN_SPELL), not dispelled */
  brokenCount: number;
  /** cleanseCount / (cleanseCount + missedCount), ignoring broken-by-damage windows */
  cleanseRate: number;
}

export interface IMissedPurgeWindow {
  timeSeconds: number;
  /** How long the buff sat uncontested; capped at match duration if never removed */
  durationSeconds: number;
  /** How long the buff was expected to last per spellEffectData; undefined if no duration data */
  expectedBuffDurationSeconds?: number;
  enemyName: string;
  enemySpec: string;
  spellName: string;
  spellId: string;
  priority: DispelPriority;
  /** True if all eligible purgers had their purge ability on CD at the start of the miss window */
  purgeWasOnCD: boolean;
  /** What the purger last used their ability on before the miss (only set when purgeWasOnCD) */
  cdBurnedOn?: {
    spellName: string;
    priority: DispelPriority;
    secondsBefore: number;
  };
  /**
   * True if friendly team was under meaningful pressure during the miss window.
   * Uses role-aware getPressureThreshold (post B8 fix).
   */
  teamUnderPressure: boolean;
  /** True when the missed purge fell inside a friendly kill window (offensiveWindows intersection).
   *  Optional: only set when annotateMissedPurgesWithKillWindows has run. */
  duringKillWindow?: boolean;
  /** 可行性门 b+c(cleanse 侧同款):所有 eligible purger 被硬控/踢锁到自由
   * 时间 < 反应阈值。 */
  purgersLockedOut: boolean;
  /** 可行性门 a(三态,cleanse 侧同款语义)。 */
  losReachable: boolean | null;
}

/** Marks missed purges that fell inside a friendly kill window. Mutates in place;
 *  kept separate from reconstructDispelSummary so its signature (and all call sites) stay unchanged. */
export function annotateMissedPurgesWithKillWindows(
  missedPurgeWindows: IMissedPurgeWindow[],
  offensiveWindows: Array<{ fromSeconds: number; toSeconds: number }>,
): void {
  for (const miss of missedPurgeWindows) {
    miss.duringKillWindow = offensiveWindows.some(
      (w) =>
        miss.timeSeconds >= w.fromSeconds && miss.timeSeconds < w.toSeconds,
    );
  }
}

export interface IDispelSummary {
  /** Our team removed debuffs from our allies */
  allyCleanse: IDispelEvent[];
  /** Our team purged / spell-stole buffs from enemies */
  ourPurges: IDispelEvent[];
  /** Enemies stripped buffs from our team */
  hostilePurges: IDispelEvent[];
  missedCleanseWindows: IMissedCleanseWindow[];
  ccEfficiency: ICCEfficiencyStat[];
  /** Critical/High magic buffs on enemies that sat >3s while we had an offensive purger */
  missedPurgeWindows: IMissedPurgeWindow[];
}

function getPriority(spellId: string): DispelPriority {
  // WoW-flagged major defensives take precedence
  if (BIG_DEFENSIVE_IDS.has(spellId) || EXTERNAL_DEFENSIVE_IDS.has(spellId))
    return "Critical";

  const spell = SPELLS[spellId];
  if (!spell) return "Low";

  switch (spell.type) {
    case "cc":
    case "immunities":
      return "Critical";
    case "roots":
    case "immunities_spells":
    case "buffs_offensive":
    case "debuffs_offensive":
    case "buffs_defensive":
      return "High";
    case "buffs_other":
      return "Medium";
    default:
      return "Low";
  }
}

/**
 * Returns true if the given CC windows (sorted by start) cover every millisecond of [start, end].
 */
function isWindowFullyCovered(
  ccWindows: Array<{ from: number; to: number }>,
  start: number,
  end: number,
): boolean {
  const relevant = ccWindows.filter((w) => w.from <= end && w.to >= start);
  if (relevant.length === 0) return false;
  relevant.sort((a, b) => a.from - b.from);
  let covered = start;
  for (const w of relevant) {
    if (w.from > covered) return false; // gap — purger was free
    covered = Math.max(covered, w.to);
    if (covered >= end) return true;
  }
  return covered >= end;
}

/**
 * 单位「无法施法」区间(2026-08-02 可行性门 b+c 单源):
 *  - 敌方施加的施法阻断光环(硬控 + 沉默,isCastBlockingAuraType 单源);
 *  - 敌方踢技的学派锁定(SPELL_INTERRUPT 无光环事件,时长查
 *    kickLockoutSeconds;首版从宽不校学派 —— 锁的多半正是治疗学派,
 *    误豁免代价远小于误责难)。
 */
function buildCannotCastIntervals(
  unit: ICombatUnit,
  enemyIds: Set<string>,
): Array<{ from: number; to: number }> {
  const appliedTimes = new Map<string, number[]>();
  const removedTimes = new Map<string, number[]>();

  for (const aura of unit.auraEvents) {
    const spellId = aura.spellId;
    if (!spellId) continue;
    if (!enemyIds.has(aura.srcUnitId)) continue;
    const spell = SPELLS[spellId];
    // 施法阻断谓词单源(硬控 + 沉默类光环)——此前只认 "cc",被沉默的驱散者
    // 照样被判「漏解」。
    if (!spell || !isCastBlockingAuraType(spell.type)) continue;

    if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      const bucket = appliedTimes.get(spellId) ?? [];
      appliedTimes.set(spellId, [...bucket, aura.timestamp]);
    } else if (
      aura.logLine.event === LogEvent.SPELL_AURA_REMOVED ||
      aura.logLine.event === LogEvent.SPELL_AURA_BROKEN ||
      aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
    ) {
      const bucket = removedTimes.get(spellId) ?? [];
      removedTimes.set(spellId, [...bucket, aura.timestamp]);
    }
  }

  const intervals: Array<{ from: number; to: number }> = [];
  for (const [spellId, applications] of appliedTimes) {
    const removals = removedTimes.get(spellId) ?? [];
    for (const applyTs of applications) {
      const removalTs = removals.find((r) => r >= applyTs);
      intervals.push({ from: applyTs, to: removalTs ?? Infinity });
    }
  }

  // 踢锁:SPELL_INTERRUPT 语义 spellId=踢技(matchTimeline [KICK] 同源,
  // 门规谓词分叉第 13 例的教训 —— 别取 extraSpellId)。
  for (const action of unit.actionIn) {
    if (action.logLine.event !== LogEvent.SPELL_INTERRUPT) continue;
    if (!enemyIds.has(action.srcUnitId)) continue;
    const kickSpellId = action.spellId ?? "";
    intervals.push({
      from: action.timestamp,
      to: action.timestamp + kickLockoutSeconds(kickSpellId) * 1000,
    });
  }

  return intervals;
}

/**
 * Returns true if the unit was unable to cast (cast-blocking aura or kick
 * lockout — see buildCannotCastIntervals) for the ENTIRETY of
 * [windowStartMs, windowEndMs].
 */
function isPurgerFullyBlockedDuringWindow(
  purger: ICombatUnit,
  windowStartMs: number,
  windowEndMs: number,
  enemyIds: Set<string>,
): boolean {
  return isWindowFullyCovered(
    buildCannotCastIntervals(purger, enemyIds),
    windowStartMs,
    windowEndMs,
  );
}

/** 区间并集在 [start, end] 内覆盖的毫秒数。 */
function coveredMsWithin(
  intervals: Array<{ from: number; to: number }>,
  start: number,
  end: number,
): number {
  const clipped = intervals
    .map((w) => ({ from: Math.max(w.from, start), to: Math.min(w.to, end) }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from);
  let covered = 0;
  let cursor = start;
  for (const w of clipped) {
    if (w.to <= cursor) continue;
    covered += w.to - Math.max(w.from, cursor);
    cursor = Math.max(cursor, w.to);
  }
  return covered;
}

/**
 * 可行性门 b+c:所有 dispellers 在 [startMs, endMs] 内「全员同时无法施法」
 * 的时间(各自无法施法区间的交集)吃到只剩 < freeThresholdMs 的自由时间。
 * 任一驱散者自由即该时刻不计 —— 交集语义。
 */
function dispellersLockedOutForWindow(
  dispellers: ICombatUnit[],
  startMs: number,
  endMs: number,
  enemyIds: Set<string>,
  freeThresholdMs: number,
): boolean {
  if (dispellers.length === 0 || endMs <= startMs) return false;
  // 交集 = 逐毫秒「所有人都被锁」;等价于窗口减去「至少一人自由」的时间。
  // 数值化:自由时间 = 窗口长 - 交集覆盖。交集用逐单位并集再取交。
  let intersection: Array<{ from: number; to: number }> | null = null;
  for (const d of dispellers) {
    const merged = mergeIntervals(buildCannotCastIntervals(d, enemyIds));
    intersection =
      intersection === null
        ? merged
        : intersectIntervalSets(intersection, merged);
    if (intersection.length === 0) return false; // 有人全程自由
  }
  const blockedMs = coveredMsWithin(intersection ?? [], startMs, endMs);
  const freeMs = endMs - startMs - blockedMs;
  return freeMs < freeThresholdMs;
}

function mergeIntervals(
  intervals: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

function intersectIntervalSets(
  a: Array<{ from: number; to: number }>,
  b: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i].from, b[j].from);
    const to = Math.min(a[i].to, b[j].to);
    if (to > from) out.push({ from, to });
    if (a[i].to < b[j].to) i++;
    else j++;
  }
  return out;
}

/**
 * 可行性门 a(三态):反应窗 [applyTs, applyTs+reactMs] 内按整秒网格采样,
 * 任一秒任一 dispeller 与目标同时有位置且 距离 ≤ DISPEL_MAX_RANGE_YARDS 且
 * LoS 不为 false(无几何 → null → 射程单独判)→ true(够得着,责难成立);
 * 扫全网格有样本但从未够得着 → false(豁免);全程无样本对 → null(不改判,
 * 三态铁律 —— 见 losAnalysis/ccTrinketAnalysis 先例)。
 */
function anyDispellerReachable(
  dispellers: ICombatUnit[],
  target: ICombatUnit,
  applyTs: number,
  reactMs: number,
  zoneId: string | undefined,
): boolean | null {
  if (dispellers.length === 0) return null;
  // 渲染网格锚定:整秒扫描(fmtTime 向下取整秒,门规复算按渲染网格 —— 与
  // healerExposureAnalysis 的 G5 语义同族)。
  const t0 = Math.floor(applyTs / 1000) * 1000;
  let sawSamplePair = false;
  for (let t = t0; t <= applyTs + reactMs; t += 1000) {
    const targetPos = getUnitPositionAtTime(target, t, LOS_SWEEP_GAP_MS);
    if (!targetPos) continue;
    for (const d of dispellers) {
      const dPos = getUnitPositionAtTime(d, t, LOS_SWEEP_GAP_MS);
      if (!dPos) continue;
      sawSamplePair = true;
      if (distanceBetween(dPos, targetPos) > DISPEL_MAX_RANGE_YARDS) continue;
      const los = zoneId ? hasLineOfSight(zoneId, dPos, targetPos) : null;
      if (los !== false) return true; // 射程内且视线未被证伪
    }
  }
  return sawSamplePair ? false : null;
}

/** 价值门 d 的续控回看窗口(秒):漏解窗结束后这么久内目标又吃同 DR 类控制
 * 才算「驱散会换来续控」的实证(观测到的链,不是推测)。语料:22.6% 的
 * 候选命中(龙息 46.7%)。 */
export const DR_CHAIN_LOOKAHEAD_S = 10;

/**
 * 价值门 d:目标在 applyTs 时该 CC 的 DR 类**全新鲜**(getDRLevelAtTime
 * 单源,链级数学不另写一份),且窗口结束后 DR_CHAIN_LOOKAHEAD_S 内又被
 * 敌方施加同类控制。两个条件都满足 → 驱散该窗可能换来满时长续控,教练
 * 应谨慎建议而非责难。
 */
function computeDrChainRisk(
  target: ICombatUnit,
  ccSpellId: string,
  applyTs: number,
  windowEndTs: number,
  enemyIds: Set<string>,
  matchStartMs: number,
): boolean {
  const category = getDRCategory(ccSpellId);
  if (!category) return false;

  // 实例史单源:buildCcCategoryHistory(drAnalysis)—— 与 ccBreakAnalysis 的
  // 剩余时长折算共用同一份配对逻辑,各写一份就是漂移温床。
  const instances = buildCcCategoryHistory(
    target,
    category,
    enemyIds,
    matchStartMs,
  );
  const level = getDRLevelAtTime(
    instances,
    category,
    (applyTs - matchStartMs) / 1000,
  );
  if (level !== "Full") return false;

  // 续控实证:窗口结束后 lookahead 内敌方又对目标施加同类 CC(看 apply
  // 事件本身,不要求后续配对成功)。
  return target.auraEvents.some(
    (aura) =>
      aura.spellId !== null &&
      enemyIds.has(aura.srcUnitId) &&
      aura.logLine.event === LogEvent.SPELL_AURA_APPLIED &&
      getDRCategory(aura.spellId) === category &&
      aura.timestamp > windowEndTs &&
      aura.timestamp <= windowEndTs + DR_CHAIN_LOOKAHEAD_S * 1000,
  );
}

export function getFatalDeath(
  unit: ICombatUnit,
  dispelTimestamp: number,
): { name: string; spec: string } | null {
  const fatalDeath = (unit.deathRecords ?? []).find(
    (d) =>
      d.timestamp >= dispelTimestamp && d.timestamp <= dispelTimestamp + 4000,
  );
  if (fatalDeath) {
    return { name: unit.name, spec: specToString(unit.spec) };
  }
  return null;
}

/**
 * Checks if a specific CC/debuff removal was due to a friendly dispel.
 *
 * NOTE: Short CC that is neither dispelled nor broken by damage counts as nothing.
 * Previously, any short CC was misclassified as a cleanse.
 */
export function wasRemovedByAllyDispel(
  allyCleanse: IDispelEvent[],
  spellId: string,
  targetName: string,
  removalSeconds: number,
): boolean {
  // B11: the original < 0.5s proximity window was too loose (mismatched distinct events).
  // SPELL_DISPEL and SPELL_AURA_REMOVED usually share the same millisecond, but ~5% of real
  // pairs have a 1ms skew, so a strict equality (< 0.001) false-flags those as missed cleanses.
  // A 50ms window tolerates log skew while still being far tighter than a distinct re-cast.
  // Match is further constrained by removedSpellId + targetName, so cross-debuff collisions
  // within 50ms are not a concern.
  const MATCH_TOLERANCE_SECONDS = 0.05;
  return allyCleanse.some(
    (d) =>
      d.removedSpellId === spellId &&
      d.targetName === targetName &&
      Math.abs(d.timeSeconds - removalSeconds) <= MATCH_TOLERANCE_SECONDS,
  );
}

/**
 * [UNCLEANSED DEBUFF] timeline 行的豁免语境后缀。cleanseWasOnCD 此前只渲染进
 * DISPEL SUMMARY 的 worst 一条;findings 模型主要读 timeline,看到的是一条
 * 无豁免语境的「漏解」,仍会口头甩锅。
 * (「所有驱散者全程被控」的窗口在源头就被跳过,不会走到这里 —— 无需注解。)
 */
export function formatMissedCleanseExemption(
  w: Pick<
    IMissedCleanseWindow,
    | "cleanseWasOnCD"
    | "cdBurnedOn"
    | "dispellersLockedOut"
    | "losReachable"
    | "drChainRisk"
  >,
): string {
  let out = "";
  if (w.cleanseWasOnCD) {
    const burned = w.cdBurnedOn
      ? ` (used on ${w.cdBurnedOn.spellName} ${w.cdBurnedOn.secondsBefore.toFixed(1)}s before)`
      : "";
    out += ` | cleanse was ON CD${burned}`;
  }
  // 可行性门(2026-08-02):不可行的窗口仍渲染(事实层不隐瞒),但带明确
  // 豁免语境,模型不再把不可行的驱散当失误口头甩锅。
  if (w.dispellersLockedOut)
    out +=
      " | dispellers were CC'd/locked out for most of this — not actionable";
  if (w.losReachable === false)
    out += " | no dispeller had range/line of sight — not actionable";
  if (w.drChainRisk)
    out +=
      " | target's DR was fresh and the enemy re-CC'd right after — a dispel here likely trades into a full-duration chain; advise cautiously, not as a mistake";
  return out;
}

/** [MISSED PURGE OPPORTUNITY] 行的可行性豁免后缀(cleanse 侧同款待遇)。 */
export function formatMissedPurgeExemption(
  w: Pick<IMissedPurgeWindow, "purgersLockedOut" | "losReachable">,
): string {
  let out = "";
  if (w.purgersLockedOut)
    out += " | purgers were CC'd/locked out — not actionable";
  if (w.losReachable === false)
    out += " | no purger had range/line of sight — not actionable";
  return out;
}

export function reconstructDispelSummary(
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  // zoneId 供可行性门 a 查场地几何(LoS);不传 → LoS 门只按射程判(三态)。
  combat: { startTime: number; endTime: number; zoneId?: string },
  // B45: friendly pet/guardian units whose dispels should be attributed to their owner player
  friendlyPets: ICombatUnit[] = [],
  // 覆盖尾巴修复:敌方宠物(魔狱犬 Devour Magic 等)的驱散此前不进任何桶,
  // hostilePurges 对宠物 purge 失明 —— 与 friendlyPets 对称补全。
  enemyPets: ICombatUnit[] = [],
): IDispelSummary {
  const friendlyIds = new Set(friends.map((u) => u.id));
  const enemyIds = new Set(enemies.map((u) => u.id));
  // B45: pets are also considered friendly sources; owner lookup is via ownerId
  const friendlyPetIds = new Set(friendlyPets.map((u) => u.id));
  const enemyPetIds = new Set(enemyPets.map((u) => u.id));
  const friendlyPlayerById = new Map(friends.map((u) => [u.id, u]));
  const enemyPlayerById = new Map(enemies.map((u) => [u.id, u]));
  const teamDispelTypes = buildTeamDispelTypes(friends);
  const teamDispelCapability = buildTeamDispelCapability(friends);
  const unitMap = new Map<string, ICombatUnit>(
    [...friends, ...enemies, ...friendlyPets, ...enemyPets].map((u) => [
      u.id,
      u,
    ]),
  );

  const allyCleanse: IDispelEvent[] = [];
  const ourPurges: IDispelEvent[] = [];
  const hostilePurges: IDispelEvent[] = [];

  for (const unit of [...friends, ...friendlyPets, ...enemies, ...enemyPets]) {
    const isPetUnit = friendlyPetIds.has(unit.id) || enemyPetIds.has(unit.id);
    // For pet units, attribute the dispel to the owner player (if known)
    const ownerPlayer = friendlyPetIds.has(unit.id)
      ? friendlyPlayerById.get(unit.ownerId)
      : enemyPetIds.has(unit.id)
        ? enemyPlayerById.get(unit.ownerId)
        : undefined;

    for (const action of unit.actionOut) {
      const isDispel = action.logLine.event === LogEvent.SPELL_DISPEL;
      const isSteal = action.logLine.event === LogEvent.SPELL_STOLEN;
      if (!isDispel && !isSteal) continue;
      // 旧 parser 中 CombatExtraSpellAction 为类;compat 以字段存在性表达同一判定
      if (action.extraSpellId === undefined) continue;

      const removedSpellId = action.extraSpellId;
      if (!removedSpellId) continue;

      const priority = getPriority(removedSpellId);
      const destUnit = unitMap.get(action.destUnitId);
      const penaltyDesc = DISPEL_PENALTY_SPELLS.get(removedSpellId);

      // B45: pet dispels are attributed to the owner player; source name shows the player
      // so Claude sees "[CLEANSE] Warlock dispelled X (pet)" rather than "[CLEANSE] Imp dispelled X"
      const sourceName = ownerPlayer ? ownerPlayer.name : unit.name;
      const sourceSpec = ownerPlayer
        ? specToString(ownerPlayer.spec)
        : specToString(unit.spec);

      const event: IDispelEvent = {
        timeSeconds: (action.timestamp - combat.startTime) / 1000,
        dispelSpellId: action.spellId ?? "",
        dispelSpellName: getEnglishSpellName(
          action.spellId ?? "",
          action.spellName,
        ),
        removedSpellId,
        removedSpellName: getEnglishSpellName(
          removedSpellId,
          action.extraSpellName,
        ),
        sourceName,
        sourceSpec,
        targetName: action.destUnitName,
        targetSpec: destUnit ? specToString(destUnit.spec) : "Unknown",
        priority,
        hasDispelPenalty: penaltyDesc !== undefined,
        penaltyDescription: penaltyDesc,
        isSpellSteal: isSteal,
        // B45: pet unit actions are always pet dispels; player actions only when srcUnit ≠ player
        isPetDispel: isPetUnit || action.srcUnitId !== unit.id,
        wasFatal: false,
      };

      // Treat a pet owned by a friendly player as a friendly source
      // Pets passed via friendlyPets are always friendly — we already filtered them by reaction
      const srcFriendly =
        friendlyIds.has(unit.id) || friendlyPetIds.has(unit.id);
      const srcEnemy = enemyIds.has(unit.id) || enemyPetIds.has(unit.id);
      const destFriendly = friendlyIds.has(action.destUnitId);
      const destEnemy = enemyIds.has(action.destUnitId);

      const targetUnitForPenalty = ownerPlayer ?? unit;

      if (penaltyDesc !== undefined) {
        if (DISPEL_FEATURE_FLAGS.F18_FATAL_DISPEL) {
          const fatalDeath = getFatalDeath(
            targetUnitForPenalty,
            action.timestamp,
          );
          if (fatalDeath) {
            event.wasFatal = true;
            event.fatalUnitName = fatalDeath.name;
            event.fatalUnitSpec = fatalDeath.spec;
          }
        }

        if (DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS) {
          const backlashInfo = BACKLASH_CC_SPELL_IDS.get(removedSpellId);
          if (backlashInfo) {
            const match = (targetUnitForPenalty.auraEvents ?? []).find(
              (aura) =>
                aura.logLine.event === LogEvent.SPELL_AURA_APPLIED &&
                aura.spellId === backlashInfo.backlashSpellId &&
                aura.timestamp >= action.timestamp &&
                aura.timestamp <= action.timestamp + 100,
            );
            if (match) {
              event.backlashCcSpellId = match.spellId ?? undefined;
            }
          }
        }
      }

      if (srcFriendly && destFriendly) {
        // We cleansed a debuff off our ally
        if (penaltyDesc !== undefined) {
          // Measure backlash: damage to the dispeller in the window before and after
          const ts = action.timestamp;
          event.penaltyDamageTaken = targetUnitForPenalty.damageIn
            .filter(
              (d) =>
                d.logLine.timestamp >= ts &&
                d.logLine.timestamp <= ts + PENALTY_WINDOW_MS,
            )
            .reduce((sum, d) => sum + Math.abs(d.effectiveAmount), 0);
          event.penaltyDamageBaseline = targetUnitForPenalty.damageIn
            .filter(
              (d) =>
                d.logLine.timestamp >= ts - PENALTY_WINDOW_MS &&
                d.logLine.timestamp < ts,
            )
            .reduce((sum, d) => sum + Math.abs(d.effectiveAmount), 0);
        }
        allyCleanse.push(event);
      } else if (srcFriendly && destEnemy) {
        // We purged / spell-stole a buff off an enemy
        ourPurges.push(event);
      } else if (srcEnemy && destFriendly) {
        // Enemy stripped a buff off us
        hostilePurges.push(event);
      }
    }
  }

  allyCleanse.sort((a, b) => a.timeSeconds - b.timeSeconds);
  ourPurges.sort((a, b) => a.timeSeconds - b.timeSeconds);
  hostilePurges.sort((a, b) => a.timeSeconds - b.timeSeconds);

  // Missed cleanse detection: Critical/High CC on friendly by enemy lasting > threshold without dispel.
  // SPELL_AURA_BROKEN_SPELL = broke from incoming damage (not a missed cleanse, the CC ended by other means).
  const missedCleanseWindows: IMissedCleanseWindow[] = [];

  // Efficiency tracking: per friendly unit, count CC windows and cleansed/missed
  const efficiencyMap = new Map<
    string,
    {
      targetName: string;
      targetSpec: string;
      totalCCWindows: number;
      cleanseCount: number;
      missedCount: number;
      brokenCount: number;
    }
  >();

  for (const unit of friends) {
    const appliedTimes = new Map<string, { ts: number; spellName: string }[]>();
    const removedTimes = new Map<
      string,
      { ts: number; brokenByDamage: boolean }[]
    >();

    for (const aura of unit.auraEvents) {
      const spellId = aura.spellId;
      if (!spellId) continue;

      // Only CC applied by enemies
      if (!enemyIds.has(aura.srcUnitId)) continue;

      // B11 fix: skip BUFF auras. When a friendly Mage spellsteals an enemy buff (e.g.
      // Blessing of Freedom 1044), the resulting SPELL_AURA_APPLIED on the Mage carries
      // the original enemy as srcUnit — but the aura is a BUFF on our side, not a debuff
      // the healer should cleanse. Without this filter the loop fabricates a missed
      // cleanse window for every spellsteal.
      const auraType = getAuraType(aura);
      if (auraType !== null && auraType !== "DEBUFF") continue;

      const priority = getPriority(spellId);
      if (priority !== "Critical" && priority !== "High") continue;

      // 反噬豁免必须是谓词,不能靠数据缺口兜底:驱散 UA/VT 会沉默+反伤驱散者,
      // 不驱散是正确操作,永远不算漏解。此前 316099/342938/34914 恰好在
      // spellEffectData 里没有条目才没误报 —— 数据一刷新就会炸。
      if (DISPEL_PENALTY_SPELLS.has(spellId)) continue;

      // Skip spells that cannot be dispelled (DispelType=None in game data)
      const dispelType = getDispelType(spellId);
      if (!dispelType) continue;

      // Only flag if the team has someone capable of removing this debuff type
      if (!teamDispelTypes.has(dispelType)) continue;

      if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
        const bucket = appliedTimes.get(spellId) ?? [];
        appliedTimes.set(spellId, [
          ...bucket,
          {
            ts: aura.timestamp,
            spellName: getEnglishSpellName(spellId, aura.spellName),
          },
        ]);
      } else if (
        aura.logLine.event === LogEvent.SPELL_AURA_REMOVED ||
        aura.logLine.event === LogEvent.SPELL_AURA_BROKEN ||
        aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
      ) {
        const brokenByDamage =
          aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL;
        const bucket = removedTimes.get(spellId) ?? [];
        removedTimes.set(spellId, [
          ...bucket,
          { ts: aura.timestamp, brokenByDamage },
        ]);
      }
    }

    // Ensure efficiency entry exists for this unit
    const effKey = unit.id;
    if (!efficiencyMap.has(effKey)) {
      efficiencyMap.set(effKey, {
        targetName: unit.name,
        targetSpec: specToString(unit.spec),
        totalCCWindows: 0,
        cleanseCount: 0,
        missedCount: 0,
        brokenCount: 0,
      });
    }
    const eff = efficiencyMap.get(effKey);
    if (!eff) continue;

    for (const [spellId, applications] of appliedTimes) {
      const priority = getPriority(spellId);
      const removals = removedTimes.get(spellId) ?? [];

      for (const { ts: applyTs, spellName } of applications) {
        const removal = removals.find((r) => r.ts >= applyTs);
        if (!removal) continue;

        const durationSeconds = (removal.ts - applyTs) / 1000;

        // Was removed by a friendly dispel near that removal time?
        const removedByDispel = wasRemovedByAllyDispel(
          allyCleanse,
          spellId,
          unit.name,
          (removal.ts - combat.startTime) / 1000,
        );

        // CC broke from incoming damage — not a missed cleanse, but not a healer cleanse either
        if (removal.brokenByDamage) {
          eff.totalCCWindows++;
          eff.brokenCount++;
          continue;
        }

        if (removedByDispel) {
          eff.totalCCWindows++;
          eff.cleanseCount++;
          continue;
        }

        // Only count as a window (missed opportunity) if it lasted long enough for a human to react
        if (durationSeconds >= MISSED_CLEANSE_THRESHOLD_S) {
          eff.totalCCWindows++;

          // dispelType is non-null here (null case is filtered above)
          const windowDispelType = getDispelType(spellId) as DispelType;

          // Skip if every capable dispeller was themselves CC'd for the entire window —
          // you can't dispel while hard-CC'd.
          const capableDispellers =
            teamDispelCapability.get(windowDispelType) ?? [];
          const allDispellersBlocked =
            capableDispellers.length > 0 &&
            capableDispellers.every((dispeller) =>
              isPurgerFullyBlockedDuringWindow(
                dispeller,
                applyTs,
                removal.ts,
                enemyIds,
              ),
            );
          if (allDispellersBlocked) {
            // Not a missed opportunity — no one could act
            continue;
          }

          eff.missedCount++;

          // Measure post-CC pressure: damage taken in first POST_CC_PRESSURE_WINDOW_S seconds
          const windowEndMs = applyTs + POST_CC_PRESSURE_WINDOW_S * 1000;
          const postCcDamage = unit.damageIn
            .filter(
              (d) =>
                d.logLine.timestamp >= applyTs &&
                d.logLine.timestamp <= windowEndMs,
            )
            .reduce((sum, d) => sum + Math.abs(d.effectiveAmount), 0);

          let cleanseWasOnCD = false;
          let cdBurnedOn:
            | {
                spellName: string;
                priority: DispelPriority;
                secondsBefore: number;
              }
            | undefined;

          if (capableDispellers.length > 0) {
            const activeDispellers = capableDispellers.filter(
              (d) =>
                !isPurgerFullyBlockedDuringWindow(
                  d,
                  applyTs,
                  removal.ts,
                  enemyIds,
                ),
            );

            const activeDispellerNames = new Set(
              activeDispellers.map((u) => u.name),
            );
            const applyRelative = (applyTs - combat.startTime) / 1000;
            // Look back dynamically based on the spell ID of each dispel event
            const recentCleanses = allyCleanse.filter((c) => {
              if (!activeDispellerNames.has(c.sourceName)) return false;
              if (c.timeSeconds >= applyRelative) return false;
              const cd = DISPEL_FEATURE_FLAGS.F131_F132_CLEANSE_COOLDOWNS
                ? (DISPEL_COOLDOWNS_BY_SPELL.get(c.dispelSpellId) ?? 8)
                : 8;
              if (cd === 0) return false;
              return c.timeSeconds + cd > applyRelative;
            });

            const dispellersWhoUsedCD = new Set(
              recentCleanses.map((c) => c.sourceName),
            );

            // If every active dispeller who wasn't CC'd had used their cleanse recently...
            if (
              activeDispellers.length > 0 &&
              activeDispellers.every((d) => dispellersWhoUsedCD.has(d.name))
            ) {
              cleanseWasOnCD = true;
              const lastCleanse = recentCleanses[recentCleanses.length - 1]; // allyCleanse is sorted by timeSeconds
              cdBurnedOn = {
                spellName: lastCleanse.removedSpellName,
                priority: lastCleanse.priority,
                secondsBefore: applyRelative - lastCleanse.timeSeconds,
              };
            }
          }

          missedCleanseWindows.push({
            timeSeconds: (applyTs - combat.startTime) / 1000,
            durationSeconds,
            targetName: unit.name,
            targetSpec: specToString(unit.spec),
            spellName,
            spellId,
            priority,
            dispelType: windowDispelType,
            postCcDamage,
            cleanseWasOnCD,
            cdBurnedOn,
            // 可行性/价值门(2026-08-02 用户拍板;语料 150 场实证联合拦
            // ~24% 责难候选):
            dispellersLockedOut: dispellersLockedOutForWindow(
              capableDispellers,
              applyTs,
              removal.ts,
              enemyIds,
              MISSED_CLEANSE_THRESHOLD_S * 1000,
            ),
            losReachable: anyDispellerReachable(
              capableDispellers,
              unit,
              applyTs,
              MISSED_CLEANSE_THRESHOLD_S * 1000,
              combat.zoneId,
            ),
            drChainRisk: computeDrChainRisk(
              unit,
              spellId,
              applyTs,
              removal.ts,
              enemyIds,
              combat.startTime,
            ),
          });
        }
      }
    }
  }

  missedCleanseWindows.sort((a, b) => a.timeSeconds - b.timeSeconds);

  // Missed offensive purge detection: Critical/High magic buffs on enemies that sat >threshold
  // without being purged, when our team had the capability to purge.
  const missedPurgeWindows: IMissedPurgeWindow[] = [];
  const friendlyPurgers = friends.filter((f) => canOffensivePurge(f));

  if (friendlyPurgers.length > 0) {
    for (const enemy of enemies) {
      const appliedTimes = new Map<
        string,
        { ts: number; spellName: string }[]
      >();
      const removedTimes = new Map<string, number[]>();

      for (const aura of enemy.auraEvents) {
        const spellId = aura.spellId;
        if (!spellId) continue;
        // Only consider buffs applied by the enemy's own side — skip debuffs our team placed on them
        if (!enemyIds.has(aura.srcUnitId)) continue;
        // Symmetric to the cleanse fix: only treat actual buffs on enemies as purge targets.
        // A debuff briefly hitting an enemy with an enemy as srcUnit (reflects, cross-team
        // weirdness) is not something our offensive purge should handle.
        const auraType = getAuraType(aura);
        if (auraType !== null && auraType !== "BUFF") continue;
        if (getDispelType(spellId) !== "Magic") continue;
        if (PURGE_BLOCKLIST.has(spellId)) continue;
        const priority = getPriority(spellId);
        if (priority !== "Critical" && priority !== "High") continue;

        if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
          const bucket = appliedTimes.get(spellId) ?? [];
          appliedTimes.set(spellId, [
            ...bucket,
            {
              ts: aura.timestamp,
              spellName: getEnglishSpellName(spellId, aura.spellName),
            },
          ]);
        } else if (
          aura.logLine.event === LogEvent.SPELL_AURA_REMOVED ||
          aura.logLine.event === LogEvent.SPELL_AURA_BROKEN ||
          aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
        ) {
          const bucket = removedTimes.get(spellId) ?? [];
          removedTimes.set(spellId, [...bucket, aura.timestamp]);
        }
      }

      for (const [spellId, applications] of appliedTimes) {
        const priority = getPriority(spellId);
        const removals = removedTimes.get(spellId) ?? [];

        for (const { ts: applyTs, spellName } of applications) {
          const removalTs = removals.find((r) => r >= applyTs);
          const durationSeconds =
            ((removalTs ?? combat.endTime) - applyTs) / 1000;

          if (durationSeconds < MISSED_PURGE_THRESHOLD_S) continue;

          // Was it actually purged by our team within this window?
          const applyRelative = (applyTs - combat.startTime) / 1000;
          const purgedByUs = ourPurges.some(
            (p) =>
              p.removedSpellId === spellId &&
              p.targetName === enemy.name &&
              p.timeSeconds >= applyRelative &&
              p.timeSeconds <= applyRelative + durationSeconds,
          );

          if (!purgedByUs) {
            // Only flag if at least one purger was free during the window AND
            // the priority meets the bar for that purger's spec (CD-gated purgers
            // only get flagged for Critical misses — they can't spam purge every GCD).
            const windowEndMs = removalTs ?? combat.endTime;
            const eligiblePurgers = friendlyPurgers.filter(
              (p) => priority === "Critical" || !CD_GATED_PURGERS.has(p.spec),
            );
            const allPurgersBlocked =
              eligiblePurgers.length === 0 ||
              eligiblePurgers.every((purger) =>
                isPurgerFullyBlockedDuringWindow(
                  purger,
                  applyTs,
                  windowEndMs,
                  enemyIds,
                ),
              );
            if (!allPurgersBlocked) {
              // Expected buff duration from spell data
              const expectedBuffDurationSeconds =
                spellEffectData[spellId]?.durationSeconds;

              // Purge CD state: look back at ourPurges for each eligible purger.
              // Only meaningful for CD-gated purgers (Evoker 10s, DH/Warlock/Priest 8s).
              // Free-purge specs (Shaman, Mage) never have their CD "burned" — skip them.
              const cdGatedEligible = eligiblePurgers.filter((p) =>
                CD_GATED_PURGERS.has(p.spec),
              );
              let purgeWasOnCD = false;
              let cdBurnedOn:
                | {
                    spellName: string;
                    priority: DispelPriority;
                    secondsBefore: number;
                  }
                | undefined;
              if (
                cdGatedEligible.length > 0 &&
                eligiblePurgers.every((p) => CD_GATED_PURGERS.has(p.spec))
              ) {
                // Only meaningful when ALL eligible purgers are CD-gated
                const purgeCD = 8; // seconds — conservative; Evoker is 10s
                const recentPurges = ourPurges.filter(
                  (p) =>
                    cdGatedEligible.some((pu) => pu.name === p.sourceName) &&
                    p.timeSeconds < applyRelative &&
                    p.timeSeconds >= applyRelative - purgeCD,
                );
                const purgersWhoUsedCD = new Set(
                  recentPurges.map((p) => p.sourceName),
                );
                if (
                  cdGatedEligible.every((p) => purgersWhoUsedCD.has(p.name))
                ) {
                  purgeWasOnCD = true;
                  const lastPurge = recentPurges[recentPurges.length - 1];
                  cdBurnedOn = {
                    spellName: lastPurge.removedSpellName,
                    priority: lastPurge.priority,
                    secondsBefore: applyRelative - lastPurge.timeSeconds,
                  };
                }
              }

              // Healing pressure: was the friendly team taking significant damage at the moment of application?
              // We check a strict burst window (3s) instead of the entire unpurged duration so we don't falsely
              // excuse missed purges during long, unpressured periods.
              const pressureWindowEndMs = Math.min(
                applyTs + POST_CC_PRESSURE_WINDOW_S * 1000,
                removalTs ?? combat.endTime,
              );
              const teamUnderPressure = friends.some((f) => {
                const threshold = getPressureThreshold(f);
                const dmg = f.damageIn
                  .filter(
                    (d) =>
                      d.logLine.timestamp >= applyTs &&
                      d.logLine.timestamp <= pressureWindowEndMs,
                  )
                  .reduce((sum, d) => sum + Math.abs(d.effectiveAmount), 0);
                return dmg >= threshold;
              });

              missedPurgeWindows.push({
                timeSeconds: applyRelative,
                durationSeconds,
                expectedBuffDurationSeconds,
                enemyName: enemy.name,
                enemySpec: specToString(enemy.spec),
                spellName,
                spellId,
                priority,
                purgeWasOnCD,
                cdBurnedOn,
                teamUnderPressure,
                purgersLockedOut: dispellersLockedOutForWindow(
                  eligiblePurgers,
                  applyTs,
                  windowEndMs,
                  enemyIds,
                  MISSED_PURGE_THRESHOLD_S * 1000,
                ),
                losReachable: anyDispellerReachable(
                  eligiblePurgers,
                  enemy,
                  applyTs,
                  MISSED_PURGE_THRESHOLD_S * 1000,
                  combat.zoneId,
                ),
              });
            }
          }
        }
      }
    }

    missedPurgeWindows.sort((a, b) => a.timeSeconds - b.timeSeconds);
  }

  const ccEfficiency: ICCEfficiencyStat[] = [...efficiencyMap.values()]
    .filter((e) => e.totalCCWindows > 0)
    .map((e) => {
      const dispelableWindows = e.cleanseCount + e.missedCount;
      return {
        ...e,
        // Rate only counts windows where dispel was possible (excludes broken-by-damage)
        cleanseRate:
          dispelableWindows > 0 ? e.cleanseCount / dispelableWindows : 1,
      };
    })
    .sort((a, b) => b.totalCCWindows - a.totalCCWindows);

  return {
    allyCleanse,
    ourPurges,
    hostilePurges,
    missedCleanseWindows,
    ccEfficiency,
    missedPurgeWindows,
  };
}

/**
 * 敌方队内解逐条(2026-07-18 baseline 排查):对面奶把你的 CC/dot 从他们队友
 * 身上解掉——此前整类事件不渲染(42/176 场漏 Purify),教练关键信息
 * ("你的 Hex 秒被解")+ 覆盖门 sufficiency 主要缺口。上限 8 条,超出折叠。
 */
export function formatEnemyDispelsForContext(
  enemySummary: IDispelSummary,
): string[] {
  const evs = enemySummary.allyCleanse;
  if (evs.length === 0) return [];
  const lines: string[] = [
    "ENEMY DISPELS (their team cleansing your CC/dots off themselves):",
  ];
  const shown = evs.slice(0, 8);
  for (const e of shown) {
    lines.push(
      `  ${fmtTime(e.timeSeconds)}  ${e.sourceSpec} ${e.dispelSpellName} removed ${e.removedSpellName} from ${e.targetSpec}`,
    );
  }
  if (evs.length > shown.length) {
    lines.push(`  [+${evs.length - shown.length} more enemy dispels folded]`);
  }
  return lines;
}

export function formatDispelContextForAI(summary: IDispelSummary): string[] {
  const lines: string[] = [];
  const { missedCleanseWindows, ccEfficiency, missedPurgeWindows } = summary;

  lines.push("DISPEL SUMMARY:");

  // Cleanse summary
  const totalCCWindows = ccEfficiency.reduce((s, e) => s + e.totalCCWindows, 0);
  const totalMissed = ccEfficiency.reduce((s, e) => s + e.missedCount, 0);
  const totalCleansed = ccEfficiency.reduce((s, e) => s + e.cleanseCount, 0);
  const totalBroken = ccEfficiency.reduce((s, e) => s + e.brokenCount, 0);

  if (totalCCWindows === 0) {
    lines.push("  No significant CC applied to your team.");
  } else {
    const brokenStr =
      totalBroken > 0 ? `, ${totalBroken} broken by damage` : "";
    lines.push(
      `  CC windows on your team: ${totalCCWindows} total — ${totalMissed} missed, ${totalCleansed} cleansed${brokenStr}`,
    );

    // Worst missed cleanse
    const significantMissed = missedCleanseWindows.filter(
      (w) =>
        w.priority === "Critical" ||
        (w.priority === "High" &&
          (w.durationSeconds > 5 || w.postCcDamage > 50_000)),
    );
    if (significantMissed.length > 0) {
      const worst = [...significantMissed].sort(
        (a, b) => b.durationSeconds - a.durationSeconds,
      )[0];
      const dmgStr =
        worst.postCcDamage > 0
          ? `, ${Math.round(worst.postCcDamage / 1000)}k dmg taken`
          : "";
      lines.push(
        `  Worst missed cleanse: ${worst.spellName} [${worst.priority}] on ${worst.targetSpec} at ${fmtTime(worst.timeSeconds)} (${Math.round(worst.durationSeconds)}s${dmgStr})`,
      );
      if (
        DISPEL_FEATURE_FLAGS.F131_F132_CLEANSE_COOLDOWNS &&
        worst.cleanseWasOnCD &&
        worst.cdBurnedOn
      ) {
        lines.push(
          `    - Note: Cleanse was on cooldown (burned on ${worst.cdBurnedOn.spellName} [${worst.cdBurnedOn.priority} priority] ${worst.cdBurnedOn.secondsBefore.toFixed(1)}s before)`,
        );
      }
      const highDamageMisses = significantMissed.filter(
        (w) => w.postCcDamage > 100_000,
      );
      if (highDamageMisses.length > 0) {
        lines.push(
          `  High-damage missed cleanses: ${highDamageMisses.length} with >100k dmg taken during CC`,
        );
      }
    }
  }

  // Purge summary
  // NOTE: kept as the original Critical/High-only filter (pre-duringKillWindow escalation) so the
  // "worst" pick and its rendered line stay byte-identical to the pre-existing behavior for all
  // inputs — including in-window duration ties/wins that would otherwise silently swap which item
  // is reported as worst (e.g. a High 5s not-in-window miss vs. a Medium 20s in-window miss).
  const significantMissedPurges = missedPurgeWindows.filter(
    (w) => w.priority === "Critical" || w.priority === "High",
  );
  if (significantMissedPurges.length === 0) {
    lines.push("  Missed purge windows: None (Critical/High)");
  } else {
    const worst = [...significantMissedPurges].sort(
      (a, b) => b.durationSeconds - a.durationSeconds,
    )[0];
    const pressureStr = worst.teamUnderPressure ? " during pressure" : "";
    lines.push(
      `  Missed purge windows: ${significantMissedPurges.length} — worst: ${worst.spellName} on ${worst.enemySpec} (${Math.round(worst.durationSeconds)}s unpurged${pressureStr})`,
    );
  }

  // Kill-window misses are always surfaced, regardless of priority (a friendly kill can be blown by
  // a Medium-priority buff just as easily as a Critical one) — rendered as dedicated lines rather
  // than folded into the "worst" pick above so they can never be hidden by a longer non-window miss.
  const killWindowMisses = missedPurgeWindows.filter(
    (w) => w.duringKillWindow === true,
  );
  for (const miss of killWindowMisses) {
    lines.push(
      // 时刻用 fmtTime,与 prompt 里其它所有时间戳一致 —— 此前渲染成裸秒
      // ("at 94s"),既与全文记号不符,也容易被读成时长而非绝对时刻。
      `  MISSED PURGE DURING FRIENDLY KILL WINDOW: ${miss.spellName} on ${miss.enemySpec} (${miss.enemyName}) at ${fmtTime(miss.timeSeconds)} (${Math.round(miss.durationSeconds)}s unpurged, priority ${miss.priority})`,
    );
  }

  return lines;
}
