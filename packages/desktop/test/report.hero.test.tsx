// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import { deriveTimeline } from "../src/renderer/src/report/derive/timeline";
import { loadMatchFixture } from "./fixtures/loadFixture";

const m = loadMatchFixture();

describe("hero line + overflow menu (UI review #1)", () => {
  it("hero line carries result + meta on every view; 终结 is no longer a KPI chip", () => {
    render(<MatchReport source={m} matchId="t" />);
    const hero = screen.getByTestId("rpt-hero");
    expect(hero.textContent).toMatch(/胜利|败北|平局/);
    expect(hero.textContent).toContain(m.bracket);
    // 终结 lives on the hero line (or nowhere), never in the KPI row
    const deaths = deriveTimeline(m).deaths.length;
    expect(screen.queryByTestId("hero-finisher") != null).toBe(deaths > 0);
    expect(
      screen.getByTestId("kpi-chips").querySelector(".rpt-kpi-click"),
    ).toBeNull();
    expect(screen.getByTestId("kpi-chips").textContent).not.toContain("终结");
    // Survives a view switch (it sits outside the view switch)
    fireEvent.click(screen.getByRole("button", { name: "事件" }));
    expect(screen.getByTestId("rpt-hero")).toBeTruthy();
  });

  it("workflow buttons live in the ⋯ menu; 报告问题 keeps its testid; Escape closes", () => {
    render(<MatchReport source={m} matchId="t" />);
    expect(screen.queryByText("复制 Markdown")).toBeNull();
    expect(screen.queryByTestId("bug-report-btn")).toBeNull();
    fireEvent.click(screen.getByTestId("rpt-overflow-btn"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("复制 Markdown")).toBeTruthy();
    expect(screen.getByText("导出图片")).toBeTruthy();
    expect(screen.getByTestId("bug-report-btn")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("报告问题 from the menu opens the bug-report modal", () => {
    render(<MatchReport source={m} matchId="t" />);
    fireEvent.click(screen.getByTestId("rpt-overflow-btn"));
    fireEvent.click(screen.getByTestId("bug-report-btn"));
    expect(screen.getByTestId("bug-comment")).toBeTruthy();
    // The menu closed itself on selection
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
