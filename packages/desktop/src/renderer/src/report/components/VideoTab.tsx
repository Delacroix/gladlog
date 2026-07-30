import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../../bridge";
import type { ReportSource } from "../derive/types";
import {
  deriveVideoMoments,
  type AiChipLike,
  type VideoMoment,
} from "../derive/videoMoments";
import {
  advanceFeed,
  initialFeed,
  VideoFeed,
  type FeedState,
} from "./VideoFeed";
import { VideoMomentStrip, type StripMark } from "./VideoMomentStrip";

const FEED_PREF_KEY = "gladlog.videoFeed.enabled";

/** 独立「录像」tab(真机反馈:回放页小窗太小)。全宽原生播放器 + 下方对齐
 * 标记条(A)+ 右侧播放事件 feed(C,kill-feed 式)。自主播放,打开时自动
 * 定位到本场(shuffle 为本轮)开始;标记/feed 由 video timeupdate 驱动,
 * 与回放页时钟无关。 */
export function VideoTab({
  url,
  startedAt,
  source,
  matchId,
}: {
  url: string;
  /** 录像起点墙钟 epoch ms(播放锚点)。 */
  startedAt: number;
  source: ReportSource;
  /** AI 深挖 chips 缓存查询用(shuffle 按轮,与录像的 videoMatchId 正交)。 */
  matchId?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [durationS, setDurationS] = useState(0);
  const [aiChips, setAiChips] = useState<AiChipLike[]>([]);
  const [feedOn, setFeedOn] = useState(() => {
    try {
      return localStorage.getItem(FEED_PREF_KEY) !== "0";
    } catch {
      return true; // 测试环境无 localStorage
    }
  });
  const [feed, setFeed] = useState<FeedState>(() => initialFeed(0));

  // 本场开始在视频里的偏移(秒);battleS(相对本场) + offset = videoS
  const offsetS = Math.max(0, (source.startTime - startedAt) / 1000);

  const moments: VideoMoment[] = useMemo(
    () => deriveVideoMoments(source, aiChips),
    [source, aiChips],
  );
  const marks: StripMark[] = useMemo(
    () =>
      moments.map((m) => ({
        videoS: m.tS + offsetS,
        toVideoS: m.toS != null ? m.toS + offsetS : undefined,
        moment: m,
      })),
    [moments, offsetS],
  );

  useEffect(() => {
    let alive = true;
    setAiChips([]);
    if (!matchId) return;
    try {
      // 缺面/无缓存都静默降级(feed 仍有确定性时刻)
      void bridge()
        .analysis?.getCached(matchId)
        .then((cached) => {
          if (!alive || !cached) return;
          const f = (cached as { findings?: unknown[] }).findings ?? [];
          const chips = f.flatMap(
            (x) =>
              (x as { deepDive?: { chips?: AiChipLike[] } }).deepDive?.chips ??
              [],
          );
          setAiChips(chips);
        })
        .catch(() => {});
    } catch {
      /* 桩缺面 */
    }
    return () => {
      alive = false;
    };
  }, [matchId]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const seek = () => {
      v.currentTime = offsetS;
    };
    const meta = () => setDurationS(v.duration);
    if (v.readyState >= 1) {
      seek();
      meta();
    } else
      v.addEventListener(
        "loadedmetadata",
        () => {
          seek();
          meta();
        },
        { once: true },
      );
    const onTime = () => {
      const battleS = v.currentTime - offsetS;
      setFeed((prev) => advanceFeed(prev, battleS, Date.now(), moments));
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [source, startedAt, offsetS, moments]);

  const toggleFeed = () => {
    setFeedOn((on) => {
      try {
        localStorage.setItem(FEED_PREF_KEY, on ? "0" : "1");
      } catch {
        /* 同上 */
      }
      return !on;
    });
  };

  return (
    <div className="rpt-video-tab">
      <div className="rpt-video-tab-row">
        <div className="rpt-video-tab-main">
          <video ref={ref} src={url} controls playsInline />
          <VideoMomentStrip
            marks={marks}
            durationS={durationS}
            onSeek={(videoS) => {
              const v = ref.current;
              if (v) v.currentTime = videoS;
            }}
          />
        </div>
        {feedOn && <VideoFeed items={feed.items} />}
      </div>
      <p className="rpt-dim rpt-video-tab-hint">
        标记条:金带 = 爆发窗,✕ = 死亡,⚠ = 失误,点击定位;右侧 feed
        随播放弹出关键事件。
        <button className="rpt-video-feed-toggle" onClick={toggleFeed}>
          {feedOn ? "关闭事件 feed" : "打开事件 feed"}
        </button>
        要与战斗时间轴逐秒对照,用「回放」页的录像小窗。
      </p>
    </div>
  );
}
