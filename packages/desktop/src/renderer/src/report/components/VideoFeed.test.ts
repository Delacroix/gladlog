import { describe, expect, it } from "vitest";
import type { VideoMoment } from "../derive/videoMoments";
import {
  advanceFeed,
  FEED_MAX,
  FEED_OUT_MS,
  FEED_TTL_MS,
  initialFeed,
} from "./VideoFeed";

const mk = (tS: number, label = `e${tS}`): VideoMoment => ({
  tS,
  kind: "death",
  weight: "major",
  label,
  unitNames: [],
});

describe("advanceFeed", () => {
  it("正常推进:收 (lastS, nowS] 的事件,新条目在底部", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 12, 1000, [mk(11), mk(12), mk(13)]);
    expect(s.items.map((i) => i.moment.tS)).toEqual([11, 12]);
    s = advanceFeed(s, 13, 1200, [mk(11), mk(12), mk(13)]);
    expect(s.items.map((i) => i.moment.tS)).toEqual([11, 12, 13]);
  });

  it("TTL:先标 out 播淡出,再移除;不重复收已见条目", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 11, 1000, [mk(11)]);
    s = advanceFeed(s, 11.2, 1000 + FEED_TTL_MS + 10, [mk(11)]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.out).toBe(true);
    s = advanceFeed(s, 11.4, 1000 + FEED_TTL_MS + FEED_OUT_MS + 10, [mk(11)]);
    expect(s.items).toHaveLength(0);
  });

  it("拖进度条(前跳/回退)重置:只补种新位置前 5s 内", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 11, 1000, [mk(11)]);
    // 前跳 60s:11 处的条目清掉,只收 (55,60]
    s = advanceFeed(s, 60, 2000, [mk(11), mk(56), mk(59), mk(40)]);
    expect(s.items.map((i) => i.moment.tS)).toEqual([56, 59]);
    // 回退到 20:重置,只收 (15,20]
    s = advanceFeed(s, 20, 3000, [mk(11), mk(18), mk(56)]);
    expect(s.items.map((i) => i.moment.tS)).toEqual([18]);
  });

  it("cap:超出丢最旧,保住最新的 FEED_MAX 条", () => {
    let s = initialFeed(0);
    const moments = [1, 2, 3, 4, 5, 6].map((t) => mk(t));
    s = advanceFeed(s, 2.5, 1000, moments); // 收 1,2
    s = advanceFeed(s, 5.5, 1100, moments); // 再收 3,4,5 → 共 5 条 → 丢 1
    expect(s.items).toHaveLength(FEED_MAX);
    expect(s.items.map((i) => i.moment.tS)).toEqual([2, 3, 4, 5]);
  });
});
