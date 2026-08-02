/**
 * Single source for the finding category enum (2026-07-25, landing the separate
 * task settled in the agy debate).
 *
 * category used to be a free-form string chosen by the model
 * (buildFindingsPrompt imposed no constraint), yet it is the cross-match
 * aggregation key of the mistake log (StatsDashboard groups by category) and
 * part of findingKey — a free string drifting with language/wording breaks the
 * aggregation (in Chinese mode both SURVIVAL and 目标选择 were observed for the
 * same thing). The fix: the model's output is constrained to an English slug
 * enum and localization happens only on the render side; normalization runs
 * deterministically in the audit layer, and anything outside the table is kept
 * verbatim (never folded into "other" — merging unknown values would let
 * distinct new forms overwrite each other).
 */

export const FINDING_CATEGORIES = [
  "survival",
  "cooldowns",
  "positioning",
  "target-selection",
  "cc",
  "interrupts",
  "dispels",
  "offense",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

const CANON = new Set<string>(FINDING_CATEGORIES);

/** Synonyms / historical forms → slug. Keys are always compared lower-cased;
 * covers the model's historical output (SURVIVAL, 目标选择), common English
 * near-synonyms, and the domain relatives of candidateFindings' type. */
const ALIASES: Record<string, FindingCategory> = {
  // survival
  survivability: "survival",
  defense: "survival",
  defensives: "survival",
  生存: "survival",
  // cooldowns
  cd: "cooldowns",
  cooldown: "cooldowns",
  "cooldown-usage": "cooldowns",
  "cd-usage": "cooldowns",
  "cd-waste": "cooldowns",
  cds: "cooldowns",
  冷却: "cooldowns",
  // positioning
  position: "positioning",
  站位: "positioning",
  走位: "positioning",
  // target-selection
  "target selection": "target-selection",
  targeting: "target-selection",
  "target-priority": "target-selection",
  目标选择: "target-selection",
  // cc
  "cc-usage": "cc",
  "crowd control": "cc",
  "crowd-control": "cc",
  控制: "cc",
  // interrupts
  interrupt: "interrupts",
  kicks: "interrupts",
  打断: "interrupts",
  // dispels
  dispel: "dispels",
  cleanse: "dispels",
  purge: "dispels",
  驱散: "dispels",
  // offense
  offensive: "offense",
  damage: "offense",
  burst: "offense",
  进攻: "offense",
};

/** Deterministic normalization: enum members pass through unchanged; aliases
 * are mapped; everything else is returned trimmed but verbatim (unknown forms
 * are preserved — they do not merge in the aggregation, but neither do they
 * contaminate each other). */
export function normalizeFindingCategory(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  if (CANON.has(lower)) return lower;
  return ALIASES[lower] ?? ALIASES[t] ?? t;
}
