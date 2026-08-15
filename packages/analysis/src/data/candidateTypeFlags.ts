/**
 * P1/P2 起爆候选类型开关(2026-08-15,distillation Task 4)。
 *
 * 四个新候选类型(missedSyncWindow / unsyncedBurst / cdHoarded / cdSpentIdle,
 * candidateFindings.ts 里对应 missedSyncWindowEvents / unsyncedBurstEvents /
 * cdHoardedEvents / cdSpentIdleEvents 四个纯函数,Task 2/3 已完成实现但故意未
 * 接线)默认全 false —— 检测器本身恒可用,菜单装配处(teamPlayEvents)按开关逐
 * 类过滤,四开关全 false 时生产 prompt 必须与今天字节一致。
 *
 * A/B harness(计划 Task 6/7)按臂翻转单个字段来跑逐类对照实验,用户拍板后再把
 * 通过的类型改回默认 true —— 照 dispelFeatureFlags.ts 先例,故意留成可变的普通
 * 对象字面量(而非 readonly/as const),测试和 harness 都是直接赋值翻转
 * (`CANDIDATE_TYPE_FLAGS.xxx = true`),不建单独的 override/reset 机制。
 */
export const CANDIDATE_TYPE_FLAGS: Record<
  "missedSyncWindow" | "unsyncedBurst" | "cdHoarded" | "cdSpentIdle",
  boolean
> = {
  missedSyncWindow: false,
  unsyncedBurst: false,
  cdHoarded: false,
  cdSpentIdle: false,
};
