import { getEnglishSpellName } from "@gladlog/analysis";

/** Single source for spell names in the render layer (P2-1): by default it
 * returns the logged name verbatim (same criterion as the GCD lanes and the
 * meter details — a CN log stays Chinese everywhere, an EN log stays English
 * everywhere); only when the logged name is missing (e.g. a spell that was
 * never cast and is known by id alone) does it fall back to the English
 * dictionary name. The analysis side (prompt/audits) does not go through
 * this. */
export function displaySpellName(
  spellId: string | null | undefined,
  logName: string | null | undefined,
): string {
  return logName || getEnglishSpellName(spellId ?? "", null);
}
