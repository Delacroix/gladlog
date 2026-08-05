/**
 * Anti-rot test for the predicate index — the executable half of
 * `docs/predicate-index.md`.
 *
 * Why it exists: CLAUDE.md's "the gate predicate IS the spec" rule demands
 * "one fact, one predicate", with the fallback "export the predicate from one
 * place and import it on both sides; when that is impossible, write a unit
 * test asserting equality — don't rely on a comment". The 2026-08-01 lesson
 * was that what was missing wasn't the rule but the INDEX — the same person
 * who had read the rule still hand-copied two predicates in a single day (the
 * "known match" criterion and dateKey formatting). The index doc makes them
 * findable; this test keeps the doc from rotting:
 *
 *  1. every export listed in the doc must actually exist (imported by **file
 *     path**, so a rename/move turns this red);
 *  2. the Chinese and English versions must list the **same** set of
 *     predicates, matching this file's list entry by entry (three-way pinning:
 *     miss any one of them and it fails);
 *  3. pairs that cannot share an export get a direct equality assertion —
 *     exactly CLAUDE.md's fallback;
 *  4. the "analysis produces X, the gate verifies X" inverse relations are run
 *     end to end, each with a negative control so it cannot silently no-op.
 */
import * as candidateFindings from "@gladlog/analysis/src/analysis/candidateFindings";
import * as deepDive from "@gladlog/analysis/src/analysis/deepDive";
import * as factFormat from "@gladlog/analysis/src/analysis/factFormat";
import * as findingCategories from "@gladlog/analysis/src/analysis/findingCategories";
import * as momentSnapshot from "@gladlog/analysis/src/analysis/momentSnapshot";
import * as buildExemplarLedPrompt from "@gladlog/analysis/src/compare/buildExemplarLedPrompt";
import * as claimChecker from "@gladlog/analysis/src/compare/claimChecker";
import * as timelineHelpers from "@gladlog/analysis/src/context/timelineHelpers";
import * as arenaGeometry from "@gladlog/analysis/src/data/arenaGeometry";
import * as spellCategories from "@gladlog/analysis/src/data/spellCategories";
import * as spellEffectData from "@gladlog/analysis/src/data/spellEffectData";
import * as spellTags from "@gladlog/analysis/src/data/spellTags";
import * as cooldowns from "@gladlog/analysis/src/utils/cooldowns";
import * as counterfactual from "@gladlog/analysis/src/utils/counterfactual";
import * as deathOutcomeAnalysis from "@gladlog/analysis/src/utils/deathOutcomeAnalysis";
import * as dispelAnalysis from "@gladlog/analysis/src/utils/dispelAnalysis";
import * as dpsMetrics from "@gladlog/analysis/src/utils/dpsMetrics";
import * as killWindowTargetSelection from "@gladlog/analysis/src/utils/killWindowTargetSelection";
import * as losAnalysis from "@gladlog/analysis/src/utils/losAnalysis";
import * as positionAnalysis from "@gladlog/analysis/src/utils/positionAnalysis";
import * as positionSampling from "@gladlog/analysis/src/utils/positionSampling";
import * as stats from "@gladlog/analysis/src/utils/stats";
import { CombatUnitSpec } from "@gladlog/parser-compat";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// corpus-tools' package.json has `exports: { "." : ... }`, so deep imports are
// rejected — hence the relative paths. The index table lists FILES, so the test
// must be pinned to those exact files.
import * as archiveLedger from "../../corpus-tools/src/archiveLedger";
import * as archivePlan from "../../corpus-tools/src/archivePlan";
import * as pvpLogFetch from "../../corpus-tools/src/pvpLogFetch";
// Desktop renderer predicates (the "Report UI" section). Relative for a
// different reason than corpus-tools: eval has no dependency on the desktop app
// and should not grow one. Both modules are leaf-safe to import — flowSeries
// pulls only `import type`, timeRange pulls nothing — so listing them here adds
// no runtime weight to the eval suite.
import * as flowSeries from "../../desktop/src/renderer/src/report/derive/flowSeries";
import * as meterRows from "../../desktop/src/renderer/src/report/derive/meterRows";
import * as teamSide from "../../desktop/src/renderer/src/report/derive/teamSide";
import * as reportTimeRange from "../../desktop/src/renderer/src/report/derive/timeRange";
import * as abCompareStats from "../src/ab/abCompareStats";
import * as redactOutcome from "../src/halo/redactOutcome";
import * as checkScoreProvenance from "../src/provenance/checkScoreProvenance";
import * as positioningScan from "../src/quality/positioningScan";
import * as promptQualityCheck from "../src/quality/promptQualityCheck";

type Namespace = Record<string, unknown>;

interface PredicateRow {
  /**
   * File holding the authoritative predicate (repo-relative path); must match
   * the index table's second column character for character.
   */
  file: string;
  /** Export name. */
  symbol: string;
  /** That file's module namespace — existence is checked against it. */
  mod: Namespace;
}

const A = "packages/analysis/src";
const E = "packages/eval/src";
const C = "packages/corpus-tools/src";
const D = "packages/desktop/src/renderer/src/report";

/**
 * Machine-readable copy of the index table. Changing it requires the same
 * change in `docs/predicate-index.md` and `docs/predicate-index.zh-CN.md`, and
 * vice versa — the three-way consistency cases below watch for that.
 */
const INDEX: PredicateRow[] = [
  // Time and the render grid
  { file: `${A}/utils/cooldowns.ts`, symbol: "fmtTime", mod: cooldowns },
  { file: `${A}/utils/cooldowns.ts`, symbol: "toRenderSecond", mod: cooldowns },
  {
    file: `${A}/utils/cooldowns.ts`,
    symbol: "renderedWindowSeconds",
    mod: cooldowns,
  },
  // HP sampling
  {
    file: `${A}/utils/cooldowns.ts`,
    symbol: "HP_SAMPLE_RADIUS_MS",
    mod: cooldowns,
  },
  {
    file: `${A}/utils/cooldowns.ts`,
    symbol: "getUnitHpAtTimestamp",
    mod: cooldowns,
  },
  // Cooldown availability
  { file: `${A}/utils/cooldowns.ts`, symbol: "cdAvailableAt", mod: cooldowns },
  {
    file: `${A}/utils/deathOutcomeAnalysis.ts`,
    symbol: "isAvailableAt",
    mod: deathOutcomeAnalysis,
  },
  {
    file: `${A}/utils/killWindowTargetSelection.ts`,
    symbol: "matchMinHpPct",
    mod: killWindowTargetSelection,
  },
  {
    file: `${A}/analysis/candidateFindings.ts`,
    symbol: "CD_WASTE_PRESSURE_HP_PCT",
    mod: candidateFindings,
  },
  // Position and geometry
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "LOS_SWEEP_SLACK_S",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "LOS_SWEEP_GAP_MS",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "INTERP_MAX_GAP_MS",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "positionSampleInstants",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "CC_MAX_CAST_RANGE_YARDS",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "CC_MAX_PLAUSIBLE_RANGE_YARDS",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "DISPEL_MAX_RANGE_YARDS",
    mod: positionSampling,
  },
  {
    file: `${A}/data/spellCategories.ts`,
    symbol: "kickLockoutSeconds",
    mod: spellCategories,
  },
  {
    file: `${A}/utils/dispelAnalysis.ts`,
    symbol: "DR_CHAIN_LOOKAHEAD_S",
    mod: dispelAnalysis,
  },
  {
    file: `${A}/utils/positionSampling.ts`,
    symbol: "HEALER_TRAINED_YARDS",
    mod: positionSampling,
  },
  {
    file: `${A}/utils/losAnalysis.ts`,
    symbol: "getUnitPositionAtTime",
    mod: losAnalysis,
  },
  {
    file: `${A}/utils/losAnalysis.ts`,
    symbol: "getUnitRawPositionAtTime",
    mod: losAnalysis,
  },
  {
    file: `${A}/utils/losAnalysis.ts`,
    symbol: "distanceBetween",
    mod: losAnalysis,
  },
  {
    file: `${A}/utils/losAnalysis.ts`,
    symbol: "hasLineOfSight",
    mod: losAnalysis,
  },
  {
    file: `${A}/data/arenaGeometry.ts`,
    symbol: "arenaObstacles",
    mod: arenaGeometry,
  },
  {
    file: `${A}/utils/positionAnalysis.ts`,
    symbol: "POSITION_MISTAKES",
    mod: positionAnalysis,
  },
  {
    file: `${A}/utils/positionAnalysis.ts`,
    symbol: "stayedInHadRealCost",
    mod: positionAnalysis,
  },
  // Order statistics
  { file: `${A}/utils/stats.ts`, symbol: "toSortedFinite", mod: stats },
  { file: `${A}/utils/stats.ts`, symbol: "medianFinite", mod: stats },
  // Thresholds
  {
    file: `${A}/context/timelineHelpers.ts`,
    symbol: "DMG_SPIKE_THRESHOLD",
    mod: timelineHelpers,
  },
  {
    file: `${A}/utils/counterfactual.ts`,
    symbol: "COUNTERFACTUAL_WINDOW_S",
    mod: counterfactual,
  },
  {
    file: `${A}/utils/counterfactual.ts`,
    symbol: "DECISIVE_MARGIN_PCT",
    mod: counterfactual,
  },
  // Classification and name tables
  { file: `${A}/utils/cooldowns.ts`, symbol: "specToString", mod: cooldowns },
  { file: `${A}/utils/cooldowns.ts`, symbol: "isHealerSpec", mod: cooldowns },
  { file: `${A}/utils/cooldowns.ts`, symbol: "isMeleeSpec", mod: cooldowns },
  { file: `${A}/data/spellTags.ts`, symbol: "ccSpellIds", mod: spellTags },
  { file: `${A}/data/spellTags.ts`, symbol: "trinketSpellIds", mod: spellTags },
  {
    file: `${A}/data/spellEffectData.ts`,
    symbol: "getEnglishSpellName",
    mod: spellEffectData,
  },
  {
    file: `${A}/data/spellCategories.ts`,
    symbol: "isCastBlockingAuraType",
    mod: spellCategories,
  },
  {
    file: `${A}/analysis/findingCategories.ts`,
    symbol: "FINDING_CATEGORIES",
    mod: findingCategories,
  },
  {
    file: `${A}/analysis/findingCategories.ts`,
    symbol: "normalizeFindingCategory",
    mod: findingCategories,
  },
  {
    file: `${A}/utils/dpsMetrics.ts`,
    symbol: "isBurstConverted",
    mod: dpsMetrics,
  },
  // Formatting and notation
  {
    file: `${A}/compare/claimChecker.ts`,
    symbol: "PLACEHOLDER",
    mod: claimChecker,
  },
  {
    file: `${A}/compare/buildExemplarLedPrompt.ts`,
    symbol: "COMPARE_PROMPT_VERSION",
    mod: buildExemplarLedPrompt,
  },
  {
    file: `${A}/analysis/factFormat.ts`,
    symbol: "fmtFactNum",
    mod: factFormat,
  },
  // Moment snapshot (deep dive, SDD 2026-08-05 Task 1/2/3)
  {
    file: `${A}/analysis/momentSnapshot.ts`,
    symbol: "aurasActiveAt",
    mod: momentSnapshot,
  },
  {
    file: `${A}/analysis/momentSnapshot.ts`,
    symbol: "largestCastGap",
    mod: momentSnapshot,
  },
  {
    file: `${A}/analysis/momentSnapshot.ts`,
    symbol: "ACTIVITY_GAP_MIN_S",
    mod: momentSnapshot,
  },
  {
    file: `${A}/analysis/momentSnapshot.ts`,
    symbol: "MOMENT_PACK_MAX",
    mod: momentSnapshot,
  },
  {
    file: `${A}/analysis/deepDive.ts`,
    symbol: "SNAPSHOT_KINDS",
    mod: deepDive,
  },
  // Gate side
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "checkPercentileMonotonicity",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "checkSameSecondHpConsistency",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "checkWindowSpanConsistency",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "checkCooldownLedgerConsistency",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "checkSnapshotFactsConsistency",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/promptQualityCheck.ts`,
    symbol: "DEATH_KEYWORDS",
    mod: promptQualityCheck,
  },
  {
    file: `${E}/quality/positioningScan.ts`,
    symbol: "extractGeoClaims",
    mod: positioningScan,
  },
  {
    file: `${E}/quality/positioningScan.ts`,
    symbol: "checkGeoClaims",
    mod: positioningScan,
  },
  {
    file: `${E}/provenance/checkScoreProvenance.ts`,
    symbol: "FACT_AUDIT_MIN",
    mod: checkScoreProvenance,
  },
  {
    file: `${E}/provenance/checkScoreProvenance.ts`,
    symbol: "FACT_AUDIT_MAX",
    mod: checkScoreProvenance,
  },
  { file: `${E}/ab/abCompareStats.ts`, symbol: "makeRng", mod: abCompareStats },
  {
    file: `${E}/halo/redactOutcome.ts`,
    symbol: "RESULT_LABEL_RE",
    mod: redactOutcome,
  },
  // Corpus archiving
  { file: `${C}/archiveLedger.ts`, symbol: "dateKeyOf", mod: archiveLedger },
  {
    file: `${C}/archiveLedger.ts`,
    symbol: "LEDGER_WINDOW_DAYS",
    mod: archiveLedger,
  },
  { file: `${C}/archivePlan.ts`, symbol: "matchDateKey", mod: archivePlan },
  { file: `${C}/archivePlan.ts`, symbol: "isDateKeyDir", mod: archivePlan },
  { file: `${C}/archivePlan.ts`, symbol: "isKnownStub", mod: archivePlan },
  { file: `${C}/archivePlan.ts`, symbol: "shouldArchive", mod: archivePlan },
  {
    file: `${C}/archivePlan.ts`,
    symbol: "shouldStopScanning",
    mod: archivePlan,
  },
  {
    file: `${C}/archivePlan.ts`,
    symbol: "checkArchivePayload",
    mod: archivePlan,
  },
  {
    file: `${C}/pvpLogFetch.ts`,
    symbol: "checkRawPayloadBytes",
    mod: pvpLogFetch,
  },
  {
    file: `${C}/pvpLogFetch.ts`,
    symbol: "checkDecompressedPayload",
    mod: pvpLogFetch,
  },
  // Report UI (desktop renderer) — two consumers inside one screen rather than
  // an analysis/gate pair; see the doc's Scope note.
  {
    file: `${D}/derive/flowSeries.ts`,
    symbol: "forEachContribution",
    mod: flowSeries,
  },
  { file: `${D}/derive/flowSeries.ts`, symbol: "petsOf", mod: flowSeries },
  {
    file: `${D}/derive/flowSeries.ts`,
    symbol: "METRIC_BASES",
    mod: flowSeries,
  },
  {
    file: `${D}/derive/timeRange.ts`,
    symbol: "msInRange",
    mod: reportTimeRange,
  },
  { file: `${D}/derive/teamSide.ts`, symbol: "sideOfUnit", mod: teamSide },
  { file: `${D}/derive/meterRows.ts`, symbol: "meterGroups", mod: meterRows },
];

const rowKey = (r: { file: string; symbol: string }): string =>
  `${r.file} → ${r.symbol}`;

const REPO_ROOT = join(__dirname, "../../..");
const readRepo = (p: string): string =>
  readFileSync(join(REPO_ROOT, p), "utf8");

/** All .ts sources under packages/eval (repo-relative, test fixtures excluded). */
function evalSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(REPO_ROOT, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules") walk(child);
      } else if (ent.name.endsWith(".ts")) {
        out.push(child);
      }
    }
  };
  walk("packages/eval/src");
  walk("packages/eval/scripts");
  return out.sort();
}

// ---------------------------------------------------------------------------
// HEALER_TRAINED fixture: the producer side (whole-second grid +
// INTERP_MAX_GAP_MS) and the gate side (whole seconds + real sample instants +
// sub-second grid + LOS_SWEEP_GAP_MS) are deliberately parameterized
// DIFFERENTLY.
//
// Conclusion (do not try to "unify" them again): the gate's instant set is a
// **strict superset** of the producer's and its gap is looser, while
// getUnitPositionAtTime's gap only accepts/rejects and never changes the
// interpolated value — so gateMin <= producerMin always holds, and the gate's
// one-sided criterion (it only punishes "claimed closer than observed") is not
// papering over the difference but the correct expression of that directional
// relation. Making the producer adopt the gate's 3000ms gap would be wrong:
// INTERP_MAX_GAP_MS is the T3 grounding guard, and loosening it would revive
// mid-segment interpolation across sampling blackouts.
// The fixture pins that directional relation executably: 7.5yd on every whole
// second, dipping to 6.0yd on half seconds (visible to the gate only).
// ---------------------------------------------------------------------------

const FIXTURE_START_MS = 1_000_000;
const FIXTURE_END_MS = FIXTURE_START_MS + 60_000;

function fixtureUnit(
  id: string,
  name: string,
  spec: CombatUnitSpec,
  xAt: (seconds: number) => number,
): any {
  const advancedActions = [];
  for (let ms = 0; ms <= 60_000; ms += 500) {
    advancedActions.push({
      timestamp: FIXTURE_START_MS + ms,
      advanced: true,
      advancedActorCurrentHp: 100,
      advancedActorMaxHp: 100,
      advancedActorPositionX: xAt(ms / 1000),
      advancedActorPositionY: 0,
      advancedActorPowers: [],
    });
  }
  return { id, name, spec, advancedActions, deathRecords: [] };
}

const trainedHealer = (): any =>
  fixtureUnit("1", "Healer-Realm-US", CombatUnitSpec.Paladin_Holy, () => 0);

const trainedEnemy = (): any =>
  fixtureUnit("2", "Trainer-Realm-US", CombatUnitSpec.Warrior_Arms, (t) => {
    if (t >= 40 && t <= 50) return 1; // genuinely camped segment
    if (t < 10 || t > 30) return 40; // not camping
    return Number.isInteger(t) ? 7.5 : 6; // 7.5 on whole seconds, 6.0 on halves
  });

/**
 * Producer side runs the real computeOwnerPositionEvents, then renders prompt
 * lines through the real formatter.
 */
function healerTrainedFixture(): { lines: string[] } {
  const healer = trainedHealer();
  const events = positionAnalysis.computeOwnerPositionEvents({
    owner: healer,
    friends: [healer],
    enemies: [trainedEnemy()],
    combat: { startTime: FIXTURE_START_MS, endTime: FIXTURE_END_MS },
    burstWindows: [],
    ownerCooldowns: [],
    isHealer: true,
    ownerIsMelee: false,
  });
  expect(events.filter((e) => e.type === "HEALER_TRAINED")).toHaveLength(2);
  return { lines: positionAnalysis.formatPositionEventsForContext(events) };
}

function trainedCtx(): any {
  const healer = trainedHealer();
  return {
    owner: healer,
    friends: [healer],
    enemies: [trainedEnemy()],
    zoneId: "1505",
    matchStartMs: FIXTURE_START_MS,
    unitIdMap: new Map<number, string>(),
  };
}

const BEGIN = "<!-- predicate-index:begin -->";
const END = "<!-- predicate-index:end -->";
/**
 * Shape of an index-table cell: `path` → `symbol`. Prose outside the table
 * never participates in matching.
 */
const CELL = /`(packages\/[^`]+\.ts)`\s*→\s*`([A-Za-z_$][\w$]*)`/g;

function docRowKeys(docPath: string): string[] {
  const doc = readRepo(docPath);
  const from = doc.indexOf(BEGIN);
  const to = doc.indexOf(END);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error(`${docPath} 缺少 predicate-index 标记对`);
  }
  const body = doc.slice(from + BEGIN.length, to);
  return [...body.matchAll(CELL)].map((m) => `${m[1]} → ${m[2]}`);
}

describe("谓词索引:表里的每个 export 都还在", () => {
  it.each(INDEX.map((r) => [rowKey(r), r] as [string, PredicateRow]))(
    "%s",
    (_key, row) => {
      // Looked up by file path: if a symbol moves to another file the index
      // points at the wrong place, and this must go red.
      expect(Object.keys(row.mod)).toContain(row.symbol);
      expect(row.mod[row.symbol]).toBeDefined();
    },
  );
});

describe("谓词索引:文档与测试三方一致", () => {
  const EN = "docs/predicate-index.md";
  const ZH = "docs/predicate-index.zh-CN.md";

  it("英文版没有重复行", () => {
    const keys = docRowKeys(EN);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it("中英两版列出同一批谓词,顺序也相同", () => {
    // Order is pinned too: the two versions' section structure must be
    // equivalent, otherwise "equivalent content" is just a slogan.
    expect(docRowKeys(ZH)).toEqual(docRowKeys(EN));
  });

  it("文档列出的谓词与本测试的清单逐条相同", () => {
    expect(docRowKeys(EN).sort()).toEqual(INDEX.map(rowKey).sort());
  });
});

describe("谓词索引:无法共享 export 的配对,断言相等", () => {
  it("门规的 LoS 容差仍由分析侧 export 派生,不是手抄的字面量", () => {
    // TIME_SLACK_SECONDS / POSITION_MAX_GAP_MS are private aliases inside
    // positioningScan.ts and cannot be imported, so all we can pin is the
    // derivation itself — the moment someone turns it back into a literal,
    // this goes red.
    const src = readRepo("packages/eval/src/quality/positioningScan.ts");
    expect(src).toMatch(/const TIME_SLACK_SECONDS = LOS_SWEEP_SLACK_S;/);
    expect(src).toMatch(/const POSITION_MAX_GAP_MS = LOS_SWEEP_GAP_MS;/);
    // Negative control: the two gap constants are deliberately unequal — do
    // not merge them just because both are called "gap".
    expect(positionSampling.INTERP_MAX_GAP_MS).not.toBe(
      positionSampling.LOS_SWEEP_GAP_MS,
    );
  });

  it("门规的 CC 上限与贴脸定义仍由分析侧 export 派生,不是手抄的字面量", () => {
    const src = readRepo("packages/eval/src/quality/positioningScan.ts");
    expect(src).toMatch(
      /const MAX_CC_CLAIM_YARDS = CC_MAX_PLAUSIBLE_RANGE_YARDS;/,
    );
    expect(src).toMatch(/const TRAINED_MAX_YARDS = HEALER_TRAINED_YARDS;/);
    // Negative control: cast range and the "trustworthy upper bound on a
    // recomputed distance" are deliberately unequal — three places each used
    // to carry their own number (40 / 45 / 50); do not merge them into one
    // just because all three called themselves "max CC distance".
    expect(positionSampling.CC_MAX_CAST_RANGE_YARDS).not.toBe(
      positionSampling.CC_MAX_PLAUSIBLE_RANGE_YARDS,
    );
    // The ordering is structurally guaranteed by the derivation (trustworthy
    // bound = cast range + observation slack); this only pins the direction.
    expect(positionSampling.CC_MAX_CAST_RANGE_YARDS).toBeLessThan(
      positionSampling.CC_MAX_PLAUSIBLE_RANGE_YARDS,
    );
  });

  it("makeRng 与 IndexEntry 在 packages/eval 里各只有一处声明", () => {
    // Types are erased at compile time, so single-source cannot be proven at
    // runtime by "importing the same object"; what CAN be pinned is "exactly
    // one declaration in the tree". Both have been hand-copied before (the RNG
    // into the calibration-set builder; IndexEntry copied four times, with only
    // the authoritative copy carrying ownerName).
    const declaringFiles = (pattern: RegExp): string[] =>
      evalSourceFiles().filter((f) => pattern.test(readRepo(f)));

    expect(declaringFiles(/\bfunction makeRng\b/)).toEqual([
      "packages/eval/src/ab/abCompareStats.ts",
    ]);
    expect(declaringFiles(/\binterface IndexEntry\b/)).toEqual([
      "packages/eval/src/corpus/buildCorpus.ts",
    ]);
  });

  it("归档目录名与账本分片名出自同一个 dateKey 格式化", () => {
    for (const ms of [
      Date.UTC(2026, 7, 1, 0, 0, 0),
      Date.UTC(2026, 7, 1, 23, 59, 59),
      Date.UTC(2026, 0, 9, 12, 0, 0),
      Date.UTC(2025, 11, 31, 23, 0, 0),
    ]) {
      expect(archivePlan.matchDateKey(ms)).toBe(archiveLedger.dateKeyOf(ms));
    }
  });

  it("战报曲线的指标组成 == 榜单 meterValue 的组成(治疗含吸收)", () => {
    // Both halves pinned. METRIC_BASES eats events, meterValue eats totals, so
    // they cannot be one expression — but if either side stops counting
    // absorbs as healing, the chart's bars and the leaderboard bar right next
    // to them start printing different numbers for the same player.
    expect(flowSeries.METRIC_BASES).toEqual({
      damage: ["damageDone"],
      healing: ["healingDone", "absorbsDone"],
      taken: ["damageTaken"],
      healed: ["healingTaken", "absorbsTaken"],
    });
    // The leaderboard half, read off its source: `mode === "healing"` must
    // still add absorbsDone. A literal rewrite there turns this red.
    const src = readRepo(`${D}/derive/meterRows.ts`);
    expect(src).toMatch(/r\.healingDone \+ r\.absorbsDone/);
    expect(src).toMatch(/mode === "damage"\s*\n?\s*\? r\.damageDone/);
    // Negative control: the two heal-side bases are distinct facts and must
    // not be collapsed into one just because both end up in 治疗.
    expect(flowSeries.METRIC_BASES.healing[0]).not.toBe(
      flowSeries.METRIC_BASES.healing[1],
    );
  });

  it("时间窗边界只有一处比较:eventInRange 与 msInRange 在边界上一致", () => {
    const m = { startTime: 1_000_000 };
    const range = { fromS: 10, toS: 20 };
    const inMs = reportTimeRange.msInRange(m, range);
    const inEvent = reportTimeRange.eventInRange(m, range);
    for (const ms of [
      m.startTime + 9_999, // just outside
      m.startTime + 10_000, // inclusive lower bound
      m.startTime + 15_000,
      m.startTime + 20_000, // inclusive upper bound
      m.startTime + 20_001, // just outside
    ]) {
      expect(inEvent({ timestamp: ms }), String(ms)).toBe(inMs(ms));
    }
    // Boundaries are inclusive on BOTH ends — a half-open window would silently
    // drop an event landing exactly on the edge of a chosen kill window.
    expect(inMs(m.startTime + 10_000)).toBe(true);
    expect(inMs(m.startTime + 20_000)).toBe(true);
    // The defensive branch lives only on the event shape, on purpose.
    expect(inEvent({})).toBe(true);
  });
});

describe("谓词索引:分析产出 X ⇄ 门规验证 X", () => {
  it("经 fmtTime + renderedWindowSeconds 渲染的窗口,门规零违规", () => {
    const lines: string[] = [];
    const raw: [number, number][] = [];
    for (let from = 0; from < 400; from += 37) {
      for (const d of [0.1, 0.5, 0.9, 3.4, 9.6, 18.2]) {
        const to = from + 0.4 + d;
        raw.push([from + 0.4, to]);
        lines.push(
          `${cooldowns.fmtTime(from + 0.4)}–${cooldowns.fmtTime(to)} (${cooldowns.renderedWindowSeconds(from + 0.4, to)}s)`,
        );
      }
    }
    expect(promptQualityCheck.checkWindowSpanConsistency(lines)).toEqual([]);

    // Negative control: labelling the span by rounding the raw fractional
    // seconds must be caught by the gate — proof the case above is not a no-op.
    const naive = raw.map(
      ([f, t]) =>
        `${cooldowns.fmtTime(f)}–${cooldowns.fmtTime(t)} (${Math.round(t - f)}s)`,
    );
    expect(
      promptQualityCheck.checkWindowSpanConsistency(naive).length,
    ).toBeGreaterThan(0);
  });

  it("取自 toSortedFinite 的百分位,门规零违规", () => {
    const pool = [500, NaN, 100, 900, Infinity, 300, 700, NaN, 200];
    const sorted = stats.toSortedFinite(pool);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const line = `Restoration Druid (n=${sorted.length}): p50 ${at(0.5)}k | p90 ${at(0.9)}k`;
    expect(promptQualityCheck.checkPercentileMonotonicity([line])).toEqual([]);

    // Negative control: this is what the mis-ordering looks like when NaN is
    // not filtered before sort (shape measured on 2026-07-20).
    expect(
      promptQualityCheck.checkPercentileMonotonicity([
        "Marksmanship Hunter (n=87): p50 214k | p90 65k",
      ]).length,
    ).toBeGreaterThan(0);
  });

  it("HEALER_TRAINED 的 closest 距离,门规零违规(采样刻意不同参,方向由此钉住)", () => {
    const { lines } = healerTrainedFixture();
    const { claims } = positioningScan.extractGeoClaims(lines.join("\n"));
    // Both camped claims must be extracted, otherwise everything below no-ops
    const trained = claims.filter((c) => c.kind === "TRAINED");
    expect(trained).toHaveLength(2);
    expect(
      positioningScan.checkGeoClaims(claims, trainedCtx()).violations,
    ).toEqual([]);

    // If the two sides in fact sampled identically, the case above would be a
    // no-op. This conversely pins "the gate really does see the sub-second dip
    // the producer cannot": the producer claims 7.5yd (whole seconds), the gate
    // observes 6.0yd (half seconds).
    // The criterion is claim < gateMin − max(3, 0.25·claim), so for a 3.5yd
    // claim:
    //   gateMin = 6.0 (the gate's fine grid) → 3.5 < 3.0 is false → pass;
    //   gateMin = 7.5 (if the gate degraded to whole seconds) → 3.5 < 4.5 is
    //   true → violation.
    // So "3.5 passes" is equivalent to asserting gateMin < producerClaim, i.e.
    // the two sides really are parameterized differently.
    expect(trained[0].distanceYards).toBe(7.5);
    expect(
      positioningScan.checkGeoClaims(
        [{ ...trained[0], distanceYards: 3.5 }],
        trainedCtx(),
      ).violations,
    ).toEqual([]);
  });

  it("反向对照:用错窗口采样出的 closest 会被门规抓住", () => {
    // In the fixture the healer is camped to a closest 6.0yd (sub-second)
    // during 0:10–0:31, and only truly camped to 1yd during 0:40–0:51.
    // Pinning the later segment's closest distance onto the earlier one is
    // exactly the shape of "sampled the wrong window".
    const { claims } = positioningScan.extractGeoClaims(
      healerTrainedFixture().lines.join("\n"),
    );
    const trained = claims.filter((c) => c.kind === "TRAINED");
    const wrongWindow = {
      ...trained[0],
      distanceYards: trained[1].distanceYards,
    };
    const violations = positioningScan.checkGeoClaims(
      [wrongWindow],
      trainedCtx(),
    ).violations;
    expect(violations.map((v) => v.code)).toEqual(["G2_TRAINED_DISTANCE"]);
  });

  it("HP 查询时刻先归渲染网格,同秒才不会出现两个 HP", () => {
    // toRenderSecond IS fmtTime's rounding rule — as long as both render paths
    // snap to the grid first, a single displayed second can only have one
    // sample instant (the premise of the same-second HP gate).
    for (const t of [0, 0.4, 7.9, 42.4, 59.999, 60, 125.5]) {
      expect(cooldowns.fmtTime(t)).toBe(
        cooldowns.fmtTime(cooldowns.toRenderSecond(t)),
      );
    }
  });
});
