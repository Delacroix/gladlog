/**
 * GH #28 遗留项结清(2026-08-22):slow-defensive-response 的「你有工具」必须问
 * **对承压的那个人有用的**工具。
 *
 * 此前它只问「有没有防御 CD 转好」,压力打在队友身上时,owner 手里的纯自保墙
 * 也算「你有答案却慢了」—— 与 GH #28(绝望祷言救队友)同一个错。窗口数据里本来
 * 就带着 `mostPressuredTarget`(enemyCDs.ts 按窗口内承伤最高的友方算),接进来即可。
 *
 * 探针必须诚实:吞掉第二个参数就等于门没生效(与 cdHoarded 的 onlyUnitName 同形)。
 */
import { describe, expect, it } from "vitest";

import { slowDefensiveResponseEvents } from "../src/analysis/candidateFindings";

const OWNER = { id: "h", name: "Healer-R" };
const window = {
  fromSeconds: 100,
  toSeconds: 130,
  damageInWindow: 900_000,
  damageRatio: 2.0, // ≥ SLOW_DEF_RESPONSE_MIN_RATIO(1.5)
  activeCDs: [
    {
      playerName: "Enemy-A",
      spellName: "Combustion",
      spellId: "190319",
      castSeconds: 100,
    },
  ],
};
/** 诚实探针:按承压对象决定「有没有可用工具」,和生产接线同构。 */
const probes = (toolsFor: (pressured?: string) => boolean) => ({
  reactionTo: () => null,
  toolAvailableAt: (_t: number, pressured?: string) => toolsFor(pressured),
  ownerInCCAt: () => false,
});

describe("slow-defensive-response × 承压对象(GH #28 遗留)", () => {
  it("压力在队友身上、owner 只有自保墙 → 不指控", () => {
    const evts = slowDefensiveResponseEvents(
      [
        {
          ...window,
          mostPressuredTarget: {
            unitName: "Ally-R",
            startHpPct: 90,
            midHpPct: 40,
            endHpPct: 25,
          },
        },
      ],
      OWNER,
      // 生产接线在承压对象≠owner 时只认够得着队友的 CD;这里模拟「只有自保墙」
      probes(
        (pressured) => pressured === undefined || pressured === OWNER.name,
      ),
      [],
    );
    expect(evts).toEqual([]);
  });

  it("压力在 owner 自己身上 → 自保墙就是答案,照常指控", () => {
    const evts = slowDefensiveResponseEvents(
      [
        {
          ...window,
          mostPressuredTarget: {
            unitName: OWNER.name,
            startHpPct: 90,
            midHpPct: 35,
            endHpPct: 20,
          },
        },
      ],
      OWNER,
      probes(
        (pressured) => pressured === undefined || pressured === OWNER.name,
      ),
      [],
    );
    expect(evts).toHaveLength(1);
  });

  it("承压对象未知 → 不收窄(保守,维持既有行为)", () => {
    const evts = slowDefensiveResponseEvents(
      [window],
      OWNER,
      probes(() => true),
      [],
    );
    expect(evts).toHaveLength(1);
  });

  it("红线:承压对象是通过第二个参数下发的 —— 探针吞掉它就等于门没生效", () => {
    const seen: Array<string | undefined> = [];
    slowDefensiveResponseEvents(
      [
        {
          ...window,
          mostPressuredTarget: {
            unitName: "Ally-R",
            startHpPct: 90,
            midHpPct: 40,
            endHpPct: 25,
          },
        },
      ],
      OWNER,
      {
        reactionTo: () => null,
        ownerInCCAt: () => false,
        toolAvailableAt: (_t, p) => {
          seen.push(p);
          return false;
        },
      },
      [],
    );
    expect(seen).toEqual(["Ally-R"]);
  });
});
