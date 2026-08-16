// @vitest-environment jsdom
import { render } from "@testing-library/react";

import { ReplayView } from "../src/renderer/src/report/components/ReplayView";
import {
  activeCcAt,
  deriveCcSpans,
} from "../src/renderer/src/report/derive/replayHighlights";
import type { StoredMatch } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

/** A friendly player eats an enemy Polymorph (t0 → t0+6s) and later an enemy
 *  Entangling Roots (t0+15s → t0+20s). Aura pairing is the same ground truth
 *  analyzePlayerCCAndTrinket consumes — the derive must surface both, tagged
 *  by kind. */
function buildSynthetic(): {
  s: StoredMatch;
  victimId: string;
  t0: number;
} {
  const s = JSON.parse(JSON.stringify(m)) as StoredMatch;
  const units = s.units as Record<string, any>;
  const victim = Object.values(units).find(
    (u: any) => u.info && u.reaction === "Friendly",
  ) as any;
  const enemy = Object.values(units).find(
    (u: any) => u.info && u.reaction === "Hostile",
  ) as any;
  const t0 = s.startTime + 20_000;

  const aura = (
    eventName: string,
    spellId: number,
    spellName: string,
    timestamp: number,
  ) => ({
    eventName,
    timestamp,
    spellId,
    spellName,
    srcId: enemy.id,
    srcName: enemy.name,
    destId: victim.id,
    destName: victim.name,
    auraType: "DEBUFF",
    params: [],
  });

  victim.auraEvents = [
    ...(victim.auraEvents ?? []),
    aura("SPELL_AURA_APPLIED", 118, "Polymorph", t0),
    aura("SPELL_AURA_REMOVED", 118, "Polymorph", t0 + 6_000),
    aura("SPELL_AURA_APPLIED", 339, "Entangling Roots", t0 + 15_000),
    aura("SPELL_AURA_REMOVED", 339, "Entangling Roots", t0 + 20_000),
  ];
  return { s, victimId: victim.id, t0 };
}

describe("回放被控状态(CC 时段派生 + 地图进度条)", () => {
  it("deriveCcSpans:变形术产生 kind=cc 的时段,定身产生 kind=root", () => {
    const { s, victimId, t0 } = buildSynthetic();
    const spans = deriveCcSpans(s)[victimId] ?? [];
    const poly = spans.find((sp) => sp.spellId === "118");
    expect(poly).toBeTruthy();
    expect(poly!.kind).toBe("cc");
    expect(poly!.fromMs).toBe(t0);
    expect(poly!.toMs).toBe(t0 + 6_000);
    expect(poly!.spellName).toBe("Polymorph");
    const roots = spans.find((sp) => sp.spellId === "339");
    expect(roots).toBeTruthy();
    expect(roots!.kind).toBe("root");
    expect(roots!.fromMs).toBe(t0 + 15_000);
    expect(roots!.toMs).toBe(t0 + 20_000);
  });

  it("activeCcAt:窗口内返回该时段,硬 CC 优先于定身,窗口外返回 null", () => {
    const { s, victimId, t0 } = buildSynthetic();
    const spans = deriveCcSpans(s)[victimId] ?? [];
    expect(activeCcAt(spans, t0 + 2_000)?.spellId).toBe("118");
    expect(activeCcAt(spans, t0 + 16_000)?.spellId).toBe("339");
    expect(activeCcAt(spans, t0 + 10_000)).toBeNull();
    // 硬 CC 与定身重叠时报硬 CC
    const overlap = [
      {
        fromMs: 0,
        toMs: 5_000,
        spellId: "339",
        spellName: "Entangling Roots",
        kind: "root" as const,
      },
      {
        fromMs: 1_000,
        toMs: 4_000,
        spellId: "118",
        spellName: "Polymorph",
        kind: "cc" as const,
      },
    ];
    expect(activeCcAt(overlap, 2_000)?.spellId).toBe("118");
  });

  it("真实 fixture:结构不变式(区间正向、kind 合法)", () => {
    for (const spans of Object.values(deriveCcSpans(m))) {
      for (const sp of spans) {
        expect(sp.toMs).toBeGreaterThan(sp.fromMs);
        expect(["cc", "root"]).toContain(sp.kind);
      }
    }
  });

  it("UI:seek 到被控时刻 → 状态环 + 进度条出现,文字含技能名与剩余秒", () => {
    const { s, t0 } = buildSynthetic();
    const { container } = render(
      <ReplayView
        source={s}
        seekReq={{ tMs: t0 + 2_000, unitNames: [], nonce: 1 }}
      />,
    );
    expect(container.querySelector(".rpt-replay-cc-ring")).toBeTruthy();
    const bar = container.querySelector(".rpt-replay-cc-bar");
    expect(bar).toBeTruthy();
    // 剩 6-2=4.0s;文案格式由组件定,但技能名与剩余秒必须都在
    expect(bar!.textContent).toContain("Polymorph");
    expect(bar!.textContent).toContain("4.0");
  });

  it("UI:定身时段用 root 样式;无控制时刻两者皆无", () => {
    const { s, t0 } = buildSynthetic();
    const rooted = render(
      <ReplayView
        source={s}
        seekReq={{ tMs: t0 + 16_000, unitNames: [], nonce: 1 }}
      />,
    ).container;
    expect(rooted.querySelector(".rpt-replay-cc-ring.root")).toBeTruthy();

    const calm = render(
      <ReplayView
        source={m}
        seekReq={{ tMs: m.startTime, unitNames: [], nonce: 1 }}
      />,
    ).container;
    expect(calm.querySelector(".rpt-replay-cc-ring")).toBeNull();
    expect(calm.querySelector(".rpt-replay-cc-bar")).toBeNull();
  });
});
