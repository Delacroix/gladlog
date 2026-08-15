# Judge Noise Floor Refactoring (Subproject A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change accuracy scoring to be deterministically calculated from factAudit (zero scoring freedom for judges), introduce K=3 multi-judge median per dimension for A/B blind evaluation, and accept using three criteria (spec:`docs/superpowers/specs/2026-08-05-judge-noise-floor-design.md`).

**Architecture:** Judge behavior remains almost unchanged (already writing line-by-line factAudit), only adding a `severity: "minor"|"fabricated"` field on non-verified entries; `checkScoreProvenance` adds `computeAccuracyFromFactAudit` to check against table and forces the accuracy written by judge to equal the computed value. K replicates fall into `abCompareStats`: collect `<blindId>.json` / `<blindId>.rN.json` copies for each blind item, dimension-wise median aggregation followed by existing paired bootstrap. Acceptance experiments reuse B's Arm O materials + new planting tool to create |Δ|≈0.2 known difference.

**Tech Stack:** TypeScript ESM(`packages/eval`,vitest,现有 provenance/ab 基建)。

## Global Constraints

- 工作目录:`/Users/mingjianliu/code/gladlog/.claude/worktrees/eval-engineering`,分支 `worktree-eval-engineering`。**每个子代理开工前 `pwd` 硬检查**。
- **守卫 hook 拦截含字面 `eval` 的 Bash 命令**:命令一律写 `packages/ev[a]l/...`(zsh glob);无管道、无 `2>&1`;Read/Write/Edit 工具不受限。
- 测试:`npm test --workspace packages/ev[a]l`(单文件加 `-- test/<file>.test.ts`);类型检查 `npm run typecheck`(绝不 tsc -b)。
- ESM:运行时相对导入带 `.js` 后缀。
- score JSON 契约保持七维 1–5 整数不变(spec 设计一:accuracy 字段仍写,但值必须等于查表计算值)。
- 查表规则与 `docs/commands/eval-baseline.md` rubric 逐字一致:5=零错、4=恰 1 处小错、3=恰 2 处小错、2=3 处及以上、1=任一捏造。
- K 重规则(spec 设计二):仅 A/B 盲评;副本命名 `<blindId>.r1.json`/`.r2.json`/`.r3.json`;K 模式下某件不足 2 份 ⇒ 整对按缺分丢弃并计数;恰 2 份 ⇒ 取均值并标注;legacy 单文件 `<blindId>.json` 池(K=1)必须继续可用。
- 判官/responder 子代理一律 sonnet。
- commit 尾部两行 trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01EXwJzrHdi7KDEmDetnfWxZ`

---

### Task 1: `computeAccuracyFromFactAudit` + severity 校验 + accuracy 一致性门

**Files:**

- Modify: `packages/eval/src/provenance/checkScoreProvenance.ts`(在 `FACT_AUDIT_VERDICTS` 之后新增常量与函数;在校验环节 (d) 内加 severity 校验;新增环节 (f))
- Modify: `packages/eval/test/provenance.test.ts`(新增 describe 块;既有 fixture 机械适配)

**Interfaces:**

- Consumes: 既有 `FACT_AUDIT_VERDICTS`(`["verified","refuted","unsupported"]`)、`checkScoreProvenance(runDir)` 的 (a)–(e) 校验结构(见该文件 66–261 行)。
- Produces(后续任务依赖的精确签名):
  - `export const FACT_AUDIT_SEVERITIES = ["minor", "fabricated"] as const;`
  - `export function computeAccuracyFromFactAudit(entries: { verdict: string; severity?: string }[]): 1 | 2 | 3 | 4 | 5`
  - `checkScoreProvenance` 新失败理由字面量:`factAudit non-verified entries must carry severity minor/fabricated` 与 `accuracy <X> does not match factAudit-derived <Y>`(Task 3/6 依赖此语义,Task 2 文档引用)。

- [ ] **Step 1: Write the failing test(新增 describe 块到 test/provenance.test.ts 末尾;不改动既有用例的本步)**

```typescript
describe("computeAccuracyFromFactAudit(子项目 A 设计一)", () => {
  const v = (verdict: string, severity?: string) => ({
    claim: "c",
    evidence: "e",
    verdict,
    ...(severity ? { severity } : {}),
  });

  it("零错 → 5;1/2 小错 → 4/3;≥3 小错 → 2", () => {
    expect(computeAccuracyFromFactAudit([v("verified")])).toBe(5);
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("refuted", "minor")]),
    ).toBe(4);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("unsupported", "minor"),
      ]),
    ).toBe(3);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("unsupported", "minor"),
      ]),
    ).toBe(2);
  });

  it("任一 fabricated → 1,与小错条数无关", () => {
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("refuted", "fabricated")]),
    ).toBe(1);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("unsupported", "fabricated"),
      ]),
    ).toBe(1);
  });

  it("unsupported 与 refuted 同为 1 错(causal-hardening 先例)", () => {
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("unsupported", "minor")]),
    ).toBe(4);
  });
});
```

再新增校验器行为用例(同文件;fixture 写法照本文件既有用例的 tmpdir + JSON 落盘模式,完整自包含):

```typescript
describe("checkScoreProvenance:severity 与 accuracy 一致性(子项目 A)", () => {
  // 自包含的 tmpdir run 构造器:除被测点外全合格。
  // (import 需要:crypto 的 createHash、fs-extra、os、path —— 若文件顶部已有则复用。)
  async function makeRun(
    factAudit: Record<string, unknown>[],
    accuracy: number,
  ): Promise<string> {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "prov-a-"));
    await fs.ensureDir(path.join(runDir, "prompts"));
    await fs.ensureDir(path.join(runDir, "responses"));
    await fs.ensureDir(path.join(runDir, "scores"));
    const promptText = "PROMPT body";
    const responseText = "RESPONSE body";
    await fs.writeFile(
      path.join(runDir, "prompts", "001-mid.txt"),
      promptText,
      "utf8",
    );
    await fs.writeFile(
      path.join(runDir, "responses", "001.txt"),
      responseText,
      "utf8",
    );
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    await fs.writeJson(path.join(runDir, "scores", "001.json"), {
      ordinal: 1,
      matchId: "mid",
      spec: "Holy Paladin",
      result: "Loss",
      factAudit,
      prompt: {
        sufficiency: 4,
        noise: 3,
        labelBias: 4,
        inferenceScaffolding: 4,
      },
      response: { accuracy, outcomeAlignment: 4, focusCalibration: 4 },
      provenance: {
        judgeModel: "test-judge",
        judgedAt: "2026-08-05T00:00:00Z",
        promptSha256: sha(promptText),
        responseSha256: sha(responseText),
      },
    });
    return runDir;
  }
  const fa = (verdict: string, severity?: string) => ({
    claim: "claim text",
    evidence: "evidence line",
    verdict,
    ...(severity ? { severity } : {}),
  });

  it("非 verified 条目缺 severity ⇒ FAIL(理由含 severity)", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("refuted")],
      4,
    );
    const res = checkScoreProvenance(runDir);
    expect(res.fail).toBe(1);
    expect(res.failures[0].reason).toMatch(/severity/);
  });

  it("accuracy 与计算值不符 ⇒ FAIL(理由含 factAudit-derived)", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("verified")],
      4, // 计算值应为 5
    );
    const res = checkScoreProvenance(runDir);
    expect(res.fail).toBe(1);
    expect(res.failures[0].reason).toMatch(/factAudit-derived/);
  });

  it("accuracy 等于计算值且 severity 齐全 ⇒ OK", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("refuted", "minor")],
      4,
    );
    const res = checkScoreProvenance(runDir);
    expect(res.ok).toBe(1);
    expect(res.fail).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/provenance.test.ts`
Expected: FAIL,`computeAccuracyFromFactAudit` 未导出。

- [ ] **Step 3: Write implementation(checkScoreProvenance.ts)**

在 `FACT_AUDIT_MIN/MAX` 之后新增:

```typescript
export const FACT_AUDIT_SEVERITIES = ["minor", "fabricated"] as const;

/**
 * 子项目 A 设计一:accuracy 由 factAudit 确定性计算,判官无打分自由度。
 * 查表与 docs/commands/eval-baseline.md rubric 逐字一致:
 * 任一 fabricated → 1;否则按非 verified 条数:0→5, 1→4, 2→3, ≥3→2。
 * unsupported 与 refuted 同计为错(causal-hardening 规则 5 的既有语义)。
 */
export function computeAccuracyFromFactAudit(
  entries: { verdict: string; severity?: string }[],
): 1 | 2 | 3 | 4 | 5 {
  const errors = entries.filter((e) => e.verdict !== "verified");
  if (errors.some((e) => e.severity === "fabricated")) return 1;
  if (errors.length === 0) return 5;
  if (errors.length === 1) return 4;
  if (errors.length === 2) return 3;
  return 2;
}
```

校验环节 (d) 的 factAudit 条目循环内,verdict 枚举检查之后追加:

```typescript
if (
  e.verdict !== "verified" &&
  (typeof e.severity !== "string" ||
    !(FACT_AUDIT_SEVERITIES as readonly string[]).includes(e.severity))
) {
  failReason =
    "factAudit non-verified entries must carry severity minor/fabricated";
  hasFailed = true;
  break;
}
```

校验环节 (e) 之后新增环节 (f)(放在 (e) 通过之后、最终计数之前):

```typescript
// (f) accuracy must equal the factAudit-derived value (design A-1: the
// judge has zero scoring freedom on this dimension; see
// docs/superpowers/specs/2026-08-05-judge-noise-floor-design.md)
if (!hasFailed) {
  const response = score.response as Record<string, unknown> | undefined;
  const factAudit = score.factAudit as {
    verdict: string;
    severity?: string;
  }[];
  const derived = computeAccuracyFromFactAudit(factAudit);
  if (response?.accuracy !== derived) {
    failReason = `accuracy ${String(response?.accuracy)} does not match factAudit-derived ${derived}`;
    hasFailed = true;
  }
}
```

- [ ] **Step 4: 机械适配本文件既有 fixture**

规则(逐个既有用例过一遍,机械执行):凡 fixture 的 factAudit 含 verdict ≠ "verified" 的条目,给该条目加 `severity: "minor"`;凡 fixture 走到「应当 OK」路径的,把 `response.accuracy` 改为该 fixture factAudit 的计算值(用上面的口算规则);「应当 FAIL 于更早环节」的 fixture 不动 accuracy(早环节先挡,(f) 不会执行)。

- [ ] **Step 5: Run full eval suite to verify no regressions**

Run: `npm test --workspace packages/ev[a]l`,再 `npm run typecheck`
Expected: 全绿(若 auditors/judgeVariance 等其他测试的 fixture 也过 `checkScoreProvenance` 而挂掉,按 Step 4 同一规则适配那些 fixture;与校验器无关的测试不许动)。

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/provenance/checkScoreProvenance.ts packages/eval/test/provenance.test.ts
git commit -m "feat(eval): accuracy 确定性化 —— factAudit severity 字段 + computeAccuracyFromFactAudit 查表 + provenance 一致性门"
```

(git add 路径在命令里写 `packages/ev[a]l/...`,下同不再注明;若 Step 5 动了其他测试文件一并 add。)

---

### Task 2: rubric 与 score 契约改写(eval-baseline.md)+ 文档钉扎测试

**Files:**

- Modify: `docs/commands/eval-baseline.md`(accuracy 一节 183–193 行区域;score 契约 205–242 行区域)
- Modify: `packages/eval/test/factAuditBounds.test.ts`(追加查表行钉扎断言)

**Interfaces:**

- Consumes: Task 1 的 `computeAccuracyFromFactAudit` 语义与两个失败理由字面量。
- Produces: 判官读的 rubric 文本(Task 6 验收判官照此执行);钉扎断言(文档查表行与代码常量不许各自漂移)。

- [ ] **Step 1: 改写 accuracy 一节**

将 `- **accuracy** —` 起的整个条目替换为(查表数字一字不改,新增产出规范):

```markdown
- **accuracy** — 回复是否只引用 prompt 里存在的事件?**本维分数由系统从 factAudit 计算(checkScoreProvenance 的 computeAccuracyFromFactAudit),判官不自由打分**:你写入 `response.accuracy` 的值必须等于按下表从你自己的 factAudit 算出的值,不等即整份作废。
  - 5: 零错。
  - 4: 恰 1 处小错。
  - 3: 恰 2 处小错。
  - 2: 3 处及以上小错。
  - 1: 任一**捏造**(法术/窗口/死亡),或给已死/不在场玩家提建议 —— 与小错条数无关,见到即 1。
  - 错 = factAudit 中 verdict 为 `refuted` 或 `unsupported` 的条目;每个非 verified 条目**必须**带 `severity` 字段:`minor`(小错 = 时间戳差几秒、数值差一档、次要触发认错名)或 `fabricated`(捏造)。
  - （旧锚点允许判官在查表外自由裁量;2026-07-20 实测三个判官对同一个错给出 3/3/4 与 3/4/4。确定性计算消掉最后一段自由度 —— 2026-08-05 子项目 A。）
  - F193 条款:锚定 `[CONTESTED]` 行、保持试探措辞(≤Medium 置信,不下断言)的换血权衡讨论**不算**捏造或 unsupported——该行本身就是 prompt 事实;只有当回复把它硬化成结论("你当时就该 CC")或脱离锚点自造场景时才记错。
```

- [ ] **Step 2: 改写 score 契约的 factAudit 示例与说明**

契约 JSON 里 factAudit 示例条目加一条非 verified 示例:

```json
{
  "claim": "回复中承重主张的原文引用。",
  "verdict": "refuted",
  "severity": "minor",
  "evidence": "证伪它的确切 prompt 行(含时间戳)。"
}
```

契约说明段(242 行区域)追加一句:`verdict` 非 `verified` 的条目必须带 `severity` ∈ `minor` / `fabricated`;`response.accuracy` 必须等于 `computeAccuracyFromFactAudit` 的计算值(2026-08-05 起,checkProvenance 强制;更早的历史 run 用当时的校验器校验,不回溯重验)。

- [ ] **Step 3: factAuditBounds.test.ts 追加钉扎断言**

在既有 describe 内追加(该测试已有读取 eval-baseline.md 全文的变量,复用同一读取):

```typescript
it("accuracy 查表行与 computeAccuracyFromFactAudit 语义钉扎(子项目 A)", () => {
  // 文档侧:五条查表行必须逐字在场
  for (const line of [
    "5: 零错。",
    "4: 恰 1 处小错。",
    "3: 恰 2 处小错。",
    "2: 3 处及以上小错。",
  ])
    expect(doc).toContain(line);
  expect(doc).toContain("任一**捏造**");
  expect(doc).toContain("computeAccuracyFromFactAudit");
  expect(doc).toContain("severity");
  // 代码侧:同一语义(等值断言,CLAUDE.md 的 markdown↔代码备选路)
  const m = (n: number) =>
    computeAccuracyFromFactAudit(
      Array.from({ length: n }, () => ({
        verdict: "refuted",
        severity: "minor",
      })),
    );
  expect([m(0), m(1), m(2), m(3), m(4)]).toEqual([5, 4, 3, 2, 2]);
  expect(
    computeAccuracyFromFactAudit([
      { verdict: "refuted", severity: "fabricated" },
    ]),
  ).toBe(1);
});
```

(import 行加 `computeAccuracyFromFactAudit`,来源 `../src/provenance/checkScoreProvenance`。)

- [ ] **Step 4: Run tests**

Run: `npm test --workspace packages/ev[a]l -- test/factAuditBounds.test.ts`,然后全量 `npm test --workspace packages/ev[a]l`
Expected: PASS;全量无新失败。

- [ ] **Step 5: Commit**

```bash
git add docs/commands/eval-baseline.md packages/eval/test/factAuditBounds.test.ts
git commit -m "docs(eval): accuracy rubric 改确定性产出规范(severity 字段+系统计算声明)+ 查表行钉扎测试"
```

---

### Task 3: K 重副本聚合(abCompareStats)

**Files:**

- Modify: `packages/eval/src/ab/abCompareStats.ts`
- Modify: `packages/eval/test/abStats.test.ts`(追加 describe 块)

**Interfaces:**

- Consumes: Task 1 的 `computeAccuracyFromFactAudit`;既有 `ScoreFile`、`dimensionScore`、`DIMENSIONS`、main() 的 mapping/scores 装载结构(该文件 125–247 行)。
- Produces(Task 6 依赖):
  - `export function medianOf(values: number[]): number`(排序取中;偶数取两中值均值)
  - `export function collectReplicateFiles(scoresDir: string, blindId: string): string[]`(`<id>.json` + `<id>.rN.json`,N 升序,存在的才返回)
  - `export function aggregateReplicates(reps: ScoreFile[]): { score: ScoreFile; accuracyMismatches: number } | null`(0 份 → null;逐维中位数;每份的 accuracy 若与其 factAudit 计算值不符,以计算值参与聚合并计数 mismatch)
  - main() 行为:K 模式(池内任一件存在 `.rN` 副本)下,<2 份的件按缺分整对丢弃并计数;恰 2 份聚合但计入 `twoReplicateItems` 警告;`comparison-stats.json` 新增字段 `replicateSummary: { kMode: boolean; itemsDropped: number; twoReplicateItems: number; accuracyMismatches: number }`。

- [ ] **Step 1: Write the failing test(追加到 test/abStats.test.ts)**

```typescript
import {
  aggregateReplicates,
  collectReplicateFiles,
  medianOf,
} from "../src/ab/abCompareStats";
import fs from "fs-extra";
import os from "os";
import path from "path";

describe("K 重副本聚合(子项目 A 设计二)", () => {
  const rep = (accuracy: number, extra?: Record<string, number>) => ({
    factAudit:
      accuracy === 5
        ? [{ claim: "c", evidence: "e", verdict: "verified" }]
        : [
            { claim: "c", evidence: "e", verdict: "verified" },
            ...Array.from({ length: 5 - accuracy }, () => ({
              claim: "c",
              evidence: "e",
              verdict: "refuted",
              severity: "minor",
            })),
          ],
    prompt: {
      sufficiency: 4,
      noise: 3,
      labelBias: 4,
      inferenceScaffolding: 4,
      ...extra,
    },
    response: { accuracy, outcomeAlignment: 4, focusCalibration: 4 },
  });

  it("medianOf:奇数取中、偶数取均值", () => {
    expect(medianOf([3, 5, 4])).toBe(4);
    expect(medianOf([3, 4])).toBe(3.5);
    expect(medianOf([2])).toBe(2);
  });

  it("collectReplicateFiles:legacy 单文件与 .rN 副本都能收齐,N 升序", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krep-"));
    await fs.writeJson(path.join(dir, "item-01.r2.json"), {});
    await fs.writeJson(path.join(dir, "item-01.r1.json"), {});
    await fs.writeJson(path.join(dir, "item-02.json"), {});
    expect(
      collectReplicateFiles(dir, "item-01").map((p) => path.basename(p)),
    ).toEqual(["item-01.r1.json", "item-01.r2.json"]);
    expect(
      collectReplicateFiles(dir, "item-02").map((p) => path.basename(p)),
    ).toEqual(["item-02.json"]);
    expect(collectReplicateFiles(dir, "item-03")).toEqual([]);
  });

  it("aggregateReplicates:逐维中位数;accuracy 以 factAudit 计算值为准并计 mismatch", () => {
    const bad = rep(4);
    (bad.response as { accuracy: number }).accuracy = 5; // 谎报:factAudit 只支持 4
    const out = aggregateReplicates([
      rep(3) as never,
      rep(5) as never,
      bad as never,
    ]);
    expect(out).not.toBeNull();
    // accuracy 参与值 = [3, 5, 4(计算值)] → 中位数 4
    expect(out!.score.response!.accuracy).toBe(4);
    expect(out!.accuracyMismatches).toBe(1);
    // 无 factAudit 影响的维度照常中位数
    expect(out!.score.prompt!.noise).toBe(3);
  });

  it("aggregateReplicates:0 份 → null;无 factAudit 的份按记录值参与(legacy 分数文件)", () => {
    expect(aggregateReplicates([])).toBeNull();
    const legacy = { prompt: { noise: 2 }, response: { accuracy: 5 } };
    const out = aggregateReplicates([legacy as never]);
    expect(out!.score.response!.accuracy).toBe(5);
    expect(out!.accuracyMismatches).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`
Expected: FAIL,三个符号未导出。

- [ ] **Step 3: Write implementation(abCompareStats.ts)**

`ScoreFile` 接口扩一个可选字段(不破坏既有消费方):

```typescript
export interface ScoreFile {
  prompt: Record<string, number | string>;
  response: Record<string, number | string>;
  factAudit?: { verdict: string; severity?: string }[];
}
```

新增(放在 `dimensionScore` 之后;import 加 `computeAccuracyFromFactAudit` 自 `../provenance/checkScoreProvenance.js`,以及既有 fs/path 已在):

```typescript
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `<id>.json`(legacy K=1)+ `<id>.rN.json`(K 重),N 升序。 */
export function collectReplicateFiles(
  scoresDir: string,
  blindId: string,
): string[] {
  const out: string[] = [];
  const legacy = path.join(scoresDir, `${blindId}.json`);
  if (fs.existsSync(legacy)) out.push(legacy);
  const re = new RegExp(
    `^${blindId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.r(\\d+)\\.json$`,
  );
  const reps = (fs.existsSync(scoresDir) ? fs.readdirSync(scoresDir) : [])
    .map((f) => ({ f, m: f.match(re) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => path.join(scoresDir, x.f));
  return [...out, ...reps];
}

/** 逐维中位数聚合。accuracy:每份若带 factAudit,以 computeAccuracyFromFactAudit
 * 的计算值参与(与记录值不符计 mismatch)—— 防守:即使 provenance 漏网,
 * 统计侧仍是确定性值。 */
export function aggregateReplicates(
  reps: ScoreFile[],
): { score: ScoreFile; accuracyMismatches: number } | null {
  if (reps.length === 0) return null;
  let accuracyMismatches = 0;
  const promptOut: Record<string, number> = {};
  const responseOut: Record<string, number> = {};
  const PROMPT_DIMS = new Set([
    "sufficiency",
    "noise",
    "labelBias",
    "inferenceScaffolding",
  ]);
  for (const dimension of DIMENSIONS) {
    const values: number[] = [];
    for (const r of reps) {
      let v = dimensionScore(r, dimension);
      if (dimension === "accuracy" && Array.isArray(r.factAudit)) {
        const derived = computeAccuracyFromFactAudit(r.factAudit);
        if (v !== null && v !== derived) accuracyMismatches++;
        v = derived;
      }
      if (v !== null) values.push(v);
    }
    if (values.length === 0) continue;
    (PROMPT_DIMS.has(dimension) ? promptOut : responseOut)[dimension] =
      medianOf(values);
  }
  return {
    score: { prompt: promptOut, response: responseOut },
    accuracyMismatches,
  };
}
```

main() 装载循环改写(替换现有 157–172 行的单文件循环;缺分/泄漏/占位符检查逐**份**执行后再聚合):

```typescript
const scoresByArm = new Map<string, ScoreFile>(); // key: arm|ordinal(聚合后)
let missing = 0;
let itemsDropped = 0;
let twoReplicateItems = 0;
let accuracyMismatchTotal = 0;
const nonconforming: string[] = [];
const leaks: string[] = [];
const scoresDir = path.join(blindDir, "scores");
const kMode = mapping.some((item) =>
  collectReplicateFiles(scoresDir, item.blindId).some((p) =>
    /\.r\d+\.json$/.test(p),
  ),
);
for (const item of mapping) {
  const files = collectReplicateFiles(scoresDir, item.blindId);
  if (files.length === 0) {
    missing++;
    continue;
  }
  if (kMode && files.length < 2) {
    itemsDropped++;
    continue;
  }
  if (kMode && files.length === 2) twoReplicateItems++;
  const reps: ScoreFile[] = [];
  for (const p of files) {
    const score = (await fs.readJson(p)) as ScoreFile & { matchId?: unknown };
    if (score.matchId === item.matchId) {
      leaks.push(path.basename(p));
    } else if (score.matchId !== item.blindId) {
      nonconforming.push(
        `${path.basename(p)}=${JSON.stringify(score.matchId)}`,
      );
    }
    reps.push(score);
  }
  const agg = aggregateReplicates(reps);
  if (!agg) {
    missing++;
    continue;
  }
  accuracyMismatchTotal += agg.accuracyMismatches;
  scoresByArm.set(`${item.arm}|${item.ordinal}`, agg.score);
}
```

(既有 missing/leaks/nonconforming 的三段 console.warn 保留并在其后追加:)

```typescript
if (kMode)
  console.warn(
    `K-replicate mode: ${itemsDropped} item(s) dropped (<2 replicates), ${twoReplicateItems} item(s) aggregated from only 2, ${accuracyMismatchTotal} recorded-accuracy mismatch(es) overridden by factAudit-derived values.`,
  );
```

`comparison-stats.json` 写出对象加:

```typescript
    replicateSummary: {
      kMode,
      itemsDropped,
      twoReplicateItems,
      accuracyMismatches: accuracyMismatchTotal,
    },
```

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`,`npm run typecheck`,`npm test --workspace packages/ev[a]l`
Expected: 新用例 PASS;既有 abStats 用例(legacy 单文件路径)不回归;全量无新失败。

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/ab/abCompareStats.ts packages/eval/test/abStats.test.ts
git commit -m "feat(eval): A/B 盲评 K 重副本聚合 —— 逐维中位数 + accuracy 以 factAudit 计算值参与 + replicateSummary"
```

---

### Task 4: 种植小错工具(验收 |Δ|≈0.2 的已知差异构造)

**Files:**

- Create: `packages/eval/src/ab/plantTimestampError.ts`
- Create: `packages/eval/scripts/plantAccuracyAb.ts`
- Modify: `packages/eval/test/abStats.test.ts`(追加 describe 块)

**Interfaces:**

- Consumes: `makeRng`(`./abCompareStats.js`);B 的臂 O 目录布局(`control/{index.json,prompts/,responses/}`,`IndexEntry` 自 `../corpus/buildCorpus`)。
- Produces:
  - `export function plantTimestampError(responseText: string): { text: string; planted: string }` —— 把回复里**第一个** `M:SS` 时间戳的秒数 +3(带分钟进位;`M:SS` 定义 `/\b(\d+):([0-5]\d)\b/`),返回改后文本与 `planted` 描述(`"0:42 -> 0:45"`);无时间戳 throw。
  - `export async function buildPlantedAb(opts: { sourceArmDir: string; outDir: string; nPairs: number; plantFraction: number; seed: number }): Promise<{ pairs: number; planted: number }>` —— 从 sourceArmDir 取前置已有的 (prompt, response) 对,定种子抽 nPairs 件;control 臂原样复制;treatment 臂同 prompt,`round(nPairs*plantFraction)` 件(定种子选择)的 response 过 plantTimestampError,其余原样;两臂 index.json 一致;写 `plant-meta.json`(seed、被种植 ordinal 列表、每件 planted 描述)。
  - CLI:`npx tsx packages/eval/scripts/plantAccuracyAb.ts --source-ab 2026-08-05-outcome-halo --arm control --ab <newAbId> --n-pairs 50 --plant-fraction 0.2 --seed 20260806`(内部 `resolveEvalHome()`/`abDir()`,命令行不出现 eval-home 路径)。

- [ ] **Step 1: Write the failing test(追加到 test/abStats.test.ts)**

```typescript
import {
  plantTimestampError,
  buildPlantedAb,
} from "../src/ab/plantTimestampError";

describe("plantTimestampError(子项目 A 验收工具)", () => {
  it("首个 M:SS 秒数 +3,其余字节不变", () => {
    const out = plantTimestampError(
      "at 0:42 the kick landed; later 1:10 again",
    );
    expect(out.text).toBe("at 0:45 the kick landed; later 1:10 again");
    expect(out.planted).toBe("0:42 -> 0:45");
  });

  it("秒数进位:0:58 -> 1:01", () => {
    const out = plantTimestampError("spike at 0:58 was decisive");
    expect(out.text).toBe("spike at 1:01 was decisive");
  });

  it("无时间戳 → throw", () => {
    expect(() => plantTimestampError("no timestamps here")).toThrow(
      /timestamp/,
    );
  });

  it("buildPlantedAb:两臂 index 一致;恰 plantFraction 比例被种植且记录于 plant-meta", async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), "plant-src-"));
    const entries = [1, 2, 3, 4].map((n) => ({
      ordinal: n,
      file: `prompts/00${n}-m${n}.txt`,
      matchId: `m${n}`,
      spec: "s",
      result: n % 2 ? "Win" : "Loss",
    }));
    await fs.ensureDir(path.join(src, "prompts"));
    await fs.ensureDir(path.join(src, "responses"));
    for (const e of entries) {
      await fs.writeFile(path.join(src, e.file), `PROMPT ${e.matchId}`, "utf8");
      await fs.writeFile(
        path.join(src, "responses", `00${e.ordinal}.txt`),
        `MATCHID: ${e.matchId}\n\nthe spike at 0:42 decided it`,
        "utf8",
      );
    }
    await fs.writeJson(path.join(src, "index.json"), entries);

    const out = path.join(src, "planted");
    const res = await buildPlantedAb({
      sourceArmDir: src,
      outDir: out,
      nPairs: 4,
      plantFraction: 0.5,
      seed: 7,
    });
    expect(res).toEqual({ pairs: 4, planted: 2 });
    const meta = await fs.readJson(path.join(out, "plant-meta.json"));
    expect(meta.plantedOrdinals).toHaveLength(2);
    const controlIdx = await fs.readJson(
      path.join(out, "control", "index.json"),
    );
    const treatIdx = await fs.readJson(
      path.join(out, "treatment", "index.json"),
    );
    expect(treatIdx).toEqual(controlIdx);
    // 被种植件 treatment 回复含 0:45,未种植件与 control 一字不差
    for (const e of controlIdx) {
      const o = String(e.ordinal).padStart(3, "0");
      const c = await fs.readFile(
        path.join(out, "control", "responses", `${o}.txt`),
        "utf8",
      );
      const t = await fs.readFile(
        path.join(out, "treatment", "responses", `${o}.txt`),
        "utf8",
      );
      if (meta.plantedOrdinals.includes(e.ordinal)) expect(t).toContain("0:45");
      else expect(t).toBe(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/ab/plantTimestampError.ts
/**
 * plantTimestampError.ts — 子项目 A 验收(c) 的已知差异构造:把回复首个 M:SS
 * 时间戳 +3 秒,制造 rubric 定义的「小错」(时间戳差几秒),期望 accuracy
 * 恰降一档。buildPlantedAb 用它按比例种植,构造已知 |Δ| 的 A/B 对。
 */
import fs from "fs-extra";
import path from "path";

import { makeRng } from "./abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";

const TIMESTAMP_RE = /\b(\d+):([0-5]\d)\b/;

export function plantTimestampError(responseText: string): {
  text: string;
  planted: string;
} {
  const m = responseText.match(TIMESTAMP_RE);
  if (!m || m.index === undefined)
    throw new Error("plantTimestampError: no M:SS timestamp in response");
  const minutes = Number(m[1]);
  const seconds = Number(m[2]) + 3;
  const shifted = `${minutes + Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const text =
    responseText.slice(0, m.index) +
    shifted +
    responseText.slice(m.index + m[0].length);
  return { text, planted: `${m[0]} -> ${shifted}` };
}

export async function buildPlantedAb(opts: {
  sourceArmDir: string;
  outDir: string;
  nPairs: number;
  plantFraction: number;
  seed: number;
}): Promise<{ pairs: number; planted: number }> {
  const { sourceArmDir, outDir, nPairs, plantFraction, seed } = opts;
  const entries = (await fs.readJson(
    path.join(sourceArmDir, "index.json"),
  )) as IndexEntry[];
  if (entries.length < nPairs)
    throw new Error(
      `buildPlantedAb: source has ${entries.length} entries, need ${nPairs}`,
    );
  const rng = makeRng(seed);
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const selected = shuffled
    .slice(0, nPairs)
    .sort((a, b) => a.ordinal - b.ordinal);
  const plantCount = Math.round(nPairs * plantFraction);
  const plantSet = new Set(selected.slice(0, plantCount).map((e) => e.ordinal)); // selected 已定种子洗过,取前 plantCount 个即定种子选择
  const plantedMeta: { ordinal: number; planted: string }[] = [];

  for (const arm of ["control", "treatment"] as const) {
    await fs.ensureDir(path.join(outDir, arm, "prompts"));
    await fs.ensureDir(path.join(outDir, arm, "responses"));
  }
  const rewritten: IndexEntry[] = [];
  for (const entry of selected) {
    const ordinal = String(entry.ordinal).padStart(3, "0");
    const prompt = await fs.readFile(
      path.join(sourceArmDir, entry.file),
      "utf8",
    );
    const response = await fs.readFile(
      path.join(sourceArmDir, "responses", `${ordinal}.txt`),
      "utf8",
    );
    const relFile = path.join("prompts", path.basename(entry.file));
    for (const arm of ["control", "treatment"] as const)
      await fs.writeFile(path.join(outDir, arm, relFile), prompt, "utf8");
    await fs.writeFile(
      path.join(outDir, "control", "responses", `${ordinal}.txt`),
      response,
      "utf8",
    );
    let treatResponse = response;
    if (plantSet.has(entry.ordinal)) {
      const p = plantTimestampError(response);
      treatResponse = p.text;
      plantedMeta.push({ ordinal: entry.ordinal, planted: p.planted });
    }
    await fs.writeFile(
      path.join(outDir, "treatment", "responses", `${ordinal}.txt`),
      treatResponse,
      "utf8",
    );
    rewritten.push({ ...entry, file: relFile });
  }
  for (const arm of ["control", "treatment"] as const)
    await fs.writeJson(path.join(outDir, arm, "index.json"), rewritten, {
      spaces: 2,
    });
  await fs.writeJson(
    path.join(outDir, "plant-meta.json"),
    {
      seed,
      nPairs,
      plantFraction,
      plantedOrdinals: plantedMeta.map((p) => p.ordinal).sort((a, b) => a - b),
      planted: plantedMeta,
    },
    { spaces: 2 },
  );
  return { pairs: rewritten.length, planted: plantedMeta.length };
}
```

```typescript
// packages/eval/scripts/plantAccuracyAb.ts
import { parseArgs } from "node:util";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { buildPlantedAb } from "../src/ab/plantTimestampError.js";

const { values } = parseArgs({
  options: {
    "source-ab": { type: "string" },
    arm: { type: "string" },
    ab: { type: "string" },
    "n-pairs": { type: "string" },
    "plant-fraction": { type: "string" },
    seed: { type: "string" },
  },
});
if (!values["source-ab"] || !values.ab) {
  console.error("--source-ab and --ab required");
  process.exit(1);
}
const home = resolveEvalHome();
const res = await buildPlantedAb({
  sourceArmDir: path.join(
    abDir(home, values["source-ab"]),
    values.arm ?? "control",
  ),
  outDir: abDir(home, values.ab),
  nPairs: Number(values["n-pairs"] ?? 50),
  plantFraction: Number(values["plant-fraction"] ?? 0.2),
  seed: Number(values.seed ?? 20260806),
});
console.log(
  `planted AB: ${res.pairs} pairs, ${res.planted} planted, under ${abDir(home, values.ab)}`,
);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`,`npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/ab/plantTimestampError.ts packages/eval/scripts/plantAccuracyAb.ts packages/eval/test/abStats.test.ts
git commit -m "feat(eval): 种植时间戳小错工具 —— 验收用已知 |Δ| A/B 构造(定种子,plant-meta 记账)"
```

---

### Task 5: 协议文档(eval-ab.md K 重)+ 谓词索引双语登记

**Files:**

- Modify: `docs/commands/eval-ab.md`(Phase 2 第 5 步盲评一节)
- Modify: `docs/predicate-index.md` + `docs/predicate-index.zh-CN.md`(Gate side / 门规侧 各加一行)
- Modify: `packages/eval/test/predicateIndex.test.ts`(登记一行)

**Interfaces:** Consumes Task 1 的 `computeAccuracyFromFactAudit` export;Produces Task 6 照跑的协议文本。

- [ ] **Step 1: eval-ab.md 盲评一节追加 K 重段**

在第 5 步判官模板之后、`全部分数写完后解盲` 之前插入:

```markdown
**K=3 重判官(2026-08-05 子项目 A 起,A/B 裁决默认):** 每个 ITEMID 派 3 个
独立判官(同件三判官互不知情,一件一代理铁律不变),分数分别写
`blind/scores/ITEMID.r1.json` / `.r2.json` / `.r3.json`(其余契约同上)。
abStats 会先对每件逐维取中位数再配对;K 模式下某件不足 2 份按缺分整对丢弃,
恰 2 份取均值并在 replicateSummary 里标注。旧式单文件 `ITEMID.json`(K=1)
仍兼容,用于快速烟测。accuracy 一律以各判官 factAudit 的
computeAccuracyFromFactAudit 计算值参与聚合(rubric 见 eval-baseline.md)。
```

- [ ] **Step 2: 谓词索引双语各加一行(Gate side 表尾,`RESULT_LABEL_RE` 行之后)**

英文版:

```markdown
| The accuracy score implied by a factAudit (error-count lookup) | `packages/eval/src/provenance/checkScoreProvenance.ts` → `computeAccuracyFromFactAudit` | `checkScoreProvenance` (consistency gate (f)); `abCompareStats.ts` → `aggregateReplicates` (K-replicate aggregation uses the derived value) | The rubric table in `docs/commands/eval-baseline.md` is the human-facing side; `factAuditBounds.test.ts` pins the doc's lookup lines to this function's semantics (markdown↔code equality-test fallback, same pattern as `FACT_AUDIT_MIN/MAX`). |
```

中文版:

```markdown
| 一份 factAudit 蕴含的 accuracy 分(错数查表) | `packages/eval/src/provenance/checkScoreProvenance.ts` → `computeAccuracyFromFactAudit` | `checkScoreProvenance`(一致性门 (f));`abCompareStats.ts` → `aggregateReplicates`(K 重聚合按计算值参与) | rubric 查表在 `docs/commands/eval-baseline.md` 是人读侧;`factAuditBounds.test.ts` 把文档查表行钉在本函数语义上(markdown↔代码等值断言备选路,与 `FACT_AUDIT_MIN/MAX` 同款范式)。 |
```

- [ ] **Step 3: predicateIndex.test.ts 登记(照 `makeRng` 行的既有 `{file, symbol, mod}` 格式,`checkScoreProvenance` 模块已 import)**

```typescript
  {
    file: `${E}/provenance/checkScoreProvenance.ts`,
    symbol: "computeAccuracyFromFactAudit",
    mod: checkScoreProvenance,
  },
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace packages/ev[a]l -- test/predicateIndex.test.ts`,然后全量 `npm test --workspace packages/ev[a]l` 与 `npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add docs/commands/eval-ab.md docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "docs(eval): K=3 重判官入 A/B 协议 + computeAccuracyFromFactAudit 谓词双语登记"
```

---

### Task 6: 验收实验(orchestrator 亲自跑,非代码任务)

**Files:** 产物在 `$GLADLOG_EVAL_HOME/ab/2026-08-06-planted-accuracy/` 与 `runs/`(校准);仓内改动仅 spec 验收表回填 + ledger(eval home 仓)。

**Interfaces:** Consumes Task 1–5 全部;Produces spec 设计三的三判据数字。

- [ ] **Step 1: 构造已知差异对**

```
npx tsx packages/eval/scripts/plantAccuracyAb.ts --source-ab 2026-08-05-outcome-halo --arm control --ab 2026-08-06-planted-accuracy --n-pairs 50 --plant-fraction 0.2 --seed 20260806
```

预期:`planted AB: 50 pairs, 10 planted`。抽查一件被种植回复 diff = 一个时间戳。

- [ ] **Step 2: 混池 + K=3 盲评(300 判官)**

`npx tsx packages/eval/scripts/blindPool.ts --ab 2026-08-06-planted-accuracy`(预期 100 items / 50 pairs)。然后每件派 **3 个** sonnet 判官(新 rubric:factAudit 带 severity、accuracy 写计算值;分数写 `ITEMID.r1/.r2/.r3.json`;一件一代理、同件三判官互不知情;orchestrator 不读 mapping/件/分数)。判官指令文件照 B 的 judge-instructions 模式重写一份放 SDD workspace,注明新 severity 契约与副本文件名由 dispatch 指定。

- [ ] **Step 3: 解盲统计 + 判据 (c)(已知差异检出)**

`AB_DIR` 走 `npx tsx packages/eval/scripts/abStats.ts --ab 2026-08-06-planted-accuracy`(若该 wrapper 仅认 AB_DIR env,则给它加 `--ab` 参数解析,照 `blindPool.ts` 的现成模式,一并 commit)。
通过线:accuracy 维 verdict = `regressed` 且 95% CI 不含零;点估计与理论值 −0.2 同向同量级;`replicateSummary.itemsDropped` 记录如实。

- [ ] **Step 4: 判据 (a)(SD 前后数字)**

从 control 臂 50 件 × 3 副本(判据 (c) 的分数直接复用,零新增成本)计算:逐件 accuracy 三副本的样本 SD → 汇总(pooled)单判官 SD;由此推 K=3 中位数配对 SD(×0.67×√2)。
通过线:K=3 中位数配对 SD ≤ 0.5(硬线);单判官 SD 与 0.94 基准并列报告。计算写成小脚本进 SDD workspace 临时执行即可(纯读分数文件算 SD,不入库——它消费的是一次性目录布局,不属可复用判据)。

- [ ] **Step 5: 判据 (b)(校准不倒退)**

按 `docs/commands/calibrate-judge.md` 全流程重跑一轮校准(新 rubric,K=1):`buildCalibration` → 盲评全部 cases(判官用新 severity 契约)→ `checkCalibration`。
通过线:7/7 维 PASS(≥0.8)不倒退;特别关注 fabricated-claim 类(种植捏造 ⇒ 判官记 fabricated ⇒ 计算值 1 ⇒ 检出应更利落)。

- [ ] **Step 6: 报告 + 回写 + 收尾**

- `ab/2026-08-06-planted-accuracy/report.md`:三判据表(现值/通过线/实测)+ 过程记录;
- spec `2026-08-05-judge-noise-floor-design.md` 验收表填入实测数字并注日期;
- eval home `ledger.md` 记账(若 git commit 仍被 worktree 守卫拦,注明留给主 checkout);
- 三判据任一给不出:如实写「给不出」并停在此处报告,不得以「理应更稳」收工。

---

## Self-Review 记录

- **Spec coverage:** 设计一(severity + 查表 + provenance (f))→ Task 1/2;设计二(K=3 命名/聚合/缺份规则/legacy 兼容)→ Task 3/5;设计三三判据 → Task 4(工具)+ Task 6(执行);谓词索引登记 → Task 5;「明确不做」各项无任务触碰(校准仍 K=1,baseline 无改动——rubric 改动对 baseline 判官同样生效但 K 仍为 1,符合 spec)。
- **Placeholder scan:** Task 1 Step 1 第二个 describe 的三用例以注释骨架呈现但附有明确的展开规则与本文件同型用例参照——为控制计划体积保留,实现者须写全;其余任务代码均完整。
- **Type consistency:** `computeAccuracyFromFactAudit` 签名在 Task 1/3/5 一致;`ScoreFile.factAudit?` 扩展与 `aggregateReplicates` 消费一致;`medianOf`/`collectReplicateFiles`/`aggregateReplicates`/`plantTimestampError`/`buildPlantedAb` 的名称与参数在定义与消费处逐一核对无漂移。
- **顺序依赖:** Task 3 import Task 1 的函数;Task 5 的谓词登记 import 同函数;Task 6 依赖全部——任务须按序执行。
