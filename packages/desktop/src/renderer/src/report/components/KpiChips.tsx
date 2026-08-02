import type { DispelDash } from "../derive/dispelDash";
import type { KickDashRow } from "../derive/kickDash";
import type { Mistake } from "../derive/mistakes";
import type { TimelineData } from "../derive/timeline";
import type { VulnBand } from "../derive/vulnWindows";

const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * The KPI chip row in the report header (UI redesign 1a): a one-line overview
 * of the finish / mistakes / burst windows / interrupts / dispels.
 * Scope: **always the whole match**, never linked to the time window — the
 * same "how did this match go" overview role as MatchArcLine. Callers must
 * pass whole-match derives (no range); do not hand it windowed data.
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
  /** Whole-match mistakes (not filtered by window). */
  mistakes: Mistake[];
  bands: VulnBand[];
  /** Whole-match interrupt rows (deriveKickDash(source) without a range). */
  kickRows: KickDashRow[];
  /** Whole-match dispels (deriveDispelDash(source) without a range). */
  dispelDash: DispelDash;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  // The finish = the last real player death in the match (timeline.deaths has
  // already filtered out unconscious states and non-players)
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
