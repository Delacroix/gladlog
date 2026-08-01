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
import * as dpsMetrics from "@gladlog/analysis/src/utils/dpsMetrics";
import * as losAnalysis from "@gladlog/analysis/src/utils/losAnalysis";
import * as positionAnalysis from "@gladlog/analysis/src/utils/positionAnalysis";
import * as positionSampling from "@gladlog/analysis/src/utils/positionSampling";
import * as stats from "@gladlog/analysis/src/utils/stats";
import { readFileSync } from "fs";
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
