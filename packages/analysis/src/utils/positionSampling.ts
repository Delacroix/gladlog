/**
 * 位置采样谓词(单源)—— 分析侧与 eval 门规侧共用的常量。
 *
 * 为什么单独一个模块:CLAUDE.md 的门规谓词即规范要求「同一个事实用同一个谓词:
 * 同一常量、同一采样函数、同一容差」,且「谓词放一处 export,两边 import;
 * 做不到时写断言相等的单测,别靠注释」。
 *
 * 这些常量此前散在四处私有声明,靠 healerExposureAnalysis.ts 里一句
 * 「MUST stay equal to … positioningScan.ts」的注释耦合 —— 正是该规则明令
 * 禁止的形态。2026-07 全量审计里 5 个独立 bug 全是这一类(HP 采样半径不一致、
 * 有界 vs 无界回溯、插值 vs raw 采样、小数秒 vs 渲染秒网格),所以这里改成
 * 真正的单源 export。
 *
 * 注意两个常量语义不同,不要因为都叫「gap」就混用:
 *  - LOS_SWEEP_GAP_MS  = LoS 扫描判定用,分析与门规必须逐字节相同,否则门规
 *                        复算不出分析的结论(或反过来放行了幻觉主张)。
 *  - INTERP_MAX_GAP_MS = 单点位置插值的 grounding 守卫,比前者严得多 ——
 *                        采样间隔超过它就认为插值是编的(单位 idle/潜行)。
 *    它**不该**等于 LOS_SWEEP_GAP_MS,历史上因为两者都曾叫
 *    POSITION_MAX_GAP_MS(值 1500 vs 3000)而极易看串。
 */

/** LoS 扫描的时间松弛(秒):锚点 ±N 秒按整秒网格扫描。分析与门规必须相同。 */
export const LOS_SWEEP_SLACK_S = 2;

/** LoS 扫描的位置插值最大采样间隔(毫秒)。分析与门规必须相同。 */
export const LOS_SWEEP_GAP_MS = 3_000;

/**
 * 单点位置插值的 grounding 守卫(毫秒)。超过此间隔的插值位置视为伪造 ——
 * 陈旧位置会声称存在 LoS,而真实采样显示早已断开,进而产出「去断视线」的
 * 假建议(2026-07-14 全量审计 G5)。
 */
export const INTERP_MAX_GAP_MS = 1_500;

// ---------------------------------------------------------------------------
// CC 距离的两个上限 —— 是两个事实,不是一个
// ---------------------------------------------------------------------------
//
// 2026-08-01 谓词索引调查发现这里曾有三个互不相干的数(45 / 40 / 50),三处注释
// 都自称是「CC 的最大距离」。研究后的结论(勿再各写一份):
//
//  A. 施法射程(CC_MAX_CAST_RANGE_YARDS)——**能不能打到**。游戏里射程最远的
//     控制约 40 码(冰冻陷阱 / 日光术 / 和平之环)。用于前瞻判定:此刻站在 40 码
//     开外的敌人对治疗构不成 CC 威胁(healerExposureAnalysis)。
//  B. 观测距离上限(CC_MAX_PLAUSIBLE_RANGE_YARDS)——**算出来的这个数可不可信**。
//     针对**已经发生**的 CC:落地时刻两边都在动、位置来自插值、飞行物还有旅行
//     时间,所以复算距离**合法地**可以略大于射程。超过它就是坏数据,产出侧直接
//     抑制该距离(ccTrinketAnalysis),门规据此判 G6。
//
// 二者不是同一个事实,证据是语料本身:141237 条已渲染的 "Nyd from caster" 主张里
// 有 90 条落在 (40, 45],最大 44.7 —— 若 A 和 B 是同一个数,这 90 条不可能存在。
// 顺序关系(A ≤ B)由下面的**派生式**结构性保证,不靠注释也不靠单测。
//
// 门规侧曾另写 IMPOSSIBLE_CC_YARDS = 50,比产出侧的抑制阈值还宽 5 码,于是
// (45, 50] 这一段永远不可能被触发 —— 门规实为死代码。现在门规直接 import B,
// 变成「验证产出侧自己声明的契约」(与 G2 用 HEALER_TRAINED_YARDS 同形)。
// 语料实测收紧前后同判据:>50 = 0 条 → >45 = 0 条,行为不变、判据变强。

/**
 * 玩家 CC 技能的最大施法射程(码)。前瞻判定用:站在这之外的敌人无论有没有
 * 视线都落不到 CC。**不是**「复算距离的可信上限」,那是下面那条。
 */
export const CC_MAX_CAST_RANGE_YARDS = 40;

/**
 * 观测宽容量(码):已落地的 CC,其复算距离允许比施法射程多出这么多 ——
 * 位置插值误差 + 飞行物旅行时间 + 施法瞬间双方仍在移动。
 */
const CC_RANGE_OBSERVATION_SLACK_YARDS = 5;

/**
 * 已发生 CC 的复算距离可信上限(码)。产出侧超过它就抑制距离(宁可不出主张),
 * 门规侧超过它即 violation。刻意由射程 + 观测宽容量派生,保证永远 ≥ 射程。
 */
export const CC_MAX_PLAUSIBLE_RANGE_YARDS =
  CC_MAX_CAST_RANGE_YARDS + CC_RANGE_OBSERVATION_SLACK_YARDS;

/**
 * 「治疗被贴脸」的定义距离(码):敌方近战在这个半径内即算 camping。
 *
 * 产出侧(positionAnalysis 的 HEALER_TRAINED)按它判定并渲染主张,门规
 * (positioningScan 的 G2_TRAINED_DEFINITION)按它复核 —— 定义本身必须同源,
 * 否则门规验的是另一条定义。
 */
export const HEALER_TRAINED_YARDS = 8;

// ---------------------------------------------------------------------------
// 门规复算的采样时刻集合
// ---------------------------------------------------------------------------

/**
 * 门规复算时补的亚秒网格(毫秒)。getUnitPositionAtTime 是线性插值的,管线可在
 * 任意亚秒时刻取值;两单位采样时刻不重合时,交叉逼近的最小值只存在于采样点之间
 * (D2 实测:声明 1.7yd 为真、仅按采样时刻扫描给出 5.3yd 的假违规)。
 */
const GATE_SWEEP_GRID_MS = 250;

interface AdvancedSampleSource {
  advancedActions?: ReadonlyArray<{ timestamp: number }>;
}

/**
 * 门规复算某区间时该查哪些时刻(单源)。
 *
 * = 调用方给的锚点时刻 ∪ 区间内两单位的全部真实 advanced 采样时刻 ∪ 亚秒网格。
 * 这三层缺一不可:只查整秒会漏掉亚秒低谷,只查采样时刻会漏掉两边采样不重合时
 * 的交叉低谷。positioningScan 的 windowDistanceSpan 与 minDistanceInWindow 曾各
 * 抄一份,任何一份漏改就是「同一事实两套采样」。
 *
 * 注意:本函数**只**定义时刻集合,不定义容差 —— gap 容差由调用方按用途传入
 * (LOS_SWEEP_GAP_MS vs INTERP_MAX_GAP_MS,两者刻意不等)。
 */
export function positionSampleInstants(
  units: ReadonlyArray<AdvancedSampleSource>,
  fromMs: number,
  toMs: number,
  anchorInstants: ReadonlyArray<number> = [],
): number[] {
  const instants = new Set<number>(anchorInstants);
  for (const u of units) {
    for (const act of u.advancedActions ?? []) {
      if (act.timestamp >= fromMs && act.timestamp <= toMs)
        instants.add(act.timestamp);
    }
  }
  for (let ts = fromMs; ts <= toMs; ts += GATE_SWEEP_GRID_MS) instants.add(ts);
  return [...instants].sort((a, b) => a - b);
}
