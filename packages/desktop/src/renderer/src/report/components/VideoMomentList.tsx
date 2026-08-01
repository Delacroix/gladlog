import { useEffect, useRef } from "react";

import type { VideoMoment } from "../derive/videoMoments";
import { fmtClock } from "./VideoFeed";
import { MARK_STYLE } from "./VideoMomentStrip";

/**
 * 「全部时刻」静态清单(UI 改版 2a):行 = 时刻 + glyph + 描述 + ▶,
 * 与 feed/标记条共用同一份 videoMoments(同源,不重复 derive);
 * 当前播放行高亮并跟随滚动。「AI 发现」tab 复用本组件传过滤后的 moments。
 */
export function VideoMomentList({
  moments,
  curBattleS,
  onSeek,
  emptyText,
}: {
  moments: VideoMoment[];
  /** 当前播放时刻(相对本场秒);null = 无播放位置。 */
  curBattleS: number | null;
  onSeek?: (battleS: number) => void;
  emptyText: string;
}) {
  // 当前行 = 已过去的最后一个时刻(播放头压着它;还没到第一个时刻则无)
  const curIdx =
    curBattleS == null
      ? -1
      : moments.reduce((acc, m, i) => (m.tS <= curBattleS ? i : acc), -1);
  const curRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // jsdom 无 scrollIntoView(桩缺面惯例:可选调用 + 兜底)
    try {
      curRef.current?.scrollIntoView?.({ block: "nearest" });
    } catch {
      /* noop */
    }
  }, [curIdx]);

  if (moments.length === 0)
    return <p className="rpt-engage-empty">{emptyText}</p>;
  return (
    <div className="rpt-video-moments" data-testid="video-moment-list">
      {moments.map((m, i) => {
        const style = MARK_STYLE[m.kind] ?? { cls: "other", glyph: "•" };
        return (
          <button
            key={`${m.kind}:${m.tS}:${i}`}
            ref={i === curIdx ? curRef : undefined}
            type="button"
            className={
              i === curIdx ? "rpt-video-moment-row cur" : "rpt-video-moment-row"
            }
            onClick={() => onSeek?.(m.tS)}
            title="定位到该时刻"
          >
            <span className="rpt-video-feed-t">{fmtClock(m.tS)}</span>
            <span className={`rpt-video-moment-icon ${style.cls}`}>
              {style.glyph}
            </span>
            <span className="rpt-video-moment-label">{m.label}</span>
            <span className="rpt-video-moment-play">▶</span>
          </button>
        );
      })}
    </div>
  );
}
