import {
  AtomicArenaCombat,
  CombatUnitSpec,
  ICombatUnit,
  LogEvent,
} from "@gladlog/parser-compat";

import { IPlayerCCTrinketSummary } from "./ccTrinketAnalysis";
import { isCooldownAvailableFromLastUse, specToString } from "./cooldowns";
import {
  distanceBetween,
  getUnitPositionAtTime,
  hasLineOfSight,
} from "./losAnalysis";

interface IImmunitySpell {
  name: string;
  cooldownSeconds: number;
  lockoutSpellId?: string;
  specs: CombatUnitSpec[];
  /** Spell IDs that reset this immunity's cooldown when cast (CDR/reset mechanics). */
  resetSpellIds?: string[];
}

const IMMUNITY_SPELLS: Record<string, IImmunitySpell> = {
  "642": {
    name: "Divine Shield",
    cooldownSeconds: 300,
    lockoutSpellId: "25771",
    specs: [
      CombatUnitSpec.Paladin_Holy,
      CombatUnitSpec.Paladin_Retribution,
      CombatUnitSpec.Paladin_Protection,
    ],
  },
  "45438": {
    name: "Ice Block",
    cooldownSeconds: 240,
    lockoutSpellId: "41425",
    specs: [
      CombatUnitSpec.Mage_Arcane,
      CombatUnitSpec.Mage_Fire,
      CombatUnitSpec.Mage_Frost,
    ],
    // B30: Cold Snap (235219) resets Ice Block's cooldown
    resetSpellIds: ["235219"],
  },
  "47585": {
    name: "Dispersion",
    cooldownSeconds: 90,
    specs: [CombatUnitSpec.Priest_Shadow],
  },
  "186265": {
    name: "Aspect of the Turtle",
    cooldownSeconds: 180,
    specs: [
      CombatUnitSpec.Hunter_BeastMastery,
      CombatUnitSpec.Hunter_Marksmanship,
      CombatUnitSpec.Hunter_Survival,
    ],
  },
  "196555": {
    name: "Netherwalk",
    cooldownSeconds: 30,
    specs: [CombatUnitSpec.DemonHunter_Havoc],
  },
};

// 键集必须恒等于 spellIdLists.externalDefensiveSpellIds(14 条,防漂移见
// deathOutcome.whitelist.test.ts)——本表曾只收录 7 条(外置减伤主白名单串联腐烂
// 的一环:主白名单扩到 14 条时本表没跟着扩,LoS/距离/CD 判定全在缺失的 8 条上
// 空转)。冷却秒数来源:spellEffectGenerated.json(DB2 官方 cooldownSeconds /
// chargeCooldownSeconds,charges=1 时二者等价);specs 来源优先级:
// (1) cooldowns.ts 的 SPEC_EXCLUSIVE_SPELLS(有登记的按登记);
// (2) talentIdMap.json(DB2 天赋树,逐 spellId 查 classNodes/specNodes/
//     heroNodes/subTreeNodes——命中哪些专精的树就是哪些专精可用;204018 一条
//     纠正了"三系通用"的旧认知,实为 Paladin_Protection 专精天赋)。
const EXTERNAL_DEFENSIVE_SPELLS: Record<
  string,
  { name: string; cooldownSeconds: number; specs: CombatUnitSpec[] }
> = {
  "102342": {
    name: "Ironbark",
    cooldownSeconds: 45,
    specs: [CombatUnitSpec.Druid_Restoration],
  },
  "33206": {
    name: "Pain Suppression",
    cooldownSeconds: 180,
    specs: [CombatUnitSpec.Priest_Discipline],
  },
  "47788": {
    name: "Guardian Spirit",
    cooldownSeconds: 180,
    specs: [CombatUnitSpec.Priest_Holy],
  },
  "1022": {
    name: "Blessing of Protection",
    cooldownSeconds: 300,
    specs: [
      CombatUnitSpec.Paladin_Holy,
      CombatUnitSpec.Paladin_Retribution,
      CombatUnitSpec.Paladin_Protection,
    ],
  },
  "6940": {
    name: "Blessing of Sacrifice",
    cooldownSeconds: 120,
    specs: [
      CombatUnitSpec.Paladin_Holy,
      CombatUnitSpec.Paladin_Retribution,
      CombatUnitSpec.Paladin_Protection,
    ],
  },
  "116849": {
    name: "Life Cocoon",
    cooldownSeconds: 120,
    specs: [CombatUnitSpec.Monk_Mistweaver],
  },
  // 以下 8 条为本次收敛新增(spellEffectGenerated.json 查得 cooldownSeconds,
  // charges 形态取 chargeCooldownSeconds;specs 参 cooldowns.ts 登记/职业归属)。
  "204018": {
    name: "Blessing of Spellwarding",
    cooldownSeconds: 300, // spellEffectGenerated: charges.chargeCooldownSeconds=300
    // talentIdMap.json:仅 Paladin Protection specNodes 命中(与 "Improved
    // Ardent Defender" 合并节点)——不是三系通用的班用祝福(纠正常见旧认知)。
    specs: [CombatUnitSpec.Paladin_Protection],
  },
  "62618": {
    name: "Power Word: Barrier",
    cooldownSeconds: 180, // spellEffectGenerated: cooldownSeconds=180
    specs: [CombatUnitSpec.Priest_Discipline], // cooldowns.ts SPEC_EXCLUSIVE_SPELLS
  },
  "98008": {
    name: "Spirit Link Totem",
    cooldownSeconds: 180, // spellEffectGenerated: charges.chargeCooldownSeconds=180
    specs: [CombatUnitSpec.Shaman_Restoration], // cooldowns.ts SPEC_EXCLUSIVE_SPELLS
  },
  "97462": {
    name: "Rallying Cry",
    cooldownSeconds: 180, // spellEffectGenerated: cooldownSeconds=180
    specs: [
      CombatUnitSpec.Warrior_Arms,
      CombatUnitSpec.Warrior_Fury,
      CombatUnitSpec.Warrior_Protection,
    ], // 战士班用技能(classSpells.ts 未按专精拆分,三系皆可用)
  },
  "196718": {
    name: "Darkness",
    cooldownSeconds: 300, // spellEffectGenerated: cooldownSeconds=300
    // talentIdMap.json:三系 classNodes 皆命中(Havoc/Vengeance/Devourer)——
    // 恶魔猎手班用天赋,非某一专精独占。
    specs: [
      CombatUnitSpec.DemonHunter_Havoc,
      CombatUnitSpec.DemonHunter_Vengeance,
      CombatUnitSpec.DemonHunter_Devourer,
    ],
  },
  "51052": {
    name: "Anti-Magic Zone",
    cooldownSeconds: 240, // spellEffectGenerated: cooldownSeconds=240
    specs: [
      CombatUnitSpec.DeathKnight_Blood,
      CombatUnitSpec.DeathKnight_Frost,
      CombatUnitSpec.DeathKnight_Unholy,
    ], // 死亡骑士班用技能(classSpells.ts 未按专精拆分,三系皆可用)
  },
  "357170": {
    name: "Time Dilation",
    cooldownSeconds: 60, // spellEffectGenerated: charges.chargeCooldownSeconds=60
    specs: [CombatUnitSpec.Evoker_Preservation], // 恢复系神谕者专精天赋
  },
  "374227": {
    name: "Zephyr",
    cooldownSeconds: 120, // spellEffectGenerated: cooldownSeconds=120
    // talentIdMap.json:三系 classNodes 皆命中(Devastation/Preservation/
    // Augmentation)——神谕者班用天赋,非恢复系独占。
    specs: [
      CombatUnitSpec.Evoker_Devastation,
      CombatUnitSpec.Evoker_Preservation,
      CombatUnitSpec.Evoker_Augmentation,
    ],
  },
};

export { EXTERNAL_DEFENSIVE_SPELLS };

export interface IDeathImmuneAvailable {
  spellId: string;
  spellName: string;
  wasInCC: boolean;
}

export interface IMissedExternal {
  casterName: string;
  casterSpec: string;
  spellId: string;
  spellName: string;
  casterWasInCC: boolean;
}

export interface IDeathOutcomeEvent {
  deadPlayer: string;
  deadPlayerSpec: string;
  atSeconds: number;
  availableImmunities: IDeathImmuneAvailable[];
  missedExternals: IMissedExternal[];
}

export interface IDeathOutcomeSummary {
  events: IDeathOutcomeEvent[];
}

function lastCastSeconds(
  unit: ICombatUnit,
  spellId: string,
  matchStartMs: number,
): number | null {
  const casts = unit.spellCastEvents.filter(
    (e) =>
      e.spellId === spellId && e.logLine.event === LogEvent.SPELL_CAST_SUCCESS,
  );
  if (casts.length === 0) return null;
  return (
    (Math.max(...casts.map((e) => e.logLine.timestamp)) - matchStartMs) / 1000
  );
}

// BACKLOG #21 item2: exported (only) so the drift-prevention unit test can call this predicate
// directly alongside cdAvailableAt — not otherwise used outside this module.
export function isAvailableAt(
  unit: ICombatUnit,
  spellId: string,
  cooldownSeconds: number,
  atSeconds: number,
  matchStartMs: number,
  resetSpellIds?: string[],
): boolean {
  const lastCast = lastCastSeconds(unit, spellId, matchStartMs);
  // 核心判据与 cooldowns.ts 的 cdAvailableAt 共享(isCooldownAvailableFromLastUse)——
  // 数据源(raw spellCastEvents vs 已解析的 casts 台账)与下方 resetSpellIds 扩展
  // 各自保留,详见该函数上方注释。
  if (isCooldownAvailableFromLastUse(lastCast, cooldownSeconds, atSeconds))
    return true;

  // B30: if a reset spell was cast between the last use and atSeconds, the cooldown was reset.
  // Treat the reset cast as the new "last cast" and check availability from there.
  if (lastCast !== null && resetSpellIds && resetSpellIds.length > 0) {
    for (const resetId of resetSpellIds) {
      const resetCast = lastCastSeconds(unit, resetId, matchStartMs);
      if (
        resetCast !== null &&
        resetCast > lastCast &&
        resetCast <= atSeconds
      ) {
        // Reset happened after the last use — it is now available
        return true;
      }
    }
  }
  return false;
}

/** Pre-computed lockout intervals: [fromSeconds, toSeconds] pairs sorted by fromSeconds. */
type LockoutIntervals = [number, number][];

/** Build lockout intervals for one (unit, spellId) pair once per match. */
function buildLockoutIntervals(
  unit: ICombatUnit,
  lockoutSpellId: string,
  matchStartMs: number,
): LockoutIntervals {
  const relevant = unit.auraEvents
    .filter((e) => e.spellId === lockoutSpellId)
    .sort((a, b) => {
      if (a.logLine.timestamp !== b.logLine.timestamp)
        return a.logLine.timestamp - b.logLine.timestamp;
      if (a.logLine.event === LogEvent.SPELL_AURA_APPLIED) return -1;
      if (b.logLine.event === LogEvent.SPELL_AURA_APPLIED) return 1;
      return 0;
    });

  const intervals: LockoutIntervals = [];
  let openAt: number | null = null;
  for (const e of relevant) {
    const t = (e.logLine.timestamp - matchStartMs) / 1000;
    if (e.logLine.event === LogEvent.SPELL_AURA_APPLIED) openAt = t;
    else if (
      e.logLine.event === LogEvent.SPELL_AURA_REMOVED &&
      openAt !== null
    ) {
      intervals.push([openAt, t]);
      openAt = null;
    }
  }
  return intervals;
}

/** B29: O(log N) lockout check using pre-built intervals. */
function isLockedOutAt(
  intervals: LockoutIntervals,
  atSeconds: number,
): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [from, to] = intervals[mid];
    if (atSeconds < from) {
      hi = mid - 1;
    } else if (atSeconds > to) {
      lo = mid + 1;
    } else {
      return true; // atSeconds is within [from, to]
    }
  }
  return false;
}

/** Lethal-window length used to judge whether a player could have pressed a defensive before dying. */
export const LETHAL_WINDOW_SECONDS = 5;
/** Minimum contiguous CC-free gap (seconds) that counts as "they had a moment to press something". */
export const MIN_FREE_GAP_SECONDS = 1;

/**
 * True only if the player had NO contiguous CC-free gap >= MIN_FREE_GAP_SECONDS in the
 * [death - windowSeconds, death] window — i.e. they were effectively locked out for the
 * whole lethal window. CC the player trinketed out of (`trinketState === 'used'`) does not
 * count as lockout. Uniform CC model: every CC type is treated the same.
 */
export function wasLockedOutThroughWindow(
  ccSummary: Pick<IPlayerCCTrinketSummary, "playerName" | "ccInstances">,
  deathSeconds: number,
  windowSeconds = LETHAL_WINDOW_SECONDS,
): boolean {
  const windowStart = Math.max(0, deathSeconds - windowSeconds);
  const windowEnd = deathSeconds;
  if (windowEnd <= windowStart) return false;

  const intervals = ccSummary.ccInstances
    .filter((cc) => cc.trinketState !== "used")
    .map((cc): [number, number] => [
      Math.max(windowStart, cc.atSeconds),
      Math.min(windowEnd, cc.atSeconds + cc.durationSeconds),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let cursor = windowStart;
  let maxFreeGap = 0;
  for (const [start, end] of intervals) {
    if (start > cursor) maxFreeGap = Math.max(maxFreeGap, start - cursor);
    cursor = Math.max(cursor, end);
  }
  if (windowEnd > cursor) maxFreeGap = Math.max(maxFreeGap, windowEnd - cursor);

  return maxFreeGap < MIN_FREE_GAP_SECONDS;
}

// Max range for external defensive spells (all are 40-yard targeted spells in WoW).
const EXTERNAL_SPELL_RANGE_YARDS = 40;

export function buildDeathOutcomeSummary(
  combat: Pick<AtomicArenaCombat, "startTime"> & { zoneId?: string },
  friends: ICombatUnit[],
  ccSummaries: Pick<IPlayerCCTrinketSummary, "playerName" | "ccInstances">[],
  /**
   * 返回某单位某技能**已解析的**冷却秒数(即 `[RES]` 台账渲染所用的那个值,
   * 含天赋修正)。传入后优先于下面 EXTERNAL_DEFENSIVE_SPELLS 表里的常量。
   *
   * 为什么必须传:本表曾自带 cooldownSeconds,与主路径(extractMajorCooldowns
   * → spellEffectData + 天赋修正)各自维护,同一个技能出现两个值。实证
   * (2026-07-20,ord 041):Ironbark 本表写 45s、台账解析为 65s,0:52 施放后
   * 1:53 时本块判"available"而同秒台账写 `cd:Ironbark(7s)` —— 同一份 prompt
   * 对同一个冷却给出相反结论。谓词单源:可用性判定必须消费同一个冷却值。
   */
  resolvedCooldownSeconds?: (
    unit: ICombatUnit,
    spellId: string,
  ) => number | undefined,
): IDeathOutcomeSummary {
  const matchStartMs = combat.startTime;
  const events: IDeathOutcomeEvent[] = [];

  // B29: pre-build lockout intervals once per (unit, spell) pair to avoid O(N) filter+sort per death
  const lockoutCache = new Map<string, LockoutIntervals>();
  const getLockoutIntervals = (
    unit: ICombatUnit,
    spellId: string,
  ): LockoutIntervals => {
    const key = `${unit.id}:${spellId}`;
    if (!lockoutCache.has(key))
      lockoutCache.set(key, buildLockoutIntervals(unit, spellId, matchStartMs));
    return lockoutCache.get(key) ?? [];
  };

  for (const unit of friends) {
    for (const deathRecord of unit.deathRecords) {
      const atSeconds = (deathRecord.timestamp - matchStartMs) / 1000;
      const ccSummary = ccSummaries.find((s) => s.playerName === unit.name);

      const availableImmunities: IDeathImmuneAvailable[] = [];
      for (const [spellId, spell] of Object.entries(IMMUNITY_SPELLS)) {
        if (!spell.specs.includes(unit.spec)) continue;
        if (
          !isAvailableAt(
            unit,
            spellId,
            spell.cooldownSeconds,
            atSeconds,
            matchStartMs,
            spell.resetSpellIds,
          )
        )
          continue;
        if (
          spell.lockoutSpellId &&
          isLockedOutAt(
            getLockoutIntervals(unit, spell.lockoutSpellId),
            atSeconds,
          )
        )
          continue;
        availableImmunities.push({
          spellId,
          spellName: spell.name,
          wasInCC: ccSummary
            ? wasLockedOutThroughWindow(ccSummary, atSeconds)
            : false,
        });
      }

      const deathMs = deathRecord.timestamp;
      const dyingPos = getUnitPositionAtTime(unit, deathMs);

      const missedExternals: IMissedExternal[] = [];
      for (const teammate of friends) {
        if (teammate.id === unit.id) continue;
        // A teammate who is already dead at this death cannot cast an external — don't list their
        // tools as "available" (would blame a dead player for not saving a later death).
        if (
          teammate.deathRecords.some((d) => d.timestamp < deathRecord.timestamp)
        )
          continue;
        const teammateCCSummary = ccSummaries.find(
          (s) => s.playerName === teammate.name,
        );

        // B27: skip if teammate was out of spell range or LoS-blocked at death time
        const casterPos = getUnitPositionAtTime(teammate, deathMs);
        if (dyingPos && casterPos) {
          if (distanceBetween(dyingPos, casterPos) > EXTERNAL_SPELL_RANGE_YARDS)
            continue;
          if (combat.zoneId) {
            const los = hasLineOfSight(combat.zoneId, casterPos, dyingPos);
            if (los === false) continue; // confirmed LoS blocked (null = unmapped, pass through)
          }
        }

        for (const [spellId, spell] of Object.entries(
          EXTERNAL_DEFENSIVE_SPELLS,
        )) {
          const everCast = teammate.spellCastEvents.some(
            (e) =>
              e.spellId === spellId &&
              e.logLine.event === LogEvent.SPELL_CAST_SUCCESS,
          );
          if (!everCast && !spell.specs.includes(teammate.spec)) continue;
          // 冷却值优先取**已解析的**(与 [RES] 台账同源,含天赋修正);
          // 拿不到才退回本表常量。见本函数签名处的根因说明。
          if (
            !isAvailableAt(
              teammate,
              spellId,
              resolvedCooldownSeconds?.(teammate, spellId) ??
                spell.cooldownSeconds,
              atSeconds,
              matchStartMs,
            )
          )
            continue;
          missedExternals.push({
            casterName: teammate.name,
            casterSpec: specToString(teammate.spec),
            spellId,
            spellName: spell.name,
            casterWasInCC: teammateCCSummary
              ? wasLockedOutThroughWindow(teammateCCSummary, atSeconds)
              : false,
          });
        }
      }

      if (availableImmunities.length > 0 || missedExternals.length > 0) {
        events.push({
          deadPlayer: unit.name,
          deadPlayerSpec: specToString(unit.spec),
          atSeconds,
          availableImmunities,
          missedExternals,
        });
      }
    }
  }

  return { events };
}

export function formatDeathOutcomeForContext(
  summary: IDeathOutcomeSummary,
): string {
  if (summary.events.length === 0) return "";
  const lines: string[] = ["DEATHS WITH MISSED OPTIONS"];
  for (const ev of summary.events) {
    const t = `${Math.floor(ev.atSeconds / 60)}:${String(Math.floor(ev.atSeconds % 60)).padStart(2, "0")}`;
    for (const imm of ev.availableImmunities) {
      const ccNote = imm.wasInCC ? ", was in CC" : ", was not CC'd";
      lines.push(
        `  [${t}] ${ev.deadPlayerSpec} (${ev.deadPlayer}) — had ${imm.spellName} available${ccNote}`,
      );
    }
    for (const ext of ev.missedExternals) {
      const ccNote = ext.casterWasInCC ? ", caster in CC" : ", caster was free";
      lines.push(
        `  [${t}] ${ev.deadPlayer} died — ${ext.casterName} had ${ext.spellName} available${ccNote}`,
      );
    }
  }
  return lines.join("\n");
}
