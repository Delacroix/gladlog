import {
  buildDeepDivePack,
  buildMatchContext,
  buildOffensiveDeepDivePack,
  classifyFindingKind,
  DEEP_DIVE_MAX,
  extractCandidateFindings,
  hasCoachableSignal,
  hasOffensiveCoachableSignal,
  isHealerSpec,
  SEVERITY_RANK,
  specToString,
  type DeepDivePack,
  type Finding,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

export type AnalysisRunInput = {
  matchId: string;
  candidates: ReturnType<typeof extractCandidateFindings>;
  richContext: string;
  spec: string;
  ownerName: string;
  enemySpecs: number[];
};

/**
 * 单盘分析的输入构建 —— StructuredAnalysisPanel 与批量驱动器共用的唯一入口
 * (谓词单源:owner 解析、candidates、richContext 两个消费者不许分叉)。
 *
 * 前置契约:调用前必须 await ensureAnalysisData()(提示词法术名不许降级,
 * 见 analysis 的 data/ensure.ts)。panel 用 dataReady 门,批量起跑前 await 一次。
 */
export function buildAnalysisInput(
  source: ReportSource,
  matchId: string,
): AnalysisRunInput | null {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    // owner = 日志记录者(playerId);找不到时回退友方治疗(旧行为)。
    const owner =
      players.find(
        (u) =>
          u.id === legacy.playerId &&
          u.reaction === CombatUnitReaction.Friendly,
      ) ??
      players.find(
        (u) =>
          isHealerSpec(u.spec) && u.reaction === CombatUnitReaction.Friendly,
      );
    if (!owner) return null;

    const candidates = extractCandidateFindings(legacy, owner.id);
    const friends = players.filter((u) => u.reaction === owner.reaction);
    const enemies = players.filter((u) => u.reaction !== owner.reaction);

    const richContext = buildMatchContext(legacy, friends, enemies, {
      useTimelinePrompt: true,
      owner,
    });
    const spec = specToString(owner.spec);

    return {
      matchId,
      candidates,
      richContext,
      spec,
      ownerName: owner.name,
      enemySpecs: enemies.map((u) => Number(u.spec)).filter((s) => s > 0),
    };
  } catch {
    return null;
  }
}

/**
 * 深挖轮证据包构建(初轮 findings → 生存席 ≤DEEP_DIVE_MAX + 进攻保底一席),
 * 同为 panel 深挖 effect 与批量驱动器的共享路径。构包失败返回空数组
 * (深挖不致命,保持初轮)。
 */
export function buildDeepenPacks(
  source: ReportSource,
  findings: Finding[],
  candidates: AnalysisRunInput["candidates"],
  ownerName?: string,
): DeepDivePack[] {
  try {
    const legacy = toLegacySafe(source);
    const ranked = findings
      .map((f, i) => ({ f, i }))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.f.severity] ?? 9) -
            (SEVERITY_RANK[b.f.severity] ?? 9) || a.i - b.i,
      );
    // 生存席:按严重度取 ≤DEEP_DIVE_MAX 个死亡类过门 pack;进攻保底一席
    const survivalPacks: DeepDivePack[] = [];
    const offensivePacks: DeepDivePack[] = [];
    for (const { f, i } of ranked) {
      const kind = classifyFindingKind(f, candidates);
      if (kind === "survival") {
        if (survivalPacks.length >= DEEP_DIVE_MAX) continue;
        const pack = buildDeepDivePack(legacy, f, i, candidates, ownerName);
        // 可教信号门:干净窗口不深挖,避免硬编套话
        if (pack && hasCoachableSignal(pack.items)) survivalPacks.push(pack);
      } else {
        if (offensivePacks.length >= 1) continue; // OFFENSIVE_DEEP_DIVE_MAX = 1
        const pack = buildOffensiveDeepDivePack(
          legacy,
          f,
          i,
          candidates,
          ownerName,
        );
        if (pack && hasOffensiveCoachableSignal(pack.items))
          offensivePacks.push(pack);
      }
    }
    return [...survivalPacks, ...offensivePacks];
  } catch {
    return [];
  }
}
