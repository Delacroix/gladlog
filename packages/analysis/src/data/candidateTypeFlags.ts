/**
 * P1/P2 起爆候选类型开关(2026-08-15,distillation Task 4;2026-08-15 Task 9
 * 全部翻 true,用户裁决全量上线)。
 *
 * 四个新候选类型(missedSyncWindow / unsyncedBurst / cdHoarded / cdSpentIdle,
 * candidateFindings.ts 里对应 missedSyncWindowEvents / unsyncedBurstEvents /
 * cdHoardedEvents / cdSpentIdleEvents 四个纯函数)——检测器本身恒可用,菜单装
 * 配处(teamPlayEvents)按开关逐类过滤,四开关全 true 时生产 prompt 常规产出全
 * 部四类型(与 A/B 阶段的默认全 false 基线不再字节一致,这正是本次上线的目的)。
 *
 * 上线依据(用户 2026-08-15 裁决,A/B 报告 p1p2-ab-p1.md/p1p2-ab-p2.md):
 * missedSyncWindow 采纳 25.9%/审计 97.6%/filler 30.9→26.3;unsyncedBurst 采纳
 * 26.5%/审计 88.9%/整体审计 92.9 vs 96.9(用户知情开启,§29(b) 前置修复已完成
 * 见 candidateFindings.ts `unsyncedBurstEvents` 的 healerNames 数组);cdHoarded
 * 采纳 26.3%/filler 24.8→18.2;cdSpentIdle 采纳 21.4%/审计 100%/filler
 * +6.4pp(用户知情开启)。
 *
 * A/B harness 仍可按臂翻转单个字段跑逐类对照实验——照 dispelFeatureFlags.ts
 * 先例,故意留成可变的普通对象字面量(而非 readonly/as const),测试和 harness
 * 都是直接赋值翻转(`CANDIDATE_TYPE_FLAGS.xxx = false`),不建单独的
 * override/reset 机制。
 */
export const CANDIDATE_TYPE_FLAGS: Record<
  "missedSyncWindow" | "unsyncedBurst" | "cdHoarded" | "cdSpentIdle",
  boolean
> = {
  missedSyncWindow: true,
  unsyncedBurst: true,
  cdHoarded: true,
  cdSpentIdle: true,
};
