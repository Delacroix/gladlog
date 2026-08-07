/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Feasibility gates for blaming a missed cleanse (decided by the user
 * 2026-08-02) — a "you didn't dispel" accusation must first pass:
 *  gate a LoS/range: every dispeller holding that answer was out of reach
 *    (only judged when position data exists; no data → no change of verdict)
 *  gate b+c unable to cast: hard CC / silence auras ∪ kick lockout, leaving
 *    less free time inside the window than the reaction threshold (3s)
 *  gate d DR context: the target's DR category is fully fresh AND they are
 *    re-CC'd by the same category within 10s of the window ending — this does
 *    NOT block, but annotates the finding as "advise with caution" (dispelling
 *    may simply buy a full-duration re-CC).
 * Corpus baseline (150 matches / 766 rounds): Binding Shot is the #1 coaching
 * candidate (x106), and the four gates together are expected to block ~24% of
 * blame candidates.
 */
import { CombatUnitSpec, LogEvent } from "@gladlog/parser-compat";

import {
  missedCleanseEvents,
  missedPurgeEvents,
} from "../src/analysis/candidateFindings";
import { kickLockoutSeconds } from "../src/data/spellCategories";
import {
  formatMissedCleanseExemption,
  formatMissedPurgeExemption,
  reconstructDispelSummary,
} from "../src/utils/dispelAnalysis";
import {
  makeAdvancedAction,
  makeAuraEvent,
  makeInterruptEvent,
  makeUnit,
} from "./ported/testHelpers";

const S = (sec: number) => MATCH_START + sec * 1000;
const MATCH_START = 1_000_000;
const COMBAT = { startTime: MATCH_START, endTime: MATCH_START + 120_000 };

/** Binding Shot (the false positive the user called out): cc/Magic, 3s tier. */
const BINDING_SHOT = "117526";
/** Hard CC sitting on the dispeller (Polymorph, cc category,
 * isCastBlockingAuraType=true). */
const POLY = "118";

/** Put a Binding Shot on target t1 from fromS→toS (applied by enemy e1,
 * expiring naturally). */
function targetWithBinding(fromS: number, toS: number, extra: any[] = []) {
  return makeUnit("t1", {
    spec: CombatUnitSpec.Warrior_Arms,
    auraEvents: [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        BINDING_SHOT,
        S(fromS),
        "e1",
        "t1",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        BINDING_SHOT,
        S(toS),
        "e1",
        "t1",
      ),
      ...extra,
    ],
  });
}

/** A dispeller holding the Magic answer (Discipline Priest). */
function discPriest(id: string, overrides: any = {}) {
  return makeUnit(id, { spec: CombatUnitSpec.Priest_Discipline, ...overrides });
}

const enemy = () =>
  makeUnit("e1", { spec: CombatUnitSpec.Hunter_Marksmanship });

function summarize(friends: any[], combat: any = COMBAT) {
  return reconstructDispelSummary(friends as any, [enemy()] as any, combat);
}

/** All missed-cleanse windows in this file are Binding Shot (dispelType
 * Magic); a Discipline Priest is a MAGIC_REMOVERS spec, so this owner
 * identity is a capability-gate no-op — these tests exercise the feasibility
 * gates (a/b+c/d), not the 2026-08-05 owner-capability gate (that gate has
 * its own coverage in candidateFindings.test.ts). */
const DISPEL_OWNER = { spec: CombatUnitSpec.Priest_Discipline };

describe("门 b+c 无法施法(硬控∪踢锁,自由时间 < 3s 反应阈值)", () => {
  it("基线:无任何门数据 → 窗口成立且不豁免,候选照常产出", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")]);
    expect(ds.missedCleanseWindows).toHaveLength(1);
    const w = ds.missedCleanseWindows[0];
    expect(w.dispellersLockedOut).toBe(false);
    expect(w.losReachable).toBeNull(); // no position data: tri-state null, verdict unchanged
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(1);
  });

  it("驱散者被硬控吃掉反应窗(6s 窗只自由 2s)→ 豁免,候选不出", () => {
    const h1 = discPriest("h1", {
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, POLY, S(9.5), "e1", "h1"),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, POLY, S(14), "e1", "h1"),
      ],
    });
    const ds = summarize([targetWithBinding(10, 16), h1]);
    expect(ds.missedCleanseWindows).toHaveLength(1);
    expect(ds.missedCleanseWindows[0].dispellersLockedOut).toBe(true);
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(0);
  });

  it("长窗口只锁一小段(16s 窗自由 13s)→ 不豁免", () => {
    const h1 = discPriest("h1", {
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "e1", "h1"),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, POLY, S(13), "e1", "h1"),
      ],
    });
    const ds = summarize([targetWithBinding(10, 26), h1]);
    expect(ds.missedCleanseWindows[0].dispellersLockedOut).toBe(false);
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(1);
  });

  it("踢锁计入无法施法(4s 窗被 3s 锁吃剩 1s)→ 豁免", () => {
    // An unknown interrupt id falls back to a conservative 3s lockout (the same
    // fallback predicate as ccTrinketAnalysis)
    expect(kickLockoutSeconds("999999")).toBe(3);
    const h1 = discPriest("h1", {
      actionIn: [
        makeInterruptEvent("999999", "Kick", "585", "Smite", S(10), "e1"),
      ],
    });
    const ds = summarize([targetWithBinding(10, 14), h1]);
    expect(ds.missedCleanseWindows).toHaveLength(1);
    expect(ds.missedCleanseWindows[0].dispellersLockedOut).toBe(true);
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(0);
  });

  it("多驱散者:任一自由即不豁免(交集语义)", () => {
    const h1 = discPriest("h1", {
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, POLY, S(9), "e1", "h1"),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, POLY, S(16), "e1", "h1"),
      ],
    });
    const h2 = discPriest("h2"); // free the whole time
    const ds = summarize([targetWithBinding(10, 16), h1, h2]);
    expect(ds.missedCleanseWindows[0].dispellersLockedOut).toBe(false);
  });
});

describe("门 a LoS/射程(三态:有数据且全员够不着才豁免)", () => {
  const far = (id: string) =>
    discPriest(id, {
      advancedActions: [
        makeAdvancedAction(S(9), 0, 0),
        makeAdvancedAction(S(14), 0, 0),
      ],
    });
  it("全员超 40 码射程 → losReachable=false,候选不出", () => {
    const t1 = targetWithBinding(10, 16);
    (t1 as any).advancedActions = [
      makeAdvancedAction(S(9), 50, 0),
      makeAdvancedAction(S(14), 50, 0),
    ].map((a) => ({ ...a, advancedActorId: "t1" }));
    const ds = summarize([t1, far("h1")], { ...COMBAT, zoneId: "0" });
    expect(ds.missedCleanseWindows[0].losReachable).toBe(false);
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(0);
  });

  it("射程内(30 码)→ losReachable=true,候选照常", () => {
    const t1 = targetWithBinding(10, 16);
    (t1 as any).advancedActions = [
      makeAdvancedAction(S(9), 30, 0),
      makeAdvancedAction(S(14), 30, 0),
    ].map((a) => ({ ...a, advancedActorId: "t1" }));
    const ds = summarize([t1, far("h1")], { ...COMBAT, zoneId: "0" });
    expect(ds.missedCleanseWindows[0].losReachable).toBe(true);
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(1);
  });

  it("无位置数据 → null,不改判(非 advanced 语料的教学不许被吞)", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")], {
      ...COMBAT,
      zoneId: "0",
    });
    expect(ds.missedCleanseWindows[0].losReachable).toBeNull();
    expect(
      missedCleanseEvents(ds.missedCleanseWindows, DISPEL_OWNER, [], false),
    ).toHaveLength(1);
  });
});

describe("门 d DR 语境(全新鲜 + 10s 内同类续控 → 注解不拦)", () => {
  it("窗口结束后 8s 内目标再吃同 DR 类控制且 DR 全新鲜 → drChainRisk=true,候选仍产出", () => {
    // After the previous Binding Shot window (10→16) ends, the target is CC'd
    // again at S22 (the same DR category is constructed with the same id)
    const t1 = targetWithBinding(10, 16, [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        BINDING_SHOT,
        S(22),
        "e1",
        "t1",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        BINDING_SHOT,
        S(24),
        "e1",
        "t1",
      ),
    ]);
    const ds = summarize([t1, discPriest("h1")]);
    const w = ds.missedCleanseWindows.find((x) => x.timeSeconds === 10)!;
    expect(w.drChainRisk).toBe(true);
    // Annotating is not blocking: the candidate survives (carrying the DR fact)
    // and the coaching wording is softened instead
    expect(
      missedCleanseEvents(
        ds.missedCleanseWindows,
        DISPEL_OWNER,
        [],
        false,
      ).some((c) => c.t === 10 && c.facts.drChainRisk === "yes"),
    ).toBe(true);
  });

  it("无后续同类控制 → drChainRisk=false", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")]);
    expect(ds.missedCleanseWindows[0].drChainRisk).toBe(false);
  });

  it("DR 已递减(此前 16s 内吃过同类)→ 即便有续控也不算 chain risk", () => {
    const t1 = targetWithBinding(10, 16, [
      // The same category already landed at S4→S6, so the DR for the S10
      // window is not fully fresh
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        BINDING_SHOT,
        S(4),
        "e1",
        "t1",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        BINDING_SHOT,
        S(6),
        "e1",
        "t1",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        BINDING_SHOT,
        S(22),
        "e1",
        "t1",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        BINDING_SHOT,
        S(24),
        "e1",
        "t1",
      ),
    ]);
    const ds = summarize([t1, discPriest("h1")]);
    const w = ds.missedCleanseWindows.find((x) => x.timeSeconds === 10)!;
    expect(w.drChainRisk).toBe(false);
  });
});

describe("豁免后缀与 purge 侧", () => {
  it("formatMissedCleanseExemption:各门后缀", () => {
    const base = {
      cleanseWasOnCD: false,
      cdBurnedOn: undefined,
      dispellersLockedOut: false,
      losReachable: null as boolean | null,
      drChainRisk: false,
    };
    expect(formatMissedCleanseExemption(base)).toBe("");
    expect(
      formatMissedCleanseExemption({ ...base, dispellersLockedOut: true }),
    ).toContain("locked out");
    expect(
      formatMissedCleanseExemption({ ...base, losReachable: false }),
    ).toContain("range/line of sight");
    expect(
      formatMissedCleanseExemption({ ...base, drChainRisk: true }),
    ).toContain("DR was fresh");
  });

  it("missedPurgeEvents:锁定/够不着的 purge 责难被拦", () => {
    const base = {
      timeSeconds: 20,
      durationSeconds: 8,
      enemyName: "e1",
      spellName: "Blessing of Freedom",
      spellId: "1044",
      priority: "High" as const,
      purgeWasOnCD: false,
      duringKillWindow: false,
      purgersLockedOut: false,
      losReachable: null as boolean | null,
    };
    expect(missedPurgeEvents([base])).toHaveLength(1);
    expect(
      missedPurgeEvents([{ ...base, purgersLockedOut: true }]),
    ).toHaveLength(0);
    expect(missedPurgeEvents([{ ...base, losReachable: false }])).toHaveLength(
      0,
    );
  });

  it("purge 集成:purger 超射程 → losReachable=false", () => {
    // The enemy carries a Critical/High priority Magic buff (Blessing of
    // Freedom 1044, given by their own side)
    const e1 = makeUnit("e1", {
      spec: CombatUnitSpec.Paladin_Holy,
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "1044",
          S(20),
          "e1",
          "e1",
          "BUFF",
        ),
        makeAuraEvent(
          LogEvent.SPELL_AURA_REMOVED,
          "1044",
          S(28),
          "e1",
          "e1",
          "BUFF",
        ),
      ],
      advancedActions: [
        makeAdvancedAction(S(19), 60, 0),
        makeAdvancedAction(S(24), 60, 0),
      ],
    });
    (e1 as any).advancedActions = (e1 as any).advancedActions.map((a: any) => ({
      ...a,
      advancedActorId: "e1",
    }));
    const purger = discPriest("h1", {
      advancedActions: [
        makeAdvancedAction(S(19), 0, 0),
        makeAdvancedAction(S(24), 0, 0),
      ],
    });
    const ds = reconstructDispelSummary([purger] as any, [e1] as any, {
      ...COMBAT,
      zoneId: "0",
    });
    expect(ds.missedPurgeWindows).toHaveLength(1);
    expect(ds.missedPurgeWindows[0].losReachable).toBe(false);
    expect(formatMissedPurgeExemption(ds.missedPurgeWindows[0])).toContain(
      "range/line of sight",
    );
  });
});
