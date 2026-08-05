import {
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  buildDeepDivePrompt,
  buildWindowPack,
  type DeepDivePack,
  SNAPSHOT_KINDS,
} from "./deepDive";
import { MOMENT_PACK_MAX } from "./momentSnapshot";
import type { CandidateEvent, Finding } from "./types";

// Fixture style copied from deepDive.window.test.ts's mkFullUnit (~150-180):
// field names aligned with what analyzePlayerCCAndTrinket / momentSnapshot's
// collectors actually read (auraEvents/spellCastEvents/damageIn/etc.).
const mkUnit = (
  id: string,
  name: string,
  friendly: boolean,
  spec: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name,
  info: { specId: spec },
  spec,
  class: CombatUnitClass.None,
  reaction: friendly ? CombatUnitReaction.Friendly : CombatUnitReaction.Hostile,
  advancedActions: [],
  damageOut: [],
  damageIn: [],
  healOut: [],
  healIn: [],
  absorbsOut: [],
  absorbsIn: [],
  spellCastEvents: [],
  castStartEvents: [],
  petSpellCastEvents: [],
  auraEvents: [],
  actionIn: [],
  actionOut: [],
  deathRecords: [],
  ...overrides,
});

const auraEvent = (
  event: LogEvent,
  timestamp: number,
): Record<string, unknown> => ({
  logLine: { event, timestamp, parameters: [] },
  timestamp,
  spellId: "5782", // Fear — in ccSpellIds
  spellName: "Fear",
  srcUnitId: "e",
  srcUnitName: "Warr-Area52",
  destUnitId: "o",
  destUnitName: "Owner-Area52",
  effectiveAmount: 0,
  advancedActorMaxHp: 0,
  advancedActorCurrentHp: 0,
});

const castEvent = (timestamp: number, spellName = "Penance") => ({
  logLine: { event: LogEvent.SPELL_CAST_SUCCESS, timestamp, parameters: [] },
  timestamp,
  spellId: "1",
  spellName,
});

// The owner takes one 4s Fear (>=3s hard CC) with no trinket cast on record →
// trinketState resolves to available_unused — this is the real (non-snapshot)
// signal that passes hasCoachableSignal (same fixture shape as
// deepDive.window.test.ts's ccCombat), landing at 80s inside window [70,105].
// The owner also casts once at 72s so buildCastFlowLines has something to
// report.
const ccCombat = {
  startTime: 0,
  endTime: 105_000,
  startInfo: { zoneId: "1672" },
  units: {
    o: mkUnit("o", "Owner-Area52", true, CombatUnitSpec.Priest_Discipline, {
      auraEvents: [
        auraEvent(LogEvent.SPELL_AURA_APPLIED, 80_000),
        auraEvent(LogEvent.SPELL_AURA_REMOVED, 84_000),
      ],
      spellCastEvents: [castEvent(72_000)],
    }),
    e: mkUnit("e", "Warr-Area52", false, CombatUnitSpec.Warrior_Arms),
  },
};

// No signal of any kind (no aura/cc/cast events at all): the base fixture
// used by "全不过门 → null" in deepDive.window.test.ts.
const plainCombat = {
  startTime: 0,
  endTime: 105_000,
  startInfo: { zoneId: "1672" },
  units: {
    o: mkUnit("o", "Owner-Area52", true, CombatUnitSpec.Priest_Discipline),
    w: mkUnit("w", "Teammate-Area52", true, CombatUnitSpec.Warrior_Arms),
    e: mkUnit("e", "Emage-Area52", false, CombatUnitSpec.Mage_Frost),
  },
};

const noCandidates: CandidateEvent[] = [];

describe("buildWindowPack snapshot 开关(SDD 2026-08-05 Task 2)", () => {
  it("snapshot 关(默认):对同输入 buildWindowPack 输出与改动前深度相等(字节不变回归)", () => {
    const noOpts = buildWindowPack(
      ccCombat,
      70,
      105,
      noCandidates,
      "Owner-Area52",
    );
    const explicitFalse = buildWindowPack(
      ccCombat,
      70,
      105,
      noCandidates,
      "Owner-Area52",
      { snapshot: false },
    );
    const explicitUndefinedOpts = buildWindowPack(
      ccCombat,
      70,
      105,
      noCandidates,
      "Owner-Area52",
      undefined,
    );
    expect(noOpts).not.toBeNull();
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(noOpts));
    expect(JSON.stringify(explicitUndefinedOpts)).toBe(JSON.stringify(noOpts));
    // Sanity: the default pack must not contain any snapshot-kind item and
    // must not carry castFlow — that's what "byte identical" is protecting.
    expect(noOpts!.pack.items.some((it) => SNAPSHOT_KINDS.has(it.kind))).toBe(
      false,
    );
    expect(noOpts!.pack.castFlow).toBeUndefined();
  });

  it("snapshot 开:items 含快照 kind、总数 ≤ MOMENT_PACK_MAX、facts 并入 pack.facts、castFlow 非空", () => {
    const r = buildWindowPack(ccCombat, 70, 105, noCandidates, "Owner-Area52", {
      snapshot: true,
    });
    expect(r).not.toBeNull();
    expect(r!.pack.items.length).toBeLessThanOrEqual(MOMENT_PACK_MAX);
    const snapshotItems = r!.pack.items.filter((it) =>
      SNAPSHOT_KINDS.has(it.kind),
    );
    expect(snapshotItems.length).toBeGreaterThan(0);
    for (const it of snapshotItems) {
      for (const [k, v] of Object.entries(it.facts)) {
        expect(r!.pack.facts[`${it.key}.${k}`]).toBe(v);
      }
    }
    expect(r!.pack.castFlow).toBeDefined();
    expect(r!.pack.castFlow!.length).toBeGreaterThan(0);
  });

  it("survival 门不被纯快照 items 骗过:只有快照、无事件信号 → buildWindowPack 返回 null", () => {
    const r = buildWindowPack(
      plainCombat,
      0,
      105,
      noCandidates,
      "Owner-Area52",
      { snapshot: true },
    );
    expect(r).toBeNull();
  });
});

describe("buildDeepDivePrompt castFlow 段(SDD 2026-08-05 Task 2)", () => {
  const basePack: DeepDivePack = {
    findingIndex: 0,
    anchorFrom: 100,
    anchorTo: 150,
    items: [
      {
        key: "p1",
        kind: "cc",
        t: 128,
        label: "Fear → Healer(4.0s)",
        unitNames: ["Healer-R"],
        facts: {
          t: "128",
          spell: "Fear",
          duration: "4.0",
          trinket: "on_cooldown",
        },
      },
    ],
    facts: {
      "p1.t": "128",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "on_cooldown",
    },
  };
  const packWithFlow: DeepDivePack = {
    ...basePack,
    castFlow: ["1:12 Owner(Disc) → Penance"],
  };
  const findings: Finding[] = [
    {
      eventIds: ["death:v:150"],
      severity: "high",
      category: "survival",
      title: "被秒",
      explanation: "You died.",
    } as Finding,
  ];

  it("prompt:castFlow 段与 context-only HARD RULE 只在 snapshot pack 出现", () => {
    const withFlow = buildDeepDivePrompt(
      [packWithFlow],
      findings,
      "Holy Paladin",
      "Owner-Area52",
    );
    expect(withFlow).toContain("CAST FLOW (context only");
    expect(withFlow).toContain("1:12 Owner(Disc) → Penance");
    expect(withFlow).toContain(
      "The cast flow section is context only: no number from it may appear in prose unless the same number exists as a {{pN.field}} fact.",
    );

    const withoutFlow = buildDeepDivePrompt(
      [basePack],
      findings,
      "Holy Paladin",
      "Owner-Area52",
    );
    expect(withoutFlow).not.toContain("CAST FLOW (context only");
    expect(withoutFlow).not.toContain("The cast flow section is context only");
  });
});
