// packages/analysis/src/compare/buildExemplarLedPrompt.ts
import type { VerifiedComparison } from "./verifiedComparison";
import type { ReferenceCell } from "./corpusTypes";

/**
 * Cache key for the cohort-comparison cache (desktop's `compare.json`) — the
 * version of *this file's* prompt. Unrelated to the findings prompt version in
 * `shared/promptVersion.ts`.
 *
 * Single-source predicate: bump it here when buildExemplarLedPrompt's output
 * changes, or when verifiedComparison's set of dimensions changes. The writer
 * (compare.ts `finish`) and the reader (`getCached`) share this one constant.
 *
 * Why it has to be its own constant (2026-08-02): compare.json used to key off
 * the analysis PROMPT_VERSION, which has no causal relation to it — so every
 * findings-prompt bump (13→14→15 within two days, 2026-08-01/02) silently voided
 * every stored cohort comparison in the library, and the "vs your cohort" panel
 * simply vanished with no explanation. v1 is the decoupling point; older
 * compare.json files store the analysis version (3/14/15…), which will not equal
 * 1 and is therefore treated as stale. That is intended — the old predicate had
 * already invalidated them — so there is no migration.
 */
export const COMPARE_PROMPT_VERSION = 1;

export function buildExemplarLedPrompt(
  vc: VerifiedComparison,
  cell: ReferenceCell,
  specName: string,
): string {
  const keyLines = Object.keys(vc.facts)
    .map((k) => `  {{${k}}}`)
    .join("\n");
  const exemplars = cell.exemplarCrises
    .flat()
    .slice(0, 8)
    .map((c) => `  - ${c}`)
    .join("\n");
  return [
    `You are a World of Warcraft arena coach. Compare this ${specName}'s play to their skill cohort (bracket ${cell.bracket}, comp ${cell.archetype}, build group ${cell.buildGroup}, N=${cell.sampleN}).`,
    ``,
    `STRUCTURE (make it genuinely instructive, not a number dump):`,
    `1. One opening sentence: overall read of where this player sits vs the cohort.`,
    `2. For each dimension where the player is meaningfully BELOW the cohort (per its verdict placeholder): a short paragraph that (a) explains in plain language what that metric measures and why it wins games, (b) states the gap using the value/median placeholders, (c) gives ONE concrete, actionable adjustment for the next session.`,
    `3. One short paragraph acknowledging the strongest dimension (what to keep doing).`,
    `4. Close with a single priority: if they fix only one thing, which and why.`,
    ``,
    `HARD RULES:`,
    `- Refer to EVERY number and every performance judgement ONLY through the placeholders below. Never write a raw statistic, percentage, or percentile yourself — write the placeholder and it will be substituted.`,
    `- Do not invent spells, numbers, or cohort facts. Use only what is provided.`,
    ``,
    `Available placeholders (use verbatim, in double braces):`,
    keyLines,
    ``,
    `How strong players in this cohort handled crisis moments (for qualitative guidance only):`,
    exemplars || "  (none available)",
    ``,
    `Write the coaching narrative now, using the placeholders.`,
  ].join("\n");
}
