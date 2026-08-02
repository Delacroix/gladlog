// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";

import { ReplayView } from "../src/renderer/src/report/components/ReplayView";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

/**
 * The opening position blind window.
 *
 * Coordinates ride only on `*_DAMAGE` (the unit taking damage), `*_HEAL` (the
 * unit healed) and `SPELL_CAST_SUCCESS` (the caster) records, and running
 * produces no combat-log record at all — someone who is merely running at the
 * start has not a single record about them in the log. Measured on this
 * fixture, the first sample per player lands at +0.6 / +1.2 / +1.5 / +2.8 /
 * +5.4 / +14.2 seconds.
 *
 * That stretch must be marked "position unknown" and must not be drawn as a
 * known position: sampleAt can only pin the position to the first sample, which
 * is "where they first got dragged into the fight" — usually most of the arena
 * away from where they started.
 */
describe("回放开局的位置盲窗", () => {
  it("开局时刻:所有单位都还没有坐标依据 → 全部标成未知态", () => {
    const { container } = render(<ReplayView source={m} />);
    const units = container.querySelectorAll(".rpt-replay-unit");
    expect(units.length).toBeGreaterThan(0);
    const asserted = [...units].filter(
      (u) => !u.classList.contains("rpt-replay-unit-unknown"),
    );
    expect(asserted).toHaveLength(0);
  });

  it("开局时刻不画走位尾迹(没有走过的路可画)", () => {
    const { container } = render(<ReplayView source={m} />);
    expect(container.querySelectorAll(".rpt-replay-trail")).toHaveLength(0);
  });

  it("拖到 +20s(晚于所有人的首样本)→ 不再有未知态", () => {
    const { container } = render(<ReplayView source={m} />);
    const scrub = container.querySelector(
      ".rpt-replay-scrub",
    ) as HTMLInputElement;
    fireEvent.change(scrub, {
      target: { value: String(m.startTime + 20_000) },
    });
    const units = container.querySelectorAll(".rpt-replay-unit");
    expect(units.length).toBeGreaterThan(0);
    const unknown = [...units].filter((u) =>
      u.classList.contains("rpt-replay-unit-unknown"),
    );
    expect(unknown).toHaveLength(0);
  });
});
