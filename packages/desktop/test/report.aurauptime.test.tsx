// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { AuraUptimeCard } from "../src/renderer/src/report/components/AuraUptimeCard";
import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import {
  deriveAuraUptime,
  mergeCoverage,
} from "../src/renderer/src/report/derive/auraUptime";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

describe("光环 uptime(第四阶段④)", () => {
  it("mergeCoverage:重叠/相接区间并集,互不相交保持原样", () => {
    expect(
      mergeCoverage([
        { fromS: 0, toS: 30 },
        { fromS: 10, toS: 40 },
        { fromS: 50, toS: 60 },
      ]),
    ).toEqual([
      { fromS: 0, toS: 40 },
      { fromS: 50, toS: 60 },
    ]);
  });

  it("derive:按单位分组,行按类别白名单筛选,uptime 秒数与区间加总一致且不超全场", () => {
    const { groups, durationS } = deriveAuraUptime(m);
    expect(groups.length).toBeGreaterThan(0);
    // Group structure (P1-2): rows in a group all belong to the group head's
    // unit; anything beyond top-N goes into hiddenRows
    for (const g of groups) {
      expect(g.rows.length).toBeGreaterThan(0);
      expect(g.rows.length).toBeLessThanOrEqual(6);
      for (const r of [...g.rows, ...g.hiddenRows])
        expect(r.unitId).toBe(g.unitId);
    }
    const rows = groups.flatMap((g) => [...g.rows, ...g.hiddenRows]);
    for (const r of rows) {
      expect(["offense", "defense", "cc"]).toContain(r.kind);
      // uptime = union of intervals (overlapping sources of the same buff must
      // not be double-counted)
      const union = mergeCoverage(r.intervals).reduce(
        (s, iv) => s + (iv.toS - iv.fromS),
        0,
      );
      expect(r.uptimeS).toBeCloseTo(Math.round(union * 10) / 10, 5);
      expect(r.uptimeS).toBeLessThanOrEqual(durationS + 1e-6);
      for (const iv of r.intervals) {
        expect(iv.fromS).toBeGreaterThanOrEqual(0);
        expect(iv.toS).toBeLessThanOrEqual(durationS + 1e-6);
        expect(iv.toS).toBeGreaterThanOrEqual(iv.fromS);
      }
    }
  });

  it("时间窗:窗口占比 = 重叠秒数 / 窗口时长(同谓词),且 ≤ 全场秒数", () => {
    const flat = (d: ReturnType<typeof deriveAuraUptime>) =>
      d.groups.flatMap((g) => [...g.rows, ...g.hiddenRows]);
    const full = flat(deriveAuraUptime(m));
    const range = { fromS: 10, toS: 40 };
    const windowed = flat(deriveAuraUptime(m, range));
    for (const w of windowed) {
      const f = full.find(
        (r) => r.unitId === w.unitId && r.spellId === w.spellId,
      );
      // A windowed row is necessarily present among the whole-match rows too (a
      // window can only lower uptime, never create new rows) … unless the
      // whole-match version was squeezed out by the per-unit top-N truncation —
      // skip the comparison in that case
      if (!f) continue;
      expect(w.uptimeS).toBeLessThanOrEqual(f.uptimeS + 1e-6);
      expect(w.uptimeS).toBeLessThanOrEqual(30 + 1e-6);
    }
  });

  it("组件:渲染区间条与占比;空数据不渲染", () => {
    const data = deriveAuraUptime(m);
    const { container } = render(<AuraUptimeCard data={data} />);
    expect(screen.getByTestId("aura-uptime")).toBeTruthy();
    expect(container.querySelectorAll(".rpt-aura-seg").length).toBeGreaterThan(
      0,
    );
    // Grouped rendering: group head row + indented rows + shared scale row
    expect(container.querySelectorAll(".rpt-aura-group-head").length).toBe(
      data.groups.length,
    );
    expect(container.querySelector(".rpt-aura-scale")).toBeTruthy();
    const { container: empty } = render(
      <AuraUptimeCard data={{ groups: [], durationS: 1 }} />,
    );
    expect(empty.querySelector("[data-testid=aura-uptime]")).toBeNull();
  });

  it("战报视图集成:对局面板「光环」tab 下出现(1a 合卡)", () => {
    render(<MatchReport source={m} matchId="t" />);
    fireEvent.click(screen.getByTestId("engage-tab-aura"));
    expect(screen.getByTestId("aura-uptime")).toBeTruthy();
  });
});
