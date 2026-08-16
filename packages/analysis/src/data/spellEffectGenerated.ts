/**
 * Generated at: 2026-08-13T03:28:42.963Z
 * Build: 12.1.0.69273
 * Candidates: 4949
 * Mined: 4948
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */

import type { IMinedSpell } from "./spellEffectData";
import rawEffects from "./spellEffectGenerated.json";

export const SPELL_EFFECTS_GENERATED: Record<string, IMinedSpell> =
  rawEffects as unknown as Record<string, IMinedSpell>;
