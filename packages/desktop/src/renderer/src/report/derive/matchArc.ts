import {
  extractMajorCooldowns,
  reconstructEnemyCDTimeline,
  specToString,
} from "@gladlog/analysis";
import {
  buildMatchArcStructured,
  type IMatchArcPhase,
} from "@gladlog/analysis/src/context/matchNarrative";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { resolveOwner } from "./analysisInput";
import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

/**
 * 比赛节奏头部行(#10 T4)。只负责组装 T1 的 `buildMatchArcStructured` 入参——
 * 与 keyMoments.ts 相同的 legacy/owner/friends/enemies 组装模式(:129 敌方
 * CD 时间线、:149 每个友方的 extractMajorCooldowns)——相位边界/转折点的
 * 判定逻辑单源在 buildMatchArcStructured,这里不重算。
 *
 * stub-safe:任何一步失败(缺字段/坏 fixture)都吞掉返回 []——头部行是锦上
 * 添花,不该拖垮整页战报。
 */
export function deriveMatchArc(source: ReportSource): IMatchArcPhase[] {
  try {
    const legacy = toLegacySafe(source);
    const units = Object.values(legacy.units);
    const players = units.filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction !== CombatUnitReaction.Friendly,
    );
    // agy 复核:owner 解析复用 analysisInput.ts 的 resolveOwner(谓词单源)——
    // 它比裸 find(id===playerId) 多一道 reaction===Friendly 校验 + 治疗兜底,
    // 与 buildAnalysisInput/buildWindowAnalysisRequest 是同一个「谁是 owner」
    // 判据,不在这里另起一套。
    const owner = resolveOwner(legacy) ?? friends[0];

    const enemyCDTimeline = reconstructEnemyCDTimeline(
      enemies,
      legacy,
      owner,
      friends,
    );
    const allTeamCooldownsWithPlayer = friends.flatMap((u) =>
      extractMajorCooldowns(u, legacy).map((cd) => ({ player: u, cd })),
    );
    // 同 buildMatchContext.ts 的 friendlyDeaths 谓词(门规谓词即规范):
    // filter(deathRecords.length>0).flatMap(...).sort(atSeconds)。
    const friendlyDeaths = friends
      .filter((u) => (u.deathRecords ?? []).length > 0)
      .flatMap((u) =>
        (u.deathRecords ?? []).map((d) => ({
          spec: specToString(u.spec),
          atSeconds: (d.timestamp - legacy.startTime) / 1000,
        })),
      )
      .sort((a, b) => a.atSeconds - b.atSeconds);
    const durationSeconds = (legacy.endTime - legacy.startTime) / 1000;

    return buildMatchArcStructured(
      enemyCDTimeline,
      allTeamCooldownsWithPlayer,
      friendlyDeaths,
      durationSeconds,
      legacy.startInfo.bracket,
    );
  } catch {
    return [];
  }
}
