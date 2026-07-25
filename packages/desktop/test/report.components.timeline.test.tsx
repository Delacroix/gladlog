// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { Timeline } from "../src/renderer/src/report/components/Timeline";
import { UnitPanel } from "../src/renderer/src/report/components/UnitPanel";
import { deriveCasts } from "../src/renderer/src/report/derive/casts";
import { deriveTimeline } from "../src/renderer/src/report/derive/timeline";
import { loadMatchFixture } from "./fixtures/loadFixture";

const m = loadMatchFixture();

describe("Timeline", () => {
  it("每个序列一条 path,死亡标记数量正确", () => {
    const data = deriveTimeline(m);
    const { container } = render(<Timeline data={data} />);
    expect(container.querySelectorAll("path.rpt-tl-line")).toHaveLength(
      data.series.length,
    );
    expect(container.querySelectorAll(".rpt-tl-death")).toHaveLength(
      data.deaths.length,
    );
  });
  it("series 空(无 advanced)也能渲染", () => {
    const data = deriveTimeline({ ...m, hasAdvancedLogging: false });
    const { container } = render(<Timeline data={data} />);
    expect(
      container.querySelector("[data-testid='rpt-timeline']"),
    ).toBeTruthy();
  });
  it("⚠ 聚簇(P1-4):tS 相近的 3 个 marks 并为 1 个 ⚠3 节点;相距远的独立", () => {
    const data = deriveTimeline(m);
    const durS = (data.end - data.start) / 1000;
    // 相邻间隔 4 viewBox 像素(阈值 8px 内);第 4 个远离
    const step = (durS * 4) / 800;
    const marks = [
      { tS: 10, label: "a", severity: "minor" },
      { tS: 10 + step, label: "b", severity: "major" },
      { tS: 10 + 2 * step, label: "c", severity: "average" },
      { tS: durS * 0.8, label: "d", severity: "minor" },
    ];
    const { container } = render(<Timeline data={data} marks={marks} />);
    const nodes = container.querySelectorAll("[data-testid='tl-mistake']");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.textContent).toContain("⚠3");
    // 组色取最重档
    expect(nodes[0]!.getAttribute("class")).toContain("rpt-tl-mistake-major");
  });
  it("图例(P1-4):每系列一项,点击回调 onSelectUnit;隐藏系列降透明", () => {
    const data = deriveTimeline(m);
    const hidden = new Set([data.series[0]!.unitId]);
    const calls: string[] = [];
    const { container } = render(
      <Timeline
        data={data}
        hidden={hidden}
        onSelectUnit={(id) => calls.push(id)}
      />,
    );
    const items = container.querySelectorAll(".rpt-tl-legend-item");
    expect(items).toHaveLength(data.series.length);
    expect(items[0]!.className).toContain("off");
    fireEvent.click(items[0]!);
    expect(calls).toEqual([data.series[0]!.unitId]);
  });
});

describe("UnitPanel", () => {
  it("渲染选中单位的名字与施法行数", () => {
    const u = Object.values(m.units).find(
      (x) => x.kind === "Player" && x.casts.length > 0,
    )!;
    render(<UnitPanel source={m} unitId={u.id} onSelectUnit={() => {}} />);
    expect(screen.getAllByText(u.name).length).toBeGreaterThan(0);
    expect(deriveCasts(m, u.id).length).toBeGreaterThan(0);
    expect(screen.getByText(/施法 \+ 重要光环\(\d+\)/)).toBeTruthy(); // 合并事件流标题
    expect(screen.getByText(/天赋 \d+ 项/)).toBeTruthy();
  });

  it("玩家筛选下拉:列出全部玩家,切换回调选中 unitId", () => {
    const players = Object.values(m.units).filter((x) => x.kind === "Player");
    expect(players.length).toBeGreaterThan(1);
    const selected = players[0]!;
    const other = players[1]!;
    const onSelectUnit = vi.fn();
    render(
      <UnitPanel source={m} unitId={selected.id} onSelectUnit={onSelectUnit} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe(selected.id);
    expect(select.querySelectorAll("option")).toHaveLength(players.length);
    fireEvent.change(select, { target: { value: other.id } });
    expect(onSelectUnit).toHaveBeenCalledWith(other.id);
  });
});
