import {
  buildWindowPack,
  extractCandidateFindings,
  PACK_ITEM_KIND_ZH,
  type CandidateEvent,
  type PackItem,
} from "@gladlog/analysis";

import { resolveOwner } from "./analysisInput";
import { toLegacySafe } from "./legacySource";
import type { TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

/**
 * BACKLOG #13 收官:未覆盖亮点自动滑窗。全场确定性扫窗,复用 #16 现成的
 * 信号门(`buildWindowPack` 非 null = 命中)——不重新实现任何 gate(谓词
 * 单源,见 CLAUDE.md 门规谓词即规范)。滑窗本身零模型成本:命中判定全靠
 * 既有确定性谓词,只有用户点了卡片上的按钮才会真正触发一次模型调用
 * (调用方复用 #16 的 runWindowAi,走独立的 `buildWindowAnalysisRequest`)。
 *
 * 性能(复核轮修复):滑窗直接调用 `buildWindowPack`(#16 真正的信号门原语),
 * 而不是每窗都调用点击路径用的 `buildWindowAnalysisRequest`——后者内部会
 * 重新 `toLegacySafe` + `resolveOwner` + `extractCandidateFindings`(全场
 * 日志遍历),这三步与"扫第几个窗口"无关,每窗重算一次纯属浪费:9 窗的
 * 90s fixture 上实测 `extractCandidateFindings` 单次 ~2.36ms,更长对局
 * (spec 估算 ~17 窗)会线性累积成可观的同步阻塞。这里把这三步提到循环外
 * 算一次(`buildSweepContext`),每窗只调 `buildWindowPack` 传同一份
 * candidates——测试断言 `extractCandidateFindings` 调用次数恒为 1,不随
 * 窗口数变化(结构性回归哨兵,不是脆弱的 ms 阈值)。
 */

interface SweepContext {
  legacy: ReturnType<typeof toLegacySafe>;
  ownerName: string;
  candidates: CandidateEvent[];
}

/** 全场只算一次的派生状态(与滑窗第几个窗口无关)。任何一步失败(owner 解析
 * 不出/legacy 转换抛错)都视为"这场无法滑窗",返回 null,调用方据此产出
 * 空亮点列表——与原 `buildWindowAnalysisRequest` 遇错返回 null 的防御姿态
 * 一致,不冒泡异常。 */
function buildSweepContext(source: ReportSource): SweepContext | null {
  try {
    const legacy = toLegacySafe(source);
    const owner = resolveOwner(legacy);
    if (!owner) return null;
    return {
      legacy,
      ownerName: owner.name,
      candidates: extractCandidateFindings(legacy, owner.id),
    };
  } catch {
    return null;
  }
}

/** 窗宽(秒)。产品拍板固定值,v1 不做可配置(spec 边界:不做可配置窗宽/步进)。 */
export const SWEEP_WINDOW_S = 20;
/** 步进(秒)。 */
export const SWEEP_STRIDE_S = 10;
/**
 * 去重容差(秒):窗口与既有锚点(初轮 findings 时间锚 / 确定性失误清单 tS)
 * 重叠即视为「已覆盖」。这是本卡片自己的确定性 UI 展示门槛,不参与
 * positioningScan/qualityCheck 的门规复算,所以不是"共享谓词"意义上必须
 * 与 eval 侧同名常量相等的那类值——但仍然单源导出,消费方与测试都从这里
 * import,不允许各处另起字面量 5。
 */
export const ANCHOR_TOLERANCE_S = 5;
/** 最终展示条数上限(信号密度降序取前 N)。 */
export const TOP_N = 3;

export interface UncoveredHighlight {
  range: TimeRange;
  /** zh 信号摘要,如「2 次 HP 轨迹 · 1 次防御施放」(kind 计数,出现顺序=
   * 首次出现顺序,不重排字母/频次 —— 与 items 时间序一致,读起来像时间线;
   * kind→中文词表见 `@gladlog/analysis` 的 `PACK_ITEM_KIND_ZH`)。 */
  summary: string;
  /** 排名依据:pack.items 条数(信号密度)。 */
  itemCount: number;
}

/** kind→中文用 `@gladlog/analysis` 的 `PACK_ITEM_KIND_ZH` 单源表(复核轮
 * 修复:此前这里本地另抄一份措辞不同的表,与 `buildWindowAnchorFinding`
 * 用来拼 prompt 正文的那份不一致)。 */
function summarizeKinds(items: readonly PackItem[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = PACK_ITEM_KIND_ZH[item.kind] ?? item.kind;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((label) => `${counts.get(label)} 次${label}`).join(" · ");
}

interface RawHit {
  fromS: number;
  toS: number;
}

/** 相邻/重叠命中窗合并(重叠即并,取并集边界)。hits 须已按 fromS 升序。 */
function mergeOverlapping(hits: readonly RawHit[]): RawHit[] {
  const merged: RawHit[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.fromS <= last.toS) {
      last.toS = Math.max(last.toS, hit.toS);
    } else {
      merged.push({ ...hit });
    }
  }
  return merged;
}

/**
 * 未覆盖亮点自动滑窗:全场 20s 窗、10s 步进跑 #16 同一信号门;与既有锚点
 * (±5s 容差)重叠的窗口丢弃 —— 只留「现有分析没碰过」的时段;命中窗合并
 * (取并集边界)后按信号密度(pack.items 数)降序排名,取 top 3。
 *
 * @param source 战报数据源。
 * @param durationS 全场时长(秒)——调用方传入(与 rangeDurationS(source) 同源,
 *   这里不重复解析 source.startTime/endTime,避免两处时长口径分叉)。
 * @param anchors 既有锚点时间点(秒):初轮 findings 的时间锚 ∪ 确定性失误
 *   清单(deriveMistakes)的 tS,调用方拼好后传入 —— 本函数只做去重几何,
 *   不关心锚点从哪来(谓词单源留在调用方拼装,这里保持纯函数好测)。
 */
export function deriveUncoveredHighlights(
  source: ReportSource,
  durationS: number,
  anchors: readonly number[],
): UncoveredHighlight[] {
  if (!(durationS > 0)) return [];
  const ctx = buildSweepContext(source);
  if (!ctx) return [];
  // 同一份 legacy/candidates/ownerName 喂给每一窗的 buildWindowPack——#16
  // 的信号门原语,零重新实现,只是不再让每窗自己重新派生这三样全场状态。
  const gate = (fromS: number, toS: number) => {
    try {
      return buildWindowPack(
        ctx.legacy,
        fromS,
        toS,
        ctx.candidates,
        ctx.ownerName,
      );
    } catch {
      return null;
    }
  };

  const raw: RawHit[] = [];
  for (let fromS = 0; fromS < durationS; fromS += SWEEP_STRIDE_S) {
    const toS = Math.min(fromS + SWEEP_WINDOW_S, durationS);
    const covered = anchors.some(
      (a) => a >= fromS - ANCHOR_TOLERANCE_S && a <= toS + ANCHOR_TOLERANCE_S,
    );
    if (covered) continue;
    if (!gate(fromS, toS)) continue;
    raw.push({ fromS, toS });
  }
  const merged = mergeOverlapping(raw);
  const ranked = merged
    .map((m): UncoveredHighlight | null => {
      // 并窗后重新构包:摘要/计数按并集窗口算,不是简单合并子窗口的计数
      // (子窗口证据有重叠,直接相加会重复计)。理论上加宽窗口不应该让门
      // 从"过"变"不过"(items 只增不减),这里的 null 分支是纵深防御,不是
      // 预期路径。窗口边界直接用合并后的 m.fromS/toS(由本函数的 for 循环
      // 生成,天然落在 [0, durationS] 内,不需要再夹一次)。
      const r = gate(m.fromS, m.toS);
      if (!r) return null;
      return {
        range: { fromS: m.fromS, toS: m.toS },
        summary: summarizeKinds(r.pack.items),
        itemCount: r.pack.items.length,
      };
    })
    .filter((h): h is UncoveredHighlight => h !== null)
    .sort((a, b) => b.itemCount - a.itemCount);
  return ranked.slice(0, TOP_N);
}
