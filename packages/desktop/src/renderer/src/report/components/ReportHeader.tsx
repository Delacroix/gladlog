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
 * 页头一行(1c → 1a 修订):胜负 + 赛制·地图·时长(·评分变动)。玩家名/
 * 当前评分仍不出现在页头(1c 决策不回滚,它们在榜单里);评分**变动**是
 * 对局结果的一部分(UI 改版 1a 用户拍板),shuffle 只在末轮由调用方传入。
 */
export function ReportHeader({
  source,
  roundLabel,
  ratingDelta = null,
}: {
  source: ReportSource;
  roundLabel?: string;
  /** 相邻两场 meta 差值(App 层算,log 里没有个人评分变动);null/0 不显示。 */
  ratingDelta?: number | null;
}) {
  const res = source.result.toLowerCase();
  return (
    <div className="rpt-head-left">
      <span className={`rpt-head-result rpt-result-${res}`}>
        {RESULT_LABEL[res] ?? source.result}
      </span>
      {/* 顺序按规格 1a:赛制 · 回合 · 地图 · 时长 · 评分变动 */}
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
