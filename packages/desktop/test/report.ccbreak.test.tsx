// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { EngagementPanel } from "../src/renderer/src/report/components/EngagementPanel";
import type { CcBreakDash } from "../src/renderer/src/report/derive/ccBreakDash";
import type { DispelDash } from "../src/renderer/src/report/derive/dispelDash";

const emptyDispel: DispelDash = {
  rows: [],
  missedPurges: [],
  missedCleanses: [],
  ccEfficiency: [],
};

const aura = { groups: [] } as never;

function renderPanel(
  ccBreak?: CcBreakDash,
  onSeek?: (t: number, u: string[]) => void,
) {
  return render(
    <EngagementPanel
      kickRows={[]}
      dispelDash={emptyDispel}
      auraUptime={aura}
      ccRows={[]}
      ccBreak={ccBreak}
      onSeek={onSeek}
    />,
  );
}

describe("对局面板「破控」tab(2026-08-02)", () => {
  const dash: CcBreakDash = {
    friendly: [
      {
        tS: 42,
        label:
          "OurPriest 的 Shadow Word: Pain 打破了 OurMage 给 e1 上的 Polymorph(剩 6.5s)",
        unitName: "OurPriest",
      },
    ],
    enemy: [
      {
        tS: 61,
        label:
          "敌方 EnemyLock 的 Agony 提前打破了 t1 身上的 Polymorph(剩 3.0s)",
        unitName: "t1",
      },
    ],
    rootBreakCount: 2,
  };

  it("不传 ccBreak:不显示破控 tab(旧调用方平滑)", () => {
    renderPanel(undefined);
    expect(screen.queryByTestId("engage-tab-break")).toBeNull();
  });

  it("资敌/敌方自误两节 + root 脚注;行 ▶ 回放跳打破者", () => {
    const seeks: Array<[number, string[]]> = [];
    renderPanel(dash, (t, u) => seeks.push([t, u]));
    fireEvent.click(screen.getByTestId("engage-tab-break"));
    expect(screen.getByTestId("engage-tab-break").textContent).toBe("破控 2");
    expect(screen.getByText(/资敌打破/)).toBeTruthy();
    expect(screen.getByText(/敌方自误/)).toBeTruthy();
    expect(
      screen.getByText((c) => c.includes("root") && c.includes("被打破 2 次")),
    ).toBeTruthy();
    const jumps = screen.getAllByTitle("回放此刻");
    fireEvent.click(jumps[0]);
    expect(seeks[0][0]).toBe(39); // tS-3 提前量
    expect(seeks[0][1]).toEqual(["OurPriest"]);
  });

  it("空数据:统一空态文案", () => {
    renderPanel({ friendly: [], enemy: [], rootBreakCount: 0 });
    fireEvent.click(screen.getByTestId("engage-tab-break"));
    expect(screen.getByText("本场无记录。")).toBeTruthy();
  });
});
