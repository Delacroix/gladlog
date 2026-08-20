/**
 * Generated at: 2026-08-20T03:39:24.089Z
 * Build: 12.1.0.69382
 * Candidates: 8070
 * Mined: 8063
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

import type { IMinedSpell } from "./spellEffectData";
import rawEffects from "./spellEffectGenerated.json";

export const SPELL_EFFECTS_GENERATED: Record<string, IMinedSpell> =
  rawEffects as unknown as Record<string, IMinedSpell>;
