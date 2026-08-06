# 后视偏差谓词(子项目 C)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** findings 时序约束从散文规则升级为确定性谓词 `hindsightViolations`,产品门(auditFindings 第五层 drop)+ eval 扫描双侧消费,入谓词索引。

**Architecture:** 谓词单文件 `hindsightLint.ts`(causalLint 同款范式:analysis 单源 export,多消费方 import);比较基于**渲染事实** `facts.t`(fmtFactNum 十进制秒字符串),不是 `CandidateEvent.t`(whole-round 候选的 `t` 填 0,会毒化 min;`facts.t === undefined` 才是 whole-round 的判据,与菜单渲染 `t=whole-round` 完全一致)。

**Tech Stack:** TypeScript,vitest。测试跑法:`npm test --prefix packages/eval`(eval 侧)与 `npx vitest run <file> --root packages/analysis`(analysis 侧)。绝不 `tsc -b`;typecheck 用 `npm run typecheck`。

## Global Constraints

- 门规谓词即规范:`HINDSIGHT_CLUSTER_SLACK_S` 与 `hindsightViolations` 单源 export,消费方 import,不复制常量;
- 比较锚定渲染值:一律 `Number(facts.t)`,`facts.t === undefined` 的引用不参与锚点也不豁免整条;
- 双语成对:predicate-index 两语各加同义行;
- spec `docs/superpowers/specs/2026-08-06-hindsight-predicate-design.md` 的规则 1-3 逐字为准;
- 违规理由字符串为中文、含 `T`、`e.t`、`e.type` 三个具体值;
- 不改 findings 输出 schema、不改 PROMPT_VERSION、不动 deepDive。

---

### Task 1: hindsightLint 谓词

**Files:**

- Create: `packages/analysis/src/analysis/hindsightLint.ts`
- Test: `packages/analysis/src/analysis/hindsightLint.test.ts`

**Interfaces:**

- Produces: `export const HINDSIGHT_CLUSTER_SLACK_S = 30;` 与 `export function hindsightViolations(eventIds: string[], byId: Map<string, CandidateEvent>): string[]`(空数组=通过)。注意入参是 `eventIds`,不是整个 finding——审计层在 grounding 之后调用,id 必已可解析。

- [ ] **Step 1: 写失败测试**(用最小 CandidateEvent 构造器 `mk(id, type, t?)`,`t === undefined` 时 facts 不含 t):

```ts
import { describe, expect, it } from "vitest";
import {
  HINDSIGHT_CLUSTER_SLACK_S,
  hindsightViolations,
} from "./hindsightLint";
import type { CandidateEvent } from "./types";

const mk = (id: string, type: string, t?: number): CandidateEvent => ({
  id,
  type,
  t: t ?? 0,
  unitNames: [],
  facts: t === undefined ? {} : { t: String(t) },
});
const byId = (...es: CandidateEvent[]) => new Map(es.map((e) => [e.id, e]));

describe("hindsightViolations", () => {
  it("跨类型且超出聚簇窗 ⇒ 违规,理由含三个具体值", () => {
    const m = byId(
      mk("a", "kick-eaten", 130),
      mk("b", "death-unused-defensive", 161),
    );
    const v = hindsightViolations(["a", "b"], m);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("130");
    expect(v[0]).toContain("161");
    expect(v[0]).toContain("death-unused-defensive");
  });
  it("恰好 30s 边界 ⇒ 通过(> 才违规)", () => {
    const m = byId(mk("a", "kick-eaten", 100), mk("b", "cc-locked", 130));
    expect(hindsightViolations(["a", "b"], m)).toEqual([]);
  });
  it("同 type 跨时段 ⇒ 通过(模式豁免)", () => {
    const m = byId(mk("a", "kick-eaten", 10), mk("b", "kick-eaten", 200));
    expect(hindsightViolations(["a", "b"], m)).toEqual([]);
  });
  it("whole-round 引用不参与锚点、也不豁免其余引用", () => {
    const m = byId(
      mk("w", "cd-waste"),
      mk("a", "kick-eaten", 130),
      mk("b", "cc-locked", 200),
    );
    expect(hindsightViolations(["w", "a", "b"], m)).toHaveLength(1);
  });
  it("有时刻事件不足 2 个 ⇒ 通过", () => {
    const m = byId(mk("w", "cd-waste"), mk("a", "kick-eaten", 130));
    expect(hindsightViolations(["w", "a"], m)).toEqual([]);
    expect(hindsightViolations(["a"], m)).toEqual([]);
  });
  it("锚点并列多 type:远期事件 type 在聚簇内出现过 ⇒ 通过", () => {
    const m = byId(
      mk("a", "kick-eaten", 10),
      mk("b", "cc-locked", 12),
      mk("c", "cc-locked", 300),
    );
    expect(hindsightViolations(["a", "b", "c"], m)).toEqual([]);
  });
  it("多个远期跨类型引用逐条报告", () => {
    const m = byId(
      mk("a", "kick-eaten", 10),
      mk("b", "cc-locked", 100),
      mk("c", "wasted-trinket", 200),
    );
    expect(hindsightViolations(["a", "b", "c"], m)).toHaveLength(2);
  });
  it("常量导出为 30", () => {
    expect(HINDSIGHT_CLUSTER_SLACK_S).toBe(30);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**(模块不存在)
- [ ] **Step 3: 最小实现**:

```ts
import type { CandidateEvent } from "./types";

/** 同一次交手的聚簇窗(秒)。独立常量,语义≠deepDive 的 PACK_BEFORE_S。 */
export const HINDSIGHT_CLUSTER_SLACK_S = 30;

/**
 * 后视偏差谓词(spec 2026-08-06-hindsight-predicate-design 规则 1-3)。
 * 比较基于渲染事实 facts.t(菜单里模型看到的值);facts.t 缺失 = whole-round,
 * 不参与锚点计算也不豁免整条。
 */
export function hindsightViolations(
  eventIds: string[],
  byId: Map<string, CandidateEvent>,
): string[] {
  const timed = eventIds
    .map((id) => byId.get(id))
    .filter(
      (e): e is CandidateEvent => e !== undefined && e.facts.t !== undefined,
    )
    .map((e) => ({ e, t: Number(e.facts.t) }))
    .filter(({ t }) => Number.isFinite(t));
  if (timed.length < 2) return [];
  const anchorT = Math.min(...timed.map(({ t }) => t));
  const clusterTypes = new Set(
    timed
      .filter(({ t }) => t <= anchorT + HINDSIGHT_CLUSTER_SLACK_S)
      .map(({ e }) => e.type),
  );
  const out: string[] = [];
  for (const { e, t } of timed) {
    if (t - anchorT > HINDSIGHT_CLUSTER_SLACK_S && !clusterTypes.has(e.type)) {
      out.push(
        `hindsight: 引用了锚点 ${anchorT}s 之后 ${t}s 的 ${e.type} 事件,跨类型且超出 ${HINDSIGHT_CLUSTER_SLACK_S}s 聚簇窗`,
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试全绿**
- [ ] **Step 5: Commit** `feat(analysis): hindsightLint 后视偏差谓词 —— 隐式锚点+聚簇豁免,锚定渲染 facts.t`

### Task 2: auditFindings 第五层 drop

**Files:**

- Modify: `packages/analysis/src/analysis/auditFindings.ts`(在 causalLint 层之后、accept 之前)
- Test: `packages/analysis/src/analysis/auditFindings.test.ts`(追加用例;文件已存在则追加,不存在则建)

**Interfaces:**

- Consumes: Task 1 的 `hindsightViolations(finding.eventIds, byId)`。
- Produces: dropped reason 前缀 `hindsight: `(谓词返回串已带前缀,直接 `dropped.push({ finding, reason: violations.join("; ") })`)。

- [ ] **Step 1: 失败测试** —— 构造含 kick-eaten@130 + death-unused-defensive@161 两候选的 `auditFindings` 调用,断言该 finding 进 `dropped` 且 reason 含 `hindsight:`;再加一条同 type 跨时段 finding 断言存活。测试里的候选 facts 需带 `t`(字符串),finding 的 explanation 用合法占位符(照该文件现有测试的构造方式)。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— causalLint drop 块之后:

```ts
const hv = hindsightViolations(f.eventIds, byId);
if (hv.length > 0) {
  dropped.push({ finding: f, reason: hv.join("; ") });
  continue;
}
```

(import 加到文件头;如该文件的 drop 循环里 finding 变量名不是 `f`、map 不是 `byId`,以现文件为准对齐。)

- [ ] **Step 4: 跑 analysis 全套测试 + `npm run typecheck`**
- [ ] **Step 5: Commit** `feat(analysis): auditFindings 第五层 hindsight drop —— 消费 hindsightLint 谓词`

### Task 3: hindsightScan 语料工具

**Files:**

- Create: `packages/eval/scripts/hindsightScan.ts`
- Test: `packages/eval/test/hindsightScan.test.ts`(核心纯函数)

**Interfaces:**

- Consumes: `@gladlog/analysis` 的 `hindsightViolations`、`HINDSIGHT_CLUSTER_SLACK_S`(跨包 import 走既有 workspace 依赖;eval 已依赖 analysis 则直接用,否则声明依赖)。
- Produces: 两个模式。
  - `--synthesize --run <runId>`:从 run 语料(复用 `smokeFindingsPrompt.ts` 取候选菜单的现成路径;若无可复用函数则从其源码抽公共函数)采样菜单,合成两组 finding:20 个**种植违规**(取同菜单内跨 type 且 Δfacts.t > 30s 的事件对)与 20 个**合法**(同 type 对 / 30s 内聚簇对 / death-setup 单事件),对每个跑谓词,打印 `planted caught X/20, legit passed Y/20` 与逐条表。菜单不足以凑满 20 时如实打印实际 n,不虚报。
  - `--check <jsonl>`:每行 `{eventIds, candidates}`,跑谓词报违规行号与理由(冒烟复核用)。
- 核心逻辑(采样、合成、判定)抽成 export 的纯函数,脚本壳只做 IO——测试测纯函数:给定人造菜单,种植合成必被谓词抓、合法合成必通过。

- [ ] **Step 1: 失败测试**(纯函数:`synthesizePlanted(menu)` 返回的每个 finding 跑谓词非空;`synthesizeLegit(menu)` 每个为空)
- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 全绿 + typecheck**
- [ ] **Step 5: Commit** `feat(eval): hindsightScan 语料工具 —— 种植/合法合成 + 谓词复核两模式`

### Task 4: 谓词索引双语登记

**Files:**

- Modify: `docs/predicate-index.md`("Gate side (`packages/eval`)" 节)与 `docs/predicate-index.zh-CN.md` 同节
- Modify: `packages/eval/test/predicateIndex.test.ts`

**Steps:**

- [ ] 两语各加一行(格式照该节现有行,登记 `hindsightViolations` + `HINDSIGHT_CLUSTER_SLACK_S`,消费方 `auditFindings`(产品)与 `hindsightScan`(eval),备注豁免语义一句话)。
- [ ] `predicateIndex.test.ts` 照现有范式钉扎:符号存在于 `hindsightLint.ts`、常量值 30 单源、索引行两语同在。
- [ ] 跑 `npm test --prefix packages/eval` 全绿。
- [ ] Commit `docs: hindsightViolations 谓词双语登记 + 一致性钉扎`

### Task 5: 验收实验(orchestrator 亲跑,不派实现子代理)

- [ ] Step 1: `--synthesize` 跑真实语料 run(现成 run 选覆盖广的,如 2026-07-16-baseline),记录种植 X/20、合法 Y/20;不达 20/20、0/20 就修谓词再跑(修法进 commit,不放宽验收)。
- [ ] Step 2: 20 场真实冒烟:对语料 20 场构建 findings prompt(smokeFindingsPrompt 路径),每场一个 sonnet responder 子代理产 findings JSON,走 parse + auditFindings(新五层),统计 hindsight drop 率;drop 逐条人工复核,误杀 >1/3 则回炉调规则(改动进 spec)。
- [ ] Step 3: 结果写回 spec 验收表(实测数字)+ SDD 台账;报告落 `$GLADLOG_EVAL_HOME/ab/2026-08-06-hindsight/report.md`。
- [ ] Commit spec 写回。

## Self-review

- spec 覆盖:规则 1-3(Task 1)、产品门(Task 2)、eval 扫描+种植验收(Task 3+5)、谓词索引(Task 4)、验收表三行(Task 5)全对应;spec 落点里的 `buildCalibrationSuite` hindsight-pair 扰动类**移到 hindsightScan 内实现**(种植合成即扰动生成,判官校准与确定性谓词无关)——spec 落点一节随 Task 5 写回时同步勘正。
- 占位符扫描:无 TBD;Task 2 的变量名对齐说明是现实约束不是留白。
- 类型一致:`hindsightViolations(eventIds: string[], byId: Map<string, CandidateEvent>)` 全文一致;facts.t 判据全文一致。
