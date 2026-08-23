// @gladlog/analysis public API.
// Entry shape: legacy (@gladlog/parser-compat); the type design allows future
// native StoredMatch-shaped utils to coexist and be migrated one util at a time
// (a concession from the 4a spec debate).
export * from "./context/buildMatchContext";
export * from "./utils/cooldowns";
export * from "./utils/renderGrid";
export * from "./utils/stats";
export * from "./utils/positionSampling";
export * from "./utils/enemyCompArchetype";
export * from "./utils/enemyCDs";
export * from "./utils/offensiveWindows";
export * from "./utils/drAnalysis";
export * from "./utils/ccTrinketAnalysis";
export * from "./utils/ccBreakAnalysis";
export * from "./utils/dispelAnalysis";
export * from "./utils/dispelKind";
export * from "./utils/healingGaps";
export * from "./utils/incomingPressure";
export * from "./utils/healerOffenseAnalysis";
export * from "./utils/healerExposureAnalysis";
export * from "./utils/killWindowTargetSelection";
export * from "./utils/killAttempts";
export * from "./utils/auraIntervals";
export * from "./utils/burstLedger";
export * from "./utils/kickAudit";
export * from "./utils/dpsMetrics";
export * from "./utils/dampening";
export * from "./utils/deathOutcomeAnalysis";
export * from "./utils/talentOwnership";
export * from "./utils/counterfactual";
export * from "./utils/threatAssessment";
export * from "./utils/rawStreams";
export { SpellTag } from "./data/spellTypes";
export { zoneMetadata } from "./data/zoneMetadata";
export { classMetadata } from "./data/classSpells";
export { CURATED_ID_TABLES } from "./data/curatedIdRegistry";
export {
  HEALING_VERDICTS,
  healingVerdictDomain,
  healingVerdictOf,
  healingVerdictZh,
  type HealingVerdict,
} from "./data/healingVerdicts";
export type { CuratedIdTable, CuratedIdKind } from "./data/curatedIdRegistry";
export { spellClassMap } from "./data/drCategories";
export { SPELL_CATEGORIES } from "./data/spellCategories";
export { SPELL_EFFECT_OVERRIDES } from "./data/spellEffectOverrides";
export { default as spellIdLists } from "./data/spellIdLists";
export { ccSpellIds, trinketSpellIds } from "./data/spellTags";
export { getEnglishSpellName } from "./data/spellEffectData";
export { SPELL_ICONS_GENERATED } from "./data/spellIconsGenerated";
export { SPEC_ICONS } from "./data/specIconsGenerated";
export { SPELL_NAMES_ZH_GENERATED } from "./data/spellNamesZh";
export { OBSERVED_SPELL_IDS } from "./data/observedSpellIds";
export {
  MITIGATION_TABLE,
  MITIGATION_OVERRIDES,
  NO_MITIGATION_IDS,
  type IMitigationEntry,
} from "./data/mitigationData";
export { englishNameIndex } from "./data/spellNameLookup";
export { SPELL_NAME_STOPWORDS } from "./data/spellNameStopwords";
export { getTalentNames } from "./data/talentNames";
export { nodeMaps } from "./data/talentStrings";
export { ensureAnalysisData, analysisDataReady } from "./data/ensure";
// Geometry primitives (used by the positioning grounding scanner, backlog #3)
export {
  getUnitPositionAtTime,
  distanceBetween,
  hasLineOfSight,
  type IPosition,
} from "./utils/losAnalysis";
export { arenaObstacles } from "./data/arenaGeometry";
export * from "./utils/positionAnalysis";
export {
  computeHealerMetrics,
  computeCDResponseLatency,
} from "./utils/healerMetrics";
export type { IHealerMetrics } from "./utils/healerMetrics";
export { extractRotations } from "./utils/crisisEvents";
export type { IExtractedRotations } from "./utils/crisisEvents";

export * from "./compare/corpusTypes";
export * from "./compare/cellLookup";
export * from "./compare/verifiedComparison";
export * from "./compare/claimChecker";
export * from "./compare/buildExemplarLedPrompt";

export * from "./analysis/types";
export * from "./analysis/candidateFindings";
// P1/P2 起爆候选开关(2026-08-15,Task 6 A/B harness):候选类型开关本身没有
// index.ts 导出口(candidateFindings.test.ts 用同包内相对路径直接翻转),但 A/B
// harness 按设计（candidateTypeFlags.ts 头部注释）活在 packages/desktop/scripts
// 下,跨包边界翻转开关只能靠公开导出——这一行就是那个口子，没有派生任何新逻辑。
export { CANDIDATE_TYPE_FLAGS } from "./data/candidateTypeFlags";
export * from "./analysis/causalLint";
export * from "./analysis/hindsightLint";
export * from "./analysis/spellNameZhLint";
export * from "./analysis/auditFindings";
export * from "./analysis/findingCategories";
export * from "./analysis/buildFindingsPrompt";
export * from "./analysis/parseModelJson";
export * from "./analysis/deepDive";
export {
  METRIC_LABELS,
  VERDICT_LABELS,
  METRIC_LOWER_IS_BETTER,
  metricLabel,
  metricScore,
  verdictLabel,
} from "./compare/metricLabels";
export { OFF_GCD_SPELL_IDS } from "./data/offGcdGenerated";
// Lane pressure/exposure (backlog #4): the damage-spike threshold shared by
// the prompt and the lanes (single-source, see context/timelineHelpers.ts).
export { DMG_SPIKE_THRESHOLD } from "./context/timelineHelpers";
