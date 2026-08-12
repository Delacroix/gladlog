# 无限 token 深挖上限实验 + 评审工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一套查证 CLI(包装现成谓词)+ 评审会话构建/机器预筛 + dev:ui 评审工作台,支撑「最强模型多轮自主深挖一场对局 → 人在完整战报 context 下逐条盲评」的上限实验。

**Architecture:** 研究侧代码全部进 `packages/eval`(`src/explore/` 放逻辑,`scripts/` 只做薄壳);评审 UI 活在 `packages/desktop/dev/` 测试台(新增 `?review=` 模式 + vite dev 中间件落盘标注);产品 src 唯一改动是给 `MatchReport` 加一个惰性可选 prop `externalSeek`(外部驱动回放跳转)。

**Tech Stack:** tsx CLI(ESM)、既有 `@gladlog/analysis` 谓词(深路径 import,不改 analysis 包)、Vite dev 中间件、React(dev harness)。

**Spec:** `docs/superpowers/specs/2026-08-12-unlimited-deepdive-review-design.md`

## Global Constraints

- **门规谓词即规范**:不新写任何采样逻辑,只包装 `@gladlog/analysis` 现成 export;所有时刻先 `toRenderSecond()`(= `Math.floor`)再采样。深路径 import(`@gladlog/analysis/src/utils/...`)是既有惯例(见 `packages/eval/test/predicateIndex.test.ts`),`momentSnapshot`/`getUnitRawPositionAtTime` 无公共导出路径,一律深 import,**不改 analysis 的 index.ts**。
- eval 绝不 import `@gladlog/desktop`;对局转换恒用 `toLegacyMatch({ ...m, rawLines: [] })`(惯例注释在 `packages/eval/scripts/momentDiveAb.ts`)。
- eval 的 `scripts/` 不在 typecheck 范围 —— 逻辑必须放 `packages/eval/src/`,脚本只做 arg parsing + 调用。
- 任何谓词消费前先 `await ensureAnalysisData()`(from `@gladlog/analysis`)。
- desktop 侧 push 前:`npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet`(eslint 必须全仓,不能只扫 src)。本机绝不跑 `test:visual`。
- 评审工作台不进视觉基线(不加 scene,走 `?review=` 独立模式)。
- 端口用 `dev/ports.ts` 的 `VISUAL_PORT`,不硬编码 5199。
- 提交直接 commit+push 到 main(用户既定工作流);每个 task 一个 commit。
- 落盘文件全部 tmp+rename 原子写(仓库既定纪律)。
- `docs/commands/*.md` 不在双语成对清单里,单语中文即可。

## 数据契约(全计划共用)

`$GLADLOG_EVAL_HOME/review-sessions/` 下,一次实验一个 `<name>`:

- `<name>.deep.json` — 深挖代理手工产出:`DeepFindingInput[]`
- `<name>.session.json` — `ReviewSession`(构建器产出,含预筛结论与打散卡片)
- `<name>.answers.json` — `ReviewAnswers`(工作台落盘)

类型单源:`packages/eval/src/explore/reviewTypes.ts`(dev harness 相对路径 import 它,vite 会经 `/@fs/` 服务 workspace 内文件,无需配置)。

---

### Task 1: 对局库访问 + `pick`/`overview`(eval)

**Files:**

- Create: `packages/eval/src/explore/storeAccess.ts`
- Test: `packages/eval/test/explore.storeAccess.test.ts`

**Interfaces:**

- Produces:
  - `DEFAULT_MATCH_DIR: string`
  - `loadIndex(matchesDir: string): StoredMetaRow[]`(`StoredMetaRow = { id: string; kind?: "match" | "shuffle"; durationS?: number; playerName?: string; result?: string; startTime?: number; bracket?: string }`)
  - `pickRows(rows: StoredMetaRow[], opts: { minDurationS: number }): StoredMetaRow[]`(时长过滤 + 按 startTime 新→旧)
  - `loadLegacyRound(matchesDir: string, matchId: string, roundSeq?: number): { legacy: LegacyRound; kind: "match" | "shuffle"; roundSeq?: number }`(`type LegacyRound = ReturnType<typeof toLegacyMatch>`)
  - `splitTeams(legacy: LegacyRound): { friends: ICombatUnit[]; enemies: ICombatUnit[]; owner: ICombatUnit | undefined }`
  - `overviewLines(legacy: LegacyRound, meta?: StoredMetaRow): string[]`

参照实现(必读):`packages/eval/scripts/momentDiveAb.ts` 的 `loadIndex`(读 `_index.ndjson`,按 id 去重后写胜出)、round 提取(`doc.data.rounds` vs `[doc.data]`)、`findOwner`(playerId+Friendly,退化到友方治疗)。`splitTeams` 按 `unit.reaction === CombatUnitReaction.Friendly / .Hostile` 且仅玩家单位分组(玩家判定照 momentDiveAb 现有写法)。`overviewLines` 输出:每单位一行(`名字 阵营 [死亡: 1:23, …]`,死亡取 `unit.deathRecords ?? []`,字段名以 parser-compat 实际为准,防御式读取)+ 一行 `时长 m:ss`(`renderedWindowSeconds(0, (endTime-startTime)/1000)` + `fmtTime`)。

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/explore.storeAccess.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadIndex, pickRows } from "../src/explore/storeAccess";

function tmpStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-store-"));
  const rows = [
    {
      id: "aaa",
      kind: "match",
      durationS: 300,
      playerName: "Me-Realm",
      startTime: 100,
    },
    {
      id: "aaa",
      kind: "match",
      durationS: 301,
      playerName: "Me-Realm",
      startTime: 100,
    }, // dup, last wins
    { id: "bbb", kind: "shuffle", durationS: 90, startTime: 200 },
    { id: "ccc", kind: "match", durationS: 150, startTime: 300 },
  ];
  writeFileSync(
    join(dir, "_index.ndjson"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  mkdirSync(join(dir, "aaa"));
  return dir;
}

describe("storeAccess", () => {
  it("loadIndex dedupes by id, last write wins", () => {
    const rows = loadIndex(tmpStore());
    expect(rows.map((r) => r.id).sort()).toEqual(["aaa", "bbb", "ccc"]);
    expect(rows.find((r) => r.id === "aaa")?.durationS).toBe(301);
  });

  it("pickRows filters by duration and sorts newest first", () => {
    const rows = pickRows(loadIndex(tmpStore()), { minDurationS: 120 });
    expect(rows.map((r) => r.id)).toEqual(["ccc", "aaa"]); // bbb 90s dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @gladlog/eval run test -- explore.storeAccess`
Expected: FAIL(module not found)

- [ ] **Step 3: Implement `storeAccess.ts`**(照 momentDiveAb 范式;`loadLegacyRound` 内 `toLegacyMatch({ ...roundData, rawLines: [] })`,shuffle 时按 `roundSeq` 取 `doc.data.rounds[roundSeq]`,缺省 0)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @gladlog/eval run test -- explore.storeAccess`
Expected: PASS

- [ ] **Step 5: 真库集成 smoke(skip-if-missing)**——同一测试文件追加:

```ts
import { existsSync } from "node:fs";
import {
  DEFAULT_MATCH_DIR,
  loadLegacyRound,
  overviewLines,
  splitTeams,
} from "../src/explore/storeAccess";
import { ensureAnalysisData } from "@gladlog/analysis";

const hasLibrary = existsSync(join(DEFAULT_MATCH_DIR, "_index.ndjson"));

describe.skipIf(!hasLibrary)("storeAccess against real library", () => {
  it("loads a real round and renders an overview", async () => {
    await ensureAnalysisData();
    const rows = pickRows(loadIndex(DEFAULT_MATCH_DIR), { minDurationS: 120 });
    expect(rows.length).toBeGreaterThan(0);
    const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, rows[0].id);
    const teams = splitTeams(legacy);
    expect(teams.friends.length).toBeGreaterThan(0);
    const lines = overviewLines(legacy, rows[0]);
    expect(lines.some((l) => /\d:\d\d/.test(l))).toBe(true);
  });
});
```

Run: `npm -w @gladlog/eval run test -- explore.storeAccess` → PASS(本机有库,真跑)

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/storeAccess.ts packages/eval/test/explore.storeAccess.test.ts
git commit -m "feat(eval): matchExplore 地基——对局库读取/选局过滤/概览行"
```

---

### Task 2: 查证查询集(cd / hp / auras / pos / dr / flow / gaps)+ 统一 dispatch

**Files:**

- Create: `packages/eval/src/explore/matchExplore.ts`
- Test: `packages/eval/test/explore.queries.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LegacyRound`、`splitTeams`。
- Produces:
  - `cdLines(legacy, t: number): string[]` — 每玩家一行:`{fmtTime(tt)} {名} ready: A,B | onCd: C(还剩 Ns)`
  - `hpLines(legacy, t: number): string[]`、`hpCurveLines(legacy, fromS, toS, stepS): string[]`
  - `auraLines(legacy, t: number): string[]`
  - `posLines(legacy, t: number): string[]` — owner↔每单位:`dist 12.3yd | LoS 通/挡/未知`
  - `drLines(legacy, fromS, toS): string[]` — 双向 CC 链,窗口内每次落地一行
  - `flowLines(legacy, fromS, toS): string[]` — 直接透传 `buildCastFlowLines`
  - `gapLines(legacy): string[]` — `detectHealingGaps` + `formatHealingGapsForContext`
  - `runQuery(legacy: LegacyRound, argv: string[]): string[]` — dispatch:`argv[0]` ∈ overview|cd|hp|hpcurve|auras|pos|dr|flow|gaps,其后 `--t/--from/--to/--step`;非法子命令/缺参 throw `Error("usage: …")`。**这是预筛与 CLI 的共享谓词**——两边只准走它。

谓词绑定(签名已核实,全部现成):

| 查询     | 谓词                                                                                                             | import 路径                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| cd       | `extractMajorCooldowns(unit, combat)` + `cdAvailableAt(cd, tSeconds)`                                            | `@gladlog/analysis`                                         |
| hp       | `getHpPercentAtTime(unit, atSeconds, matchStartMs)`(null→`无样本`)                                               | `@gladlog/analysis`                                         |
| auras    | `aurasActiveAt(unit, combat, t)`                                                                                 | `@gladlog/analysis/src/analysis/momentSnapshot`             |
| pos 距离 | `getUnitPositionAtTime(unit, tMs, INTERP_MAX_GAP_MS)` + `distanceBetween`                                        | `@gladlog/analysis`(常量来自 `positionSampling`)            |
| pos LoS  | `getUnitRawPositionAtTime(unit, tMs, LOS_SWEEP_GAP_MS)` + `hasLineOfSight(zoneId, a, b)`,null→`未知`绝不当 false | `@gladlog/analysis/src/utils/losAnalysis`(raw 版无公共导出) |
| dr       | `analyzeOutgoingCCChains(friends, enemies, combat)` 正反各一次                                                   | `@gladlog/analysis`                                         |
| flow     | `buildCastFlowLines(combat, fromS, toS)`                                                                         | `@gladlog/analysis/src/analysis/momentSnapshot`             |
| gaps     | `detectHealingGaps(healer, friends, enemies, combat)` + `formatHealingGapsForContext`,healer=友方 `isHealerSpec` | `@gladlog/analysis`                                         |

所有入参时刻先 `toRenderSecond()`;`tMs = legacy.startTime + toRenderSecond(t) * 1000`;`zoneId` 取 `legacy.startInfo.zoneId`。**dr 一步注意**:动手前读 `packages/analysis/src/utils/drAnalysis.ts:441` 附近 `IOutgoingCCChain` 的实际字段名再写映射(每次 application 一行:时刻/施放者/目标/技能/DR 档位/实际时长),不许猜字段。

- [ ] **Step 1: Write the failing test**(纯逻辑部分)

```ts
// packages/eval/test/explore.queries.test.ts
import { describe, expect, it } from "vitest";
import { runQuery } from "../src/explore/matchExplore";

const emptyLegacy = {
  startTime: 1_000_000,
  endTime: 1_180_000,
  startInfo: { zoneId: "1672" },
  units: {},
} as any;

describe("runQuery dispatch", () => {
  it("rejects unknown subcommand with usage", () => {
    expect(() => runQuery(emptyLegacy, ["nope"])).toThrow(/usage/);
  });
  it("requires --t for cd", () => {
    expect(() => runQuery(emptyLegacy, ["cd"])).toThrow(/usage/);
  });
  it("floors fractional seconds to the render grid", () => {
    // 空对局也要输出表头行,且表头时刻是 floor 后的渲染秒
    const lines = runQuery(emptyLegacy, ["cd", "--t", "93.9"]);
    expect(lines[0]).toContain("1:33"); // fmtTime(93), not 1:34
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @gladlog/eval run test -- explore.queries`
Expected: FAIL

- [ ] **Step 3: Implement `matchExplore.ts`**(表结构如上;每个查询函数第一行输出一条表头 `## cd @ 1:33` 便于引用与断言;单位遍历用 `splitTeams`,无数据时输出 `(无数据)` 行而不是空数组)

- [ ] **Step 4: Run pure tests to verify they pass**

- [ ] **Step 5: 真库集成 smoke**——追加 `describe.skipIf(!hasLibrary)`:对真库第一场 >120s 的对局依次跑全部 8 个子命令,断言每个返回 ≥1 行且不 throw;对 `pos` 断言每行匹配 `/dist [\d.]+yd|未知/`。

Run: `npm -w @gladlog/eval run test -- explore.queries`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/matchExplore.ts packages/eval/test/explore.queries.test.ts
git commit -m "feat(eval): matchExplore 八类查证查询,单源 runQuery dispatch"
```

---

### Task 3: CLI 薄壳 `scripts/matchExplore.ts`

**Files:**

- Create: `packages/eval/scripts/matchExplore.ts`

**Interfaces:**

- Consumes: `loadIndex/pickRows/loadLegacyRound/overviewLines/runQuery`、`ensureAnalysisData`。
- Produces: 命令行(供深挖代理使用):
  - `npx tsx packages/eval/scripts/matchExplore.ts pick [--min-duration 120] [--store <dir>]` — 表格:id / kind / 时长 / playerName / result / bracket
  - `npx tsx packages/eval/scripts/matchExplore.ts <matchId> [--round N] [--store <dir>] <sub> [--t X | --from A --to B [--step S]]` — 透传 `runQuery`

- [ ] **Step 1: Implement**(`node:util` 的 `parseArgs`,`allowPositionals: true`;顶层 await `ensureAnalysisData()`;错误走 `console.error(usage); process.exit(1)`;逻辑零新增——脚本不在 typecheck 范围所以必须保持哑壳)

- [ ] **Step 2: Manual smoke**

```bash
npx tsx packages/eval/scripts/matchExplore.ts pick | head -5
ID=$(npx tsx packages/eval/scripts/matchExplore.ts pick | awk 'NR==2{print $1}')
npx tsx packages/eval/scripts/matchExplore.ts "$ID" overview
npx tsx packages/eval/scripts/matchExplore.ts "$ID" cd --t 60
```

Expected: 三条命令都有输出、退出码 0。**把实际输出贴进 commit message 不需要,但必须真跑过。**

- [ ] **Step 3: Commit**

```bash
git add packages/eval/scripts/matchExplore.ts
git commit -m "feat(eval): matchExplore CLI 薄壳(pick + 查询透传)"
```

---

### Task 4: 评审类型 + 基线 findings 转换

**Files:**

- Create: `packages/eval/src/explore/reviewTypes.ts`
- Create: `packages/eval/src/explore/baselineFindings.ts`
- Test: `packages/eval/test/explore.baseline.test.ts`

**Interfaces:**

- Produces(`reviewTypes.ts`,dev harness 也 import 它):

```ts
export interface EvidenceRef {
  cmd: string;
  line: string;
} // cmd = runQuery argv 串,如 "cd --t 93"
export interface DeepFindingInput {
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: EvidenceRef[];
  severity: "high" | "med" | "low";
}
export type PrescreenVerdict = "verified" | "mismatch" | "unverifiable";
export interface ReviewCard {
  cardId: string;
  source: "deep" | "baseline";
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: Array<EvidenceRef & { verdict: PrescreenVerdict }>;
}
export interface ReviewSession {
  schemaVersion: 1;
  name: string;
  matchId: string;
  roundSeq?: number;
  createdAt: number;
  cards: ReviewCard[];
}
export interface ReviewAnswer {
  cardId: string;
  truth: "true" | "partial" | "false" | "cant-tell";
  awareness: "knew" | "vague" | "unaware";
  actionable: "concrete" | "generic" | "non-actionable";
  adopt: "yes" | "maybe" | "no";
  impact: "high" | "med" | "low" | "none";
  note: string;
  answeredAt: number;
}
export interface ReviewAnswers {
  schemaVersion: 1;
  name: string;
  answers: ReviewAnswer[];
}
```

- Produces(`baselineFindings.ts`):
  - `readActiveAnalysisResult(matchesDir: string, matchId: string, lang?: "zh" | "en"): { findings: Finding[] } | null` — 读 `analysis-v2.<lang>.json`(候选顺序 zh → en → 无后缀,照 `packages/desktop/src/main/analysis.ts:1225-1300` 的既有扫描顺序);信封 v2 取 `slots[lastSlotKey].result`,v1 取 `result`。**只读 JSON,不 import desktop。**
  - `baselineToCards(findings: Finding[], legacy: LegacyRound, owner: ICombatUnit | undefined): Array<Omit<ReviewCard, "cardId" | "evidence"> & { evidence: EvidenceRef[] }>` — claim = `title — explanation`(有 `deepDive.text` 追加一段);anchorT 优先 `min(deepDive.chips[].t)`,否则用候选事件联查:`extractCandidateFindings` 重建候选(**调用方式照抄 `packages/eval/scripts/deepDiveScan.ts` 的既有调用**),取 `eventIds` 命中候选的最小 `t`;两者皆无 → anchorT = 0、unitNames = []。evidence 由命中的候选事件生成:`{ cmd: "flow --from <t-5> --to <t+5>", line: 候选渲染行 }` 形态不强求可验,基线证据统一标 `unverifiable` 之外的特例——直接标 `verified`(它们本来就是确定性派生物),在 Task 5 预筛里按 source==="baseline" 短路。

- [ ] **Step 1: Write the failing test**(纯 JSON 信封部分)

```ts
// packages/eval/test/explore.baseline.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActiveAnalysisResult } from "../src/explore/baselineFindings";

function writeDoc(dir: string, id: string, file: string, doc: unknown) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, file), JSON.stringify(doc));
}
const finding = {
  eventIds: ["e1"],
  severity: "high",
  category: "cc",
  title: "T",
  explanation: "E",
};

describe("readActiveAnalysisResult", () => {
  it("reads v2 envelope via lastSlotKey", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    writeDoc(dir, "m1", "analysis-v2.zh.json", {
      schemaVersion: 2,
      language: "zh",
      lastSlotKey: "cli:claude",
      slots: {
        "cli:claude": {
          promptVersion: 3,
          createdAt: 1,
          result: { findings: [finding], dropped: 0, hadNarration: false },
        },
      },
    });
    expect(readActiveAnalysisResult(dir, "m1", "zh")?.findings).toHaveLength(1);
  });
  it("reads v1 legacy envelope and falls back zh→en→bare", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    writeDoc(dir, "m1", "analysis-v2.json", {
      schemaVersion: 1,
      promptVersion: 3,
      createdAt: 1,
      result: { findings: [finding], dropped: 0, hadNarration: false },
    });
    expect(readActiveAnalysisResult(dir, "m1", "zh")?.findings).toHaveLength(1);
  });
  it("returns null when no cache exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-an-"));
    mkdirSync(join(dir, "m1"));
    expect(readActiveAnalysisResult(dir, "m1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test → FAIL**;**Step 3: Implement**;**Step 4: Run test → PASS**

- [ ] **Step 5: anchor 推导单测**——同文件追加:构造 `Finding` 带 `deepDive.chips: [{t: 45, …}, {t: 30, …}]`,断言 anchorT === 30;无 chips 无候选命中 → anchorT === 0。(候选联查路径进真库 smoke:`describe.skipIf(!hasLibrary)` 对一场有分析缓存的对局跑 `baselineToCards`,断言不 throw。库里有分析缓存的对局少,找不到就 `this.skip()`。)

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/reviewTypes.ts packages/eval/src/explore/baselineFindings.ts packages/eval/test/explore.baseline.test.ts
git commit -m "feat(eval): 评审类型单源 + 基线分析缓存转换(v1/v2 信封、chips 锚点)"
```

---

### Task 5: 机器预筛 + 会话构建脚本

**Files:**

- Create: `packages/eval/src/explore/buildSession.ts`
- Create: `packages/eval/scripts/buildReviewSession.ts`
- Test: `packages/eval/test/explore.buildSession.test.ts`

**Interfaces:**

- Consumes: Task 2 `runQuery`、Task 4 全部。
- Produces(`buildSession.ts`):
  - `prescreen(evidence: EvidenceRef[], query: (argv: string[]) => string[]): Array<EvidenceRef & { verdict: PrescreenVerdict }>` — 逐条:`query(cmd.split(/\s+/))` throw → `unverifiable`;输出含 `line`(trim 后全等)→ `verified`;否则 `mismatch`。`query` 注入以便测试;生产传 `(argv) => runQuery(legacy, argv)`。**评审 UI 与预筛判同一事实的谓词就是 `runQuery`,别处不准再实现。**
  - `seededShuffle<T>(items: T[], seed: string): T[]` — mulberry32(fnv1a(seed)),同 seed 恒同序(可复现,别用 `Math.random`)
  - `buildSession(opts: { name: string; matchId: string; roundSeq?: number; deep: DeepFindingInput[]; legacy: LegacyRound; matchesDir: string }): ReviewSession` — deep 卡预筛 + 基线卡(source 短路 `verified`)→ 合并 → `seededShuffle(cards, name)` → `cardId = "c" + index`(打散后编号,编号不泄露来源)
- Produces(脚本):`npx tsx packages/eval/scripts/buildReviewSession.ts --name <name> --match <id> [--round N] [--store <dir>]` — 读 `$GLADLOG_EVAL_HOME/review-sessions/<name>.deep.json`,写 `<name>.session.json`(tmp+rename;`resolveEvalHome()` from `packages/eval/src/evalHome.ts`,目录不存在则 mkdir)

- [ ] **Step 1: Write the failing test**

```ts
// packages/eval/test/explore.buildSession.test.ts
import { describe, expect, it } from "vitest";
import { prescreen, seededShuffle } from "../src/explore/buildSession";

describe("prescreen", () => {
  const query = (argv: string[]) => {
    if (argv[0] !== "cd") throw new Error("usage");
    return ["## cd @ 1:33", "1:33 Foo ready: 圣盾术 | onCd: 圣光术"];
  };
  it("verifies a line that the query reproduces", () => {
    const [r] = prescreen(
      [{ cmd: "cd --t 93", line: "1:33 Foo ready: 圣盾术 | onCd: 圣光术" }],
      query,
    );
    expect(r.verdict).toBe("verified");
  });
  it("flags a line the query does not reproduce as mismatch", () => {
    const [r] = prescreen(
      [{ cmd: "cd --t 93", line: "1:33 Foo ready: 圣光术" }],
      query,
    );
    expect(r.verdict).toBe("mismatch");
  });
  it("flags an invalid cmd as unverifiable", () => {
    const [r] = prescreen([{ cmd: "nope --t 1", line: "x" }], query);
    expect(r.verdict).toBe("unverifiable");
  });
});

describe("seededShuffle", () => {
  it("is deterministic per seed and permutes", () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "s1");
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "s1")).toEqual(a);
    expect(a.slice().sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
```

- [ ] **Step 2: Run → FAIL**;**Step 3: Implement `buildSession.ts`**;**Step 4: Run → PASS**

- [ ] **Step 5: Implement 脚本薄壳 + manual smoke**(拿 Task 3 的 `$ID`,手写一个 2 条的 `<name>.deep.json`——其中 1 条 evidence 故意抄错一个数字——跑构建,`jq` 检查 session:卡片数 = deep 2 + 基线 N、抄错那条 verdict === "mismatch")

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/buildSession.ts packages/eval/scripts/buildReviewSession.ts packages/eval/test/explore.buildSession.test.ts
git commit -m "feat(eval): 机器预筛(runQuery 单源核真)+ 评审会话构建"
```

---

### Task 6: `MatchReport` 外部跳转入口(唯一的产品 src 改动)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(props 区 ~:75-104,`handleSeekEvent` 区 ~:145-174)
- Test: `packages/desktop/test/report.externalseek.test.tsx`

**Interfaces:**

- Produces: `MatchReport` 新可选 prop `externalSeek?: { tSeconds: number; unitNames: string[]; nonce: number } | null`(default null,不传 = 现状零变化)。消费方式:

```tsx
useEffect(() => {
  if (!externalSeek) return;
  handleSeekEvent(externalSeek.tSeconds, externalSeek.unitNames);
  // nonce 变一次跳一次;沿用 seekReq 既有的 nonce 防重语义
}, [externalSeek?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 1: Write the failing test**(**照抄 `packages/desktop/test/report.evidenceseek.test.tsx` 的现有搭建**——fixture 装载、`__gladlogFixture` mock、render 方式全部沿用,只改断言目标)

```tsx
// packages/desktop/test/report.externalseek.test.tsx —— 骨架,搭建部分抄 evidenceseek
it("externalSeek prop switches to replay view at the given time", async () => {
  const { rerender } = renderMatchReport({ externalSeek: null }); // 沿用该文件的 helper 写法
  rerender(
    withProps({ externalSeek: { tSeconds: 42, unitNames: ["Foo"], nonce: 1 } }),
  );
  await waitFor(() => {
    expect(
      document.querySelector(".rpt-view-tabs button.active")?.textContent,
    ).toContain("回放");
  });
});
```

- [ ] **Step 2: Run → FAIL**(`npm test --workspace=packages/desktop -- report.externalseek`)
- [ ] **Step 3: Implement**(prop + effect,≤10 行)
- [ ] **Step 4: Run → PASS**;再全量 `npm test --workspace=packages/desktop` 确认无回归
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/test/report.externalseek.test.tsx
git commit -m "feat(desktop): MatchReport externalSeek 受控跳转 prop(惰性,评审工作台用)"
```

---

### Task 7: 评审 API(vite dev 中间件)

**Files:**

- Create: `packages/desktop/dev/review/reviewApi.ts`
- Modify: `packages/desktop/dev/vite.config.mts`(plugins 数组加一项)
- Test: `packages/desktop/dev/review/reviewApi.test.ts`

**Interfaces:**

- Produces:
  - `reviewApiPlugin(opts?: { evalHome?: string; matchesDir?: string }): Plugin` — `configureServer` 挂 `server.middlewares.use("/__review", handler)`。只需 dev 模式(视觉回归走 preview,不受影响,也**不要**加 `configurePreviewServer`)。
  - `handleReviewRequest(req: { method: string; url: string; body: string }, io: { readFile(p): string | null; writeFileAtomic(p, data): void; listDir(p): string[] }): { status: number; body: string }` — 纯路由逻辑,单独导出可测。
- 路由(全部 JSON):
  - `GET /__review/list` → `{ sessions: string[] }`(`<evalHome>/review-sessions/*.session.json` 的 name 列表)
  - `GET /__review/session/<name>` → `<name>.session.json` 内容;404 → `{ error }`
  - `GET /__review/match/<id>` → `<matchesDir>/<id>/match.json` 内容
  - `GET /__review/answers/<name>` → `<name>.answers.json`,不存在返回 `{ schemaVersion: 1, name, answers: [] }`
  - `POST /__review/answers/<name>` → body 整体覆盖写(tmp+rename)
- 路径安全:`<name>`/`<id>` 只允许 `/^[A-Za-z0-9._-]+$/`,否则 400(防目录穿越)。
- evalHome 解析:`import { resolveEvalHome } from "../../../eval/src/evalHome"`(vite.config 是 Node 侧 esbuild 打包,跨包相对 TS import 可行);matchesDir 默认 `join(homedir(), "Library/Application Support/gladlog/matches")`,`GLADLOG_MATCH_DIR` env 可覆盖。

- [ ] **Step 1: Write the failing test**(`handleReviewRequest` 纯函数 + 内存 io stub:list/get/post 往返、404、非法 name 400)

```ts
// packages/desktop/dev/review/reviewApi.test.ts
import { describe, expect, it } from "vitest";
import { handleReviewRequest } from "./reviewApi";

function memIo(files: Record<string, string> = {}) {
  return {
    files,
    readFile: (p: string) => files[p] ?? null,
    writeFileAtomic: (p: string, d: string) => {
      files[p] = d;
    },
    listDir: (p: string) =>
      Object.keys(files)
        .filter((f) => f.startsWith(p))
        .map((f) => f.slice(p.length + 1)),
  };
}

describe("handleReviewRequest", () => {
  it("answers roundtrip: POST then GET returns the same doc", () => {
    const io = memIo();
    const doc = JSON.stringify({ schemaVersion: 1, name: "exp1", answers: [] });
    expect(
      handleReviewRequest(
        { method: "POST", url: "/__review/answers/exp1", body: doc },
        io,
      ).status,
    ).toBe(200);
    const got = handleReviewRequest(
      { method: "GET", url: "/__review/answers/exp1", body: "" },
      io,
    );
    expect(JSON.parse(got.body)).toEqual(JSON.parse(doc));
  });
  it("missing session is 404", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/nope", body: "" },
        memIo(),
      ).status,
    ).toBe(404);
  });
  it("path traversal name is 400", () => {
    expect(
      handleReviewRequest(
        { method: "GET", url: "/__review/session/..%2Fx", body: "" },
        memIo(),
      ).status,
    ).toBe(400);
  });
});
```

- [ ] **Step 2: Run → FAIL**(`npm test --workspace=packages/desktop -- reviewApi`;dev/ 下测试随 desktop vitest 跑,先例 `dev/scenes.test.ts`)
- [ ] **Step 3: Implement**(`reviewApiPlugin` 里把 node req 读成 body 串后调 `handleReviewRequest`,真 io 用 `readFileSync`/tmp+rename/`readdirSync`)
- [ ] **Step 4: Run → PASS**;`dev/vite.config.mts` 的 `plugins: [react()]` 改为 `plugins: [react(), reviewApiPlugin()]`
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/dev/review/reviewApi.ts packages/desktop/dev/review/reviewApi.test.ts packages/desktop/dev/vite.config.mts
git commit -m "feat(desktop-dev): 评审 API vite dev 中间件(会话/对局/标注读写)"
```

---

### Task 8: `ReviewPanel` 组件 + 汇总

**Files:**

- Create: `packages/desktop/dev/review/summary.ts`
- Create: `packages/desktop/dev/review/ReviewPanel.tsx`
- Test: `packages/desktop/dev/review/summary.test.ts`、`packages/desktop/dev/review/ReviewPanel.test.tsx`

**Interfaces:**

- Consumes: `reviewTypes`(相对 import `../../../eval/src/explore/reviewTypes`)。
- Produces(`summary.ts`):
  - `summarize(session: ReviewSession, answers: ReviewAnswer[]): { bySource: Record<"deep" | "baseline", { total: number; answered: number; novelValuable: number; dims: Record<string, Record<string, number>> }> }` — `novelValuable` 按 spec 操作定义:`truth === "true" && awareness === "unaware" && (impact === "high" || impact === "med")`。
- Produces(`ReviewPanel.tsx`):

```tsx
export function ReviewPanel(props: {
  session: ReviewSession;
  answers: ReviewAnswer[]; // 已有标注(启动读回)
  onSave(answers: ReviewAnswer[]): void; // 每答一题整体回写(POST)
  onSeek(card: ReviewCard): void; // → externalSeek
}): JSX.Element;
```

行为:

- 队列态:进度 `k/N`;当前卡片显示 claim、`fmtTime(anchorT)` 时刻章(点击 = `onSeek`)、证据行列表(**只显示 `line` 文本;verdict 与 source 在揭盲前一律不渲染**)。
- 五问各一行按钮组(单选,选中高亮),文案:属实吗[属实/有出入/不属实/看不出来]、打的时候我意识到了吗[知道/模糊/完全没意识到]、建议可执行吗[有具体动作/太泛/不可操作]、下一场会照做吗[会/也许/不会]、对胜负影响[高/中/低/无关];note 一个 `<textarea>`;「下一张」按钮仅五问齐了可点,点击组装 `ReviewAnswer`(`answeredAt: Date.now()`)调 `onSave` 并前进;支持「上一张」改答案。
- 全部答完 → 揭盲视图:`summarize` 结果表(deep vs baseline 分列:总数/验真新发现数/各维分布)+ 逐卡列表(此时显示 source 徽章与每条 evidence 的 verdict 徽章)。
- 样式:内联 `<style>` 或 `dev/harness.css` 追加 `.review-*` 类,**不改产品 `styles.css`**。

- [ ] **Step 1: Write failing tests**

```ts
// packages/desktop/dev/review/summary.test.ts
import { describe, expect, it } from "vitest";
import { summarize } from "./summary";
import type {
  ReviewAnswer,
  ReviewCard,
  ReviewSession,
} from "../../../eval/src/explore/reviewTypes";

const card = (cardId: string, source: "deep" | "baseline"): ReviewCard => ({
  cardId,
  source,
  claim: "c",
  anchorT: 10,
  unitNames: [],
  evidence: [],
});
const session: ReviewSession = {
  schemaVersion: 1,
  name: "s",
  matchId: "m",
  createdAt: 1,
  cards: [
    card("c0", "deep"),
    card("c1", "deep"),
    card("c2", "baseline"),
    card("c3", "baseline"),
  ],
};
const ans = (cardId: string, over: Partial<ReviewAnswer>): ReviewAnswer => ({
  cardId,
  truth: "true",
  awareness: "knew",
  actionable: "concrete",
  adopt: "yes",
  impact: "low",
  note: "",
  answeredAt: 1,
  ...over,
});

describe("summarize", () => {
  it("counts answered per source and novelValuable by the operational definition", () => {
    const answers = [
      ans("c0", { awareness: "unaware", impact: "med" }), // deep: novel & valuable
      ans("c1", { awareness: "unaware", impact: "low" }), // impact 不够,不算
      ans("c2", { truth: "false", awareness: "unaware", impact: "high" }), // 不属实,不算
    ];
    const s = summarize(session, answers);
    expect(s.bySource.deep.answered).toBe(2);
    expect(s.bySource.deep.novelValuable).toBe(1);
    expect(s.bySource.baseline.answered).toBe(1);
    expect(s.bySource.baseline.novelValuable).toBe(0);
    expect(s.bySource.baseline.total).toBe(2);
  });
});
```

```tsx
// packages/desktop/dev/review/ReviewPanel.test.tsx(render/fireEvent 搭建照 desktop 现有组件测试)
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
// session 复用 summary.test 的构造思路:2 卡(deep, baseline),evidence 各 1 条 verdict: "verified"

describe("ReviewPanel", () => {
  it("gates 下一张 on all five answers and reports the answer", () => {
    const onSave = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={onSave}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    const next = screen.getByRole("button", { name: "下一张" });
    expect(next).toHaveProperty("disabled", true);
    for (const label of ["属实", "知道", "有具体动作", "会", "中"])
      fireEvent.click(screen.getByRole("button", { name: label }));
    expect(next).toHaveProperty("disabled", false);
    fireEvent.click(next);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0].cardId).toBe(
      twoCardSession.cards[0].cardId,
    );
  });

  it("seeks on anchor chip click and hides source until finished", () => {
    const onSeek = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={() => {}}
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByText("0:10")); // fmtTime(anchorT)
    expect(onSeek.mock.calls[0][0].cardId).toBe(twoCardSession.cards[0].cardId);
    expect(screen.queryByText(/深挖|baseline|deep/)).toBeNull(); // 盲评期间无来源徽章
  });

  it("shows reveal summary with source badges after all cards answered", () => {
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={fullAnswersForBoth}
        onSave={() => {}}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/验真新发现/)).toBeTruthy();
    expect(screen.getAllByText(/深挖|现有管线/).length).toBeGreaterThan(0);
  });
});
```

(`twoCardSession` / `fullAnswersForBoth` 为文件内常量,构造同 summary.test。)

- [ ] **Step 2: Run → FAIL**;**Step 3: Implement**;**Step 4: Run → PASS**
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/dev/review/summary.ts packages/desktop/dev/review/ReviewPanel.tsx packages/desktop/dev/review/summary.test.ts packages/desktop/dev/review/ReviewPanel.test.tsx
git commit -m "feat(desktop-dev): ReviewPanel 五问卡片 + 揭盲汇总(盲评期间不渲染来源/预筛)"
```

---

### Task 9: `?review=` 模式接线 + 真机走查 + 运行手册

**Files:**

- Create: `packages/desktop/dev/review/ReviewMode.tsx`
- Modify: `packages/desktop/dev/main.tsx`(模式分派处;scene 判定优先,review 次之,最后 Harness)
- Create: `docs/commands/deepdive-probe.md`

**Interfaces:**

- Consumes: Task 6 `externalSeek`、Task 7 API、Task 8 `ReviewPanel`。
- Produces(`ReviewMode.tsx`):

```tsx
export function ReviewMode(props: { name: string }): JSX.Element;
```

行为:

1. `fetch("/__review/session/" + name)` → `ReviewSession`;`fetch("/__review/match/" + session.matchId)` → StoredMatch doc;shuffle 时按 `session.roundSeq` 取 `doc.data.rounds[…]`(round 提取逻辑与 Task 1 `loadLegacyRound` 同构,但这里是浏览器侧,对 doc.data 的处理**照抄 dev/main.tsx 现有 local fixture 的消费路径**——full-match.json 怎么变成 `source`,这里就怎么变);`fetch("/__review/answers/" + name)` → 已有标注。
2. 布局:`display: flex`,左 `<MatchReport source={…} matchId={session.matchId} externalSeek={seek} />`(flex: 1),右 `<ReviewPanel …>`(固定 380px,独立滚动)。
3. `onSeek(card) => setSeek({ tSeconds: card.anchorT, unitNames: card.unitNames, nonce: Date.now() })`;`onSave(answers) => fetch(POST /__review/answers/<name>)`(失败 `console.error` + 顶部红条提示,不吞)。
4. 模块级 mock:review 模式复用 main.tsx 既有 slim mock,但把 `analysis.getState` 覆盖为空结果(AI tab 不出假 findings 干扰盲评)。

- main.tsx 分派:`const review = new URLSearchParams(window.location.search).get("review")`;`scene` 命中走 Scene(现状),否则 `review` 非空走 `<ReviewMode name={review} />`,否则 Harness。**不改 `scenes.ts`**(review 不是 scene,不进视觉基线)。

- [ ] **Step 1: Implement `ReviewMode` + main.tsx 接线**(dev 代码,以真机走查为主验证;`scenes.test.ts` 不受影响——跑一次确认)

- [ ] **Step 2: 真机端到端走查(run-ui 流程)**

```bash
cd packages/desktop && npm run dev:ui   # 后台常驻
```

用 Task 5 造好的真实会话:浏览器开 `http://localhost:5199/?review=<name>`,依次核对:
① 左侧战报正常渲染该真实对局;② 右侧 1/N 卡片、证据行可见、无 source/verdict 徽章;③ 点时刻章 → 左侧切回放并跳到锚点;④ 答完一张刷新页面 → 进度保留(标注读回);⑤ 全答完 → 揭盲汇总出现;⑥ `cat $GLADLOG_EVAL_HOME/review-sessions/<name>.answers.json` 内容与 UI 一致。
用 claude-in-chrome 截图逐项确认,**每项都要真看到**。

- [ ] **Step 3: Write `docs/commands/deepdive-probe.md`**(单语中文)。内容必须含:
  1. 选局:`matchExplore pick` → 选本人、>2 分钟、有死亡/转折的一场。
  2. 深挖代理开场提示词全文(直接可粘进新 Claude Code 会话):角色 = 用最强模型深挖此局;工具 = `matchExplore` 全部子命令用法表;纪律 = 先 overview 通读 → 提假设 → 查数据行验证 → 连续两轮无新发现即停;产出格式 = `<name>.deep.json` 的 `DeepFindingInput[]` schema 全文,**每条 evidence 的 `line` 必须原样复制自某次查询输出、`cmd` 为该次查询参数串**,编不出证据的结论不许写。
  3. 构建 + 评审 + 揭盲的命令序列(Task 3/5 的命令 + `?review=` URL)。
  4. 参考层(不作裁决):agy/Gemini 对 findings 独立审一遍、七维判官照跑,结论只并列展示。
  5. 单盘收尾:把揭盲汇总(deep vs baseline 的验真新发现数、幻觉数、参考层意见)追记到 `$GLADLOG_EVAL_HOME/ledger.md`。

- [ ] **Step 4: push 前全量检查**

```bash
npm test --workspace=packages/desktop && npm -w @gladlog/eval run test && npm run typecheck && npx eslint . --quiet
```

Expected: 全绿。红了修到绿,不许跳过。

- [ ] **Step 5: Commit + push**

```bash
git add packages/desktop/dev/review/ReviewMode.tsx packages/desktop/dev/main.tsx docs/commands/deepdive-probe.md
git commit -m "feat(desktop-dev): ?review= 评审模式接线 + 深挖上限实验运行手册"
git push
```

---

## 完成定义

代码全部落地只是地基;实验本身(跑一盘)按 `docs/commands/deepdive-probe.md` 走,产出三样:上限报告、金标集(answers 累积)、可蒸馏清单。第一盘跑完前不下「深挖是否更好」的结论——**修复要给前后数字,实验要给逐条标注**。
