import { ICombatUnit } from "@gladlog/parser-compat";

import {
  CC_DURATION_TALENT_MODIFIERS,
  ccFullDurationSeconds,
} from "../data/spellEffectData";
import { talentOwnershipOf } from "./talentOwnership";

/**
 * Full (undiminished) PvP duration of a CC / root aura AS CAST BY THIS UNIT:
 * `ccFullDurationSeconds` (official DB2, overrides layered) times every
 * `CC_DURATION_TALENT_MODIFIERS` entry the caster is known to hold
 * (`talentOwnershipOf` === "yes"; "unknown" never lengthens — a claim about a
 * longer CC must rest on evidence the player has the talent). Without a caster
 * it is the plain base duration.
 *
 * GH #44 tail (2026-09-02): the first entry is Resonant Voice → Intimidating
 * Shout 6 → 7.2 s. Consumer: ccBreakAnalysis (the "Xs of CC wasted" estimate
 * — a Warrior with the talent whose Intimidating Shout got broken at 6.5 s
 * used to be told the break wasted nothing).
 */
export function ccFullDurationForCaster(
  spellId: string,
  caster: Pick<ICombatUnit, "spec" | "info" | "spellCastEvents"> | undefined,
): number | undefined {
  const base = ccFullDurationSeconds(spellId);
  if (base === undefined || !caster) return base;
  let mult = 1;
  for (const m of CC_DURATION_TALENT_MODIFIERS[spellId] ?? [])
    if (talentOwnershipOf(caster, m.talentSpellId) === "yes")
      mult *= 1 + m.pct / 100;
  return base * mult;
}
