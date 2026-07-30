import { ICombatUnit } from "@gladlog/parser-compat";

import { getEnglishSpellName } from "../data/spellEffectData";
import { IMitigationEntry, MITIGATION_TABLE } from "../data/mitigationData";
import spellIdLists from "../data/spellIdLists";
import { buildAuraIntervals } from "./auraIntervals";
import { binarySearchClosest } from "./binarySearch";
import {
  HP_SAMPLE_RADIUS_MS,
  IMajorCooldownInfo,
  cdAvailableAt,
} from "./cooldowns";
import { IPlayerCCTrinketSummary } from "./ccTrinketAnalysis";
import {
  IMissedExternal,
  wasLockedOutThroughWindow,
} from "./deathOutcomeAnalysis";

/**
 * counterfactual.ts —— 减伤反事实核算(17b)三档谓词单源 + 三形态算术。
 *
 * 三种独立口径,逐条计算、不建模同窗叠加:
 *  - A(computeMitigationAudit):死亡窗内**已激活**的白名单减伤逐条核算
 *    ——arith 条目按观测伤害反推挡掉量;immunity(pct=100)不反推,只如实
 *    报覆盖时长与期内观测承伤;机制类/表外条目(转移/反弹等)不编数字;
 *    positional(黑暗)本期不建模,跳过不出行。
 *  - B(computeMissedExternalCounterfactuals):队友外置**可用未给**,打折
 *    口径(省下量 = 窗内命中学派伤害 × pct%),仅「明显能活」开口。
 *  - 窄门(computeUnusedSelfCounterfactuals):自己可用未按,同打折口径,
 *    CC 死锁整窗静默;仅「明显能活」开口。
 *
 * 谓词单源纪律(门规谓词即规范):HP 采样一律复用 `HP_SAMPLE_RADIUS_MS`
 * (cooldowns.ts 单源常量),白名单一律从 `spellIdLists` 派生,减伤表一律
 * 消费 `MITIGATION_TABLE`——本文件不得重新定义任何一个已有常量/表。
 */

export const COUNTERFACTUAL_WINDOW_S = 10;
/** 明显线余量:15% maxHp。 */
export const DECISIVE_MARGIN_PCT = 15;
/** 边缘档下界:0.5×净掉血。 */
export const MARGINAL_FLOOR_RATIO = 0.5;

export type CounterfactualTier = "decisive" | "marginal" | "fatal";

/**
 * 三档谓词单源(量化报告同口径)。savedAmount/netDamage/maxHp 同单位
 * (绝对 HP 值)。
 *   明显能活: savedAmount > netDamage + DECISIVE_MARGIN_PCT% × maxHp
 *   边缘:     savedAmount ∈ (MARGINAL_FLOOR_RATIO × netDamage, 明显线]
 *   仍然死:   其余
 */
export function counterfactualTier(
  savedAmount: number,
  netDamage: number,
  maxHp: number,
): CounterfactualTier {
  const decisiveLine = netDamage + (DECISIVE_MARGIN_PCT / 100) * maxHp;
  if (savedAmount > decisiveLine) return "decisive";
  if (savedAmount > MARGINAL_FLOOR_RATIO * netDamage) return "marginal";
  return "fatal";
}

// 白名单单源派生:大自保 ∪ 外置。刻意不用 externalOrBigDefensiveSpellIds——
// 那张表额外含团队增益类 id(64843/740/200183 等),服务于「谁能兼职」的
// cooldowns.ts 判定,与减伤反事实的白名单语义(能挡伤/免疫的自保墙)不同。
const WHITELIST_IDS: ReadonlySet<string> = new Set<string>([
  ...spellIdLists.bigDefensiveSpellIds,
  ...spellIdLists.externalDefensiveSpellIds,
]);

/**
 * 绝对 HP 直采:`getUnitHpAtTimestamp` 返回的是百分比,反事实算术要绝对
 * 值,所以不能复用它——但采样逻辑(最近 advancedAction、来源校验、半径
 * 门)与它完全同源,采样半径复用同一个 `HP_SAMPLE_RADIUS_MS`,不发明第二
 * 个半径常量。
 */
function absHpAt(
  unit: ICombatUnit,
  tMs: number,
): { hp: number; maxHp: number } | null {
  const closest = binarySearchClosest(
    unit.advancedActions,
    tMs,
    (a) => a.logLine.timestamp,
  );
  if (!closest) return null;
  if (closest.advancedActorId !== unit.id) return null;
  if (closest.advancedActorMaxHp <= 0) return null;
  if (Math.abs(closest.logLine.timestamp - tMs) > HP_SAMPLE_RADIUS_MS) {
    return null;
  }
  return {
    hp: closest.advancedActorCurrentHp,
    maxHp: closest.advancedActorMaxHp,
  };
}

/**
 * 净掉血/满血单源:窗口起点绝对 HP 即净掉血(死亡时 HP→0,治疗已天然网
 * 入 HP 曲线,不必再单独减治疗量——与量化报告同口径);maxHp 取死亡时刻
 * 采样,取不到则退到窗口起点采样(两次都取不到 → null,rows/hits 各自
 * 按「宁缺」处理,不外推数字)。三形态(A/B/窄门)共用同一份计算,保证三
 * 者对同一场死亡给出同一个净掉血/满血读数。
 */
function windowNetDamageAndMaxHp(
  victim: ICombatUnit,
  matchStartMs: number,
  deathS: number,
): { netDamage: number | null; maxHp: number | null } {
  const windowStartMs = matchStartMs + windowStartSecondsOf(deathS) * 1000;
  const deathMs = matchStartMs + deathS * 1000;
  const startSample = absHpAt(victim, windowStartMs);
  const deathSample = absHpAt(victim, deathMs);
  return {
    netDamage: startSample ? startSample.hp : null,
    maxHp: deathSample
      ? deathSample.maxHp
      : startSample
        ? startSample.maxHp
        : null,
  };
}

/** 窗内命中 schoolMask 的观测伤害合计(绝对值,`effectiveAmount` 已是打折后的实收值)。 */
function windowDamage(
  unit: ICombatUnit,
  fromS: number,
  toS: number,
  schoolMask: number,
  matchStartMs: number,
): number {
  const fromMs = matchStartMs + fromS * 1000;
  const toMs = matchStartMs + toS * 1000;
  let sum = 0;
  for (const d of unit.damageIn) {
    const ts = d.logLine.timestamp;
    if (ts < fromMs || ts > toMs) continue;
    const school = Number.parseInt(d.spellSchoolId ?? "0x0", 16);
    if ((school & schoolMask) === 0) continue;
    sum += Math.abs(d.effectiveAmount);
  }
  return sum;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * 死亡窗口起点(相对秒),夹到 0:比赛/对局刚开局(deathS < WINDOW_S)时
 * `deathS - COUNTERFACTUAL_WINDOW_S` 会算出负数,若不夹零则 HP 采样目标
 * 时刻早于 matchStartMs 至少 (WINDOW_S - deathS) 秒——超出
 * `HP_SAMPLE_RADIUS_MS`(3s)必定 null,导致早期死亡整体静默丢失反事实
 * 输出(agy flash 复核发现,2026-07-30)。四处窗口边界(netDamage/maxHp
 * 采样 + 三个函数各自的 windowDamage 调用)必须用同一个夹零值,不得各夹
 * 各的。
 */
function windowStartSecondsOf(deathS: number): number {
  return Math.max(0, deathS - COUNTERFACTUAL_WINDOW_S);
}

export interface IMitigationAuditRow {
  spellId: string;
  spellName: string;
  kind: "arith" | "immunity" | "mechanic";
  /** 激活区间∩死亡窗的秒数(一位小数)。 */
  activeOverlapS: number;
  /** kind=arith:挡掉量(绝对值)与占 maxHp 百分比。 */
  blockedAmount?: number;
  blockedPctMaxHp?: number;
  /** kind=immunity:免疫覆盖期内观测承伤(应≈0,如实报)。 */
  damageTakenDuringImmunity?: number;
}

/**
 * A 形态:死亡窗内死者身上激活的白名单减伤逐条核算(独立口径,多条目不
 * 建模叠加交互)。
 */
export function computeMitigationAudit(
  victim: ICombatUnit,
  combat: {
    startTime: number;
    endTime: number;
    units: Record<string, ICombatUnit>;
  },
  deathS: number,
): {
  rows: IMitigationAuditRow[];
  netDamage: number | null;
  maxHp: number | null;
} {
  const windowStartS = windowStartSecondsOf(deathS);
  const { netDamage, maxHp } = windowNetDamageAndMaxHp(
    victim,
    combat.startTime,
    deathS,
  );

  const rows: IMitigationAuditRow[] = [];
  const intervals = buildAuraIntervals(victim, combat).filter((iv) =>
    WHITELIST_IDS.has(iv.spellId),
  );

  for (const iv of intervals) {
    const overlapFrom = Math.max(iv.fromS, windowStartS);
    const overlapTo = Math.min(iv.toS, deathS);
    if (overlapTo <= overlapFrom) continue; // 无重叠,不出行

    const activeOverlapS = round1(overlapTo - overlapFrom);
    const spellName = getEnglishSpellName(iv.spellId, iv.spellName);
    const entry: IMitigationEntry | undefined = MITIGATION_TABLE[iv.spellId];

    if (!entry) {
      // 表外(含 NO_MITIGATION_IDS,二者互斥):机制类,不编数字。
      rows.push({
        spellId: iv.spellId,
        spellName,
        kind: "mechanic",
        activeOverlapS,
      });
      continue;
    }
    if (entry.positional) continue; // 黑暗类:本期不建模位置条件,跳过不出行

    const observed = windowDamage(
      victim,
      overlapFrom,
      overlapTo,
      entry.schoolMask,
      combat.startTime,
    );

    if (entry.pct >= 100) {
      // 免疫:除数为零,绝不反推,如实报覆盖秒数与期内观测承伤。
      rows.push({
        spellId: iv.spellId,
        spellName,
        kind: "immunity",
        activeOverlapS,
        damageTakenDuringImmunity: observed,
      });
      continue;
    }

    const blockedAmount = Math.round(
      (observed * entry.pct) / (100 - entry.pct),
    );
    rows.push({
      spellId: iv.spellId,
      spellName,
      kind: "arith",
      activeOverlapS,
      blockedAmount,
      blockedPctMaxHp:
        maxHp !== null && maxHp > 0
          ? round1((blockedAmount / maxHp) * 100)
          : undefined,
    });
  }

  return { rows, netDamage, maxHp };
}

export interface ICounterfactualHit {
  spellId: string;
  spellName: string;
  source: "unused-self" | "missed-external";
  casterName?: string; // missed-external 时
  savedAmount: number;
  savedPctMaxHp: number;
  tier: CounterfactualTier;
}

/**
 * B/窄门共用的打折口径:候选**未激活**,不做反推(那是 A 形态的专利),
 * 直接按表定 pct 打折窗内命中学派的观测伤害——只有 tier=decisive 才产出
 * 一条 hit,marginal/fatal 静默(诚实伦理:不确定的不说)。
 */
function decisiveHitFor(
  spellId: string,
  rawSpellName: string,
  source: ICounterfactualHit["source"],
  casterName: string | undefined,
  saved: number,
  netDamage: number | null,
  maxHp: number | null,
): ICounterfactualHit | null {
  if (netDamage === null || maxHp === null || maxHp <= 0) return null;
  const tier = counterfactualTier(saved, netDamage, maxHp);
  if (tier !== "decisive") return null;
  return {
    spellId,
    spellName: getEnglishSpellName(spellId, rawSpellName),
    source,
    casterName,
    savedAmount: saved,
    savedPctMaxHp: round1((saved / maxHp) * 100),
    tier,
  };
}

/**
 * 窄门:自己可用未按(表内非 positional;CC 死锁返回空)。只返回 decisive。
 */
export function computeUnusedSelfCounterfactuals(
  victim: ICombatUnit,
  victimCds: IMajorCooldownInfo[],
  victimCcSummary: Pick<IPlayerCCTrinketSummary, "playerName" | "ccInstances">,
  combat: { startTime: number; units: Record<string, ICombatUnit> },
  deathS: number,
): ICounterfactualHit[] {
  if (wasLockedOutThroughWindow(victimCcSummary, deathS)) return [];

  const windowStartS = windowStartSecondsOf(deathS);
  const { netDamage, maxHp } = windowNetDamageAndMaxHp(
    victim,
    combat.startTime,
    deathS,
  );

  const hits: ICounterfactualHit[] = [];
  for (const cd of victimCds) {
    if (!cdAvailableAt(cd, deathS)) continue;
    const entry = MITIGATION_TABLE[cd.spellId];
    if (!entry || entry.positional) continue;

    const observed = windowDamage(
      victim,
      windowStartS,
      deathS,
      entry.schoolMask,
      combat.startTime,
    );
    const saved = Math.round((observed * entry.pct) / 100);
    const hit = decisiveHitFor(
      cd.spellId,
      cd.spellName,
      "unused-self",
      undefined,
      saved,
      netDamage,
      maxHp,
    );
    if (hit) hits.push(hit);
  }
  return hits;
}

/** B 形态:missedExternals × 表 → 三档,只返回 decisive。 */
export function computeMissedExternalCounterfactuals(
  missedExternals: IMissedExternal[],
  victim: ICombatUnit,
  combat: { startTime: number },
  deathS: number,
): ICounterfactualHit[] {
  const windowStartS = windowStartSecondsOf(deathS);
  const { netDamage, maxHp } = windowNetDamageAndMaxHp(
    victim,
    combat.startTime,
    deathS,
  );

  const hits: ICounterfactualHit[] = [];
  for (const m of missedExternals) {
    const entry = MITIGATION_TABLE[m.spellId];
    if (!entry || entry.positional) continue; // 表外/positional 跳过

    const observed = windowDamage(
      victim,
      windowStartS,
      deathS,
      entry.schoolMask,
      combat.startTime,
    );
    const saved = Math.round((observed * entry.pct) / 100);
    const hit = decisiveHitFor(
      m.spellId,
      m.spellName,
      "missed-external",
      m.casterName,
      saved,
      netDamage,
      maxHp,
    );
    if (hit) hits.push(hit);
  }
  return hits;
}
