/**
 * Placeholder syntax (single source). interpolate, claimChecker, and the
 * deep-dive audit must all share this one regex — writing their own drifts:
 * the deep-dive audit once carried its own `/\{\{(p\d+)\.[^}]+\}\}/`, which
 * tolerated no leading whitespace. So when the model wrote `{{ p1.t }}`,
 * claimChecker accepted it and the bare-number check accepted it, but only the
 * audit failed to extract the key → with citedKeys empty the whole item was
 * silently dropped, and with it non-empty the chips degraded to citedKeys
 * only, quietly undoing the "chips take citedKeys ∪ usedKeys so we don't jump
 * to the wrong moment" fix.
 */
export const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** The placeholder keys actually used in the text (e.g. `p1.t`), deduplicated
 * and kept in order of first appearance. */
export function extractPlaceholderKeys(text: string): string[] {
  const re = new RegExp(PLACEHOLDER.source, "g");
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))];
}

/** Replace every {{key}} present in facts with its value; unknown keys stay literal. */
export function interpolate(
  text: string,
  facts: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(facts, key) ? facts[key] : m,
  );
}

// A "stat-like" bare number: a decimal (0.85 OR a leading-dot .85), or an integer
// tied to a stat context (% or "percentile"). Conversational integers ("2 minutes")
// are allowed. Runs AFTER placeholder spans are stripped, so no lookbehind needed.
const DECIMAL = /\d*\.\d+/;
const STAT_PCT = /\b\d+\s*(%|percent\b)/i; // digit + % OR the word "percent"
const PERCENTILE_NUM = /\b\d+(st|nd|rd|th)?\s*percentile/i;

/**
 * Scrub exemplar text of everything this file's gate would flag (2026-08-12
 * probe: 27/36 real compare narrations were killed by claimChecker, and the
 * single biggest source was the model quoting the exemplar crisis strings —
 * `At 19.3s (Teammate X HP: 36%): …` carries the exact decimals/percentages
 * the HARD RULES forbid, so the prompt fed the model contraband and then shot
 * it for repeating it; same disease as the 2026-08-01 "rich context bypasses
 * the candidate gate" incident).
 *
 * Lives HERE, next to the gate regexes it reuses (shared-predicate rule): the
 * first two replaces handle the known machine-generated crisis-string shapes
 * readably, and the generic passes over the very same DECIMAL/STAT_PCT/
 * PERCENTILE_NUM sources guarantee the invariant "scrubbed text passes the
 * gate" no matter what shape the corpus grows next — the test asserts exactly
 * that, with claimChecker itself as the oracle.
 */
export function scrubExemplar(text: string): string {
  return (
    text
      // crisisEvents.ts shape: `At 19.3s (Teammate X HP: 36%): casts`
      .replace(/\bAt\s+\d+(?:\.\d+)?s\s*/gi, "")
      .replace(/HP:\s*\d+\s*%/gi, "HP low")
      // belt-and-braces: anything else the gate would flag, via the same regex
      // sources the gate scans with
      .replace(new RegExp(DECIMAL.source, "g"), "")
      .replace(new RegExp(STAT_PCT.source, "gi"), "")
      .replace(new RegExp(PERCENTILE_NUM.source, "gi"), "percentile")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export function claimChecker(
  rawText: string,
  facts: Record<string, string>,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  // 1. every {{key}} must resolve
  let m: RegExpExecArray | null;
  const re = new RegExp(PLACEHOLDER.source, "g");
  while ((m = re.exec(rawText)) !== null) {
    if (!Object.prototype.hasOwnProperty.call(facts, m[1]))
      violations.push(`unknown placeholder {{${m[1]}}}`);
  }
  // 2. strip placeholder spans, then scan the prose for raw stat-like numbers
  const prose = rawText.replace(PLACEHOLDER, " ");
  for (const [label, rx] of [
    ["decimal", DECIMAL],
    ["percentage", STAT_PCT],
    ["percentile", PERCENTILE_NUM],
  ] as const) {
    const hit = prose.match(rx);
    if (hit)
      violations.push(`raw ${label} outside placeholder: "${hit[0].trim()}"`);
  }
  return { ok: violations.length === 0, violations };
}
