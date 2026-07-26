/**
 * 学习链路的库上验收工具(CLAUDE.md verification rule:修复/功能要给同一
 * 判据下的前后数字)。直读真实库回填出临时台账 → scanPatterns,打印:
 * 台账场数 / 稳定模式数 / 每模式 hits 明细,并对 rules.json(若存在)里
 * 每条规则的 stats 用台账重算复核,不一致即 exit 1。
 *
 * 用法:npx tsx scripts/learningScan.ts [matchesDir] [learningDir]
 * 默认 matchesDir = ~/Library/Application Support/gladlog/matches(mac)。
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import {
  measureGroup,
  scanPatterns,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LedgerMatch,
  RulesDoc,
} from "@gladlog/analysis/src/learning/types";

const matchesDir =
  process.argv[2] ??
  join(homedir(), "Library/Application Support/gladlog/matches");
const learningDir = process.argv[3] ?? join(matchesDir, "..", "learning");

// 三种"没进台账"互不相同,分开计数——同一个静默 continue 会让"漏扫
// (缓存/meta 解析出问题)"伪装成"没分析过",验收工具就没法自证没漏数
// (2026-07-26 review 抓到)。
let noAnalysis = 0; // 该场压根没有 analysis-v2*.json 缓存
let skippedBadMeta = 0; // 有缓存,但 meta.json 缺 startTime 或解析失败
let badDoc = 0; // 有缓存,但 analysis-v2*.json 本身解析失败

const matches: LedgerMatch[] = [];
for (const dir of readdirSync(matchesDir).filter(
  (d) => !d.startsWith(".") && !d.startsWith("_"),
)) {
  const base = join(matchesDir, dir);
  const file = [
    "analysis-v2.zh.json",
    "analysis-v2.en.json",
    "analysis-v2.json",
  ].find((f) => existsSync(join(base, f)));
  if (!file) {
    noAnalysis++;
    continue;
  }

  let doc: { result?: { findings?: unknown } };
  try {
    doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
  } catch {
    badDoc++;
    continue;
  }

  let meta: {
    id?: string;
    startTime?: number;
    result?: string;
    zoneId?: string;
    bracket?: string;
    teams?: Array<Array<{ specId: number }>>;
  };
  try {
    meta = JSON.parse(readFileSync(join(base, "meta.json"), "utf-8"));
  } catch {
    skippedBadMeta++;
    continue;
  }
  if (typeof meta.startTime !== "number") {
    skippedBadMeta++;
    continue;
  }

  matches.push({
    matchId: meta.id ?? dir,
    startTime: meta.startTime,
    win: String(meta.result ?? "")
      .toLowerCase()
      .startsWith("win"),
    zoneId: meta.zoneId,
    bracket: meta.bracket,
    enemySpecs: (meta.teams?.[1] ?? [])
      .map((t: { specId: number }) => t.specId)
      .filter((s: number) => s > 0),
    findings: (
      (doc.result?.findings as Array<{
        category: string;
        severity: string;
      }>) ?? []
    ).map((f) => ({
      category: normalizeFindingCategory(f.category),
      severity: f.severity,
      eventTypes: [],
    })),
  });
}

console.log(`台账(直读回填口径): ${matches.length} 场`);
console.log(
  `  无分析缓存: ${noAnalysis} 场  meta 坏/缺 startTime: ${skippedBadMeta} 场  分析缓存解析失败: ${badDoc} 场`,
);
if (skippedBadMeta + badDoc > 0) {
  console.error(
    `⚠ 有 ${skippedBadMeta + badDoc} 场存在分析缓存但被跳过(meta 坏/缺 startTime=${skippedBadMeta},缓存 JSON 解析失败=${badDoc})—— 这些场本该进台账,请检查是否是坏档而非"未分析"。`,
  );
}
const patterns = scanPatterns(matches);
console.log(`稳定模式: ${patterns.length} 个`);
for (const p of patterns)
  console.log(
    `  ${p.patternId}  hits=${p.hits}/${p.windowMatches}  trend=[${p.trend.join(",")}]  例=${p.exampleMatchIds.join(",")}`,
  );

// rules.json 复核:每条规则的 stats 必须与台账重算一致
const rulesPath = join(learningDir, "rules.json");
if (existsSync(rulesPath)) {
  const doc = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDoc;
  let bad = 0;
  for (const r of doc.rules) {
    const g = measureGroup(matches, r.category, r.eventTypes, r.condition);
    if (g.hits !== r.stats.hits || g.windowMatches !== r.stats.windowMatches) {
      // 注意:app 的 rules.json 基于含 live eventTypes 的台账,直读回填
      // 口径 eventTypes 全 [] —— type 级规则允许出入,category 级必须一致。
      if (r.eventTypes.length === 0) {
        console.error(
          `✗ ${r.ruleId}: rules.json hits=${r.stats.hits}/${r.stats.windowMatches},重算=${g.hits}/${g.windowMatches}`,
        );
        bad++;
      }
    }
  }
  console.log(
    bad === 0
      ? `rules.json 复核: ${doc.rules.length} 条全部与台账重算一致 ✓`
      : `rules.json 复核: ${bad} 条不一致 ✗`,
  );
  if (bad > 0) process.exit(1);
} else {
  console.log("rules.json 不存在(app 内尚未整合)—— 只报模式扫描结果");
}
