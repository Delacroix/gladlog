import generated from "./mitigationGenerated.json";

export interface IMitigationEntry {
  /** Damage reduction percentage, 0-100; immunities = 100. */
  pct: number;
  /** School mask this applies to, same bit semantics as the log's
   * spellSchoolId (0x7F all / 0x7E magic only / 0x1 physical only). */
  schoolMask: number;
  /**
   * Applies only to units standing inside the spell's area; consumers MUST
   * combine it with a coordinate check (advanced position data) before counting
   * this mitigation — without that check it must not be counted.
   */
  positional?: true;
}

/**
 * Curated override layer (always wins): every entry states its source and why
 * it overrides. Entries the generation layer cannot extract (unresolved / zero
 * hits) or extracts wrongly (contradicting game facts) are pinned here.
 *
 * Evidence basis (2026-07 human review, DB2 build 12.1.0.68629, full
 * SpellEffect table of 628107 rows):
 * - "aura39/40" = DB2 school-immunity / damage-immunity rows (immunities are
 *   pct=100 per the spec decision);
 * - "DR aura <id>" = the cast id itself has no aura-87 row; the actual
 *   mitigation aura hangs off a different id, that id has been observed in this
 *   library's real match logs (observedSpellIdsGenerated.json), and the value is
 *   taken from that aura id's current DB2 aura-87 row;
 * - the 4 pending entries (115203/357170/196718/374227) were each decided by the
 *   user on 2026-07-30; conclusions are in the inline "user decision" comments
 *   and in task-2-report.md. 196718 was originally ruled no-mitigation and then
 *   overturned by the user — see that entry's comment.
 */
export const MITIGATION_OVERRIDES: Record<string, IMitigationEntry> = {
  // —— Immunities (spec decision: immunity = pct 100 + the correct school mask) ——
  "642": { pct: 100, schoolMask: 0x7f }, // Divine Shield: full immunity; DB2 aura39 misc0=127+126; zero hits in the generation layer (immunities don't use aura87)
  "45438": { pct: 100, schoolMask: 0x7f }, // Ice Block: full immunity; DB2 aura39 misc0=1+127
  "196555": { pct: 100, schoolMask: 0x7f }, // Netherwalk: full damage immunity; DB2 aura40 misc0=127
  "1022": { pct: 100, schoolMask: 0x1 }, // Blessing of Protection: physical immunity only; DB2 aura39 misc0=1 (its aura87 points=0 row is a leftover dead slot, Task 1 unresolved)
  "204018": { pct: 100, schoolMask: 0x7e }, // Blessing of Spellwarding: magic immunity only; DB2 aura39 misc0=126
  "31224": { pct: 100, schoolMask: 0x7e }, // Cloak of Shadows: magic immunity only; DB2 aura186 points=-200 (spell hit -200%); spec decision; the aura87 0 row is a dead slot
  "186265": { pct: 100, schoolMask: 0x7f }, // Aspect of the Turtle: deflection = immunity (DB2 aura184/185/186 are all -200% hit); the spec decision overrides the generation layer's 30 with immunity semantics (that 30 is the residual mitigation on damage that isn't deflected)

  // —— The mitigation aura hangs off a different id (the generation layer can't find it by cast id) ——
  "51052": { pct: 15, schoolMask: 0x7e }, // Anti-Magic Zone: DR aura 145629 (observed), currently -15/126; the same-named 332831 (-20) is not observed and judged not live
  "62618": { pct: 20, schoolMask: 0x7f }, // Power Word: Barrier: DR aura 81782 (observed), currently -20/127
  "98008": { pct: 10, schoolMask: 0x7f }, // Spirit Link Totem: DR aura 325174 (observed), currently -10/127 (98007 has the same value but is not observed)
  "61336": { pct: 50, schoolMask: 0x7f }, // Survival Instincts: the cast id is dummy only (points=50); same-named 50322/236157 are both currently -50/127; stable at 50% long-term
  "115203": { pct: 20, schoolMask: 0x7f }, // Fortifying Brew: the cast id's dummy effect is ±20 (wowhead currently shows -20 too); the actual buff 120954 has aura87 base value 0 filled in by script, and a separate -15 variant exists (243435, not observed). 2026-07-30 user decision: take 20%
  "357170": { pct: 50, schoolMask: 0x7f }, // Time Dilation: mechanic = proportional absorb (aura69 all schools + dummy points=50); the absorbed 50% is re-settled ~10s later (time shift) so total damage is unchanged, but on a death/burst-window basis it is equivalent to 50% mitigation. 2026-07-30 user decision: adopt that basis (the strict total-damage no-mitigation alternative was presented and rejected)

  // —— Conditional mitigation (only in specific positions/conditions; consumers must evaluate the condition themselves) ——
  "196718": { pct: 40, schoolMask: 0x7f, positional: true }, // Darkness: 2026-07-30 user reversal — count it as 40% (a major cooldown cannot count as 0), but position MUST be evaluated: not standing in the Darkness means it doesn't count. The dividing line is whether the condition is decidable from the log: Darkness's condition (position) is, hence a value + positional; Zephyr's (374227) condition (whether the damage is AoE) is not, so it stays omitted
};

/**
 * Whitelisted entries that genuinely have no (percentage-type) mitigation
 * attribute — pure absorb shields / healing / damage-transfer effects, each with
 * its reason. Mutually exclusive with MITIGATION_TABLE; the anti-rot test
 * guards that there is no third state.
 */
export const NO_MITIGATION_IDS: ReadonlySet<string> = new Set([
  "6940", // Blessing of Sacrifice: damage transfer (30% redirected to the paladin); the spec states transfer effects don't enter the table; its aura87 points=0 row is a dead slot
  "19236", // Desperate Prayer: pure healing + max health, DB2 has no aura87 row at all
  "47788", // Guardian Spirit: +60% healing received (aura118) + death prevention, no percentage mitigation (the same-named new id 1247928 has a -10 row but is not observed, see the pending-decision section note)
  "97462", // Rallying Cry: +10% max health (the actual buff is 97463), no mitigation
  "116849", // Life Cocoon: pure absorb shield (aura69) + healing bonus, no percentage mitigation
  "122470", // Touch of Karma: absorb + damage transfer to the target (aura69), not percentage mitigation
  "374227", // Zephyr: only 20% AoE mitigation (aura229, not aura87); this table's shape cannot express conditional mitigation. 2026-07-30 user decision: no-mitigation, better omitted (196718 Darkness is also conditional, but its condition — position — is decidable from the log, so it was moved into MITIGATION_OVERRIDES; see the comment there)
]);

const gen = (
  generated as unknown as {
    entries: Record<string, IMitigationEntry>;
  }
).entries;

/** Merged table: generated base + curated overrides always winning (same
 * two-layer scheme as spellEffectData). */
export const MITIGATION_TABLE: Record<string, IMitigationEntry> = {
  ...gen,
  ...MITIGATION_OVERRIDES,
};
