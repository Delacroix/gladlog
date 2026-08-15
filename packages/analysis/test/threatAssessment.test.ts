import { LogEvent } from "@gladlog/parser-compat";

import {
  matchThreatLevel,
  THREAT_LEVEL_LOW_MIN_HP_PCT,
  THREAT_SEGMENT_PERSIST_S,
  threatActiveAt,
} from "../src/utils/threatAssessment";
import {
  makeAdvancedAction,
  makeAuraEvent,
  makeCombat,
  makeDamageEvent,
  makeUnit,
} from "./ported/testHelpers";

// Avenging Wrath ("Wings") — Offensive-tagged in classMetadata, the brief's
// own reference fixture ("敌方翅膀光环活跃时刻 → true").
const WINGS = "31884";

const START = 1_000_000;
const combat = makeCombat(START, START + 300_000);

describe("threatActiveAt", () => {
  it("敌方翅膀(进攻大 CD)光环活跃时刻 → true", () => {
    const enemy = makeUnit("enemy-1", {
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          WINGS,
          START + 10_000,
          "enemy-1",
          "enemy-1",
          "BUFF",
        ),
        makeAuraEvent(
          LogEvent.SPELL_AURA_REMOVED,
          WINGS,
          START + 30_000,
          "enemy-1",
          "enemy-1",
          "BUFF",
        ),
      ],
    });
    const friendly = makeUnit("friend-1", { damageIn: [] });

    expect(threatActiveAt(20, [enemy], [friendly], combat)).toBe(true);
  });

  it("全静默时刻(无敌方进攻光环、无己方承伤)→ false", () => {
    const enemy = makeUnit("enemy-1", { auraEvents: [] });
    const friendly = makeUnit("friend-1", { damageIn: [] });

    expect(threatActiveAt(20, [enemy], [friendly], combat)).toBe(false);
  });

  it("翅膀光环已消失后的时刻 → false(区间判定不是「曾经活跃过」)", () => {
    const enemy = makeUnit("enemy-1", {
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          WINGS,
          START + 10_000,
          "enemy-1",
          "enemy-1",
          "BUFF",
        ),
        makeAuraEvent(
          LogEvent.SPELL_AURA_REMOVED,
          WINGS,
          START + 30_000,
          "enemy-1",
          "enemy-1",
          "BUFF",
        ),
      ],
    });
    const friendly = makeUnit("friend-1", { damageIn: [] });

    expect(threatActiveAt(60, [enemy], [friendly], combat)).toBe(false);
  });

  it("无敌方进攻光环,但己方承伤速率超过标定阈值(窗口内)→ true", () => {
    const enemy = makeUnit("enemy-1", { auraEvents: [] });
    // No advancedActions → getPressureThreshold falls back to the DPS role
    // threshold (60k for CombatUnitSpec.None, same table panic-press uses).
    const friendly = makeUnit("friend-1", {
      damageIn: [makeDamageEvent(START + 20_000, 70_000, "friend-1")],
    });

    expect(threatActiveAt(20, [enemy], [friendly], combat)).toBe(true);
  });

  it("己方承伤在窗口外(超出 THREAT_DAMAGE_WINDOW_MS)→ 不计入,false", () => {
    const enemy = makeUnit("enemy-1", { auraEvents: [] });
    const friendly = makeUnit("friend-1", {
      damageIn: [makeDamageEvent(START + 40_000, 70_000, "friend-1")], // 20s query point, 20s away
    });

    expect(threatActiveAt(20, [enemy], [friendly], combat)).toBe(false);
  });

  it("己方承伤未过阈值(35k < 60k)→ false", () => {
    const enemy = makeUnit("enemy-1", { auraEvents: [] });
    const friendly = makeUnit("friend-1", {
      damageIn: [makeDamageEvent(START + 20_000, 35_000, "friend-1")],
    });

    expect(threatActiveAt(20, [enemy], [friendly], combat)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchThreatLevel — event-segment aggregation (2026-08-15 review FINDING 1:
// replaces the earlier whole-match-min-HP shape, which misread a real ~150ms
// HP trough — immediately reversed by an emergency heal — as a match-wide
// "high" verdict).
//
// Fixture convention: `enemy` never carries an Offensive-tagged aura, so every
// case below isolates threatActiveAt's damage-rate disjunct. maxHp is 100,000
// unless noted, so getPressureThreshold (15% of max HP, real advancedActions
// present) is a round 15,000.
// ---------------------------------------------------------------------------

const noAuraEnemy = () => makeUnit("enemy-1", { auraEvents: [] });

/** Builds a friendly whose HP is `beforePct` from t=0, dips to `troughPct` at
 * `troughS`, recovers to `afterPct` at `recoverS` (if given), and takes one
 * damage hit at `hitS` big enough alone to clear the 15,000 pressure
 * threshold (round maxHp=100,000). One damage hit → threatActiveAt is true
 * for exactly a THREAT_DAMAGE_WINDOW_MS-wide window centered on it (10s at
 * the default 5,000ms half-width) — the minimum possible raw segment length.
 */
function friendlyWithDip(opts: {
  troughS: number;
  troughPct: number;
  hitS?: number;
  recoverS?: number;
  afterPct?: number;
}): ReturnType<typeof makeUnit> {
  const { troughS, troughPct, hitS = troughS, recoverS, afterPct } = opts;
  const actions = [
    makeAdvancedAction(START, 0, 0, 100_000, 100_000),
    makeAdvancedAction(START + troughS * 1000, 0, 0, 100_000, troughPct * 1000),
  ];
  if (recoverS !== undefined && afterPct !== undefined) {
    actions.push(
      makeAdvancedAction(
        START + recoverS * 1000,
        0,
        0,
        100_000,
        afterPct * 1000,
      ),
    );
  }
  return makeUnit("friend-1", {
    advancedActions: actions,
    damageIn: [makeDamageEvent(START + hitS * 1000, 40_000, "friend-1")],
  });
}

describe("matchThreatLevel", () => {
  it("无进阶数据(旧档)→ 保守判 low,不误报", () => {
    const friendly = makeUnit("friend-1", { advancedActions: [] });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("low");
  });

  it("全程无威胁片段(无施法光环、无承伤)→ low", () => {
    const friendly = makeUnit("friend-1", {
      advancedActions: [makeAdvancedAction(START, 0, 0, 100_000, 100_000)],
      damageIn: [],
    });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("low");
  });

  it("片段确实触发(承伤过阈值),但血线从未跌破分界线(仅到 80%)→ low(候选门先行过滤,不靠答坑)", () => {
    const friendly = friendlyWithDip({ troughS: 20, troughPct: 80 });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("low");
  });

  it("跌破分界线但迅速被救回(答坑,B11)→ low", () => {
    const friendly = friendlyWithDip({
      troughS: 20,
      troughPct: 20,
      recoverS: 30,
      afterPct: 90,
    });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("low");
  });

  it("跌破分界线、未被救回、片段本身较短(<PERSIST)→ med", () => {
    const friendly = friendlyWithDip({ troughS: 20, troughPct: 10 }); // no recovery ever
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("med");
  });

  it(`跌破分界线、未被救回、片段持续 ≥ THREAT_SEGMENT_PERSIST_S(${THREAT_SEGMENT_PERSIST_S}s)→ high(单片段持续)`, () => {
    // A sustained multi-hit burst (not one isolated spike) keeps
    // threatActiveAt true across a long contiguous span.
    const hits = [];
    for (let s = 15; s <= 40; s += 2) {
      hits.push(makeDamageEvent(START + s * 1000, 40_000, "friend-1"));
    }
    const friendly = makeUnit("friend-1", {
      advancedActions: [
        makeAdvancedAction(START, 0, 0, 100_000, 100_000),
        makeAdvancedAction(START + 40_000, 0, 0, 100_000, 5_000), // 5% — stays low
      ],
      damageIn: hits,
    });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("high");
  });

  it("两个独立的、未被救回的短片段(复现)→ high", () => {
    const friendly = makeUnit("friend-1", {
      advancedActions: [
        makeAdvancedAction(START, 0, 0, 100_000, 100_000),
        makeAdvancedAction(START + 20_000, 0, 0, 100_000, 10_000), // episode 1, never recovers before episode 2
        makeAdvancedAction(START + 150_000, 0, 0, 100_000, 8_000), // episode 2
      ],
      damageIn: [
        makeDamageEvent(START + 20_000, 40_000, "friend-1"),
        makeDamageEvent(START + 150_000, 40_000, "friend-1"),
      ],
    });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("high");
  });

  it(`跌破分界线恰在分界(=${THREAT_LEVEL_LOW_MIN_HP_PCT}%)→ 不算候选,low`, () => {
    const friendly = friendlyWithDip({
      troughS: 20,
      troughPct: THREAT_LEVEL_LOW_MIN_HP_PCT,
    });
    expect(matchThreatLevel([noAuraEnemy()], [friendly], combat)).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Named real-match-shaped fixtures (2026-08-15 review FINDING 3: the old
// "B6 参考例" test used a synthetic single-number 81% fixture that shared no
// actual shape with match 44ea4cf6's real HP curve — misleadingly named. These
// two reconstruct the *shape* the reviewer verified from the real corpus
// (raw advancedSamples + damageIn dump), not the literal byte values.
// ---------------------------------------------------------------------------

describe("matchThreatLevel — real-match-shaped fixtures", () => {
  const matchCombat = makeCombat(START, START + 300_000); // 5 min, covers both windows below

  it('44ea4cf6 形态复原(密集下降 88%→7.85% 于 ~10s 内、72ms 恢复、2:50 全队回满、4:26 第二窗只到 81%)→ "low"', () => {
    const maxHp = 500_000;
    // Dense decline 10s→20s: 88% (440,000) down to 7.85% (39,250), one sample
    // per second — mirrors the real advancedSamples density the reviewer
    // pulled from 44ea4cf6's raw hp curve.
    const declineActions = [];
    const startPct = 88;
    const troughPct = 7.85;
    for (let s = 10; s <= 20; s++) {
      const pct = startPct - ((startPct - troughPct) * (s - 10)) / 10;
      declineActions.push(
        makeAdvancedAction(START + s * 1000, 0, 0, maxHp, (pct / 100) * maxHp),
      );
    }
    const friendly = makeUnit("friend-1", {
      advancedActions: [
        makeAdvancedAction(START, 0, 0, maxHp, (startPct / 100) * maxHp),
        ...declineActions,
        // 72ms recovery: immediately back above the low line, then a slow
        // climb the rest of the way, full by 2:50 (170s). A sample inside the
        // segment's own post-end recovery-check window (raw segment ends
        // ~24s in, THREAT_RECOVERY_WINDOW_S=15s after that) is required for
        // the answered check to actually see the recovery.
        makeAdvancedAction(START + 20_072, 0, 0, maxHp, 0.76 * maxHp),
        makeAdvancedAction(START + 30_000, 0, 0, maxHp, 0.8 * maxHp),
        makeAdvancedAction(START + 40_000, 0, 0, maxHp, 0.86 * maxHp),
        makeAdvancedAction(START + 100_000, 0, 0, maxHp, 0.94 * maxHp),
        makeAdvancedAction(START + 170_000, 0, 0, maxHp, maxHp),
        // 4:26 (266s): a second, shallower window — down to 81% only, never
        // crossing the low line.
        makeAdvancedAction(START + 264_000, 0, 0, maxHp, maxHp),
        makeAdvancedAction(START + 266_000, 0, 0, maxHp, 0.81 * maxHp),
        makeAdvancedAction(START + 270_000, 0, 0, maxHp, 0.9 * maxHp),
      ],
      damageIn: [
        // Dense damage 10s-19s driving the first decline.
        ...Array.from({ length: 10 }, (_, i) =>
          makeDamageEvent(START + (10 + i) * 1000, 45_000, "friend-1"),
        ),
        // The 4:26 window: enough total damage to clear the pressure
        // threshold (so it really is a candidate segment), but the HP curve
        // above never drops it below the low line.
        makeDamageEvent(START + 265_000, 50_000, "friend-1"),
        makeDamageEvent(START + 266_000, 45_000, "friend-1"),
      ],
    });

    expect(matchThreatLevel([noAuraEnemy()], [friendly], matchCombat)).toBe(
      "low",
    );
  });

  it('76ea5f90 形态复原(双死、HP 到 0% 且无后续数据)→ "high"', () => {
    const maxHp = 500_000;
    const friendA = makeUnit("friend-a", {
      advancedActions: [
        makeAdvancedAction(START, 0, 0, maxHp, maxHp),
        makeAdvancedAction(START + 25_000, 0, 0, maxHp, maxHp),
        makeAdvancedAction(START + 28_000, 0, 0, maxHp, 0.2 * maxHp),
        makeAdvancedAction(START + 30_000, 0, 0, maxHp, 0), // death, no further samples
      ],
      damageIn: [
        makeDamageEvent(START + 26_000, 100_000, "friend-a"),
        makeDamageEvent(START + 28_000, 100_000, "friend-a"),
        makeDamageEvent(START + 30_000, 100_000, "friend-a"),
      ],
      deathRecords: [{ timestamp: START + 30_000 } as never],
    });
    const friendB = makeUnit("friend-b", {
      advancedActions: [
        makeAdvancedAction(START, 0, 0, maxHp, maxHp),
        makeAdvancedAction(START + 145_000, 0, 0, maxHp, maxHp),
        makeAdvancedAction(START + 148_000, 0, 0, maxHp, 0.2 * maxHp),
        makeAdvancedAction(START + 150_000, 0, 0, maxHp, 0), // death, no further samples
      ],
      damageIn: [
        makeDamageEvent(START + 146_000, 100_000, "friend-b"),
        makeDamageEvent(START + 148_000, 100_000, "friend-b"),
        makeDamageEvent(START + 150_000, 100_000, "friend-b"),
      ],
      deathRecords: [{ timestamp: START + 150_000 } as never],
    });
    const doubleDeathCombat = makeCombat(START, START + 190_000); // ~3min, matches the real match's duration

    expect(
      matchThreatLevel([noAuraEnemy()], [friendA, friendB], doubleDeathCombat),
    ).toBe("high");
  });
});
