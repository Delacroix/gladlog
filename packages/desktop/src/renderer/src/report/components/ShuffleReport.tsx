import { useState } from "react";
import type { StoredShuffle } from "../derive/types";
import { MatchReport } from "./MatchReport";

/** Shuffle report header (P1-4): the W/L pill sequence IS the round switcher
 * (the rpt-round-tabs row has been removed); each pill reads `R{i} · W/L`,
 * with role=tab and left/right keyboard switching. */
export function ShuffleReport({
  shuffle,
  videoMatchId,
  ratingDelta = null,
}: {
  shuffle: StoredShuffle;
  /** The lobby's storage id — the whole recording hangs off it and is shared
   * by all 6 rounds (see the prop of the same name on MatchReport). */
  videoMatchId?: string;
  /** Rating change for the whole lobby (computed at the App layer); shown only
   * in the final round's header — rating settles when the lobby ends, so
   * showing it on an intermediate round would wrongly suggest "this round
   * gained/lost rating". */
  ratingDelta?: number | null;
}) {
  const [active, setActive] = useState(0);
  const round = shuffle.rounds[active] ?? shuffle.rounds[0]!;
  const move = (delta: number) =>
    setActive((cur) =>
      Math.min(shuffle.rounds.length - 1, Math.max(0, cur + delta)),
    );
  return (
    <div className="rpt-shuffle">
      <div className="rpt-shuffle-head">
        <span className="rpt-shuffle-title">
          Solo Shuffle · {shuffle.rounds.length} 回合 · {shuffle.result}
        </span>
        <span className="rpt-shuffle-seq" role="tablist">
          {shuffle.rounds.map((r, i) => (
            <i
              key={i}
              role="tab"
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              className={[
                r.winningTeamId === r.playerTeamId ? "w" : "l",
                i === active ? "cur" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setActive(i)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") move(-1);
                else if (e.key === "ArrowRight") move(1);
              }}
              title={`回合 ${i + 1}`}
              style={{ cursor: "pointer" }}
            >
              R{i + 1} · {r.winningTeamId === r.playerTeamId ? "W" : "L"}
            </i>
          ))}
        </span>
      </div>
      {/* key={round.id} is deliberately omitted (fix round 2, revised after
          review): a full remount would also reset `view` (you finish a round
          in the replay tab and get thrown back to the report tab) and would
          destroy and rebuild the <video> element for the recording shared via
          videoMatchId on every round switch (all 6 rounds share the lobby
          recording, so switching should be a seek, not a reload/flicker). The
          only state that actually goes stale across rounds is timeRange and
          winAi — both moved inside MatchReport and reset individually when
          matchId changes (see the prevMatchIdRef effect in that file), so
          there is no need to blow away the whole subtree via a key change. */}
      <MatchReport
        source={round}
        roundLabel={`回合 ${active + 1}/${shuffle.rounds.length}`}
        matchId={round.id}
        videoMatchId={videoMatchId}
        ratingDelta={active === shuffle.rounds.length - 1 ? ratingDelta : null}
      />
    </div>
  );
}
