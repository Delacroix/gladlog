/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 12.1 Stellar Protection (1297521, baseline Balance passive at 42):
 * dispelling Moonfire/Sunfire re-applies Stellar Flare to the cleansed ally,
 * and dispelling Stellar Flare detonates it (damage + knock-up). Corpus proof
 * (3v3-rall-any-102, 2026-08-13): 46/63 Moonfire/Sunfire dispels re-applied
 * Stellar Flare 202347 within 2s; the one observed Stellar Flare dispel
 * detonated 202347 damage on the cleansed ally in the same 0.01s.
 *
 * The exemption is gated twice, and both gates must be predicates:
 *   - era: the passive shipped with 12.1 go-live — pre-12.1 matches must keep
 *     flagging these debuffs (our whole 12.0 library must not change);
 *   - caster spec: only a Balance druid has the passive — Feral/Guardian/Resto
 *     Moonfire stays freely dispellable.
 *
 * Like dispelPenalty.test.ts, this file mocks the world where the game data
 * for these ids is filled in (today they are absent from spellEffectGenerated,
 * so the missed-cleanse path happens not to reach them — the protection must
 * not rely on that hole).
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../../src/utils/dispelAnalysis";
import { makeAuraEvent, makeUnit } from "./testHelpers";

vi.mock("../../src/data/spellEffectData", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellEffectData")>();
  return {
    ...mod,
    spellEffectData: {
      ...mod.spellEffectData,
      "164812": { spellId: "164812", name: "Moonfire", dispelType: "Magic" },
      "202347": {
        spellId: "202347",
        name: "Stellar Flare",
        dispelType: "Magic",
      },
    },
  };
});

vi.mock("../../src/data/spellCategories", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellCategories")>();
  return {
    ...mod,
    SPELL_CATEGORIES: {
      ...mod.SPELL_CATEGORIES,
      "164812": { type: "debuffs_offensive" },
      "202347": { type: "debuffs_offensive" },
    },
  };
});

/** First wall-clock moment safely inside the 12.1 era (go-live +2h). */
const POST_121 = Date.UTC(2026, 7, 12, 0, 0, 0);
/** Tiny synthetic epoch — lands in the pre-12.1 era by construction. */
const PRE_121 = 1_000_000;

function makeTeams(opts: { start: number; casterSpec: CombatUnitSpec }) {
  const healer = makeUnit("h", {
    name: "Healer",
    spec: CombatUnitSpec.Priest_Holy,
  });
  const target = makeUnit("t", {
    name: "Target",
    spec: CombatUnitSpec.Warrior_Arms,
  });
  const enemy = makeUnit("e1", {
    reaction: CombatUnitReaction.Hostile,
    spec: opts.casterSpec,
  });
  // Moonfire sits on the target for 10s and expires undispelled
  (target as any).auraEvents = [
    makeAuraEvent(
      LogEvent.SPELL_AURA_APPLIED,
      "164812",
      opts.start + 10_000,
      "e1",
      "t",
    ),
    makeAuraEvent(
      LogEvent.SPELL_AURA_REMOVED,
      "164812",
      opts.start + 20_000,
      "e1",
      "t",
    ),
  ];
  const combat = { startTime: opts.start, endTime: opts.start + 120_000 };
  return { healer, target, enemy, combat };
}

describe("dispelAnalysis — Stellar Protection (12.1)", () => {
  it("12.1 era + Balance caster: undispelled Moonfire is NOT a missed cleanse", () => {
    const { healer, target, enemy, combat } = makeTeams({
      start: POST_121,
      casterSpec: CombatUnitSpec.Druid_Balance,
    });
    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      combat,
    );
    expect(res.missedCleanseWindows).toHaveLength(0);
  });

  it("era gate: the same Moonfire in a pre-12.1 match still IS a missed cleanse", () => {
    const { healer, target, enemy, combat } = makeTeams({
      start: PRE_121,
      casterSpec: CombatUnitSpec.Druid_Balance,
    });
    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      combat,
    );
    expect(res.missedCleanseWindows).toHaveLength(1);
  });

  it("spec gate: 12.1-era Moonfire from a FERAL druid still IS a missed cleanse", () => {
    const { healer, target, enemy, combat } = makeTeams({
      start: POST_121,
      casterSpec: CombatUnitSpec.Druid_Feral,
    });
    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      combat,
    );
    expect(res.missedCleanseWindows).toHaveLength(1);
  });

  it("annotates an actual 12.1-era Stellar Flare cleanse with the dispel penalty", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Druid_Balance,
    });
    (healer as any).actionOut = [
      {
        logLine: {
          event: LogEvent.SPELL_DISPEL,
          timestamp: POST_121 + 30_000,
          parameters: [],
        },
        timestamp: POST_121 + 30_000,
        spellId: "527",
        spellName: "Purify",
        extraSpellId: "202347",
        extraSpellName: "Stellar Flare",
        srcUnitId: "h",
        destUnitId: "t",
        destUnitName: "Target",
      },
    ];
    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      { startTime: POST_121, endTime: POST_121 + 120_000 },
    );
    expect(res.allyCleanse).toHaveLength(1);
    expect(res.allyCleanse[0].hasDispelPenalty).toBe(true);
  });

  it("does not annotate the same cleanse in a pre-12.1 match", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", {
      reaction: CombatUnitReaction.Hostile,
      spec: CombatUnitSpec.Druid_Balance,
    });
    (healer as any).actionOut = [
      {
        logLine: {
          event: LogEvent.SPELL_DISPEL,
          timestamp: PRE_121 + 30_000,
          parameters: [],
        },
        timestamp: PRE_121 + 30_000,
        spellId: "527",
        spellName: "Purify",
        extraSpellId: "202347",
        extraSpellName: "Stellar Flare",
        srcUnitId: "h",
        destUnitId: "t",
        destUnitName: "Target",
      },
    ];
    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      { startTime: PRE_121, endTime: PRE_121 + 120_000 },
    );
    expect(res.allyCleanse).toHaveLength(1);
    expect(res.allyCleanse[0].hasDispelPenalty).toBe(false);
  });
});
