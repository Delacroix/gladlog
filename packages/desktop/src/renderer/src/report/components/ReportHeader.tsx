import { zoneMetadata } from "@gladlog/analysis";

import type { ReportSource } from "../derive/types";

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RESULT_LABEL: Record<string, string> = {
  win: "胜利",
  loss: "败北",
  lose: "败北",
  draw: "平局",
};

/**
 * The one-line page header (1c, revised by 1a): result + bracket · map ·
 * duration (· rating change). Player name and current rating still do not
 * appear in the header (the 1c decision is not rolled back; they live in the
 * leaderboard); the rating **change**, however, is part of the match result
 * (user's call in UI rework 1a), and for shuffle the caller only passes it on
 * the final round.
 */
export function ReportHeader({
  source,
  roundLabel,
  ratingDelta = null,
}: {
  source: ReportSource;
  roundLabel?: string;
  /** Difference between two adjacent matches' meta (computed in the app
   * layer; the log carries no personal rating change); null/0 renders
   * nothing. */
  ratingDelta?: number | null;
}) {
  const res = source.result.toLowerCase();
  return (
    <div className="rpt-head-left">
      <span className={`rpt-head-result rpt-result-${res}`}>
        {RESULT_LABEL[res] ?? source.result}
      </span>
      {/* Order per spec 1a: bracket · round · map · duration · rating change */}
      <span className="rpt-head-meta">
        {source.bracket}
        {roundLabel ? ` · ${roundLabel}` : ""} ·{" "}
        {zoneMetadata[String(source.zoneId)]?.name ?? `zone ${source.zoneId}`} ·{" "}
        {fmtDuration(source.endTime - source.startTime)}
        {ratingDelta != null && ratingDelta !== 0 && (
          <span
            className={`rpt-head-rating ${
              ratingDelta > 0 ? "rpt-rating-up" : "rpt-rating-down"
            }`}
          >
            {" "}
            · {ratingDelta > 0 ? "+" : ""}
            {ratingDelta}
          </span>
        )}
      </span>
    </div>
  );
}
