import { LogEvent } from "@gladlog/parser-compat";

import {
  matchThreatLevel,
  THREAT_LEVEL_HIGH_MIN_HP_PCT,
  THREAT_LEVEL_LOW_MIN_HP_PCT,
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

describe("matchThreatLevel", () => {
  const friendlyWithMinHp = (pct: number) =>
    makeUnit("friend-1", {
      advancedActions: [makeAdvancedAction(START, 0, 0, 100, pct)],
    });

  it("B6 参考例(44ea4cf6):敌方 sync 最深只打到 81% 血 → low", () => {
    expect(matchThreatLevel([friendlyWithMinHp(81)])).toBe("low");
  });

  it(`恰在 low 分界(${THREAT_LEVEL_LOW_MIN_HP_PCT}%)→ low`, () => {
    expect(
      matchThreatLevel([friendlyWithMinHp(THREAT_LEVEL_LOW_MIN_HP_PCT)]),
    ).toBe("low");
  });

  it("中档(50% 血)→ med", () => {
    expect(matchThreatLevel([friendlyWithMinHp(50)])).toBe("med");
  });

  it(`恰在 high 分界(${THREAT_LEVEL_HIGH_MIN_HP_PCT}%)→ med`, () => {
    expect(
      matchThreatLevel([friendlyWithMinHp(THREAT_LEVEL_HIGH_MIN_HP_PCT)]),
    ).toBe("med");
  });

  it("高档(10% 血,略低于 high 分界)→ high", () => {
    expect(matchThreatLevel([friendlyWithMinHp(10)])).toBe("high");
  });

  it("多个队友取最低者定级(一人 90% 一人 20% → high)", () => {
    expect(
      matchThreatLevel([friendlyWithMinHp(90), friendlyWithMinHp(20)]),
    ).toBe("high");
  });

  it("无进阶数据(旧档)→ 保守判 low,不误报", () => {
    const friendly = makeUnit("friend-1", { advancedActions: [] });
    expect(matchThreatLevel([friendly])).toBe("low");
  });
});
