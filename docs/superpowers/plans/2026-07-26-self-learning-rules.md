# Cross-Match Self-Learning (Ledger → Deterministic Filter → AI Distillation → Rules Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist historical AI findings to a local ledger, use deterministic filtering to extract stable patterns, have AI only translate/summarize passing a deterministic audit, and produce rules used for a "Recurring Habit" badge in new matches (without calling AI) and a long-term trends report page.

**Architecture:** Four-layer data flow — when `analysis.run` completes, append one row/run to `userData/learning/ledger.ndjson` (each row is a run containing findings, last-run-wins per matchId); `patternScan` pure function (packages/analysis) filters stable patterns; main side `learning.ts` service calls the model to distill + deterministically audits then writes `rules.json`; renderer uses the same matching predicate to attach badges to audited findings, and StatsDashboard adds a "Long-term Trends" card.

**Tech Stack:** TypeScript, Electron main (fs direct write, no DB), vitest, existing AI client abstractions (`resolveAiClient`/`AnthropicLike`).

**Spec:** `docs/superpowers/specs/2026-07-26-self-learning-rules-design.md` (includes the 2026-07-26 plan phase correction section — cross-match granularity is category + candidate type, not findingKey).

## Global Constraints

- Use `npm run typecheck` (root directory) for type checking, **never `tsc -b`**.
- Before pushing desktop changes: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`.
- The main process **must NEVER import the `@gladlog/analysis` barrel** (top-level await of large tables will drag into main), always use deep path imports (`@gladlog/analysis/src/learning/...`); newly added learning modules in this plan must not import any modules that pull in large tables (only depend on claimChecker/causalLint/findingCategories/types).
- Predicate as specification: windows/thresholds/retirement constants are defined exactly once in `patternScan.ts`, filtering, retirement, badges, and report pages all import the same copy.
- AI output forbids raw numbers, only `{{hits}}`/`{{windowMatches}}` placeholders are allowed; violations drop the entire item. Rule description/advice are stored as **templates** (with placeholders), and rendered using the shared `interpolate` for variable substitution — stat updates do not invalidate text.
- Commits: commit directly to main (repository convention, do not create branches); commit messages must be in Chinese and prefixed with the module name.
- Run tests for the respective package at the end of each Task; for Task 6 onwards involving desktop, run the three pre-push checks before every commit.

---

### Task 1: 学习共享类型 + patternScan 纯函数(packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/types.ts`
- Create: `packages/analysis/src/learning/patternScan.ts`
- Test: `packages/analysis/src/learning/patternScan.test.ts`

**Interfaces:**

- Consumes: 无(纯新增;类型上只引用本文件)。
- Produces(后续 Task 全部依赖,签名精确):
  - 类型 `LedgerRun`, `LedgerMatch`, `LedgerFinding`, `PatternCondition`, `StablePattern`, `GroupStats`, `LearnedRule`, `RulesDoc`(见下方代码)。
  - 常量 `PATTERN_WINDOW_MATCHES=20`, `PATTERN_MIN_HITS=5`, `RULE_RETIRE_MAX_HITS=2`, `TREND_BUCKET_MATCHES=5`, `SLICE_MIN_HITS=4`, `SLICE_RATE_FACTOR=2`。
  - `patternId(category: string, eventTypes: string[], cond: PatternCondition | null): string`
  - `findingMatchesGroup(f: LedgerFinding, category: string, eventTypes: string[]): boolean`
  - `matchInCondition(m: { zoneId?: string; enemySpecs: number[] }, cond: PatternCondition | null): boolean`
  - `measureGroup(all: LedgerMatch[], category: string, eventTypes: string[], condition: PatternCondition | null): GroupStats`
  - `scanPatterns(all: LedgerMatch[]): StablePattern[]`
  - `nextRuleStatus(prev: "active" | "improved", hits: number): "active" | "improved"`

- [ ] **Step 1: 写 types.ts**

```ts
/**
 * 跨对局学习的共享类型(spec: docs/superpowers/specs/2026-07-26-self-learning-rules-design.md)。
 * 台账(desktop main)与筛/提炼/应用(本目录)共用 —— 谓词单源的前提是类型单源。
 *
 * 跨场键是 category(+候选事件 type),**不是 findingKey**:findingKey 含
 * eventIds,那是每场候选的局部 id,跨场永不重复(aggregate() 跨场也只用
 * category,findingKey 只服务单场 flags)。
 */

/** 台账一行 = 一次分析 run(内嵌该场 findings)。同场重分析追加新行,
 * 读取时按 matchId 取 createdAt 最大的一行(last-run-wins,整场替换 ——
 * 逐 finding 后写胜出会让被新一轮放弃的旧 finding 永久残留)。 */
export interface LedgerRun {
  v: 1;
  matchId: string;
  /** 对局开始时间(ms)—— 窗口排序键(meta.json 的 startTime)。 */
  startTime: number;
  win: boolean;
  zoneId?: string;
  bracket?: string;
  /** 敌方专精 id(meta.teams[1]);旧档缺 teams 时 []。 */
  enemySpecs: number[];
  /** 只记录不作废:学习记忆与 prompt 缓存失效解耦(spec §1)。 */
  promptVersion: number;
  createdAt: number;
  findings: LedgerFinding[];
}

export interface LedgerFinding {
  /** 已过 normalizeFindingCategory 的 slug(写入侧保证)。 */
  category: string;
  severity: string;
  /** finding 引用的候选事件 type 去重升序(live 写入时有;回填旧场为 [])。 */
  eventTypes: string[];
}

/** 台账归并后的对局视图 = LedgerRun 去掉信封字段;scan/统计的输入。 */
export type LedgerMatch = Omit<LedgerRun, "v" | "promptVersion" | "createdAt">;

export interface PatternCondition {
  enemySpec?: number;
  zoneId?: string;
}

export interface GroupStats {
  /** 实际窗口大小(min(符合条件的对局数, PATTERN_WINDOW_MATCHES))。 */
  windowMatches: number;
  hits: number;
  /** 全历史(不限窗口)首/末命中对局的 startTime;无命中时 0。 */
  firstSeen: number;
  lastSeen: number;
  /** 窗口内按 TREND_BUCKET_MATCHES 场分桶的命中数,旧→新。 */
  trend: number[];
  /** 窗口内最近命中的对局 id,新→旧,≤3 —— 提炼实例与 UI 证据链。 */
  exampleMatchIds: string[];
  /** 命中是否横跨窗口新旧两半(排除一波连败尖峰)。 */
  spansBothHalves: boolean;
}

export interface StablePattern {
  /** 确定性 id,同时用作 ruleId:cat:<c>[|type:<t>][|spec:<id>][|zone:<id>] */
  patternId: string;
  category: string;
  /** [] = category 级;["death"] = category+type 级(单 type)。 */
  eventTypes: string[];
  condition: PatternCondition | null;
  windowMatches: number;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  trend: number[];
  exampleMatchIds: string[];
}

export interface LearnedRule {
  ruleId: string;
  status: "active" | "improved";
  category: string;
  eventTypes: string[];
  condition: PatternCondition | null;
  stats: {
    windowMatches: number;
    hits: number;
    firstSeen: number;
    lastSeen: number;
    trend: number[];
  };
  /** 模板文本(含 {{hits}}/{{windowMatches}} 占位符),渲染时插值。
   * 缺当前语言 → UI 用确定性兜底(category 标签 + stats),下轮整合懒补。 */
  description: { zh?: string; en?: string };
  advice: { zh?: string; en?: string };
  evidence: string[];
  distilledAt: number;
  distillModel: string;
}

export interface RulesDoc {
  schemaVersion: 1;
  updatedAt: number;
  /** 上次整合时台账覆盖的对局数 —— 增量自动触发的判据。 */
  ledgerMatches: number;
  rules: LearnedRule[];
}
```

- [ ] **Step 2: 写 patternScan.test.ts(失败测试)**

```ts
import { describe, expect, it } from "vitest";

import {
  matchInCondition,
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  patternId,
  RULE_RETIRE_MAX_HITS,
  scanPatterns,
} from "./patternScan";
import type { LedgerMatch } from "./types";

/** i 越大越新;hit=true 时带一条 survival finding。 */
const mk = (
  i: number,
  hit: boolean,
  opts: { type?: string; enemySpecs?: number[]; zoneId?: string } = {},
): LedgerMatch => ({
  matchId: `m${i}`,
  startTime: 1_000_000 + i * 60_000,
  win: false,
  zoneId: opts.zoneId,
  enemySpecs: opts.enemySpecs ?? [],
  findings: hit
    ? [
        {
          category: "survival",
          severity: "high",
          eventTypes: opts.type ? [opts.type] : [],
        },
      ]
    : [],
});

describe("patternId", () => {
  it("确定性拼接,type 升序、条件按 spec→zone", () => {
    expect(patternId("survival", ["death"], { enemySpec: 62 })).toBe(
      "cat:survival|type:death|spec:62",
    );
    expect(patternId("cooldowns", [], null)).toBe("cat:cooldowns");
  });
});

describe("scanPatterns 稳定判定", () => {
  it("窗口内 5 命中且横跨两半 → 产出;4 命中 → 不产出", () => {
    // 20 场,命中分布在 i=1,5,10,15,19(横跨两半)
    const hits = new Set([1, 5, 10, 15, 19]);
    const m5 = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m5).some((p) => p.patternId === "cat:survival")).toBe(
      true,
    );
    const m4 = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i) && i !== 10),
    );
    expect(scanPatterns(m4)).toEqual([]);
  });

  it("命中挤在窗口一半(连败尖峰)→ 不产出", () => {
    const hits = new Set([15, 16, 17, 18, 19]); // 全在最新一半
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("窗口只取最近 20 场:第 21 场以前的命中不算", () => {
    // 30 场,命中全在最老的 10 场 → 窗口(最近 20)内 0 命中
    const m = Array.from({ length: 30 }, (_, i) => mk(i, i < 10));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("type 级完全覆盖 category 级时只出 type 级", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i), { type: "death" }),
    );
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|type:death");
    expect(ids).not.toContain("cat:survival");
  });

  it("条件切片:子集命中率 ≥2× 全集且 ≥4 场 → 额外产出条件模式", () => {
    // 20 场:8 场对法师(spec 62),其中 6 场命中;其余 12 场 0 命中。
    // 全集 6/20=0.3,子集 6/8=0.75 ≥ 2×0.3 ✓
    const m = Array.from({ length: 20 }, (_, i) => {
      const vsMage = i < 8;
      // 命中分布跨两半:i ∈ {0,1,2,5,6,7}
      const hit = vsMage && i !== 3 && i !== 4;
      return mk(i, hit, { enemySpecs: vsMage ? [62] : [71] });
    });
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|spec:62");
  });
});

describe("measureGroup", () => {
  it("trend 按 5 场分桶(旧→新),example 取最近命中 ≤3", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    const g = measureGroup(m, "survival", [], null);
    expect(g.hits).toBe(5);
    expect(g.windowMatches).toBe(20);
    expect(g.trend).toEqual([1, 1, 1, 2]); // 桶[0-4],[5-9],[10-14],[15-19]
    expect(g.exampleMatchIds).toEqual(["m19", "m15", "m10"]);
    expect(g.spansBothHalves).toBe(true);
  });

  it("不足 20 场时窗口取实际场数", () => {
    const m = Array.from({ length: 6 }, (_, i) => mk(i, i % 2 === 0));
    const g = measureGroup(m, "survival", [], null);
    expect(g.windowMatches).toBe(6);
    expect(g.hits).toBe(3);
  });
});

describe("退役/复活谓词(滞回)", () => {
  it("≤RETIRE 退役,≥MIN_HITS 复活,中间保持", () => {
    expect(nextRuleStatus("active", RULE_RETIRE_MAX_HITS)).toBe("improved");
    expect(nextRuleStatus("improved", PATTERN_MIN_HITS)).toBe("active");
    expect(nextRuleStatus("active", 3)).toBe("active");
    expect(nextRuleStatus("improved", 3)).toBe("improved");
  });
});

describe("matchInCondition(应用侧同一谓词)", () => {
  it("null 恒真;enemySpec 要求包含;zoneId 要求相等", () => {
    expect(matchInCondition({ enemySpecs: [] }, null)).toBe(true);
    expect(matchInCondition({ enemySpecs: [62, 71] }, { enemySpec: 62 })).toBe(
      true,
    );
    expect(matchInCondition({ enemySpecs: [71] }, { enemySpec: 62 })).toBe(
      false,
    );
    expect(
      matchInCondition({ zoneId: "1552", enemySpecs: [] }, { zoneId: "1552" }),
    ).toBe(true);
    expect(matchInCondition({ enemySpecs: [] }, { zoneId: "1552" })).toBe(
      false,
    ); // zoneId 未知 → 保守不命中
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/learning/patternScan.test.ts`(cwd `packages/analysis`)
Expected: FAIL(模块不存在)。

- [ ] **Step 4: 写 patternScan.ts 实现**

```ts
/**
 * 确定性筛(spec §2):台账对局视图 → 稳定模式。
 *
 * 谓词即规范:这里的常量与谓词是唯一权威 —— 退役(learning.ts)、徽章
 * (matchRules.ts)、报告页全部 import 本文件,别复制数值。
 */
import type {
  GroupStats,
  LedgerFinding,
  LedgerMatch,
  PatternCondition,
  StablePattern,
} from "./types";

export const PATTERN_WINDOW_MATCHES = 20;
export const PATTERN_MIN_HITS = 5;
export const RULE_RETIRE_MAX_HITS = 2;
export const TREND_BUCKET_MATCHES = 5;
/** 条件切片显著性(spec §2):子集命中 ≥4 且命中率 ≥ 全集 2 倍。 */
export const SLICE_MIN_HITS = 4;
export const SLICE_RATE_FACTOR = 2;

export function patternId(
  category: string,
  eventTypes: string[],
  cond: PatternCondition | null,
): string {
  let id = `cat:${category}`;
  for (const t of [...eventTypes].sort()) id += `|type:${t}`;
  if (cond?.enemySpec !== undefined) id += `|spec:${cond.enemySpec}`;
  if (cond?.zoneId !== undefined) id += `|zone:${cond.zoneId}`;
  return id;
}

/** finding 命中分组:category 相等且分组 type 全部被引用。 */
export function findingMatchesGroup(
  f: LedgerFinding,
  category: string,
  eventTypes: string[],
): boolean {
  if (f.category !== category) return false;
  return eventTypes.every((t) => f.eventTypes.includes(t));
}

/** 对局是否满足条件 —— 筛选与应用(徽章)共用的**同一个**谓词。
 * 条件字段在对局侧未知(如 renderer 拿不到 zoneId)→ 保守判不满足。 */
export function matchInCondition(
  m: { zoneId?: string; enemySpecs: number[] },
  cond: PatternCondition | null,
): boolean {
  if (!cond) return true;
  if (cond.enemySpec !== undefined && !m.enemySpecs.includes(cond.enemySpec))
    return false;
  if (cond.zoneId !== undefined && m.zoneId !== cond.zoneId) return false;
  return true;
}

const hitsIn = (m: LedgerMatch, category: string, eventTypes: string[]) =>
  m.findings.some((f) => findingMatchesGroup(f, category, eventTypes));

export function measureGroup(
  all: LedgerMatch[],
  category: string,
  eventTypes: string[],
  condition: PatternCondition | null,
): GroupStats {
  const eligible = all
    .filter((m) => matchInCondition(m, condition))
    .sort((a, b) => b.startTime - a.startTime); // 新→旧
  const window = eligible.slice(0, PATTERN_WINDOW_MATCHES);
  const hitFlags = window.map((m) => hitsIn(m, category, eventTypes));
  const hits = hitFlags.filter(Boolean).length;

  const half = Math.floor(window.length / 2);
  const newerHits = hitFlags.slice(0, half).some(Boolean);
  const olderHits = hitFlags.slice(half).some(Boolean);

  // trend 旧→新分桶
  const oldFirst = [...window].reverse();
  const trend: number[] = [];
  for (let i = 0; i < oldFirst.length; i += TREND_BUCKET_MATCHES) {
    trend.push(
      oldFirst
        .slice(i, i + TREND_BUCKET_MATCHES)
        .filter((m) => hitsIn(m, category, eventTypes)).length,
    );
  }

  const allHits = eligible.filter((m) => hitsIn(m, category, eventTypes));
  return {
    windowMatches: window.length,
    hits,
    firstSeen: allHits.length
      ? Math.min(...allHits.map((m) => m.startTime))
      : 0,
    lastSeen: allHits.length ? Math.max(...allHits.map((m) => m.startTime)) : 0,
    trend,
    exampleMatchIds: window
      .filter((_, i) => hitFlags[i])
      .slice(0, 3)
      .map((m) => m.matchId),
    spansBothHalves: newerHits && olderHits,
  };
}

/** 退役/复活(spec §5):滞回 —— 阈值间空档保持现状,防边界抖动。 */
export function nextRuleStatus(
  prev: "active" | "improved",
  hits: number,
): "active" | "improved" {
  if (hits <= RULE_RETIRE_MAX_HITS) return "improved";
  if (hits >= PATTERN_MIN_HITS) return "active";
  return prev;
}

const qualifies = (g: GroupStats) =>
  g.hits >= PATTERN_MIN_HITS && g.spansBothHalves;

export function scanPatterns(all: LedgerMatch[]): StablePattern[] {
  if (all.length === 0) return [];
  const window = [...all]
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, PATTERN_WINDOW_MATCHES);

  // 候选分组域:窗口内出现过的 category 与 category+type
  const cats = new Set<string>();
  const typesByCat = new Map<string, Set<string>>();
  for (const m of window)
    for (const f of m.findings) {
      cats.add(f.category);
      const s = typesByCat.get(f.category) ?? new Set<string>();
      for (const t of f.eventTypes) s.add(t);
      typesByCat.set(f.category, s);
    }

  const out: StablePattern[] = [];
  const emit = (
    category: string,
    eventTypes: string[],
    condition: PatternCondition | null,
    g: GroupStats,
  ) =>
    out.push({
      patternId: patternId(category, eventTypes, condition),
      category,
      eventTypes,
      condition,
      windowMatches: g.windowMatches,
      hits: g.hits,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      trend: g.trend,
      exampleMatchIds: g.exampleMatchIds,
    });

  // 条件切片域:窗口内出现过的敌方 spec / zoneId
  const specs = new Set<number>();
  const zones = new Set<string>();
  for (const m of window) {
    for (const s of m.enemySpecs) specs.add(s);
    if (m.zoneId) zones.add(m.zoneId);
  }
  const emitSlices = (
    category: string,
    eventTypes: string[],
    base: GroupStats,
  ) => {
    const baseRate = base.windowMatches ? base.hits / base.windowMatches : 0;
    const conds: PatternCondition[] = [
      ...[...specs].map((s) => ({ enemySpec: s })),
      ...[...zones].map((z) => ({ zoneId: z })),
    ];
    for (const cond of conds) {
      const g = measureGroup(all, category, eventTypes, cond);
      const rate = g.windowMatches ? g.hits / g.windowMatches : 0;
      if (
        g.hits >= SLICE_MIN_HITS &&
        g.spansBothHalves &&
        rate >= SLICE_RATE_FACTOR * baseRate
      )
        emit(category, eventTypes, cond, g);
    }
  };

  for (const cat of cats) {
    const catStats = measureGroup(all, cat, [], null);
    const typeStats = [...(typesByCat.get(cat) ?? [])].map((t) => ({
      t,
      g: measureGroup(all, cat, [t], null),
    }));
    const qualifyingTypes = typeStats.filter(({ g }) => qualifies(g));
    for (const { t, g } of qualifyingTypes) {
      emit(cat, [t], null, g);
      emitSlices(cat, [t], g);
    }
    // category 级只在比最好的 type 级多带信息(命中更多)时才出,避免
    // 「survival」与「survival+death」100% 重合的双规则。
    const bestType = Math.max(0, ...qualifyingTypes.map(({ g }) => g.hits));
    if (qualifies(catStats) && catStats.hits > bestType) {
      emit(cat, [], null, catStats);
      emitSlices(cat, [], catStats);
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/learning/patternScan.test.ts`(cwd `packages/analysis`)
Expected: PASS 全绿。注意条件切片测试若失败,先核对测试里构造的命中分布是否真跨两半(条件子集自己的窗口重新算半分)。

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/learning/
git commit -m "feat(analysis): 跨对局学习之确定性筛 —— patternScan 纯函数 + 谓词单源常量"
```

---

### Task 2: AI 提炼 prompt + 确定性审计(packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/distillRules.ts`
- Test: `packages/analysis/src/learning/distillRules.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `StablePattern`;既有 `claimChecker`/`interpolate`(`../compare/claimChecker`)、`causalLint`(`../analysis/causalLint`)。
- Produces:
  - `distillFacts(p: { hits: number; windowMatches: number }): Record<string, string>` — 占位符事实表 `{hits, windowMatches}`。
  - `buildDistillPrompt(patterns: StablePattern[], examples: Record<string, string[]>, lang: "zh" | "en"): string`
  - `auditDistilledRules(parsed: unknown[] | null, patterns: StablePattern[]): { texts: Array<{ patternId: string; description: string; advice: string }>; dropped: Array<{ patternId?: string; reason: string }> }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";

import {
  auditDistilledRules,
  buildDistillPrompt,
  distillFacts,
} from "./distillRules";
import type { StablePattern } from "./types";

const pat = (id: string): StablePattern => ({
  patternId: id,
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  windowMatches: 20,
  hits: 9,
  firstSeen: 1,
  lastSeen: 2,
  trend: [2, 3, 2, 2],
  exampleMatchIds: ["m1"],
});

describe("auditDistilledRules", () => {
  const patterns = [pat("cat:survival|type:death")];

  it("合规条目通过;占位符能被 distillFacts 插值", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description:
            "近 {{windowMatches}} 场里有 {{hits}} 场存在阵亡类问题。",
          advice: "开大前先看治疗蓝量。",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
    expect(distillFacts(patterns[0]!)).toEqual({
      hits: "9",
      windowMatches: "20",
    });
  });

  it("裸数字 → 丢弃", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "近 20 场里有 9 场存在阵亡类问题。",
          advice: "ok",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/digit/);
  });

  it("未知 patternId / 未知占位符 / 因果断言 → 丢弃;null 输入 → 全空", () => {
    const bad = auditDistilledRules(
      [
        { patternId: "cat:nope", description: "x", advice: "y" },
        {
          patternId: "cat:survival|type:death",
          description: "{{deaths}} 次阵亡",
          advice: "y",
        },
      ],
      patterns,
    );
    expect(bad.texts).toHaveLength(0);
    expect(bad.dropped).toHaveLength(2);
    expect(auditDistilledRules(null, patterns).texts).toHaveLength(0);
  });

  it("同 patternId 重复条目:first-wins", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "第一条",
          advice: "a",
        },
        {
          patternId: "cat:survival|type:death",
          description: "第二条",
          advice: "b",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]!.description).toBe("第一条");
  });
});

describe("buildDistillPrompt", () => {
  it("包含 pattern 数据、实例、硬规则与语言指令", () => {
    const p = buildDistillPrompt(
      [pat("cat:survival|type:death")],
      { "cat:survival|type:death": ["死于集火时没开减伤。"] },
      "zh",
    );
    expect(p).toContain("cat:survival|type:death");
    expect(p).toContain("{{hits}}");
    expect(p).toContain("死于集火时没开减伤。");
    expect(p).toContain("Simplified Chinese");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/learning/distillRules.test.ts`(cwd `packages/analysis`)
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
/**
 * AI 提炼(spec §3):稳定模式 → 规则文本。AI 只做「翻译成人话 + 归纳」,
 * 不允许发明事实 —— 审计沿用 findings 的占位符纪律:文本禁裸数字,唯二
 * 合法数字是 {{hits}}/{{windowMatches}},渲染时由代码从 stats 插值。
 */
import { claimChecker } from "../compare/claimChecker";
import { causalLint } from "../analysis/causalLint";
import type { StablePattern } from "./types";

export function distillFacts(p: {
  hits: number;
  windowMatches: number;
}): Record<string, string> {
  return { hits: String(p.hits), windowMatches: String(p.windowMatches) };
}

export function buildDistillPrompt(
  patterns: StablePattern[],
  examples: Record<string, string[]>,
  lang: "zh" | "en",
): string {
  const data = patterns.map((p) => ({
    patternId: p.patternId,
    category: p.category,
    eventTypes: p.eventTypes,
    condition: p.condition,
    hits: p.hits,
    windowMatches: p.windowMatches,
    exampleFindings: examples[p.patternId] ?? [],
  }));
  const language =
    lang === "zh"
      ? "Write description/advice in Simplified Chinese. Keep spell/ability names in English."
      : "Write description/advice in English.";
  return [
    "You are summarizing a player's RECURRING habits across many arena matches.",
    "Each pattern below was found by deterministic statistics over past AI findings.",
    "For EACH pattern, write a short description of the habit and one actionable training advice.",
    "",
    "PATTERNS (JSON):",
    JSON.stringify(data, null, 1),
    "",
    "HARD RULES:",
    '1. Output ONLY a JSON array: [{"patternId": "...", "description": "...", "advice": "..."}]. No prose, no markdown fence.',
    "2. patternId MUST be copied verbatim from the patterns above. Exactly one object per pattern.",
    "3. NEVER write a bare number. The ONLY numbers allowed are the literal placeholders {{hits}} and {{windowMatches}}.",
    "4. Ground every statement ONLY in the given stats and exampleFindings. Do not invent events, spells, or reasons.",
    '5. No causal certainty ("caused", "because you died"); use hedged phrasing ("tends to", "often coincides with").',
    `6. ${language}`,
  ].join("\n");
}

export function auditDistilledRules(
  parsed: unknown[] | null,
  patterns: StablePattern[],
): {
  texts: Array<{ patternId: string; description: string; advice: string }>;
  dropped: Array<{ patternId?: string; reason: string }>;
} {
  const texts: Array<{
    patternId: string;
    description: string;
    advice: string;
  }> = [];
  const dropped: Array<{ patternId?: string; reason: string }> = [];
  if (!Array.isArray(parsed)) return { texts, dropped };
  const byId = new Map(patterns.map((p) => [p.patternId, p]));
  const seen = new Set<string>();

  for (const item of parsed) {
    const o = item as {
      patternId?: unknown;
      description?: unknown;
      advice?: unknown;
    };
    if (
      typeof o?.patternId !== "string" ||
      typeof o?.description !== "string" ||
      typeof o?.advice !== "string"
    ) {
      dropped.push({ reason: "shape: missing patternId/description/advice" });
      continue;
    }
    const p = byId.get(o.patternId);
    if (!p) {
      dropped.push({ patternId: o.patternId, reason: "unknown patternId" });
      continue;
    }
    if (seen.has(o.patternId)) {
      dropped.push({ patternId: o.patternId, reason: "duplicate patternId" });
      continue;
    }
    const facts = distillFacts(p);
    const bad = ["description", "advice"]
      .map((field) => {
        const text = field === "description" ? o.description : o.advice;
        const check = claimChecker(text as string, facts);
        if (!check.ok)
          return `${field} numeric: ${check.violations.join("; ")}`;
        // auditFindings 同款加严:剥占位符与 2v2/3v3 后不许残留任何数字
        const prose = (text as string)
          .replace(/\{\{\s*[\w.]+\s*\}\}/g, " ")
          .replace(/\b\d+v\d+\b/gi, " ");
        if (/\d/.test(prose)) return `${field}: raw digit outside placeholder`;
        const causal = causalLint(text as string);
        if (causal.length > 0) return `${field} causal: ${causal.join("; ")}`;
        return null;
      })
      .filter((x): x is string => x !== null);
    if (bad.length > 0) {
      dropped.push({ patternId: o.patternId, reason: bad.join(" | ") });
      continue;
    }
    seen.add(o.patternId);
    texts.push({
      patternId: o.patternId,
      description: o.description,
      advice: o.advice,
    });
  }
  return { texts, dropped };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/learning/distillRules.test.ts`(cwd `packages/analysis`)
Expected: PASS。若 causalLint 测试误伤中文措辞,查看 `causalLint.ts` 的词表再调测试文案(不要放松审计)。

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src/learning/distillRules.ts packages/analysis/src/learning/distillRules.test.ts
git commit -m "feat(analysis): 学习规则的 AI 提炼 prompt + 占位符纪律审计"
```

---

### Task 3: 规则应用谓词 + 徽章文本(packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/matchRules.ts`
- Test: `packages/analysis/src/learning/matchRules.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `findingMatchesGroup`/`matchInCondition`/`LearnedRule`;既有 `CandidateEvent`/`Finding`(`../analysis/types`)。
- Produces(renderer 与测试依赖):
  - `ruleAppliesToFinding(rule: LearnedRule, finding: Pick<Finding, "category" | "eventIds">, candidates: CandidateEvent[], meta: { zoneId?: string; enemySpecs: number[] }): boolean`
  - `habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string` — 确定性文本,数字来自 stats,非 AI。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";

import type { CandidateEvent } from "../analysis/types";
import { habitBadgeText, ruleAppliesToFinding } from "./matchRules";
import type { LearnedRule } from "./types";

const rule = (over: Partial<LearnedRule> = {}): LearnedRule => ({
  ruleId: "cat:survival|type:death",
  status: "active",
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  stats: { windowMatches: 20, hits: 9, firstSeen: 1, lastSeen: 2, trend: [] },
  description: {},
  advice: {},
  evidence: [],
  distilledAt: 0,
  distillModel: "",
  ...over,
});

const cands: CandidateEvent[] = [
  { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
  { id: "e2", type: "cd-waste", t: 0, unitNames: ["A"], facts: {} },
];
const meta = { enemySpecs: [62] };

describe("ruleAppliesToFinding", () => {
  it("category+type 命中 → true;type 不匹配 → false", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(ruleAppliesToFinding(rule(), f, cands, meta)).toBe(true);
    expect(
      ruleAppliesToFinding(
        rule(),
        { category: "survival", eventIds: ["e2"] },
        cands,
        meta,
      ),
    ).toBe(false);
  });

  it("improved 规则不打徽章;条件不满足不打", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(
      ruleAppliesToFinding(rule({ status: "improved" }), f, cands, meta),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 71 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 62 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(true);
  });

  it("category 级规则(eventTypes=[])对同类 finding 恒命中", () => {
    const f = { category: "survival", eventIds: ["e2"] };
    expect(ruleAppliesToFinding(rule({ eventTypes: [] }), f, cands, meta)).toBe(
      true,
    );
  });
});

describe("habitBadgeText", () => {
  it("确定性、双语、数字来自 stats", () => {
    expect(habitBadgeText(rule(), "zh")).toBe("惯性问题 · 近 20 场已犯 9 次");
    expect(habitBadgeText(rule(), "en")).toBe(
      "Recurring · 9 of last 20 matches",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/learning/matchRules.test.ts`(cwd `packages/analysis`)
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
/**
 * 规则应用(spec §4):新对局的审计后 findings 上确定性匹配规则,不调 AI。
 * 匹配谓词与 patternScan 同源(findingMatchesGroup / matchInCondition)——
 * 「筛出来的模式」与「打上徽章的 finding」必须是同一个判定。
 */
import type { CandidateEvent, Finding } from "../analysis/types";
import { findingMatchesGroup, matchInCondition } from "./patternScan";
import type { LearnedRule } from "./types";

export function ruleAppliesToFinding(
  rule: LearnedRule,
  finding: Pick<Finding, "category" | "eventIds">,
  candidates: CandidateEvent[],
  meta: { zoneId?: string; enemySpecs: number[] },
): boolean {
  if (rule.status !== "active") return false;
  if (!matchInCondition(meta, rule.condition)) return false;
  const byId = new Map(candidates.map((c) => [c.id, c.type]));
  const eventTypes = [
    ...new Set(
      (finding.eventIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is string => !!t),
    ),
  ];
  return findingMatchesGroup(
    { category: finding.category, severity: "", eventTypes },
    rule.category,
    rule.eventTypes,
  );
}

/** 徽章文本:纯 stats 插值,不经过任何模型。「已犯 N 次」是历史事实陈述,
 * 不写「第 N+1 次」—— 后者对本场是断言,须由统计而非渲染层保证。 */
export function habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string {
  const { windowMatches, hits } = rule.stats;
  return lang === "zh"
    ? `惯性问题 · 近 ${windowMatches} 场已犯 ${hits} 次`
    : `Recurring · ${hits} of last ${windowMatches} matches`;
}
```

- [ ] **Step 4: 跑测试确认通过;顺跑全包测试**

Run: `npm test --workspace=packages/analysis`
Expected: PASS(含 Task 1/2 的测试)。

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src/learning/matchRules.ts packages/analysis/src/learning/matchRules.test.ts
git commit -m "feat(analysis): 规则应用谓词(与 patternScan 同源)+ 惯性徽章文本"
```

---

### Task 4: 学习台账 learningLedger(desktop main)

**Files:**

- Create: `packages/desktop/src/main/learningLedger.ts`
- Test: `packages/desktop/src/main/learningLedger.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LedgerRun`/`LedgerMatch` 类型(深路径 `@gladlog/analysis/src/learning/types`,类型 only,不拉大表)。
- Produces(Task 5 依赖):
  - `createLearningLedger(learningDir: string): LearningLedger`
  - `type LearningLedger = { file: string; append(runs: LedgerRun[]): void; read(): { matches: LedgerMatch[]; badLines: number; totalLines: number }; compact(): void }`
  - `read()` 语义:按 matchId 取 createdAt 最大的一行;坏行跳过计数;matches 无序(排序归 patternScan)。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import type { LedgerRun } from "@gladlog/analysis/src/learning/types";
import { createLearningLedger } from "./learningLedger";

const run = (
  matchId: string,
  createdAt: number,
  cat = "survival",
): LedgerRun => ({
  v: 1,
  matchId,
  startTime: 1000,
  win: false,
  enemySpecs: [62],
  promptVersion: 12,
  createdAt,
  findings: [{ category: cat, severity: "high", eventTypes: ["death"] }],
});

const fresh = () =>
  createLearningLedger(mkdtempSync(join(tmpdir(), "gl-ledger-")));

describe("learningLedger", () => {
  it("append → read 往返;同场 last-run-wins(整场替换)", () => {
    const l = fresh();
    l.append([run("m1", 100, "survival")]);
    l.append([run("m1", 200, "cooldowns"), run("m2", 150)]);
    const { matches, badLines } = l.read();
    expect(badLines).toBe(0);
    expect(matches).toHaveLength(2);
    const m1 = matches.find((m) => m.matchId === "m1")!;
    expect(m1.findings[0]!.category).toBe("cooldowns"); // 新 run 整场替换
  });

  it("坏行跳过并计数,不影响好行", () => {
    const l = fresh();
    l.append([run("m1", 100)]);
    appendFileSync(l.file, "not json\n{broken\n", "utf-8");
    l.append([run("m2", 100)]);
    const { matches, badLines } = l.read();
    expect(matches).toHaveLength(2);
    expect(badLines).toBe(2);
  });

  it("文件不存在 → 空结果不抛", () => {
    const l = fresh();
    expect(l.read()).toEqual({ matches: [], badLines: 0, totalLines: 0 });
  });

  it("compact:冗余行超阈值时重写为归并视图,前后 read 等价", () => {
    const l = fresh();
    // m1 写 5 次(4 行冗余),m2 写 1 次
    for (let i = 1; i <= 5; i++) l.append([run("m1", i * 100)]);
    l.append([run("m2", 100)]);
    const before = l.read();
    l.compact();
    const after = l.read();
    expect(after.matches).toEqual(expect.arrayContaining(before.matches));
    expect(after.totalLines).toBe(2);
    // 幂等:不冗余时 compact 不改文件
    const raw = readFileSync(l.file, "utf-8");
    l.compact();
    expect(readFileSync(l.file, "utf-8")).toBe(raw);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/learningLedger.test.ts`(cwd `packages/desktop`)
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
/**
 * 学习台账(spec §1):append-only NDJSON,一行 = 一次分析 run(内嵌该场
 * findings)。同场重分析追加新行,读取按 matchId 取 createdAt 最大行 ——
 * last-run-wins 整场替换,免得被新一轮放弃的旧 finding 永久残留。
 *
 * promptVersion 只记录不作废:台账的记忆不被 analysis 缓存失效策略绑架,
 * 这是它独立于 analysis-v2.*.json 存在的核心理由。
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import type {
  LedgerMatch,
  LedgerRun,
} from "@gladlog/analysis/src/learning/types";

/** 行数超过归并后对局数的 1.2 倍(>20% 冗余)才重写 —— spec §6。 */
const COMPACT_REDUNDANCY_FACTOR = 1.2;

export type LearningLedger = ReturnType<typeof createLearningLedger>;

export function createLearningLedger(learningDir: string) {
  const file = join(learningDir, "ledger.ndjson");

  const readMerged = (): {
    byMatch: Map<string, LedgerRun>;
    badLines: number;
    totalLines: number;
  } => {
    const byMatch = new Map<string, LedgerRun>();
    let badLines = 0;
    let totalLines = 0;
    let raw = "";
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return { byMatch, badLines, totalLines };
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      totalLines++;
      try {
        const r = JSON.parse(line) as LedgerRun;
        if (r.v !== 1 || typeof r.matchId !== "string")
          throw new Error("shape");
        const prev = byMatch.get(r.matchId);
        if (!prev || r.createdAt >= prev.createdAt) byMatch.set(r.matchId, r);
      } catch {
        badLines++; // 坏行跳过不静默:计数上抛给 getState 展示
      }
    }
    return { byMatch, badLines, totalLines };
  };

  return {
    file,
    append(runs: LedgerRun[]): void {
      if (runs.length === 0) return;
      mkdirSync(learningDir, { recursive: true });
      appendFileSync(
        file,
        runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    },
    read(): { matches: LedgerMatch[]; badLines: number; totalLines: number } {
      const { byMatch, badLines, totalLines } = readMerged();
      const matches = [...byMatch.values()].map(
        ({ v: _v, promptVersion: _p, createdAt: _c, ...m }) => m,
      );
      return { matches, badLines, totalLines };
    },
    /** 冗余超阈值时重写为归并视图(tmp+rename 原子,与 analysis 缓存同法)。 */
    compact(): void {
      const { byMatch, totalLines } = readMerged();
      if (totalLines <= byMatch.size * COMPACT_REDUNDANCY_FACTOR) return;
      const tmp = `${file}.tmp`;
      writeFileSync(
        tmp,
        [...byMatch.values()].map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
      renameSync(tmp, file);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/learningLedger.test.ts`(cwd `packages/desktop`)
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/learningLedger.ts packages/desktop/src/main/learningLedger.test.ts
git commit -m "feat(desktop): 学习台账 ledger.ndjson —— 每 run 一行、last-run-wins、坏行容错、超阈值压缩"
```

---

### Task 5: learning 服务(回填 + 整合 + 自动触发)(desktop main)

**Files:**

- Create: `packages/desktop/src/main/learning.ts`
- Test: `packages/desktop/src/main/learning.test.ts`

**Interfaces:**

- Consumes: Task 1-4 全部;既有 `resolveAiClient`/`buildCoachSystemPrompt`/`PROMPT_VERSION`(`./ai`)、`resolveAiModel`(`../shared/aiModels`)、`parseModelJsonArray`(深路径)、`recordAiDebug`(`./aiDebugLog`)、`normalizeFindingCategory`(深路径)。
- Produces(Task 6/7/8 依赖):
  - `createLearningService(deps): LearningService`,deps 形状与 `createAnalysisService` 同构(getSettings/clientFactory?/matchesDir/emit)+ `learningDir: string`。
  - `LearningService` 方法:
    - `recordAnalysis(e: { matchId: string; findings: Finding[]; candidates: CandidateEvent[] }): void` — analysis 写入点调用;同步 append + 异步 maybeAutoConsolidate。
    - `init(): void` — app 启动调用;无回填标记时后台回填,完成后首次整合。
    - `consolidate(): Promise<void>` — 手动/自动整合;并发守卫;事件 `gladlog:learning:done|error`。
    - `getRules(): Promise<RulesDoc | null>`
    - `getState(): Promise<LearningState>`,其中 `type LearnedState`(export)= `{ backfill: { running: boolean; scanned: number; total: number } | null; consolidating: boolean; ledgerMatches: number; badLines: number; lastConsolidatedAt: number | null }`
  - 常量 `CONSOLIDATE_EVERY_MATCHES = 10`(export,自动触发判据)。
  - 落盘:`<learningDir>/rules.json`(RulesDoc,tmp+rename)、`<learningDir>/backfill-done.json`(`{ at: number; scanned: number }`)。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { AnthropicLike } from "./ai";
import { createLearningService } from "./learning";

/** 造一个 matches 目录:n 场,偶数场带 survival finding 的 analysis 缓存。 */
function seedMatches(root: string, n: number): string {
  const matchesDir = join(root, "matches");
  for (let i = 0; i < n; i++) {
    const dir = join(matchesDir, `m${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id: `m${i}`,
        startTime: 1_000_000 + i * 60_000,
        result: i % 3 === 0 ? "win" : "loss",
        zoneId: "1552",
        bracket: "3v3",
        teams: [[], [{ specId: 62, classId: 8 }]],
      }),
    );
    writeFileSync(
      join(dir, "analysis-v2.zh.json"),
      JSON.stringify({
        schemaVersion: 1,
        promptVersion: 7, // 故意用旧版本:回填必须不看 promptVersion
        language: "zh",
        createdAt: 1_000_000 + i * 60_000,
        result: {
          findings:
            i % 2 === 0
              ? [
                  {
                    eventIds: ["e1"],
                    severity: "high",
                    category: "survival",
                    title: "t",
                    explanation: "死于集火时没开减伤。",
                  },
                ]
              : [],
          dropped: 0,
          hadNarration: true,
        },
      }),
    );
  }
  return matchesDir;
}

const fakeClient = (raw: string): AnthropicLike => ({
  async *stream() {
    yield { delta: raw };
  },
});

const flush = () => new Promise((r) => setTimeout(r, 50));

function mkService(root: string, raw: string) {
  const events: Array<{ ch: string; payload: unknown }> = [];
  const svc = createLearningService({
    getSettings: () => ({
      anthropicApiKey: "k",
      aiModels: null,
      wowDirectory: null,
      aiLanguage: "zh" as const,
    }),
    clientFactory: () => fakeClient(raw),
    matchesDir: join(root, "matches"),
    learningDir: join(root, "learning"),
    emit: (ch, payload) => events.push({ ch, payload }),
  });
  return { svc, events };
}

describe("learning 服务", () => {
  it("回填:全部旧 promptVersion 场也进台账;完成写标记 + 首次整合", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn-"));
    seedMatches(root, 20);
    const good = JSON.stringify([
      {
        patternId: "cat:survival",
        description: "近 {{windowMatches}} 场里 {{hits}} 场有生存问题。",
        advice: "留意减伤时机。",
      },
    ]);
    const { svc } = mkService(root, good);
    svc.init();
    // 回填 + 首次整合都是异步;轮询标记文件
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const st = await svc.getState();
    expect(st.ledgerMatches).toBe(20);
    const doc = (await svc.getRules()) as RulesDoc;
    expect(doc).not.toBeNull();
    // 10/20 场命中 survival(偶数场),必产出 active 规则
    const r = doc.rules.find((x) => x.ruleId === "cat:survival");
    expect(r?.status).toBe("active");
    expect(r?.stats.hits).toBe(10);
    expect(r?.description.zh).toContain("{{hits}}");
  });

  it("提炼输出裸数字 → 审计丢弃,规则仍在但无文本;stats 照常落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn2-"));
    seedMatches(root, 20);
    const bad = JSON.stringify([
      { patternId: "cat:survival", description: "近 20 场 10 次", advice: "x" },
    ]);
    const { svc } = mkService(root, bad);
    svc.init();
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const doc = (await svc.getRules()) as RulesDoc;
    const r = doc.rules.find((x) => x.ruleId === "cat:survival")!;
    expect(r.stats.hits).toBe(10);
    expect(r.description.zh).toBeUndefined();
  });

  it("recordAnalysis:append 台账并带候选 type;自动整合按增量 10 场触发", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn3-"));
    const matchesDir = seedMatches(root, 1);
    const { svc } = mkService(root, "[]");
    // 手工放回填标记,跳过回填路径
    mkdirSync(join(root, "learning"), { recursive: true });
    writeFileSync(
      join(root, "learning", "backfill-done.json"),
      JSON.stringify({ at: 1, scanned: 0 }),
    );
    svc.init();
    svc.recordAnalysis({
      matchId: "m0",
      findings: [
        {
          eventIds: ["e1"],
          severity: "high",
          category: "survival",
          title: "t",
          explanation: "x",
        },
      ],
      candidates: [
        { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
      ],
    });
    await flush();
    const ledger = readFileSync(
      join(root, "learning", "ledger.ndjson"),
      "utf-8",
    );
    expect(ledger).toContain('"eventTypes":["death"]');
    expect(ledger).toContain('"enemySpecs":[62]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/learning.test.ts`(cwd `packages/desktop`)
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
/**
 * 跨对局学习服务(spec §3/§5):台账 → patternScan 确定性筛 → AI 提炼
 * (占位符纪律审计)→ rules.json。整合的确定性部分(stats/status)**总是**
 * 落盘;AI 文本失败只影响 description/advice,下轮懒补 —— 学习状态永不
 * 因模型抽风而回滚。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { mkdirSync } from "fs";
import { join } from "path";

import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import { parseModelJsonArray } from "@gladlog/analysis/src/analysis/parseModelJson";
import type {
  CandidateEvent,
  Finding,
} from "@gladlog/analysis/src/analysis/types";
import {
  auditDistilledRules,
  buildDistillPrompt,
} from "@gladlog/analysis/src/learning/distillRules";
import {
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  scanPatterns,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LearnedRule,
  LedgerRun,
  RulesDoc,
  StablePattern,
} from "@gladlog/analysis/src/learning/types";
import { recordAiDebug } from "./aiDebugLog";
import { resolveAiModel, type AiModelSelection } from "../shared/aiModels";
import {
  buildCoachSystemPrompt,
  PROMPT_VERSION,
  resolveAiClient,
  type AiBackend,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";
import { createLearningLedger } from "./learningLedger";

/** 台账较上次整合新增 ≥ 此数即自动整合(spec §5)。 */
export const CONSOLIDATE_EVERY_MATCHES = 10;

export interface LearningState {
  backfill: { running: boolean; scanned: number; total: number } | null;
  consolidating: boolean;
  ledgerMatches: number;
  badLines: number;
  lastConsolidatedAt: number | null;
}

export function createLearningService(deps: {
  getSettings: () => {
    anthropicApiKey: string | null;
    aiModels?: AiModelSelection | null;
    wowDirectory: string | null;
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiLanguage?: AiLanguage;
  };
  clientFactory?: (key: string) => AnthropicLike;
  matchesDir: string;
  learningDir: string;
  emit: (channel: string, payload: unknown) => void;
}) {
  const ledger = createLearningLedger(deps.learningDir);
  const rulesPath = join(deps.learningDir, "rules.json");
  const backfillMarker = join(deps.learningDir, "backfill-done.json");

  let consolidating = false;
  let backfill: { running: boolean; scanned: number; total: number } | null =
    null;

  const readRulesDoc = (): RulesDoc | null => {
    try {
      const doc = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDoc;
      return doc.schemaVersion === 1 ? doc : null;
    } catch {
      return null;
    }
  };
  const writeRulesDoc = (doc: RulesDoc): void => {
    mkdirSync(deps.learningDir, { recursive: true });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf-8");
    renameSync(tmp, rulesPath);
  };

  /** 从 meta.json + findings/candidates 铸台账行。meta 缺失时返回 null
   * (没有 startTime 就无法进窗口排序,宁缺勿错)。 */
  const buildRun = (
    matchId: string,
    findings: Array<Pick<Finding, "category" | "severity" | "eventIds">>,
    typeOf: (eventId: string) => string | undefined,
    createdAt: number,
    promptVersion: number,
  ): LedgerRun | null => {
    let meta: {
      id?: string;
      startTime?: number;
      result?: string;
      zoneId?: string;
      bracket?: string;
      teams?: Array<Array<{ specId: number }>>;
    };
    try {
      meta = JSON.parse(
        readFileSync(join(deps.matchesDir, matchId, "meta.json"), "utf-8"),
      );
    } catch {
      return null;
    }
    if (typeof meta.startTime !== "number") return null;
    return {
      v: 1,
      matchId: meta.id ?? matchId,
      startTime: meta.startTime,
      win: String(meta.result ?? "")
        .toLowerCase()
        .startsWith("win"),
      zoneId: meta.zoneId,
      bracket: meta.bracket,
      enemySpecs: (meta.teams?.[1] ?? [])
        .map((t) => t.specId)
        .filter((s) => typeof s === "number" && s > 0),
      promptVersion,
      createdAt,
      findings: findings.map((f) => ({
        category: normalizeFindingCategory(f.category),
        severity: f.severity,
        eventTypes: [
          ...new Set(
            (f.eventIds ?? []).map(typeOf).filter((t): t is string => !!t),
          ),
        ].sort(),
      })),
    };
  };

  const maybeAutoConsolidate = (): void => {
    const { matches } = ledger.read();
    const prev = readRulesDoc();
    const due = prev
      ? matches.length - prev.ledgerMatches >= CONSOLIDATE_EVERY_MATCHES
      : matches.length >= PATTERN_MIN_HITS && existsSync(backfillMarker);
    if (due) void consolidate();
  };

  /** 提炼实例:从证据场的 analysis 缓存捞该 category 的解释文本(≤3 条)。 */
  const collectExamples = (
    rules: LearnedRule[],
    lang: AiLanguage,
  ): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const r of rules) {
      const texts: string[] = [];
      for (const matchId of r.evidence) {
        if (texts.length >= 3) break;
        const base = join(deps.matchesDir, matchId);
        const file = [
          `analysis-v2.${lang}.json`,
          `analysis-v2.${lang === "zh" ? "en" : "zh"}.json`,
          "analysis-v2.json",
        ].find((f) => existsSync(join(base, f)));
        if (!file) continue;
        try {
          const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
          const findings: Array<{ category: string; explanation?: string }> =
            doc.result?.findings ?? [];
          for (const f of findings) {
            if (texts.length >= 3) break;
            if (
              normalizeFindingCategory(f.category) === r.category &&
              f.explanation
            )
              texts.push(f.explanation);
          }
        } catch {
          /* 坏缓存跳过:实例是锦上添花,不是硬依赖 */
        }
      }
      out[r.ruleId] = texts;
    }
    return out;
  };

  async function consolidate(): Promise<void> {
    if (consolidating) return;
    consolidating = true;
    try {
      const { matches } = ledger.read();
      const patterns = scanPatterns(matches);
      const prev = readRulesDoc();
      const byId = new Map<string, LearnedRule>(
        (prev?.rules ?? []).map((r) => [r.ruleId, r]),
      );
      for (const p of patterns) {
        if (!byId.has(p.patternId))
          byId.set(p.patternId, {
            ruleId: p.patternId,
            status: "active",
            category: p.category,
            eventTypes: p.eventTypes,
            condition: p.condition,
            stats: {
              windowMatches: p.windowMatches,
              hits: p.hits,
              firstSeen: p.firstSeen,
              lastSeen: p.lastSeen,
              trend: p.trend,
            },
            description: {},
            advice: {},
            evidence: p.exampleMatchIds,
            distilledAt: 0,
            distillModel: "",
          });
      }
      // 确定性部分:全部规则(含旧规则)按当前台账重算 stats + 退役/复活
      for (const r of byId.values()) {
        const g = measureGroup(matches, r.category, r.eventTypes, r.condition);
        r.stats = {
          windowMatches: g.windowMatches,
          hits: g.hits,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          trend: g.trend,
        };
        r.evidence = g.exampleMatchIds.length ? g.exampleMatchIds : r.evidence;
        r.status = nextRuleStatus(r.status, g.hits);
      }
      const rules = [...byId.values()].sort(
        (a, b) => b.stats.hits - a.stats.hits,
      );

      // AI 提炼:active 且缺当前语言文本的规则(语言切换懒重译走同一条路)
      const settings = deps.getSettings();
      const lang: AiLanguage = settings.aiLanguage ?? "zh";
      const need = rules.filter(
        (r) => r.status === "active" && !r.description[lang],
      );
      let distilled = 0;
      let droppedByAudit = 0;
      const client = resolveAiClient(settings, deps.clientFactory);
      if (need.length > 0 && client) {
        const pats: StablePattern[] = need.map((r) => ({
          patternId: r.ruleId,
          category: r.category,
          eventTypes: r.eventTypes,
          condition: r.condition,
          windowMatches: r.stats.windowMatches,
          hits: r.stats.hits,
          firstSeen: r.stats.firstSeen,
          lastSeen: r.stats.lastSeen,
          trend: r.stats.trend,
          exampleMatchIds: r.evidence,
        }));
        const prompt = buildDistillPrompt(
          pats,
          collectExamples(need, lang),
          lang,
        );
        let raw = "";
        const stream = client.stream({
          model: resolveAiModel(settings),
          max_tokens: 4096,
          system: buildCoachSystemPrompt(lang),
          messages: [{ role: "user", content: prompt }],
        });
        for await (const ev of stream) if (ev.delta) raw += ev.delta;
        recordAiDebug({
          kind: "analysis",
          matchId: "learning#consolidate",
          at: Date.now(),
          model: resolveAiModel(settings),
          prompt,
          raw,
        });
        const audit = auditDistilledRules(parseModelJsonArray(raw), pats);
        droppedByAudit = audit.dropped.length;
        for (const t of audit.texts) {
          const r = byId.get(t.patternId)!;
          r.description[lang] = t.description;
          r.advice[lang] = t.advice;
          r.distilledAt = Date.now();
          r.distillModel = resolveAiModel(settings);
          distilled++;
        }
      }

      writeRulesDoc({
        schemaVersion: 1,
        updatedAt: Date.now(),
        ledgerMatches: matches.length,
        rules,
      });
      ledger.compact();
      deps.emit("gladlog:learning:done", {
        rules: rules.length,
        distilled,
        dropped: droppedByAudit,
      });
    } catch (err) {
      deps.emit("gladlog:learning:error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      consolidating = false;
    }
  }

  /** 回填(spec §1):扫全部 analysis-v2 缓存进台账。与 aggregate() 关键
   * 差异:**不看 promptVersion** —— 旧版本场也是学习记忆。 */
  async function runBackfill(): Promise<void> {
    const { readdirSync } = await import("fs");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(deps.matchesDir).filter(
        (d) => !d.startsWith(".") && !d.startsWith("_"),
      );
    } catch {
      dirs = [];
    }
    backfill = { running: true, scanned: 0, total: dirs.length };
    let batch: LedgerRun[] = [];
    for (const dir of dirs) {
      backfill.scanned++;
      const base = join(deps.matchesDir, dir);
      const file = [
        "analysis-v2.zh.json",
        "analysis-v2.en.json",
        "analysis-v2.json",
      ].find((f) => existsSync(join(base, f)));
      if (!file) continue;
      try {
        const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
        const findings: Array<
          Pick<Finding, "category" | "severity" | "eventIds">
        > = doc.result?.findings ?? [];
        // 回填没有 candidates → eventTypes 全 [](type 级模式从 live 数据累积)
        const run = buildRun(
          dir,
          findings,
          () => undefined,
          doc.createdAt ?? 0,
          doc.promptVersion ?? 0,
        );
        if (run) batch.push(run);
      } catch {
        /* 坏缓存跳过 */
      }
      if (batch.length >= 50) {
        ledger.append(batch);
        batch = [];
        deps.emit("gladlog:learning:progress", {
          scanned: backfill.scanned,
          total: backfill.total,
        });
        // 让位其它 IPC(与 App 后台补载同思路)
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    ledger.append(batch);
    writeFileSync(
      backfillMarker,
      JSON.stringify({ at: Date.now(), scanned: backfill.scanned }),
      "utf-8",
    );
    backfill = { ...backfill, running: false };
    deps.emit("gladlog:learning:progress", {
      scanned: backfill.scanned,
      total: backfill.total,
    });
    maybeAutoConsolidate(); // 回填完成 → 首次整合
  }

  return {
    init(): void {
      if (!existsSync(backfillMarker)) {
        mkdirSync(deps.learningDir, { recursive: true });
        void runBackfill().catch((err) =>
          deps.emit("gladlog:learning:error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    /** analysis 写入点(spec §1):初轮 run 落盘后调用。失败静默 ——
     * 台账写不进不能影响分析主流程。 */
    recordAnalysis(e: {
      matchId: string;
      findings: Finding[];
      candidates: CandidateEvent[];
    }): void {
      try {
        const byId = new Map(e.candidates.map((c) => [c.id, c.type]));
        const run = buildRun(
          e.matchId,
          e.findings,
          (id) => byId.get(id),
          Date.now(),
          PROMPT_VERSION,
        );
        if (!run) return;
        ledger.append([run]);
        maybeAutoConsolidate();
      } catch {
        /* best-effort */
      }
    },
    consolidate,
    async getRules(): Promise<RulesDoc | null> {
      return readRulesDoc();
    },
    async getState(): Promise<LearningState> {
      const { matches, badLines } = ledger.read();
      return {
        backfill,
        consolidating,
        ledgerMatches: matches.length,
        badLines,
        lastConsolidatedAt: readRulesDoc()?.updatedAt ?? null,
      };
    },
  };
}
export type LearningService = ReturnType<typeof createLearningService>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/learning.test.ts`(cwd `packages/desktop`)
Expected: PASS。测试 1 里 20 场偶数命中的分布天然跨两半;若 scan 未产出,先打印 `scanPatterns` 输入核对 startTime 排序方向。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/learning.ts packages/desktop/src/main/learning.test.ts
git commit -m "feat(desktop): learning 服务 —— 回填/整合/自动触发,确定性 stats 与 AI 文本分离落盘"
```

---

### Task 6: 装配 —— analysis 写入点、index.ts 接线、IPC、preload

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`(deps 加 `onFindings`;`finish` 加 record 参数)
- Modify: `packages/desktop/src/main/index.ts:149-175`(建 learning 服务、接线、init)
- Modify: `packages/desktop/src/main/ipc.ts`(deps 加 `learning`,注册 3 个 handle)
- Modify: `packages/desktop/src/preload/index.ts`(learning 面)
- Modify: `packages/desktop/src/preload/api.ts`(GladlogApi.learning 类型)
- Test: `packages/desktop/src/main/analysis.test.ts`(补一条 onFindings 触发断言)

**Interfaces:**

- Consumes: Task 5 的 `LearningService`/`LearningState`。
- Produces:
  - `createAnalysisService` deps 新增 `onFindings?: (e: { matchId: string; findings: Finding[]; candidates: CandidateEvent[] }) => void`。语义:**模型真跑过**(审计路径,含 0 findings)或 `no-candidates`(干净场,进频次分母)时调用;`no-client`/`bad-json` 不调(没分析就没记忆)。
  - IPC:`gladlog:learning:getRules` / `gladlog:learning:getState` / `gladlog:learning:consolidate`;事件 `gladlog:learning:progress|done|error`(Task 5 已 emit)。
  - `GladlogApi.learning`:`{ getRules(): Promise<RulesDoc | null>; getState(): Promise<LearningState>; consolidate(): Promise<void>; onProgress(cb: (p: { scanned: number; total: number }) => void): () => void; onDone(cb: (d: { rules: number; distilled: number; dropped: number }) => void): () => void; onError(cb: (d: { message: string }) => void): () => void }`(RulesDoc/LearningState 类型 import 自深路径与 `../main/learning`)。

- [ ] **Step 1: analysis.ts 加钩子**

deps 类型里(`emit` 之后)加:

```ts
  /** 学习台账写入点(spec §1):模型真跑过或干净场(no-candidates)时回调;
   * no-client/bad-json 不算已分析。失败由接收方消化,这里 fire-and-forget。 */
  onFindings?: (e: {
    matchId: string;
    findings: Finding[];
    candidates: CandidateEvent[];
  }) => void;
```

`run()` 里改两处:

```ts
const finish = (result: AnalysisResult, record = false) => {
  // …原函数体不动,末尾 emit 之后加:
  if (record)
    deps.onFindings?.({
      matchId: input.matchId,
      findings: result.findings,
      candidates: input.candidates,
    });
};

const fallback = (reason: "no-candidates" | "no-client" | "bad-json") =>
  finish(
    { findings: [], dropped: 0, hadNarration: false, fallbackReason: reason },
    reason === "no-candidates",
  );
```

审计成功路径改为:

```ts
finish(
  {
    findings: audit.findings,
    dropped: audit.dropped.length,
    hadNarration: audit.findings.length > 0,
  },
  true,
);
```

- [ ] **Step 2: analysis.test.ts 补断言**

在现有测试文件里加一条(仿照现有用 fake client 的测试搭法,fake client 返回一条合法 finding JSON):

```ts
it("run 完成时回调 onFindings(candidates 原样带出)", async () => {
  const events: unknown[] = [];
  // 按本文件现有 fake-client 测试的组装方式建 service,仅多传:
  // onFindings: (e) => events.push(e)
  // …run() 后:
  expect(events).toHaveLength(1);
  expect((events[0] as { matchId: string }).matchId).toBe("m1");
});
```

(组装细节抄同文件最近一个走 fake client 的用例;若现有用例都走 `no-client` 回退,则断言 no-candidates 路径:`candidates: []` 时 onFindings 收到 `findings: []`。)

- [ ] **Step 3: index.ts 接线**

`createAnalysisService` 调用处(`packages/desktop/src/main/index.ts:149`)改为:

```ts
const learning = createLearningService({
  getSettings: () => settings.get(),
  matchesDir: join(userData(), "matches"),
  learningDir: join(userData(), "learning"),
  clientFactory: realClientFactory,
  emit: (ch, payload) => win?.webContents.send(ch, payload),
});
const analysis = createAnalysisService({
  getSettings: () => settings.get(),
  matchesDir: join(userData(), "matches"),
  clientFactory: realClientFactory,
  emit: (ch, payload) => win?.webContents.send(ch, payload),
  onFindings: (e) => learning.recordAnalysis(e),
});
```

文件头加 `import { createLearningService } from "./learning";`;`registerIpc({...})` 加 `learning,`;`registerIpc` 之后加 `learning.init();`。

- [ ] **Step 4: ipc.ts 注册**

deps 类型加 `learning: LearningService;`(import type 自 `./learning`),`registerIpc` 体末尾加:

```ts
ipcMain.handle("gladlog:learning:getRules", () => deps.learning.getRules());
ipcMain.handle("gladlog:learning:getState", () => deps.learning.getState());
ipcMain.handle("gladlog:learning:consolidate", () =>
  deps.learning.consolidate(),
);
```

- [ ] **Step 5: preload 两个文件**

`preload/index.ts` 的 analysis 段之后加(`sub` 用同文件既有工具):

```ts
  learning: {
    getRules: () => ipcRenderer.invoke("gladlog:learning:getRules"),
    getState: () => ipcRenderer.invoke("gladlog:learning:getState"),
    consolidate: () => ipcRenderer.invoke("gladlog:learning:consolidate"),
    onProgress: sub<{ scanned: number; total: number }>(
      "gladlog:learning:progress",
    ),
    onDone: sub<{ rules: number; distilled: number; dropped: number }>(
      "gladlog:learning:done",
    ),
    onError: sub<{ message: string }>("gladlog:learning:error"),
  },
```

`preload/api.ts` 的 `GladlogApi` 里 `analysis` 之后加(文件头 import type):

```ts
import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { LearningState } from "../main/learning";
```

```ts
  /** 跨对局学习(spec 2026-07-26):规则读取、状态、手动整合。 */
  learning: {
    getRules(): Promise<RulesDoc | null>;
    getState(): Promise<LearningState>;
    consolidate(): Promise<void>;
    onProgress(cb: (p: { scanned: number; total: number }) => void): () => void;
    onDone(
      cb: (d: { rules: number; distilled: number; dropped: number }) => void,
    ): () => void;
    onError(cb: (d: { message: string }) => void): () => void;
  };
```

- [ ] **Step 6: 全量验证 + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: 全绿。

```bash
git add packages/desktop/src/main/ packages/desktop/src/preload/
git commit -m "feat(desktop): 学习链路装配 —— analysis 写入点、learning IPC/preload、启动回填"
```

---

### Task 7: renderer 惯性徽章(StructuredAnalysisPanel + FindingsList + KeyMomentAxis)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`(取 rules、建 habitOf、input 加 enemySpecs)
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx`(habitOf prop + 徽章渲染)
- Modify: `packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx`(同款 prop,finding 卡头部渲染)
- Modify: renderer 样式文件(`grep -rn "rpt-finding-sev" packages/desktop/src/renderer/src --include="*.css"` 定位 `.rpt-finding` 样式所在文件,追加 `.rpt-finding-habit`)
- Test: `packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`(补 habitOf 用例)

**Interfaces:**

- Consumes: Task 3 的 `ruleAppliesToFinding`/`habitBadgeText`(barrel 或深路径均可,renderer 无大表顾虑;用深路径 `@gladlog/analysis/src/learning/matchRules` 与 `.../types` 保持一致);Task 6 的 `bridge().learning.getRules`。
- Produces: `FindingsList`/`KeyMomentAxis` 新可选 prop `habitOf?: (f: Finding) => string | null`。

- [ ] **Step 1: FindingsList.test.tsx 补失败用例**

仿照同文件现有渲染测试:

```tsx
it("habitOf 命中时渲染惯性徽章", () => {
  render(
    <FindingsList
      findings={[
        {
          eventIds: ["e1"],
          severity: "high",
          category: "survival",
          title: "t",
          explanation: "x",
        },
      ]}
      onSelect={() => {}}
      habitOf={() => "惯性问题 · 近 20 场已犯 9 次"}
    />,
  );
  expect(screen.getByText("惯性问题 · 近 20 场已犯 9 次")).toBeTruthy();
});
```

Run: `npx vitest run src/renderer/src/report/components/FindingsList.test.tsx`(cwd `packages/desktop`)→ FAIL(prop 不存在)。

- [ ] **Step 2: FindingsList.tsx 加 prop 与渲染**

props 解构与类型里加:

```ts
  /** 跨对局惯性徽章(spec §4):返回徽章文本或 null。文本由确定性 stats
   * 插值(habitBadgeText),不经过模型。 */
  habitOf?: (f: Finding) => string | null;
```

`.rpt-finding-head` div 内、title span 之后加:

```tsx
{
  (() => {
    const habit = habitOf?.(f);
    return habit ? (
      <span
        className="rpt-finding-habit"
        title="跨对局稳定模式(确定性统计,非 AI 判断)"
      >
        {habit}
      </span>
    ) : null;
  })();
}
```

- [ ] **Step 3: KeyMomentAxis.tsx 同款**

props 加同一 `habitOf?: (f: Finding) => string | null;`;在 finding 卡的 `.rpt-finding-head`(`KeyMomentAxis.tsx` 约 241 行,`rpt-finding-title` span 之后)插入与 Step 2 相同的渲染块(把 `f` 换成该作用域的 `e.f`)。

- [ ] **Step 4: StructuredAnalysisPanel.tsx 接数据**

1. import 加:

```ts
import {
  habitBadgeText,
  ruleAppliesToFinding,
} from "@gladlog/analysis/src/learning/matchRules";
import type { LearnedRule } from "@gladlog/analysis/src/learning/types";
```

2. `input` useMemo 的返回值加 `enemySpecs`(`enemies` 已在作用域):

```ts
return {
  matchId,
  candidates,
  richContext,
  spec,
  ownerName: owner.name,
  enemySpecs: enemies.map((u) => Number(u.spec)).filter((s) => s > 0),
};
```

3. state + 加载(仿 goals 的容错风格;`(bridge() as { learning?: ... })` 收窄以兼容测试桩):

```ts
const [rules, setRules] = useState<LearnedRule[]>([]);
useEffect(() => {
  try {
    const api = (
      bridge() as unknown as {
        learning?: { getRules(): Promise<{ rules: LearnedRule[] } | null> };
      }
    ).learning;
    if (!api) return;
    void api
      .getRules()
      .then((doc) => setRules(doc?.rules ?? []))
      .catch(() => {});
  } catch {
    /* 测试桩无该面 */
  }
}, [matchId]);
```

4. habitOf(zoneId 在 renderer 侧未知 → 传 undefined,zone 条件规则保守不亮;matchInCondition 对未知字段判不满足,见 Task 1):

```ts
const habitOf = useMemo(() => {
  if (rules.length === 0 || !input) return undefined;
  const meta = { enemySpecs: input.enemySpecs };
  return (f: Finding): string | null => {
    const hit = rules.find((r) =>
      ruleAppliesToFinding(r, f, input.candidates, meta),
    );
    return hit ? habitBadgeText(hit, lang ?? "zh") : null;
  };
}, [rules, input, lang]);
```

5. 三个渲染点传 prop:两处 `<FindingsList` 与两处 `<KeyMomentAxis` 都加 `habitOf={habitOf}`。

- [ ] **Step 5: 样式**

在 grep 定位到的样式文件(`.rpt-finding-sev` 所在处)追加:

```css
.rpt-finding-habit {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  background: color-mix(in srgb, var(--warn, #d97706) 18%, transparent);
  color: var(--warn, #d97706);
  white-space: nowrap;
}
```

(若该文件不用 `--warn` 变量,抄邻近徽章类的既有配色写法,保持一致胜过好看。)

- [ ] **Step 6: 验证 + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: 全绿。可选人工验证:`/run-ui` 测试台看徽章(fixture bridge 无 learning 面 → 不渲染,属预期)。

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop): 战报 finding 惯性徽章 —— 规则引擎跑在审计后 findings 上,不调 AI"
```

---

### Task 8: StatsDashboard 长期规律卡片

**Files:**

- Modify: `packages/desktop/src/renderer/src/components/StatsDashboard.tsx`(新卡片:规则列表 + 趋势 + 手动整合)
- Modify: StatsDashboard 关联样式文件(`grep -rn "dash-card" packages/desktop/src/renderer/src --include="*.css"` 定位)

**Interfaces:**

- Consumes: Task 6 的 `bridge().learning.*`;Task 1 类型;`interpolate`(`@gladlog/analysis/src/compare/claimChecker`);`distillFacts`(`@gladlog/analysis/src/learning/distillRules`);组件内既有 `categoryLabel`(错题本已用,沿用其 import)与 `onOpenMatch` prop。
- Produces: 无下游依赖(叶子 UI)。

- [ ] **Step 1: 数据接入**

组件内(错题本 state 附近)加:

```ts
const [rulesDoc, setRulesDoc] = useState<RulesDoc | null>(null);
const [learnState, setLearnState] = useState<LearningState | null>(null);
const reloadLearning = () => {
  try {
    const api = (
      bridge() as unknown as {
        learning?: {
          getRules(): Promise<RulesDoc | null>;
          getState(): Promise<LearningState>;
        };
      }
    ).learning;
    if (!api) return;
    void api
      .getRules()
      .then(setRulesDoc)
      .catch(() => {});
    void api
      .getState()
      .then(setLearnState)
      .catch(() => {});
  } catch {
    /* 测试桩无该面 */
  }
};
useEffect(() => {
  reloadLearning();
  try {
    const api = (
      bridge() as unknown as {
        learning?: { onDone(cb: () => void): () => void };
      }
    ).learning;
    return api?.onDone?.(() => reloadLearning());
  } catch {
    return undefined;
  }
}, []);
```

import(文件头):

```ts
import { interpolate } from "@gladlog/analysis/src/compare/claimChecker";
import { distillFacts } from "@gladlog/analysis/src/learning/distillRules";
import { habitBadgeText } from "@gladlog/analysis/src/learning/matchRules";
import type {
  LearnedRule,
  RulesDoc,
} from "@gladlog/analysis/src/learning/types";
import type { LearningState } from "../../../main/learning";
```

(`LearningState` 的相对路径按 StatsDashboard 现有对 main 类型的 import 方式对齐——文件里 `StoredMatchMeta` 怎么引就怎么引。)

- [ ] **Step 2: 卡片渲染**

错题本卡片(`data-testid="dash-notebook"`)之后插入:

```tsx
{
  (rulesDoc || learnState) && (
    <div className="dash-card" data-testid="dash-learning">
      <h3>
        长期规律 —— 跨对局稳定模式(确定性统计 + AI 归纳)
        <button
          className="dash-learning-run"
          disabled={learnState?.consolidating}
          onClick={() => {
            try {
              void (
                bridge() as unknown as {
                  learning?: { consolidate(): Promise<void> };
                }
              ).learning?.consolidate();
            } catch {
              /* noop */
            }
          }}
        >
          {learnState?.consolidating ? "整合中…" : "重新整合"}
        </button>
      </h3>
      <p className="dash-learning-meta">
        {learnState?.backfill?.running
          ? `回填历史分析中… ${learnState.backfill.scanned}/${learnState.backfill.total}`
          : `台账 ${learnState?.ledgerMatches ?? 0} 场` +
            (learnState?.lastConsolidatedAt
              ? ` · 上次整合 ${new Date(learnState.lastConsolidatedAt).toLocaleString()}`
              : " · 尚未整合")}
        {learnState && learnState.badLines > 0
          ? ` · ${learnState.badLines} 坏行已跳过`
          : ""}
      </p>
      {(rulesDoc?.rules ?? []).map((r: LearnedRule) => {
        const facts = distillFacts(r.stats);
        const desc = r.description.zh ?? r.description.en;
        const adv = r.advice.zh ?? r.advice.en;
        const max = Math.max(1, ...r.stats.trend);
        return (
          <div key={r.ruleId} className="dash-learning-rule">
            <span
              className={`dash-learning-status ${r.status}`}
              title={
                r.status === "improved"
                  ? "近期已明显减少 —— 进步证据,继续保持"
                  : "仍在活跃发生"
              }
            >
              {r.status === "improved" ? "已改进" : "活跃"}
            </span>
            <span className="dash-learning-cat">
              {categoryLabel(r.category, "zh")}
              {r.eventTypes.length > 0 ? ` · ${r.eventTypes.join("+")}` : ""}
              {r.condition?.enemySpec
                ? `(对位 spec ${r.condition.enemySpec})`
                : r.condition?.zoneId
                  ? `(地图 ${r.condition.zoneId})`
                  : ""}
            </span>
            <span className="dash-learning-count">
              {habitBadgeText(r, "zh")}
            </span>
            <span className="dash-learning-trend" title="每 5 场命中数,旧→新">
              {r.stats.trend.map((h, i) => (
                <i
                  key={i}
                  style={{ height: `${4 + (h / max) * 12}px` }}
                  className={h > 0 ? "hit" : ""}
                />
              ))}
            </span>
            <p className="dash-learning-desc">
              {desc ? interpolate(desc, facts) : "(描述待下次整合生成)"}
            </p>
            {adv && (
              <p className="dash-learning-advice">
                💡 {interpolate(adv, facts)}
              </p>
            )}
            <span className="dash-learning-evidence">
              {r.evidence.map((id) => (
                <button key={id} onClick={() => onOpenMatch?.(id)}>
                  查看战例
                </button>
              ))}
            </span>
          </div>
        );
      })}
      {(rulesDoc?.rules ?? []).length === 0 &&
        !learnState?.backfill?.running && (
          <p className="dash-learning-empty">
            还没有稳定模式 —— 分析的对局多了(同类问题近 20 场出现 5 次以上)
            会自动出现在这里。
          </p>
        )}
    </div>
  );
}
```

注意:`onOpenMatch` 是 StatsDashboard 既有 prop(App.tsx:197 传入),签名 `(matchId: string) => void`;若组件内解构名不同,以组件现有解构为准。`categoryLabel` 若该文件尚未 import,按 FindingsList 的路径引:`import { categoryLabel } from "../report/derive/findingDisplay";`。

- [ ] **Step 3: 样式**

在 `dash-card` 样式所在文件追加:

```css
.dash-learning-run {
  float: right;
  font-size: 12px;
}
.dash-learning-meta {
  color: var(--mute);
  font-size: 12px;
}
.dash-learning-rule {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  gap: 4px 10px;
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.2));
}
.dash-learning-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
}
.dash-learning-status.active {
  background: rgba(217, 119, 6, 0.18);
  color: #d97706;
}
.dash-learning-status.improved {
  background: rgba(22, 163, 74, 0.18);
  color: #16a34a;
}
.dash-learning-desc,
.dash-learning-advice {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 13px;
}
.dash-learning-trend {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
}
.dash-learning-trend i {
  width: 5px;
  background: var(--line, #ccc);
  border-radius: 1px;
}
.dash-learning-trend i.hit {
  background: #d97706;
}
.dash-learning-evidence {
  grid-column: 1 / -1;
  display: flex;
  gap: 6px;
}
.dash-learning-empty {
  color: var(--mute);
  font-size: 13px;
}
```

(同 Task 7:变量名以该文件既有写法为准。)

- [ ] **Step 4: 验证 + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: 全绿。

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop): 战绩页长期规律卡片 —— 规则/趋势/证据链/手动整合"
```

---

### Task 9: 真实库验收(前后数字)+ 收尾

**Files:**

- Create: `packages/desktop/scripts/learningScan.ts`(常驻验证工具,不是一次性脚本 —— 与 `scripts/verifyVision.ts` 同级同性质)
- Modify: `packages/desktop/package.json`(scripts 加 `"learning:scan": "tsx scripts/learningScan.ts"`)

**Interfaces:**

- Consumes: Task 1/4/5 的 `scanPatterns`/`measureGroup`/`createLearningLedger` 及回填逻辑同款读取。

- [ ] **Step 1: 写 learningScan.ts**

```ts
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
  if (!file) continue;
  try {
    const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
    const meta = JSON.parse(readFileSync(join(base, "meta.json"), "utf-8"));
    if (typeof meta.startTime !== "number") continue;
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
      findings: (doc.result?.findings ?? []).map(
        (f: { category: string; severity: string }) => ({
          category: normalizeFindingCategory(f.category),
          severity: f.severity,
          eventTypes: [],
        }),
      ),
    });
  } catch {
    /* 坏档跳过 */
  }
}

console.log(`台账(直读回填口径): ${matches.length} 场`);
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
```

- [ ] **Step 2: 在真实库上跑,记录数字**

Run: `npm run learning:scan --workspace=packages/desktop`
Expected 与记录(验收判据,写进 commit message):

1. 台账场数 ≈ 已分析对局数(≤794,只算有 analysis 缓存的场)。
2. 稳定模式 N 个(N 是多少就报多少;N=0 时检查窗口内是否真有 ≥5 次同类——数字本身就是结论)。
3. 抽 3 个模式,人工用错题本(战绩页)对同 category 的条目数交叉核对量级。

- [ ] **Step 3: 在 app 里跑通全链路(人工冒烟)**

`npm run dev --workspace=packages/desktop` 启动,依次确认:

1. 启动后战绩页出现回填进度 → 台账场数落定。
2. 首次整合自动触发(或点"重新整合"),长期规律卡片出现规则、描述里无裸数字异常(占位符已插值)。
3. 打开一场命中规则 category 的对局战报 → finding 上出现"惯性问题 · 近 N 场已犯 M 次"徽章。
4. `learning:scan` 复核 rules.json 全一致(Step 1 脚本 exit 0)。

占位符纪律类功能的教训(memory:深挖轮量化):单测盲区在真模型格式漂移,**必须真模型 smoke** —— 第 2 步至少一次走真实 AI 后端,确认审计不误杀正常输出(若全部被丢,看 DevPanel 的 aiCalls 里 raw 与 dropped 原因再调 prompt 措辞,不放松审计)。

- [ ] **Step 4: 最终提交 + push**

```bash
git add packages/desktop/scripts/learningScan.ts packages/desktop/package.json
git commit -m "feat(desktop): learning:scan 验收工具 —— 台账/模式/规则三级数字复核

真实库验收(判据=learning:scan):台账 <N> 场,稳定模式 <M> 个,rules.json 复核全一致"
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet && git push
```

(`<N>`/`<M>` 填 Step 2 实测数字 —— 修复必须给前后数字,功能验收同理。)

---

## Self-Review 记录

- **Spec 覆盖**:§1 台账=Task 4+6,回填=Task 5;§2 筛=Task 1;§3 提炼+审计=Task 2+5;§4 应用+UI=Task 3+7,报告页=Task 8;§5 触发/退役=Task 5(`CONSOLIDATE_EVERY_MATCHES`/`nextRuleStatus`);§6 坏行/压缩/懒重译(consolidate 的 `!description[lang]` 即懒重译路径)/小库(`windowMatches` 取实际)=Task 1/4/5;§7 验收=Task 9。
- **Spec 偏差(已回写 spec 修正节)**:跨场键 findingKey→category+type;台账每 run 一行、last-run-wins 按场不按 finding;endTime→startTime;去掉 ownerSpec;"审计失败保留旧 rules.json 整份"→"确定性部分总是落盘,仅文本缺失待补"(更强的性质)。
- **类型一致性**:`LearnedRule.stats` 字段与 `GroupStats` 去掉 example/spans 后一致;`habitOf` 三处签名相同;`LedgerMatch = Omit<LedgerRun,...>` 单源派生。
