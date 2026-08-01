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
  fmtClock,
  FEED_CAPACITY_FALLBACK,
  FEED_OUT_MS,
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
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [curS, setCurS] = useState(0);
  // feed 容量(容器实测高度换算,VideoFeed 的 ResizeObserver 回调写入)。
  // ref 而非 state:容量随窗口大小变化,不该经由 useEffect 依赖数组触发
  // 播放器 effect 重挂、把播放位置弹回 offsetS(见下面主 effect 的取值)。
  const capacityRef = useRef(FEED_CAPACITY_FALLBACK);
  const momentsRef = useRef<VideoMoment[]>([]);

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
  useEffect(() => {
    momentsRef.current = moments;
  }, [moments]);
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
      setFeed((prev) =>
        advanceFeed(
          prev,
          battleS,
          Date.now(),
          momentsRef.current,
          capacityRef.current,
        ),
      );
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
    // moments/capacity 特意不入依赖(改走 ref):它们随 aiChips 到达/feed
    // 容器 resize 变化,不该触发这个 effect 重挂——重挂会重新调用 seek()
    // 把播放位置弹回 offsetS,而这两者跟"播放器该在哪一秒"完全无关。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, startedAt, offsetS, endS]);

  // feed 淘汰结算心跳:被挤出的条目先标 out 播 FEED_OUT_MS 淡出,再真正从
  // 数组移除——这一步不依赖 timeupdate(暂停时也要能收尾那个已经不可见的
  // 占位空当,否则空位会一直卡在列表里)。nowS 传上次的 lastS(不推进),
  // advanceFeed 对 fromS===nowS 的补种窗口恒空,所以这个 tick 只结算到期
  // 淘汰,不会凭空补出新条目——这是 VideoFeed 旧版"力弱心跳"真正要做但
  // 没做到的事(旧版只 force 重渲染,不重算 advanceFeed,paused 时永远
  // 消不完)。
  useEffect(() => {
    const id = setInterval(() => {
      setFeed((prev) =>
        advanceFeed(
          prev,
          prev.lastS,
          Date.now(),
          momentsRef.current,
          capacityRef.current,
        ),
      );
    }, FEED_OUT_MS);
    return () => clearInterval(id);
  }, []);

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
        {feedOn && (
          <VideoFeed
            items={feed.items}
            onCapacityChange={(c) => {
              capacityRef.current = c;
            }}
          />
        )}
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
