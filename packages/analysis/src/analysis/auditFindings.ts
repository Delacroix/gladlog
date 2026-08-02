import { claimChecker, interpolate } from "../compare/claimChecker";
import { causalLint } from "./causalLint";
import { normalizeFindingCategory } from "./findingCategories";
import { repairSpellNameZh } from "./spellNameZhLint";
import type { AuditResult, CandidateEvent, Finding, RawFinding } from "./types";

/** Single-source severity ordering (high > med > low): shared by audit sorting
 * and deep-dive selection. */
export const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  med: 1,
  low: 2,
};
const RANK = SEVERITY_RANK;

export function auditFindings(
  raw: RawFinding[],
  candidates: CandidateEvent[],
): AuditResult {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  const dropped: AuditResult["dropped"] = [];

  for (const f of raw) {
    // Layer 1: grounding — the finding must anchor to >=1 event, and every
    // eventId must resolve. (Empty eventIds is unanchored → drop.)
    const refs = f.eventIds.map((id) => byId.get(id));
    if (f.eventIds.length === 0 || refs.some((r) => !r)) {
      dropped.push({
        finding: f,
        reason: "grounding: unanchored / unknown eventId",
      });
      continue;
    }
    // Facts the explanation may cite = the union of the referenced events' facts.
    // If two referenced events share a fact key with DIFFERING values (e.g. two
    // deaths, each with its own t), that placeholder is ambiguous — a last-write
    // merge would silently mis-attribute. Refined 2026-07-24: drop only when
    // the explanation **actually uses** a colliding key — the old rule dropped
    // the whole finding whenever a colliding key merely existed, which also
    // killed the multi-event chains the prompt explicitly encourages (death +
    // setup, several missed cleanses); a smoke run measured 3/7 findings dying
    // this way. The mis-attribution guarantee is unchanged: every rendered
    // placeholder must still resolve uniquely.
    const facts: Record<string, string> = {};
    const colliding = new Set<string>();
    for (const r of refs as CandidateEvent[])
      for (const [k, v] of Object.entries(r.facts)) {
        if (k in facts && facts[k] !== v) colliding.add(k);
        facts[k] = v;
      }
    // Indexed variants ({{t1}}/{{t2}}, following eventIds order): the **only
    // legal way** for a multi-event finding to reference each event's own
    // timestamp. Without them, a model writing {{t}} is guaranteed to be
    // dropped — reproduced in production 2026-07-25: 3 of 5 findings in a
    // Chinese reply died this way and the user saw only 2. Generated for
    // **every** key, not just colliding ones: the model cannot see the
    // collision set, so emitting only colliding keys would make {{duration1}}
    // (where both values happen to be equal) and a single-event {{deathT1}}
    // fail to resolve and be wrongly dropped (confirmed by smoke). Build the
    // variants first, then merge the bare keys, with skip-if-present so a real
    // key that happens to end in a digit is not clobbered.
    (refs as CandidateEvent[]).forEach((r, i) => {
      for (const [k, v] of Object.entries(r.facts)) {
        const indexed = `${k}${i + 1}`;
        if (!(indexed in facts)) facts[indexed] = v;
      }
    });
    const usedKeys = [
      ...f.explanation.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g),
    ].map((m) => m[1]!);
    const ambiguous = usedKeys.filter((k) => colliding.has(k));
    if (ambiguous.length > 0) {
      dropped.push({
        finding: f,
        reason: `ambiguous: placeholder(s) ${ambiguous.join(",")} collide across referenced events`,
      });
      continue;
    }
    // Layer 2: numeric. claimChecker validates {{key}} resolution + flags raw
    // decimals/percentages. But analysis fabrication is integer-heavy (times,
    // damage, "90k"), and the shared checker allows bare integers — unsafe here.
    // So additionally forbid ANY raw digit outside a placeholder: the prompt
    // mandates every number be a {{placeholder}}, so a bare digit = fabrication
    // or a disobeyed instruction. (Do not fork the shared checker; add the
    // stricter rule at the audit layer.)
    const check = claimChecker(f.explanation, facts);
    if (!check.ok) {
      dropped.push({
        finding: f,
        reason: `numeric: ${check.violations.join("; ")}`,
      });
      continue;
    }
    // Strip placeholders, then bracket/format terms (1v1, 2v2, 3v3 — never a
    // fabricated stat), then flag any remaining raw digit.
    // Stripping uses the same **strict** pattern as claimChecker: a lax
    // [^}]* would also strip illegal placeholders like {{t-1}} — which never
    // pass interpolate and would render verbatim into the UI. Under the strict
    // pattern such text stays put, contains digits, and is dropped by the raw
    // digit rule (agy review F3).
    const prose = f.explanation
      .replace(/\{\{\s*[\w.]+\s*\}\}/g, " ")
      .replace(/\b\d+v\d+\b/gi, " ");
    if (/\d/.test(prose)) {
      dropped.push({
        finding: f,
        reason: "numeric: raw digit outside placeholder",
      });
      continue;
    }
    // Layer 3: zh spell-name auto-repair. Unlike causalLint (drop-on-hit), a
    // translated ability name is deterministically fixable 1:1 — dropping
    // the whole finding over one mistranslated name is too destructive, and
    // repairing also restores #15 inline-icon matching (English-name-only
    // scanner) that the untranslated text would otherwise silently miss.
    // Consumption invariant: repair runs BEFORE causalLint (see
    // spellNameZhLint.ts's header comment) — causalLint below validates the
    // REPAIRED text, the same text that ends up in the finding.
    const { text: repairedExplanation, repairs } = repairSpellNameZh(
      f.explanation,
    );
    if (repairs.length > 0) {
      console.warn(
        `[spellNameZhLint] auditFindings repaired ${repairs.map((r) => `${r.zhName}→${r.enName}`).join(", ")}`,
      );
    }
    // Layer 4: causal-language lint (on the repaired text).
    const causal = causalLint(repairedExplanation);
    if (causal.length > 0) {
      dropped.push({ finding: f, reason: `causal: ${causal.join("; ")}` });
      continue;
    }
    findings.push({
      ...f,
      // Normalize category (enum/alias → slug, anything off-vocabulary kept
      // as-is): the stability of aggregation keys and of findingKey is fixed
      // here; the render side only localizes for display
      category: normalizeFindingCategory(f.category),
      explanation: interpolate(repairedExplanation, facts),
    });
  }

  findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
  return { findings, dropped };
}
