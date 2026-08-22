// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Meters } from "../src/renderer/src/report/components/Meters";
import { checkFaithful } from "../src/renderer/src/report/derive/faithfulness";
import { meterRows } from "../src/renderer/src/report/derive/meterRows";
import { deriveSummary } from "../src/renderer/src/report/derive/summary";
import { loadMatchFixture } from "./fixtures/loadFixture";

const m = loadMatchFixture();
const rows = deriveSummary(m);

describe("checkFaithful: meters", () => {
  it("real fixture render is faithful (no divergences)", () => {
    const model = meterRows(rows, "damage");
    const { container } = render(<Meters rows={rows} mode="damage" />);
    expect(checkFaithful("meters", container, model)).toEqual([]);
  });

  it("HAS TEETH: a mis-scaled bar width is caught", () => {
    const model = meterRows(rows, "damage");
    const { container } = render(<Meters rows={rows} mode="damage" />);
    const bar = container.querySelector<HTMLElement>(".rpt-meter-bar");
    expect(bar).toBeTruthy();
    bar!.style.width = "999%"; // deliberate lie: out of range AND != selector
    const divs = checkFaithful("meters", container, model);
    expect(divs.length).toBeGreaterThan(0);
    expect(divs.some((d) => d.invariant === "view-faithful")).toBe(true);
    expect(divs.some((d) => d.invariant === "range")).toBe(true);
  });

  it("HAS TEETH: a fabricated number label is caught", () => {
    const model = meterRows(rows, "damage");
    const { container } = render(<Meters rows={rows} mode="damage" />);
    const valEl = container.querySelector<HTMLElement>(".rpt-meter-value");
    expect(valEl).toBeTruthy();
    valEl!.textContent = "9,999,999"; // fabricated
    const divs = checkFaithful("meters", container, model);
    expect(
      divs.some(
        (d) =>
          d.invariant === "view-faithful" || d.invariant === "format-roundtrip",
      ),
    ).toBe(true);
  });

  it("HAS TEETH: a px width (not %) is caught (parseFloat would strip the unit)", () => {
    const model = meterRows(rows, "damage");
    const { container } = render(<Meters rows={rows} mode="damage" />);
    const bar = container.querySelector<HTMLElement>(".rpt-meter-bar");
    // Same numeric value, wrong unit: a visually-broken 50px bar.
    bar!.style.width = `${model[0]!.widthPct}px`;
    const divs = checkFaithful("meters", container, model);
    expect(divs.some((d) => d.invariant === "unit")).toBe(true);
  });

  it("one identity element per row (UI review #6): icon/glyph with the side ring, no separate team dot", () => {
    const sides = new Map(
      rows.map((r, i) => [r.unitId, i % 2 ? "enemy" : "friendly"] as const),
    );
    const { container } = render(
      <Meters rows={rows} mode="damage" teamSides={sides} />,
    );
    const first = container.querySelector(".rpt-meter-row")!;
    expect(first.querySelectorAll(".rpt-meter-ident")).toHaveLength(1);
    expect(first.querySelector("[data-testid=team-dot]")).toBeNull();
    expect(
      first.querySelector(".rpt-meter-ident")!.getAttribute("data-side"),
    ).toMatch(/friendly|enemy/);
    // Faithfulness of the new markup is covered by the bare-render case above
    // (checkFaithful's monotonic invariant assumes the flat, ungrouped list).
  });

  it("HAS TEETH: a fabricated tooltip is caught", () => {
    const model = meterRows(rows, "damage");
    const { container } = render(<Meters rows={rows} mode="damage" />);
    const row = container.querySelector<HTMLElement>(".rpt-meter-row");
    row!.setAttribute("title", "Someone: 42"); // fabricated tooltip number
    const divs = checkFaithful("meters", container, model);
    expect(
      divs.some(
        (d) =>
          d.invariant === "view-faithful" && d.sourceRef.endsWith(".title"),
      ),
    ).toBe(true);
  });
});
