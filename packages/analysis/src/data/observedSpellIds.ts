import raw from "./observedSpellIdsGenerated.json";

/** 语料观测过的 spellId(字符串,与全仓 id 口径一致)。 */
export const OBSERVED_SPELL_IDS: ReadonlySet<string> = new Set(
  (raw as unknown as number[]).map(String),
);
