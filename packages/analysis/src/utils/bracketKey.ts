/**
 * One predicate for "which bracket is this combat" from the raw
 * `startInfo.bracket` string the log carries ("2v2", "3v3",
 * "Rated Solo Shuffle", …). Consumers: candidateFindings (per-bracket
 * candidate allow-list, GH #18 ruling 2026-08-30) and
 * archetypeInjection.bracketToArchetypeSlug (which used to parse the string
 * itself — same fact, now one predicate). Unknown/blitz/BG → null.
 */
export type BracketKey = "2v2" | "3v3" | "solo";

export function bracketKey(
  bracket: string | undefined | null,
): BracketKey | null {
  if (!bracket) return null;
  const lower = bracket.toLowerCase();
  if (lower.includes("solo")) return "solo";
  if (lower.includes("3v3")) return "3v3";
  if (lower.includes("2v2")) return "2v2";
  return null;
}
