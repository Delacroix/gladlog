import {
  activeRuns,
  deriveTimeline,
  PLATEAU_HP_RATIO,
} from "../src/renderer/src/report/derive/timeline";
import { loadMatchFixture } from "./fixtures/loadFixture";

describe("deriveTimeline", () => {
  const m = loadMatchFixture();
  it("fixture(advanced 日志):每个 Player 一条序列,点按时间升序", () => {
    const t = deriveTimeline(m);
    expect(t.hasAdvanced).toBe(true);
    expect(t.series.length).toBeGreaterThan(0);
    for (const s of t.series) {
      for (let i = 1; i < s.points.length; i++)
        expect(s.points[i]!.t).toBeGreaterThanOrEqual(s.points[i - 1]!.t);
      for (const p of s.points) expect(p.maxHp).toBeGreaterThan(0);
    }
  });
  it("死亡标记数量=非假死 deaths 总数,时间在对局范围内", () => {
    const t = deriveTimeline(m);
    const expected = Object.values(m.units)
      .filter((u) => u.kind === "Player")
      .reduce((a, u) => a + u.deaths.filter((d) => !d.unconscious).length, 0);
    expect(t.deaths).toHaveLength(expected);
    for (const d of t.deaths) {
      expect(d.t).toBeGreaterThanOrEqual(t.start);
      expect(d.t).toBeLessThanOrEqual(t.end);
    }
  });
  it("hasAdvanced=false → series 空", () => {
    const noAdv = { ...m, hasAdvancedLogging: false };
    expect(deriveTimeline(noAdv).series).toEqual([]);
  });
});

describe("activeRuns (plateau fade, UI review #2)", () => {
  const p = (t: number, hp: number) => ({ t, hp, maxHp: 100 });
  it("all-plateau series → no runs", () => {
    expect(activeRuns([p(0, 100), p(1, 100), p(2, 100)])).toEqual([]);
  });
  it("a dip is one run extended by one point each side", () => {
    const pts = [
      p(0, 100),
      p(1, 100),
      p(2, 80),
      p(3, 60),
      p(4, 100),
      p(5, 100),
    ];
    expect(activeRuns(pts).map((r) => r.map((q) => q.t))).toEqual([
      [1, 2, 3, 4],
    ]);
  });
  it("two dips → two runs; the threshold is PLATEAU_HP_RATIO", () => {
    const pts = [
      p(0, 100),
      p(1, 90),
      p(2, 100),
      p(3, 100),
      p(4, 100 * PLATEAU_HP_RATIO - 0.01),
      p(5, 100),
    ];
    expect(activeRuns(pts)).toHaveLength(2);
    expect(activeRuns([p(0, 100 * PLATEAU_HP_RATIO), p(1, 100)])).toEqual([]);
  });
  it("a dip at the edges is clamped, not extended past the series", () => {
    const runs = activeRuns([p(0, 50), p(1, 100), p(2, 100), p(3, 40)]);
    expect(runs.map((r) => r.map((q) => q.t))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
