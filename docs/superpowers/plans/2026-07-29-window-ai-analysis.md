# 选段 AI 分析(backlog #16)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 战报视图时间窗激活时一键【AI 分析此段】:选段证据包 → window 模式深挖 prompt → 审计 → 内联结果卡;无信号不调模型,结果落盘旁路缓存。

**Architecture:** 复用深挖全链路。analysis 侧给两个构包函数加 `windowOverride` 参数(同一收集代码,零抽取风险),新增 `buildWindowPack`(含信号门分级)与中性锚点构造器;prompt 加 `mode:"window"`。desktop main 新增 `analyzeWindow` IPC(单请求-响应 + `windowAnalysis.<lang>.json` LRU 缓存 + 幂等守卫);renderer 在 `MatchReport` 工具条挂按钮 + `WindowAnalysisCard` 终态卡。

**Tech Stack:** TypeScript、React、vitest、Electron IPC。

**Spec:** `docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md`
**工作目录:** 一律 worktree `/Users/mingjianliu/code/gladlog-wt-16`(main;依赖已装)。主检出 `/Users/mingjianliu/code/gladlog` 被用户占用,**绝对不碰**。

## Global Constraints

- 直接 commit 到 worktree 的 main 并最终 push(项目惯例,不建分支)。
- 复合命令绝不裸 `cd`(绝对路径或 `(cd … && …)` 子壳);门禁链绝不加管道。
- desktop 测试一律 `npm test --workspace=packages/desktop`(直跑单文件绕过配置出伪影,#15 踩过三次);analysis 同理 workspace 口径。
- push 前唯一门禁 `npm run presubmit`;视觉基线 CI 单源,本机绝不跑 `test:visual`。
- 谓词单源:窗口收集代码不复制——`windowOverride` 参数让 finding 锚点与用户窗口走**同一段代码**。锚点文案时间先 floor 到渲染秒(门规谓词即规范)。
- 无信号路径在 renderer 判定,**不发 IPC 不调模型**;空结果是合法输出。
- main 绝不静态 import deepDive 值(13.6MB 表进 main 模块图)——照 `deepenInner` 的动态 import 先例。

**Spec 偏差(有意,记录在案):** spec 写「抽取私有 collectPackItems」;本计划改用 `windowOverride` 可选参数达成同一目标(共用收集代码)——340 行机械搬移换 ~15 行参数化,重构风险小一个量级,谓词单源语义相同。`windowPackGate` 并入 `buildWindowPack` 返回值(null = 无信号),少一个导出面。

---

### Task 1: analysis — windowOverride 参数化 + buildWindowPack + 中性锚点

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`(buildDeepDivePack ~117-131、buildOffensiveDeepDivePack ~633-651、文件尾新增两导出)
- Modify: `packages/analysis/src/index.ts`(导出新函数)
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts`(新)

**Interfaces:**

- Consumes: 既有 `buildDeepDivePack/buildOffensiveDeepDivePack/hasCoachableSignal/hasOffensiveCoachableSignal/DeepDivePack/Finding`。
- Produces(Task 2/3/4 消费):
  - `WindowOverride = { fromS: number; toS: number }`(导出 type)
  - `buildDeepDivePack(combat, finding, findingIndex, candidates, ownerName?, windowOverride?)`(第 6 参可选,旧调用零破坏)
  - `buildOffensiveDeepDivePack(...同上第 6 参...)`
  - `buildWindowPack(combat, fromS, toS, ownerName?): { pack: DeepDivePack; kind: "survival" | "offensive" } | null`(null = 构包失败或无可教信号)
  - `buildWindowAnchorFinding(pack: DeepDivePack, fromS: number, toS: number, kind: "survival" | "offensive"): Finding`(确定性中性锚点)

- [ ] **Step 1: 写失败测试**

`deepDive.window.test.ts`(combat fixture 抄本文件 `deepDive.test.ts` ~620-682 的 `mkUnit`/`combat`/`candidates`/`finding` 写法,同一构造一字不差搬来自用):

```ts
import { describe, expect, it } from "vitest";
import {
  buildDeepDivePack,
  buildWindowAnchorFinding,
  buildWindowPack,
} from "./deepDive";
// …搬 deepDive.test.ts 的 mkUnit/combat/candidates/finding fixture(锚点 100s/105s 场)…

describe("windowOverride 等价性", () => {
  it("同一窗口:finding 锚点包与 override 包逐项相同", () => {
    const viaFinding = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
    );
    // finding 锚点 100 → 窗口 [70, 105](PACK_BEFORE_S=30 / durS 夹 105)
    const viaOverride = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: 70, toS: 105 },
    );
    expect(viaOverride).not.toBeNull();
    expect(viaOverride!.items).toEqual(viaFinding!.items);
    expect(viaOverride!.facts).toEqual(viaFinding!.facts);
    expect(viaOverride!.anchorFrom).toBe(70);
    expect(viaOverride!.anchorTo).toBe(105);
  });

  it("override 时不依赖 finding.eventIds(合成空锚点也能构包)", () => {
    const synth = {
      eventIds: [],
      severity: "low",
      category: "window",
      title: "",
      explanation: "",
    } as Finding;
    const p = buildDeepDivePack(combat, synth, 0, [], "Owner-Area52", {
      fromS: 70,
      toS: 105,
    });
    expect(p).not.toBeNull(); // 旧行为:eventIds 空 → null;override 必须绕过
  });

  it("窗口越界被夹:fromS<0 → 0,toS>durS → durS", () => {
    const p = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: -5, toS: 999 },
    );
    expect(p!.anchorFrom).toBe(0);
    expect(p!.anchorTo).toBe(105);
  });
});

describe("buildWindowPack 信号门分级", () => {
  it("生存信号过门 → kind=survival", () => {
    // 用 105s 场:窗口内有 trinket available_unused 的 ≥3s CC 时过生存门
    // (若该 fixture 无此信号,构造一个含 cc + trinket=available_unused,duration≥3
    //  的 auraEvents 变体 —— 判据抄 hasCoachableSignal 的 cc 分支)
    const r = buildWindowPack(ccCombat, 70, 105, "Owner-Area52");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("survival");
  });

  it("全不过门 → null(调用方走无信号文案)", () => {
    const r = buildWindowPack(combat, 0, 10, "Owner-Area52"); // 空窗口
    expect(r).toBeNull();
  });
});

describe("buildWindowAnchorFinding 中性锚点", () => {
  it("时间 floor 到渲染秒;无问题措辞;含 kind 计数摘要", () => {
    const f = buildWindowAnchorFinding(somePack, 36.7, 59.2, "survival");
    expect(f.title).toBe("用户选段 0:36–0:59");
    expect(f.explanation).not.toMatch(/问题|失误|错误|mistake|wrong/i);
    expect(f.eventIds).toEqual([]);
    expect(f.severity).toBe("low");
  });
});
```

(`ccCombat`/`somePack` 由实现者按上述注释用同款 mkUnit 构造;somePack 可直接用文件头 `pack` 常量样式手写。)

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- deepDive.window`
Expected: FAIL(新导出不存在)。

- [ ] **Step 3: 实现**

`buildDeepDivePack` 头部改(`buildOffensiveDeepDivePack` 同样三处对称改):

```ts
export interface WindowOverride {
  fromS: number;
  toS: number;
}

export function buildDeepDivePack(
  combat: any,
  finding: Finding,
  findingIndex: number,
  candidates: CandidateEvent[],
  ownerName?: string,
  /** 用户选段(#16):窗口取 override 原样(夹 [0, durS]),不做 -30/+10
   * padding —— 用户框的就是想看的;此时不依赖 finding.eventIds。 */
  windowOverride?: WindowOverride,
): DeepDivePack | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ts = (finding.eventIds ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is CandidateEvent => !!c && Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.t);
  if (!windowOverride && ts.length === 0) return null; // 整场观察类无锚点,不深挖
  const durS = ((combat?.endTime ?? 0) - (combat?.startTime ?? 0)) / 1000;
  const anchorFrom = windowOverride
    ? Math.max(0, windowOverride.fromS)
    : Math.max(0, Math.min(...ts) - PACK_BEFORE_S);
  const anchorTo = windowOverride
    ? Math.min(durS, windowOverride.toS)
    : Math.min(durS, Math.max(...ts) + PACK_AFTER_S);
```

`focusT`(截断焦点,survival 版在 HP 段声明为 `Math.max(...ts)`、offensive 版为 `Math.min(...ts)`):override 时两者都取窗口中点 `(anchorFrom + anchorTo) / 2`(用户窗口无天然焦点,中点最中性)。注意 `Math.max(...[])` 是 `-Infinity` —— override 分支必须先判,不能先算。

文件尾新增:

```ts
/** 用户选段构包(#16):生存收集 → 生存门;不过再进攻收集 → 进攻门;
 * 全不过 → null(调用方显示「无可教信号」,不调模型)。合成空锚点
 * finding 仅为复用两个构包函数的签名,不进 prompt(prompt 用
 * buildWindowAnchorFinding 的中性锚点)。 */
export function buildWindowPack(
  combat: any,
  fromS: number,
  toS: number,
  ownerName?: string,
): { pack: DeepDivePack; kind: "survival" | "offensive" } | null {
  const synth: Finding = {
    eventIds: [],
    severity: "low",
    category: "window",
    title: "",
    explanation: "",
  };
  const win = { fromS, toS };
  const surv = buildDeepDivePack(combat, synth, 0, [], ownerName, win);
  if (surv && hasCoachableSignal(surv.items))
    return { pack: surv, kind: "survival" };
  const off = buildOffensiveDeepDivePack(combat, synth, 0, [], ownerName, win);
  if (off && hasOffensiveCoachableSignal(off.items))
    return { pack: off, kind: "offensive" };
  return null;
}

const KIND_ZH: Record<PackItem["kind"], string> = {
  cc: "受控",
  defensive: "防御施放",
  "enemy-cd": "敌方进攻 CD",
  hp: "HP 轨迹",
  dispel: "驱散",
  "external-available": "外置可用",
  "immunity-available": "免疫可用",
  position: "走位",
  "target-hp": "目标血线",
  "enemy-defensive": "敌方防御",
  immunity: "敌方免疫",
  "our-cc": "我方控制",
  "our-cd": "我方大招",
  "off-target": "脱靶",
  "dr-clip": "踩 DR",
};

/** 中性锚点(#16 三层弥补之一):title/explanation 由 pack 统计确定性生成,
 * 不含「问题/失误」预设;时间 floor 到渲染秒(门规谓词即规范)。 */
export function buildWindowAnchorFinding(
  pack: DeepDivePack,
  fromS: number,
  toS: number,
  kind: "survival" | "offensive",
): Finding {
  const mm = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const counts = new Map<string, number>();
  for (const it of pack.items)
    counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([k, n]) => `${KIND_ZH[k as PackItem["kind"]] ?? k}×${n}`)
    .join("、");
  return {
    eventIds: [],
    severity: "low",
    category: kind === "offensive" ? "window-offensive" : "window",
    title: `用户选段 ${mm(fromS)}–${mm(toS)}`,
    explanation: `该窗口由用户手动选取。窗口内证据:${summary}。`,
  };
}
```

`index.ts` 导出 `buildWindowPack`、`buildWindowAnchorFinding`、`WindowOverride` type(挨着既有 deepDive 导出)。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis`
Expected: 全绿(新文件 + 既有 deepDive 用例零回归——等价性测试就是回归证明)。再 `npm run typecheck`。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(analysis): 深挖构包 windowOverride 参数化 + buildWindowPack 信号门分级 + 中性锚点(#16)"
```

---

### Task 2: analysis — window 模式 prompt

**Files:**

- Modify: `packages/analysis/src/analysis/deepDive.ts`(buildDeepDivePrompt ~806-863)
- Test: `packages/analysis/src/analysis/deepDive.window.test.ts`(追加 describe)

**Interfaces:**

- Produces: `buildDeepDivePrompt(packs, findings, specName, ownerName?, mode?: "deepen" | "window")`(第 5 参可选,缺省 "deepen" 行为逐字不变;Task 3 传 "window")。

- [ ] **Step 1: 写失败测试**

追加到 `deepDive.window.test.ts`:

```ts
describe("buildDeepDivePrompt window 模式", () => {
  const windowFinding = buildWindowAnchorFinding(pack, 100, 150, "survival");
  it("含选段契约:不预设有问题 + 空数组合法", () => {
    const p = buildDeepDivePrompt(
      [pack],
      [windowFinding],
      "Holy Paladin",
      "Owner-Area52",
      "window",
    );
    expect(p).toContain("manually selected");
    expect(p).toContain("Do NOT assume something went wrong");
    expect(p).toContain("output an empty array");
    expect(p).not.toContain("deepening findings"); // 追问框架文案不得出现
    expect(p).toContain("SELECTED WINDOW"); // 段头换名
    // 硬规则与输出契约保持(审计兼容锚点)
    expect(p).toContain('"findingIndex": number');
    expect(p).toContain("Write NO digits");
  });
  it("缺省 mode 行为不变(回归锚)", () => {
    const p = buildDeepDivePrompt(
      [pack],
      findings,
      "Holy Paladin",
      "Owner-Area52",
    );
    expect(p).toContain("deepening findings");
    expect(p).toContain("FINDING 0:");
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/analysis -- deepDive.window`
Expected: 新 describe FAIL(无第 5 参)。

- [ ] **Step 3: 实现**

签名加 `mode: "deepen" | "window" = "deepen"`。两处按 mode 分叉,其余(listing 渲染、HARD RULES、输出契约)一字不动:

```ts
// sections 里的段头:
mode === "window"
  ? [
      `SELECTED WINDOW ${p.findingIndex}: ${f.title} — ${f.explanation}`,
      `EVIDENCE PACK ${p.findingIndex} (window ${fmt(p.anchorFrom)}s–${fmt(p.anchorTo)}s; the ONLY additional evidence you may reference):`,
      listing,
    ].join("\n")
  : /* 原三行不动 */

// 开头指令段:
mode === "window"
  ? `You are a World of Warcraft arena coach reviewing a time window that ${ownerShort} (a ${specName}) manually selected from their own match replay. ${ownerShort} is curious whether anything in this window could have been played differently. Do NOT assume something went wrong — the window was selected out of curiosity, not because a mistake is known to be there. For the window, write ONE short paragraph (3-5 sentences) ONLY IF the evidence pack supports a specific, concrete observation about a decision ${ownerShort}'s team could have made differently. If nothing stands out, output an empty array [] — that is a good and expected answer.`
  : /* 原句不动 */
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/analysis` + `npm run typecheck`
Expected: 全绿(缺省模式回归锚保证 deepen 路径逐字未变)。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(analysis): 深挖 prompt window 模式(中性框架+空输出契约,#16)"
```

---

### Task 3: desktop main — analyzeWindow 服务 + 落盘缓存 + IPC + preload

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`
- Modify: `packages/desktop/src/main/ipc.ts`(~133 行 deepen handler 旁)
- Modify: `packages/desktop/src/preload/index.ts`(~69 行 deepen 旁)
- Modify: `packages/desktop/src/preload/api.ts`(analysis 块 ~142 deepen 旁)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts`(补桩)
- Test: `packages/desktop/src/main/analysis.test.ts`(追加 describe;harness 抄本文件既有 `createAnalysisService` + `mkdtempSync` 模式)

**Interfaces:**

- Consumes: Task 1/2 的 `buildWindowAnchorFinding`、`buildDeepDivePrompt(mode:"window")`(经动态 import)、既有 `auditDeepDives/parseModelJsonArray/resolveAiClient/resolveAiModel/buildCoachSystemPrompt/recordAiDebug`。
- Produces(Task 4 消费,preload api.ts 同型):

```ts
export type WindowAnalyzeInput = {
  matchId: string;
  fromS: number;
  toS: number;
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName?: string;
};
export type WindowAnalyzeResult =
  | {
      status: "ok";
      text: string;
      chips: DeepDiveResult["chips"];
      fromCache: boolean;
    }
  | { status: "audit-empty" } // 模型输出全部未过审计(或空)→ UI 提示可重试
  | { status: "no-client" } // 未配 AI → UI 提示去设置
  | { status: "busy" }; // 同场同窗口在飞(幂等守卫)
```

- [ ] **Step 1: 写失败测试**

`analysis.test.ts` 追加(mock client 抄本文件 `clientFactory: () => ({ stream: ... })` 既有写法;`stream` 返回的 async iterable 逐段吐合规 JSON):

```ts
describe("analyzeWindow(#16 选段分析)", () => {
  const PACK = {
    findingIndex: 0,
    anchorFrom: 30,
    anchorTo: 60,
    items: [
      {
        key: "p1",
        kind: "cc",
        t: 40,
        label: "Fear → O",
        unitNames: ["O-R"],
        facts: {
          t: "40",
          spell: "Fear",
          duration: "4.0",
          trinket: "available_unused",
        },
      },
    ],
    facts: {
      "p1.t": "40",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "available_unused",
    },
  };
  const GOOD = JSON.stringify([
    {
      findingIndex: 0,
      deepDive:
        "At {{p1.t}}s the {{p1.spell}} landed with trinket {{p1.trinket}}; trinket that stun.",
      citedKeys: ["p1"],
    },
  ]);
  const input = (dir: string) => ({
    matchId: "m1",
    fromS: 30,
    toS: 60,
    pack: PACK,
    kind: "survival" as const,
    spec: "Holy Paladin",
    ownerName: "O-Realm",
  });

  it("正常链路:LLM → 审计 → ok + 落盘;二次调用命中缓存不再调 client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir));
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") {
      expect(r1.text).toContain("At 40s");
      expect(r1.fromCache).toBe(false);
    }
    expect(
      JSON.parse(
        readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
      )["30-60"].text,
    ).toContain("At 40s");
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") expect(r2.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("审计全丢 → audit-empty 且不落盘(允许重试)", async () => {
    // client 吐裸数字条目("died at 40s" 无占位符)→ auditDeepDives 全丢
  });

  it("无 client → no-client,不写缓存", async () => {});

  it("LRU:第 21 个窗口写入后最旧 at 的条目被驱逐,文件恰 20 条", async () => {});

  it("幂等:同场同窗口在飞时第二次调用立即返回 busy,不叠加 client 调用", async () => {
    // client stream 挂在 never-resolve 的 promise 上,并发两次 analyzeWindow
  });
});
```

(注释体用例由实现者按第一条的完整样式补全——mock 变体已写明。)

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/desktop -- src/main/analysis`
Expected: FAIL(analyzeWindow 不存在)。

- [ ] **Step 3: 实现**

`analysis.ts` 内(deepen 旁):

```ts
const WINDOW_CACHE_MAX = 20;
const windowInFlight = new Set<string>(); // `${matchId}:${windowKey}`

const windowCachePath = (matchId: string, lang: AiLanguage) =>
  join(deps.matchesDir, matchId, `windowAnalysis.${lang}.json`);

type WindowCacheEntry = {
  fromS: number;
  toS: number;
  text: string;
  chips: Array<{
    t: number;
    label: string;
    unitNames: string[];
    spellId?: string;
  }>;
  at: number;
};

async function analyzeWindow(
  input: WindowAnalyzeInput,
): Promise<WindowAnalyzeResult> {
  const windowKey = `${Math.floor(input.fromS)}-${Math.floor(input.toS)}`;
  const flight = `${input.matchId}:${windowKey}`;
  if (windowInFlight.has(flight)) return { status: "busy" };
  windowInFlight.add(flight);
  try {
    const settings = deps.getSettings();
    const lang: AiLanguage = settings.aiLanguage ?? "zh";
    const path = windowCachePath(input.matchId, lang);
    let cache: Record<string, WindowCacheEntry> = {};
    try {
      cache = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      /* 首次 */
    }
    const hit = cache[windowKey];
    if (hit)
      return {
        status: "ok",
        text: hit.text,
        chips: hit.chips,
        fromCache: true,
      };

    const client = resolveAiClient(settings, deps.clientFactory);
    if (!client) return { status: "no-client" };

    // 动态 import:与 deepenInner 同理由(13.6MB 表不进 main 启动模块图)
    const [
      { buildDeepDivePrompt, auditDeepDives, buildWindowAnchorFinding },
      { ensureAnalysisData },
    ] = await Promise.all([
      import("@gladlog/analysis/src/analysis/deepDive"),
      import("@gladlog/analysis/src/data/ensure"),
    ]);
    await ensureAnalysisData();
    const anchor = buildWindowAnchorFinding(
      input.pack,
      input.fromS,
      input.toS,
      input.kind,
    );
    const prompt = buildDeepDivePrompt(
      [input.pack],
      [anchor],
      input.spec,
      input.ownerName,
      "window",
    );
    let raw = "";
    const stream = client.stream({
      model: resolveAiModel(settings),
      max_tokens: 2048, // 单 pack 单段,deepen 的 4096 是 8 条口径
      system: buildCoachSystemPrompt(lang),
      messages: [{ role: "user", content: prompt }],
    });
    for await (const ev of stream) if (ev.delta) raw += ev.delta;
    recordAiDebug({
      kind: "analysis",
      matchId: `${input.matchId}#window:${windowKey}`,
      at: Date.now(),
      model: resolveAiModel(settings),
      prompt,
      raw,
    });
    const dives = auditDeepDives(parseModelJsonArray(raw), [input.pack]);
    const d = dives.find((x) => x.findingIndex === 0);
    if (!d) return { status: "audit-empty" }; // 不落盘,允许重试
    cache[windowKey] = {
      fromS: input.fromS,
      toS: input.toS,
      text: d.text,
      chips: d.chips,
      at: Date.now(),
    };
    const keys = Object.keys(cache);
    if (keys.length > WINDOW_CACHE_MAX) {
      const evict = keys
        .sort((a, b) => cache[a]!.at - cache[b]!.at)
        .slice(0, keys.length - WINDOW_CACHE_MAX);
      for (const k of evict) delete cache[k];
    }
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), "utf-8");
    renameSync(tmp, path);
    return { status: "ok", text: d.text, chips: d.chips, fromCache: false };
  } catch {
    return { status: "audit-empty" }; // 网络/解析失败同待遇:可重试,不落盘
  } finally {
    windowInFlight.delete(flight);
  }
}
```

`analyzeWindow` 加进 service 返回对象。类型 `WindowAnalyzeInput/WindowAnalyzeResult` 导出。
注意:**不用**代际计数器(nextGen)——窗口分析是单请求-响应,不与 run/deepen 抢写 `analysis-v2` 缓存,互不作废;幂等守卫已防重。

`ipc.ts`:

```ts
ipcMain.handle("gladlog:analysis:analyzeWindow", (_e, input) =>
  deps.analysis.analyzeWindow(input),
);
```

`preload/index.ts`:

```ts
analyzeWindow: (input) => ipcRenderer.invoke("gladlog:analysis:analyzeWindow", input),
```

`preload/api.ts` analysis 块加(类型与 main 导出同型,unknown 化同 deepen 先例):

```ts
/** 选段分析(#16):pack 由 renderer 确定性构建;单请求-响应,不走 emit。 */
analyzeWindow(input: {
  matchId: string; fromS: number; toS: number;
  pack: unknown; kind: "survival" | "offensive";
  spec: string; ownerName?: string;
}): Promise<
  | { status: "ok"; text: string; chips: Array<{ t: number; label: string; unitNames: string[]; spellId?: string }>; fromCache: boolean }
  | { status: "audit-empty" } | { status: "no-client" } | { status: "busy" }
>;
```

`fixtureBridge.ts` analysis 桩对象加:`async analyzeWindow() { return { status: "no-client" as const }; }`。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(desktop): analyzeWindow 主进程服务(LRU 落盘缓存+幂等守卫)+ IPC/preload(#16)"
```

---

### Task 4: desktop renderer — resolveOwner 提取 + 按钮 + WindowAnalysisCard

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/analysisInput.ts`(提取 resolveOwner + 新 buildWindowAnalysisRequest)
- Create: `packages/desktop/src/renderer/src/report/components/WindowAnalysisCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(工具条按钮 + 状态机 + 卡挂载)
- Modify: `packages/desktop/src/renderer/src/styles.css`(卡样式微量)
- Test: `packages/desktop/test/windowAnalysis.test.tsx`(新;fixture 桩用 `__gladlogFixture` 既有模式)

**Interfaces:**

- Consumes: Task 1 `buildWindowPack`、Task 3 bridge `analysis.analyzeWindow`、#15 `makeRichText`、既有 `toLegacySafe/specToString/ensureAnalysisData/ChipIcon`、`MatchReport` 的 `handleSeekEvent`。
- Produces:

```ts
// analysisInput.ts
export function resolveOwner(legacy: LegacyLike): Unit | undefined; // buildAnalysisInput 内联逻辑原样提取,两处共用
export function buildWindowAnalysisRequest(
  source: ReportSource,
  fromS: number,
  toS: number,
): {
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName: string;
} | null;
// null = owner 缺失/构包失败/无可教信号 → 调用方显示无信号文案,不发 IPC

// WindowAnalysisCard.tsx
export type WindowCardState =
  | { phase: "loading" }
  | { phase: "result"; text: string; chips: Chips; fromCache: boolean }
  | { phase: "none" } // 无信号(确定性,零成本)
  | { phase: "audit-empty" } // 可重试
  | { phase: "no-client" };
export function WindowAnalysisCard(props: {
  state: WindowCardState;
  range: { fromS: number; toS: number };
  rich: (t?: string | null) => ReactNode;
  onJumpT: (tSeconds: number, unitNames: string[]) => void;
  onRetry: () => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败测试**

`test/windowAnalysis.test.tsx`(`// @vitest-environment jsdom`;真实 fixture `test/fixtures/real-match-sample.json` 剥了死亡/承伤——无信号路径天然可测;fixture 别用 spellId="1"):

```tsx
// 1) buildWindowAnalysisRequest:裁剪 fixture 上任意窗口 → null(无死亡/承伤,门不过),不抛
// 2) MatchReport 无 timeRange → 无【AI 分析此段】按钮;设 initialTimeRange={fromS:36,toS:59} → 按钮出现
// 3) 点按钮(fixture 门不过)→ 出「未检出可教信号」卡,且 __gladlogFixture.analysis.analyzeWindow 未被调用(vi.fn 计数 0)
// 4) 窗口 onChange(TimeRangeBar 清除)→ 卡收起
// 5) WindowAnalysisCard 单测:result 态渲染 text(经注入 rich)+ chips 按钮点了调 onJumpT;audit-empty 态有重试按钮调 onRetry
```

每条写成真实断言(选择器:按钮 `data-testid="window-ai-btn"`,卡 `data-testid="window-ai-card"`),组件桩照 `MatchReport.initialView.test.tsx` 的挂载方式。

- [ ] **Step 2: 跑测确认失败**

Run: `npm test --workspace=packages/desktop -- windowAnalysis`
Expected: FAIL。

- [ ] **Step 3: 实现**

`analysisInput.ts`:把 buildAnalysisInput 里 owner 解析四行提为 `export function resolveOwner(legacy)`(原调用点改用它,行为逐字保留);新增:

```ts
/** 选段分析请求(#16):构包 + 判门全在 renderer,门不过返回 null(不发 IPC)。
 * 前置契约:调用前 await ensureAnalysisData()(prompt 法术名不许降级)。 */
export function buildWindowAnalysisRequest(
  source: ReportSource,
  fromS: number,
  toS: number,
) {
  try {
    const legacy = toLegacySafe(source);
    const owner = resolveOwner(legacy);
    if (!owner) return null;
    const r = buildWindowPack(legacy, fromS, toS, owner.name);
    if (!r) return null;
    return {
      pack: r.pack,
      kind: r.kind,
      spec: specToString(owner.spec),
      ownerName: owner.name,
    };
  } catch {
    return null;
  }
}
```

`WindowAnalysisCard.tsx`:finding 卡样式(`rpt-finding rpt-finding-low` 容器 + `data-testid="window-ai-card"`);头行「选段分析 0:36–0:59」+ fromCache 时小字「(缓存)」;phase 分支:

- loading:「分析中…(约 10–30s)」;
- result:`<p className="rpt-finding-body">{rich(text)}</p>` + chips 行(`<ChipIcon spellId={c.spellId} />⏱ {mmss(c.t)} {c.label}`,onClick → `onJumpT(c.t, c.unitNames)`——FindingsList 深挖 chips 同款);
- none:「这段未检出可教信号(无受控/防御施放/敌方爆发/HP 骤降等)。」;
- audit-empty:「模型输出未通过审计。」+ 重试按钮(onRetry);
- no-client:「未配置 AI(设置里填 API Key 后可用)。」。

`MatchReport.tsx`:

- state:`const [winAi, setWinAi] = useState<{ range: TimeRange; state: WindowCardState } | null>(null);`
- `timeRange` 变化(含清除)即 `setWinAi(null)`(effect 对比 range 不等就收卡;缓存命中重点一次即可回显,不自动查)。
- 工具条按钮(TimeRangeBar 与「复制 Markdown」之间):

```tsx
{
  timeRange && (
    <button
      className="rpt-btn"
      data-testid="window-ai-btn"
      title="对当前选段做一次 AI 深挖(无可教信号时不调用模型)"
      onClick={() => void runWindowAi(timeRange)}
    >
      AI 分析此段
    </button>
  );
}
```

- 处理函数(组件内):

```tsx
const runWindowAi = async (range: TimeRange) => {
  setWinAi({ range, state: { phase: "loading" } });
  await ensureAnalysisData(); // 构包前置契约
  const req = buildWindowAnalysisRequest(source, range.fromS, range.toS);
  if (!req) return setWinAi({ range, state: { phase: "none" } }); // 不发 IPC
  try {
    const r = await bridge().analysis.analyzeWindow({
      matchId: resolvedMatchId,
      fromS: range.fromS,
      toS: range.toS,
      pack: req.pack,
      kind: req.kind,
      spec: req.spec,
      ownerName: req.ownerName,
    });
    if (r.status === "ok")
      setWinAi({
        range,
        state: {
          phase: "result",
          text: r.text,
          chips: r.chips,
          fromCache: r.fromCache,
        },
      });
    else if (r.status === "busy")
      return; // 在飞:保持 loading,结果由先前调用落缓存后用户再点回显
    else setWinAi({ range, state: { phase: r.status } });
  } catch {
    setWinAi({ range, state: { phase: "audit-empty" } }); // 无桥/异常同可重试待遇
  }
};
```

- rich:`const [aiLang, setAiLang] = useState<"zh" | "en">("zh");` + mount effect 读 `bridge().settings.get()`(try/catch,ProComparisonVerified 同款);`const rich = useMemo(() => makeRichText(source, aiLang), [source, aiLang]);`(点击流程先 await 了 ensureAnalysisData,结果渲染时索引必已就绪——不需要 dataReady 门,注释说明)。
- 卡挂载:工具条行下、`<Timeline>` 上方,`winAi && <WindowAnalysisCard state={winAi.state} range={winAi.range} rich={rich} onJumpT={handleSeekEvent} onRetry={() => void runWindowAi(winAi.range)} />`。

`styles.css`:`.rpt-window-ai { margin: 8px 0; }` 一类微量(实现者按需要,勿大改)。

- [ ] **Step 4: 跑测确认通过**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck` + `npx eslint packages/desktop/src --quiet`
Expected: 全绿。

- [ ] **Step 5: run-ui 真眼验收(试验台)**

dev:ui 起在 worktree(5199 被占会自动换口),真实 fixture 拖选窗口 → 点按钮 → 无信号卡出现(裁剪 fixture 无死亡,天然走 none 路径);fixtureBridge 桩返回 no-client 时终态卡文案正确。截图留档。

- [ ] **Step 6: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "feat(desktop): 战报选段【AI 分析此段】按钮 + WindowAnalysisCard 终态卡(#16)"
```

---

### Task 5: 门禁、push、CI、视觉基线、backlog 收账

**Files:**

- Modify: `docs/BACKLOG.md`(#16 标题行 ✅)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/report-window.png`(CI 生成人审——该场景 initialTimeRange={36,59} 激活,新按钮必然入镜)

- [ ] **Step 1: presubmit**

Run(worktree): `(cd /Users/mingjianliu/code/gladlog-wt-16 && npm run presubmit)`
Expected: 全绿;红了修到绿,不跳步。

- [ ] **Step 2: backlog 收账 + push**

`docs/BACKLOG.md` #16 标题行加:
`✅(2026-07-29 落地:TimeRangeBar 选段→windowOverride 构包→window 模式深挖→WindowAnalysisCard;无信号零成本路径;windowAnalysis.<lang>.json LRU 缓存;spec docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md;真模型 filler smoke 待真机)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-16 add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-16 commit -m "docs: backlog #16 收账"
git -C /Users/mingjianliu/code/gladlog-wt-16 push
```

- [ ] **Step 3: 按 headSha 盯 CI**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-16 rev-parse HEAD)
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
# run 可能延迟建出:空则 sleep 20 重查;拿到 id 后
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run watch <RUN_ID> --exit-status)
```

frontend-qa 若因 report-window 基线红 → 预期,走 Step 4。

- [ ] **Step 4: 视觉基线重生成(CI 单源,人审)**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh workflow run visual-baseline.yml --ref main)
# 循环查 status(gh run watch 会提前退出);完成后
RUN=$(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run list --workflow visual-baseline.yml --limit 1 --json databaseId -q '.[0].databaseId')
(cd /Users/mingjianliu/code/gladlog-wt-16 && gh run download $RUN -n visual-baselines -D /tmp/bl16)
for f in /tmp/bl16/scenes.spec.ts/*.png; do n=$(basename $f); cmp -s "$f" /Users/mingjianliu/code/gladlog-wt-16/packages/desktop/qa/__screenshots__/scenes.spec.ts/$n || echo "DIFF $n"; done
```

DIFF 逐张 Read 人审:变化必须是「report-window 工具条多一个按钮」可解释;其他场景不许动。审过 cp 覆盖、commit、push,回 Step 3 盯绿。

- [ ] **Step 5: 汇报验收数字 + 真机 smoke 交接**

- 前后数字:同一 fixture 场景,窗口激活时按钮 0→1;无信号路径 analyzeWindow 调用计数 0(测试断言);缓存命中 client 调用 1→1(不增)。
- **真模型 filler smoke 留给用户真机**(spec 三层弥补之验证层):真库挑 3-4 场,每场选「有死亡窗/平静窗/进攻窗」各一段点分析,人审:平静窗是否老实说没问题、有信号窗建议是否落在 pack 证据上。这是收官条件之一,写进汇报待办。

---

## Self-Review 记录(定稿前跑过)

1. **Spec 覆盖**:构包/门分级/中性锚点(T1)、window prompt 三层弥补之一(T2)、IPC/缓存 LRU/幂等/audit-empty 不落盘(T3)、按钮/终态卡/无信号零 IPC/rich 复用(T4)、presubmit/基线/收账/smoke 交接(T5)。spec 的 collectPackItems 与 windowPackGate 两处按「Spec 偏差」段有记录地精化。
2. **占位符**:Task 3 Step 1 有三条注释体用例、Task 4 Step 1 为清单式——均已写明 mock 变体与断言目标,实现者按首条完整样例补全,不属 TBD;其余无。
3. **类型一致**:`WindowAnalyzeInput/Result` 在 T3 定义、T4 经 preload api 同型消费;`buildWindowPack` 返回 `{pack, kind} | null` 三处一致;`WindowCardState.phase` 与 result.status 字面量对齐(busy 不进卡态,loading 覆盖)。
