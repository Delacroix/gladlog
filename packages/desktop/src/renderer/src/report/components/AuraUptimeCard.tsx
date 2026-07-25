import { useState } from "react";

import { classColor } from "../data/gameConstants";
import type { AuraUptime, AuraUptimeRow } from "../derive/auraUptime";
import type { TimeRange } from "../derive/timeRange";

const BAR_W = 420;

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 光环 uptime 卡(第四阶段④):按单位分组(P1-2)—— 组头(职业色 + 名字)+
 * 组内行缩进;条区共享 0:00/mid/end 刻度 + 50% 竖线;卡头类别图例。
 * 推断段(开局已挂/未见掉落)画虚线边,不冒充观测;时间窗激活时条上画选区、
 * 占比按窗口算(与其余面板同口径)。
 */
export function AuraUptimeCard({
  data,
  range,
}: {
  data: AuraUptime;
  range?: TimeRange | null;
}) {
  const { groups, durationS } = data;
  const [openUnits, setOpenUnits] = useState<Set<string>>(new Set());
  if (groups.length === 0) return null;
  const x = (s: number) => (s / durationS) * BAR_W;

  const auraRow = (r: AuraUptimeRow) => (
    <tr
      key={`${r.unitId}:${r.spellId}`}
      className={r.reaction === "Hostile" ? "rpt-stats-enemy" : ""}
    >
      <td className="rpt-aura-spell rpt-aura-indent">{r.spellName}</td>
      <td className="rpt-aura-bar-cell">
        <svg
          viewBox={`0 0 ${BAR_W} 12`}
          className="rpt-aura-bar"
          preserveAspectRatio="none"
        >
          <rect
            x={0}
            y={0}
            width={BAR_W}
            height={12}
            className="rpt-aura-track"
          />
          <line
            x1={BAR_W / 2}
            y1={0}
            x2={BAR_W / 2}
            y2={12}
            className="rpt-aura-midline"
          />
          {range && (
            <rect
              x={x(range.fromS)}
              y={0}
              width={Math.max(1, x(range.toS) - x(range.fromS))}
              height={12}
              className="rpt-aura-window"
            />
          )}
          {r.intervals.map((iv, k) => (
            <rect
              key={k}
              x={x(iv.fromS)}
              y={2}
              width={Math.max(1.5, x(iv.toS) - x(iv.fromS))}
              height={8}
              className={[
                `rpt-aura-seg rpt-aura-${r.kind}`,
                iv.inferredStart || iv.inferredEnd ? "rpt-aura-inferred" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <title>
                {`${r.spellName} ${iv.fromS.toFixed(1)}–${iv.toS.toFixed(1)}s` +
                  (iv.inferredStart ? "(开局前已挂,推断)" : "") +
                  (iv.inferredEnd ? "(未见掉落,推断至场终)" : "")}
              </title>
            </rect>
          ))}
        </svg>
      </td>
      <td className="rpt-aura-pct">
        {r.uptimePct}%<span className="rpt-stats-dim"> ×{r.applications}</span>
        {r.hasInferred && (
          <span className="rpt-stats-dim" title="含推断段(虚线)">
            {" "}
            ⌁
          </span>
        )}
      </td>
    </tr>
  );

  return (
    <div className="rpt-ledger" data-testid="aura-uptime">
      <div className="rpt-ledger-head">
        <span className="rpt-ledger-title">光环 uptime</span>
        {range && (
          <span className="rpt-stats-dim">
            占比按窗口 {Math.round(range.toS - range.fromS)}s 口径
          </span>
        )}
        <span className="rpt-aura-legend">
          {(
            [
              ["offense", "进攻"],
              ["defense", "防御"],
              ["cc", "控制"],
            ] as const
          ).map(([k, label]) => (
            <span key={k} className="rpt-aura-legend-item">
              <svg viewBox="0 0 10 8" width={10} height={8}>
                <rect
                  width={10}
                  height={8}
                  className={`rpt-aura-seg rpt-aura-${k}`}
                />
              </svg>
              {label}
            </span>
          ))}
        </span>
      </div>
      <table className="rpt-stats rpt-aura-table">
        <tbody>
          {/* 共享刻度行:条区 0:00 / mid / end 三刻度 */}
          <tr className="rpt-aura-scale-row">
            <td />
            <td className="rpt-aura-bar-cell">
              <div className="rpt-aura-scale">
                <span>0:00</span>
                <span>{fmtT(durationS / 2)}</span>
                <span>{fmtT(durationS)}</span>
              </div>
            </td>
            <td />
          </tr>
          {groups.map((g) => {
            const open = openUnits.has(g.unitId);
            return [
              <tr
                key={`h:${g.unitId}`}
                className={[
                  "rpt-aura-group-head",
                  g.reaction === "Hostile" ? "rpt-stats-enemy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td colSpan={3}>
                  <span
                    className="rpt-aura-glyph"
                    style={{ background: classColor(g.classId) }}
                  />
                  {g.unitName.split("-")[0]}
                </td>
              </tr>,
              ...g.rows.map(auraRow),
              ...(open ? g.hiddenRows.map(auraRow) : []),
              g.hiddenRows.length > 0 && !open ? (
                <tr key={`m:${g.unitId}`}>
                  <td colSpan={3}>
                    <button
                      className="rpt-aura-more"
                      onClick={() =>
                        setOpenUnits((cur) => new Set(cur).add(g.unitId))
                      }
                    >
                      +{g.hiddenRows.length} 更低占比光环
                    </button>
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
