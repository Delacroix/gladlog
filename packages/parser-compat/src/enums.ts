/**
 * Combat-log related enums.
 *
 * Provenance discipline (see docs/DATA-COMPLIANCE.md): this file used to be
 * copied wholesale from wowarenalogs' packages/parser/src/types.ts, a repo
 * under CC BY-NC-ND 4.0, which is incompatible with this repo's MIT license.
 * Every enum is now anchored to a public Blizzard fact of its own:
 *
 * - CombatUnitSpec / CombatUnitClass: generated from DB2, see
 *   ./enumsGenerated.ts.
 * - LogEvent: the values ARE the event names that appear verbatim in the log
 *   file — dictated by the log format, no room for invention.
 * - CombatUnitPowerType: member names and values from Blizzard's client API
 *   `Enum.PowerType`.
 * - Unit flag masks: Blizzard's public COMBATLOG_OBJECT_* constants.
 * - CombatUnitType / CombatUnitReaction / CombatResult: small enums internal to
 *   this repo; their values are used in-process only (never persisted, never
 *   compared across versions).
 */

export { CombatUnitClass, CombatUnitSpec } from "./enumsGenerated";

/**
 * Combat-log event names. Value and member name are literally identical —
 * these strings ARE the event tokens at the start of each log line, and the
 * parser dispatches on them. Grouped in the order: match boundaries → casts →
 * auras → damage → healing/resources → deaths → support (the _SUPPORT variants
 * introduced in 11.0).
 */
export enum LogEvent {
  // Match and zone boundaries
  ZONE_CHANGE = "ZONE_CHANGE",
  ARENA_MATCH_START = "ARENA_MATCH_START",
  ARENA_MATCH_END = "ARENA_MATCH_END",
  COMBATANT_INFO = "COMBATANT_INFO",

  // Casts
  SPELL_CAST_START = "SPELL_CAST_START",
  SPELL_CAST_SUCCESS = "SPELL_CAST_SUCCESS",
  SPELL_CAST_FAILED = "SPELL_CAST_FAILED",
  SPELL_SUMMON = "SPELL_SUMMON",
  SPELL_EXTRA_ATTACKS = "SPELL_EXTRA_ATTACKS",

  // Auras, interrupts and dispels
  SPELL_AURA_APPLIED = "SPELL_AURA_APPLIED",
  SPELL_AURA_APPLIED_DOSE = "SPELL_AURA_APPLIED_DOSE",
  SPELL_AURA_REFRESH = "SPELL_AURA_REFRESH",
  SPELL_AURA_REMOVED = "SPELL_AURA_REMOVED",
  SPELL_AURA_REMOVED_DOSE = "SPELL_AURA_REMOVED_DOSE",
  SPELL_AURA_BROKEN = "SPELL_AURA_BROKEN",
  SPELL_AURA_BROKEN_SPELL = "SPELL_AURA_BROKEN_SPELL",
  SPELL_INTERRUPT = "SPELL_INTERRUPT",
  SPELL_DISPEL = "SPELL_DISPEL",
  SPELL_DISPEL_FAILED = "SPELL_DISPEL_FAILED",
  SPELL_STOLEN = "SPELL_STOLEN",

  // Damage and misses
  SWING_DAMAGE = "SWING_DAMAGE",
  SWING_DAMAGE_LANDED = "SWING_DAMAGE_LANDED",
  RANGE_DAMAGE = "RANGE_DAMAGE",
  SPELL_DAMAGE = "SPELL_DAMAGE",
  SPELL_PERIODIC_DAMAGE = "SPELL_PERIODIC_DAMAGE",
  ENVIRONMENTAL_DAMAGE = "ENVIRONMENTAL_DAMAGE",
  DAMAGE_SHIELD = "DAMAGE_SHIELD",
  DAMAGE_SPLIT = "DAMAGE_SPLIT",
  SPELL_ABSORBED = "SPELL_ABSORBED",
  SWING_MISSED = "SWING_MISSED",
  RANGE_MISSED = "RANGE_MISSED",
  SPELL_MISSED = "SPELL_MISSED",
  SPELL_PERIODIC_MISSED = "SPELL_PERIODIC_MISSED",
  DAMAGE_SHIELD_MISSED = "DAMAGE_SHIELD_MISSED",

  // Healing and resources
  SPELL_HEAL = "SPELL_HEAL",
  SPELL_PERIODIC_HEAL = "SPELL_PERIODIC_HEAL",
  SPELL_ENERGIZE = "SPELL_ENERGIZE",
  SPELL_PERIODIC_ENERGIZE = "SPELL_PERIODIC_ENERGIZE",
  SPELL_DRAIN = "SPELL_DRAIN",
  SPELL_PERIODIC_DRAIN = "SPELL_PERIODIC_DRAIN",
  SPELL_LEECH = "SPELL_LEECH",
  SPELL_PERIODIC_LEECH = "SPELL_PERIODIC_LEECH",

  // Deaths
  UNIT_DIED = "UNIT_DIED",
  PARTY_KILL = "PARTY_KILL",

  // Support variants (attribution for damage/healing dealt "through someone
  // else's hand", e.g. Chimaeral/Augmentation effects)
  SWING_DAMAGE_SUPPORT = "SWING_DAMAGE_SUPPORT",
  SWING_DAMAGE_LANDED_SUPPORT = "SWING_DAMAGE_LANDED_SUPPORT",
  RANGE_DAMAGE_SUPPORT = "RANGE_DAMAGE_SUPPORT",
  SPELL_DAMAGE_SUPPORT = "SPELL_DAMAGE_SUPPORT",
  SPELL_PERIODIC_DAMAGE_SUPPORT = "SPELL_PERIODIC_DAMAGE_SUPPORT",
  SPELL_HEAL_SUPPORT = "SPELL_HEAL_SUPPORT",
  SPELL_PERIODIC_HEAL_SUPPORT = "SPELL_PERIODIC_HEAL_SUPPORT",
}

/**
 * Power (resource) types. Member names and values come from Blizzard's client
 * API `Enum.PowerType` (Obsolete/Obsolete2/NumPowerTypes are Blizzard's own
 * member names, kept verbatim so the numbering has no holes that could be
 * misread as missing entries).
 */
export enum CombatUnitPowerType {
  HealthCost = -2,
  None = -1,
  Mana = 0,
  Rage = 1,
  Focus = 2,
  Energy = 3,
  ComboPoints = 4,
  Runes = 5,
  RunicPower = 6,
  SoulShards = 7,
  LunarPower = 8,
  HolyPower = 9,
  Alternate = 10,
  Maelstrom = 11,
  Chi = 12,
  Insanity = 13,
  Obsolete = 14,
  Obsolete2 = 15,
  ArcaneCharges = 16,
  Fury = 17,
  Pain = 18,
  NumPowerTypes = 19,
}

/** Unit allegiance. Values are used in-process only. */
export enum CombatUnitReaction {
  Neutral = 0,
  Friendly = 1,
  Hostile = 2,
}

/** Unit kind. Values are used in-process only; the order matches the test
 *  order of the flag masks below. */
export enum CombatUnitType {
  None = 0,
  Player = 1,
  NPC = 2,
  Pet = 3,
  Guardian = 4,
  Object = 5,
}

/** Match result (from the uploader's point of view). Values are used
 *  in-process only. */
export enum CombatResult {
  Unknown = 0,
  DrawGame = 1,
  Lose = 2,
  Win = 3,
}

// ── Unit flag decoding ───────────────────────────────────────────────────
// Masks come from Blizzard's public COMBATLOG_OBJECT_* constants (the bit
// fields in log fields 3 and 6).
const TYPE_PLAYER = 0x0400; // COMBATLOG_OBJECT_TYPE_PLAYER
const TYPE_NPC = 0x0800; // COMBATLOG_OBJECT_TYPE_NPC
const TYPE_PET = 0x1000; // COMBATLOG_OBJECT_TYPE_PET
const TYPE_GUARDIAN = 0x2000; // COMBATLOG_OBJECT_TYPE_GUARDIAN
const TYPE_OBJECT = 0x4000; // COMBATLOG_OBJECT_TYPE_OBJECT
const REACTION_FRIENDLY = 0x0010; // COMBATLOG_OBJECT_REACTION_FRIENDLY
const REACTION_HOSTILE = 0x0040; // COMBATLOG_OBJECT_REACTION_HOSTILE

/**
 * Flags → unit kind. Player is tested first, the rest in the order
 * pet → guardian → NPC → object — a pet also sets the NPC bit, so testing NPC
 * first would swallow every pet.
 */
export function getUnitType(flags: number): CombatUnitType {
  if (flags & TYPE_PLAYER) return CombatUnitType.Player;
  if (flags & TYPE_PET) return CombatUnitType.Pet;
  if (flags & TYPE_GUARDIAN) return CombatUnitType.Guardian;
  if (flags & TYPE_NPC) return CombatUnitType.NPC;
  if (flags & TYPE_OBJECT) return CombatUnitType.Object;
  return CombatUnitType.None;
}

/** Flags → allegiance. Neutral when neither bit is set. */
export function getUnitReaction(flags: number): CombatUnitReaction {
  if (flags & REACTION_FRIENDLY) return CombatUnitReaction.Friendly;
  if (flags & REACTION_HOSTILE) return CombatUnitReaction.Hostile;
  return CombatUnitReaction.Neutral;
}
