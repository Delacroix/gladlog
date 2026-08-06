import type { CandidateEvent } from "./types";

/** 同一次交手的聚簇窗(秒)。独立常量,语义≠deepDive 的 PACK_BEFORE_S。 */
export const HINDSIGHT_CLUSTER_SLACK_S = 30;

/**
 * 后视偏差谓词(spec 2026-08-06-hindsight-predicate-design 规则 1-3)。
 * 比较基于渲染事实 facts.t(菜单里模型看到的值);facts.t 缺失 = whole-round,
 * 不参与锚点计算也不豁免整条。
 */
export function hindsightViolations(
  eventIds: string[],
  byId: Map<string, CandidateEvent>,
): string[] {
  const timed = eventIds
    .map((id) => byId.get(id))
    .filter(
      (e): e is CandidateEvent => e !== undefined && e.facts.t !== undefined,
    )
    .map((e) => ({ e, t: Number(e.facts.t) }))
    .filter(({ t }) => Number.isFinite(t));
  if (timed.length < 2) return [];
  const anchorT = Math.min(...timed.map(({ t }) => t));
  const clusterTypes = new Set(
    timed
      .filter(({ t }) => t <= anchorT + HINDSIGHT_CLUSTER_SLACK_S)
      .map(({ e }) => e.type),
  );
  const out: string[] = [];
  for (const { e, t } of timed) {
    if (t - anchorT > HINDSIGHT_CLUSTER_SLACK_S && !clusterTypes.has(e.type)) {
      out.push(
        `hindsight: 引用了锚点 ${anchorT}s 之后 ${t}s 的 ${e.type} 事件,跨类型且超出 ${HINDSIGHT_CLUSTER_SLACK_S}s 聚簇窗`,
      );
    }
  }
  return out;
}
