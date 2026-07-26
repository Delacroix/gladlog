/**
 * Generated at: 2026-07-11T09:20:51.664Z
 * Build: 12.1.0.68629
 * Candidates: 3562
 * Mined: 3560
 * 数据在同名 .json(vite json.stringify → JSON.parse 装载,大 JSON 教训)。
 */

import type { IMinedSpell } from "./spellEffectData";
import rawEffects from "./spellEffectGenerated.json";

export const SPELL_EFFECTS_GENERATED: Record<string, IMinedSpell> =
  rawEffects as unknown as Record<string, IMinedSpell>;
