import { fmtTime } from "@gladlog/analysis";

import type { UncoveredHighlight } from "../derive/uncoveredHighlights";
import type { TimeRange } from "../derive/timeRange";

/**
 * 未覆盖亮点卡(BACKLOG #13):AI 分析视图 findings 区下方,展示自动滑窗
 * 找到的、现有分析没碰过的可教时段。零亮点时不渲染(零噪音 —— 干净局/
 * 已被 findings+失误清单充分覆盖的局,不该看到一张空卡)。
 *
 * 点击【AI 分析此段】=设置该窗口的时间范围 + 触发 #16 的 runWindowAi——
 * 零新 IPC,复用选段分析既有链路(缓存/force 语义原样继承)。
 */
export function UncoveredHighlightsCard({
  highlights,
  onAnalyze,
}: {
  highlights: UncoveredHighlight[];
  onAnalyze: (range: TimeRange) => void;
}) {
  if (highlights.length === 0) return null;
  return (
    <div className="rpt-ledger" data-testid="uncovered-highlights-card">
      <div className="rpt-ledger-head">
        <span className="rpt-ledger-title">未覆盖亮点</span>
      </div>
      <div className="rpt-ledger-section">
        {highlights.map((h, i) => (
          <div
            key={`${h.range.fromS}-${h.range.toS}`}
            className="rpt-ledger-row"
          >
            <span>
              {fmtTime(h.range.fromS)}–{fmtTime(h.range.toS)}
            </span>
            <span className="rpt-ledger-spells">{h.summary}</span>
            <button
              className="rpt-finding-toggle"
              data-testid={`uncovered-highlight-btn-${i}`}
              onClick={() => onAnalyze(h.range)}
            >
              AI 分析此段
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
