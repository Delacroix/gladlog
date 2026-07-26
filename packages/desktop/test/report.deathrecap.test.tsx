// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { DeathRecapCard } from "../src/renderer/src/report/components/DeathRecapCard";
import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import { deriveDeathRecaps } from "../src/renderer/src/report/derive/deathRecap";
import { toLegacySafe } from "../src/renderer/src/report/derive/legacySource";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const base = loadRealMatchFixture();

// fixture 裁剪到前 90s,没有玩家死亡(唯一 death 是 NPC)——克隆并给承伤最多的
// 玩家注入一次死亡(时刻取其最后一次承伤),走真实转换/判定管线。
function withInjectedDeath() {
  const m = JSON.parse(JSON.stringify(base)) as typeof base;
  const players = Object.values(m.units).filter(
    (u) =>
      u.kind === "Player" && (u as { damageIn?: unknown[] }).damageIn?.length,
  ) as unknown as Array<{
    id: string;
    name: string;
    damageIn: Array<{ timestamp: number }>;
    deaths: Array<Record<string, unknown>>;
  }>;
  players.sort((a, b) => b.damageIn.length - a.damageIn.length);
  const victim = players[0]!;
  const t = Math.max(...victim.damageIn.map((d) => d.timestamp));
  victim.deaths.push({
    timestamp: t,
    eventName: "UNIT_DIED",
    spellId: 0,
    spellName: "",
    srcId: "",
    srcName: "",
    destId: victim.id,
    destName: victim.name,
    unconscious: false,
  });
  return { m, victim, deathTMs: t };
}

const { m, victim } = withInjectedDeath();

describe("死亡回顾(backlog #6)", () => {
  it("deriveDeathRecaps:真实 fixture 出 1 条回顾,事件升序且含承伤", () => {
    const recaps = deriveDeathRecaps(m);
    expect(recaps.length).toBeGreaterThanOrEqual(1);
    const r = recaps[0]!;
    expect(r.deathS).toBeGreaterThan(0);
    for (let i = 1; i < r.events.length; i++) {
      expect(r.events[i]!.tS).toBeGreaterThanOrEqual(r.events[i - 1]!.tS);
    }
    // 死前窗口内必有伤害事件(死总得有原因)
    expect(r.events.some((e) => e.kind === "dmg")).toBe(true);
    // 事件都在窗口内
    for (const e of r.events) {
      expect(e.tS).toBeLessThanOrEqual(r.deathS + 0.001);
      expect(e.tS).toBeGreaterThanOrEqual(r.deathS - 10.001);
    }
  });

  it("DeathRecapCard:渲染标题/事件行;回放此刻回调带死者名", () => {
    const recaps = deriveDeathRecaps(m);
    const jumped: Array<[number, string[]]> = [];
    render(
      <DeathRecapCard
        recap={recaps[0]!}
        onClose={() => {}}
        onJump={(t, names) => jumped.push([t, names])}
      />,
    );
    expect(screen.getByText(/死亡回顾 —/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /回放此刻/ }));
    expect(jumped.length).toBe(1);
    expect(jumped[0]![1]).toEqual([victim.name]);
    expect(jumped[0]![0]).toBeCloseTo(Math.max(0, recaps[0]!.deathS - 8), 3);
  });

  it("P1-3:进战报默认展开最近一次死亡回顾;✕ 关闭后本场不再自动打开", () => {
    render(<MatchReport source={m} matchId="t" />);
    // 挂载 effect 即自动展开(无需点击),内容归属注入的死者
    const card = screen.getByTestId("death-recap");
    expect(card.textContent).toContain(victim.name.split("-")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByTestId("death-recap")).toBeNull();
  });

  it("战报视图:点死亡标记打开回顾卡,✕ 关闭", () => {
    const { container } = render(<MatchReport source={m} matchId="t" />);
    const marker = container.querySelector(".rpt-tl-death-click");
    expect(marker).toBeTruthy();
    fireEvent.click(marker!);
    expect(screen.getByTestId("death-recap")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByTestId("death-recap")).toBeNull();
  });
});

describe("回放视图死亡回顾入口(#6 v2)", () => {
  it("scrub 到死亡后点 ✕ → 回顾卡打开(回放视图内)", () => {
    const { container } = render(<MatchReport source={m} matchId="t" />);
    fireEvent.click(screen.getByRole("button", { name: "回放" }));
    // scrub 到末尾让阵亡残影出现
    const scrub = container.querySelector(
      ".rpt-replay-scrub",
    ) as HTMLInputElement;
    fireEvent.change(scrub, { target: { value: scrub.max } });
    const ghost = container.querySelector(".rpt-replay-ghost-click");
    expect(ghost).toBeTruthy();
    fireEvent.click(ghost!);
    expect(screen.getByTestId("death-recap")).toBeTruthy();
    // 关闭后仍在回放视图
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByTestId("death-recap")).toBeNull();
    expect(container.querySelector(".rpt-replay-scrub")).toBeTruthy();
  });

  it("泳道阵亡 divider 也可开回顾", () => {
    const { container } = render(<MatchReport source={m} matchId="t" />);
    fireEvent.click(screen.getByRole("button", { name: "回放" }));
    const divider = container.querySelector(".rpt-gcd-death-click");
    expect(divider).toBeTruthy();
    fireEvent.click(divider!);
    expect(screen.getByTestId("death-recap")).toBeTruthy();
  });
});

describe("死亡回顾血量曲线采样(hpSeries)", () => {
  it("deriveDeathRecaps: 能够根据 advancedActions 采样出 hpSeries 且序列非空时末尾追加死亡终点", () => {
    const { m, victim, deathTMs } = withInjectedDeath();

    const matchStartMs = m.startTime;
    const deathS = (deathTMs - matchStartMs) / 1000;

    const legacy = toLegacySafe(m);
    const legacyVictim = legacy.units[victim.id];
    expect(legacyVictim).toBeDefined();

    legacyVictim.advancedActions = [
      {
        logLine: { event: "ADVANCED_SAMPLE", timestamp: deathTMs - 10000 },
        advancedActorId: victim.id,
        advancedActorCurrentHp: 100,
        advancedActorMaxHp: 100,
        advancedActorPositionX: 0,
        advancedActorPositionY: 0,
        advanced: true,
        timestamp: deathTMs - 10000,
        advancedActorPowers: [],
      },
      {
        logLine: { event: "ADVANCED_SAMPLE", timestamp: deathTMs - 5000 },
        advancedActorId: victim.id,
        advancedActorCurrentHp: 50,
        advancedActorMaxHp: 100,
        advancedActorPositionX: 0,
        advancedActorPositionY: 0,
        advanced: true,
        timestamp: deathTMs - 5000,
        advancedActorPowers: [],
      },
      {
        logLine: { event: "ADVANCED_SAMPLE", timestamp: deathTMs },
        advancedActorId: victim.id,
        advancedActorCurrentHp: 10,
        advancedActorMaxHp: 100,
        advancedActorPositionX: 0,
        advancedActorPositionY: 0,
        advanced: true,
        timestamp: deathTMs,
        advancedActorPowers: [],
      },
    ];

    const recaps = deriveDeathRecaps(m);
    const r = recaps.find((x) => x.unitId === victim.id);
    expect(r).toBeDefined();
    if (!r) return;

    // hpSeries 必须有值，且末尾追加了 { tS: deathS, pct: 0 }
    expect(r.hpSeries.length).toBeGreaterThan(0);
    const lastPoint = r.hpSeries[r.hpSeries.length - 1];
    expect(lastPoint).toEqual({ tS: deathS, pct: 0 });

    // 验证特定的采样点与网格时刻值
    const p10 = r.hpSeries.find((p) => Math.abs(p.tS - (deathS - 10)) < 0.001);
    expect(p10).toBeDefined();
    expect(p10!.pct).toBe(100);

    const p5 = r.hpSeries.find((p) => Math.abs(p.tS - (deathS - 5)) < 0.001);
    expect(p5).toBeDefined();
    expect(p5!.pct).toBe(50);

    const p0 = r.hpSeries.find((p) => Math.abs(p.tS - deathS) < 0.001 && p.pct > 0);
    expect(p0).toBeDefined();
    expect(p0!.pct).toBe(10);
  });

  it("deriveDeathRecaps: 当 advancedActions 清空时 hpSeries 应为 []", () => {
    const { m, victim } = withInjectedDeath();
    const legacy = toLegacySafe(m);
    const legacyVictim = legacy.units[victim.id];
    legacyVictim.advancedActions = [];

    const recaps = deriveDeathRecaps(m);
    const r = recaps.find((x) => x.unitId === victim.id);
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.hpSeries).toEqual([]);
  });
});
