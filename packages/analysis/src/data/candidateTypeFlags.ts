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
 *
 * `manaPressure`(BACKLOG #26 Task 3, 2026-08-15,raw-streams 计划):healer OOM
 * 窗 × 被拒施法意图候选(candidateFindings.ts 的 `manaPressureEvents`)——本次
 * 新增,默认 false,尚未走 Task 6 语料标定 / Task 7 独立 A/B,开关关时生产零
 * 变化(负断言测试 pin 住)。上线路径与四个 P1/P2 类型相同:标定→A/B→用户裁决
 * 翻 true,不与它们一起裁决。
 *
 * `manaEfficiency`(BACKLOG #26 Task 4, 2026-08-15,raw-streams 计划):全场聚合
 * 型「蓝效审计」——健疗法术耗蓝占比 vs 有效治疗占比的比值低于地板
 * (candidateFindings.ts 的 `manaEfficiencyEvents`,消费 Task 4 新增的
 * `SpellPower` datagen 表 `spellManaCostGenerated.json`)。一场至多 1 条,与
 * `manaPressure` 同款状态:默认 false,尚未走 Task 6/Task 7,开关关时生产零
 * 变化。
.
 *
 * `attemptIntoTrinket`(2026-08-18,击杀尝试重设计):打在有徽章目标上的失败
 * 尝试、且同刻存在 prime 目标(candidateFindings.ts 装配
 * `attemptIntoTrinketEvents`,提取器 utils/killAttempts.ts)。默认 true ——
 * 用户当日拍板接线(GH #16,三档模型 8,791 次晕落地验证在前),与 P1/P2
 * 「先标定再裁决」路径不同:判据本身即当日验证产物。
 */
export const CANDIDATE_TYPE_FLAGS: Record<
  | "missedSyncWindow"
  | "unsyncedBurst"
  | "cdHoarded"
  | "cdSpentIdle"
  | "manaPressure"
  | "manaEfficiency"
  | "attemptIntoTrinket",
  boolean
> = {
  // 下架 2026-08-19(GH #13,用户裁定)。判别力实测为负(−4.4pp)的根因
  // 拆解:①机会分母混杂 —— 胜局场均 8.30 个敌奶硬控窗 vs 负局 7.19,发生率
  // 型指标量的是控场能力;②洗掉分母后按机会归一化的转化率 **胜 26.7% vs
  // 负 27.8%,持平** —— 「打满这些窗口」的行为本身不区分胜负,信号前提
  // 不成立;③实现噪声:43.1% 被指控窗口 <2.5s(塞不下一个 GCD)、21.4%
  // 窗口前 6s 内团队刚摁过进攻大招。修实现救不回 ②,故下架而非收紧。
  // 纯函数 missedSyncWindowEvents 与其测试保留(测试自行翻 flag)。
  missedSyncWindow: false,
  unsyncedBurst: true,
  cdHoarded: true,
  cdSpentIdle: true,
  manaPressure: false,
  manaEfficiency: false,
  attemptIntoTrinket: true,
};
