import { ICombatUnit, LogEvent } from "@gladlog/parser-compat";

import { getEnglishSpellName } from "../data/spellEffectData";
import { SPELL_CATEGORIES } from "../data/spellCategories";
import {
  buildCcCategoryHistory,
  getDRCategory,
  getDRLevelAtTime,
} from "./drAnalysis";

/**
 * 打破控制统计(2026-08-02 用户需求)。判定不靠启发式 —— 日志自带 ground
 * truth:CC 光环的 removal 事件为 SPELL_AURA_BROKEN_SPELL(src=**打破者**、
 * params[11..12]=打破技能)/ SPELL_AURA_BROKEN(纯近战,现代日志≈0)。
 * 语料基线(150 场/766 combat):6.14 次/combat,占硬 CC 窗口 17.5%;
 * 四象限近对半 —— 资敌(己方伤害打破己方给敌人上的控)48.2% vs 敌方自误
 * 46.6%;「救人式打破」物理上几乎不存在(友军伤害打不到队友),不设档。
 */

export interface ICcBreakEvent {
  /** 打破时刻(相对秒)。 */
  atSeconds: number;
  ccSpellId: string;
  ccSpellName: string;
  /** 被控者(控在谁身上)。 */
  holderName: string;
  holderIsFriendly: boolean;
  /** 施控者(谁上的控)。 */
  casterName: string;
  /** 打破者(谁的伤害打断的)。 */
  breakerName: string;
  breakerIsFriendly: boolean;
  /** 打破技能;纯近战 BROKEN 事件为空 id + 「Melee」。 */
  breakSpellId: string;
  breakSpellName: string;
  /** 控生效了多久。 */
  heldSeconds: number;
  /** 还能再控多久:满时长(spellCategories duration 表)按被控者当时 DR 档
   * 折算(Full=全额,50%=减半)后减去已持续;无表 → null(不猜)。 */
  remainingSeconds: number | null;
  isRoot: boolean;
}

export interface ICcBreakStats {
  /** 全部硬 CC 打破事件(时间序)。 */
  events: ICcBreakEvent[];
  /** 资敌打破(可教):己方打破了挂在敌人身上的控,且剩余 ≥
   * CC_BREAK_REPORT_MIN_REMAINING_S(语料:阈值 2s 保留 80%,滤掉尾巴上的
   * 无关紧要打破)。 */
  friendlySquander: ICcBreakEvent[];
  /** 敌方自误(正面信号):敌方伤害打破了他们给我方队友上的控。 */
  enemySquander: ICcBreakEvent[];
  /** root(定身)打破计数 —— 单列一档,不混入硬 CC(定身被打破经常是
   * 战术上正确的换算,不能当失误教)。 */
  rootBreakCount: number;
}

/** 资敌打破进「可教」清单的最小剩余秒数(语料:≥2s 保留 1810/2266=80%)。 */
export const CC_BREAK_REPORT_MIN_REMAINING_S = 2;

const isCcType = (spellId: string): boolean =>
  SPELL_CATEGORIES[spellId]?.type === "cc";
const isRootType = (spellId: string): boolean =>
  SPELL_CATEGORIES[spellId]?.type === "roots";

/**
 * 扫描双方单位的 CC 光环打破事件。配对语义与语料挖掘脚本一致:APPLIED 记
 * pending(key=spellId:casterId),REFRESH 视作重上,BROKEN/BROKEN_SPELL 的
 * src 是打破者、key 对不上 → 按同 spellId 最早 pending 配对。
 */
export function analyzeCcBreaks(
  friends: ICombatUnit[],
  enemies: ICombatUnit[],
  combat: { startTime: number; endTime: number },
  // 宠物打破归主(B45 同款):地狱烈焰/宠物 DoT 打破的控占资敌象限 ~8%,
  // 不传则这些事件落「其他象限」不进榜单。
  friendlyPets: ICombatUnit[] = [],
  enemyPets: ICombatUnit[] = [],
): ICcBreakStats {
  const friendlyIds = new Set(friends.map((u) => u.id));
  const enemyIds = new Set(enemies.map((u) => u.id));
  const friendlyPetById = new Map(friendlyPets.map((u) => [u.id, u]));
  const enemyPetById = new Map(enemyPets.map((u) => [u.id, u]));
  const playerById = new Map([...friends, ...enemies].map((u) => [u.id, u]));

  const events: ICcBreakEvent[] = [];
  let rootBreakCount = 0;

  for (const holder of [...friends, ...enemies]) {
    const holderIsFriendly = friendlyIds.has(holder.id);
    // 被控者的 DR 史按「对方阵营施加」取(与时间轴 [DR] 标注同源语义)
    const opponentIds = holderIsFriendly ? enemyIds : friendlyIds;

    const pending = new Map<string, { applyMs: number; casterName: string }>();

    for (const aura of holder.auraEvents) {
      const spellId = aura.spellId;
      if (!spellId) continue;
      const cc = isCcType(spellId);
      const root = isRootType(spellId);
      if (!cc && !root) continue;
      const ev = aura.logLine.event;
      const key = `${spellId}:${aura.srcUnitId}`;

      if (
        ev === LogEvent.SPELL_AURA_APPLIED ||
        ev === LogEvent.SPELL_AURA_REFRESH
      ) {
        pending.set(key, {
          applyMs: aura.timestamp,
          casterName: aura.srcUnitName,
        });
      } else if (ev === LogEvent.SPELL_AURA_REMOVED) {
        pending.delete(key);
      } else if (
        ev === LogEvent.SPELL_AURA_BROKEN ||
        ev === LogEvent.SPELL_AURA_BROKEN_SPELL
      ) {
        // BROKEN 事件的 src = 打破者不是施法者 → key 多半对不上,按同
        // spellId 最早 pending 配对(与挖掘脚本同语义)。
        let matchKey = pending.has(key) ? key : undefined;
        if (!matchKey) {
          let bestApply = Infinity;
          for (const [k, v] of pending) {
            if (k.startsWith(`${spellId}:`) && v.applyMs < bestApply) {
              bestApply = v.applyMs;
              matchKey = k;
            }
          }
        }
        if (!matchKey) continue;
        const entry = pending.get(matchKey);
        pending.delete(matchKey);
        if (!entry) continue;

        if (root) {
          rootBreakCount++;
          continue;
        }

        // 宠物打破归主:阵营按宠物所属侧,展示名归到主人 +「(宠物)」标注
        const asFriendlyPet = friendlyPetById.get(aura.srcUnitId);
        const asEnemyPet = enemyPetById.get(aura.srcUnitId);
        const breakerIsFriendly =
          friendlyIds.has(aura.srcUnitId) || asFriendlyPet !== undefined;
        const pet = asFriendlyPet ?? asEnemyPet;
        const petOwner = pet ? playerById.get(pet.ownerId) : undefined;
        const breakerName = pet
          ? `${petOwner?.name ?? pet.name}(宠物)`
          : aura.srcUnitName;
        const params = aura.logLine.parameters;
        const breakSpellId =
          aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
            ? String(params[11] ?? "")
            : "";
        const breakSpellName =
          aura.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
            ? getEnglishSpellName(breakSpellId, String(params[12] ?? ""))
            : "Melee";

        const heldSeconds = (aura.timestamp - entry.applyMs) / 1000;

        // 剩余时长:满时长表 × DR 折算 − 已持续;无表不猜(null)
        let remainingSeconds: number | null = null;
        const tableDuration = SPELL_CATEGORIES[spellId]?.duration;
        if (tableDuration !== undefined) {
          const category = getDRCategory(spellId);
          let factor = 1;
          if (category) {
            const history = buildCcCategoryHistory(
              holder,
              category,
              opponentIds,
              combat.startTime,
            );
            const level = getDRLevelAtTime(
              history,
              category,
              (entry.applyMs - combat.startTime) / 1000,
            );
            factor = level === "50%" ? 0.5 : level === "Immune" ? 0 : 1;
          }
          remainingSeconds = Math.max(0, tableDuration * factor - heldSeconds);
        }

        events.push({
          atSeconds: (aura.timestamp - combat.startTime) / 1000,
          ccSpellId: spellId,
          ccSpellName: getEnglishSpellName(spellId, aura.spellName),
          holderName: holder.name,
          holderIsFriendly,
          casterName: entry.casterName,
          breakerName,
          breakerIsFriendly,
          breakSpellId,
          breakSpellName,
          heldSeconds,
          remainingSeconds,
          isRoot: false,
        });
      }
    }
  }

  events.sort((a, b) => a.atSeconds - b.atSeconds);

  return {
    events,
    friendlySquander: events.filter(
      (e) =>
        !e.holderIsFriendly &&
        e.breakerIsFriendly &&
        (e.remainingSeconds === null ||
          e.remainingSeconds >= CC_BREAK_REPORT_MIN_REMAINING_S),
    ),
    enemySquander: events.filter(
      (e) => e.holderIsFriendly && !e.breakerIsFriendly,
    ),
    rootBreakCount,
  };
}
