import { useState } from "react";
import type { StoredShuffle } from "../derive/types";
import { MatchReport } from "./MatchReport";

/** Shuffle 报表头(P1-4):W/L 胶囊序列即回合切换控件(rpt-round-tabs 行
 * 已删),胶囊 `R{i} · W/L`,role=tab + 键盘左右切换。 */
export function ShuffleReport({
  shuffle,
  videoMatchId,
}: {
  shuffle: StoredShuffle;
  /** lobby 的存储 id —— 整段录像挂在它上,6 轮共享(见 MatchReport 同名 prop)。 */
  videoMatchId?: string;
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
              title={`Round ${i + 1}`}
              style={{ cursor: "pointer" }}
            >
              R{i + 1} · {r.winningTeamId === r.playerTeamId ? "W" : "L"}
            </i>
          ))}
        </span>
      </div>
      {/* key=round.id:换回合必须重挂载,不能复用同一实例(fix:审计
          Critical——否则 timeRange/winAi 等 useState 跨回合残留,可能把上一
          轮的选段 AI 分析渲染在新一轮页面上。同一先例见 App.tsx 的
          key={selectedId})。 */}
      <MatchReport
        key={round.id}
        source={round}
        roundLabel={`Round ${active + 1}`}
        matchId={round.id}
        videoMatchId={videoMatchId}
      />
    </div>
  );
}
