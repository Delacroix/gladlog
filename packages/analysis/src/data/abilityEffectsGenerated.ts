/**
 * Generated at: 2026-08-23T02:32:46.123Z
 * Build: 12.1.0.69382
 * Source: DB2 SpellEffect — aura 69 (absorb), Effect 10/136 + aura 8/20
 *   (healing, split self vs ally by ImplicitTarget), aura 118/259
 *   (healing received %), aura 31 (haste %). One EffectTriggerSpell hop,
 *   dummy rows ignored unless they are all the spell has.
 *   See scripts/datagen/genAbilityEffects.ts for the rules and controls.
 * Absent field = the official rows do not show that effect. Treat as
 *   "not known to do this", never as proof of absence for a spell whose
 *   implementation is a dummy row + server script.
 * ids: 2232 — absorb 109, heals self 119, heals others 264, healing-received 9, haste 70, hits enemy 1638, enemy AoE 566, deals damage 1166
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
  hitsEnemy?: true;
  enemyAoE?: true;
  dealsDamage?: true;
};

export const ABILITY_EFFECTS_GENERATED: Record<string, AbilityEffectFacts> =
  raw as Record<string, AbilityEffectFacts>;
