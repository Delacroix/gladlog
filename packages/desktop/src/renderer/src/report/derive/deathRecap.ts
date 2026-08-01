import {
  analyzePlayerCCAndTrinket,
  buildDeathOutcomeSummary,
  computeMissedExternalCounterfactuals,
  computeMitigationAudit,
  computeUnusedSelfCounterfactuals,
  detectPanicDefensives,
  extractMajorCooldowns,
  findCheaperDefensiveAlternatives,
  ICounterfactualHit,
  IMajorCooldownInfo,
  IMitigationAuditRow,
  SPELL_CATEGORIES,
} from "@gladlog/analysis";
import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import { displaySpellName } from "./spellDisplay";
import type { ReportSource } from "./types";

/** 死前回看窗口(秒)。 */
export const DEATH_RECAP_WINDOW_S = 10;

export interface DeathRecapEvent {
  /** 相对秒(自 combat start)。 */
  tS: number;
  kind: "dmg" | "heal" | "cc" | "def_used";
  spell: string;
  /** 原始技能 id(#21 item1:接内联图标用,查不到表项 ChipIcon 自行降级)。 */
  spellId?: string;
  amount?: number;
  srcName: string;
  hpBeforePct?: number;
  hpAfterPct?: number;
  /** kind="def_used" 专用(#10 T5):同一份 analysis 判定
   * (detectPanicDefensives,与 keyMoments.ts 的 defensive 恐慌注记同一谓词)——
   * 未见明显敌方威胁下按下的大件。 */
  panic?: boolean;
}

export interface DeathRecap {
  unitId: string;
  unitName: string;
  /** 死亡时刻,相对秒。 */
  deathS: number;
  /** 死前 DEATH_RECAP_WINDOW_S 秒事件流(升序)。 */
  events: DeathRecapEvent[];
  /** 死亡时刻可用而未按的免疫/保命技(analysis deathOutcome 谓词)。 */
  availableImmunities: Array<{
    spellId: string;
    spellName: string;
    wasInCC: boolean;
    /** F166 同一谓词(findCheaperDefensiveAlternatives):死亡时刻还有哪些
     * 严格更省(更短 CD)的大件也可用而未按——供卡片追加"更省替代"提示。
     * 无匹配台账项或无更省选项时为空数组。 */
    cheaperAlternatives: string[];
  }>;
  /** 队友可给而没给的外部保命(施法者是否被控)。 */
  missedExternals: Array<{
    casterName: string;
    spellId: string;
    spellName: string;
    casterWasInCC: boolean;
  }>;
  /**
   * 减伤核算(A 形态,#17b Task4):死亡窗内死者身上**已激活**的白名单减伤
   * 逐条核算,数字直接来自 Task1 counterfactual.ts 的 computeMitigationAudit
   * ——渲染层不重新反推挡伤量。
   */
  mitigationAudit: IMitigationAuditRow[];
  /**
   * 反事实(B/窄门合并,仅 decisive):队友外置可用未给 + 自己可用未按,
   * 只保留「明显能活」档(诚实伦理,marginal/fatal 静默)。
   */
  counterfactuals: ICounterfactualHit[];
}

const DEF_TYPES = new Set(["immunities", "buffs_defensive"]);

/**
 * 友方每次死亡的回顾(backlog #6)。判定全部消费 analysis 谓词
 * (buildDeathOutcomeSummary / analyzePlayerCCAndTrinket)——渲染层不重造
 * 死亡判定,这是审计里双谓词病的教训。
 */
export function deriveDeathRecaps(source: ReportSource): DeathRecap[] {
  try {
    const legacy = toLegacySafe(source);
    const matchStartMs = legacy.startTime;
    // 覆盖双方死亡:己方死 = 防守复盘,敌方死 = 击杀执行复盘。
    const players = Object.values(legacy.units).filter((u) => u.info);
    if (players.length === 0) return [];

    const combatLike = {
      startTime: legacy.startTime,
      endTime: legacy.endTime,
      // legacy.startInfo.zoneId 是必填 string(toLegacyMatch 无条件构造
      // IStartInfo,见 parser-compat/src/{types,convert}.ts)——不需要任何
      // optional 兜底;上一版在这里转成 `{zoneId?: string} | undefined` 用
      // 强制类型断言压过编译器,复现的正是本次要修的那类 bug(压过检查后编译
      // 器就看不出"读了不存在的字段")。
      startInfo: { zoneId: legacy.startInfo.zoneId },
    };
    const allUnits = Object.values(legacy.units);
    const ccSummaries = players.map((p) => {
      const opponents = players.filter((o) => o.reaction !== p.reaction);
      const oppIds = new Set(opponents.map((o) => o.id));
      const oppPets = allUnits.filter(
        (u) => u.ownerId && oppIds.has(u.ownerId),
      );
      return analyzePlayerCCAndTrinket(p, opponents, combatLike, oppPets);
    });
    // I-1(reviewer finding):buildDeathOutcomeSummary 的 teammate/missedExternals
    // 循环内部不做阵营过滤(它信任调用方已经传入一份纯队友池——analysis 侧
    // 唯一的其它调用点 buildMatchContext.ts 正是这么用的:分开传 friends/
    // enemies)。这里此前把双方 `players` 整池当 friends 传入是本组件独有的
    // 用法(要覆盖两边死亡做复盘),于是一个还活着的敌方治疗被当成"queue 里
    // 的队友"塞进受害者的 missedExternals——战报会把敌人写成「本该救你的人」。
    // 按受害者阵营分两次调用,各自只喂同阵营池,再合并 events:两次调用内部
    // 各自的 teammate 循环天然只能扫到本队,不改 buildDeathOutcomeSummary 本身。
    const friendlyPlayers = players.filter(
      (p) => p.reaction === CombatUnitReaction.Friendly,
    );
    const hostilePlayers = players.filter(
      (p) => p.reaction === CombatUnitReaction.Hostile,
    );
    const outcomeCombat = {
      startTime: legacy.startTime,
      zoneId: legacy.startInfo.zoneId,
    };
    const outcomeEvents = [
      ...buildDeathOutcomeSummary(outcomeCombat, friendlyPlayers, ccSummaries)
        .events,
      ...buildDeathOutcomeSummary(outcomeCombat, hostilePlayers, ccSummaries)
        .events,
    ];
    // 减伤核算/反事实(#17b Task4):victimCds/ccSummary 与上面已算好的件按
    // unit.id 对齐,不重算——legacy 本身已有 startTime/endTime/units,直接
    // 喂给 Task1 的三个函数(与 keyMoments.ts 的 extractMajorCooldowns(u,
    // legacy) 同一用法)。
    const cdsByUnit = new Map<string, IMajorCooldownInfo[]>(
      players.map((p) => [p.id, extractMajorCooldowns(p, legacy)]),
    );
    const ccSummaryByUnit = new Map(
      players.map((p, i) => [p.id, ccSummaries[i]!]),
    );
    // 恐慌性使用(#10 T5):门规谓词即规范——直接消费 analysis 的
    // detectPanicDefensives(与 keyMoments.ts 的 defensive 恐慌注记同一份判定),
    // 按受害者阵营分两次调用(与上面 buildDeathOutcomeSummary 同一理由:
    // 该函数内部不做阵营过滤,friends/enemies 必须各喂同阵营池)。
    const panicsFriendly = detectPanicDefensives(
      friendlyPlayers,
      hostilePlayers,
      combatLike,
    );
    const panicsHostile = detectPanicDefensives(
      hostilePlayers,
      friendlyPlayers,
      combatLike,
    );
    const panicsFor = (reaction: CombatUnitReaction) =>
      reaction === CombatUnitReaction.Friendly ? panicsFriendly : panicsHostile;

    const nameOf = (id: string): string => legacy.units[id]?.name ?? "unknown";

    const recaps: DeathRecap[] = [];
    for (const unit of players) {
      for (const death of unit.deathRecords) {
        const deathS = (death.timestamp - matchStartMs) / 1000;
        const fromS = deathS - DEATH_RECAP_WINDOW_S;
        const events: DeathRecapEvent[] = [];

        const clampPct = (v: number) => Math.min(100, Math.max(0, v));
        /** 事件前后血量:同时间戳 advanced 样本 = 落地后 HP;前值 = 后值回推本事件数额。
         * amountTowardBefore:dmg 为 +|amount|(之前更高),heal 为 −amount(之前更低)。 */
        const hpRangeAt = (
          tsMs: number,
          amountTowardBefore: number,
        ): { hpBeforePct: number; hpAfterPct: number } | undefined => {
          const sample = unit.advancedActions.find(
            (a) => a.logLine?.timestamp === tsMs,
          );
          if (!sample || sample.advancedActorMaxHp <= 0) return undefined;
          const max = sample.advancedActorMaxHp;
          const hpAfterPct = clampPct(
            (sample.advancedActorCurrentHp / max) * 100,
          );
          const hpBeforePct = clampPct(
            hpAfterPct + (amountTowardBefore / max) * 100,
          );
          return { hpBeforePct, hpAfterPct };
        };

        // 承伤(日志符号约定:原始伤害为负 → Math.abs)
        for (const d of unit.damageIn) {
          const tS = (d.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          events.push({
            tS,
            kind: "dmg",
            spell: displaySpellName(d.spellId ?? "", d.spellName ?? ""),
            spellId: d.spellId,
            amount: Math.abs(d.effectiveAmount),
            srcName: nameOf(d.srcUnitId),
            ...hpRangeAt(d.logLine.timestamp, Math.abs(d.effectiveAmount)),
          });
        }
        // 承疗
        for (const h of unit.healIn) {
          const tS = (h.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          if (h.effectiveAmount <= 0) continue;
          events.push({
            tS,
            kind: "heal",
            spell: displaySpellName(h.spellId ?? "", h.spellName ?? ""),
            spellId: h.spellId,
            amount: h.effectiveAmount,
            srcName: nameOf(h.srcUnitId),
            ...hpRangeAt(h.logLine.timestamp, -h.effectiveAmount),
          });
        }
        // 身上被贴的控制(curated cc 分类)
        for (const a of unit.auraEvents) {
          if (a.logLine.event !== LogEvent.SPELL_AURA_APPLIED) continue;
          if (SPELL_CATEGORIES[a.spellId ?? ""]?.type !== "cc") continue;
          const tS = (a.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          events.push({
            tS,
            kind: "cc",
            spell: displaySpellName(a.spellId ?? "", a.spellName ?? ""),
            spellId: a.spellId,
            srcName: nameOf(a.srcUnitId),
          });
        }
        // 自己按下的防御技;恐慌性使用(#10 T5)按 (spellId, 施法者名, ~秒)
        // 对齐 detectPanicDefensives 的输出——同一份判定,不在这里重造。
        const panics = panicsFor(unit.reaction);
        for (const c of unit.spellCastEvents) {
          if (c.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
          if (!DEF_TYPES.has(SPELL_CATEGORIES[c.spellId ?? ""]?.type ?? ""))
            continue;
          const tS = (c.logLine.timestamp - matchStartMs) / 1000;
          if (tS < fromS || tS > deathS) continue;
          const panic = panics.some(
            (p) =>
              p.spellId === c.spellId &&
              p.casterName === unit.name &&
              Math.abs(p.timeSeconds - tS) < 1,
          );
          events.push({
            tS,
            kind: "def_used",
            spell: displaySpellName(c.spellId ?? "", c.spellName ?? ""),
            spellId: c.spellId,
            srcName: unit.name,
            ...(panic ? { panic: true } : {}),
          });
        }
        events.sort((a, b) => a.tS - b.tS);

        // deathOutcome 事件按 (名字, 秒) 对齐
        const oc = outcomeEvents.find(
          (e) =>
            e.deadPlayer === unit.name && Math.abs(e.atSeconds - deathS) < 1,
        );

        // 减伤核算/反事实(#17b Task4):三个函数同调一次 deathS,数字同源
        // ——卡片不重新推导挡伤/省伤量,只消费 Task1 的返回值。
        const victimCds = cdsByUnit.get(unit.id) ?? [];
        const victimCcSummary = ccSummaryByUnit.get(unit.id);
        const mitigationAudit = computeMitigationAudit(
          unit,
          legacy,
          deathS,
        ).rows;
        const counterfactuals: ICounterfactualHit[] = [
          ...(victimCcSummary
            ? computeUnusedSelfCounterfactuals(
                unit,
                victimCds,
                victimCcSummary,
                legacy,
                deathS,
              )
            : []),
          ...computeMissedExternalCounterfactuals(
            oc?.missedExternals ?? [],
            unit,
            legacy,
            deathS,
          ),
        ];

        recaps.push({
          unitId: unit.id,
          unitName: unit.name,
          deathS,
          events,
          // 更省替代(#10 T5,F166 同一谓词):按 spellId 对齐该未按大件在
          // victimCds 台账里的项,喂给 findCheaperDefensiveAlternatives 找
          // 死亡时刻还可用的更短 CD 选项——台账查无此项(未入账/非大件)时
          // 静默给空数组,不假装有替代。
          availableImmunities: (oc?.availableImmunities ?? []).map((i) => {
            const cd = victimCds.find((c) => c.spellId === i.spellId);
            return {
              spellId: i.spellId,
              spellName: i.spellName,
              wasInCC: i.wasInCC,
              cheaperAlternatives: cd
                ? findCheaperDefensiveAlternatives(cd, victimCds, deathS, {})
                : [],
            };
          }),
          missedExternals: (oc?.missedExternals ?? []).map((m) => ({
            casterName: m.casterName,
            spellId: m.spellId,
            spellName: m.spellName,
            casterWasInCC: m.casterWasInCC,
          })),
          mitigationAudit,
          counterfactuals,
        });
      }
    }
    return recaps.sort((a, b) => a.deathS - b.deathS);
  } catch {
    return [];
  }
}
