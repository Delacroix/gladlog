/**
 * 谓词索引防腐测试 —— `docs/predicate-index.md` 可执行的另一半。
 *
 * 为什么存在:CLAUDE.md 的门规谓词即规范要求「同一个事实用同一个谓词」,并给出
 * 兜底做法「谓词放一处 export、两边 import;做不到时写断言相等的单测,别靠注释」。
 * 2026-08-01 的教训是缺的不是规矩而是索引 —— 同一个人读过规矩,仍在一天里手抄了
 * 「已知场次」判据和 dateKey 格式化两处谓词。索引文档负责让人查得到,这个测试负责
 * 让文档不腐烂:
 *
 *  1. 文档里列出的每个 export 必须真的存在(按**文件路径** import,改名/挪窝即红);
 *  2. 中英两版必须列出**同一批**谓词,且与本文件的清单逐条一致(三方互钉,任一处
 *     漏改就挂);
 *  3. 无法共享 export 的配对,直接断言相等 —— 这正是 CLAUDE.md 的备选办法;
 *  4. 「分析产出 X、门规验证 X」的互逆关系端到端跑一遍,每条配反向对照,防空转。
 */
import * as candidateFindings from "@gladlog/analysis/src/analysis/candidateFindings";
import * as factFormat from "@gladlog/analysis/src/analysis/factFormat";
import * as findingCategories from "@gladlog/analysis/src/analysis/findingCategories";
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

// corpus-tools 的 package.json 有 `exports: { "." : ... }`,深层 import 会被拒,
// 所以按相对路径引 —— 索引表列的是文件,测试就必须钉在那个文件上。
import * as archiveLedger from "../../corpus-tools/src/archiveLedger";
import * as archivePlan from "../../corpus-tools/src/archivePlan";
import * as pvpLogFetch from "../../corpus-tools/src/pvpLogFetch";
import * as abCompareStats from "../src/ab/abCompareStats";
import * as checkScoreProvenance from "../src/provenance/checkScoreProvenance";
import * as positioningScan from "../src/quality/positioningScan";
import * as promptQualityCheck from "../src/quality/promptQualityCheck";

type Namespace = Record<string, unknown>;

interface PredicateRow {
  /** 权威谓词所在文件(仓库相对路径),必须与索引表第二列逐字相同。 */
  file: string;
  /** export 名。 */
  symbol: string;
  /** 该文件的 module namespace —— 存在性就在这上面查。 */
  mod: Namespace;
}

const A = "packages/analysis/src";
const E = "packages/eval/src";
const C = "packages/corpus-tools/src";

/**
 * 索引表的机读副本。改这里必须同步改 `docs/predicate-index.md` 与
 * `docs/predicate-index.zh-CN.md`,反之亦然 —— 下面的三方一致性用例会盯着。
 */
const INDEX: PredicateRow[] = [
  // 时间与渲染网格
  { file: `${A}/utils/cooldowns.ts`, symbol: "fmtTime", mod: cooldowns },
  { file: `${A}/utils/cooldowns.ts`, symbol: "toRenderSecond", mod: cooldowns },
  {
    file: `${A}/utils/cooldowns.ts`,
    symbol: "renderedWindowSeconds",
    mod: cooldowns,
  },
  // HP 采样
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
  // 冷却可用性
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
  // 位置与几何
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
  // 次序统计量
  { file: `${A}/utils/stats.ts`, symbol: "toSortedFinite", mod: stats },
  { file: `${A}/utils/stats.ts`, symbol: "medianFinite", mod: stats },
  // 阈值
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
  // 分类与名表
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
  // 格式化与记号
  {
    file: `${A}/compare/claimChecker.ts`,
    symbol: "PLACEHOLDER",
    mod: claimChecker,
  },
  {
    file: `${A}/analysis/factFormat.ts`,
    symbol: "fmtFactNum",
    mod: factFormat,
  },
  // 门规侧
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
  // 语料归档
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
];

const rowKey = (r: { file: string; symbol: string }): string =>
  `${r.file} → ${r.symbol}`;

const REPO_ROOT = join(__dirname, "../../..");
const readRepo = (p: string): string =>
  readFileSync(join(REPO_ROOT, p), "utf8");

/** packages/eval 下所有 .ts 源文件(仓库相对路径,排除 test 夹具)。 */
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
// HEALER_TRAINED 夹具:产出侧(整秒网格 + INTERP_MAX_GAP_MS)与门规侧
// (整秒 + 真实采样时刻 + 亚秒网格 + LOS_SWEEP_GAP_MS)刻意不同参。
//
// 结论(勿再试图「统一」):门规的时刻集合是产出侧的**严格超集**、gap 也更松,
// 而 getUnitPositionAtTime 的 gap 只管接受/拒绝、不改变插得的值 —— 于是恒有
// gateMin ≤ producerMin,门规的单边判据(只罚「声称得比观测更近」)不是在遮盖
// 差异,而是这个方向关系的正确表达。反过来让产出侧吃门规的 3000ms gap 是错的:
// INTERP_MAX_GAP_MS 是 T3 grounding 守卫,放宽会让跨采样空窗的中段插值复活。
// 夹具把这个方向关系钉成可执行的:整秒恒 7.5yd,半秒下潜到 6.0yd(只有门规看得到)。
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
    if (t >= 40 && t <= 50) return 1; // 真贴脸段
    if (t < 10 || t > 30) return 40; // 没在贴
    return Number.isInteger(t) ? 7.5 : 6; // 整秒 7.5,半秒 6.0
  });

/** 产出侧跑真的 computeOwnerPositionEvents,再经真的 formatter 渲染成 prompt 行。 */
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
/** 索引表单元格的形状:`路径` → `符号`。表外的正文一律不参与匹配。 */
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
      // 按文件路径查:符号换了文件,索引就指错了地方,这里必须红。
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
    // 顺序一起钉:两版分节结构必须等价,否则「内容等价」只是口号。
    expect(docRowKeys(ZH)).toEqual(docRowKeys(EN));
  });

  it("文档列出的谓词与本测试的清单逐条相同", () => {
    expect(docRowKeys(EN).sort()).toEqual(INDEX.map(rowKey).sort());
  });
});

describe("谓词索引:无法共享 export 的配对,断言相等", () => {
  it("门规的 LoS 容差仍由分析侧 export 派生,不是手抄的字面量", () => {
    // TIME_SLACK_SECONDS / POSITION_MAX_GAP_MS 是 positioningScan.ts 的私有别名,
    // import 不到,只能钉住派生式本身 —— 一旦有人改回字面量,这里就红。
    const src = readRepo("packages/eval/src/quality/positioningScan.ts");
    expect(src).toMatch(/const TIME_SLACK_SECONDS = LOS_SWEEP_SLACK_S;/);
    expect(src).toMatch(/const POSITION_MAX_GAP_MS = LOS_SWEEP_GAP_MS;/);
    // 反向对照:两个 gap 常量刻意不等,别因为都叫 gap 就合并。
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
    // 反向对照:射程与「复算距离可信上限」刻意不等 —— 三处曾各写一个数
    // (40 / 45 / 50),别因为都自称「CC 最大距离」就合并成一个。
    expect(positionSampling.CC_MAX_CAST_RANGE_YARDS).not.toBe(
      positionSampling.CC_MAX_PLAUSIBLE_RANGE_YARDS,
    );
    // 顺序关系由派生式结构性保证(可信上限 = 射程 + 观测宽容量),这里只钉方向。
    expect(positionSampling.CC_MAX_CAST_RANGE_YARDS).toBeLessThan(
      positionSampling.CC_MAX_PLAUSIBLE_RANGE_YARDS,
    );
  });

  it("makeRng 与 IndexEntry 在 packages/eval 里各只有一处声明", () => {
    // 类型在编译期被擦除,运行时没法「import 同一个对象」来证明单源;能钉的是
    // 「树里只有一处声明」。两者都被手抄过(RNG 抄进校准集构建、IndexEntry 抄了
    // 四份且只有权威那份带 ownerName)。
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

    // 反向对照:按原始小数秒四舍五入标注时长,门规必须抓到 —— 证明上面不是空转。
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

    // 反向对照:NaN 未剔除时 sort 留下的乱序长这样(2026-07-20 实测形态)。
    expect(
      promptQualityCheck.checkPercentileMonotonicity([
        "Marksmanship Hunter (n=87): p50 214k | p90 65k",
      ]).length,
    ).toBeGreaterThan(0);
  });

  it("HEALER_TRAINED 的 closest 距离,门规零违规(采样刻意不同参,方向由此钉住)", () => {
    const { lines } = healerTrainedFixture();
    const { claims } = positioningScan.extractGeoClaims(lines.join("\n"));
    // 两条 camped 主张都必须被抽出来,否则下面是空转
    const trained = claims.filter((c) => c.kind === "TRAINED");
    expect(trained).toHaveLength(2);
    expect(
      positioningScan.checkGeoClaims(claims, trainedCtx()).violations,
    ).toEqual([]);

    // 上面若两侧采样其实一样,这条用例就是空转。反过来钉住「门规确实看到了产出侧
    // 看不见的亚秒低谷」:产出侧声称 7.5yd(整秒),门规观测到 6.0yd(半秒)。
    // 判据是 claim < gateMin − max(3, 0.25·claim),所以 3.5yd 的主张:
    //   gateMin = 6.0(门规的细网格)→ 3.5 < 3.0 不成立 → 放行;
    //   gateMin = 7.5(若门规退化成整秒)→ 3.5 < 4.5 成立 → 违规。
    // 因此「3.5 放行」等价于断言 gateMin < producerClaim,即两侧采样确实不同参。
    expect(trained[0].distanceYards).toBe(7.5);
    expect(
      positioningScan.checkGeoClaims(
        [{ ...trained[0], distanceYards: 3.5 }],
        trainedCtx(),
      ).violations,
    ).toEqual([]);
  });

  it("反向对照:用错窗口采样出的 closest 会被门规抓住", () => {
    // 夹具里治疗在 0:10–0:31 被贴到最近 6.0yd(亚秒),0:40–0:51 才真贴到 1yd。
    // 把后一段的最近距离安到前一段上 —— 这正是「采样窗口取错」的形状。
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
    // toRenderSecond 是 fmtTime 的取整规则本身 —— 两条渲染路径只要都先归网格,
    // 同一显示秒就只可能有一个采样时刻(同秒 HP 门规的前提)。
    for (const t of [0, 0.4, 7.9, 42.4, 59.999, 60, 125.5]) {
      expect(cooldowns.fmtTime(t)).toBe(
        cooldowns.fmtTime(cooldowns.toRenderSecond(t)),
      );
    }
  });
});
