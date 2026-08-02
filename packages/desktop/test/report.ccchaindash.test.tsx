// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { CCChainPanel } from "../src/renderer/src/report/components/CCChainPanel";
import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import { deriveCCChainDash } from "../src/renderer/src/report/derive/ccChainDash";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

function combatantInfo(specId: number) {
  return {
    teamId: 0,
    specId,
    personalRating: 1500,
    talents: [],
    pvpTalents: [],
    equipment: [],
    interestingAuras: [],
  };
}

/**
 * Enemy CC chain panel (#10 T5): a fully synthetic minimal source (one friend,
 * one enemy) so that CC data already present in the real fixture cannot
 * interfere with the DR-sequence assertions — all the decisions come from
 * analysis's analyzeOutgoingCCChains, and this only verifies the render-layer
 * aggregation (chain length / total duration / wasted flag) and the range
 * filter (display only; it never recomputes the DR sequence). spellId 51514
 * (Hex, 8s CC) applied three times, each gap < DR_RESET_MS (16s):
 * Full → 50% → Immune.
 */
function buildSource(): ReportSource {
  const HEX = { spellId: 51514, spellName: "Hex" };
  const ev = (over: Record<string, unknown>) => ({
    srcId: "p1",
    srcName: "Caster1",
    destId: "p2",
    destName: "Target1",
    auraType: "DEBUFF",
    ...HEX,
    ...over,
  });
  return {
    kind: "match",
    id: "test-cc-chain",
    bracket: "2v2",
    zoneId: "0",
    startTime: 0,
    endTime: 60_000,
    playerId: "p1",
    playerTeamId: 0,
    winningTeamId: null,
    result: "Win",
    linesTotal: 0,
    linesDropped: 0,
    hasAdvancedLogging: true,
    timezone: "UTC",
    units: {
      p1: {
        id: "p1",
        name: "Caster1",
        kind: "Player",
        reaction: "Friendly",
        classId: 9, // Warlock
        specId: 265, // Affliction
        info: combatantInfo(265),
      },
      p2: {
        id: "p2",
        name: "Target1",
        kind: "Player",
        reaction: "Hostile",
        classId: 1,
        specId: 71,
        info: combatantInfo(71),
        auraEvents: [
          ev({ timestamp: 0, eventName: "SPELL_AURA_APPLIED" }),
          ev({ timestamp: 2_000, eventName: "SPELL_AURA_REMOVED" }),
          ev({ timestamp: 6_000, eventName: "SPELL_AURA_APPLIED" }),
          ev({ timestamp: 8_000, eventName: "SPELL_AURA_REMOVED" }),
          ev({ timestamp: 12_000, eventName: "SPELL_AURA_APPLIED" }),
          ev({ timestamp: 14_000, eventName: "SPELL_AURA_REMOVED" }),
        ],
      },
    },
  } as unknown as ReportSource;
}

/**
 * A single boundary-crossing CC (#10 T5, adopted from the agy flash review): a
 * 10s application over [40,50] overlaps the [45,60] window by only 5s — CC is a
 * DURATION fact, so filtering and timing must both use timeRange.ts's
 * overlap-seconds predicate (the same one statsTable.ts uses for CC instances)
 * rather than the atSeconds point test meant for instantaneous events;
 * otherwise an application that "starts outside the window but spends most of
 * itself inside it" gets discarded entirely.
 */
function buildBoundarySource(): ReportSource {
  const base = buildSource();
  const p2 = (base.units as unknown as Record<string, Record<string, unknown>>)
    .p2!;
  const ev = (over: Record<string, unknown>) => ({
    srcId: "p1",
    srcName: "Caster1",
    destId: "p2",
    destName: "Target1",
    auraType: "DEBUFF",
    spellId: 51514,
    spellName: "Hex",
    ...over,
  });
  p2.auraEvents = [
    ...(p2.auraEvents as unknown[]),
    ev({ timestamp: 40_000, eventName: "SPELL_AURA_APPLIED" }),
    ev({ timestamp: 50_000, eventName: "SPELL_AURA_REMOVED" }),
  ];
  return base;
}

const m = buildSource();

describe("敌方 CC 链面板(#10 T5)", () => {
  it("range 按重叠秒数过滤/计时(agy flash 复核采纳):起点在窗口外但大半段落入窗口的应用仍计入,totalCcSeconds 按重叠部分累加,apps 里的 durationSeconds 保留原始全长", () => {
    const boundary = buildBoundarySource();
    const windowed = deriveCCChainDash(boundary, { fromS: 45, toS: 60 });
    const row = windowed.rows[0]!;
    // The original 3 applications (0/6/12s) all fall outside [45,60]; only the
    // 4th (40-50s) overlaps the window, by 5s — so chainLen must be 1, not 0
    // (proving the atSeconds point test did not wrongly kill it).
    expect(row.chainLen).toBe(1);
    expect(row.totalCcSeconds).toBeCloseTo(5, 5);
    // The detail row still shows the application's real full length (10s), not
    // the 5s left after window clipping.
    expect(row.apps[0]!.durationSeconds).toBeCloseTo(10, 5);
    expect(row.apps[0]!.atSeconds).toBeCloseTo(40, 5);
  });
  it("deriveCCChainDash:三次应用聚合成一条链(链长 3,总时长 6s),含一次 Immune → wasted=true", () => {
    const dash = deriveCCChainDash(m);
    expect(dash.rows).toHaveLength(1);
    const row = dash.rows[0]!;
    expect(row.targetName).toBe("Target1");
    expect(row.chainLen).toBe(3);
    expect(row.totalCcSeconds).toBeCloseTo(6, 5);
    expect(row.wasted).toBe(true);
    expect(row.apps.map((a) => a.drInfo.level)).toEqual([
      "Full",
      "50%",
      "Immune",
    ]);
  });

  it("range 过滤只影响展示行:窗口 [5,20] 排除第 1 次应用,但 DR 序列(第 3 次仍是 Immune)不因窗口重算", () => {
    const full = deriveCCChainDash(m);
    const windowed = deriveCCChainDash(m, { fromS: 5, toS: 20 });
    expect(full.rows[0]!.chainLen).toBe(3);
    const windowedRow = windowed.rows[0]!;
    expect(windowedRow.chainLen).toBe(2);
    // The two displayed applications are the chain's 2nd and 3rd — the 3rd is
    // still Immune even though the 1st is out of the window's view (the
    // decision is computed on the full stream and never falls back to
    // Full/50% just because the range narrowed).
    expect(windowedRow.apps.map((a) => a.drInfo.level)).toEqual([
      "50%",
      "Immune",
    ]);
    expect(windowedRow.wasted).toBe(true);
  });

  it("range 完全排除该目标的应用 → 该行消失(不留 chainLen=0 的空行)", () => {
    const dash = deriveCCChainDash(m, { fromS: 100, toS: 200 });
    expect(dash.rows).toHaveLength(0);
  });

  it("CCChainPanel:渲染行 + 点击展开明细 + 25%/免疫档标红(chip-bad)+ ▶ 跳回放", () => {
    const dash = deriveCCChainDash(m);
    const jumped: Array<[number, string[]]> = [];
    const { container } = render(
      <CCChainPanel
        rows={dash.rows}
        onSeek={(t, names) => jumped.push([t, names])}
      />,
    );
    expect(screen.getByTestId("cc-chain-dash")).toBeTruthy();
    const row = container.querySelector(
      "[data-testid=cc-chain-dash] tr.rpt-stats-expandable",
    );
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    const detailItems = container.querySelectorAll(".rpt-stats-detail-item");
    expect(detailItems.length).toBe(3);
    // At least one 25%/immune tier flagged red (rpt-ledger-chip-bad) — here it
    // is the 3rd one (Immune)
    const badChips = container.querySelectorAll(
      ".rpt-stats-detail-item .rpt-ledger-chip-bad",
    );
    expect(badChips.length).toBe(1);
    const jumpBtn = container.querySelector(".rpt-stats-detail-jump");
    expect(jumpBtn).toBeTruthy();
    fireEvent.click(jumpBtn!);
    expect(jumped.length).toBe(1);
    expect(jumped[0]![1]).toEqual(["Caster1", "Target1"]);
  });

  it("空态保壳(P1-1):无 CC 链时仍出卡壳 + 一行空态,不出表格", () => {
    const { container } = render(<CCChainPanel rows={[]} />);
    expect(
      container.querySelector("[data-testid=cc-chain-dash] .rpt-ledger-empty")
        ?.textContent,
    ).toContain("控制链");
    expect(container.querySelector("table")).toBeNull();
  });

  it("战报视图集成:对局面板「CC链」tab 下挂载(1a 合卡;真实 fixture,native 数组齐全,不重造合成源)", () => {
    // The synthetic source (m) only carries the fields ccChainDash needs and
    // lacks native arrays deriveSummary reads directly (damageOut etc.) — so
    // the real fixture is used to walk the full mount path, verifying only
    // where the panel mounts and that it does not crash, without asserting on
    // specific DR values (those are already pinned by the synthetic cases
    // above).
    render(<MatchReport source={loadRealMatchFixture()} matchId="t" />);
    fireEvent.click(screen.getByTestId("engage-tab-cc"));
    expect(screen.getByTestId("cc-chain-dash")).toBeTruthy();
  });
});
