// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { IMatchArcPhase } from "@gladlog/analysis/src/context/matchNarrative";

import { MatchArcLine } from "./MatchArcLine";

// #10 T4:比赛节奏头部行。三相位 + 可点转折点(onSeek 收到 tS);短场两相位
// 无转折点也要能渲染;空数组不渲染整行(挂载方直接消费 deriveMatchArc 的
// stub-safe []).

const threePhases: IMatchArcPhase[] = [
  {
    phase: "early",
    fromS: 0,
    toS: 12,
    prose: "No coordinated enemy burst in opening phase.",
    turningPoint: { tS: 12, label: "PlayerA's Barkskin" },
  },
  {
    phase: "mid",
    fromS: 12,
    toS: 40,
    prose:
      "PlayerA's Barkskin committed — limited major CD coverage remaining.",
    turningPoint: { tS: 40, label: "PlayerB died" },
  },
  {
    phase: "late",
    fromS: 40,
    toS: 90,
    prose:
      "Pressure continued with limited defensive options → PlayerB died at 1:30.",
  },
];

const twoPhases: IMatchArcPhase[] = [
  {
    phase: "early",
    fromS: 0,
    toS: 7,
    prose: "Early pressure established — no recovery window.",
  },
  {
    phase: "late",
    fromS: 7,
    toS: 15,
    prose: "PlayerB died at 0:15 — speed kill.",
  },
];

describe("MatchArcLine", () => {
  it("渲染三相位(早期/中期/后期),含两个可点转折点", () => {
    render(<MatchArcLine phases={threePhases} onSeek={vi.fn()} />);
    const line = screen.getByTestId("match-arc-line");
    expect(line.textContent).toContain("早期");
    expect(line.textContent).toContain("中期");
    expect(line.textContent).toContain("后期");
    expect(screen.getAllByRole("button").length).toBe(2);
  });

  it("点转折点按钮 → onSeek 收到 turningPoint.tS", () => {
    const onSeek = vi.fn();
    render(<MatchArcLine phases={threePhases} onSeek={onSeek} />);
    screen.getByRole("button", { name: "PlayerA's Barkskin" }).click();
    expect(onSeek).toHaveBeenCalledWith(12, []);
    screen.getByRole("button", { name: "PlayerB died" }).click();
    expect(onSeek).toHaveBeenCalledWith(40, []);
  });

  it("短场(<90s)两相位:早期/后期,无转折点不渲染按钮", () => {
    render(<MatchArcLine phases={twoPhases} />);
    const line = screen.getByTestId("match-arc-line");
    expect(line.textContent).toContain("早期");
    expect(line.textContent).toContain("后期");
    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("空相位数组 → 整行不渲染", () => {
    const { container } = render(<MatchArcLine phases={[]} />);
    expect(
      container.querySelector('[data-testid="match-arc-line"]'),
    ).toBeNull();
  });

  it("未传 onSeek 时转折点不渲染成死按钮(agy 复核:看着能点却点不动)", () => {
    render(<MatchArcLine phases={threePhases} />);
    expect(screen.queryAllByRole("button").length).toBe(0);
  });
});
