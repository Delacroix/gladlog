import {
  analyzeOutgoingCCChains,
  type IOutgoingCCApplication,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import { overlapSeconds, type TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

export interface CCChainRow {
  targetName: string;
  targetSpec: string;
  /** classColor 用;按目标名从 legacy.units 反查,查不到时留空(不画色点)。 */
  targetClassId?: number;
  chainLen: number;
  totalCcSeconds: number;
  /** 链内是否有落在 25% DR 或免疫档的应用(浪费的控制)。 */
  wasted: boolean;
  apps: IOutgoingCCApplication[];
}

const EMPTY: { rows: CCChainRow[] } = { rows: [] };

/**
 * 敌方 CC 链面板(#10 T5):我方对每个敌方目标造成的控制链聚合,DR 降级/免疫
 * 标红。判定全部消费 analysis 的 analyzeOutgoingCCChains(与时间轴 [DR] 标注
 * 同一谓词)——drAnalysis.ts:311-318 明确禁止按 DR 等级过滤,这里同样不过滤,
 * 只在展示层聚合。
 *
 * range(时间窗联动①):DR 序列在全量流上算(链长/降级判定不受窗口边界影响,
 * 否则窗口内第一条应用会被误判成 Full),之后按展示层过滤 apps——CC 应用是
 * 「时长事实」(有 atSeconds+durationSeconds),按 timeRange.ts 的谓词用重叠秒数
 * 判定(与 statsTable.ts 的 CC 实例过滤/计时同一谓词),不是瞬时事件的
 * tInRange:否则一条起点在窗口外、但大半段落在窗口内的应用会被整条丢弃
 * (agy flash 复核抓到,已采纳)。
 */
export function deriveCCChainDash(
  source: ReportSource,
  range?: TimeRange | null,
): { rows: CCChainRow[] } {
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

    const classIdByName = new Map(
      Object.values(legacy.units).map((u) => [u.name, Number(u.class)]),
    );

    const chains = analyzeOutgoingCCChains(friends, enemies, legacy);
    const rows: CCChainRow[] = [];
    for (const chain of chains) {
      // 重叠 >0 即计入(跨界不整段消失,与 statsTable.ts 的 CC 实例口径一致);
      // apps 里保留应用原始的 durationSeconds(逐条明细要展示真实持续时长,
      // 不是被窗口裁剪后的片段),只有聚合列 totalCcSeconds 按重叠部分累加。
      const apps = chain.applications.filter(
        (a) => overlapSeconds(a.atSeconds, a.durationSeconds, range) > 0,
      );
      if (apps.length === 0) continue;
      rows.push({
        targetName: chain.targetName,
        targetSpec: chain.targetSpec,
        targetClassId: classIdByName.get(chain.targetName),
        chainLen: apps.length,
        totalCcSeconds: apps.reduce(
          (sum, a) =>
            sum + overlapSeconds(a.atSeconds, a.durationSeconds, range),
          0,
        ),
        wasted: apps.some(
          (a) => a.drInfo.level === "25%" || a.drInfo.level === "Immune",
        ),
        apps,
      });
    }
    return { rows: rows.sort((a, b) => b.chainLen - a.chainLen) };
  } catch {
    return EMPTY;
  }
}
