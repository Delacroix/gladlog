import raw from "./spellNamesZhGenerated.json";

/** zhCN ability names (a datagen artifact, limited to the intersection of the
 * icon set and genuine translations). A missing entry = untranslated or without
 * an icon; the consumer's fallback chain is: this match's log name > this table
 * > the English name unchanged. */
export const SPELL_NAMES_ZH_GENERATED = raw as unknown as Record<
  string,
  string
>;
