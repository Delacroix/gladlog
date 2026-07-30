// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";

import { DeathRecapCard } from "../src/renderer/src/report/components/DeathRecapCard";
import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import {
  DeathRecap,
  deriveDeathRecaps,
} from "../src/renderer/src/report/derive/deathRecap";
import { toLegacySafe } from "../src/renderer/src/report/derive/legacySource";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
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
  it("scrub 到死亡后点 ✕ → 切回战报视图并在常驻栏展示(回顾只有一个家,2026-07-26)", () => {
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
    // 浮层已移除:点死亡 → 自动切战报视图,回顾出现在右栏常驻位
    expect(screen.getByTestId("death-recap")).toBeTruthy();
    expect(container.querySelector(".rpt-recap-col")).toBeTruthy();
    expect(container.querySelector(".rpt-replay-scrub")).toBeNull();
    // 关闭后留在战报视图,常驻栏回到占位态
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByTestId("death-recap")).toBeNull();
    expect(container.querySelector(".rpt-recap-placeholder")).toBeTruthy();
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

describe("死亡回顾血条 v2 (derive)", () => {
  it("deriveDeathRecaps: 能够匹配 advancedActions 计算出 hpBeforePct 和 hpAfterPct", () => {
    const { m, victim, deathTMs } = withInjectedDeath();
    const legacy = toLegacySafe(m);
    const legacyVictim = legacy.units[victim.id];

    const tDmg = deathTMs - 5000;
    const tHeal = deathTMs - 3000;
    const tNoSample = deathTMs - 1000;

    legacyVictim.damageIn = [
      {
        srcUnitFlags: 0,
        destUnitFlags: 0,
        timestamp: tDmg,
        srcUnitName: "Attacker",
        destUnitName: victim.name,
        logLine: { event: "SPELL_DAMAGE", timestamp: tDmg, parameters: [] },
        spellId: "12222",
        spellName: "Test Dmg",
        srcUnitId: "enemy-1",
        destUnitId: victim.id,
        amount: 20000,
        effectiveAmount: -20000,
      },
      {
        srcUnitFlags: 0,
        destUnitFlags: 0,
        timestamp: tNoSample,
        srcUnitName: "Attacker",
        destUnitName: victim.name,
        logLine: {
          event: "SPELL_DAMAGE",
          timestamp: tNoSample,
          parameters: [],
        },
        spellId: "12222",
        spellName: "No Sample Dmg",
        srcUnitId: "enemy-1",
        destUnitId: victim.id,
        amount: 10000,
        effectiveAmount: -10000,
      },
    ];

    legacyVictim.healIn = [
      {
        srcUnitFlags: 0,
        destUnitFlags: 0,
        timestamp: tHeal,
        srcUnitName: "Healer",
        destUnitName: victim.name,
        logLine: { event: "SPELL_HEAL", timestamp: tHeal, parameters: [] },
        spellId: "33333",
        spellName: "Test Heal",
        srcUnitId: "healer-1",
        destUnitId: victim.id,
        amount: 10000,
        effectiveAmount: 10000,
      },
    ];

    legacyVictim.advancedActions = [
      {
        logLine: { event: "ADVANCED_SAMPLE", timestamp: tDmg },
        advancedActorId: victim.id,
        advancedActorCurrentHp: 50000,
        advancedActorMaxHp: 100000,
        advancedActorPositionX: 0,
        advancedActorPositionY: 0,
        advanced: true,
        timestamp: tDmg,
        advancedActorPowers: [],
      },
      {
        logLine: { event: "ADVANCED_SAMPLE", timestamp: tHeal },
        advancedActorId: victim.id,
        advancedActorCurrentHp: 80000,
        advancedActorMaxHp: 100000,
        advancedActorPositionX: 0,
        advancedActorPositionY: 0,
        advanced: true,
        timestamp: tHeal,
        advancedActorPowers: [],
      },
    ];

    const recaps = deriveDeathRecaps(m);
    const r = recaps.find((x) => x.unitId === victim.id);
    expect(r).toBeDefined();
    if (!r) return;

    const dmgEvent = r.events.find((e) => e.spell === "Test Dmg");
    expect(dmgEvent).toBeDefined();
    expect(dmgEvent!.hpBeforePct).toBeCloseTo(70, 3);
    expect(dmgEvent!.hpAfterPct).toBeCloseTo(50, 3);

    const healEvent = r.events.find((e) => e.spell === "Test Heal");
    expect(healEvent).toBeDefined();
    expect(healEvent!.hpBeforePct).toBeCloseTo(70, 3);
    expect(healEvent!.hpAfterPct).toBeCloseTo(80, 3);

    const noSampleEvent = r.events.find((e) => e.spell === "No Sample Dmg");
    expect(noSampleEvent).toBeDefined();
    expect(noSampleEvent!.hpBeforePct).toBeUndefined();
    expect(noSampleEvent!.hpAfterPct).toBeUndefined();
  });
});

describe("死亡回顾血条 v2 (DeathRecapCard)", () => {
  it("DeathRecapCard: 渲染血条列并断言 delta 样式、class、title, 且 cc 行无 track, 且不存在 sparkline/grid", () => {
    const recap: DeathRecap = {
      unitId: "victim-1",
      unitName: "Victim",
      deathS: 100,
      events: [
        {
          tS: 92,
          kind: "dmg",
          spell: "Mortal Strike",
          amount: 20000,
          srcName: "Attacker",
          hpBeforePct: 82.1,
          hpAfterPct: 61.4,
        },
        {
          tS: 94,
          kind: "heal",
          spell: "Flash Heal",
          amount: 10000,
          srcName: "Healer",
          hpBeforePct: 60.8,
          hpAfterPct: 70.9,
        },
        {
          tS: 95,
          kind: "cc",
          spell: "Kidney Shot",
          srcName: "Attacker",
        },
      ],
      availableImmunities: [],
      missedExternals: [],
    };

    const { container } = render(
      <DeathRecapCard recap={recap} onClose={() => {}} />,
    );

    expect(container.querySelector(".rpt-hpspark")).toBeNull();
    expect(container.querySelector(".rpt-recap-grid")).toBeNull();

    const dmgRow = container.querySelector(".rpt-recap-dmg");
    expect(dmgRow).toBeTruthy();
    const dmgHpBarTd = dmgRow!.querySelector(".rpt-recap-hpbar");
    expect(dmgHpBarTd).toBeTruthy();
    expect(dmgHpBarTd!.getAttribute("title")).toBe("82% → 61%");

    const dmgBase = dmgHpBarTd!.querySelector(
      ".rpt-recap-hpbar-base",
    ) as HTMLElement;
    const dmgDelta = dmgHpBarTd!.querySelector(
      ".rpt-recap-hpbar-delta",
    ) as HTMLElement;
    expect(dmgBase).toBeTruthy();
    expect(dmgDelta).toBeTruthy();
    expect(dmgBase.style.width).toBe("61.4%");
    expect(dmgDelta.style.left).toBe("61.4%");
    // 82.1 - 61.4 = 20.7
    expect(dmgDelta.style.width).toBe("20.7%");
    expect(dmgDelta.className).toContain("rpt-recap-hpbar-delta-dmg");

    const healRow = container.querySelector(".rpt-recap-heal");
    expect(healRow).toBeTruthy();
    const healHpBarTd = healRow!.querySelector(".rpt-recap-hpbar");
    expect(healHpBarTd).toBeTruthy();
    expect(healHpBarTd!.getAttribute("title")).toBe("61% → 71%");

    const healBase = healHpBarTd!.querySelector(
      ".rpt-recap-hpbar-base",
    ) as HTMLElement;
    const healDelta = healHpBarTd!.querySelector(
      ".rpt-recap-hpbar-delta",
    ) as HTMLElement;
    expect(healBase).toBeTruthy();
    expect(healDelta).toBeTruthy();
    expect(healBase.style.width).toBe("60.8%");
    expect(healDelta.style.left).toBe("60.8%");
    // 70.9 - 60.8 = 10.1
    expect(healDelta.style.width).toBe("10.1%");
    expect(healDelta.className).toContain("rpt-recap-hpbar-delta-heal");

    const ccRow = container.querySelector(".rpt-recap-cc");
    expect(ccRow).toBeTruthy();
    const ccHpBarTd = ccRow!.querySelector(".rpt-recap-hpbar");
    expect(ccHpBarTd).toBeTruthy();
    expect(ccHpBarTd!.querySelector(".rpt-recap-hpbar-track")).toBeNull();
  });
});

describe("死亡回顾 —— zoneId 双点修复的行为回归(reviewer finding #2)", () => {
  // 与 packages/analysis/test/ported/losAnalysis.test.ts 同一北柱几何
  // (Nagrand '1505' 圆形柱 cx=-2043.6 cy=6621.5 r=2.5):两点相距 15 码
  // (<40 码外置射程,>8 码近距免检),恰好被柱子挡视野——专挑这对坐标就是
  // 要让案例只在"LoS 门真的被 combat.zoneId 触发"时才会排除该候选,不依赖
  // 距离判定(那部分早已被 B27 测试覆盖)。
  const CASTER_POS = { x: -2050, y: 6621.5 };
  const DYING_POS = { x: -2035, y: 6621.5 };
  const DEATH_T = 5_000_000;

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

  /** zoneId 可控的最小合成 ReportSource:一死一活,活的持 Ironbark(102342,
   * 恢复德鲁伊)且从未使用过——生产路径下"可用未给"的候选。 */
  function buildBlockedLosSource(zoneId: string): ReportSource {
    return {
      kind: "match",
      id: "test-los-regression",
      bracket: "2v2",
      zoneId,
      startTime: DEATH_T - 30_000,
      endTime: DEATH_T + 1_000,
      playerId: "dead1",
      playerTeamId: 0,
      winningTeamId: null,
      result: "Lose",
      linesTotal: 0,
      linesDropped: 0,
      hasAdvancedLogging: true,
      timezone: "UTC",
      units: {
        dead1: {
          id: "dead1",
          name: "Warrior",
          kind: "Player",
          reaction: "Friendly",
          classId: 1,
          specId: 71, // Warrior_Arms
          info: combatantInfo(71),
          deaths: [
            {
              timestamp: DEATH_T,
              eventName: "UNIT_DIED",
              spellId: 0,
              spellName: "",
              srcId: "",
              srcName: "",
              destId: "dead1",
              destName: "Warrior",
              params: [],
              unconscious: false,
            },
          ],
          advancedSamples: [
            {
              timestamp: DEATH_T,
              hp: 0,
              maxHp: 100_000,
              x: DYING_POS.x,
              y: DYING_POS.y,
            },
          ],
        },
        heal1: {
          id: "heal1",
          name: "Druid",
          kind: "Player",
          reaction: "Friendly",
          classId: 11,
          specId: 105, // Druid_Restoration
          info: combatantInfo(105),
          advancedSamples: [
            {
              timestamp: DEATH_T,
              hp: 100_000,
              maxHp: 100_000,
              x: CASTER_POS.x,
              y: CASTER_POS.y,
            },
          ],
        },
      },
    } as unknown as ReportSource;
  }

  it("zoneId 正确贯通(真实映射区域)时,LoS 门生效,被柱子挡住的 Ironbark 不进 missedExternals", () => {
    const recaps = deriveDeathRecaps(buildBlockedLosSource("1505"));
    expect(recaps).toHaveLength(1);
    const names = recaps[0]!.missedExternals.map((m) => m.spellName);
    expect(names).not.toContain("Ironbark");
  });

  it("对照组:zoneId 为空串(等同 deathRecap.ts 两处读点回归到 undefined/顶层不存在字段的旧 bug)时,同一几何 LoS 门不生效,Ironbark 误判为可用未给", () => {
    const recaps = deriveDeathRecaps(buildBlockedLosSource(""));
    expect(recaps).toHaveLength(1);
    const names = recaps[0]!.missedExternals.map((m) => m.spellName);
    expect(names).toContain("Ironbark");
  });
});
