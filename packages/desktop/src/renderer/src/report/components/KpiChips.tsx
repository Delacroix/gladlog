import type { DispelDash } from "../derive/dispelDash";
import type { KickDashRow } from "../derive/kickDash";
import type { Mistake } from "../derive/mistakes";
import type { TimelineData } from "../derive/timeline";
import type { VulnBand } from "../derive/vulnWindows";

const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 战报页头 KPI chips 行(UI 改版 1a):终结/失误/爆发窗/打断/驱散 一行速览。
 * 口径:**恒为全场**,不随时间窗联动 —— 同 MatchArcLine 的「这场怎么打的」
 * 概览定位;调用方必须传全场 derive(不带 range),别把窗口版数据递进来。
 */
export function KpiChips({
  timeline,
  mistakes,
  bands,
  kickRows,
  dispelDash,
  onSeek,
}: {
  timeline: TimelineData;
  /** 全场失误(不过滤窗口)。 */
  mistakes: Mistake[];
  bands: VulnBand[];
  /** 全场口径 kick 行(deriveKickDash(source) 不带 range)。 */
  kickRows: KickDashRow[];
  /** 全场口径驱散(deriveDispelDash(source) 不带 range)。 */
  dispelDash: DispelDash;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  // 终结 = 全场最后一次玩家真死(timeline.deaths 已滤 unconscious/非玩家)
  const lastDeath =
    timeline.deaths.length > 0
      ? timeline.deaths.reduce((a, b) => (b.t > a.t ? b : a))
      : null;
  const lastDeathS = lastDeath ? (lastDeath.t - timeline.start) / 1000 : null;

  const major = mistakes.filter((m) => m.severity === "major").length;
  const rest = mistakes.length - major;

  const bursts = bands.filter((b) => b.kind === "burst");
  const converted = bursts.filter((b) => b.targetDied).length;

  const kicksLanded = kickRows
    .filter((r) => r.reaction === "Friendly")
    .reduce((a, r) => a + r.landed, 0);
  const dispels = dispelDash.rows
    .filter((r) => r.reaction === "Friendly")
    .reduce((a, r) => a + r.cleanses + r.purges + r.steals, 0);

  return (
    <div className="rpt-kpi-row" data-testid="kpi-chips">
      {lastDeath && lastDeathS !== null && (
        <button
          type="button"
          className="rpt-kpi rpt-kpi-click"
          title="跳到终结时刻回放"
          onClick={() =>
            onSeek?.(Math.max(0, lastDeathS - 3), [lastDeath.name])
          }
        >
          <span className="rpt-kpi-k">终结</span>
          <span className="rpt-kpi-v">
            {lastDeath.name.split("-")[0]} · {mmss(lastDeathS)}
          </span>
        </button>
      )}
      <span className="rpt-kpi">
        <span className="rpt-kpi-k">失误</span>
        <span className="rpt-kpi-v">
          {major > 0 && <span className="rpt-kpi-major">{major} 重大</span>}
          {major > 0 && rest > 0 && " · "}
          {(rest > 0 || major === 0) && `${rest} 一般`}
        </span>
      </span>
      {bursts.length > 0 && (
        <span className="rpt-kpi">
          <span className="rpt-kpi-k">爆发窗</span>
          <span className="rpt-kpi-v">
            {converted}/{bursts.length} 转化
          </span>
        </span>
      )}
      <span className="rpt-kpi">
        <span className="rpt-kpi-k">打断</span>
        <span className="rpt-kpi-v">{kicksLanded}</span>
      </span>
      <span className="rpt-kpi">
        <span className="rpt-kpi-k">驱散</span>
        <span className="rpt-kpi-v">{dispels}</span>
      </span>
    </div>
  );
}
