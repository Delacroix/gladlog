import { SPELL_CATEGORIES, SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import type { ReportSource } from "./types";

export interface CastRow {
  t: number;
  spellId: number;
  spellName: string;
  targetName: string;
  byPet: boolean;
  /** 图标基名(挖掘表 spellIconsGenerated);缺表项 undefined → 首字母 fallback。 */
  icon?: string;
}
export interface AuraRow {
  t: number;
  spellId: number;
  spellName: string;
  auraType: "BUFF" | "DEBUFF";
  applied: boolean;
}

/** 一条单位事件:施法 或 重要光环(curated PvP 分类内的光环)。 */
export type UnitEvent =
  ({ kind: "cast" } & CastRow) | ({ kind: "aura"; category: string } & AuraRow);

/** 该光环是否属于 curated PvP 分类集(CC/定身/免疫/防御CD/进攻CD/缴械/打断…)。 */
export function auraCategory(spellId: number): string | undefined {
  return SPELL_CATEGORIES[String(spellId)]?.type;
}

/** 该施法是否为大招/关键 CD(免疫/防御CD/进攻CD/缴械),用于 GCD 泳道高亮。 */
const MAJOR_CD_TYPES = new Set([
  "immunities",
  "buffs_defensive",
  "buffs_offensive",
  "disarms",
]);
export function isMajorCd(spellId: number): boolean {
  const c = auraCategory(spellId);
  return c != null && MAJOR_CD_TYPES.has(c);
}

export function deriveCasts(m: ReportSource, unitId: string): CastRow[] {
  const u = m.units[unitId];
  if (!u) return [];
  const row =
    (byPet: boolean) =>
    (e: (typeof u.casts)[number]): CastRow => ({
      t: e.timestamp,
      spellId: e.spellId,
      spellName: e.spellName,
      targetName: e.destName,
      byPet,
      icon: SPELL_ICONS_GENERATED[String(e.spellId)],
    });
  return [...u.casts.map(row(false)), ...u.petCasts.map(row(true))].sort(
    (a, b) => a.t - b.t,
  );
}

/** GCD 地板(ms):极限急速下 GCD ≈ 0.75s;同一法术连续间隔低于此,
 * 物理上不可能是玩家 GCD 行为(资源 proc / 光环 tick 型施法)。 */
const SUB_GCD_MS = 700;
/** 判为噪声法术的最小样本数与亚 GCD 间隔占比。 */
const NOISE_MIN_CASTS = 4;
const NOISE_SUB_GCD_RATIO = 0.5;

/**
 * GCD 泳道口径的施法流(2026-07-25,用户实测反馈):
 * 剔除「物理上不可能是 GCD 行为」的垃圾 ——
 *  1) 宠物填充施法(恶魔火焰箭/爪击/树人滋养系逐秒刷屏):宠物施法只保留
 *     curated PvP 分类内的(断法吞噬等要事仍显示);
 *  2) 玩家侧 proc 刷屏(灵魂残片 ×5721/10场、89% 亚 GCD 间隔):同一法术
 *     连续间隔多数低于 GCD 地板 → 整个法术判噪声。
 * 实测(用户 10 场 shuffle):64549 chips 里 44.5% 被推过结束线折叠 ——
 * 垃圾把真技能顶出画面,这就是「技能被 truncate」的来源。
 * 数据驱动逐场自适应,不维护法术黑名单(白名单腐烂教训)。
 */
export function filterGcdNoise(rows: CastRow[]): CastRow[] {
  const bySpell = new Map<string, number[]>();
  const keyOf = (r: CastRow) => `${r.spellId}:${r.byPet ? 1 : 0}`;
  for (const r of rows) {
    const arr = bySpell.get(keyOf(r)) ?? [];
    arr.push(r.t);
    bySpell.set(keyOf(r), arr);
  }
  const noisy = new Set<string>();
  for (const [key, ts] of bySpell) {
    if (ts.length < NOISE_MIN_CASTS) continue;
    let sub = 0;
    for (let i = 1; i < ts.length; i++)
      if (ts[i]! - ts[i - 1]! < SUB_GCD_MS) sub++;
    if (sub >= (ts.length - 1) * NOISE_SUB_GCD_RATIO) noisy.add(key);
  }
  return rows.filter((r) => {
    if (r.byPet && !SPELL_CATEGORIES[String(r.spellId)]) return false;
    return !noisy.has(keyOf(r));
  });
}

/** GCD 泳道消费的施法流 = 全量施法 - GCD 噪声。 */
export function deriveGcdCasts(m: ReportSource, unitId: string): CastRow[] {
  return filterGcdNoise(deriveCasts(m, unitId));
}

export function deriveAuraEvents(m: ReportSource, unitId: string): AuraRow[] {
  const u = m.units[unitId];
  if (!u) return [];
  return [...u.auraEvents]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => ({
      t: e.timestamp,
      spellId: e.spellId,
      spellName: e.spellName,
      auraType: e.auraType,
      applied: !e.eventName.includes("REMOVED"),
    }));
}

/**
 * 合并「施法 + 重要光环」为一条按时间升序的事件流。
 * 光环只保留 curated PvP 分类内的(过滤掉杂噪 proc / 小 buff)。
 */
export function deriveUnitTimeline(
  m: ReportSource,
  unitId: string,
): UnitEvent[] {
  const casts: UnitEvent[] = deriveCasts(m, unitId).map((c) => ({
    kind: "cast",
    ...c,
  }));
  const auras: UnitEvent[] = [];
  for (const a of deriveAuraEvents(m, unitId)) {
    const category = auraCategory(a.spellId);
    if (!category) continue;
    auras.push({ kind: "aura", category, ...a });
  }
  return [...casts, ...auras].sort((a, b) => a.t - b.t);
}
