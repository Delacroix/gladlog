import { describe, expect, it } from "vitest";

import { transformSpellManaCostRows } from "../../scripts/datagen/genSpellManaCost";
import { parseCsv } from "../../scripts/datagen/lib/wagoCsv";
import {
  SPELL_MANA_COST_TABLE,
  manaCostForCast,
} from "../../src/data/spellManaCost";

const HEADER = "SpellID,PowerType,PowerCostPct,ManaCost,RequiredAuraSpellID";
const row = (
  spellId: string,
  powerType: string,
  pct: string,
  flat: string,
  requiredAura = "0",
) => `${spellId},${powerType},${pct},${flat},${requiredAura}`;

describe("transformSpellManaCostRows", () => {
  it("unconditional pct row → { pct }", () => {
    const csv = [HEADER, row("20473", "0", "2", "0")].join("\n");
    const { rows } = parseCsv(csv);
    const table = transformSpellManaCostRows(rows, new Set(["20473"]));
    expect(table).toEqual({ "20473": { pct: 2 } });
  });

  it("flat ManaCost row → { flat }", () => {
    const csv = [HEADER, row("228", "0", "0", "120")].join("\n");
    const { rows } = parseCsv(csv);
    const table = transformSpellManaCostRows(rows, new Set(["228"]));
    expect(table).toEqual({ "228": { flat: 120 } });
  });

  it("non-mana PowerType (rage/energy/etc.) is ignored entirely", () => {
    const csv = [HEADER, row("1", "1", "10", "0")].join("\n");
    const { rows } = parseCsv(csv);
    expect(transformSpellManaCostRows(rows, new Set(["1"]))).toEqual({});
  });

  it("spell not in the observed set is dropped", () => {
    const csv = [HEADER, row("999", "0", "5", "0")].join("\n");
    const { rows } = parseCsv(csv);
    expect(transformSpellManaCostRows(rows, new Set(["20473"]))).toEqual({});
  });

  it("zero-cost row (pct=0, flat=0) is dropped — nothing usable", () => {
    const csv = [HEADER, row("1", "0", "0", "0")].join("\n");
    const { rows } = parseCsv(csv);
    expect(transformSpellManaCostRows(rows, new Set(["1"]))).toEqual({});
  });

  it("spec-conditional rows (RequiredAuraSpellID gated) → bySpec keyed by CombatUnitSpec id, unmapped auras dropped", () => {
    const csv = [
      HEADER,
      row("2061", "0", "2.61", "0", "137031"), // Holy Priest
      row("2061", "0", "10", "0", "137033"), // Shadow Priest
      row("2061", "0", "10", "0", "417191"), // "Initial Priest" — no real spec, must be dropped
    ].join("\n");
    const { rows } = parseCsv(csv);
    const table = transformSpellManaCostRows(rows, new Set(["2061"]));
    expect(table).toEqual({
      "2061": { bySpec: { "257": { pct: 2.61 }, "258": { pct: 10 } } },
    });
  });

  it("unconditional row coexisting with conditional rows keeps both (base + bySpec)", () => {
    const csv = [
      HEADER,
      row("999", "0", "5", "0", "0"), // spec-agnostic default
      row("999", "0", "1", "0", "137029"), // Holy Paladin override
    ].join("\n");
    const { rows } = parseCsv(csv);
    const table = transformSpellManaCostRows(rows, new Set(["999"]));
    expect(table).toEqual({
      "999": { pct: 5, bySpec: { "65": { pct: 1 } } },
    });
  });
});

describe("manaCostForCast", () => {
  it("unconditional row: pct converts to absolute mana via manaMax", () => {
    expect(manaCostForCast("20473", "65", 273000)).toBeCloseTo(5460, 5); // 2% of 273000
  });

  it("spec-conditional row: picks the caster's own spec, not another spec's row", () => {
    // 2061 Flash Heal: Holy Priest 2.61%, Shadow Priest 10% (see generator anchors)
    expect(manaCostForCast("2061", "257", 273000)).toBeCloseTo(
      0.0261 * 273000,
      1,
    );
    expect(manaCostForCast("2061", "258", 273000)).toBeCloseTo(0.1 * 273000, 5);
  });

  it("spec-conditional row with no matching spec → null (never guesses)", () => {
    // 2061 has no unconditional row and no Discipline (256) anchor in this
    // synthetic case — but the real table DOES have 256, so use a spec that
    // is genuinely absent: e.g. a Mage spec never casts Flash Heal.
    expect(manaCostForCast("2061", "62", 273000)).toBeNull();
  });

  it("unknown spellId → null", () => {
    expect(manaCostForCast("999999999", "65", 273000)).toBeNull();
  });
});

/**
 * Anchor list (2026-08-15, DR-seven-step-precedent discipline): five
 * healing spells whose mana cost was verified against build 12.1.0.69273's
 * live `SpellPower` CSV AND cross-checked independently (see
 * genSpellManaCost.ts's module header + task-4-report.md):
 *   - Holy Shock (20473, Holy Paladin, unconditional 2%): wowhead's generic
 *     tooltip independently reads "2% of base mana" — matches exactly; the
 *     healer's own raw.txt mana samples around a real Holy Shock cast in
 *     match 60ab1e8f show a 2.05% drop across a 0.017s gap to the next
 *     logged event — empirical confirmation, not just column-reading.
 *   - Holy Light (82326, Holy Paladin, unconditional 7%).
 *   - Holy Word: Serenity (2050, Priest, unconditional 2.375%).
 *   - Flash Heal (2061, spec-conditional): Holy Priest 2.61% vs the
 *     class-generic wowhead tooltip's 10% (the Shadow/default row) — this
 *     ~4x gap is exactly the misread this table's spec-conditional handling
 *     exists to prevent; asserting BOTH rows here pins that the Holy row
 *     specifically, not the class-default row, resolves for a Holy Priest.
 *   - Flash of Light (19750, spec-conditional): Holy Paladin 0.6% vs
 *     Retribution/Protection's shared 10% — the largest observed spec gap
 *     in this table (~16.7x), a real Holy Paladin mana-economy fact (cheap
 *     Flash of Light spam is central to the spec's kit).
 * A mismatch here means either the upstream DB2 build changed these costs
 * (rare — check the patch notes before touching this test) or the
 * generator's spec-aura mapping/scope logic drifted — STOP and report per
 * CLAUDE.md's anchor-list discipline, do not just update the expected
 * number to make the test pass.
 */
describe("spellManaCostGenerated anchors", () => {
  it("Holy Shock (20473): unconditional 2%", () => {
    expect(SPELL_MANA_COST_TABLE["20473"]).toEqual({ pct: 2 });
  });
  it("Holy Light (82326): unconditional 7%", () => {
    expect(SPELL_MANA_COST_TABLE["82326"]).toEqual({ pct: 7 });
  });
  it("Holy Word: Serenity (2050): unconditional 2.375%", () => {
    expect(SPELL_MANA_COST_TABLE["2050"]).toEqual({ pct: 2.375 });
  });
  it("Flash Heal (2061): Holy Priest (257) 2.61%, not the 10% class-default", () => {
    const row = SPELL_MANA_COST_TABLE["2061"];
    expect(row?.pct).toBeUndefined(); // no spec-agnostic row exists
    expect(row?.bySpec?.["257"]?.pct).toBeCloseTo(2.6099998951, 5);
    expect(row?.bySpec?.["258"]?.pct).toBe(10); // Shadow Priest — the wowhead-generic value
  });
  it("Flash of Light (19750): Holy Paladin (65) 0.6%, not the 10% Ret/Prot value", () => {
    const row = SPELL_MANA_COST_TABLE["19750"];
    expect(row?.bySpec?.["65"]?.pct).toBeCloseTo(0.60000002384, 5);
    expect(row?.bySpec?.["70"]?.pct).toBe(10); // Retribution Paladin
  });
});
