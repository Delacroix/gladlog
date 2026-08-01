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

/** m:ss,与 VideoFeed 的时刻显示同款格式(自成一份而非导入——两处都是纯展示
 * 用的取整显示,不是门规复算的判据,重复一行比跨文件耦合更省心)。 */
const fmtClock = (tS: number) =>
  `${Math.floor(tS / 60)}:${String(Math.floor(tS % 60)).padStart(2, "0")}`;

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
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [curS, setCurS] = useState(0);

  // 本场开始在视频里的偏移(秒);battleS(相对本场) + offset = videoS
  const offsetS = Math.max(0, (source.startTime - startedAt) / 1000);
  // 本场结束在视频里的位置;测到 duration 后再夹一次(录像可能比本场结束
  // 得早,比如手动停录),避免进度条/时间轴伸到播放器实际没有的那段。
  const rawEndS = Math.max(offsetS, (source.endTime - startedAt) / 1000);
  const endS = durationS > 0 ? Math.min(rawEndS, durationS) : rawEndS;

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
      setCurS(offsetS);
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
      // 按轮 clamp:越出本轮范围(拖进度条/上一轮残留播放)自动弹回边界,
      // 越过终点额外暂停——播放器不该替用户播出下一轮的画面。start 侧留
      // 0.25s 容差(timeupdate 是离散采样,卡在边界±几帧属正常抖动)。
      if (v.currentTime < offsetS - 0.25) {
        v.currentTime = offsetS;
      } else if (v.currentTime >= endS) {
        v.pause();
        v.currentTime = endS;
      }
      setCurS(v.currentTime);
      const battleS = v.currentTime - offsetS;
      setFeed((prev) => advanceFeed(prev, battleS, Date.now(), moments));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    setMuted(v.muted);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [source, startedAt, offsetS, endS, moments]);

  const togglePlay = () => {
    const v = ref.current;
    if (!v) return;
    // 按 `playing` state 而非 v.paused 分支:play()/pause() 事件是异步真相
    // 来源,但 state 与按钮当前展示的 label 保证一致,点哪个字就做哪个动作。
    if (playing) v.pause();
    else void v.play();
  };
  const toggleMute = () => {
    const v = ref.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
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

  const clampedCurS = Math.min(Math.max(curS, offsetS), endS);

  return (
    <div className="rpt-video-tab">
      <div className="rpt-video-tab-row">
        <div className="rpt-video-tab-main">
          <video ref={ref} src={url} playsInline />
          <div
            className="rpt-video-controls"
            role="group"
            aria-label="录像播放控制"
          >
            <button
              type="button"
              className="rpt-video-ctrl-play"
              aria-label={playing ? "暂停" : "播放"}
              onClick={togglePlay}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <span className="rpt-video-ctrl-time" aria-hidden="true">
              {fmtClock(Math.max(0, clampedCurS - offsetS))} /{" "}
              {fmtClock(Math.max(0, endS - offsetS))}
            </span>
            <input
              type="range"
              className="rpt-video-ctrl-range"
              aria-label="播放进度(本轮范围内)"
              min={offsetS}
              max={endS}
              step={0.1}
              value={clampedCurS}
              onChange={(e) => {
                const val = Number(e.target.value);
                const v = ref.current;
                if (v) v.currentTime = val;
                setCurS(val);
              }}
            />
            <button
              type="button"
              className="rpt-video-ctrl-mute"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={toggleMute}
            >
              {muted ? "🔇" : "🔊"}
            </button>
          </div>
          <VideoMomentStrip
            marks={marks}
            durationS={durationS}
            windowStartS={offsetS}
            windowEndS={endS}
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
