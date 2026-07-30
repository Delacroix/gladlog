import { useEffect, useRef, useState } from "react";
import type { VideoMoment } from "../derive/videoMoments";

/** 播放事件 feed(kill-feed 式,brainstorm C 定稿):播放越过事件时刻从
 * 底部滑入、旧条目 TTL 到期淡出、下面往上顶。状态机是纯函数(可测),
 * 组件只做壳。驱动 = video timeupdate(~4Hz),与回放页时钟无关。 */

export const FEED_TTL_MS = 5_000;
/** 淡出动画时长:TTL 到期先标 out 播动画,再真正移除。 */
export const FEED_OUT_MS = 400;
export const FEED_MAX = 4;
/** 前跳超过此秒数视为拖进度条:重置堆栈,只重放新位置前 RESEED_S 秒。 */
const JUMP_S = 3;
const RESEED_S = 5;

export interface FeedItem {
  key: string;
  moment: VideoMoment;
  bornAt: number; // 墙钟 ms
  out: boolean;
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

export function advanceFeed(
  state: FeedState,
  nowS: number,
  wallNow: number,
  moments: VideoMoment[],
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
    }));
  const base = jumped ? [] : state.items;
  const seen = new Set(base.map((it) => it.key));
  const merged = [...base, ...fresh.filter((it) => !seen.has(it.key))]
    // TTL+淡出窗之外的移除;TTL 之内的标记 out 状态
    .filter((it) => wallNow - it.bornAt < FEED_TTL_MS + FEED_OUT_MS)
    .map((it) => ({ ...it, out: wallNow - it.bornAt >= FEED_TTL_MS }));
  // cap:丢最旧(队首),新条目永远在底部
  const items = merged.slice(Math.max(0, merged.length - FEED_MAX));
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

const fmt = (tS: number) =>
  `${Math.floor(tS / 60)}:${String(Math.floor(tS % 60)).padStart(2, "0")}`;

export function VideoFeed({ items }: { items: FeedItem[] }) {
  // 到期淡出需要一个不依赖 timeupdate 的补充心跳(暂停时也要能消完)
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    timer.current = setInterval(() => force((n) => n + 1), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  return (
    <div className="rpt-video-feed" data-testid="video-feed">
      {items.map((it) => (
        <div
          key={it.key}
          className={`rpt-video-feed-item${it.out ? " out" : ""}`}
        >
          <span className="rpt-video-feed-t">{fmt(it.moment.tS)}</span>
          <span className="rpt-video-feed-icon">
            {KIND_ICON[it.moment.kind] ?? "•"}
          </span>
          <span className="rpt-video-feed-label">{it.moment.label}</span>
        </div>
      ))}
    </div>
  );
}
