/**
 * BACKLOG #18 终审 Minor #3(shared-predicate rule 收敛):"死亡时可用未按"这一
 * 事实曾有三份异源实现——matchTimelineSections 的 [DEATH] Unused(原先手算
 * availableWindows 命中)、timelineHelpers 的 [DEFENSIVE AVAILABLE](原先手算
 * readyAt)、candidateFindings 的 death-unused-defensive/external-unused(已
 * 消费 cdAvailableAt)。三者现在全部 import 并直接调用 cdAvailableAt——本测试
 * 是防漂移哨兵:对同一合成冷却台账 + 同一死亡时刻,三个消费点必须与
 * cdAvailableAt 本身给出一致的布尔结论。任何一处未来被改回本地手算公式,
 * 只要与 cdAvailableAt 语义分叉,这里就会挂。
 */
import { describe, expect, it } from "vitest";

import { CombatUnitReaction, CombatUnitSpec } from "@gladlog/parser-compat";

import { deathUnusedDefensiveEvents } from "../src/analysis/candidateFindings";
import { emitFriendlyDeathEntries } from "../src/context/matchTimelineSections";
import { buildKillSequenceBlock } from "../src/context/timelineHelpers";
import { cdAvailableAt, IMajorCooldownInfo } from "../src/utils/cooldowns";
import { makeUnit } from "./ported/testHelpers";

const SPELL_ID = "102342"; // Ironbark — Defensive, not in any CC/Forbearance whitelist
const SPELL_NAME = "Ironbark";
const DEATH_T = 15;

function makeCd(casts: number[], cooldownSeconds: number): IMajorCooldownInfo {
  return {
    spellId: SPELL_ID,
    spellName: SPELL_NAME,
    tag: "Defensive",
    cooldownSeconds,
    maxChargesDetected: 1,
    casts: casts.map((timeSeconds) => ({ timeSeconds })),
    availableWindows: [], // 三个消费点均已不读这个字段(Minor #3 收敛前 matchTimelineSections
    // 读它;收敛后统一走 cdAvailableAt),留空验证没人还在悄悄依赖它。
    neverUsed: casts.length === 0,
  };
}

/** [DEATH] 行里是否把 Ironbark 列进 "(Unused: …)"。 */
function deathSectionFlagsUnused(cd: IMajorCooldownInfo): boolean {
  const dyingUnit = makeUnit("Player1", {
    name: "Player1",
    spec: CombatUnitSpec.Druid_Restoration,
    reaction: CombatUnitReaction.Friendly,
  });
  const lines: string[] = [];
  emitFriendlyDeathEntries<never>({
    friendlyDeaths: [
      { spec: "Restoration Druid", name: "Player1", atSeconds: DEATH_T },
    ],
    unitsByName: new Map([["Player1", dyingUnit]]),
    ccTrinketSummaries: [],
    owner: dyingUnit,
    ownerCDs: [cd],
    teammateCDs: [],
    matchStartMs: 0,
    pid: (n) => n,
    requestSnapshotPlaceholder: () => "SNAPSHOT" as never,
    addEntry: (_t, ...ls) => {
      for (const l of ls) if (typeof l === "string") lines.push(l);
    },
  });
  expect(lines.length).toBeGreaterThan(0);
  return lines[0].includes(`Unused: ${SPELL_NAME}`);
}

/** [DEFENSIVE AVAILABLE] 行里是否点名 Ironbark。 */
function killSeqFlagsAvailable(cd: IMajorCooldownInfo): boolean {
  const dyingUnit = makeUnit("Player1", {
    name: "Player1",
    spec: CombatUnitSpec.Druid_Restoration,
    reaction: CombatUnitReaction.Friendly,
  });
  const lines = buildKillSequenceBlock({
    matchStartMs: 0,
    matchEndSeconds: DEATH_T + 5, // < 90，触发 KILL SEQUENCE 分支
    owner: dyingUnit,
    friends: [dyingUnit],
    enemies: [],
    ownerCDs: [cd],
    teammateCDs: [],
    enemyCDTimeline: { alignedBurstWindows: [], players: [] } as any,
    ccTrinketSummaries: [],
    friendlyDeaths: [
      { spec: "Restoration Druid", name: "Player1", atSeconds: DEATH_T },
    ],
    enemyDeaths: [],
    isHealer: false,
    pid: (n) => n,
    actorLabel: (n) => n,
  });
  return lines.some(
    (l) => l.includes("[DEFENSIVE AVAILABLE]") && l.includes(SPELL_NAME),
  );
}

/** death-unused-defensive candidate 是否把 Ironbark 列进 walls。 */
function candidateFlagsUnused(cd: IMajorCooldownInfo): boolean {
  const events = deathUnusedDefensiveEvents(
    {
      deathT: DEATH_T,
      victim: { id: "Player1", name: "Player1" },
      victimCC: { ccInstances: [], trinketUseTimes: [] },
      victimCDs: [cd],
    },
    { isOwner: true },
  );
  if (events.length === 0) return false;
  return String(events[0].facts.walls).includes(SPELL_NAME);
}

describe("cdAvailableAt 三消费点防漂移一致性(BACKLOG #18 Minor #3)", () => {
  const cases: Array<{ label: string; cd: IMajorCooldownInfo }> = [
    { label: "从未使用 → 全程可用", cd: makeCd([], 60) },
    { label: "刚用过、CD 未转好 → 不可用", cd: makeCd([10], 60) },
    { label: "用过、CD 已转好 → 可用", cd: makeCd([5], 5) },
    {
      label: "两次施放取死亡前最近一次、仍在冷却 → 不可用",
      cd: makeCd([1, 12], 60),
    },
  ];

  it.each(cases)("$label", ({ cd }) => {
    const expected = cdAvailableAt(cd, DEATH_T);
    expect(deathSectionFlagsUnused(cd)).toBe(expected);
    expect(killSeqFlagsAvailable(cd)).toBe(expected);
    expect(candidateFlagsUnused(cd)).toBe(expected);
  });
});
