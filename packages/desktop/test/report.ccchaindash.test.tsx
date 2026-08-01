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
 * 敌方 CC 链面板(#10 T5):完全合成的最小源(一友一敌),避免真实 fixture
 * 里既有的 CC 数据干扰 DR 序列断言——判定全部消费 analysis 的
 * analyzeOutgoingCCChains,这里只验证渲染层聚合(链长/总时长/浪费标志)与
 * range 过滤(只影响展示,不重算 DR 序列)。spellId 51514(Hex,cc 8s)三次
 * 应用,每次间隔 < DR_RESET_MS(16s):Full → 50% → Immune。
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
 * 单条跨界 CC(#10 T5,agy flash 复核采纳):10s 应用 [40,50],窗口 [45,60] 与
 * 之只重叠 5s——CC 是「时长事实」,过滤/计时都必须按 timeRange.ts 的重叠秒数
 * 谓词(与 statsTable.ts 的 CC 实例口径同一份),不是瞬时事件的 atSeconds 落点
 * 判定:否则这种「起点在窗口外、大半段落在窗口内」的应用会被整条错误丢弃。
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
    // 原链 3 条(0/6/12s)全部落在 [45,60] 之外,只有第 4 条(40-50s)与窗口
    // 重叠 5s——chainLen 必须是 1,不是 0(证明没有被 atSeconds 落点判定误杀)。
    expect(row.chainLen).toBe(1);
    expect(row.totalCcSeconds).toBeCloseTo(5, 5);
    // 明细展示仍是这条应用的真实全长(10s),不是被窗口裁剪后的 5s。
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
    // 展示的两条应用是原链的第 2/3 次——第 3 次即便脱离第 1 次的窗口视野依然
    // 是 Immune(判定在全量流上算,不因 range 收窄而退回 Full/50%)。
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
    // 至少一条 25%/免疫档标红(rpt-ledger-chip-bad)——本例是第 3 条(Immune)
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

  it("战报视图集成:面板挂载于 Kick/Dispel 之后(真实 fixture,native 数组齐全,不重造合成源)", () => {
    // 合成源(m)只裁了 ccChainDash 判定要用的字段,缺 damageOut 等 deriveSummary
    // 直读的 native 数组——用真实 fixture 走完整挂载路径,只验证面板挂载
    // 位置/不崩,不对具体 DR 数值断言(那部分已由上面的合成源用例锁定)。
    render(<MatchReport source={loadRealMatchFixture()} matchId="t" />);
    expect(screen.getByTestId("cc-chain-dash")).toBeTruthy();
  });
});
