// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KpiChips } from "../src/renderer/src/report/components/KpiChips";
import { deriveDispelDash } from "../src/renderer/src/report/derive/dispelDash";
import { deriveStatsTable } from "../src/renderer/src/report/derive/statsTable";
import { deriveTimeline } from "../src/renderer/src/report/derive/timeline";
import type { StoredMatch } from "../src/renderer/src/report/derive/types";
import { loadMatchFixture } from "./fixtures/loadFixture";

const m = loadMatchFixture();

type RawUnit = {
  id: string;
  name: string;
  info?: unknown;
  reaction: string;
  casts: Array<Record<string, unknown>>;
  actionsOut?: Array<Record<string, unknown>>;
};

/**
 * The fixture has `actionsOut` stripped (loadFixture.ts), so every dispel
 * here is injected: on the first friendly player, a deliberate Purify (cast +
 * dispel at the same instant), a Cleanse the Weak proc (no cast) and a Cat
 * Form rider (listed id). Raw shape mirrors what parser-compat's convert.ts
 * reads: `srcId/destId/spellId` plus the raw `params` array whose [11]/[12]
 * carry the removed aura (extraSpellFields).
 */
function withDispels(): { clone: StoredMatch; me: RawUnit; ally: RawUnit } {
  const clone = JSON.parse(JSON.stringify(m)) as StoredMatch;
  const units = Object.values(
    clone.units as unknown as Record<string, RawUnit>,
  );
  const friends = units.filter((u) => u.info && u.reaction === "Friendly");
  const me = friends[0]!;
  const ally = friends[1] ?? me;
  const t = clone.startTime + 30_000;
  const mk = (spellId: number, spellName: string, ts: number) => ({
    timestamp: ts,
    eventName: "SPELL_DISPEL",
    srcId: me.id,
    srcName: me.name,
    destId: ally.id,
    destName: ally.name,
    spellId,
    spellName,
    params: [
      me.id,
      me.name,
      "0x511",
      "0x0",
      ally.id,
      ally.name,
      "0x512",
      "0x0",
      String(spellId),
      spellName,
      "0x2",
      "589",
      "Shadow Word: Pain",
      "0x20",
      "DEBUFF",
    ],
  });
  me.actionsOut = [
    ...(me.actionsOut ?? []),
    mk(527, "Purify", t),
    mk(199427, "Cleanse the Weak", t + 5000),
    mk(768, "Cat Form", t + 9000),
  ];
  me.casts = [
    ...me.casts,
    {
      timestamp: t,
      eventName: "SPELL_CAST_SUCCESS",
      srcId: me.id,
      srcName: me.name,
      destId: ally.id,
      destName: ally.name,
      spellId: 527,
      spellName: "Purify",
      params: [
        me.id,
        me.name,
        "0x511",
        "0x0",
        ally.id,
        ally.name,
        "0x512",
        "0x0",
        "527",
        "Purify",
        "0x2",
      ],
    },
  ];
  return { clone, me, ally };
}

describe("dispel dashboard splits deliberate vs passive (UI review #3)", () => {
  it("row counts, instance labels and friendly totals", () => {
    const { clone, me } = withDispels();
    const dash = deriveDispelDash(clone);
    const row = dash.rows.find((r) => r.unitId === me.id);
    expect(row).toBeTruthy();
    expect(row!.cleanses).toBe(1);
    expect(row!.passive).toBe(2);
    expect(dash.totals).toEqual({ friendlyDeliberate: 1, friendlyPassive: 2 });
    const passive = row!.events.filter((e) => e.passive);
    expect(passive).toHaveLength(2);
    expect(passive.every((e) => e.label.endsWith("(被动)"))).toBe(true);
    expect(row!.events.find((e) => !e.passive)!.label).not.toContain("被动");
  });

  it("stats table 驱散 column counts deliberate only", () => {
    const { clone, me } = withDispels();
    const rows = deriveStatsTable(clone);
    const mine = rows.find((r) => r.unitId === me.id)!;
    expect(mine.cleanses).toBe(1);
  });

  it("KPI chip renders the deliberate count with a passive suffix", () => {
    const { clone } = withDispels();
    const dash = deriveDispelDash(clone);
    const { container } = render(
      <KpiChips
        timeline={deriveTimeline(clone)}
        mistakes={[]}
        bands={[]}
        kickRows={[]}
        dispelDash={dash}
      />,
    );
    const chip = container.querySelector("[data-testid=kpi-dispel]")!;
    expect(chip.querySelector(".rpt-kpi-v")!.textContent).toMatch(/^1/);
    expect(chip.querySelector(".rpt-kpi-passive")!.textContent).toBe("+2 被动");
  });

  it("no passive dispels → no suffix (the unmodified fixture has none)", () => {
    const dash = deriveDispelDash(m);
    const { container } = render(
      <KpiChips
        timeline={deriveTimeline(m)}
        mistakes={[]}
        bands={[]}
        kickRows={[]}
        dispelDash={dash}
      />,
    );
    expect(container.querySelector(".rpt-kpi-passive")).toBeNull();
  });
});
