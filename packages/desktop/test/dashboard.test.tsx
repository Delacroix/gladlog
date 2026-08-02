// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import {
  deriveCurrentRating,
  deriveDashboard,
  deriveRatingDeltas,
  periodStart,
} from "../src/renderer/src/components/dashboard";
import { StatsDashboard } from "../src/renderer/src/components/StatsDashboard";
import type { StoredMatchMeta } from "../src/main/matchStore";

const NOW = new Date("2026-07-18T20:00:00Z").getTime();
const H = 3600_000;

const meta = (over: Partial<StoredMatchMeta>): StoredMatchMeta => ({
  id: Math.random().toString(36).slice(2),
  kind: "match",
  bracket: "3v3",
  zoneId: "1505",
  startTime: NOW - H,
  endTime: NOW - H + 300_000,
  result: "win",
  storedAt: 1,
  durationS: 300,
  avgRating: 2400,
  teams: [
    [{ specId: 105, classId: 11 }],
    [
      { specId: 64, classId: 8 },
      { specId: 71, classId: 1 },
    ],
  ],
  ...over,
});

describe("deriveDashboard", () => {
  const metas = [
    meta({}),
    meta({ result: "loss", avgRating: 2350, startTime: NOW - 2 * H }),
    // 8 天前:week 期外
    meta({ startTime: NOW - 8 * 24 * H, avgRating: 2200 }),
    // 旧行:无富字段
    meta({
      startTime: NOW - 3 * H,
      durationS: undefined,
      avgRating: undefined,
      teams: undefined,
      result: "loss",
      zoneId: "617",
    }),
    // 2v2 一场(评分序列需 ≥2 点才成线,该 bracket 应被滤掉)
    meta({ bracket: "2v2", startTime: NOW - 4 * H, avgRating: 1800 }),
  ];

  it("period 过滤 + 总览/中位数(旧行无时长不计中位)", () => {
    const week = deriveDashboard(metas, "week", NOW);
    expect(week.games).toBe(4);
    expect(week.wins).toBe(2);
    expect(week.medianDurationS).toBe(300);
    const all = deriveDashboard(metas, "all", NOW);
    expect(all.games).toBe(5);
    expect(periodStart("all", NOW)).toBe(0);
  });

  it("评分曲线按 bracket 分线且 ≥2 点;comp 表聚合敌方签名并数旧行", () => {
    const week = deriveDashboard(metas, "week", NOW);
    expect(week.ratingSeries.length).toBe(1); // 3v3 两点;2v2 单点被滤
    expect(week.ratingSeries[0]!.bracket).toBe("3v3");
    expect(week.ratingSeries[0]!.points.map((p) => p.rating)).toEqual([
      2350, 2400,
    ]);
    // comp:64+71 出现 3 场(week 内 2 场 3v3 + 1 场 2v2)
    const comp = week.comps.find((c) => c.specIds.join("+") === "64+71")!;
    expect(comp.games).toBe(3);
    expect(comp.wins).toBe(2);
    expect(week.legacyRows).toBe(1);
    // 地图:旧行也计入
    expect(week.zones.find((z) => z.zoneId === "617")!.games).toBe(1);
  });
});

describe("shuffle 回合口径(1e)", () => {
  it("胜率按回合计;comp 按回合敌组;旧 shuffle 行回退按场", () => {
    const metas = [
      // 富 shuffle 行:6 回合 4 胜,两种敌组
      meta({
        kind: "shuffle",
        bracket: "Rated Solo Shuffle",
        result: "win",
        roundStats: [
          { win: true, enemySpecIds: [64, 71, 105] },
          { win: true, enemySpecIds: [64, 71, 105] },
          { win: false, enemySpecIds: [62, 71, 105] },
          { win: true, enemySpecIds: [62, 71, 105] },
          { win: false, enemySpecIds: [64, 71, 105] },
          { win: true, enemySpecIds: [64, 71, 105] },
        ],
      }),
      // 旧 shuffle 行(无 roundStats):按场回退,teams 走 R1 名单
      meta({
        kind: "shuffle",
        bracket: "Rated Solo Shuffle",
        result: "loss",
        startTime: NOW - 2 * H,
      }),
      // 普通对局照旧
      meta({ result: "win", startTime: NOW - 3 * H }),
    ];
    const d = deriveDashboard(metas, "week", NOW);
    // 场次按局(3),胜率按回合:6(shuffle 富行)+1(旧 shuffle)+1(match)=8,
    // 胜 = 4 + 0 + 1 = 5
    expect(d.games).toBe(3);
    expect(d.rateGames).toBe(8);
    expect(d.rateWins).toBe(5);
    // comp:富 shuffle 按回合敌组拆两行;旧 shuffle + match 走 teams[1]
    const a = d.comps.find((c) => c.specIds.join("+") === "64+71+105")!;
    expect(a.games).toBe(4);
    expect(a.wins).toBe(3);
    const b = d.comps.find((c) => c.specIds.join("+") === "62+71+105")!;
    expect(b.games).toBe(2);
    expect(b.wins).toBe(1);
    const legacy = d.comps.find((c) => c.specIds.join("+") === "64+71")!;
    expect(legacy.games).toBe(2); // 旧 shuffle 行 + match 行
    expect(legacy.wins).toBe(1);
  });

  it("普通对局全场景下 rate 口径与按场一致(回归不变量)", () => {
    const metas = [meta({}), meta({ result: "loss", startTime: NOW - 2 * H })];
    const d = deriveDashboard(metas, "week", NOW);
    expect(d.rateGames).toBe(d.games);
    expect(d.rateWins).toBe(d.wins);
  });
});

describe("第二轮 P0:最近对局 + 评分涨跌单源", () => {
  it("recent 取期内按时间降序前 8", () => {
    const metas = Array.from({ length: 10 }, (_, i) =>
      meta({ id: `m${i}`, startTime: NOW - (i + 1) * H }),
    );
    const d = deriveDashboard(metas, "all", NOW);
    expect(d.recent.map((m) => m.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
  });

  it("recent 不随时间段收窄(「最近」就是最近,P0 空态填充的本意)", () => {
    const metas = [meta({ id: "old", startTime: NOW - 8 * 24 * H })];
    const d = deriveDashboard(metas, "week", NOW);
    expect(d.games).toBe(0);
    expect(d.recent.map((m) => m.id)).toEqual(["old"]);
  });

  it("deriveRatingDeltas:同 bracket+角色+评分源相邻差;CR 与队均 MMR 不混比", () => {
    const metas = [
      meta({
        id: "a",
        playerName: "A",
        playerRating: 2000,
        startTime: NOW - 3 * H,
      }),
      meta({
        id: "b",
        playerName: "A",
        playerRating: 2018,
        startTime: NOW - 2 * H,
      }),
      // 无本人评分的旧行:回退队均,是另一条 key,不与 CR 相减
      meta({ id: "c", playerName: "A", startTime: NOW - H }),
    ];
    const d = deriveRatingDeltas(metas);
    expect(d.get("a")).toBeNull();
    expect(d.get("b")).toBe(18);
    expect(d.get("c")).toBeNull();
  });
});

describe("StatsDashboard UI", () => {
  it("渲染总览/曲线/comp 表;comp 行点击回调 specId", async () => {
    // 相对当前时刻造数:组件内部用真实 Date.now() 取「近一周」窗口,
    // 固定 NOW(2026-07-18)在 7 天后滑出窗口 → dash-curve 消失
    // (2026-07-25 日期翻转 flake 实锤,CI 早晨绿下午红)。
    const now = Date.now();
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      matches: {
        list: async () => [
          meta({ startTime: now - H }),
          meta({ result: "loss", avgRating: 2350, startTime: now - 2 * H }),
        ],
      },
    };
    const picked: number[] = [];
    render(<StatsDashboard onCompClick={(id) => picked.push(id)} />);
    expect(await screen.findByText("场次")).toBeTruthy();
    // 1e 改版:整行曲线卡撤销,曲线在「当前评分」sparkline 点开的弹层里
    expect(screen.getByTestId("dash-sparkline")).toBeTruthy();
    // 首末值标签(三点五-4②):HTML 层,首=2350 末=2400
    expect(
      [...document.querySelectorAll(".dash-spark-lab")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["2350", "2400"]);
    fireEvent.click(screen.getByLabelText("展开评分曲线大图"));
    expect(screen.getByTestId("dash-curve")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(screen.queryByTestId("dash-curve")).toBeNull();
    const row = screen.getByTitle("Frost Mage + Arms Warrior");
    fireEvent.click(row);
    expect(picked).toEqual([64]);
  });

  it("最近对局卡(三点五-1①):MatchListRow 行,点击回调 onOpenMatch", async () => {
    const now = Date.now();
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      matches: {
        list: async () => [
          meta({ id: "r1", startTime: now - H }),
          meta({ id: "r2", startTime: now - 2 * H }),
        ],
      },
    };
    const opened: string[] = [];
    render(<StatsDashboard onOpenMatch={(id) => opened.push(id)} />);
    const card = await screen.findByTestId("dash-recent");
    const rows = card.querySelectorAll(".dash-recent-row");
    expect(rows.length).toBe(2);
    // 降序:最近的在前
    fireEvent.click(rows[0]!);
    expect(opened).toEqual(["r1"]);
  });

  it("阵容空态(三点五-1②):重建索引入口调 rebuildIndex 并刷新列表", async () => {
    const now = Date.now();
    const rebuildIndex = vi.fn().mockResolvedValue({ updated: 1, failed: 0 });
    const list = vi
      .fn()
      // 首拉:只有无 teams 的旧行 → 阵容空态
      .mockResolvedValueOnce([
        meta({
          id: "old",
          startTime: now - H,
          teams: undefined,
          durationS: undefined,
          avgRating: undefined,
        }),
      ])
      // 重建后:富行回填
      .mockResolvedValue([meta({ startTime: now - H })]);
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      matches: { list, rebuildIndex },
    };
    render(<StatsDashboard />);
    const btn = await screen.findByTestId("dash-rebuild");
    fireEvent.click(btn);
    await screen.findByText(/已重建:更新 1 场/);
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    // 列表已刷新:阵容行出现
    expect(screen.getByTitle("Frost Mage + Arms Warrior")).toBeTruthy();
  });
});

describe("角色区分(用户反馈:17 个号分数跳来跳去)", () => {
  const mk = (
    over: Partial<import("../src/main/matchStore").StoredMatchMeta>,
  ) =>
    ({
      id: Math.random().toString(36).slice(2),
      kind: "match",
      bracket: "3v3",
      zoneId: "1",
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      result: "Win",
      storedAt: Date.now(),
      ...over,
    }) as import("../src/main/matchStore").StoredMatchMeta;

  it("listCharacters 按场次降序;deriveDashboard 按角色过滤", async () => {
    const { deriveDashboard, listCharacters } =
      await import("../src/renderer/src/components/dashboard");
    const metas = [
      mk({ playerName: "A-Realm", result: "Win" }),
      mk({ playerName: "A-Realm", result: "Loss" }),
      mk({ playerName: "B-Realm", result: "Win" }),
      mk({}), // 旧行无 playerName
    ];
    const chars = listCharacters(metas);
    expect(chars.map((c) => c.name)).toEqual(["A-Realm", "B-Realm"]);
    const all = deriveDashboard(metas, "all");
    expect(all.games).toBe(4);
    const onlyA = deriveDashboard(metas, "all", Date.now(), "A-Realm");
    expect(onlyA.games).toBe(2);
    expect(onlyA.wins).toBe(1);
  });

  it("评分曲线优先记录者本人评分,旧行回退队均", async () => {
    const { deriveDashboard } =
      await import("../src/renderer/src/components/dashboard");
    const t = Date.now();
    const metas = [
      mk({ startTime: t - 5000, playerRating: 1800, avgRating: 2100 }),
      mk({ startTime: t - 4000, playerRating: 1820, avgRating: 2050 }),
      mk({ startTime: t - 3000, avgRating: 1500 }), // 旧行:回退队均
    ];
    const d = deriveDashboard(metas, "all");
    const pts = d.ratingSeries[0]!.points.map((p) => p.rating);
    expect(pts).toEqual([1800, 1820, 1500]);
  });
});

describe("deriveCurrentRating(1h 总览带)", () => {
  it("取最近有评分场的 bracket,与期起点前最近同 bracket 场相减", () => {
    const metas = [
      meta({ id: "a", bracket: "3v3", playerRating: 2145, startTime: NOW - H }),
      meta({
        id: "b",
        bracket: "3v3",
        playerRating: 2082,
        startTime: NOW - 8 * 24 * H, // 期起点(7 天)之前 → 基线
      }),
      meta({
        id: "c",
        bracket: "2v2",
        playerRating: 1800,
        startTime: NOW - 2 * H,
      }),
    ];
    const cur = deriveCurrentRating(metas, NOW - 7 * 24 * H);
    expect(cur).toEqual({ bracket: "3v3", rating: 2145, delta: 63 });
  });

  it("无基线 → delta null;全无评分 → null", () => {
    const cur = deriveCurrentRating(
      [meta({ playerRating: 2000, startTime: NOW - H })],
      NOW - 7 * 24 * H,
    );
    expect(cur!.delta).toBeNull();
    expect(
      deriveCurrentRating([meta({ playerRating: null, avgRating: null })], NOW),
    ).toBeNull();
  });
});
