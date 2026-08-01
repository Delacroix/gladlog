import { useEffect, useRef } from "react";
import type { VideoMoment } from "../derive/videoMoments";

/** 播放事件 feed(kill-feed 式,brainstorm C 定稿):播放越过事件时刻从
 * 底部滑入、下面往上顶。状态机是纯函数(可测),组件只做壳 + 容量测量。
 * 驱动 = video timeupdate(~4Hz),与回放页时钟无关。
 *
 * 淘汰语义(2026-08 改版,#video-tab-2):不再按墙钟 TTL 过期——条目常驻,
 * 只在被新条目挤出容量时才淘汰(displacement,而不是 time-based)。旧版
 * TTL+硬 cap 组合有个反直觉之处:容量还有空位时,条目也会到点消失;现在
 * 空间够就一直挂着,直到真的被挤占。容量由容器实测高度换算,测不到时
 * 兜底 FEED_CAPACITY_FALLBACK。被挤出的条目先标 out 播 FEED_OUT_MS 淡出
 * 动画,再真正移除(旧版这段淡出行为保留,只是触发条件从"到点"换成"被挤")。*/

/** 淡出动画时长:被挤出先标 out 播动画,再真正移除。 */
export const FEED_OUT_MS = 400;
/** 测不到容器高度时(挂载瞬间/环境无 ResizeObserver/jsdom 测试)的兜底容量。 */
export const FEED_CAPACITY_FALLBACK = 6;
/** 条目高度估算(含底部 gap)——常量而非实测:jsdom 不跑真实布局,产品里
 * 用户对±几像素的容量误差不敏感,常量足够;改 CSS 行高/gap 要同步这里。 */
const ITEM_H_PX = 34;
const GAP_PX = 6;
/** 前跳超过此秒数视为拖进度条:重置堆栈,只重放新位置前 RESEED_S 秒。 */
const JUMP_S = 3;
const RESEED_S = 5;

export interface FeedItem {
  key: string;
  moment: VideoMoment;
  bornAt: number; // 墙钟 ms,仅供调试/排序,不再驱动过期
  out: boolean;
  /** out=true 时生效:到这个墙钟时刻才真正从数组移除(留出淡出动画的时间)。 */
  evictAt?: number;
}

export interface FeedState {
  lastS: number;
  items: FeedItem[];
}

export const initialFeed = (nowS: number): FeedState => ({
  lastS: nowS,
  items: [],
});

const keyOf = (m: VideoMoment) => `${m.tS}:${m.kind}:${m.label}`;

/**
 * 推进 feed 状态机。capacity<=0 按 1 处理(至少留一条)。
 *
 * nowS 与上次(state.lastS)相同时是「淘汰结算」心跳(见 VideoFeed 组件):
 * 补种窗口 (fromS, nowS] 在 fromS===nowS 时恒空,所以这类调用只会推进
 * evictAt 已到期条目的移除,不会凭空补出新条目。
 */
export function advanceFeed(
  state: FeedState,
  nowS: number,
  wallNow: number,
  moments: VideoMoment[],
  capacity: number,
): FeedState {
  const jumped = nowS < state.lastS - 0.5 || nowS > state.lastS + JUMP_S;
  const fromS = jumped ? nowS - RESEED_S : state.lastS;
  const fresh = moments
    .filter((m) => m.tS > fromS && m.tS <= nowS)
    .map((m, i) => ({
      key: keyOf(m),
      moment: m,
      // 重置补种时错开出生时刻,避免整列同秒消失
      bornAt: wallNow + i,
      out: false,
      evictAt: undefined as number | undefined,
    }));
  const base = jumped ? [] : state.items;
  const seen = new Set(base.map((it) => it.key));
  const merged = [...base, ...fresh.filter((it) => !seen.has(it.key))];

  // 容量位移:队首(最旧)超出 cap 的条目标 out + 定住 evictAt——已经在淡出
  // 中的条目(it.out 已真)不重新定时,避免被后续的挤占反复拖长淡出时间。
  const cap = Math.max(1, capacity);
  const overflow = Math.max(0, merged.length - cap);
  const staged = merged.map((it, i) =>
    i < overflow && !it.out
      ? { ...it, out: true, evictAt: wallNow + FEED_OUT_MS }
      : it,
  );
  // 到 evictAt 才真正移除;还没被标记淘汰的条目(evictAt undefined)永远
  // 保留——这就是「常驻直到被挤占」,不再有 wall-clock TTL。
  const items = staged.filter(
    (it) => it.evictAt == null || wallNow < it.evictAt,
  );
  return { lastS: nowS, items };
}

const KIND_ICON: Record<string, string> = {
  death: "✕",
  "burst-band": "⚔",
  defensive: "🛡",
  dispel: "✨",
  cc: "🌀",
  mistake: "⚠",
  ai: "🤖",
};

export const fmtClock = (tS: number) =>
  `${Math.floor(tS / 60)}:${String(Math.floor(tS % 60)).padStart(2, "0")}`;

export function VideoFeed({
  items,
  onCapacityChange,
}: {
  items: FeedItem[];
  /** 容器实测高度换算出的容量;测不到时不回调,调用方保留上次值/兜底
   * FEED_CAPACITY_FALLBACK。 */
  onCapacityChange?: (capacity: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined" || !onCapacityChange)
      return;
    const compute = () => {
      const h = el.getBoundingClientRect().height;
      const cap =
        h > 0
          ? Math.max(1, Math.floor((h + GAP_PX) / (ITEM_H_PX + GAP_PX)))
          : FEED_CAPACITY_FALLBACK;
      onCapacityChange(cap);
    };
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    return () => ro.disconnect();
  }, [onCapacityChange]);

  return (
    <div ref={containerRef} className="rpt-video-feed" data-testid="video-feed">
      {items.map((it) => (
        <div
          key={it.key}
          className={`rpt-video-feed-item${it.out ? " out" : ""}`}
        >
          <span className="rpt-video-feed-t">{fmtClock(it.moment.tS)}</span>
          <span className="rpt-video-feed-icon">
            {KIND_ICON[it.moment.kind] ?? "•"}
          </span>
          <span className="rpt-video-feed-label">{it.moment.label}</span>
        </div>
      ))}
    </div>
  );
}
