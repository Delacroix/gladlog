import type { DispelDash } from "../derive/dispelDash";
import type { KickDashRow } from "../derive/kickDash";
import type { Mistake } from "../derive/mistakes";
import type { VulnBand } from "../derive/vulnWindows";

/**
 * The KPI chip row in the report header (UI redesign 1a): a one-line overview
 * of mistakes / burst windows / interrupts / dispels. The 终结 (finish) chip
 * moved to the hero line (ReportHeader, UI review 2026-08-21 #1).
 * Scope: **always the whole match**, never linked to the time window — the
 * same "how did this match go" overview role as MatchArcLine. Callers must
 * pass whole-match derives (no range); do not hand it windowed data.
 */
export function KpiChips({
  mistakes,
  bands,
  kickRows,
  dispelDash,
}: {
  /** Whole-match mistakes (not filtered by window). */
  mistakes: Mistake[];
  bands: VulnBand[];
  /** Whole-match interrupt rows (deriveKickDash(source) without a range). */
  kickRows: KickDashRow[];
  /** Whole-match dispels (deriveDispelDash(source) without a range). */
  dispelDash: DispelDash;
}) {
  const major = mistakes.filter((m) => m.severity === "major").length;
  const rest = mistakes.length - major;

  const bursts = bands.filter((b) => b.kind === "burst");
  const converted = bursts.filter((b) => b.targetDied).length;

  const kicksLanded = kickRows
    .filter((r) => r.reaction === "Friendly")
    .reduce((a, r) => a + r.landed, 0);
  // Deliberate dispels only; passive procs/riders ride along as a muted
  // suffix (UI review #3). One source: deriveDispelDash's totals.
  const { friendlyDeliberate, friendlyPassive } = dispelDash.totals;

  return (
    <div className="rpt-kpi-row" data-testid="kpi-chips">
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
      <span className="rpt-kpi" data-testid="kpi-dispel">
        <span className="rpt-kpi-k">驱散</span>
        <span className="rpt-kpi-v">
          {friendlyDeliberate}
          {friendlyPassive > 0 && (
            <span
              className="rpt-kpi-passive"
              title="被动触发 / 位移附带的驱散,不计入决策"
            >
              +{friendlyPassive} 被动
            </span>
          )}
        </span>
      </span>
    </div>
  );
}
