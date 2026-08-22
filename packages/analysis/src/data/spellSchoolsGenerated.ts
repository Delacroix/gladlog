/**
 * Generated at: 2026-08-22T22:04:13.839Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellMisc.SchoolMask (what school the spell IS) +
 *   SpellEffect aura 39 / 77 (which schools / mechanics it makes you
 *   immune to), one EffectTriggerSpell hop, dummy rows ignored unless
 *   they are all the spell has. See scripts/datagen/genSpellSchools.ts.
 * School mask bits: 1 Physical · 2 Holy · 4 Fire · 8 Nature · 16 Frost ·
 *   32 Shadow · 64 Arcane (126 = all magic, 127 = everything).
 * Absent field = no official row. Consumers MUST treat that as unknown
 *   and fall back, never as "stops nothing" (Anti-Magic Shell, Spell
 *   Reflection, Bladestorm and Aspect of the Turtle all have no aura 39).
 * ids: 9588 (9588 with a school, 23 with school immunity, 65 with mechanic immunity)
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

import raw from "./spellSchoolsGenerated.json";

export type SpellSchoolFacts = {
  school?: number;
  immuneSchools?: number;
  immuneMechanics?: number[];
};

export const SPELL_SCHOOLS_GENERATED: Record<string, SpellSchoolFacts> =
  raw as Record<string, SpellSchoolFacts>;
