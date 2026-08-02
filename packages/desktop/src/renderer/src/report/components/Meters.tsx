import { useEffect, useMemo, useState } from "react";

import { classGlyph } from "../data/gameConstants";
import { deriveDetailBreakdown } from "../derive/detailBreakdown";
import { type MeterMode, meterRows } from "../derive/meterRows";
import type { StatsRow } from "../derive/statsTable";
import type { UnitTotals } from "../derive/summary";
import type { TimeRange } from "../derive/timeRange";
import type { ReportSource } from "../derive/types";
import { BreakdownTable } from "./BreakdownTable";
import { StatsTable } from "./StatsTable";

const MODE_LABEL: Record<MeterMode, string> = {
  damage: "伤害",
  healing: "治疗",
  taken: "承伤",
  stats: "统计",
};

export function Meters({
  rows,
  mode,
  onMode,
  playerTeamId,
  hidden,
  onToggleUnit,
  statsRows,
  durationS,
  onSeek,
  source,
  range,
}: {
  rows: UnitTotals[];
  mode: MeterMode;
  onMode?: (m: MeterMode) => void;
  playerTeamId?: number | null;
  /** Set of hidden unitIds (used by the HP-curve filter); the matching rows
   * dim and their dots become hollow. */
  hidden?: Set<string>;
  onToggleUnit?: (unitId: string) => void;
  /** Data for the "stats" mode (backlog #10); when absent, that mode is not
   * shown. */
  statsRows?: StatsRow[];
  durationS?: number;
  /** Replay seek from the stats detail rows (v2). */
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  /** Data source for the expandable detail rows (backlog #11); when absent,
   * rows are not expandable (the older call shape). */
  source?: ReportSource;
  /** Time-window linkage (1): passed down to the detail breakdown so it uses
   * the same scope as the leaderboard totals. */
  range?: TimeRange | null;
}) {
  // Inline detail expansion: only one unit expanded at a time; switching mode
  // collapses it
  const [expandedUnitId, setExpandedUnitId] = useState<string | null>(null);
  useEffect(() => setExpandedUnitId(null), [mode]);
  const expandable = source != null && mode !== "stats";
  // Memoize the expanded data: Meters re-renders at high frequency (e.g. with
  // every replay tick), so it must not re-aggregate on every frame
  const expandedData = useMemo(
    () =>
      expandable && expandedUnitId
        ? deriveDetailBreakdown(
            source,
            expandedUnitId,
            mode as "damage" | "healing" | "taken",
            range,
          )
        : null,
    [expandable, source, expandedUnitId, mode, range],
  );
  const items = meterRows(rows, mode === "stats" ? "damage" : mode);
  const modes = (Object.keys(MODE_LABEL) as MeterMode[]).filter(
    (k) => k !== "stats" || (statsRows?.length ?? 0) > 0,
  );
  return (
    <div className="rpt-meters-card">
      <div className="rpt-meters-head">
        <span className="rpt-card-label">榜单模式</span>
        <div className="rpt-mode-seg">
          {modes.map((k) => (
            <button
              key={k}
              className={k === mode ? "active" : ""}
              onClick={() => onMode?.(k)}
            >
              {MODE_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      {mode === "stats" && statsRows ? (
        <StatsTable
          rows={statsRows}
          durationS={durationS ?? 1}
          onSeek={onSeek}
        />
      ) : (
        <div className="rpt-meters">
          {items.map((r) => {
            const enemy = playerTeamId != null && r.teamId !== playerTeamId;
            const off = hidden?.has(r.unitId) ?? false;
            const nameCls = [
              "rpt-meter-name",
              enemy ? "enemy" : "",
              off ? "off" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={r.unitId} className="rpt-meter-unit">
                <div
                  className={off ? "rpt-meter-row off" : "rpt-meter-row"}
                  title={`${r.name}: ${r.exactLabel}`}
                >
                  <button
                    type="button"
                    className={nameCls}
                    onClick={() => onToggleUnit?.(r.unitId)}
                  >
                    <span
                      className="rpt-meter-glyph"
                      style={
                        off
                          ? {
                              background: "transparent",
                              border: `1.5px solid ${r.color}`,
                              color: r.color,
                            }
                          : { background: r.color }
                      }
                    >
                      {classGlyph(r.classId)}
                    </span>
                    {r.name}
                  </button>
                  <span
                    className={
                      expandable
                        ? "rpt-meter-body rpt-meter-clickable"
                        : "rpt-meter-body"
                    }
                    onClick={
                      expandable
                        ? () =>
                            setExpandedUnitId((cur) =>
                              cur === r.unitId ? null : r.unitId,
                            )
                        : undefined
                    }
                  >
                    <span className="rpt-meter-bar-track">
                      <span
                        className="rpt-meter-bar"
                        style={{ width: `${r.widthPct}%`, background: r.color }}
                      />
                    </span>
                    <span className="rpt-meter-value">{r.label}</span>
                  </span>
                </div>
                {expandedData && expandedUnitId === r.unitId && (
                  <BreakdownTable
                    {...expandedData}
                    mode={mode as "damage" | "healing" | "taken"}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
