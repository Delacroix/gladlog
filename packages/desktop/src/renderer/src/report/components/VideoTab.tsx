import type { Finding } from "@gladlog/analysis";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../../bridge";
import { buildAnalysisInput } from "../derive/analysisInput";
import { resolveJumpTarget } from "../derive/jumpTarget";
import type { ReportSource } from "../derive/types";
import {
  deriveVideoMoments,
  type AiChipLike,
  type VideoMoment,
} from "../derive/videoMoments";
import type { TimelineData } from "../derive/timeline";
import type { VulnBand } from "../derive/vulnWindows";
import {
  advanceFeed,
  fmtClock,
  FEED_CAPACITY_FALLBACK,
  FEED_OUT_MS,
  initialFeed,
  VideoFeed,
  type FeedState,
} from "./VideoFeed";
import { VideoBattleTimeline } from "./VideoBattleTimeline";
import { VideoMomentList } from "./VideoMomentList";
import { VideoMomentStrip, type StripMark } from "./VideoMomentStrip";

/** 右侧卡 tab 记忆(2a:feed 开关升级为三 tab,旧 FEED_PREF_KEY 弃用)。 */
const SIDE_TAB_KEY = "gladlog.videoSide.tab";
type SideTab = "feed" | "all" | "ai";

/** 独立「录像」tab(真机反馈:回放页小窗太小)。全宽原生播放器 + 下方对齐
 * 标记条(A)+ 右侧播放事件 feed(C,kill-feed 式)。自主播放,打开时自动
 * 定位到本场(shuffle 为本轮)开始;标记/feed 由 video timeupdate 驱动,
 * 与回放页时钟无关。 */
export function VideoTab({
  url,
  startedAt,
  source,
  matchId,
  timeline,
  bands,
}: {
  url: string;
  /** 录像起点墙钟 epoch ms(播放锚点)。 */
  startedAt: number;
  source: ReportSource;
  /** AI 深挖 chips 缓存查询用(shuffle 按轮,与录像的 videoMatchId 正交)。 */
  matchId?: string;
  /** 战斗时间轴卡数据(2a):MatchReport 已 memo 的同源 derive,勿在本组件
   * 内重复计算(全场数据量下重复 derive 是实打实的卡顿)。不传则不渲染
   * 时间轴卡(旧调用方/测试平滑降级)。 */
  timeline?: TimelineData;
  bands?: VulnBand[];
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [durationS, setDurationS] = useState(0);
  const [aiChips, setAiChips] = useState<AiChipLike[]>([]);
  const [sideTab, setSideTab] = useState<SideTab>(() => {
    try {
      const v = localStorage.getItem(SIDE_TAB_KEY);
      return v === "all" || v === "ai" ? v : "feed";
    } catch {
      return "feed"; // 测试环境无 localStorage
    }
  });
  const [feed, setFeed] = useState<FeedState>(() => initialFeed(0));
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [curS, setCurS] = useState(0);
  // 录像比这一轮的开始还短(比如 OBS 提前停录、后面的 shuffle 轮没有画面):
  // offsetS 越界到 duration 之外,endS 的 Math.min 夹不住 offsetS 本身,会
  // 出现 endS < offsetS 的倒挂区间——决定权交给下面 seek 效果里 onReady 的
  // 判定(必须在那里同步判、同步摘听众,不能靠这里派生的值反推——中间隔一
  // 次 re-render,mount-seek 可能已经把 currentTime 定到越界的 offsetS 上,
  // 被浏览器钳回 duration 后 timeupdate 判定"早于起点"又去 snap,来回钳
  // 出死循环打满 CPU,即 VideoDock.tsx:50-55 记录的同一类教训)。
  const [noFootage, setNoFootage] = useState(false);
  // feed 容量(容器实测高度换算,VideoFeed 的 ResizeObserver 回调写入)。
  // ref 而非 state:容量随窗口大小变化,不该经由 useEffect 依赖数组触发
  // 播放器 effect 重挂、把播放位置弹回 offsetS(见下面主 effect 的取值)。
  const capacityRef = useRef(FEED_CAPACITY_FALLBACK);
  const momentsRef = useRef<VideoMoment[]>([]);
  // AI 拉取 effect 的 refresh() 每次(挂载 + 每个 onDone)都要用 candidates
  // 解出 timed finding 的时刻——buildAnalysisInput 会整份重建 richContext/
  // candidates(不便宜),按 [source, matchId] 记一次,而不是每次 refresh
  // 都重建(复核 3)。ref 而非 state:AI 拉取 effect 只依赖 matchId,不该
  // 因为这份缓存重算而重新订阅/重拉。
  const analysisInputRef = useRef<ReturnType<typeof buildAnalysisInput>>(null);
  useEffect(() => {
    analysisInputRef.current = matchId
      ? buildAnalysisInput(source, matchId)
      : null;
  }, [source, matchId]);

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
    const refresh = () => {
      try {
        // 缺面/无缓存都静默降级(feed 仍有确定性时刻)
        void bridge()
          .analysis?.getCached(matchId)
          .then((cached) => {
            if (!alive || !cached) return;
            const findings =
              (cached as { findings?: Finding[] }).findings ?? [];
            const deepDiveChips = findings.flatMap(
              (f) => f.deepDive?.chips ?? [],
            );
            // 时间轴 finding → chip:与 StructuredAnalysisPanel 的 splitFindings
            // 同一谓词(facts.t 存在 = timed,candidates 由 buildAnalysisInput
            // 同源构建——不自造时间轴判定),命中的时刻取 resolveJumpTarget
            // 同款(证据链跳转复用的那份查表)。
            let timedChips: AiChipLike[] = [];
            try {
              const input = analysisInputRef.current;
              if (input) {
                const timedIds = new Set(
                  input.candidates
                    .filter((c) => c.facts.t !== undefined)
                    .map((c) => c.id),
                );
                timedChips = findings
                  .filter((f) => f.eventIds?.some((id) => timedIds.has(id)))
                  .map((f): AiChipLike | null => {
                    const target = resolveJumpTarget(
                      input.candidates,
                      f.eventIds,
                    );
                    return target
                      ? {
                          t: target.t,
                          label: f.title,
                          unitNames: target.unitNames,
                        }
                      : null;
                  })
                  .filter((c): c is AiChipLike => c != null);
              }
            } catch {
              /* 谓词失败不拖垮 deepDive chips */
            }
            setAiChips([...deepDiveChips, ...timedChips]);
          })
          .catch(() => {});
      } catch {
        /* 桩缺面 */
      }
    };
    refresh();
    // 分析在 tab 打开时跑完(自动分析/用户重跑)要能刷新进 feed/strip,不
    // 用等下次挂载——matchId 守卫避免其他场次的完成事件串进来。
    let off: (() => void) | undefined;
    try {
      off = bridge().analysis?.onDone((d: { matchId: string }) => {
        if (!alive || d.matchId !== matchId) return;
        refresh();
      });
    } catch {
      /* 桩缺面/无 bridge 面:不订阅,不影响初次拉取 */
    }
    return () => {
      alive = false;
      off?.();
    };
  }, [matchId]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    setNoFootage(false); // 换场/换轮:先假定有画面,onReady 里按实测 duration 复核
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
    const detach = () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
    // timeupdate/play/pause 先挂上,onReady 才有听众可摘——顺序不能反:
    // 若先判定 noFootage 再挂听众,detach() 是摘一个还不存在的监听器
    // (no-op),后面的 addEventListener 又会把它们重新挂上。
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    const onReady = () => {
      const dur = v.duration;
      setDurationS(dur);
      if (Number.isFinite(dur) && dur > 0 && offsetS >= dur) {
        // 录像比这一轮的开始还短(比如 OBS 提前停录、这一 shuffle 轮完全
        // 没被录进去):不去 seek 一个越界位置——浏览器会把 currentTime 钳
        // 到 duration,离 offsetS 差值恒 > 0.25s,上面的 onTime 又判定"早于
        // 起点"再去 snap,钳回来又是一次 timeupdate……死循环打满 CPU(与
        // VideoDock.tsx:50-55 记录的同一类教训)。直接摘听众、翻空态标志,
        // 交给渲染层显示"本轮不在录像范围内",不再尝试任何 seek。
        detach();
        setNoFootage(true);
        return;
      }
      v.currentTime = offsetS;
      setCurS(offsetS);
    };
    if (v.readyState >= 1) onReady();
    else v.addEventListener("loadedmetadata", onReady, { once: true });
    setMuted(v.muted);
    return () => {
      v.removeEventListener("loadedmetadata", onReady);
      detach();
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
  const pickSideTab = (t: SideTab) => {
    setSideTab(t);
    try {
      localStorage.setItem(SIDE_TAB_KEY, t);
    } catch {
      /* 同上 */
    }
  };
  // 空依赖数组:内联箭头函数每次渲染都是新引用,VideoFeed 的 ResizeObserver
  // effect 把它放进依赖数组,新引用会致其每次渲染都 disconnect+重建观察者
  // (复核 2)——只写 ref,不捕获任何随渲染变化的值,稳定引用即可。
  const handleCapacityChange = useCallback((c: number) => {
    capacityRef.current = c;
  }, []);

  const clampedCurS = Math.min(Math.max(curS, offsetS), endS);

  return (
    <div className="rpt-video-tab">
      <div className="rpt-video-tab-row">
        <div className="rpt-video-tab-main">
          {/* video 元素本身跨 noFootage 状态保持挂载(同一个 ref 实例)——
              不随空态切换而卸载/重建,避免重新触发一次加载。 */}
          <video
            ref={ref}
            src={url}
            playsInline
            style={noFootage ? { display: "none" } : undefined}
          />
          {noFootage ? (
            <p className="rpt-dim rpt-video-tab-empty">
              本轮不在这段录像范围内(录像已经结束,比如 OBS 提前停录)——
              没有画面可放。下方战斗时间轴与右侧时刻清单来自战斗日志,仍可查看。
            </p>
          ) : (
            <>
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
                <button
                  type="button"
                  className="rpt-video-ctrl-mute"
                  aria-label="全屏"
                  title="全屏"
                  onClick={() => {
                    try {
                      void ref.current?.requestFullscreen();
                    } catch {
                      /* jsdom/旧内核无此面 */
                    }
                  }}
                >
                  ⛶
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
            </>
          )}
          {timeline && (
            <div className="rpt-video-bt" data-testid="video-bt-card">
              <span className="rpt-card-label">
                战斗时间轴 —— 点/拖定位录像
              </span>
              <VideoBattleTimeline
                data={timeline}
                bands={bands ?? []}
                playerTeamId={source.playerTeamId ?? null}
                curBattleS={noFootage ? null : clampedCurS - offsetS}
                disabled={noFootage}
                onSeek={(battleS) => {
                  const v = ref.current;
                  if (!v) return;
                  const videoS = Math.min(
                    Math.max(battleS + offsetS, offsetS),
                    endS,
                  );
                  v.currentTime = videoS;
                  setCurS(videoS);
                }}
              />
            </div>
          )}
        </div>
        {/* 右侧一张卡三 tab(2a):播放 feed | 全部时刻 | AI 发现,共用同一份
            videoMoments;无录像时 feed 不推进,清单 tab 仍可用(log 数据) */}
        <div className="rpt-video-side" data-testid="video-side">
          <div className="rpt-mode-seg rpt-video-side-tabs">
            <button
              data-testid="video-side-feed"
              className={sideTab === "feed" ? "active" : ""}
              onClick={() => pickSideTab("feed")}
            >
              播放 feed
            </button>
            <button
              data-testid="video-side-all"
              className={sideTab === "all" ? "active" : ""}
              onClick={() => pickSideTab("all")}
            >
              全部时刻 {moments.length}
            </button>
            <button
              data-testid="video-side-ai"
              className={sideTab === "ai" ? "active" : ""}
              onClick={() => pickSideTab("ai")}
            >
              AI 发现 {moments.filter((m) => m.kind === "ai").length}
            </button>
          </div>
          {sideTab === "feed" &&
            (noFootage ? (
              <p className="rpt-engage-empty">
                无画面可播 —— 看「全部时刻」清单。
              </p>
            ) : (
              <VideoFeed
                items={feed.items}
                onCapacityChange={handleCapacityChange}
              />
            ))}
          {sideTab === "all" && (
            <VideoMomentList
              moments={moments}
              curBattleS={noFootage ? null : clampedCurS - offsetS}
              onSeek={
                noFootage
                  ? undefined
                  : (battleS) => {
                      const v = ref.current;
                      if (!v) return;
                      v.currentTime = Math.min(
                        Math.max(battleS + offsetS, offsetS),
                        endS,
                      );
                    }
              }
              emptyText={
                source.kind === "shuffleRound"
                  ? "本轮无记录。"
                  : "本场无记录。"
              }
            />
          )}
          {sideTab === "ai" && (
            <VideoMomentList
              moments={moments.filter((m) => m.kind === "ai")}
              curBattleS={noFootage ? null : clampedCurS - offsetS}
              onSeek={
                noFootage
                  ? undefined
                  : (battleS) => {
                      const v = ref.current;
                      if (!v) return;
                      v.currentTime = Math.min(
                        Math.max(battleS + offsetS, offsetS),
                        endS,
                      );
                    }
              }
              emptyText="尚无 AI 发现 —— 跑一次 AI 分析后,时间轴 finding 会出现在这里。"
            />
          )}
        </div>
      </div>
      <p className="rpt-dim rpt-video-tab-hint">
        标记条:金带 = 爆发窗,✕ = 死亡,⚠ = 失误,✦ = AI 发现,点击定位;
        战斗时间轴是主 seek 面,控制条细进度条做精确微调。
      </p>
    </div>
  );
}
