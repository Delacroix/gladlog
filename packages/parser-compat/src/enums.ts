/**
 * 战斗日志相关枚举。
 *
 * 出处纪律(见 docs/DATA-COMPLIANCE.md):本文件此前整体照搬自 wowarenalogs 的
 * packages/parser/src/types.ts,该仓为 CC BY-NC-ND 4.0,与本仓 MIT 不相容。
 * 现在每个枚举都各自锚定到暴雪的公开事实:
 *
 * - CombatUnitSpec / CombatUnitClass:从 DB2 生成,见 ./enumsGenerated.ts。
 * - LogEvent:值即日志文件里逐字出现的事件名,由日志格式决定,无表达空间。
 * - CombatUnitPowerType:暴雪客户端 API `Enum.PowerType` 的成员名与取值。
 * - 单位旗标掩码:暴雪公开的 COMBATLOG_OBJECT_* 常量。
 * - CombatUnitType / CombatUnitReaction / CombatResult:本仓内部小枚举,
 *   取值仅在进程内使用(不落盘、不跨版本比较)。
 */

export { CombatUnitClass, CombatUnitSpec } from "./enumsGenerated";

/**
 * 战斗日志事件名。值与名同字面 —— 因为这些字符串就是日志行首的事件记号,
 * 解析器按它分派。分组顺序按「对局边界 → 施法 → 光环 → 伤害 → 治疗/资源 →
 * 死亡 → 支援(11.0 起的 _SUPPORT 变体)」排列。
 */
export enum LogEvent {
  // 对局与区域边界
  ZONE_CHANGE = "ZONE_CHANGE",
  ARENA_MATCH_START = "ARENA_MATCH_START",
  ARENA_MATCH_END = "ARENA_MATCH_END",
  COMBATANT_INFO = "COMBATANT_INFO",

  // 施法
  SPELL_CAST_START = "SPELL_CAST_START",
  SPELL_CAST_SUCCESS = "SPELL_CAST_SUCCESS",
  SPELL_CAST_FAILED = "SPELL_CAST_FAILED",
  SPELL_SUMMON = "SPELL_SUMMON",
  SPELL_EXTRA_ATTACKS = "SPELL_EXTRA_ATTACKS",

  // 光环与打断/驱散
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

  // 伤害与未命中
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

  // 治疗与资源
  SPELL_HEAL = "SPELL_HEAL",
  SPELL_PERIODIC_HEAL = "SPELL_PERIODIC_HEAL",
  SPELL_ENERGIZE = "SPELL_ENERGIZE",
  SPELL_PERIODIC_ENERGIZE = "SPELL_PERIODIC_ENERGIZE",
  SPELL_DRAIN = "SPELL_DRAIN",
  SPELL_PERIODIC_DRAIN = "SPELL_PERIODIC_DRAIN",
  SPELL_LEECH = "SPELL_LEECH",
  SPELL_PERIODIC_LEECH = "SPELL_PERIODIC_LEECH",

  // 死亡
  UNIT_DIED = "UNIT_DIED",
  PARTY_KILL = "PARTY_KILL",

  // 支援变体(奇美拉/增辉等「借他人之手」的伤害治疗归属)
  SWING_DAMAGE_SUPPORT = "SWING_DAMAGE_SUPPORT",
  SWING_DAMAGE_LANDED_SUPPORT = "SWING_DAMAGE_LANDED_SUPPORT",
  RANGE_DAMAGE_SUPPORT = "RANGE_DAMAGE_SUPPORT",
  SPELL_DAMAGE_SUPPORT = "SPELL_DAMAGE_SUPPORT",
  SPELL_PERIODIC_DAMAGE_SUPPORT = "SPELL_PERIODIC_DAMAGE_SUPPORT",
  SPELL_HEAL_SUPPORT = "SPELL_HEAL_SUPPORT",
  SPELL_PERIODIC_HEAL_SUPPORT = "SPELL_PERIODIC_HEAL_SUPPORT",
}

/**
 * 资源类型。成员名与取值取自暴雪客户端 API `Enum.PowerType`
 * (Obsolete/Obsolete2/NumPowerTypes 也是暴雪自己的成员名,原样保留以免
 * 数值出现空洞被误读成「缺项」)。
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

/** 单位归属。取值仅进程内使用。 */
export enum CombatUnitReaction {
  Neutral = 0,
  Friendly = 1,
  Hostile = 2,
}

/** 单位种类。取值仅进程内使用;顺序对齐下方旗标掩码的判定次序。 */
export enum CombatUnitType {
  None = 0,
  Player = 1,
  NPC = 2,
  Pet = 3,
  Guardian = 4,
  Object = 5,
}

/** 对局结果(从上传方视角)。取值仅进程内使用。 */
export enum CombatResult {
  Unknown = 0,
  DrawGame = 1,
  Lose = 2,
  Win = 3,
}

// ── 单位旗标解码 ──────────────────────────────────────────────────────────
// 掩码取自暴雪公开的 COMBATLOG_OBJECT_* 常量(日志第 3/6 字段的位域)。
const TYPE_PLAYER = 0x0400; // COMBATLOG_OBJECT_TYPE_PLAYER
const TYPE_NPC = 0x0800; // COMBATLOG_OBJECT_TYPE_NPC
const TYPE_PET = 0x1000; // COMBATLOG_OBJECT_TYPE_PET
const TYPE_GUARDIAN = 0x2000; // COMBATLOG_OBJECT_TYPE_GUARDIAN
const TYPE_OBJECT = 0x4000; // COMBATLOG_OBJECT_TYPE_OBJECT
const REACTION_FRIENDLY = 0x0010; // COMBATLOG_OBJECT_REACTION_FRIENDLY
const REACTION_HOSTILE = 0x0040; // COMBATLOG_OBJECT_REACTION_HOSTILE

/**
 * 旗标 → 单位种类。玩家优先判,其余按「宠物→守护→NPC→物件」次序 ——
 * 宠物同时置 NPC 位,先判 NPC 会把宠物吞掉。
 */
export function getUnitType(flags: number): CombatUnitType {
  if (flags & TYPE_PLAYER) return CombatUnitType.Player;
  if (flags & TYPE_PET) return CombatUnitType.Pet;
  if (flags & TYPE_GUARDIAN) return CombatUnitType.Guardian;
  if (flags & TYPE_NPC) return CombatUnitType.NPC;
  if (flags & TYPE_OBJECT) return CombatUnitType.Object;
  return CombatUnitType.None;
}

/** 旗标 → 阵营归属。两位都不置时为中立。 */
export function getUnitReaction(flags: number): CombatUnitReaction {
  if (flags & REACTION_FRIENDLY) return CombatUnitReaction.Friendly;
  if (flags & REACTION_HOSTILE) return CombatUnitReaction.Hostile;
  return CombatUnitReaction.Neutral;
}
