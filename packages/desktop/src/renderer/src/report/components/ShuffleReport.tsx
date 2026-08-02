import { useState } from "react";
import type { StoredShuffle } from "../derive/types";
import { MatchReport } from "./MatchReport";

/** Shuffle 报表头(P1-4):W/L 胶囊序列即回合切换控件(rpt-round-tabs 行
 * 已删),胶囊 `R{i} · W/L`,role=tab + 键盘左右切换。 */
export function ShuffleReport({
  shuffle,
  videoMatchId,
  ratingDelta = null,
}: {
  shuffle: StoredShuffle;
  /** lobby 的存储 id —— 整段录像挂在它上,6 轮共享(见 MatchReport 同名 prop)。 */
  videoMatchId?: string;
  /** 整局评分变动(App 层算);只在末轮页头显示 —— 评分结算发生在整局结束,
   * 中间回合展示它会误导「这轮赚/亏了分」。 */
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
      {/* 有意不加 key={round.id}(fix round 2,复核后改):全量重挂载会连带
          重置 view(切到「回放」看完一轮又跳回「战报」)、并让 videoMatchId
          共享的同一段录像 <video> 每次换轮都销毁重建(6 轮共享 lobby 录像,
          本应只是 seek,不该每次重新加载/闪烁)。真正跨局失真的只有
          timeRange/winAi 两处 state——已移进 MatchReport 内部按 matchId
          变化单独重置(见该文件的 prevMatchIdRef effect),不需要靠换 key
          连坐重置整棵子树。 */}
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
