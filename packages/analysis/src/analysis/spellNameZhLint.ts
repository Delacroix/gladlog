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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Product policy explicitly allows "EnglishName（中文注解）" — the name TOKEN
// stays English, the parenthetical is just a gloss for the reader (confirmed
// compliant example from the b824e72 A/B: "Guardian Spirit（守护之魂）").
// Only the reverse — the zh name used as the primary token, with English
// absent or merely mentioned elsewhere — is the actual violation. This
// builds the "already glossed, don't touch" regex for one table entry.
function glossRegex(enName: string, zhName: string): RegExp {
  return new RegExp(
    `${escapeRegExp(enName)}\\s{0,4}[（(]\\s{0,4}${escapeRegExp(zhName)}\\s{0,4}[）)]`,
  );
}

/** Detect zh-translated spell names in `text`. Empty = clean (mirrors
 * causalLint's contract). A zh name that only appears inside the allowed
 * "EN（zh）" gloss form is NOT reported. */
export function spellNameZhLint(text: string): SpellNameZhHit[] {
  const hits: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!text.includes(zhName)) continue;
    // Strip every already-glossed occurrence before checking for a bare one
    // — a name can appear both glossed and bare in the same response.
    const stripped = text.replace(
      new RegExp(glossRegex(enName, zhName).source, "g"),
      "",
    );
    if (stripped.includes(zhName)) hits.push({ zhName, enName });
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
 * Already-glossed "EN（zh）" occurrences are left untouched (policy-compliant).
 */
export function repairSpellNameZh(text: string): {
  text: string;
  repairs: SpellNameZhHit[];
} {
  let result = text;
  const repairs: SpellNameZhHit[] = [];
  for (const [zhName, enName] of ENTRIES) {
    if (!result.includes(zhName)) continue;
    const before = result;
    // Alternation, gloss branch first: at each match position the regex
    // engine prefers the first alternative, so an "EN（zh）" gloss span is
    // consumed whole (and left untouched by the callback) before the bare
    // zhName branch ever gets a chance to match inside it. Everything
    // outside a matched span is untouched by String.replace by definition.
    const scanRe = new RegExp(
      `${glossRegex(enName, zhName).source}|${escapeRegExp(zhName)}`,
      "g",
    );
    result = before.replace(scanRe, (m) => (m === zhName ? enName : m));
    if (result !== before) repairs.push({ zhName, enName });
  }
  return { text: result, repairs };
}
