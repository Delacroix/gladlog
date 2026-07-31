// spellNameZhLint — detects known WoW ability names rendered in their
// official Chinese localization inside AI-coach output that is contractually
// required to keep spell/ability names in English (packages/desktop/src/main/
// ai.ts buildCoachSystemPrompt) so the #15 inline-icon scanner (English-name
// tokens only) can still attach an icon.
//
// Single source consumed by auditFindings.ts (f.explanation), deepDive.ts
// (entry.deepDive), and distillRules.ts (description/advice) — mirrors
// causalLint.ts's placement/export pattern (same three call sites, same
// "one predicate, no forks" rule). Unlike causalLint, a hit here is
// auto-repaired (zh name replaced by its EN name) rather than dropping the
// whole finding — see repairSpellNameZh below for the justification.
//
// Consumption invariant (auditFindings.ts / deepDive.ts / distillRules.ts):
// repair runs BEFORE causalLint, everywhere. Repaired text is what
// downstream lints validate and what the user ultimately sees — there is
// exactly one canonical order, not "whatever the call site happened to do".
import { SPELL_NAME_ZH_TO_EN } from "../data/spellNameZhLintTable";

export interface SpellNameZhHit {
  zhName: string;
  enName: string;
}

// Longest zh name first: table has no known nested entries today, but
// scanning long-to-short is future-proof against one curated name being a
// substring of another (e.g. a hypothetical "陷阱" inside "冰冻陷阱").
const ENTRIES: ReadonlyArray<readonly [string, string]> = Object.entries(
  SPELL_NAME_ZH_TO_EN,
).sort((a, b) => b[0].length - a[0].length);

// Product policy explicitly allows "EnglishName（中文注解）" — the name TOKEN
// stays English, the parenthetical is just a reader gloss (confirmed
// compliant example from the b824e72 A/B: "Guardian Spirit（守护之魂）"). Only
// the reverse — the zh name used as the primary token, with no adjacent
// English — is the actual violation.
//
// 2026-07-31 gap fix: the original guard was a single strict regex
// (`EN\s{0,4}[（(]\s{0,4}zh\s{0,4}[）)]`) that required the zh name to sit
// within 4 WHITESPACE chars of the opening paren. Real model output glosses
// with a prefix inside the parens too — "Guardian Spirit（中文：守护之魂）" —
// so the old regex didn't recognize it as a gloss, and repair silently
// replaced the zh name INSIDE the gloss, corrupting it into
// "Guardian Spirit（中文：Guardian Spirit）". Silent irreversible mutation is
// worse than a missed repair (lint would have flagged it instead), so the
// new rule is deliberately loose about what counts as "glossed" — it looks
// for the EN name within a bounded lookback window before the zh name AND
// an opening bracket somewhere in between (so it doesn't accidentally treat
// an unrelated earlier EN mention several sentences back as a gloss for a
// later bare zh violation — see the "still flags a bare occurrence" test).
const GLOSS_LOOKBACK_GAP = 12; // chars allowed between end-of-EN-name and start-of-zh-name

function isGlossedOccurrence(
  text: string,
  zhIndex: number,
  enName: string,
): boolean {
  const windowStart = Math.max(0, zhIndex - GLOSS_LOOKBACK_GAP - enName.length);
  const context = text.slice(windowStart, zhIndex);
  const enPos = context.lastIndexOf(enName);
  if (enPos === -1) return false;
  const between = context.slice(enPos + enName.length);
  // Must be wrapped in a bracket structure ("（"/"(" between the EN name and
  // the zh name) — not just "EN name happens to be nearby in the prose" —
  // and the bracket must not already be closed before reaching the zh name.
  return /[（(]/.test(between) && !/[）)]/.test(between);
}

/** All start indices where `zhName` occurs verbatim in `text`. */
function findAllIndices(text: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return out;
    out.push(idx);
    from = idx + needle.length;
  }
}

function bareOccurrenceIndices(
  text: string,
  zhName: string,
  enName: string,
): number[] {
  return findAllIndices(text, zhName).filter(
    (idx) => !isGlossedOccurrence(text, idx, enName),
  );
}

/** Detect zh-translated spell names in `text`. Empty = clean (mirrors
 * causalLint's contract). A zh name that only appears inside the allowed
 * "EN（zh）" gloss form is NOT reported. */
export function spellNameZhLint(text: string): SpellNameZhHit[] {
  const hits: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!text.includes(zhName)) continue;
    if (bareOccurrenceIndices(text, zhName, enName).length > 0) {
      hits.push({ zhName, enName });
    }
  }
  return hits;
}

/**
 * Auto-repair: replace bare occurrences of a curated zh spell name with its
 * EN name (1:1 curated mapping — see spellNameZhLintTable.ts — so this is a
 * deterministic, safe substitution, unlike causalLint's DROP-on-hit policy).
 * Dropping a whole finding/deepDive/rule over one translated name is too
 * destructive for a defect this narrow and this mechanically fixable; the
 * repair also directly restores #15 inline-icon matching (English-name-only
 * scanner) that the untranslated finding text would otherwise silently miss.
 * Already-glossed "EN（zh）" occurrences (isGlossedOccurrence) are left
 * untouched — when unsure whether a span is a gloss, this function does NOT
 * repair it (spellNameZhLint uses the identical predicate, so anything this
 * function leaves alone is also not reported as a hit).
 */
export function repairSpellNameZh(text: string): {
  text: string;
  repairs: SpellNameZhHit[];
} {
  let result = text;
  const repairs: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!result.includes(zhName)) continue;
    const bareIdx = new Set(bareOccurrenceIndices(result, zhName, enName));
    if (bareIdx.size === 0) continue;
    let out = "";
    let cursor = 0;
    for (const idx of findAllIndices(result, zhName)) {
      if (!bareIdx.has(idx)) continue; // glossed occurrence: leave untouched
      out += result.slice(cursor, idx) + enName;
      cursor = idx + zhName.length;
    }
    out += result.slice(cursor);
    result = out;
    repairs.push({ zhName, enName });
  }
  return { text: result, repairs };
}
