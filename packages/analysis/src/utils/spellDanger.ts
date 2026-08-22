import { spells } from '../data/spellTags';

export enum SpellEffectType {
  DamageAmp = 'DamageAmp',
  HealReduction = 'HealReduction',
  Vulnerability = 'Vulnerability',
  Execution = 'Execution',
}

export const EFFECT_TYPE_WEIGHTS: Record<SpellEffectType, number> = {
  [SpellEffectType.DamageAmp]: 1.0,
  [SpellEffectType.HealReduction]: 1.5,
  [SpellEffectType.Vulnerability]: 1.2,
  [SpellEffectType.Execution]: 0.8,
};

/**
 * Effect type overrides for spells that are more dangerous than generic DamageAmp.
 * spells.json is the source of truth for *which* spells are offensive —
 * this table only needs entries for spells with non-DamageAmp effects.
 */
// 2026-08-21 S2 corpus scan (10,682 matches): removed Soul Rot 386997, Shadowy Duel 207736 — 0 occurrences, ability gone in 12.x (eval-private/reports/s2-health-2026-08-21)
// Same scan, WRONG ids replaced/deleted: 79140 Vendetta → Deathmark 360194/1248010;
// 315185 ("Mind Phase Transition In"), 314667 (no DB2 entry), 400986 ("Hellsteel
// Plating"), 343721 ("Final Reckoning") deleted; 323764 was Convoke the Spirits and
// 115080 an old Touch of Death id → both replaced by the live 322109.
export const SPELL_EFFECT_OVERRIDES: Record<string, SpellEffectType[]> = {
  // DamageAmp + HealReduction
  '360194': [SpellEffectType.DamageAmp, SpellEffectType.HealReduction], // Deathmark (Assassination Rogue)
  '1248010': [SpellEffectType.DamageAmp, SpellEffectType.HealReduction], // Deathmark (Assassination Rogue, 12.1 variant id)
  // HealReduction only
  '375901': [SpellEffectType.HealReduction], // Mindgames (Shadow Priest) — reverses heals into damage
  '198817': [SpellEffectType.HealReduction], // Sharpen Blade (Warrior)
  // Execution
  '322109': [SpellEffectType.Execution], // Touch of Death (Monk)
  '343527': [SpellEffectType.Execution], // Execution Sentence (Paladin) — 4 live ids 12.1
  '387113': [SpellEffectType.Execution], // Execution Sentence (Paladin) — 4 live ids 12.1
  '1234189': [SpellEffectType.Execution], // Execution Sentence (Paladin) — 4 live ids 12.1
  '1260251': [SpellEffectType.Execution], // Execution Sentence (Paladin) — 4 live ids 12.1
};

/**
 * Returns true if spells.json classifies this spell as offensive.
 * This is the authoritative check — covers all 120 tagged offensive spells.
 */
export function isOffensiveSpell(spellId: string): boolean {
  const entry = spells[spellId];
  return entry?.type === 'buffs_offensive' || entry?.type === 'debuffs_offensive';
}

/**
 * Logarithmic CD tier weight.
 * 30s→0.0, 60s→0.69, 90s→1.10, 120s→1.39, 180s→1.79, 300s→2.30
 */
export function cdTierWeight(cooldownSeconds: number): number {
  if (cooldownSeconds < 30) return 0;
  return Math.log(cooldownSeconds / 30);
}

/**
 * Combined danger weight for a single spell cast.
 * Uses SPELL_EFFECT_OVERRIDES for non-DamageAmp effects; defaults to DamageAmp for
 * any spell tagged offensive in spells.json.
 */
export function spellDangerWeight(spellId: string, cooldownSeconds: number): number {
  const effects = SPELL_EFFECT_OVERRIDES[spellId] ?? [SpellEffectType.DamageAmp];
  const effectWeight = effects.reduce((sum, e) => sum + EFFECT_TYPE_WEIGHTS[e], 0);
  return cdTierWeight(cooldownSeconds) * effectWeight;
}

/** Score label for display */
export function dangerLabel(score: number): 'Low' | 'Moderate' | 'High' | 'Critical' {
  if (score >= 7) return 'Critical';
  if (score >= 4) return 'High';
  if (score >= 2) return 'Moderate';
  return 'Low';
}
