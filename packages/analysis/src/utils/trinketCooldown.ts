/**
 * PvP trinket (Gladiator's Medallion family) cooldown by role — the ONE
 * declaration; `ccTrinketAnalysis.ts` (trinket-availability gate on CC) and
 * `killWindowTargetSelection.ts` (target-selection trinket state) both import
 * it. Until 2026-08-28 each file carried its own uncommented copy (GH #34,
 * batch 1's first verified sample; batch 4 applies the disposition).
 *
 * Provenance — measured, NOT official: official DB2 (Gladiator's Medallion
 * 336126) says cooldown 120 with no healer/DPS split, and cannot express the
 * healer's 90s. Corpus (120 archive files / 1,903 casts, same-player
 * consecutive-cast gaps): healer min 90.0s (n=144, p10 91.5) · DPS min 120.1s
 * (n=155, p10 121.6). The hand values are right; official data is not the
 * source here. Re-run the gap measurement before changing either number.
 */
export const HEALER_TRINKET_CD_S = 90;
export const DPS_TRINKET_CD_S = 120;
