import { analyzeCcBreaks, type ICcBreakEvent } from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import { displaySpellName } from "./spellDisplay";
import { tInRange, type TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

/** 单条打破实例;tS = 相对秒。 */
export interface CcBreakRow {
  tS: number;
  label: string;
  /** ▶ 跳转的镜头单位(打破者/被控者)。 */
  unitName: string;
}

export interface CcBreakDash {
  /** 资敌打破(可教):己方伤害打断挂在敌人身上的控,剩余 ≥2s。 */
  friendly: CcBreakRow[];
  /** 敌方自误(正面信号):敌方伤害打断他们给我方上的控。 */
  enemy: CcBreakRow[];
  /** root(定身)打破计数,单列脚注不混硬 CC。 */
  rootBreakCount: number;
}

const EMPTY: CcBreakDash = { friendly: [], enemy: [], rootBreakCount: 0 };

const fmtName = (id: string, fallback: string): string =>
  id ? displaySpellName(id, fallback) : "近战";

const short = (name: string): string => name.split("-")[0];

const remainTag = (e: ICcBreakEvent): string =>
  e.remainingSeconds !== null ? `(剩 ${e.remainingSeconds.toFixed(1)}s)` : "";

/**
 * 打破控制统计(2026-08-02 用户需求):判定全部消费 analysis 的
 * analyzeCcBreaks(日志 ground truth SPELL_AURA_BROKEN_SPELL),渲染层
 * 只做措辞。语料基线:6.14 次/combat,资敌 48.2% vs 敌方自误 46.6%。
 */
export function deriveCcBreakDash(
  source: ReportSource,
  range?: TimeRange | null,
): CcBreakDash {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction === CombatUnitReaction.Hostile,
    );
    if (friends.length === 0 || enemies.length === 0) return EMPTY;

    // 宠物打破归主(B45 同款 pets 参数)
    const petsOf = (owners: typeof players) => {
      const ids = new Set(owners.map((o) => o.id));
      return Object.values(legacy.units).filter(
        (u) => u.ownerId && ids.has(u.ownerId),
      );
    };
    const stats = analyzeCcBreaks(
      friends,
      enemies,
      { startTime: legacy.startTime, endTime: legacy.endTime },
      petsOf(friends),
      petsOf(enemies),
    );

    const friendly: CcBreakRow[] = stats.friendlySquander
      .filter((e) => tInRange(e.atSeconds, range))
      .map((e) => ({
        tS: e.atSeconds,
        label: `${short(e.breakerName)} 的 ${fmtName(e.breakSpellId, e.breakSpellName)} 打破了 ${short(e.casterName)} 给 ${short(e.holderName)} 上的 ${fmtName(e.ccSpellId, e.ccSpellName)}${remainTag(e)}`,
        unitName: e.breakerName,
      }));

    const enemy: CcBreakRow[] = stats.enemySquander
      .filter((e) => tInRange(e.atSeconds, range))
      .map((e) => ({
        tS: e.atSeconds,
        label: `敌方 ${short(e.breakerName)} 的 ${fmtName(e.breakSpellId, e.breakSpellName)} 提前打破了 ${short(e.holderName)} 身上的 ${fmtName(e.ccSpellId, e.ccSpellName)}${remainTag(e)}`,
        unitName: e.holderName,
      }));

    return { friendly, enemy, rootBreakCount: stats.rootBreakCount };
  } catch {
    return EMPTY;
  }
}
