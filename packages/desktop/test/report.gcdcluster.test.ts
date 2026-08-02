import { clusterGcdCasts } from "../src/renderer/src/report/derive/gcdCluster";

const row = (t: number, spellId: number) => ({
  t,
  spellId,
  spellName: `S${spellId}`,
  targetName: "",
  byPet: false,
});

describe("GCD 泳道折叠(同刻多技能)", () => {
  it("窗口内折叠;主 chip 取首个 on-GCD,off-GCD(勋章 336126)折为小图标", () => {
    // 336126 (Medallion, off-GCD) is pressed first, followed by 19750 (Flash of
    // Light, on-GCD) — the primary chip must be 19750
    const clusters = clusterGcdCasts(
      [row(1000, 336126), row(1200, 19750), row(3000, 853)],
      1400,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.t).toBe(1000); // the row anchors to the real time of the window's first cast
    expect(clusters[0]!.primary.spellId).toBe(19750);
    expect(clusters[0]!.minis.map((m) => m.spellId)).toEqual([336126]);
    expect(clusters[1]!.primary.spellId).toBe(853);
    expect(clusters[1]!.minis).toEqual([]);
  });

  it("全 off-GCD 的窗口:主 chip 回退首个", () => {
    const clusters = clusterGcdCasts(
      [row(1000, 336126), row(1100, 6552)],
      1400,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.primary.spellId).toBe(336126);
    expect(clusters[0]!.minis.map((m) => m.spellId)).toEqual([6552]);
  });

  it("间隔超窗不折叠", () => {
    const clusters = clusterGcdCasts([row(0, 19750), row(2000, 19750)], 1400);
    expect(clusters).toHaveLength(2);
  });
});
