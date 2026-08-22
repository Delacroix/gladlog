/**
 * Generated at: 2026-08-22T22:42:57.530Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellEffect.ImplicitTarget_0/_1 (DifficultyID 0), dummy
 *   effects ignored unless they are all the spell has, one
 *   EffectTriggerSpell hop followed. See scripts/datagen/genSpellTargeting.ts
 *   for the rule, the traps it encodes and the two-directional
 *   ground-truth assertion.
 * true  = at least one effect reaches a FRIENDLY unit other than the caster
 * false = the spell only ever affects the caster (and/or enemies)
 * absent = no official effect row; consumers must fall back, never assume
 * ids: 9613 (560 reach others)
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

import raw from "./spellTargetingGenerated.json";

export const SPELL_REACHES_OTHERS_GENERATED: Record<string, boolean> =
  raw as Record<string, boolean>;
