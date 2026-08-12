// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";

import { DeathRecapCard } from "../src/renderer/src/report/components/DeathRecapCard";
import {
  DEATH_RECAP_MIN_EVENT_PCT,
  DeathRecap,
  DeathRecapFolded,
  DeathRecapSubtotal,
  deriveDeathRecaps,
} from "../src/renderer/src/report/derive/deathRecap";
import { toLegacySafe } from "../src/renderer/src/report/derive/legacySource";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

// Issue #11 (death-recap UX): condensed rows — periodic damage subtotals,
// the DEATH_RECAP_MIN_EVENT_PCT display-density threshold, the fold bucket
// (amount-conserving, expandable), unconditional dispel rows, and the card's
// 显示全部 toggle. Same fixture/injection pattern as report.deathrecap.test.tsx
// (the fixture has no player deaths, so one is injected; synthetic event
// streams are written into the cached legacy object via toLegacySafe, which is
// the exact object deriveDeathRecaps will consume).

const base = loadRealMatchFixture();

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

const MAX_HP = 100_000;

/** Per-kind amount sums must be identical between the raw stream and the
 * condensed rows (folded row included) — the conservation criterion. */
function sums(recap: DeathRecap): {
  raw: { dmg: number; heal: number };
  rows: { dmg: number; heal: number };
} {
  const raw = { dmg: 0, heal: 0 };
  for (const e of recap.events) {
    if (e.kind === "dmg") raw.dmg += e.amount ?? 0;
    if (e.kind === "heal") raw.heal += e.amount ?? 0;
  }
  const rows = { dmg: 0, heal: 0 };
  for (const r of recap.rows) {
    if (r.type === "event") {
      if (r.event.kind === "dmg") rows.dmg += r.event.amount ?? 0;
      if (r.event.kind === "heal") rows.heal += r.event.amount ?? 0;
    } else if (r.type === "subtotal") {
      rows[r.kind] += r.total;
    } else {
      rows.dmg += r.dmgTotal;
      rows.heal += r.healTotal;
    }
  }
  return { raw, rows };
}

interface SyntheticSetup {
  m: ReturnType<typeof withInjectedDeath>["m"];
  victim: ReturnType<typeof withInjectedDeath>["victim"];
  deathTMs: number;
  legacyVictim: {
    damageIn: unknown[];
    healIn: unknown[];
    actionOut: unknown[];
    advancedActions: unknown[];
  };
}

function setupSynthetic(): SyntheticSetup {
  const { m, victim, deathTMs } = withInjectedDeath();
  const legacy = toLegacySafe(m);
  const legacyVictim = legacy.units[
    victim.id
  ] as unknown as SyntheticSetup["legacyVictim"];
  // Real unit ids for the synthetic sources: the derive layer resolves
  // srcUnitId through legacy.units (unknown ids all collapse to the same
  // "unknown" srcName, which would merge the two Agony groups).
  const otherIds = Object.keys(legacy.units).filter((id) => id !== victim.id);
  const e1 = otherIds[0]!;
  const e2 = otherIds[1]!;
  const h1 = otherIds[2] ?? otherIds[0]!;
  const hpEvent = (
    event: string,
    ts: number,
    spellId: string,
    spellName: string,
    signedAmount: number,
    srcUnitId: string,
  ) => ({
    srcUnitFlags: 0,
    destUnitFlags: 0,
    timestamp: ts,
    srcUnitName: "Src",
    destUnitName: victim.name,
    logLine: { event, timestamp: ts, parameters: [] },
    spellId,
    spellName,
    srcUnitId,
    destUnitId: victim.id,
    amount: signedAmount,
    effectiveAmount: signedAmount,
  });
  // One advanced sample inside the window: the same maxHp source hpRangeAt
  // and the threshold's maxHpNear read.
  legacyVictim.advancedActions = [
    {
      logLine: { event: "ADVANCED_SAMPLE", timestamp: deathTMs - 5000 },
      advancedActorId: victim.id,
      advancedActorCurrentHp: 50_000,
      advancedActorMaxHp: MAX_HP,
      advancedActorPositionX: 0,
      advancedActorPositionY: 0,
      advanced: true,
      timestamp: deathTMs - 5000,
      advancedActorPowers: [],
    },
  ];
  legacyVictim.damageIn = [
    // Direct hits (SPELL_DAMAGE): 20% kept, exactly-2% kept (boundary:
    // strictly-below folds), just-under-2% folded.
    hpEvent("SPELL_DAMAGE", deathTMs - 5000, "1001", "Big Hit", -20_000, e1),
    hpEvent(
      "SPELL_DAMAGE",
      deathTMs - 3900,
      "1002",
      "Edge Hit",
      -(DEATH_RECAP_MIN_EVENT_PCT * MAX_HP),
      e1,
    ),
    hpEvent("SPELL_DAMAGE", deathTMs - 4000, "1003", "Chip Hit", -1999, e1),
    // DoT: three ticks, same (spell x source) → one subtotal row.
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 8000,
      "2001",
      "Agony",
      -1000,
      e1,
    ),
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 6000,
      "2001",
      "Agony",
      -1200,
      e1,
    ),
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 4000,
      "2001",
      "Agony",
      -1300,
      e1,
    ),
    // Same DoT from a DIFFERENT source: its own subtotal (spell x source key).
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 7000,
      "2001",
      "Agony",
      -900,
      e2,
    ),
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 5000,
      "2001",
      "Agony",
      -950,
      e2,
    ),
    // Single periodic tick: promoted back to a plain event row.
    hpEvent(
      "SPELL_PERIODIC_DAMAGE",
      deathTMs - 3000,
      "2002",
      "Corruption",
      -800,
      e1,
    ),
    // Swings aggregate like periodic (non-GCD).
    hpEvent("SWING_DAMAGE", deathTMs - 6500, "1", "Melee", -700, e1),
    hpEvent("SWING_DAMAGE", deathTMs - 5500, "1", "Melee", -750, e1),
  ];
  legacyVictim.healIn = [
    hpEvent("SPELL_HEAL", deathTMs - 4500, "3001", "Flash Heal", 5000, h1),
    hpEvent("SPELL_HEAL", deathTMs - 4200, "3002", "Small Heal", 500, h1),
    // HoT ticks: folded (measured decision — fewer rows than subtotals).
    hpEvent("SPELL_PERIODIC_HEAL", deathTMs - 8000, "3003", "Renew", 600, h1),
    hpEvent("SPELL_PERIODIC_HEAL", deathTMs - 6000, "3003", "Renew", 650, h1),
  ];
  return { m, victim, deathTMs, legacyVictim };
}

describe("#11 derive:分型处理(直击阈值/DoT 小计/HoT 折叠/金额守恒)", () => {
  const { m, victim } = setupSynthetic();
  const recaps = deriveDeathRecaps(m);
  const r = recaps.find((x) => x.unitId === victim.id)!;

  it("直击 ≥2% maxHp 保留单行;=2% 恰好保留(边界);<2% 进折叠", () => {
    const eventRows = r.rows.filter((x) => x.type === "event");
    const names = eventRows.map((x) => x.event.spell);
    expect(names).toContain("Big Hit");
    expect(names).toContain("Edge Hit");
    expect(names).not.toContain("Chip Hit");
    const folded = r.rows.find((x) => x.type === "folded") as DeathRecapFolded;
    expect(folded).toBeDefined();
    expect(folded.events.map((e) => e.spell)).toContain("Chip Hit");
  });

  it("DoT 按(法术×来源)小计:同法术不同来源分行,总额/跳数/时间跨度正确;单跳法术回落为普通行", () => {
    const subtotals = r.rows.filter(
      (x) => x.type === "subtotal",
    ) as DeathRecapSubtotal[];
    const agonyE1 = subtotals.find(
      (s) => s.spell === "Agony" && s.total === 3500,
    );
    expect(agonyE1).toBeDefined();
    expect(agonyE1!.ticks).toBe(3);
    expect(agonyE1!.toS - agonyE1!.fromS).toBeCloseTo(4, 3);
    const agonyE2 = subtotals.find(
      (s) => s.spell === "Agony" && s.total === 1850,
    );
    expect(agonyE2).toBeDefined();
    expect(agonyE2!.ticks).toBe(2);
    const melee = subtotals.find((s) => s.spell === "Melee");
    expect(melee).toBeDefined();
    expect(melee!.total).toBe(1450);
    // Corruption has a single in-window tick: kept as an event row, no
    // 1-tick subtotal.
    expect(subtotals.find((s) => s.spell === "Corruption")).toBeUndefined();
    expect(
      r.rows.some((x) => x.type === "event" && x.event.spell === "Corruption"),
    ).toBe(true);
  });

  it("直击治疗 ≥2% 保留,<2% 与 HoT tick 进折叠;折叠行合计=被折叠事件之和", () => {
    const eventRows = r.rows.filter((x) => x.type === "event");
    expect(eventRows.some((x) => x.event.spell === "Flash Heal")).toBe(true);
    expect(eventRows.some((x) => x.event.spell === "Small Heal")).toBe(false);
    expect(eventRows.some((x) => x.event.spell === "Renew")).toBe(false);
    const folded = r.rows.find((x) => x.type === "folded") as DeathRecapFolded;
    expect(folded.count).toBe(folded.events.length);
    expect(folded.dmgTotal).toBe(1999);
    expect(folded.healTotal).toBe(500 + 600 + 650);
  });

  it("金额守恒:过滤+折叠+小计后各类总额与原始逐行总额相等", () => {
    const { raw, rows } = sums(r);
    expect(rows.dmg).toBe(raw.dmg);
    expect(rows.heal).toBe(raw.heal);
    expect(raw.dmg).toBeGreaterThan(0);
    expect(raw.heal).toBeGreaterThan(0);
  });

  it("折叠不静默删:events(显示全部)仍含全部原始行", () => {
    // 11 dmg + 4 heal synthetic events all present in the raw stream
    expect(r.events.filter((e) => e.kind === "dmg").length).toBe(11);
    expect(r.events.filter((e) => e.kind === "heal").length).toBe(4);
  });
});

describe("#11 derive:金额守恒(真实 fixture 全量回归)", () => {
  it("每条回顾:rows(事件+小计+折叠)与 events 的伤害/治疗总额一致,且行数不增", () => {
    const { m } = withInjectedDeath();
    const recaps = deriveDeathRecaps(m);
    expect(recaps.length).toBeGreaterThanOrEqual(1);
    for (const r of recaps) {
      const { raw, rows } = sums(r);
      expect(rows.dmg).toBe(raw.dmg);
      expect(rows.heal).toBe(raw.heal);
      expect(r.rows.length).toBeLessThanOrEqual(r.events.length);
    }
  });
});

describe("#11 derive:驱散行(reconstructDispelSummary 同谓词,无条件保留)", () => {
  it("死亡窗口内 victim 相关驱散 → kind=dispel 事件行,精简视图无条件保留", () => {
    const { m, victim, deathTMs, legacyVictim } = setupSynthetic();
    legacyVictim.actionOut = [
      {
        srcUnitFlags: 0,
        destUnitFlags: 0,
        timestamp: deathTMs - 2000,
        srcUnitName: victim.name,
        destUnitName: victim.name,
        logLine: {
          event: "SPELL_DISPEL",
          timestamp: deathTMs - 2000,
          parameters: [],
        },
        spellId: "527",
        spellName: "Purify",
        extraSpellId: "8122",
        extraSpellName: "Psychic Scream",
        srcUnitId: victim.id,
        destUnitId: victim.id,
      },
    ];
    const recaps = deriveDeathRecaps(m);
    const r = recaps.find((x) => x.unitId === victim.id)!;
    const dispels = r.events.filter((e) => e.kind === "dispel");
    expect(dispels.length).toBe(1);
    expect(dispels[0]!.spell).toContain("Psychic Scream");
    expect(dispels[0]!.spellId).toBe("8122");
    // Unconditionally present in the condensed rows
    expect(
      r.rows.some((x) => x.type === "event" && x.event.kind === "dispel"),
    ).toBe(true);
  });
});

describe("#11 card:折叠行展开 + 显示全部 toggle", () => {
  const events: DeathRecap["events"] = [
    {
      tS: 92,
      kind: "dmg",
      spell: "Big Hit",
      spellId: "1001",
      amount: 20000,
      srcName: "Attacker",
    },
    {
      tS: 93,
      kind: "dmg",
      spell: "Tick",
      spellId: "2001",
      amount: 900,
      srcName: "Attacker",
    },
    {
      tS: 94,
      kind: "dmg",
      spell: "Tick",
      spellId: "2001",
      amount: 950,
      srcName: "Attacker",
    },
    {
      tS: 95,
      kind: "dmg",
      spell: "Chip",
      spellId: "1003",
      amount: 300,
      srcName: "Attacker",
    },
    {
      tS: 96,
      kind: "heal",
      spell: "Drip",
      spellId: "3003",
      amount: 200,
      srcName: "Healer",
    },
  ];
  const folded: DeathRecap["events"] = [events[3]!, events[4]!];
  const recap: DeathRecap = {
    unitId: "v1",
    unitName: "Victim",
    deathS: 100,
    events,
    rows: [
      { type: "event", event: events[0]! },
      {
        type: "subtotal",
        kind: "dmg",
        fromS: 93,
        toS: 94,
        spell: "Tick",
        spellId: "2001",
        srcName: "Attacker",
        total: 1850,
        ticks: 2,
      },
      {
        type: "folded",
        count: 2,
        dmgTotal: 300,
        healTotal: 200,
        events: folded,
      },
    ],
    availableImmunities: [],
    missedExternals: [],
    mitigationAudit: [],
    counterfactuals: [],
  };

  it("默认精简视图:小计行带跳数注记;折叠行显示条数与合计;被折叠行不渲染", () => {
    const { container } = render(
      <DeathRecapCard recap={recap} onClose={() => {}} />,
    );
    expect(container.querySelector(".rpt-recap-subtotal")).toBeTruthy();
    expect(
      container.querySelector(".rpt-recap-subtotal-note")!.textContent,
    ).toContain("×2 跳");
    const foldBtn = container.querySelector(".rpt-recap-fold-toggle")!;
    expect(foldBtn.textContent).toContain("已折叠 2 行小额事件");
    expect(foldBtn.textContent).toContain("0.3k");
    expect(foldBtn.textContent).toContain("0.2k");
    expect(container.textContent).not.toContain("Chip");
    // 3 semantic rows: event + subtotal + fold header
    expect(container.querySelectorAll(".rpt-recap-row").length).toBe(3);
  });

  it("点展开 → 被折叠行内联显示;再点收起", () => {
    const { container } = render(
      <DeathRecapCard recap={recap} onClose={() => {}} />,
    );
    const foldBtn = container.querySelector(
      ".rpt-recap-fold-toggle",
    ) as HTMLElement;
    fireEvent.click(foldBtn);
    expect(container.textContent).toContain("Chip");
    expect(container.textContent).toContain("Drip");
    expect(container.querySelectorAll(".rpt-recap-fold-detail").length).toBe(2);
    fireEvent.click(foldBtn);
    expect(container.textContent).not.toContain("Chip");
  });

  it("显示全部 toggle:切到逐跳原始事件流(无小计/折叠行),再切回精简", () => {
    const { container, getByRole } = render(
      <DeathRecapCard recap={recap} onClose={() => {}} />,
    );
    const btn = getByRole("button", { name: "显示全部" });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // every raw event is its own row; no condensation artifacts
    expect(container.querySelectorAll(".rpt-recap-row").length).toBe(5);
    expect(container.querySelector(".rpt-recap-subtotal")).toBeNull();
    expect(container.querySelector(".rpt-recap-fold-toggle")).toBeNull();
    expect(container.textContent).toContain("Chip");
    fireEvent.click(btn);
    expect(container.querySelectorAll(".rpt-recap-row").length).toBe(3);
  });
});
