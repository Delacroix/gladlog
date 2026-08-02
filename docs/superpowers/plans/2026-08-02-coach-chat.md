# 问教练(对局内 AI 聊天)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 战报 AI 视图新增「问教练」聊天卡 —— resume「AI 分析」那次 CLI 调用的 session 进行多轮追问;仅本地 CLI 后端(claudeCli/agy/codex)支持,且必须同一 CLI 已完成本回合分析。

**Architecture:** 分析链路为三个 CLI 捕获/指定 session id 存进分析结果(`AnalysisResult.sessionId`);main 侧新增 coachChat 服务管理每 CLI 一条的落盘线程(`coachChat.<lang>.json`),续聊走各 CLI 的原生 resume,失败两段自愈重播种;renderer 聊天卡四态状态机。Spec:`docs/superpowers/specs/2026-08-02-coach-chat-design.md`。

**Tech Stack:** Electron main/renderer + IPC(现有 analysis.ts 模式)、localAiBackends 的 Runner 抽象、vitest。

## Global Constraints

- 遵守 `.claude/skills/desktop-dev` 全部约定:renderer 不得从 `src/main/*` 值引入(type-only 可以);跨进程共享纯逻辑放 `src/shared/`;bridge 面访问必须容忍桩缺面。
- 三 CLI 的 session 接口(2026-08-02 本机实测,spec 表格为准):claudeCli `--session-id <uuid>` / `claude -p --resume <id>`;agy `--output-format json` 信封含 `conversation_id` / `--conversation <id>`;codex `--json` 事件流含 session id / `codex exec resume <id>`,且 codex 捕获 session 时**必须去掉 `--ephemeral`**(该 flag 明确表示不落盘 session)。
- 分析主流程**绝不因 session 捕获失败而失败**:信封/JSONL 解析不出 id 就没有 sessionId,聊天门槛自然拦住,分析照常成功。
- 聊天回答是自由文本,不走 findings 审计;UI 固定小字「回答基于日志推理,可能有误」。
- API 后端(anthropic/deepseek)不支持聊天,任何代码路径不得为其开聊天口。
- 测试跑法:workspace 内 `npx vitest run <file>`(repo 根跑会缺 globals);push 前 `npm run presubmit`。
- 提交:直接 commit 到 main(用户惯例),每个 Task 一个 commit。

---

### Task 1: AnthropicLike 会话事件 + claudeCli `--session-id`

**Files:**

- Modify: `packages/desktop/src/main/ai.ts`(AnthropicLike 接口)
- Modify: `packages/desktop/src/main/localAiBackends.ts`(claudeCliClientFactory)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `AnthropicLike.stream` 参数新增 `sessionIdHint?: string`(claudeCli 专用)与 `captureSession?: boolean`(agy/codex 用,本 task 只定义类型);事件类型从 `{delta?: string}` 扩为 `{delta?: string; sessionId?: string}`。claudeCli 传了 `sessionIdHint` 时:args 追加 `"--session-id", hint`,并在 delta 之后 yield `{sessionId: hint}`。
- Consumes: 现有 `claudeCliClientFactory(opts?: {cmd?, run?})`、`Runner` 类型。

- [ ] **Step 1: Write the failing test**

在 `localAiBackends.test.ts` 现有 claudeCli describe 附近新增:

```ts
it("claudeCli:传 sessionIdHint 时追加 --session-id 并回报 sessionId 事件", async () => {
  const calls: string[][] = [];
  const run: Runner = async (_f, args) => {
    calls.push(args);
    return "回答文本";
  };
  const client = claudeCliClientFactory({ cmd: "/bin/claude", run });
  const events: Array<{ delta?: string; sessionId?: string }> = [];
  for await (const ev of client.stream({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    sessionIdHint: "11111111-2222-3333-4444-555555555555",
  })) {
    events.push(ev);
  }
  expect(calls[0]).toContain("--session-id");
  expect(calls[0]).toContain("11111111-2222-3333-4444-555555555555");
  expect(events).toEqual([
    { delta: "回答文本" },
    { sessionId: "11111111-2222-3333-4444-555555555555" },
  ]);
});

it("claudeCli:不传 sessionIdHint 时 args 与事件保持旧形状", async () => {
  const calls: string[][] = [];
  const run: Runner = async (_f, args) => {
    calls.push(args);
    return "ok";
  };
  const client = claudeCliClientFactory({ cmd: "/bin/claude", run });
  const events: unknown[] = [];
  for await (const ev of client.stream({
    model: "m",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(ev);
  }
  expect(calls[0]).not.toContain("--session-id");
  expect(events).toEqual([{ delta: "ok" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL(TS 报 `sessionIdHint` 不在参数类型上,或运行时 args 不含 `--session-id`)

- [ ] **Step 3: Write minimal implementation**

`ai.ts` 的 AnthropicLike 改为:

```ts
export interface AnthropicLike {
  stream(params: {
    model: string;
    max_tokens: number;
    /** 教练角色 + 输出语言指令(backlog #1);本地后端拼接到 prompt 前。 */
    system?: string;
    messages: { role: "user"; content: string }[];
    /** coach chat(2026-08-02 spec):claudeCli 专用 —— 由调用方生成 UUID,
     * 工厂追加 `--session-id <hint>` 并在文本后 yield {sessionId: hint}。 */
    sessionIdHint?: string;
    /** coach chat:agy/codex 专用 —— 切到可捕获会话 id 的输出格式并
     * yield {sessionId}。捕获失败不抛错,只是没有 sessionId 事件。 */
    captureSession?: boolean;
  }): AsyncIterable<{ delta?: string; sessionId?: string }>;
}
```

`claudeCliClientFactory` 的 stream 内:

```ts
const sessionArgs = params.sessionIdHint
  ? ["--session-id", params.sessionIdHint]
  : [];
const out = await withVersionHint(
  () =>
    run(
      cmd,
      ["-p", "--output-format", "text", "--model", params.model, ...sessionArgs],
      joinPrompt(params),
    ),
  "claude",
  versionProbe,
);
yield { delta: out };
if (params.sessionIdHint) yield { sessionId: params.sessionIdHint };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS(全文件,含既有用例)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/ai.ts packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): AnthropicLike 会话事件 + claudeCli --session-id 注入"
```

---

### Task 2: agy json 信封捕获 conversation_id

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts`(agyClientFactory + 新导出 `parseAgyJsonEnvelope`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `parseAgyJsonEnvelope(stdout: string): { conversationId: string | null; status: string | null; response: string } | null`(解析失败返回 null);agy stream 在 `params.captureSession` 时 args 含 `--output-format json`,成功则 yield `{delta: response}` + `{sessionId: conversationId}`(id 缺失时不 yield 第二个)。
- Consumes: Task 1 的参数/事件类型;既有 `stripAgyHeader`、`agyCliModelName`、spill 机制。

- [ ] **Step 1: Write the failing test**

```ts
describe("agy 会话捕获", () => {
  const ENVELOPE = JSON.stringify({
    conversation_id: "b013bd24-0cbc-46fb-a95f-67a267a90c4b",
    status: "SUCCESS",
    response: "教练回答",
  });

  it("captureSession:args 含 --output-format json,信封拆出回答与会话 id", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return ENVELOPE;
    };
    const client = agyClientFactory({ cmd: "/bin/agy", run });
    const events: Array<{ delta?: string; sessionId?: string }> = [];
    for await (const ev of client.stream({
      model: "gemini-3-pro",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      captureSession: true,
    })) {
      events.push(ev);
    }
    expect(calls[0]).toContain("--output-format");
    expect(calls[0]).toContain("json");
    expect(events).toEqual([
      { delta: "教练回答" },
      { sessionId: "b013bd24-0cbc-46fb-a95f-67a267a90c4b" },
    ]);
  });

  it("captureSession:status 非 SUCCESS 抛错(带 status 便于归因)", async () => {
    const run: Runner = async () =>
      JSON.stringify({ conversation_id: "x", status: "ERROR", response: "" });
    const client = agyClientFactory({ cmd: "/bin/agy", run });
    await expect(async () => {
      for await (const _ of client.stream({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
        captureSession: true,
      })) {
        /* drain */
      }
    }).rejects.toThrow(/ERROR/);
  });

  it("captureSession:信封解析失败回退当纯文本,无 sessionId 事件(分析不因此失败)", async () => {
    const run: Runner = async () => "不是 json 的输出";
    const client = agyClientFactory({ cmd: "/bin/agy", run });
    const events: Array<{ delta?: string; sessionId?: string }> = [];
    for await (const ev of client.stream({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      captureSession: true,
    })) {
      events.push(ev);
    }
    expect(events).toEqual([{ delta: "不是 json 的输出" }]);
  });

  it("不传 captureSession:args 不含 --output-format(旧行为字节不变)", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "raw";
    };
    const client = agyClientFactory({ cmd: "/bin/agy", run });
    for await (const _ of client.stream({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }
    expect(calls[0]).not.toContain("--output-format");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL(args 缺 --output-format / 事件形状不符)

- [ ] **Step 3: Write minimal implementation**

localAiBackends.ts 新增导出(放 stripAgyHeader 旁):

```ts
/** agy `--output-format json` 信封:{conversation_id, status, response, …}。
 * 整体 parse 失败(旧版本 agy / 输出被截)返回 null —— 调用方回退纯文本,
 * 分析主流程绝不因 session 捕获失败而失败(coach chat spec)。 */
export function parseAgyJsonEnvelope(stdout: string): {
  conversationId: string | null;
  status: string | null;
  response: string;
} | null {
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof obj.response !== "string") return null;
    return {
      conversationId:
        typeof obj.conversation_id === "string" ? obj.conversation_id : null,
      status: typeof obj.status === "string" ? obj.status : null,
      response: obj.response,
    };
  } catch {
    return null;
  }
}
```

agyClientFactory 直调分支(非 legacyScript)改:在拼 args 处按
`params.captureSession` 追加 `"--output-format", "json"`(紧跟 `--print printArg`
之后即可);拿到 `out` 后:

```ts
if (params.captureSession) {
  const env = parseAgyJsonEnvelope(out);
  if (env) {
    if (env.status && env.status !== "SUCCESS") {
      throw new Error(`agy 返回 status=${env.status}`);
    }
    yield { delta: env.response };
    if (env.conversationId) yield { sessionId: env.conversationId };
    return;
  }
  // 信封解析失败:回退旧行为(纯文本、无会话事件)
}
yield { delta: out };
```

注意:legacyScript(.mjs 包装)分支忽略 captureSession,行为不变。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): agy json 信封捕获 conversation_id(解析失败回退纯文本)"
```

---

### Task 3: codex --json 捕获 session id(去 --ephemeral)

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts`(codexClientFactory + 新导出 `parseCodexSessionId`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `parseCodexSessionId(stdoutJsonl: string): string | null`(扫 JSONL 里第一个 `"session_id"` 或 `"thread_id"` 的 UUID 值);codex stream 在 `captureSession` 时 args 含 `--json` 且**不含** `--ephemeral`,回答仍取 `-o` 文件,yield `{delta}` + `{sessionId}`(id 解析不出则只 yield delta)。
- Consumes: Task 1 参数/事件类型;既有 `-o` outFile 机制。

- [ ] **Step 1: Write the failing test**

```ts
describe("codex 会话捕获", () => {
  it("captureSession:args 含 --json 去 --ephemeral,JSONL 抓 session id,回答取 -o 文件", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      // 模拟 codex 写 -o 文件
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "最终回答", "utf-8");
      return [
        JSON.stringify({
          type: "session_configured",
          session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }),
        JSON.stringify({ type: "agent_message", text: "噪声" }),
      ].join("\n");
    };
    const client = codexClientFactory({ cmd: "/bin/codex", run });
    const events: Array<{ delta?: string; sessionId?: string }> = [];
    for await (const ev of client.stream({
      model: "gpt-x",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      captureSession: true,
    })) {
      events.push(ev);
    }
    expect(calls[0]).toContain("--json");
    expect(calls[0]).not.toContain("--ephemeral");
    expect(events).toEqual([
      { delta: "最终回答" },
      { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
  });

  it("captureSession:JSONL 无 id 时只出 delta(分析不因此失败)", async () => {
    const run: Runner = async (_f, args) => {
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "回答", "utf-8");
      return "非 json 行\n另一行";
    };
    const client = codexClientFactory({ cmd: "/bin/codex", run });
    const events: Array<{ delta?: string; sessionId?: string }> = [];
    for await (const ev of client.stream({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      captureSession: true,
    })) {
      events.push(ev);
    }
    expect(events).toEqual([{ delta: "回答" }]);
  });

  it("不传 captureSession:args 保留 --ephemeral 无 --json(旧行为)", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "x", "utf-8");
      return "";
    };
    const client = codexClientFactory({ cmd: "/bin/codex", run });
    for await (const _ of client.stream({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }
    expect(calls[0]).toContain("--ephemeral");
    expect(calls[0]).not.toContain("--json");
  });
});
```

(测试文件顶部若未 import `writeFileSync`,从 `node:fs` 补。)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```ts
/** codex `--json` JSONL 事件流里的会话 id:逐行 JSON.parse,取第一个
 * `session_id` 或 `thread_id` 形如 UUID 的值;整流解析不出返回 null。 */
export function parseCodexSessionId(stdoutJsonl: string): string | null {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const line of stdoutJsonl.split("\n")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["session_id", "thread_id"]) {
        const v = obj[key];
        if (typeof v === "string" && UUID_RE.test(v)) return v;
      }
    } catch {
      /* 非 json 行跳过 */
    }
  }
  return null;
}
```

codexClientFactory 的 args 组装改为:

```ts
const sessionArgs = params.captureSession ? ["--json"] : ["--ephemeral"];
// 原 args 数组里的 "--ephemeral" 换成 ...sessionArgs(位置保持在
// --skip-git-repo-check 之后、--color 之前)
```

拿到 stdout 后,在既有 `-o` 文件读取逻辑之后:

```ts
yield { delta };
if (params.captureSession) {
  const sid = parseCodexSessionId(stdout);
  if (sid) yield { sessionId: sid };
}
```

注意:captureSession 时 stdout 是 JSONL,**不再**作为 `-o` 文件缺失时的回答回退源
—— 保持回退仅在非 captureSession 路径(现状),captureSession 且文件读不出时让
delta 为空串(诚实:没有可用回答;上游 parseModelJsonArray 会按 bad-json 走)。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): codex --json 捕获 session id(捕获时去 --ephemeral)"
```

---

### Task 4: run() 把 sessionId 写进分析结果

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts`(AnalysisResult + run())
- Test: `packages/desktop/src/main/analysis.test.ts`

**Interfaces:**

- Produces: `AnalysisResult.sessionId?: string`(仅 CLI 后端且捕获成功且审计产出 findings 时写入;fallback 结果不带)。deepen 的 `writeMerged` 已 `{...slot.result, findings, deepened}` 展开,sessionId 自动保留 —— 不需要改 deepen。
- Consumes: Task 1-3 的 `sessionIdHint`/`captureSession`/`{sessionId}` 事件;`crypto.randomUUID`。

- [ ] **Step 1: Write the failing test**

在 `analysis.test.ts` 里仿既有 run 用例(用 `clientFactory` 桩)新增:

```ts
it("CLI 后端分析捕获 sessionId 进缓存;重试轮 claudeCli 换新 UUID", async () => {
  const hints: Array<string | undefined> = [];
  let attempt = 0;
  const service = createAnalysisService({
    getSettings: () => ({
      anthropicApiKey: null,
      wowDirectory: null,
      aiBackend: "claudeCli" as const,
      aiLanguage: "zh" as const,
    }),
    // 桩工厂钻过 resolveAiClient 不了:直接给 clientFactory 是 anthropic 专用。
    // 这里用 vi.mock 掉 resolveAiClient(见下方注),桩 stream:
    // attempt 1 返回坏 json(触发重试),attempt 2 返回合法 findings + sessionId 事件。
    matchesDir: tmpDir,
    emit: () => {},
  });
  // …调 service.run(input) 后:
  const cached = (await service.getCached("m1")) as { sessionId?: string };
  expect(cached?.sessionId).toBe(hints[1]); // 第二次(成功那轮)的 hint
  expect(hints[0]).not.toBe(hints[1]); // 重试换了 UUID
});
```

实现注:`resolveAiClient` 从 `./ai` import —— 测试里 `vi.mock("./ai", …)` 保留
`buildCoachSystemPrompt`/`PROMPT_VERSION` 真实现、只换 `resolveAiClient` 返回桩
client;桩 client 记录每次 `params.sessionIdHint` 进 `hints`,attempt 1 yield
`{delta: "not json"}`,attempt 2 yield `{delta: '[{"eventIds":["c1"],…合法 finding json}]'}`

- `{sessionId: params.sessionIdHint!}`。合法 finding 的形状抄本文件既有用例。

* [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/analysis.test.ts`
Expected: FAIL(cached.sessionId undefined)

- [ ] **Step 3: Write minimal implementation**

analysis.ts:

```ts
export type AnalysisResult = {
  // …现有字段…
  /** coach chat(2026-08-02 spec):CLI 后端分析调用捕获的会话 id,聊天
   * resume 用。API 后端/捕获失败/确定性回退结果无此字段。 */
  sessionId?: string;
};
```

run() 内(`callOnce` 改造):

```ts
const isCliBackend =
  backend === "claudeCli" || backend === "agy" || backend === "codex";
const callOnce = async (attempt: number) => {
  let raw = "";
  let capturedSession: string | undefined;
  // claudeCli 每 attempt 换新 UUID:同 id 二次播种会撞已存在的 session
  const sessionIdHint =
    backend === "claudeCli" ? crypto.randomUUID() : undefined;
  const stream = client.stream({
    model,
    max_tokens: 8192,
    system: buildCoachSystemPrompt(lang),
    messages: [{ role: "user", content: prompt }],
    ...(isCliBackend && backend !== "claudeCli" ? { captureSession: true } : {}),
    ...(sessionIdHint ? { sessionIdHint } : {}),
  });
  for await (const ev of stream) {
    if (!isCurrent(input.matchId, myGen)) return null;
    if (ev.sessionId) capturedSession = ev.sessionId;
    if (ev.delta) { /* …既有 delta 逻辑不变… */ }
  }
  // …既有 recordAiDebug/parse 不变…
  return { parsed: …, capturedSession };
};
```

成功分支的 finish 改为:

```ts
finish(
  {
    findings: audit.findings,
    dropped: audit.dropped.length,
    hadNarration: audit.findings.length > 0,
    ...(call.capturedSession ? { sessionId: call.capturedSession } : {}),
  },
  true,
);
```

文件顶部 `import { randomUUID } from "crypto";`(main 进程可用 Node 内置)。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/analysis.test.ts`
Expected: PASS(全文件)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/analysis.ts packages/desktop/src/main/analysis.test.ts
git commit -m "feat(desktop): 分析结果捕获 CLI 会话 id(claudeCli 重试换 UUID)"
```

---

### Task 5: continueCliChat + Runner 可中止

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts`(Runner opts + defaultRun + 新导出 `continueCliChat`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces:

```ts
export type CliChatBackend = "claudeCli" | "agy" | "codex";
export async function continueCliChat(input: {
  backend: CliChatBackend;
  cmd?: string; // 手填命令路径;缺省自动检测
  sessionId: string;
  question: string;
  model: string; // 线程记录的模型,与播种同源
  signal?: AbortSignal;
  run?: Runner; // 测试注入
}): Promise<string>; // 教练回答文本;失败 reject
```

- `Runner` 类型加第 4 参 `opts?: { signal?: AbortSignal }`;defaultRun 在 signal abort 时 SIGKILL 子进程并 reject `new Error("aborted")`。
- Consumes: `requireCli`/`resolveCliWithVersionProbe`、`agyCliModelName`、`stripAgyHeader`、spill 机制(`winPromptLimit`/`AGY_PROMPT_SPILL_DIR`/`ensureSpillDirSwept`)、`CODEX_OUT_SPILL_DIR`。

- [ ] **Step 1: Write the failing test**

```ts
describe("continueCliChat", () => {
  it("claudeCli:--resume <id>,问题走 stdin", async () => {
    const calls: Array<{ args: string[]; stdin: string }> = [];
    const run: Runner = async (_f, args, stdin) => {
      calls.push({ args, stdin });
      return "续聊回答";
    };
    const out = await continueCliChat({
      backend: "claudeCli",
      cmd: "/bin/claude",
      sessionId: "sid-1",
      question: "为什么该开减伤?",
      model: "claude-sonnet-5",
      run,
    });
    expect(out).toBe("续聊回答");
    expect(calls[0]!.args).toEqual([
      "-p",
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-5",
      "--resume",
      "sid-1",
    ]);
    expect(calls[0]!.stdin).toBe("为什么该开减伤?");
  });

  it("agy:--conversation <id>,无 --new-project,问题在 argv,剥 [agy-run] 头", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "[agy-run] header\n回答";
    };
    const out = await continueCliChat({
      backend: "agy",
      cmd: "/bin/agy",
      sessionId: "conv-1",
      question: "问题",
      model: "flash",
      run,
    });
    expect(out).toBe("回答");
    expect(calls[0]).toContain("--conversation");
    expect(calls[0]).toContain("conv-1");
    expect(calls[0]).not.toContain("--new-project");
  });

  it("codex:exec resume <id>,问题走 stdin,回答取 -o 文件", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args, stdin) => {
      calls.push(args);
      expect(stdin).toBe("问题");
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "codex 回答", "utf-8");
      return "";
    };
    const out = await continueCliChat({
      backend: "codex",
      cmd: "/bin/codex",
      sessionId: "sid-c",
      question: "问题",
      model: "gpt-x",
      run,
    });
    expect(out).toBe("codex 回答");
    expect(calls[0]!.slice(0, 3)).toEqual(["exec", "resume", "sid-c"]);
    expect(calls[0]).not.toContain("--ephemeral");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL(continueCliChat 未导出)

- [ ] **Step 3: Write minimal implementation**

Runner 与 defaultRun:

```ts
export type Runner = (
  file: string,
  args: string[],
  stdin: string,
  opts?: { signal?: AbortSignal },
) => Promise<string>;
```

defaultRun 里 spawn 之后:

```ts
const onAbort = () => {
  clearTimeout(timer);
  child.kill("SIGKILL");
  activeChildren.delete(child);
  reject(new Error("aborted"));
};
if (opts?.signal) {
  if (opts.signal.aborted) return onAbort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
}
```

(close/error 回调里 `opts?.signal?.removeEventListener("abort", onAbort)`。)

continueCliChat:

```ts
export async function continueCliChat(input: {
  backend: CliChatBackend;
  cmd?: string;
  sessionId: string;
  question: string;
  model: string;
  signal?: AbortSignal;
  run?: Runner;
}): Promise<string> {
  const run = input.run ?? defaultRun;
  const opts = { signal: input.signal };
  if (input.backend === "claudeCli") {
    const { cmd, versionProbe } = await resolveCliWithVersionProbe(
      "claude",
      input.cmd,
    );
    return withVersionHint(
      () =>
        run(
          cmd,
          [
            "-p",
            "--output-format",
            "text",
            "--model",
            input.model,
            "--resume",
            input.sessionId,
          ],
          input.question,
          opts,
        ),
      "claude",
      versionProbe,
    );
  }
  if (input.backend === "agy") {
    const { cmd, versionProbe } = await resolveCliWithVersionProbe(
      "agy",
      input.cmd,
    );
    // 问题也可能超 win argv 上限:复用 spill(与播种同一套守卫)
    const platform = process.platform;
    const limit = winPromptLimit(platform, cmd);
    let promptFile: string | null = null;
    let printArg = input.question;
    const extraArgs: string[] = [];
    if (limit !== null && input.question.length > limit) {
      ensureSpillDirSwept(AGY_PROMPT_SPILL_DIR);
      promptFile = join(
        AGY_PROMPT_SPILL_DIR,
        `gladlog-agy-chat-${process.pid}-${++agyTmpSeq}.txt`,
      );
      writeFileSync(promptFile, input.question, {
        encoding: "utf-8",
        mode: 0o600,
      });
      printArg = `Read the file at ${promptFile} in full and treat its entire contents as your prompt. Follow it directly; do not mention the file or describe it.`;
      extraArgs.push("--add-dir", AGY_PROMPT_SPILL_DIR);
    }
    try {
      const out = await withVersionHint(
        () =>
          run(
            cmd,
            [
              "--print",
              printArg,
              "--model",
              agyCliModelName(input.model),
              "--print-timeout",
              "110s",
              "--conversation",
              input.sessionId,
              "--sandbox",
              ...extraArgs,
            ],
            "",
            opts,
          ),
        "agy",
        versionProbe,
      );
      return stripAgyHeader(out);
    } finally {
      if (promptFile) {
        try {
          unlinkSync(promptFile);
        } catch {
          /* best-effort */
        }
      }
    }
  }
  // codex
  const { cmd, versionProbe } = await resolveCliWithVersionProbe(
    "codex",
    input.cmd,
  );
  ensureSpillDirSwept(CODEX_OUT_SPILL_DIR);
  const outFile = join(
    CODEX_OUT_SPILL_DIR,
    `gladlog-codex-chat-${process.pid}-${++codexTmpSeq}.txt`,
  );
  try {
    const stdout = await withVersionHint(
      () =>
        run(
          cmd,
          [
            "exec",
            "resume",
            input.sessionId,
            "-",
            "-m",
            input.model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--color",
            "never",
            "-o",
            outFile,
          ],
          input.question,
          opts,
        ),
      "codex",
      versionProbe,
    );
    try {
      return readFileSync(outFile, "utf-8");
    } catch {
      return stdout; // 旧版本 codex 不认 -o:回退 stdout
    }
  } finally {
    try {
      unlinkSync(outFile);
    } catch {
      /* best-effort */
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): continueCliChat 三 CLI 续聊 + Runner AbortSignal 中止"
```

---

### Task 6: coachChat 服务(main)

**Files:**

- Create: `packages/desktop/src/main/coachChat.ts`
- Test: `packages/desktop/src/main/coachChat.test.ts`

**Interfaces:**

- Produces:

```ts
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: number;
};
export type ChatState =
  | { status: "unsupported" } // 当前后端非 CLI
  | { status: "not-ready" } // 该 CLI 无带 sessionId 的本回合分析,也无既有线程
  | {
      status: "ready";
      backend: string;
      model: string;
      messages: ChatMessage[];
      busy: boolean;
    };
export type ChatSendResult =
  | { status: "ok"; reply: string }
  | { status: "need-reseed" } // resume 失败且本次未带 seed:renderer 构建 seed 后重调
  | { status: "busy" | "unsupported" | "not-ready" }
  | { status: "error"; message: string };
export type ChatSeed = {
  richContext: string;
  spec: string;
  ownerName?: string;
  findingsSummary: string;
};
export function createCoachChatService(deps: {
  getSettings: () => {
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiModels?: AiModelSelection | null;
    aiLanguage?: AiLanguage;
  };
  matchesDir: string;
  /** 测试注入;生产走 localAiBackends 实函数。 */
  chatRunner?: typeof continueCliChat;
  seedClient?: (backend: CliChatBackend, cmd?: string) => AnthropicLike;
}): {
  getState(matchId: string): Promise<ChatState>;
  send(input: {
    matchId: string;
    question: string;
    seed?: ChatSeed;
  }): Promise<ChatSendResult>;
  cancel(matchId: string): Promise<void>;
};
```

- 落盘 `<matchesDir>/<matchId>/coachChat.<lang>.json`:`{ version: 1, threads: { [backend]: { sessionId, model, messages } } }`,tmp+rename 原子写。
- Consumes: Task 4 的 `AnalysisResult.sessionId`(经 `analysisCachePath` + `toSlottedDoc` + `splitSlotKey` 扫槽:同 backend 前缀、`promptVersion === PROMPT_VERSION`、`result.sessionId` 存在,取 createdAt 最新);Task 5 `continueCliChat`;Task 1-3 的 captureSession 播种(自愈);`buildCoachSystemPrompt`。

- [ ] **Step 1: Write the failing tests**

`coachChat.test.ts`(桩 chatRunner/seedClient,tmp 目录当 matchesDir;
分析缓存文件直接手写 v2 形状播种):

```ts
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCoachChatService } from "./coachChat";
import { PROMPT_VERSION } from "../shared/promptVersion";

function seedAnalysisCache(
  dir: string,
  matchId: string,
  opts?: { sessionId?: string },
) {
  mkdirSync(join(dir, matchId), { recursive: true });
  writeFileSync(
    join(dir, matchId, "analysis-v2.zh.json"),
    JSON.stringify({
      schemaVersion: 2,
      language: "zh",
      lastSlotKey: "claudeCli:claude-sonnet-5",
      slots: {
        "claudeCli:claude-sonnet-5": {
          promptVersion: PROMPT_VERSION,
          createdAt: 1,
          result: {
            findings: [],
            dropped: 0,
            hadNarration: true,
            ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
          },
        },
      },
    }),
  );
}

const settings = () => ({
  aiBackend: "claudeCli" as const,
  aiBackendCommand: null,
  aiLanguage: "zh" as const,
});

it("门槛:API 后端 unsupported;无分析 session not-ready;有则 ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  const svc = createCoachChatService({
    getSettings: () => ({ ...settings(), aiBackend: "anthropic" as const }),
    matchesDir: dir,
  });
  expect((await svc.getState("m1")).status).toBe("unsupported");

  const svc2 = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  expect((await svc2.getState("m1")).status).toBe("not-ready");
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const st = await svc2.getState("m1");
  expect(st.status).toBe("ready");
  expect((st as { model: string }).model).toBe("claude-sonnet-5");
});

it("旧缓存无 sessionId → not-ready(重新分析才解锁)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1"); // 无 sessionId
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  expect((await svc.getState("m1")).status).toBe("not-ready");
});

it("send:resume 成功,消息追加并落盘;重开服务能读回(续聊)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async () => "教练回答");
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  const r = await svc.send({ matchId: "m1", question: "问" });
  expect(r).toEqual({ status: "ok", reply: "教练回答" });
  expect(chatRunner.mock.calls[0]![0]).toMatchObject({
    backend: "claudeCli",
    sessionId: "sid-a",
    question: "问",
    model: "claude-sonnet-5",
  });
  // 落盘 + 新实例读回
  const svc2 = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  const st = (await svc2.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});

it("send:resume 失败且无 seed → need-reseed;带 seed → 播种新 session 后重问", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-dead" });
  const chatRunner = vi
    .fn()
    .mockRejectedValueOnce(new Error("session not found"))
    .mockResolvedValue("自愈后的回答");
  // seedClient 桩:captureSession 播种,yield 回答 + 新 sessionId
  const seedClient = () => ({
    async *stream(params: { sessionIdHint?: string }) {
      yield { delta: "播种回答(含新问题的答案)" };
      yield { sessionId: params.sessionIdHint ?? "new-sid" };
    },
  });
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
    seedClient: seedClient as never,
  });
  const r1 = await svc.send({ matchId: "m1", question: "问" });
  expect(r1).toEqual({ status: "need-reseed" });
  const r2 = await svc.send({
    matchId: "m1",
    question: "问",
    seed: { richContext: "CTX", spec: "Holy Paladin", findingsSummary: "F1" },
  });
  expect(r2.status).toBe("ok");
  // 线程 sessionId 已更新为新 id(自愈)
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2); // user + assistant(need-reseed 那次不落盘)
});

it("并发守卫:同场在飞时再 send 得 busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  let release!: () => void;
  const gate = new Promise<string>((r) => (release = () => r("慢回答")));
  const chatRunner = vi.fn(() => gate);
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  const p1 = svc.send({ matchId: "m1", question: "a" });
  const r2 = await svc.send({ matchId: "m1", question: "b" });
  expect(r2.status).toBe("busy");
  release();
  await p1;
});

it("每 CLI 各一条线程:切后端显示各自历史", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async () => "答");
  let backend: "claudeCli" | "agy" = "claudeCli";
  const svc = createCoachChatService({
    getSettings: () => ({ ...settings(), aiBackend: backend }),
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  await svc.send({ matchId: "m1", question: "问" });
  backend = "agy"; // agy 无分析 session → not-ready(线程也没有)
  expect((await svc.getState("m1")).status).toBe("not-ready");
  backend = "claudeCli";
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && npx vitest run src/main/coachChat.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation**

`coachChat.ts` 要点(结构照 analysis.ts 服务闭包;完整逻辑):

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  analysisCachePath,
  resolveActiveSlot,
  splitSlotKey,
  toSlottedDoc,
} from "../shared/analysisCache";
import { PROMPT_VERSION } from "../shared/promptVersion";
import {
  resolveAiModel,
  type AiBackend,
  type AiModelSelection,
} from "../shared/aiModels";
import {
  buildCoachSystemPrompt,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";
import {
  agyClientFactory,
  claudeCliClientFactory,
  codexClientFactory,
  continueCliChat,
  type CliChatBackend,
} from "./localAiBackends";
import type { AnalysisResult } from "./analysis";

const CLI_BACKENDS: readonly string[] = ["claudeCli", "agy", "codex"];
/** 重发型种子/历史拼接的消息上限(spec:更早的截断并注明)。 */
const SEED_HISTORY_MAX = 30;

const chatPath = (matchesDir: string, matchId: string, lang: string) =>
  join(matchesDir, matchId, `coachChat.${lang}.json`);

type ChatThread = { sessionId: string; model: string; messages: ChatMessage[] };
type ChatDoc = { version: 1; threads: Record<string, ChatThread> };

function readDoc(p: string): ChatDoc {
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (raw?.version === 1 && raw.threads) return raw as ChatDoc;
  } catch {
    /* 首次 */
  }
  return { version: 1, threads: {} };
}

function writeDoc(
  matchesDir: string,
  matchId: string,
  p: string,
  doc: ChatDoc,
) {
  mkdirSync(join(matchesDir, matchId), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc), "utf-8");
  renameSync(tmp, p);
}

/** 该 CLI 后端最新一个带 sessionId 且版本现行的分析槽。 */
function findAnalysisSession(
  matchesDir: string,
  matchId: string,
  lang: AiLanguage,
  backend: string,
): { sessionId: string; model: string } | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(
      readFileSync(analysisCachePath(matchesDir, matchId, lang), "utf-8"),
    );
  } catch {
    return null;
  }
  const doc = toSlottedDoc<AnalysisResult>(raw, "legacy:unknown");
  if (!doc) return null;
  let best: { sessionId: string; model: string; createdAt: number } | null =
    null;
  for (const [key, slot] of Object.entries(doc.slots)) {
    const split = splitSlotKey(key);
    if (!split || split.backend !== backend) continue;
    if (slot.promptVersion !== PROMPT_VERSION) continue;
    const sid = slot.result?.sessionId;
    if (!sid) continue;
    if (!best || slot.createdAt > best.createdAt)
      best = { sessionId: sid, model: split.model, createdAt: slot.createdAt };
  }
  return best ? { sessionId: best.sessionId, model: best.model } : null;
}
```

`createCoachChatService`:

```ts
export function createCoachChatService(deps: {/* 见 Interfaces */}) {
  const inFlight = new Map<string, AbortController>();
  const factories: Record<
    CliChatBackend,
    (o: { cmd?: string }) => AnthropicLike
  > = {
    claudeCli: claudeCliClientFactory,
    agy: agyClientFactory,
    codex: codexClientFactory,
  };
  const seedClient =
    deps.seedClient ??
    ((backend: CliChatBackend, cmd?: string) => factories[backend]({ cmd }));
  const chatRunner = deps.chatRunner ?? continueCliChat;

  const ctx = () => {
    const s = deps.getSettings();
    const backend = (s.aiBackend ?? "anthropic") as string;
    return {
      s,
      backend,
      lang: (s.aiLanguage ?? "zh") as AiLanguage,
      cmd: s.aiBackendCommand || undefined,
      isCli: CLI_BACKENDS.includes(backend),
    };
  };

  return {
    async getState(matchId: string): Promise<ChatState> {
      const { backend, lang, isCli } = ctx();
      if (!isCli) return { status: "unsupported" };
      const doc = readDoc(chatPath(deps.matchesDir, matchId, lang));
      const thread = doc.threads[backend];
      if (thread)
        return {
          status: "ready",
          backend,
          model: thread.model,
          messages: thread.messages,
          busy: inFlight.has(matchId),
        };
      const sess = findAnalysisSession(deps.matchesDir, matchId, lang, backend);
      if (!sess) return { status: "not-ready" };
      return {
        status: "ready",
        backend,
        model: sess.model,
        messages: [],
        busy: inFlight.has(matchId),
      };
    },

    async send(input): Promise<ChatSendResult> {
      const { backend, lang, cmd, isCli } = ctx();
      if (!isCli) return { status: "unsupported" };
      if (inFlight.has(input.matchId)) return { status: "busy" };
      const path = chatPath(deps.matchesDir, input.matchId, lang);
      const doc = readDoc(path);
      let thread = doc.threads[backend];
      if (!thread) {
        const sess = findAnalysisSession(
          deps.matchesDir,
          input.matchId,
          lang,
          backend,
        );
        if (!sess && !input.seed) return { status: "not-ready" };
        thread = {
          sessionId: sess?.sessionId ?? "",
          model:
            sess?.model ??
            resolveAiModel({
              aiBackend: backend as AiBackend,
              aiModels: deps.getSettings().aiModels,
            }),
          messages: [],
        };
      }
      const ac = new AbortController();
      inFlight.set(input.matchId, ac);
      try {
        let reply: string;
        if (input.seed) {
          // 自愈/无 session 播种:新 session,种子含上下文+结论+历史+新问
          const seeded = await seedNewSession({
            backend: backend as CliChatBackend,
            cmd,
            lang,
            model: thread.model,
            seed: input.seed,
            history: thread.messages,
            question: input.question,
            signal: ac.signal,
          });
          thread.sessionId = seeded.sessionId;
          reply = seeded.reply;
        } else {
          try {
            reply = await chatRunner({
              backend: backend as CliChatBackend,
              cmd,
              sessionId: thread.sessionId,
              question: input.question,
              model: thread.model,
              signal: ac.signal,
            });
          } catch (err) {
            if (ac.signal.aborted)
              return { status: "error", message: "已停止" };
            return { status: "need-reseed" }; // renderer 构建 seed 后重调
          }
        }
        if (ac.signal.aborted) return { status: "error", message: "已停止" };
        const now = Date.now();
        thread.messages = [
          ...thread.messages,
          { role: "user", content: input.question, at: now },
          { role: "assistant", content: reply, at: now },
        ];
        doc.threads[backend] = thread;
        writeDoc(deps.matchesDir, input.matchId, path, doc);
        return { status: "ok", reply };
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        inFlight.delete(input.matchId);
      }
    },

    async cancel(matchId: string): Promise<void> {
      inFlight.get(matchId)?.abort();
    },
  };

  async function seedNewSession(p: {
    backend: CliChatBackend;
    cmd?: string;
    lang: AiLanguage;
    model: string;
    seed: ChatSeed;
    history: ChatMessage[];
    question: string;
    signal: AbortSignal;
  }): Promise<{ sessionId: string; reply: string }> {
    const hist = p.history.slice(-SEED_HISTORY_MAX);
    const histText = hist
      .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${m.content}`)
      .join("\n");
    const prompt = [
      `You previously analyzed this ${p.seed.spec} match and produced these findings:`,
      p.seed.findingsSummary,
      ``,
      `Full match context:`,
      p.seed.richContext,
      ``,
      ...(histText
        ? [
            p.history.length > SEED_HISTORY_MAX
              ? `Earlier conversation (older turns omitted):`
              : `Earlier conversation:`,
            histText,
            ``,
          ]
        : []),
      `The user now asks: ${p.question}`,
    ].join("\n");
    const client = seedClient(p.backend, p.cmd);
    const hint = p.backend === "claudeCli" ? randomUUID() : undefined;
    let reply = "";
    let sessionId: string | undefined;
    for await (const ev of client.stream({
      model: p.model,
      max_tokens: 4096,
      system: buildCoachSystemPrompt(p.lang),
      messages: [{ role: "user", content: prompt }],
      ...(hint ? { sessionIdHint: hint } : { captureSession: true }),
    })) {
      if (ev.delta) reply += ev.delta;
      if (ev.sessionId) sessionId = ev.sessionId;
    }
    if (!sessionId) throw new Error("播种未捕获到会话 id");
    return { sessionId, reply };
  }
}
```

注:`AnalysisResult` 从 `./analysis` type-only import,不构成循环(analysis.ts 不 import coachChat)。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/desktop && npx vitest run src/main/coachChat.test.ts`
Expected: PASS(7 用例)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/coachChat.ts packages/desktop/src/main/coachChat.test.ts
git commit -m "feat(desktop): coachChat 服务 —— 每 CLI 线程/门槛/续聊/两段自愈/并发守卫"
```

---

### Task 7: IPC + preload 接线

**Files:**

- Modify: `packages/desktop/src/main/ipc.ts`(registerIpc deps + 三个 handler)
- Modify: `packages/desktop/src/main/index.ts`(创建服务并传入 registerIpc;照 analysis 服务的既有创建点)
- Modify: `packages/desktop/src/preload/api.ts`(类型)与 `packages/desktop/src/preload/index.ts`(invoke 实现;照 analysis 块)

**Interfaces:**

- Produces(renderer 侧 bridge 面,`bridge().chat`):

```ts
chat: {
  getState(matchId: string): Promise<ChatState>;   // 形状见 Task 6
  send(input: { matchId: string; question: string; seed?: {
    richContext: string; spec: string; ownerName?: string;
    findingsSummary: string } }): Promise<ChatSendResult>;
  cancel(matchId: string): Promise<void>;
};
```

- IPC 频道:`gladlog:chat:getState` / `gladlog:chat:send` / `gladlog:chat:cancel`。
- Consumes: Task 6 `createCoachChatService`。

- [ ] **Step 1: 接线(纯管道,无独立单测 —— pipeline.test.ts 若有 IPC 清单测试则更新)**

ipc.ts:deps 加 `chat: CoachChatService`(type-only import),register 里:

```ts
ipcMain.handle("gladlog:chat:getState", (_e, matchId: string) =>
  deps.chat.getState(String(matchId)),
);
ipcMain.handle("gladlog:chat:send", (_e, input) => deps.chat.send(input));
ipcMain.handle("gladlog:chat:cancel", (_e, matchId: string) =>
  deps.chat.cancel(String(matchId)),
);
```

index.ts:在 createAnalysisService 创建点旁:

```ts
const coachChat = createCoachChatService({
  getSettings: () => settings.get(),
  matchesDir,
});
```

并传入 `registerIpc({ …, chat: coachChat })`。preload 两处照 analysis 块加
chat 面(api.ts 类型 + index.ts `invoke("gladlog:chat:…")` 转发)。

- [ ] **Step 2: 验证**

Run: `cd packages/desktop && npx vitest run test/pipeline.test.ts && npm run typecheck`
Expected: PASS / 零错(若 pipeline.test 有 preload 面清单断言,按报错补 chat 面)

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): coachChat IPC/preload 接线"
```

---

### Task 8: CoachChatCard(renderer)+ 挂载 AI 视图

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/CoachChatCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(`view === "ai"` 的 `rpt-ai-main` 列,StructuredAnalysisPanel 之后)
- Modify: `packages/desktop/src/renderer/src/styles.css`(`.coach-chat-*` 样式)
- Test: `packages/desktop/test/coachChatCard.test.tsx`

**Interfaces:**

- Consumes: `bridge().chat`(Task 7 面,访问必须 optional + try/catch:桩经常缺面);`buildAnalysisInput`(`../derive/analysisInput`,need-reseed 时构建 seed);`ensureAnalysisData`;`bridge().analysis.getCached`(取 findings 摘要);props `{ source: ReportSource; matchId: string }`。
- Produces: `<CoachChatCard source={source} matchId={resolvedMatchId} />`。

- [ ] **Step 1: Write the failing tests**

`test/coachChatCard.test.tsx`(jsdom,`__gladlogFixture` 桩,照
StructuredAnalysisPanel.test 惯例):

```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CoachChatCard } from "../src/renderer/src/report/components/CoachChatCard";

const src = { units: {} } as never;

function stubChat(state: unknown, send?: (input: unknown) => Promise<unknown>) {
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => state,
      send: send ?? (async () => ({ status: "ok", reply: "答" })),
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
}

it("unsupported:显示 CLI 引导文案,无输入框", async () => {
  stubChat({ status: "unsupported" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/需要本地 CLI 后端/);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("not-ready:显示「开始 AI 分析后才能对话」", async () => {
  stubChat({ status: "not-ready" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/开始 AI 分析后才能对话/);
});

it("ready:发消息 → 显示用户消息与教练回复", async () => {
  stubChat({
    status: "ready",
    backend: "claudeCli",
    model: "sonnet",
    messages: [],
    busy: false,
  });
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("答");
  expect(screen.getByText("为什么?")).toBeTruthy();
});

it("发送失败(error):该条标失败并给重试按钮", async () => {
  stubChat(
    {
      status: "ready",
      backend: "claudeCli",
      model: "sonnet",
      messages: [],
      busy: false,
    },
    async () => ({ status: "error", message: "boom" }),
  );
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "问" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText(/发送失败/);
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && npx vitest run test/coachChatCard.test.tsx`
Expected: FAIL(组件不存在)

- [ ] **Step 3: Write implementation**

CoachChatCard 要点:

- 状态:`chatState`(getState 结果)、`pending`(在飞的问题文本)、
  `failed`(失败待重试的问题文本)、`draft`(输入框)。
- mount/matchId 变化时 `void refresh()`(getState → setChatState;bridge 面缺失
  try/catch → 卡片渲染 null,与桩纪律一致)。另订阅
  `bridge().analysis?.onDone?.(…)`(可选面,有就刷新 —— 分析跑完即解锁)。
- 发送流程:

```tsx
async function doSend(question: string) {
  setPending(question);
  setFailed(null);
  try {
    let r = await bridge().chat.send({ matchId, question });
    if (r.status === "need-reseed") {
      await ensureAnalysisData();
      const input = buildAnalysisInput(source, matchId);
      const cached = (await bridge().analysis.getCached(matchId)) as {
        findings?: Array<{ title: string; explanation?: string }>;
      } | null;
      const findingsSummary =
        (cached?.findings ?? [])
          .map((f, i) => `${i + 1}. ${f.title} — ${f.explanation ?? ""}`)
          .join("\n") || "(none)";
      if (!input) {
        setFailed(question);
        setPending(null);
        return;
      }
      r = await bridge().chat.send({
        matchId,
        question,
        seed: {
          richContext: input.richContext,
          spec: input.spec,
          ownerName: input.ownerName,
          findingsSummary,
        },
      });
    }
    if (r.status === "ok") {
      setDraft("");
      await refresh();
    } else setFailed(question);
  } catch {
    setFailed(question);
  }
  setPending(null);
}
```

- 渲染四态:unsupported 引导 / not-ready 提示「开始 AI 分析后才能对话」/
  ready 消息列表(`messages` + pending 的「教练思考中…」+ failed 的
  「发送失败 · 重试」按钮)+ 输入框(textarea role=textbox)+ 「发送」按钮
  (pending 时换「停止」→ `bridge().chat.cancel(matchId)`)。
- 卡底部固定小字:「回答基于日志推理,可能有误」。
- 顶部小字:`{backend} · {model}`。
- MatchReport 挂载(`UncoveredHighlightsCard` 之后):

```tsx
<CoachChatCard source={source} matchId={resolvedMatchId} />
```

- styles.css:`.coach-chat-card`(卡片同 `.rpt-ai-main` 内其它卡)、
  `.coach-chat-msgs`(max-height: 320px; overflow-y: auto)、
  `.coach-chat-msg--user` 右对齐 / `--coach` 左对齐、输入行 flex。
  滚动容器加 `tabIndex={0}`(axe scrollable-region-focusable,前科)。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/desktop && npx vitest run test/coachChatCard.test.tsx`
Expected: PASS(4 用例)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/CoachChatCard.tsx packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/src/renderer/src/styles.css packages/desktop/test/coachChatCard.test.tsx
git commit -m "feat(desktop): 问教练聊天卡 —— 四态状态机挂进 AI 视图"
```

---

### Task 9: 全门禁 + 真机 smoke + 视觉基线

**Files:**

- 无新文件(可能更新 `packages/desktop/qa/__screenshots__/**` 基线)

- [ ] **Step 1: presubmit**

Run: `npm run presubmit`(repo 根)
Expected: EXIT=0。红了修到绿再往下。

- [ ] **Step 2: 真机 smoke(spec 收官前提,不可跳过)**

写临时脚本 `packages/desktop/scripts/tmp-chat-smoke.mts`(用完即删):
取本地库一个近期回合 → `buildAnalysisInput` → 直接调
`createAnalysisService`(claudeCli 后端)跑一次真分析 → 断言缓存
`sessionId` 存在 → `createCoachChatService.send` 问一句
「用一句话总结这局我最该改进什么」→ 断言回复非空且续聊(再问一句引用前答,
如「刚才那点展开讲讲」,回复应衔接)。agy 后端重复一遍(验证 json 信封
真机解析)。人工核对两次回答确实衔接(记进 commit message)。

- [ ] **Step 3: 视觉基线(仅当 AI 视图截图在 CI 基线集内且变化)**

按 desktop-dev 配方:`gh workflow run visual-baseline.yml --ref main` →
下载 → `cmp` 找 DIFF → 逐张人审(变化必须能用聊天卡解释)→ 覆盖 commit。

- [ ] **Step 4: Commit + push + CI**

```bash
rm -f packages/desktop/scripts/tmp-chat-smoke.mts
git add -A && git commit -m "test(desktop): 问教练真机 smoke 通过(claudeCli+agy 续聊衔接)" && git push
RUN=$(gh run list --workflow test.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RUN --exit-status
```

---

## Self-Review 记录

- Spec 覆盖:CLI-only 门槛(T6/T8)、同 agent 已分析前置(T6 findAnalysisSession + T8 not-ready 态)、三 CLI 捕获(T1-3)与续聊(T5)、分析不因捕获失败而失败(T2/T3 回退用例)、两段自愈(T6)、每 CLI 线程/切换(T6 用例)、停止/超时(T5 AbortSignal + T8 停止按钮)、免责小字(T8)、真机 smoke(T9)。deepen 保持不进 session:T4 注明 writeMerged 展开保留 sessionId,无需改动。
- 类型一致性:`ChatSendResult`/`ChatState`/`ChatSeed`/`continueCliChat` 签名在 T5/T6/T7/T8 间一致;`AnalysisResult.sessionId` T4 定义、T6 消费。
- 占位符:无 TBD;T7 是纯管道接线,以 typecheck+pipeline 测试为验收。
