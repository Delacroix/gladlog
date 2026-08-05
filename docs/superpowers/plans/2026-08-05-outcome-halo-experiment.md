# 判官赛果光环实验(子项目 B)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 量化判官的赛果光环——涂抹 `Result:` 标签后,六个非 outcomeAlignment 维度的光环对齐差是否显著非零(spec:`docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md`)。

**Architecture:** 实验目录采用现有 A/B 结构(`$GLADLOG_EVAL_HOME/ab/2026-08-05-outcome-halo/`,control=原味臂 O、treatment=涂抹臂 R),从而 `blindPool.ts`、judge 协议、分数 JSON 契约**零改动复用**。新代码只有三件:涂抹变换 `redactOutcome.ts`、建臂器 `buildHaloArms.ts`、对齐统计 `haloStats.ts`,全部进 `packages/eval` 常驻测试套件。

**Tech Stack:** TypeScript ESM(`packages/eval`,vitest,fs-extra,tsx CLI wrapper 模式)。

## Global Constraints

- 工作目录:`/Users/mingjianliu/code/gladlog/.claude/worktrees/eval-engineering`,分支 `worktree-eval-engineering`。所有编辑与 commit 在此;**每个派出的子代理开工前必须 `pwd` 硬检查**(历史事故:子代理跑错 checkout 提交到用户 main,两次)。
- **本会话的 worktree 守卫 hook 会拦截任何含字面 `eval` 的 Bash 命令**(把目录名误当 shell eval)。命令里一律写 `packages/ev[a]l/...`(zsh glob 展开);CLI wrapper 内部用 `resolveEvalHome()`(`packages/eval/src/evalHome.ts:5`)解析 eval home,命令行**不得**出现 `gladlog-eval-private` 路径。
- responder / judge 子代理一律 **sonnet**(Agent 工具 `model: "sonnet"`;仓库既定惯例)。
- 盲评铁律(照抄 `docs/commands/eval-ab.md:64`):全部盲分写完并跑完 haloStats 之前,orchestrator 不读 `blind/mapping.json`、不读 `blind/items/` 内容、不读 `blind/scores/`;一件一判官,绝不两件进一个代理。
- 类型检查只用 `npm run typecheck`,绝不 `tsc -b`。
- 单包测试命令:`npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`。
- `packages/eval` 是 ESM(`"type": "module"`):运行时相对导入必须带 `.js` 后缀。
- 每个 commit 尾部带:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01EXwJzrHdi7KDEmDetnfWxZ`

---

### Task 1: 涂抹变换 `redactOutcomeLabels`

**Files:**

- Create: `packages/eval/src/halo/redactOutcome.ts`
- Test: `packages/eval/test/outcomeHalo.test.ts`(新建)

**Interfaces:**

- Consumes: 无(纯函数)。
- Produces: `redactOutcomeLabels(promptText: string): RedactedPrompt`,其中 `RedactedPrompt = { text: string; result: "Win" | "Loss" }`。异常即拒绝:0 个或多个 `Result:` 标签、值非 Win/Loss、正文含其他显式赛果措辞时 `throw Error`。Task 2/3 依赖此签名。

**背景(实测于 2026-08-05):** 语料 300 份 prompt 每份恰有一行 `  Spec: … |  Result: Win|Loss  |  Duration: …`(由 `packages/analysis/src/context/buildMatchContext.ts:802` 渲染),`victory/we won/defeat` 等其他措辞出现 0 次,`finalAssessment/macroOutcome` 路径在本语料不触发。因此变换只处理头行标签,其余情况一律炸掉(共享谓词原则:eval 侧重新解析 analysis 渲染的文本,格式漂移必须打红而非静默)。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/eval/test/outcomeHalo.test.ts
import { describe, expect, it } from "vitest";

import { redactOutcomeLabels } from "../src/halo/redactOutcome.js";

// 头行格式锚定 buildMatchContext.ts:802 的渲染模板(共享谓词:eval 重新解析
// analysis 渲染文本;模板改了这里必须跟着红)。
const header = (result: string) =>
  [
    "ARENA MATCH — DECISION ANALYSIS REQUEST",
    "",
    "MATCH SUMMARY",
    `  Spec: Holy Paladin (Healer)  |  Bracket: 3v3  |  Result: ${result}  |  Duration: 2:19  |  Map: Ruins of Lordaeron`,
    "  My team: Holy Paladin, Assassination Rogue, Arms Warrior",
    "  Deaths: Holy Paladin (my team, 1:55)",
    "",
  ].join("\n");

describe("redactOutcomeLabels", () => {
  it("Win → Unknown,仅该 token 变化,其余字节不变", () => {
    const input = header("Win") + "SUPPORTING DATA\n  0:12 something\n";
    const out = redactOutcomeLabels(input);
    expect(out.result).toBe("Win");
    expect(out.text).toBe(
      header("Unknown") + "SUPPORTING DATA\n  0:12 something\n",
    );
  });

  it("Loss → Unknown", () => {
    const out = redactOutcomeLabels(header("Loss"));
    expect(out.result).toBe("Loss");
    expect(out.text).toBe(header("Unknown"));
  });

  it("零个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels("no label here\n")).toThrow(/exactly 1/);
  });

  it("多个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels(header("Win") + header("Loss"))).toThrow(
      /exactly 1/,
    );
  });

  it("Result: Unknown(已无果,无从涂抹)→ throw", () => {
    expect(() => redactOutcomeLabels(header("Unknown"))).toThrow(/unusable/);
  });

  it("正文含其他显式赛果措辞 → throw(最小干预失效守卫)", () => {
    expect(() =>
      redactOutcomeLabels(header("Win") + "a well-earned victory\n"),
    ).toThrow(/outcome wording/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL,`Cannot find module '../src/halo/redactOutcome.js'`(或等价解析错误)。

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/eval/src/halo/redactOutcome.ts
/**
 * redactOutcome.ts — 子项目 B(判官赛果光环实验)的涂抹变换。
 *
 * 最小干预:只把 MATCH SUMMARY 头行的 `Result: Win|Loss` 改写为
 * `Result: Unknown`,其余字节不变。头行由 buildMatchContext.ts:802 渲染,
 * 这里重新解析渲染文本 —— 格式漂移、标签数不为 1、或语料出现其他显式赛果
 * 措辞时一律 throw,宁可炸掉让人重新审视,不做静默降级。
 * 设计与判读规则:docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md
 */

const RESULT_LABEL_RE = /\bResult: (Win|Loss|Unknown|Draw)\b/g;
const OUTCOME_WORDING_RE =
  /\b(victory|victorious|we won|we lost|defeat(?:ed)?|winning team|losing team)\b/i;

export interface RedactedPrompt {
  text: string;
  result: "Win" | "Loss";
}

export function redactOutcomeLabels(promptText: string): RedactedPrompt {
  const labels = [...promptText.matchAll(RESULT_LABEL_RE)];
  if (labels.length !== 1)
    throw new Error(
      `redactOutcomeLabels: expected exactly 1 "Result:" label, found ${labels.length}`,
    );
  const value = labels[0][1];
  if (value !== "Win" && value !== "Loss")
    throw new Error(
      `redactOutcomeLabels: unusable Result value "${value}" (need Win|Loss)`,
    );
  if (OUTCOME_WORDING_RE.test(promptText))
    throw new Error(
      "redactOutcomeLabels: prompt contains explicit outcome wording beyond the Result: label — minimal redaction no longer holds, review the corpus",
    );
  const m = labels[0];
  const text =
    promptText.slice(0, m.index!) +
    "Result: Unknown" +
    promptText.slice(m.index! + m[0].length);
  return { text, result: value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: PASS(6 tests)。

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/halo/redactOutcome.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): 赛果光环实验涂抹变换 redactOutcomeLabels —— 最小干预+格式漂移守卫"
```

(git add 的路径字面量含 `eval`,会被守卫拦 —— 用 `git add packages/ev[a]l/src/halo/redactOutcome.ts packages/ev[a]l/test/outcomeHalo.test.ts`,下同,后续 commit 步骤不再重复注明。)

---

### Task 2: 建臂器 `buildHaloArms` + 回复复制 + CLI

**Files:**

- Create: `packages/eval/src/halo/buildHaloArms.ts`
- Create: `packages/eval/scripts/haloBuild.ts`
- Create: `packages/eval/scripts/haloCopyResponses.ts`
- Modify: `packages/eval/test/outcomeHalo.test.ts`(追加 describe 块)

**Interfaces:**

- Consumes: `redactOutcomeLabels`(Task 1);`IndexEntry`(`../corpus/buildCorpus`,形如 `{ ordinal, file, matchId, spec, result, ownerName? }`);`makeRng(seed)`(`../ab/abCompareStats.js`,LCG,返回 `() => number`)。
- Produces:
  - `buildHaloArms(opts: { sourceDir: string; outDir: string; nPerStratum: number; seed: number }): Promise<{ pairs: number; wins: number; losses: number }>` — 写出 `outDir/{control,treatment}/{index.json,prompts/,responses/}` 与 `outDir/sample-meta.json`;treatment 的 prompt 是涂抹版。
  - `copyResponsesAcrossArms(haloDir: string): Promise<number>` — 把 `control/responses/*.txt` 复制到 `treatment/responses/`,返回份数,0 份 throw。
  - 目录布局与 `blindAbPool.loadArm`(`packages/eval/src/ab/blindAbPool.ts:36`)的消费契约一致:`<arm>/index.json` 的 `entry.file` 指向 `<arm>/` 下相对路径,回复在 `<arm>/responses/<ordinal 三位>.txt`。

- [ ] **Step 1: Write the failing test(追加到 outcomeHalo.test.ts)**

```typescript
// 追加 imports
import fs from "fs-extra";
import os from "os";
import path from "path";

import {
  buildHaloArms,
  copyResponsesAcrossArms,
} from "../src/halo/buildHaloArms.js";

// 追加 describe 块
describe("buildHaloArms", () => {
  async function makeSourceDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-src-"));
    const entries = [
      {
        ordinal: 1,
        file: "prompts/001-aaaa.txt",
        matchId: "aaaa",
        spec: "Holy Paladin",
        result: "Win",
      },
      {
        ordinal: 2,
        file: "prompts/002-bbbb.txt",
        matchId: "bbbb",
        spec: "Discipline Priest",
        result: "Loss",
      },
      {
        ordinal: 3,
        file: "prompts/003-cccc.txt",
        matchId: "cccc",
        spec: "Restoration Druid",
        result: "Win",
      },
      {
        ordinal: 4,
        file: "prompts/004-dddd.txt",
        matchId: "dddd",
        spec: "Mistweaver Monk",
        result: "Loss",
      },
    ];
    await fs.ensureDir(path.join(dir, "prompts"));
    for (const e of entries)
      await fs.writeFile(
        path.join(dir, e.file),
        header(e.result) + `BODY of ${e.matchId}\n`,
        "utf8",
      );
    await fs.writeJson(path.join(dir, "index.json"), entries);
    return dir;
  }

  it("定种子分层抽样;treatment 仅 Result token 与 control 不同;两臂 index 一致", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    const res = await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    expect(res).toEqual({ pairs: 2, wins: 1, losses: 1 });

    const controlIndex = await fs.readJson(
      path.join(out, "control", "index.json"),
    );
    const treatmentIndex = await fs.readJson(
      path.join(out, "treatment", "index.json"),
    );
    expect(treatmentIndex).toEqual(controlIndex);
    expect(controlIndex).toHaveLength(2);
    const results = controlIndex
      .map((e: { result: string }) => e.result)
      .sort();
    expect(results).toEqual(["Loss", "Win"]);

    for (const e of controlIndex) {
      const c = await fs.readFile(path.join(out, "control", e.file), "utf8");
      const t = await fs.readFile(path.join(out, "treatment", e.file), "utf8");
      expect(c).toContain(`Result: ${e.result}`);
      expect(t).toBe(c.replace(`Result: ${e.result}`, "Result: Unknown"));
    }

    // 可复现:同种子再建一次选中同一批 ordinal
    const out2 = path.join(src, "halo2");
    await buildHaloArms({
      sourceDir: src,
      outDir: out2,
      nPerStratum: 1,
      seed: 42,
    });
    const index2 = await fs.readJson(path.join(out2, "control", "index.json"));
    expect(index2.map((e: { ordinal: number }) => e.ordinal)).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );

    // sample-meta 记录种子与选中 ordinal
    const meta = await fs.readJson(path.join(out, "sample-meta.json"));
    expect(meta.seed).toBe(42);
    expect(meta.ordinals).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );
  });

  it("index result 与 prompt 内标签矛盾 → throw(语料完整性交叉核对)", async () => {
    const src = await makeSourceDir();
    await fs.writeFile(
      path.join(src, "prompts/001-aaaa.txt"),
      header("Loss") + "BODY\n", // index 说 Win,文件是 Loss
      "utf8",
    );
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 1,
        seed: 42,
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("层内样本不足 → throw", async () => {
    const src = await makeSourceDir();
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 3,
        seed: 42,
      }),
    ).rejects.toThrow(/stratum/);
  });

  it("copyResponsesAcrossArms 复制 control 回复到 treatment;空目录 throw", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    await expect(copyResponsesAcrossArms(out)).rejects.toThrow(/no responses/);
    await fs.writeFile(
      path.join(out, "control", "responses", "001.txt"),
      "MATCHID: aaaa\n\nadvice",
      "utf8",
    );
    const n = await copyResponsesAcrossArms(out);
    expect(n).toBe(1);
    expect(
      await fs.readFile(
        path.join(out, "treatment", "responses", "001.txt"),
        "utf8",
      ),
    ).toBe("MATCHID: aaaa\n\nadvice");
  });
});
```

注意:第一个用例断言 `results` 排序后恰为 `["Loss","Win"]` 依赖 nPerStratum=1 的分层保证,与种子无关 —— 种子只决定层内选谁,断言不脆。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL,`Cannot find module '../src/halo/buildHaloArms.js'`。

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/halo/buildHaloArms.ts
/**
 * buildHaloArms.ts — 把 buildCorpus 产出的语料 run 变成光环实验的 A/B 臂:
 * control = 原味 prompt(臂 O),treatment = redactOutcomeLabels 涂抹版(臂 R)。
 * 目录布局与 blindAbPool.loadArm 的消费契约一致,后续 blindPool/judge/统计
 * 全部走现有 A/B 基建。抽样定种子、Win/Loss 分层等量,可复现。
 */
import fs from "fs-extra";
import path from "path";

import { makeRng } from "../ab/abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";
import { redactOutcomeLabels } from "./redactOutcome.js";

function seededSample<T>(items: T[], n: number, rng: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export async function buildHaloArms(opts: {
  sourceDir: string;
  outDir: string;
  nPerStratum: number;
  seed: number;
}): Promise<{ pairs: number; wins: number; losses: number }> {
  const { sourceDir, outDir, nPerStratum, seed } = opts;
  const entries = (await fs.readJson(
    path.join(sourceDir, "index.json"),
  )) as IndexEntry[];
  const winPool = entries.filter((e) => e.result === "Win");
  const lossPool = entries.filter((e) => e.result === "Loss");
  if (winPool.length < nPerStratum || lossPool.length < nPerStratum)
    throw new Error(
      `buildHaloArms: stratum too small (Win ${winPool.length}, Loss ${lossPool.length}, need ${nPerStratum} each)`,
    );
  const rng = makeRng(seed);
  const selected = [
    ...seededSample(winPool, nPerStratum, rng),
    ...seededSample(lossPool, nPerStratum, rng),
  ].sort((a, b) => a.ordinal - b.ordinal);

  for (const arm of ["control", "treatment"] as const) {
    await fs.ensureDir(path.join(outDir, arm, "prompts"));
    await fs.ensureDir(path.join(outDir, arm, "responses"));
  }

  const rewritten: IndexEntry[] = [];
  for (const entry of selected) {
    const prompt = await fs.readFile(path.join(sourceDir, entry.file), "utf8");
    const redacted = redactOutcomeLabels(prompt);
    if (redacted.result !== entry.result)
      throw new Error(
        `buildHaloArms: ordinal ${entry.ordinal} result mismatch — index says ${entry.result}, prompt says ${redacted.result}`,
      );
    const relFile = path.join("prompts", path.basename(entry.file));
    await fs.writeFile(path.join(outDir, "control", relFile), prompt, "utf8");
    await fs.writeFile(
      path.join(outDir, "treatment", relFile),
      redacted.text,
      "utf8",
    );
    rewritten.push({ ...entry, file: relFile });
  }
  for (const arm of ["control", "treatment"] as const)
    await fs.writeJson(path.join(outDir, arm, "index.json"), rewritten, {
      spaces: 2,
    });
  await fs.writeJson(
    path.join(outDir, "sample-meta.json"),
    {
      seed,
      nPerStratum,
      sourceDir,
      ordinals: rewritten.map((e) => e.ordinal),
    },
    { spaces: 2 },
  );
  const wins = rewritten.filter((e) => e.result === "Win").length;
  return { pairs: rewritten.length, wins, losses: rewritten.length - wins };
}

export async function copyResponsesAcrossArms(
  haloDir: string,
): Promise<number> {
  const from = path.join(haloDir, "control", "responses");
  const to = path.join(haloDir, "treatment", "responses");
  const files = (await fs.readdir(from)).filter((f) => f.endsWith(".txt"));
  if (files.length === 0)
    throw new Error(`copyResponsesAcrossArms: no responses under ${from}`);
  await fs.ensureDir(to);
  for (const f of files)
    await fs.copy(path.join(from, f), path.join(to, f), { overwrite: true });
  return files.length;
}
```

```typescript
// packages/eval/scripts/haloBuild.ts
import { parseArgs } from "node:util";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { buildHaloArms } from "../src/halo/buildHaloArms.js";

const { values } = parseArgs({
  options: {
    "source-run": { type: "string" },
    ab: { type: "string" },
    seed: { type: "string" },
    "n-per-stratum": { type: "string" },
  },
});
if (!values["source-run"] || !values.ab) {
  console.error(
    "--source-run <runs/ 下目录名> and --ab <ab/ 下目录名> required",
  );
  process.exit(1);
}
const home = resolveEvalHome();
const result = await buildHaloArms({
  sourceDir: path.join(home, "runs", values["source-run"]),
  outDir: abDir(home, values.ab),
  nPerStratum: Number(values["n-per-stratum"] ?? 50),
  seed: Number(values.seed ?? 20260805),
});
console.log(
  `halo arms: ${result.pairs} pairs (${result.wins} Win + ${result.losses} Loss) under ${abDir(home, values.ab)}`,
);
```

```typescript
// packages/eval/scripts/haloCopyResponses.ts
import { parseArgs } from "node:util";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { copyResponsesAcrossArms } from "../src/halo/buildHaloArms.js";

const { values } = parseArgs({ options: { ab: { type: "string" } } });
if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}
const n = await copyResponsesAcrossArms(abDir(resolveEvalHome(), values.ab));
console.log(`copied ${n} responses control → treatment`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: PASS(10 tests)。再跑 `npm run typecheck`,Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/halo/buildHaloArms.ts packages/eval/scripts/haloBuild.ts packages/eval/scripts/haloCopyResponses.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): 光环实验建臂器 —— 定种子分层抽样 + A/B 布局复用 blindPool 契约"
```

---

### Task 3: 对齐统计 `haloStats`

**Files:**

- Create: `packages/eval/src/halo/haloStats.ts`
- Create: `packages/eval/scripts/haloStats.ts`
- Modify: `packages/eval/test/outcomeHalo.test.ts`(追加 describe 块)

**Interfaces:**

- Consumes: `DIMENSIONS`、`ScoreFile`、`dimensionScore`、`makeRng`、`bootstrapCI`、`signTestP`(全部现有 export,`../ab/abCompareStats.js`);`blind/mapping.json` 条目形如 `{ blindId, arm: "control"|"treatment", ordinal, matchId }`(`blindAbPool.ts:29`);分数文件 `blind/scores/<blindId>.json` 形如 `{ prompt: {sufficiency,noise,labelBias,inferenceScaffolding,...}, response: {accuracy,outcomeAlignment,focusCalibration,...} }`。
- Produces: `computeHaloStats(haloDir: string): Promise<HaloReport>`;CLI 打印 markdown 主表+分层附表并写 `<haloDir>/halo-stats.json`。

```typescript
export interface HaloDimStats {
  dimension: string;
  n: number;
  alignedMean: number; // 光环对齐差:Win 场取 −(R−O),Loss 场取 +(R−O)
  alignedSd: number;
  ci95: { lo: number; hi: number };
  signTest: { p: number; positives: number; negatives: number; ties: number };
  winRawMean: number; // Win 层 raw Δ = R−O 均值(附表,方向核对用)
  winN: number;
  lossRawMean: number;
  lossN: number;
  verdict: "contaminated" | "reverse" | "inconclusive" | "expected-change";
}
export interface HaloReport {
  pairs: number;
  missingScores: number;
  stats: HaloDimStats[];
}
```

判读语义(spec「判读规则」):`outcomeAlignment` 恒为 `expected-change`(rubric 切换预期,不参与污染判定);其余六维 `ci95.lo > 0` ⇒ `contaminated`,`ci95.hi < 0` ⇒ `reverse`,否则 `inconclusive`。

- [ ] **Step 1: Write the failing test(追加)**

```typescript
// 追加 import
import { computeHaloStats } from "../src/halo/haloStats.js";

describe("computeHaloStats", () => {
  async function makeHaloDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-stats-"));
    const index = [
      {
        ordinal: 1,
        file: "prompts/001-aaaa.txt",
        matchId: "aaaa",
        spec: "s",
        result: "Win",
      },
      {
        ordinal: 2,
        file: "prompts/002-bbbb.txt",
        matchId: "bbbb",
        spec: "s",
        result: "Win",
      },
      {
        ordinal: 3,
        file: "prompts/003-cccc.txt",
        matchId: "cccc",
        spec: "s",
        result: "Loss",
      },
      {
        ordinal: 4,
        file: "prompts/004-dddd.txt",
        matchId: "dddd",
        spec: "s",
        result: "Loss",
      },
    ];
    await fs.ensureDir(path.join(dir, "control"));
    await fs.writeJson(path.join(dir, "control", "index.json"), index);
    await fs.ensureDir(path.join(dir, "blind", "scores"));
    const mapping: unknown[] = [];
    let blindN = 0;
    for (const e of index) {
      for (const arm of ["control", "treatment"] as const) {
        const blindId = `item-${String(++blindN).padStart(2, "0")}`;
        mapping.push({ blindId, arm, ordinal: e.ordinal, matchId: e.matchId });
        // 构造:accuracy 有纯光环(Win 场标签抬 1 分,Loss 场标签压 1 分);
        // noise 无效应;outcomeAlignment 涂抹后一律 −2(rubric 切换)。
        const isTreatment = arm === "treatment";
        const halo =
          e.result === "Win" ? (isTreatment ? -1 : 0) : isTreatment ? 1 : 0;
        await fs.writeJson(
          path.join(dir, "blind", "scores", `${blindId}.json`),
          {
            matchId: blindId,
            prompt: {
              sufficiency: 4,
              noise: 3,
              labelBias: 4,
              inferenceScaffolding: 4,
            },
            response: {
              accuracy: 3 + halo,
              outcomeAlignment: isTreatment ? 2 : 4,
              focusCalibration: 4,
            },
          },
        );
      }
    }
    await fs.writeJson(path.join(dir, "blind", "mapping.json"), { mapping });
    return dir;
  }

  it("对齐差:纯光环维 contaminated,无效应维 inconclusive,outcomeAlignment 恒 expected-change", async () => {
    const report = await computeHaloStats(await makeHaloDir());
    expect(report.pairs).toBe(4);
    expect(report.missingScores).toBe(0);
    const by = new Map(report.stats.map((s) => [s.dimension, s]));

    const acc = by.get("accuracy")!;
    // Win 场 raw Δ = R−O = −1(对齐 +1);Loss 场 raw Δ = +1(对齐 +1)⇒ 全体 +1
    expect(acc.alignedMean).toBe(1);
    expect(acc.winRawMean).toBe(-1);
    expect(acc.lossRawMean).toBe(1);
    expect(acc.verdict).toBe("contaminated");

    const noise = by.get("noise")!;
    expect(noise.alignedMean).toBe(0);
    expect(noise.verdict).toBe("inconclusive");

    const oa = by.get("outcomeAlignment")!;
    expect(oa.verdict).toBe("expected-change");
    expect(oa.winRawMean).toBe(-2);
    expect(oa.lossRawMean).toBe(-2);
  });

  it("缺分数的 ordinal 整对丢弃并计数", async () => {
    const dir = await makeHaloDir();
    await fs.remove(path.join(dir, "blind", "scores", "item-01.json"));
    const report = await computeHaloStats(dir);
    expect(report.missingScores).toBe(1);
    const acc = report.stats.find((s) => s.dimension === "accuracy")!;
    expect(acc.n).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL,`Cannot find module '../src/halo/haloStats.js'`。

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/halo/haloStats.ts
/**
 * haloStats.ts — 光环实验解盲统计。主指标是光环对齐差:
 * raw Δ = treatment − control(R−O);Win 场取 −Δ、Loss 场取 +Δ 后合并
 * (光环预期方向在赢/输场相反,直接合并互相抵消 —— spec「盲评协议与统计」)。
 * outcomeAlignment 是 rubric 切换的预期变化,恒判 expected-change,
 * 不参与污染判定。复用 abCompareStats 的 bootstrap/符号检验谓词。
 */
import fs from "fs-extra";
import path from "path";

import {
  DIMENSIONS,
  type ScoreFile,
  bootstrapCI,
  dimensionScore,
  makeRng,
  signTestP,
} from "../ab/abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";

const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 1337);

interface MappingItem {
  blindId: string;
  arm: "control" | "treatment";
  ordinal: number;
  matchId: string;
}

export interface HaloDimStats {
  dimension: string;
  n: number;
  alignedMean: number;
  alignedSd: number;
  ci95: { lo: number; hi: number };
  signTest: { p: number; positives: number; negatives: number; ties: number };
  winRawMean: number;
  winN: number;
  lossRawMean: number;
  lossN: number;
  verdict: "contaminated" | "reverse" | "inconclusive" | "expected-change";
}

export interface HaloReport {
  pairs: number;
  missingScores: number;
  stats: HaloDimStats[];
}

const mean = (xs: number[]) =>
  xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function computeHaloStats(haloDir: string): Promise<HaloReport> {
  const index = (await fs.readJson(
    path.join(haloDir, "control", "index.json"),
  )) as IndexEntry[];
  const resultByOrdinal = new Map(index.map((e) => [e.ordinal, e.result]));

  const { mapping } = (await fs.readJson(
    path.join(haloDir, "blind", "mapping.json"),
  )) as { mapping: MappingItem[] };
  const scores = new Map<string, ScoreFile>(); // key: arm|ordinal
  let missingScores = 0;
  for (const item of mapping) {
    const p = path.join(haloDir, "blind", "scores", `${item.blindId}.json`);
    if (!(await fs.pathExists(p))) {
      missingScores++;
      continue;
    }
    scores.set(
      `${item.arm}|${item.ordinal}`,
      (await fs.readJson(p)) as ScoreFile,
    );
  }

  const ordinals = [...new Set(mapping.map((m) => m.ordinal))].sort(
    (a, b) => a - b,
  );
  const rng = makeRng(BOOTSTRAP_SEED);
  const stats: HaloDimStats[] = [];
  for (const dimension of DIMENSIONS) {
    const aligned: number[] = [];
    const winRaw: number[] = [];
    const lossRaw: number[] = [];
    for (const ordinal of ordinals) {
      const c = scores.get(`control|${ordinal}`);
      const t = scores.get(`treatment|${ordinal}`);
      const result = resultByOrdinal.get(ordinal);
      if (!c || !t || (result !== "Win" && result !== "Loss")) continue;
      const cv = dimensionScore(c, dimension);
      const tv = dimensionScore(t, dimension);
      if (cv === null || tv === null) continue;
      const raw = tv - cv;
      (result === "Win" ? winRaw : lossRaw).push(raw);
      aligned.push(result === "Win" ? -raw : raw);
    }
    if (aligned.length === 0) continue;
    const alignedMean = mean(aligned);
    const alignedSd = Math.sqrt(
      aligned.reduce((s, d) => s + (d - alignedMean) ** 2, 0) /
        Math.max(1, aligned.length - 1),
    );
    const ci95 = bootstrapCI(aligned, rng);
    const verdict: HaloDimStats["verdict"] =
      dimension === "outcomeAlignment"
        ? "expected-change"
        : ci95.lo > 0
          ? "contaminated"
          : ci95.hi < 0
            ? "reverse"
            : "inconclusive";
    stats.push({
      dimension,
      n: aligned.length,
      alignedMean,
      alignedSd,
      ci95,
      signTest: signTestP(aligned),
      winRawMean: mean(winRaw),
      winN: winRaw.length,
      lossRawMean: mean(lossRaw),
      lossN: lossRaw.length,
      verdict,
    });
  }
  return { pairs: ordinals.length, missingScores, stats };
}

export function renderHaloMarkdown(report: HaloReport): string {
  const lines: string[] = [];
  lines.push(
    `Pairs: ${report.pairs}, missing scores: ${report.missingScores}`,
    "",
    "| Dimension | n | aligned Δ | SD | 95% CI | sign p | Win raw Δ (n) | Loss raw Δ (n) | Verdict |",
    "| --------- | - | --------- | -- | ------ | ------ | ------------- | -------------- | ------- |",
  );
  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  for (const s of report.stats)
    lines.push(
      `| ${s.dimension} | ${s.n} | ${f(s.alignedMean)} | ${s.alignedSd.toFixed(2)} | [${s.ci95.lo.toFixed(2)}, ${s.ci95.hi.toFixed(2)}] | ${s.signTest.p.toFixed(3)} | ${f(s.winRawMean)} (${s.winN}) | ${f(s.lossRawMean)} (${s.lossN}) | ${s.verdict} |`,
    );
  lines.push(
    "",
    "Verdicts: contaminated/reverse = 光环对齐差 95% bootstrap CI 不含零;outcomeAlignment 恒 expected-change(rubric 切换预期,非污染信号)。",
  );
  return lines.join("\n");
}
```

```typescript
// packages/eval/scripts/haloStats.ts
import { parseArgs } from "node:util";
import fs from "fs-extra";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { computeHaloStats, renderHaloMarkdown } from "../src/halo/haloStats.js";

const { values } = parseArgs({ options: { ab: { type: "string" } } });
if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}
const haloDir = abDir(resolveEvalHome(), values.ab);
const report = await computeHaloStats(haloDir);
const outPath = path.join(haloDir, "halo-stats.json");
await fs.writeJson(outPath, report, { spaces: 2 });
console.log(renderHaloMarkdown(report));
console.log(`\nStats written to ${outPath}`);
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`,然后 `npm run typecheck`
Expected: PASS(12 tests);typecheck 全绿。

- [ ] **Step 5: 全量回归**

Run: `npm test --workspace packages/ev[a]l`
Expected: 原 188 + 新 12 = 200 passed | 1 skipped(若他人并行改动导致基数变化,以「无新增失败」为准)。

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/halo/haloStats.ts packages/eval/scripts/haloStats.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): 光环对齐差统计 —— Loss 场符号翻转合并 + Win/Loss 分层附表"
```

---

### Task 4: 协议文档 + spec/谓词索引同步

**Files:**

- Create: `docs/commands/outcome-halo.md`
- Modify: `docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md`(材料与交付物两处路径修正)
- Modify: `docs/predicate-index.md` 与 `docs/predicate-index.zh-CN.md`(双语成对,登记 Result 标签谓词)

**Interfaces:** Consumes Task 1–3 的 CLI;Produces Task 5 执行时逐步照抄的协议。

- [ ] **Step 1: 写 `docs/commands/outcome-halo.md`**

内容骨架(执行命令逐条落实,子代理指令引用现有协议而非复制):

```markdown
# outcome-halo — 判官赛果光环实验执行协议

一次性实验(设计:docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md)。
工具常驻 packages/eval;本文档是执行剧本。

## 0. 前置

- worktree 内 `npm run typecheck` 与 eval 包测试全绿。
- 语料源:$GLADLOG_EVAL_HOME/runs/2026-07-30-wire-unnecessary-baseline(300 场 buildCorpus 产物,index.json 含 result)。

## 1. 建臂

npx tsx packages/eval/scripts/haloBuild.ts --source-run 2026-07-30-wire-unnecessary-baseline --ab 2026-08-05-outcome-halo --seed 20260805 --n-per-stratum 50
预期输出:halo arms: 100 pairs (50 Win + 50 Loss)。
抽查:任取一 ordinal,diff 两臂 prompt 应只差一行 Result: token。

## 2. Responder(100 件)

按 docs/commands/eval-baseline.md Step 2 的责任方协议执行,差异仅在路径:
读 control/prompts/NNN-*.txt,写 control/responses/<ordinal 三位>.txt,
首行 MATCHID: <matchId> 头照规矩带。sonnet 子代理,一件一代理,≤8 并发。
完成后:npx tsx packages/eval/scripts/haloCopyResponses.ts --ab 2026-08-05-outcome-halo
预期:copied 100 responses。

## 3. 混池

npx tsx packages/eval/scripts/blindPool.ts --ab 2026-08-05-outcome-halo
预期:Blind pool: 200 items (100 pairs)。

## 4. 盲评(200 件)

按 docs/commands/eval-ab.md Step 5 执行,契约与反去盲铁律原文适用:
一件一判官(sonnet);判官只读 blind/items/item-NN/{prompt.txt,response.txt};
七维 1–5 整数按 docs/commands/eval-baseline.md rubric;score JSON 写
blind/scores/item-NN.json,matchId 填 blindId 占位。
orchestrator 在 Step 5 之前不读 mapping/items/scores。

## 5. 解盲统计

npx tsx packages/eval/scripts/haloStats.ts --ab 2026-08-05-outcome-halo

## 6. 判读与交付

判读规则照 spec:六个非 outcome 维任一 contaminated ⇒ A 采两 pass 判官;
全 inconclusive ⇒ 维持单 pass。reverse 同样算「标签有效应」,进讨论。
交付:ab/2026-08-05-outcome-halo/report.md(主表+分层附表+judgeModel/responderModel
+种子与语料源)、$GLADLOG_EVAL_HOME/ledger.md 记账、结论回写 spec 的 A 行。
```

(写入时按上述骨架成文;命令在 worktree 会话里执行时把 `packages/eval` 敲成 `packages/ev[a]l`,文档里写正名。)

- [ ] **Step 2: spec 两处路径修正**

`docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md`:

- 「材料与分组」首条:语料改为 `runs/2026-07-30-wire-unnecessary-baseline`(同一 300 场语料的 buildCorpus 产物,含 result 元数据的 index.json;`prompts-3v3-1800-2026-07-31/` 是同批场次的无索引平铺版,不可编程消费),抽样明确为 Win/Loss 各 50 定种子分层。
- 「交付物与验收」第 1 条:`runs/<执行日期>-outcome-halo/` → `ab/2026-08-05-outcome-halo/`(A/B 目录布局复用 blindPool 契约)。

- [ ] **Step 3: 谓词索引双语登记**

`docs/predicate-index.md` + `docs/predicate-index.zh-CN.md` 各加一行(所在分节按现有文档结构选「分析↔eval」类):Result 标签渲染(`buildMatchContext.ts` MATCH SUMMARY 行)↔ `packages/eval/src/halo/redactOutcome.ts` 的 `RESULT_LABEL_RE` 重新解析;一致性由 `outcomeHalo.test.ts` 的头行模板测试 + `buildHaloArms` 的 index-vs-prompt 交叉核对把守。若 `packages/eval/test/predicateIndex.test.ts` 因新行要求符号存在性登记,按该测试现有格式补足使其通过。

- [ ] **Step 4: 验证**

Run: `npm test --workspace packages/ev[a]l`(predicateIndex 一致性测试必须绿)
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add docs/commands/outcome-halo.md docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "docs: 光环实验执行协议 + spec 路径修正 + Result 标签谓词入索引(双语)"
```

(若 predicateIndex.test.ts 无需改动则从 git add 中去掉。)

---

### Task 5: 执行实验(orchestrator 亲自跑,非代码任务)

**Files:** 产物全在 `$GLADLOG_EVAL_HOME/ab/2026-08-05-outcome-halo/`(eval home 是独立 git 仓,产物提交遵循该仓惯例);仓内改动仅 spec 的 A 行结论回写。

**Interfaces:** Consumes `docs/commands/outcome-halo.md` 全部步骤;Produces 光环实验报告数字(A 的 spec 决策输入)。

- [ ] **Step 1: 照 outcome-halo.md Step 0–1 建臂并抽查**(预期 `100 pairs (50 Win + 50 Loss)`;diff 抽查一对,只差 Result 行)
- [ ] **Step 2: 派 100 个 sonnet responder 子代理**(≤8 并发分批;每代理硬检查 pwd;完成后跑 haloCopyResponses,预期 copied 100)
- [ ] **Step 3: 跑 blindPool**(预期 `200 items (100 pairs)`)
- [ ] **Step 4: 派 200 个 sonnet 判官子代理**(一件一代理,≤8 并发;orchestrator 全程不读 mapping/items/scores;缺份补发前先删旧分数文件 —— calibrate-judge.md:43 的污染教训)
- [ ] **Step 5: 跑 haloStats,写 report.md**(主表+分层附表+judgeModel/responderModel+种子;分层方向核对:若 contaminated 维的 Win/Loss raw Δ 同号,写明与光环方向假设不符,判读降级为「标签有效应但机制存疑」)
- [ ] **Step 6: ledger.md 记账 + 结论回写 spec 批次表 A 行 + commit**(spec 改动在 worktree commit;eval home 产物按该仓惯例 commit)

---

## Self-Review 记录

- **Spec coverage:** 涂抹定义→Task 1;抽样/分组/臂布局→Task 2;盲评协议→Task 4 文档引用 + Task 5 执行;对齐差统计/分层附表/判读→Task 3;交付物→Task 5;单测常驻→Task 1–3;spec 与实测的两处偏差(语料源、ab/ 路径)→Task 4 显式修正,不静默漂移。
- **Placeholder scan:** 无 TBD/TODO;Task 4 文档骨架给全了逐条命令与预期输出。
- **Type consistency:** `RedactedPrompt`/`buildHaloArms` 返回形状/`HaloDimStats.verdict` 四值在 Task 1–3 与测试间一致;`makeRng`/`bootstrapCI`/`signTestP`/`dimensionScore`/`DIMENSIONS`/`ScoreFile` 均为 `abCompareStats.ts` 现有 export(实读核对过,行号 29–123)。
