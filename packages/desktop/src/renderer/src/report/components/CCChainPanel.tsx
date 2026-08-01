import { useState } from "react";

import { DR_LEVEL_LABEL } from "@gladlog/analysis";

import { classColor } from "../data/gameConstants";
import type { CCChainRow } from "../derive/ccChainDash";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 敌方 CC 链面板(#10 T5):我方对每个敌方目标造成的控制链聚合(链长/总时长)+
 * 行展开逐条 DR 档位,25%/免疫标红(浪费的控制)。判定全部消费 analysis 的
 * analyzeOutgoingCCChains(与时间轴 [DR] 标注同一谓词),不重造 DR 序列。
 * 惯例照搬 KickDashboard(行展开/空态卡壳/▶ 跳回放)。
 */
export function CCChainPanel({
  rows,
  onSeek,
}: {
  rows: CCChainRow[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // 空数据保留卡壳(P1-1):短回合无控制链时功能仍可发现
  if (rows.length === 0)
    return (
      <div className="rpt-ledger" data-testid="cc-chain-dash">
        <div className="rpt-ledger-head">
          <span className="rpt-ledger-title">敌方 CC 链</span>
        </div>
        <p className="rpt-ledger-empty">
          本场未对敌方造成过控制链 —— 长局中此处显示每个敌方目标的控制链长度/
          总时长与 DR 降级情况。
        </p>
      </div>
    );
  return (
    <div className="rpt-ledger" data-testid="cc-chain-dash">
      <div className="rpt-ledger-head">
        <span className="rpt-ledger-title">敌方 CC 链</span>
      </div>
      <table className="rpt-stats">
        <thead>
          <tr>
            <th>目标</th>
            <th>链长</th>
            <th>总控时长</th>
            <th>DR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const expanded = !!open[r.targetName];
            return [
              <tr
                key={r.targetName}
                className="rpt-stats-enemy rpt-stats-expandable"
                onClick={() =>
                  setOpen((o) => ({ ...o, [r.targetName]: !o[r.targetName] }))
                }
              >
                <td>
                  {r.targetClassId !== undefined && (
                    <span
                      className="rpt-meter-dot"
                      style={{
                        background: classColor(r.targetClassId),
                        borderColor: classColor(r.targetClassId),
                      }}
                    />
                  )}
                  {r.targetName}
                  <span className="rpt-stats-caret">
                    {expanded ? " ▾" : " ▸"}
                  </span>
                </td>
                <td>{r.chainLen}</td>
                <td>{r.totalCcSeconds.toFixed(1)}s</td>
                <td>
                  {r.wasted ? (
                    <span className="rpt-ledger-chip rpt-ledger-chip-bad">
                      浪费
                    </span>
                  ) : (
                    <span className="rpt-stats-dim">—</span>
                  )}
                </td>
              </tr>,
              expanded ? (
                <tr key={`${r.targetName}-d`} className="rpt-stats-detail-row">
                  <td colSpan={4}>
                    <div className="rpt-stats-detail-group">
                      {r.apps.map((a, i) => {
                        const isWasted =
                          a.drInfo.level === "25%" ||
                          a.drInfo.level === "Immune";
                        return (
                          <span
                            key={`${a.atSeconds}-${a.spellId}-${i}`}
                            className="rpt-stats-detail-item"
                          >
                            <span className="rpt-stats-detail-t">
                              {fmtT(a.atSeconds)}
                            </span>{" "}
                            {a.spellName} · {a.casterName} ·{" "}
                            {isWasted ? (
                              <span className="rpt-ledger-chip rpt-ledger-chip-bad">
                                {DR_LEVEL_LABEL[a.drInfo.level]}
                              </span>
                            ) : (
                              DR_LEVEL_LABEL[a.drInfo.level]
                            )}
                            {onSeek && (
                              <button
                                className="rpt-stats-detail-jump"
                                title="回放此刻"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  onSeek(Math.max(0, a.atSeconds - 3), [
                                    a.casterName,
                                    r.targetName,
                                  ]);
                                }}
                              >
                                ▶
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
