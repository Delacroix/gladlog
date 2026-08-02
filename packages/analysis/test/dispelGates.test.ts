/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 驱散责难可行性门(2026-08-02 用户拍板)—— 「没驱散」责难必须先过:
 *  门 a LoS/射程:所有具备该解法的驱散者都够不着(有位置数据才判;无数据不改判)
 *  门 b+c 无法施法:硬控/沉默光环 ∪ 踢锁,窗口内自由时间 < 反应阈值(3s)
 *  门 d DR 语境:目标该 DR 类全新鲜且窗口结束后 10s 内被同类续控 —— 不拦,
 *    但注解成「谨慎建议」(驱散换来的可能是满时长续控)。
 * 语料基线(150 场/766 轮):束缚射击是教练候选第 1 名(×106),四门联合
 * 预计拦 ~24% 的责难候选。
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

/** Binding Shot(用户点名误报例):cc/Magic,3s 档。 */
const BINDING_SHOT = "117526";
/** 挂在驱散者身上的硬控(Polymorph,cc 类,isCastBlockingAuraType=true)。 */
const POLY = "118";

/** 目标 t1 挂一个 fromS→toS 的束缚射击(敌方 e1 施加,自然消退)。 */
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

/** 具备 Magic 解法的驱散者(戒律牧)。 */
function discPriest(id: string, overrides: any = {}) {
  return makeUnit(id, { spec: CombatUnitSpec.Priest_Discipline, ...overrides });
}

const enemy = () =>
  makeUnit("e1", { spec: CombatUnitSpec.Hunter_Marksmanship });

function summarize(friends: any[], combat: any = COMBAT) {
  return reconstructDispelSummary(friends as any, [enemy()] as any, combat);
}

describe("门 b+c 无法施法(硬控∪踢锁,自由时间 < 3s 反应阈值)", () => {
  it("基线:无任何门数据 → 窗口成立且不豁免,候选照常产出", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")]);
    expect(ds.missedCleanseWindows).toHaveLength(1);
    const w = ds.missedCleanseWindows[0];
    expect(w.dispellersLockedOut).toBe(false);
    expect(w.losReachable).toBeNull(); // 无位置数据:三态 null,不改判
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(1);
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
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(0);
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
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(1);
  });

  it("踢锁计入无法施法(4s 窗被 3s 锁吃剩 1s)→ 豁免", () => {
    // 未知踢技 id 走保守 3s 锁(与 ccTrinketAnalysis 同一 fallback 谓词)
    expect(kickLockoutSeconds("999999")).toBe(3);
    const h1 = discPriest("h1", {
      actionIn: [
        makeInterruptEvent("999999", "Kick", "585", "Smite", S(10), "e1"),
      ],
    });
    const ds = summarize([targetWithBinding(10, 14), h1]);
    expect(ds.missedCleanseWindows).toHaveLength(1);
    expect(ds.missedCleanseWindows[0].dispellersLockedOut).toBe(true);
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(0);
  });

  it("多驱散者:任一自由即不豁免(交集语义)", () => {
    const h1 = discPriest("h1", {
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, POLY, S(9), "e1", "h1"),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, POLY, S(16), "e1", "h1"),
      ],
    });
    const h2 = discPriest("h2"); // 全程自由
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
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(0);
  });

  it("射程内(30 码)→ losReachable=true,候选照常", () => {
    const t1 = targetWithBinding(10, 16);
    (t1 as any).advancedActions = [
      makeAdvancedAction(S(9), 30, 0),
      makeAdvancedAction(S(14), 30, 0),
    ].map((a) => ({ ...a, advancedActorId: "t1" }));
    const ds = summarize([t1, far("h1")], { ...COMBAT, zoneId: "0" });
    expect(ds.missedCleanseWindows[0].losReachable).toBe(true);
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(1);
  });

  it("无位置数据 → null,不改判(非 advanced 语料的教学不许被吞)", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")], {
      ...COMBAT,
      zoneId: "0",
    });
    expect(ds.missedCleanseWindows[0].losReachable).toBeNull();
    expect(missedCleanseEvents(ds.missedCleanseWindows)).toHaveLength(1);
  });
});

describe("门 d DR 语境(全新鲜 + 10s 内同类续控 → 注解不拦)", () => {
  it("窗口结束后 8s 内目标再吃同 DR 类控制且 DR 全新鲜 → drChainRisk=true,候选仍产出", () => {
    // 前一个束缚射击窗(10→16)结束后,S22 目标又吃龙息/再吃控(同 stun 类用同 id 构造)
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
    // 注解不是拦截:候选仍在(带 DR fact),由教练措辞谨慎化
    expect(
      missedCleanseEvents(ds.missedCleanseWindows).some(
        (c) => c.t === 10 && c.facts.drChainRisk === "yes",
      ),
    ).toBe(true);
  });

  it("无后续同类控制 → drChainRisk=false", () => {
    const ds = summarize([targetWithBinding(10, 16), discPriest("h1")]);
    expect(ds.missedCleanseWindows[0].drChainRisk).toBe(false);
  });

  it("DR 已递减(此前 16s 内吃过同类)→ 即便有续控也不算 chain risk", () => {
    const t1 = targetWithBinding(10, 16, [
      // 此前 S4→S6 已吃过一次同类:S10 这窗的 DR 非全新鲜
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
    // 敌方挂 Critical/High 的 Magic 增益(自由祝福 1044,敌方自己给的)
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
