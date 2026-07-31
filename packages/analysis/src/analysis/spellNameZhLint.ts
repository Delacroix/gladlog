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
// History of this predicate (both rounds were reviewer-found gaps):
// 1. Original guard was a single strict regex requiring the zh name within 4
//    WHITESPACE chars of the opening paren — missed "Guardian Spirit（中文：
//    守护之魂）" (a prefix inside the parens), so repair corrupted the gloss
//    into "Guardian Spirit（中文：Guardian Spirit）".
// 2. Follow-up fix used a single fixed-width (12-char) lookback measured
//    BACKWARD FROM THE ZH NAME to find the EN name — still fixed-width, so
//    it broke again on any in-paren prefix longer than ~12 chars (e.g. a
//    verbose annotation before the zh name).
// The actual structural fact that makes something a gloss is "the zh name
// sits inside an unclosed bracket, and that bracket is the one immediately
// following the EN name" — NOT "the zh name is within N chars of the EN
// name". Splitting the check into two independently-bounded scans fixes
// this for good: (a) find the nearest unclosed "（"/"(" before the zh name,
// scanning back up to BRACKET_SCAN_LIMIT chars (bounds a pathologically
// long in-bracket prefix — the actual bug in round 2); (b) separately check
// the EN name sits immediately before THAT bracket (small fixed gap, since
// real "EN（" is always zero-gap — this scan is anchored to the bracket
// position, so it is never affected by how long the in-bracket prefix is).
const BRACKET_SCAN_LIMIT = 60; // generous bound for pathological in-bracket text
const EN_BRACKET_ADJACENCY_GAP = 4; // slack between the EN name and "（"/"(" itself

/** Nearest unclosed "（"/"(" before `idx`, or -1 if none within the scan
 * window (also -1 if a closing "）"/")" is hit first — that bracket is
 * already closed before reaching `idx`, so it doesn't enclose it). */
function enclosingBracketStart(text: string, idx: number): number {
  const scanStart = Math.max(0, idx - BRACKET_SCAN_LIMIT);
  for (let i = idx - 1; i >= scanStart; i--) {
    const c = text[i];
    if (c === "）" || c === ")") return -1;
    if (c === "（" || c === "(") return i;
  }
  return -1;
}

/** Structural signal alone: is `idx` (start of a zh-name match) inside SOME
 * unclosed bracket at all, regardless of what's in it? This is the ONLY
 * condition repairSpellNameZh checks before touching an occurrence — when
 * unsure whether bracketed text is a real gloss, don't mutate it (lint can
 * still flag it; see spellNameZhLint below, which additionally requires the
 * EN name to call it compliant). */
function isInsideUnclosedBracket(text: string, idx: number): boolean {
  return enclosingBracketStart(text, idx) !== -1;
}

/** Full gloss check (used for detection, i.e. "is this actually compliant,
 * not just bracketed"): the zh name must be inside an unclosed bracket AND
 * that specific bracket must be immediately preceded by the EN name. */
function isCompliantGloss(text: string, idx: number, enName: string): boolean {
  const bracketStart = enclosingBracketStart(text, idx);
  if (bracketStart === -1) return false;
  const beforeBracket = text.slice(
    Math.max(0, bracketStart - enName.length - EN_BRACKET_ADJACENCY_GAP),
    bracketStart,
  );
  return beforeBracket.includes(enName);
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

/** Detect zh-translated spell names in `text`. Empty = clean (mirrors
 * causalLint's contract). A zh name that only appears inside the allowed
 * "EN（zh）" gloss form is NOT reported — but a zh name merely sitting in
 * SOME unrelated bracket (no adjacent EN name) is still a violation: being
 * bracketed alone doesn't excuse it, only a confirmed EN-adjacent gloss
 * does (repairSpellNameZh is the conservative one that treats "bracketed"
 * alone as reason enough to not touch it — see its own doc comment). */
export function spellNameZhLint(text: string): SpellNameZhHit[] {
  const hits: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!text.includes(zhName)) continue;
    const violating = findAllIndices(text, zhName).some(
      (idx) => !isCompliantGloss(text, idx, enName),
    );
    if (violating) hits.push({ zhName, enName });
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
 *
 * Skip condition is deliberately STRUCTURAL and broader than spellNameZhLint's
 * "compliant gloss" check: ANY zh-name occurrence sitting inside an unclosed
 * bracket is left untouched, regardless of whether an EN name is anywhere
 * nearby. Mutating text inside a bracket is the risky case (footnotes,
 * clarifications, nested annotations, quoted asides) — when unsure whether a
 * bracketed occurrence is a real gloss, this function does NOT repair it.
 * spellNameZhLint still flags a bracketed-but-not-EN-glossed occurrence as a
 * hit (it's a real violation), so nothing goes unreported — repair is just
 * more conservative than detection here on purpose.
 */
export function repairSpellNameZh(text: string): {
  text: string;
  repairs: SpellNameZhHit[];
} {
  let result = text;
  const repairs: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!result.includes(zhName)) continue;
    const allIdx = findAllIndices(result, zhName);
    const repairableIdx = new Set(
      allIdx.filter((idx) => !isInsideUnclosedBracket(result, idx)),
    );
    if (repairableIdx.size === 0) continue;
    let out = "";
    let cursor = 0;
    for (const idx of allIdx) {
      if (!repairableIdx.has(idx)) continue; // bracketed: leave untouched
      out += result.slice(cursor, idx) + enName;
      cursor = idx + zhName.length;
    }
    out += result.slice(cursor);
    result = out;
    repairs.push({ zhName, enName });
  }
  return { text: result, repairs };
}
