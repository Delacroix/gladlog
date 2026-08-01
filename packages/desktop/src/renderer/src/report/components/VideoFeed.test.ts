import { describe, expect, it } from "vitest";
import type { VideoMoment } from "../derive/videoMoments";
import { advanceFeed, FEED_OUT_MS, initialFeed } from "./VideoFeed";

const mk = (tS: number, label = `e${tS}`): VideoMoment => ({
  tS,
  kind: "death",
  weight: "major",
  label,
  unitNames: [],
});

describe("advanceFeed(displacement,不再是 wall-clock TTL)", () => {
  it("正常推进:收 (lastS, nowS] 的事件,新条目在底部", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 12, 1000, [mk(11), mk(12), mk(13)], 4);
    expect(s.items.map((i) => i.moment.tS)).toEqual([11, 12]);
    s = advanceFeed(s, 13, 1200, [mk(11), mk(12), mk(13)], 4);
    expect(s.items.map((i) => i.moment.tS)).toEqual([11, 12, 13]);
  });

  it("容量够用时条目常驻:时间流逝、容量有空位,不会凭空消失", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 11, 1000, [mk(11)], 4);
    // 同一个 nowS(=lastS)的心跳 tick,墙钟往前跳了很久——旧版 TTL 会让它
    // 到点淡出,新版位移语义下容量没被挤占就该原样留着。
    s = advanceFeed(s, 11, 1000 + 60_000, [mk(11)], 4);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.out).toBe(false);
  });

  it("拖进度条(前跳/回退)重置:只补种新位置前 5s 内", () => {
    let s = initialFeed(10);
    s = advanceFeed(s, 11, 1000, [mk(11)], 4);
    // 前跳 60s:11 处的条目清掉,只收 (55,60]
    s = advanceFeed(s, 60, 2000, [mk(11), mk(56), mk(59), mk(40)], 4);
    expect(s.items.map((i) => i.moment.tS)).toEqual([56, 59]);
    // 回退到 20:重置,只收 (15,20]
    s = advanceFeed(s, 20, 3000, [mk(11), mk(18), mk(56)], 4);
    expect(s.items.map((i) => i.moment.tS)).toEqual([18]);
  });

  it("容量位移:超出容量的最旧条目先标 out(不立即消失)", () => {
    let s = initialFeed(0);
    const moments = [1, 2, 3, 4, 5].map((t) => mk(t));
    s = advanceFeed(s, 2.5, 1000, moments, 4); // 收 1,2
    s = advanceFeed(s, 5.5, 1100, moments, 4); // 再收 3,4,5 → 共 5 条,cap=4
    // 挤占瞬间:总数暂时超容量(1 条在淡出中),不是硬切
    expect(s.items.map((i) => i.moment.tS)).toEqual([1, 2, 3, 4, 5]);
    expect(s.items.find((i) => i.moment.tS === 1)!.out).toBe(true);
    expect(s.items.filter((i) => i.out)).toHaveLength(1);
  });

  it("FEED_OUT_MS 淡出期满后才真正移除,不早不晚", () => {
    let s = initialFeed(0);
    const moments = [1, 2, 3, 4, 5].map((t) => mk(t));
    s = advanceFeed(s, 5.5, 1000, moments, 4); // 一次性收 5 条,cap=4 → 1 条 out
    const evictAt = s.items.find((i) => i.moment.tS === 1)!.evictAt!;
    expect(evictAt).toBe(1000 + FEED_OUT_MS);
    // 淡出期内(即使是同 nowS 的心跳 tick)仍保留
    s = advanceFeed(s, 5.5, evictAt - 1, [], 4);
    expect(s.items.map((i) => i.moment.tS)).toContain(1);
    // 到期后的心跳 tick 真正移除
    s = advanceFeed(s, 5.5, evictAt, [], 4);
    expect(s.items.map((i) => i.moment.tS)).toEqual([2, 3, 4, 5]);
  });

  it("已在淡出中的条目再次被判定超容量时不重设 evictAt(不拖长淡出)", () => {
    let s = initialFeed(0);
    s = advanceFeed(
      s,
      5.5,
      1000,
      [1, 2, 3, 4, 5].map((t) => mk(t)),
      4,
    );
    const firstEvictAt = s.items.find((i) => i.moment.tS === 1)!.evictAt!;
    // 再挤进来一条,条目 1 仍是最旧、仍超容量,但已经在淡出中
    s = advanceFeed(s, 6.5, 1050, [mk(6)], 4);
    expect(s.items.find((i) => i.moment.tS === 1)!.evictAt).toBe(firstEvictAt);
  });

  it("capacity 变化(容器 resize)对下一次推进即时生效", () => {
    let s = initialFeed(0);
    const moments = [1, 2, 3].map((t) => mk(t));
    s = advanceFeed(s, 3.5, 1000, moments, 4); // 容量 4,3 条都留着
    expect(s.items).toHaveLength(3);
    s = advanceFeed(s, 3.5, 1000, [], 2); // 容器变矮:容量收到 2
    expect(s.items.filter((i) => !i.out)).toHaveLength(2);
    expect(s.items.find((i) => i.moment.tS === 1)!.out).toBe(true);
  });
});
