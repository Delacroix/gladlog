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

/** 自动触发/内部变体拒绝表(全部满足:表外 + 用户 10 场语料高频 + 非玩家
 * 按键;「变体」类的按键版 id 已在保留集,拒绝只去重不丢信息。
 * rot 防线 = 每条证据注释 + 语料复扫(evidenceDist/被丢名单人审流程)。 */
const AUTO_CAST_DENY: ReadonlySet<string> = new Set([
  "1217610", // 吞噬 Devour:DH 英雄天赋魂片自动触发,×867、p50≈4s,用户点名
  "473662", // 吞噬 Consume:同上双 id
  "341263", // 暗影幻灵:牧师暗影飞弹实体施放,×747,非按键
  "415388", // 回收复用:BM 自动触发,×1030、93% 亚 GCD
  "393035", // 投掷利刃自动变体:按键版(书内 Throw Glaive)已保留,×338
  "337819", // 投掷利刃自动变体:同上,×311
  "1226019", // 收割:DK 英雄天赋自动,×490
  "469270", // 毁灭之风:战士英雄天赋自动,×258
  "228537", // 破碎灵魂:DH 魂片生成事件,×220
  "408385", // 远征打击:英雄天赋自动追击,×316
  "1242174", // 死灵缠绕变体:DK 英雄天赋自动,×157
  "1256581", // 麦琳瑟拉的祝福:proc 增益施放,×148
  "126664", // 冲锋位移内部 id:按键版 100 已保留,×173
  "155777", // 回春术(萌芽):双 HoT 第二实例,按键版回春术已保留,×183
]);

/** GCD 地板(ms):极限急速下 GCD ≈ 0.75s;同一法术连续间隔低于此,
 * 物理上不可能是玩家 GCD 行为(资源 proc / 光环 tick 型施法)。 */
const SUB_GCD_MS = 700;
/** 判为噪声法术的最小样本数与亚 GCD 间隔占比。 */
const NOISE_MIN_CASTS = 4;
const NOISE_SUB_GCD_RATIO = 0.5;

/**
 * GCD 泳道口径的施法流(2026-07-25,用户实测反馈,两层门):
 *  1) **正式数据门**:玩家按键表(SkillLineAbility 技能书 ∪ 天赋树 ∪
 *     PvP 天赋,genGcdSpells 生成)∪ curated(物品法术兜底)。触发型
 *     子法术/引擎内部 id(DH 吞噬双 id、灵魂残片、法师积雪、赞美诗治疗
 *     效果 id)全不在表内 —— 已知样例 13/13 验证,SpellCooldowns 有行
 *     判据会漏吞噬(触发法术也有 CD 行),已否决。
 *  2) **物理层**:同名法术连续间隔多数低于 GCD 地板 700ms(硬游戏规则,
 *     极限急速 GCD ≈ 750ms)→ 引导逐跳打 CAST 事件类刷屏(DH 吞噬双 id
 *     交替,按名聚合才抓得住)。
 *  3) 宠物施法只保留 curated PvP 分类内的(断法吞噬等要事仍显示)。
 */
export function filterGcdNoise(rows: CastRow[]): CastRow[] {
  const bySpell = new Map<string, number[]>();
  // 按名聚合:双 id 技能(吞噬 1217610/473662)交替发,按 id 聚会漏检
  const keyOf = (r: CastRow) => `${r.spellName}:${r.byPet ? 1 : 0}`;
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
    const sid = String(r.spellId);
    if (r.byPet) return !!SPELL_CATEGORIES[sid];
    if (AUTO_CAST_DENY.has(sid)) return false;
    if (noisy.has(keyOf(r))) return false; // 物理层对表内外一视同仁
    return true; // 表外默认保留(SkillLineAbility 不完整,硬丢会误杀真按键)
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
