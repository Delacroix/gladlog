import raw from "./observedSpellIdsGenerated.json";

/** spellIds observed across the corpus (strings, matching the repo-wide id
 * convention). */
export const OBSERVED_SPELL_IDS: ReadonlySet<string> = new Set(
  (raw as unknown as number[]).map(String),
);
