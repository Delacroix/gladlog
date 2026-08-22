/**
 * Generated at: 2026-08-22T22:43:39.158Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellEffect — aura 69 (absorb), Effect 10/136 + aura 8/20
 *   (healing, split self vs ally by ImplicitTarget), aura 118/259
 *   (healing received %), aura 31 (haste %). One EffectTriggerSpell hop,
 *   dummy rows ignored unless they are all the spell has.
 *   See scripts/datagen/genAbilityEffects.ts for the rules and controls.
 * Absent field = the official rows do not show that effect. Treat as
 *   "not known to do this", never as proof of absence for a spell whose
 *   implementation is a dummy row + server script.
 * ids: 609 — absorb 129, heals self 123, heals others 266, healing-received 16, haste 85
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

import raw from "./abilityEffectsGenerated.json";

export type AbilityEffectFacts = {
  absorbs?: true;
  healsSelf?: true;
  healsOthers?: true;
  healingReceivedPct?: number;
  hastePct?: number;
};

export const ABILITY_EFFECTS_GENERATED: Record<string, AbilityEffectFacts> =
  raw as Record<string, AbilityEffectFacts>;
