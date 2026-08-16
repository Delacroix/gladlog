# Ask Coach (In-game AI Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Ask Coach" chat card to the battle report AI view — resume the session of that CLI call for "AI Analysis" to conduct multi-turn follow-up questions; only local CLI backends (claudeCli/agy/codex) are supported, and it must be the same CLI that completed the current round of analysis.

**Architecture:** The analysis pipeline captures/assigns a session id for the three CLIs and saves it in the analysis result (`AnalysisResult.sessionId`); the main side adds a coachChat service to manage one persistence thread per CLI (`coachChat.<lang>.json`), continuing the chat uses each CLI's native resume, and failures self-heal by reseeding; the renderer chat card has a four-state machine. Spec: `docs/superpowers/specs/2026-08-02-coach-chat-design.md`.

**Tech Stack:** Electron main/renderer + IPC (existing analysis.ts pattern), localAiBackends Runner abstraction, vitest.

## Global Constraints

- Adhere to all conventions in `.claude/skills/desktop-dev`: renderer must not import values from `src/main/*` (type-only is allowed); cross-process shared pure logic goes into `src/shared/`; bridge surface access must tolerate stub gaps.
- Session interfaces for the three CLIs (empirically tested locally on 2026-08-02, per spec table): claudeCli `--session-id <uuid>` / `claude -p --resume <id>`; agy `--output-format json` envelope containing `conversation_id` / `--conversation <id>`; codex `--json` event stream containing session id / `codex exec resume <id>`, and when capturing session, codex **must omit `--ephemeral`** (this flag explicitly prevents persisting session to disk).
- Main analysis flow **must never fail due to session capture failure**: if envelope/JSONL cannot parse an id, sessionId is simply omitted, chat gatekeeper blocks chat naturally, and analysis succeeds as normal.
- Chat responses are freeform text, bypassing findings audit; UI fixed fine print "Responses are based on combat log reasoning and may contain errors".
- API backends (anthropic/deepseek) do not support chat; no code path may expose a chat entry point for them.
- Test execution: `npx vitest run <file>` inside workspace (running from repo root misses globals); `npm run presubmit` before push.
- Commits: direct commit to main (user convention), one commit per Task.

---

### Task 1: AnthropicLike Session Events + claudeCli `--session-id`

**Files:**

- Modify: `packages/desktop/src/main/ai.ts` (AnthropicLike interface)
- Modify: `packages/desktop/src/main/localAiBackends.ts` (claudeCliClientFactory)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `AnthropicLike.stream` params add `sessionIdHint?: string` (claudeCli specific) and `captureSession?: boolean` (for agy/codex, type only defined in this task); event types expanded from `{delta?: string}` to `{delta?: string; sessionId?: string}`. When `sessionIdHint` is passed to claudeCli: args appends `"--session-id", hint`, and yields `{sessionId: hint}` after delta.
- Consumes: Existing `claudeCliClientFactory(opts?: {cmd?, run?})`, `Runner` type.

- [ ] **Step 1: Write the failing test**

In `localAiBackends.test.ts` near existing claudeCli describe block, add:

```ts
it("claudeCli: appends --session-id and emits sessionId event when sessionIdHint is passed", async () => {
  const calls: string[][] = [];
  const run: Runner = async (_f, args) => {
    calls.push(args);
    return "Response text";
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
    { delta: "Response text" },
    { sessionId: "11111111-2222-3333-4444-555555555555" },
  ]);
});

it("claudeCli: args and events retain legacy shape when sessionIdHint is omitted", async () => {
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
Expected: FAIL (TS reports `sessionIdHint` not in param types, or runtime args lack `--session-id`)

- [ ] **Step 3: Write minimal implementation**

Change AnthropicLike in `ai.ts` to:

```ts
export interface AnthropicLike {
  stream(params: {
    model: string;
    max_tokens: number;
    /** Coach persona + output language instructions (backlog #1); local backends prepend to prompt. */
    system?: string;
    messages: { role: "user"; content: string }[];
    /** coach chat (2026-08-02 spec): claudeCli specific — generated as UUID by caller,
     * factory appends `--session-id <hint>` and yields {sessionId: hint} after text. */
    sessionIdHint?: string;
    /** coach chat: agy/codex specific — switches to capturable session id output format and
     * yields {sessionId}. Failure to capture does not throw, simply omits sessionId event. */
    captureSession?: boolean;
  }): AsyncIterable<{ delta?: string; sessionId?: string }>;
}
```

Inside `claudeCliClientFactory` stream:

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
Expected: PASS (full file, including existing tests)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/ai.ts packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): AnthropicLike session events + claudeCli --session-id injection"
```

---

### Task 2: agy JSON Envelope Captures conversation_id

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts` (agyClientFactory + new export `parseAgyJsonEnvelope`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `parseAgyJsonEnvelope(stdout: string): { conversationId: string | null; status: string | null; response: string } | null` (returns null on parse failure); agy stream includes `--output-format json` in args when `params.captureSession` is set, yielding `{delta: response}` + `{sessionId: conversationId}` on success (omits second yield if id missing).
- Consumes: Task 1 parameter/event types; existing `stripAgyHeader`, `agyCliModelName`, spill mechanism.

- [ ] **Step 1: Write the failing test**

```ts
describe("agy session capture", () => {
  const ENVELOPE = JSON.stringify({
    conversation_id: "b013bd24-0cbc-46fb-a95f-67a267a90c4b",
    status: "SUCCESS",
    response: "Coach reply",
  });

  it("captureSession: args contain --output-format json, envelope extracts response and session id", async () => {
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
      { delta: "Coach reply" },
      { sessionId: "b013bd24-0cbc-46fb-a95f-67a267a90c4b" },
    ]);
  });

  it("captureSession: throws error when status is not SUCCESS (with status for attribution)", async () => {
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

  it("captureSession: falls back to plain text on envelope parse failure with no sessionId event (analysis does not fail)", async () => {
    const run: Runner = async () => "non-json output";
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
    expect(events).toEqual([{ delta: "non-json output" }]);
  });

  it("omitting captureSession: args do not contain --output-format (legacy behavior byte-for-byte unchanged)", async () => {
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
Expected: FAIL (args missing --output-format / event shape mismatch)

- [ ] **Step 3: Write minimal implementation**

New export in `localAiBackends.ts` (beside stripAgyHeader):

```ts
/** agy `--output-format json` envelope: {conversation_id, status, response, …}.
 * Returns null if parsing fails entirely (older agy versions / truncated output) — caller falls back to plain text;
 * main analysis flow never fails due to session capture failure (coach chat spec). */
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

In `agyClientFactory` direct call branch (non-legacyScript): append `"--output-format", "json"` based on `params.captureSession` (immediately after `--print printArg`); after getting `out`:

```ts
if (params.captureSession) {
  const env = parseAgyJsonEnvelope(out);
  if (env) {
    if (env.status && env.status !== "SUCCESS") {
      throw new Error(`agy returned status=${env.status}`);
    }
    yield { delta: env.response };
    if (env.conversationId) yield { sessionId: env.conversationId };
    return;
  }
  // Envelope parse failure: fallback to legacy behavior (plain text, no session events)
}
yield { delta: out };
```

Note: legacyScript (.mjs wrapper) branch ignores captureSession, behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): agy json envelope captures conversation_id (fallback to plain text on parse failure)"
```

---

### Task 3: codex `--json` Captures session id (remove `--ephemeral`)

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts` (codexClientFactory + new export `parseCodexSessionId`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces: `parseCodexSessionId(stdoutJsonl: string): string | null` (scans JSONL for first `"session_id"` or `"thread_id"` UUID value); codex stream adds `--json` and **omits** `--ephemeral` when `captureSession`, response still read from `-o` file, yields `{delta}` + `{sessionId}` (yields only delta if id cannot be parsed).
- Consumes: Task 1 parameter/event types; existing `-o` outFile mechanism.

- [ ] **Step 1: Write the failing test**

```ts
describe("codex session capture", () => {
  it("captureSession: args contain --json without --ephemeral, JSONL extracts session id, response read from -o file", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      // Simulate codex writing -o file
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "Final reply", "utf-8");
      return [
        JSON.stringify({
          type: "session_configured",
          session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }),
        JSON.stringify({ type: "agent_message", text: "noise" }),
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
      { delta: "Final reply" },
      { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
  });

  it("captureSession: emits only delta when JSONL lacks id (analysis does not fail)", async () => {
    const run: Runner = async (_f, args) => {
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "Reply", "utf-8");
      return "non-json line\nanother line";
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
    expect(events).toEqual([{ delta: "Reply" }]);
  });

  it("omitting captureSession: args retain --ephemeral without --json (legacy behavior)", async () => {
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

(If `writeFileSync` is not imported at top of test file, add from `node:fs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```ts
/** Session id from codex `--json` JSONL event stream: line-by-line JSON.parse, takes first
 * `session_id` or `thread_id` matching UUID format; returns null if unparseable across stream. */
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
      /* skip non-json lines */
    }
  }
  return null;
}
```

Change args assembly in `codexClientFactory` to:

```ts
const sessionArgs = params.captureSession ? ["--json"] : ["--ephemeral"];
// Replace "--ephemeral" in original args array with ...sessionArgs (position maintained after
// --skip-git-repo-check, before --color)
```

After obtaining stdout, following existing `-o` file reading logic:

```ts
yield { delta };
if (params.captureSession) {
  const sid = parseCodexSessionId(stdout);
  if (sid) yield { sessionId: sid };
}
```

Note: when `captureSession`, stdout is JSONL and **no longer** acts as fallback response source if `-o` file is missing — keep fallback only in non-captureSession path (status quo); when captureSession and file unreadable, leave delta as empty string (honest: no usable response available; upstream parseModelJsonArray handles as bad-json).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/localAiBackends.ts packages/desktop/src/main/localAiBackends.test.ts
git commit -m "feat(desktop): codex --json captures session id (removes --ephemeral on capture)"
```

---

### Task 4: run() Writes sessionId into Analysis Result

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` (AnalysisResult + run())
- Test: `packages/desktop/src/main/analysis.test.ts`

**Interfaces:**

- Produces: `AnalysisResult.sessionId?: string` (written only for CLI backends when capture succeeds and audit produces findings; omitted for fallback results). `writeMerged` in deepen already spreads `{...slot.result, findings, deepened}`, automatically preserving sessionId — no changes needed in deepen.
- Consumes: Task 1-3's `sessionIdHint`/`captureSession`/`{sessionId}` events; `crypto.randomUUID`.

- [ ] **Step 1: Write the failing test**

In `analysis.test.ts`, mimicking existing run test cases (with `clientFactory` stub), add:

```ts
it("CLI backend analysis captures sessionId into cache; retry round claudeCli swaps new UUID", async () => {
  const hints: Array<string | undefined> = [];
  let attempt = 0;
  const service = createAnalysisService({
    getSettings: () => ({
      anthropicApiKey: null,
      wowDirectory: null,
      aiBackend: "claudeCli" as const,
      aiLanguage: "zh" as const,
    }),
    matchesDir: tmpDir,
    emit: () => {},
  });
  // After calling service.run(input):
  const cached = (await service.getCached("m1")) as { sessionId?: string };
  expect(cached?.sessionId).toBe(hints[1]); // hint from second (successful) round
  expect(hints[0]).not.toBe(hints[1]); // retry swapped UUID
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/analysis.test.ts`
Expected: FAIL (cached.sessionId undefined)

- [ ] **Step 3: Write minimal implementation**

In `analysis.ts`:

```ts
export type AnalysisResult = {
  // …existing fields…
  /** coach chat (2026-08-02 spec): session id captured from CLI backend analysis call,
   * used for chat resume. Omitted for API backends / capture failures / deterministic fallback results. */
  sessionId?: string;
};
```

Inside run() (`callOnce` refactor):

```ts
const isCliBackend =
  backend === "claudeCli" || backend === "agy" || backend === "codex";
const callOnce = async (attempt: number) => {
  let raw = "";
  let capturedSession: string | undefined;
  // claudeCli swaps new UUID per attempt: duplicate id on re-seeding collides with existing session
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
    if (ev.delta) { /* …existing delta logic unchanged… */ }
  }
  // …existing recordAiDebug/parse unchanged…
  return { parsed: …, capturedSession };
};
```

Update finish in success branch:

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

Top of file: `import { randomUUID } from "crypto";` (Node built-in available in main process).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && npx vitest run src/main/analysis.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/analysis.ts packages/desktop/src/main/analysis.test.ts
git commit -m "feat(desktop): analysis result captures CLI session id (claudeCli retry swaps UUID)"
```

---

### Task 5: continueCliChat + Abortable Runner

**Files:**

- Modify: `packages/desktop/src/main/localAiBackends.ts` (Runner opts + defaultRun + new export `continueCliChat`)
- Test: `packages/desktop/src/main/localAiBackends.test.ts`

**Interfaces:**

- Produces:

```ts
export type CliChatBackend = "claudeCli" | "agy" | "codex";
export async function continueCliChat(input: {
  backend: CliChatBackend;
  cmd?: string; // Custom command path; auto-detected if omitted
  sessionId: string;
  question: string;
  model: string; // Model recorded in thread, matching seed source
  signal?: AbortSignal;
  run?: Runner; // Test injection
}): Promise<string>; // Coach reply text; rejects on failure
```

- `Runner` type adds 4th parameter `opts?: { signal?: AbortSignal }`; defaultRun kills child process with SIGKILL and rejects `new Error("aborted")` when signal aborts.
- Consumes: `requireCli`/`resolveCliWithVersionProbe`, `agyCliModelName`, `stripAgyHeader`, spill mechanism (`winPromptLimit`/`AGY_PROMPT_SPILL_DIR`/`ensureSpillDirSwept`), `CODEX_OUT_SPILL_DIR`.

- [ ] **Step 1: Write the failing test**

```ts
describe("continueCliChat", () => {
  it("claudeCli: --resume <id>, question via stdin", async () => {
    const calls: Array<{ args: string[]; stdin: string }> = [];
    const run: Runner = async (_f, args, stdin) => {
      calls.push({ args, stdin });
      return "Follow-up reply";
    };
    const out = await continueCliChat({
      backend: "claudeCli",
      cmd: "/bin/claude",
      sessionId: "sid-1",
      question: "Why should defensive be used here?",
      model: "claude-sonnet-5",
      run,
    });
    expect(out).toBe("Follow-up reply");
    expect(calls[0]!.args).toEqual([
      "-p",
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-5",
      "--resume",
      "sid-1",
    ]);
    expect(calls[0]!.stdin).toBe("Why should defensive be used here?");
  });

  it("agy: --conversation <id>, without --new-project, question in argv, strip [agy-run] header", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "[agy-run] header\nreply";
    };
    const out = await continueCliChat({
      backend: "agy",
      cmd: "/bin/agy",
      sessionId: "conv-1",
      question: "question",
      model: "flash",
      run,
    });
    expect(out).toBe("reply");
    expect(calls[0]).toContain("--conversation");
    expect(calls[0]).toContain("conv-1");
    expect(calls[0]).not.toContain("--new-project");
  });

  it("codex: exec resume <id>, question via stdin, response read from -o file", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args, stdin) => {
      calls.push(args);
      expect(stdin).toBe("question");
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1]!, "codex reply", "utf-8");
      return "";
    };
    const out = await continueCliChat({
      backend: "codex",
      cmd: "/bin/codex",
      sessionId: "sid-c",
      question: "question",
      model: "gpt-x",
      run,
    });
    expect(out).toBe("codex reply");
    expect(calls[0]!.slice(0, 3)).toEqual(["exec", "resume", "sid-c"]);
    expect(calls[0]).not.toContain("--ephemeral");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && npx vitest run src/main/localAiBackends.test.ts`
Expected: FAIL (continueCliChat not exported)

- [ ] **Step 3: Write minimal implementation**

Runner and defaultRun:

```ts
export type Runner = (
  file: string,
  args: string[],
  stdin: string,
  opts?: { signal?: AbortSignal },
) => Promise<string>;
```

Inside defaultRun after spawn:

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

(In close/error callbacks: `opts?.signal?.removeEventListener("abort", onAbort)`.)

continueCliChat implementation:

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
    // Question may also exceed Windows argv limits: reuse spill (same guard as seeding)
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
      return stdout; // Older codex versions don't recognize -o: fallback to stdout
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
git commit -m "feat(desktop): continueCliChat for 3 CLIs + Runner AbortSignal cancellation"
```

---

### Task 6: coachChat Service (main)

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
  | { status: "unsupported" } // Current backend not CLI
  | { status: "not-ready" } // CLI lacks analysis with sessionId for this round and has no thread
  | {
      status: "ready";
      backend: string;
      model: string;
      messages: ChatMessage[];
      busy: boolean;
    };
export type ChatSendResult =
  | { status: "ok"; reply: string }
  | { status: "need-reseed" } // resume failed without seed provided: renderer constructs seed and retries
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
  /** Test injection; production uses real localAiBackends functions. */
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

- Persists `<matchesDir>/<matchId>/coachChat.<lang>.json`: `{ version: 1, threads: { [backend]: { sessionId, model, messages } } }`, atomic tmp+rename write.
- Consumes: Task 4 `AnalysisResult.sessionId` (scans slots via `analysisCachePath` + `toSlottedDoc` + `splitSlotKey`: matching backend prefix, `promptVersion === PROMPT_VERSION`, `result.sessionId` exists, takes latest createdAt); Task 5 `continueCliChat`; Task 1-3 captureSession seeding (self-healing); `buildCoachSystemPrompt`.

- [ ] **Step 1: Write the failing tests**

`coachChat.test.ts`:

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

it("gates: API backend unsupported; match without analysis session not-ready; ready otherwise", async () => {
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

it("legacy cache without sessionId -> not-ready (unlocked only after re-analysis)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1"); // No sessionId
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  expect((await svc.getState("m1")).status).toBe("not-ready");
});

it("send: resume succeeds, message appended and persisted; readable upon service restart (continue chat)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async () => "Coach reply");
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  const r = await svc.send({ matchId: "m1", question: "question" });
  expect(r).toEqual({ status: "ok", reply: "Coach reply" });
  expect(chatRunner.mock.calls[0]![0]).toMatchObject({
    backend: "claudeCli",
    sessionId: "sid-a",
    question: "question",
    model: "claude-sonnet-5",
  });
  // Persisted + read back on new instance
  const svc2 = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  const st = (await svc2.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});

it("send: resume fails without seed -> need-reseed; with seed -> seeds new session and re-asks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-dead" });
  const chatRunner = vi
    .fn()
    .mockRejectedValueOnce(new Error("session not found"))
    .mockResolvedValue("Reply after self-healing");
  // seedClient stub: captureSession seeding, yields reply + new sessionId
  const seedClient = () => ({
    async *stream(params: { sessionIdHint?: string }) {
      yield { delta: "Seeded reply (answering new question)" };
      yield { sessionId: params.sessionIdHint ?? "new-sid" };
    },
  });
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
    seedClient: seedClient as never,
  });
  const r1 = await svc.send({ matchId: "m1", question: "question" });
  expect(r1).toEqual({ status: "need-reseed" });
  const r2 = await svc.send({
    matchId: "m1",
    question: "question",
    seed: { richContext: "CTX", spec: "Holy Paladin", findingsSummary: "F1" },
  });
  expect(r2.status).toBe("ok");
  // thread sessionId updated to new id (self-healing)
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2); // user + assistant (need-reseed attempt not persisted)
});

it("concurrency guard: returns busy when another send is in-flight for same match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  let release!: () => void;
  const gate = new Promise<string>((r) => (release = () => r("Slow reply")));
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

it("one thread per CLI: switching backend displays respective history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async () => "reply");
  let backend: "claudeCli" | "agy" = "claudeCli";
  const svc = createCoachChatService({
    getSettings: () => ({ ...settings(), aiBackend: backend }),
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  await svc.send({ matchId: "m1", question: "question" });
  backend = "agy"; // agy has no analysis session -> not-ready (no thread either)
  expect((await svc.getState("m1")).status).toBe("not-ready");
  backend = "claudeCli";
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && npx vitest run src/main/coachChat.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Write implementation**

`coachChat.ts` implementation:

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
/** Max message limit for seeded re-transmission / history stitching (spec: earlier turns truncated with note). */
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
    /* First time */
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

/** Finds latest analysis slot for this CLI backend carrying sessionId and current version. */
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

export function createCoachChatService(deps: {
  getSettings: () => {
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiModels?: AiModelSelection | null;
    aiLanguage?: AiLanguage;
  };
  matchesDir: string;
  chatRunner?: typeof continueCliChat;
  seedClient?: (backend: CliChatBackend, cmd?: string) => AnthropicLike;
}) {
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

    async send(input: {
      matchId: string;
      question: string;
      seed?: ChatSeed;
    }): Promise<ChatSendResult> {
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
          // Self-healing / seed-less seeding: new session, seed contains context + findings + history + new question
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
              return { status: "error", message: "Stopped" };
            return { status: "need-reseed" }; // renderer builds seed and retries
          }
        }
        if (ac.signal.aborted) return { status: "error", message: "Stopped" };
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
    if (!sessionId) throw new Error("Seeding failed to capture session id");
    return { sessionId, reply };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/desktop && npx vitest run src/main/coachChat.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/coachChat.ts packages/desktop/src/main/coachChat.test.ts
git commit -m "feat(desktop): coachChat service -- per-CLI threads / gates / resume / 2-step self-healing / concurrency guards"
```

---

### Task 7: IPC + Preload Wiring

**Files:**

- Modify: `packages/desktop/src/main/ipc.ts` (registerIpc deps + three handlers)
- Modify: `packages/desktop/src/main/index.ts` (create service and pass to registerIpc; following analysis service pattern)
- Modify: `packages/desktop/src/preload/api.ts` (types) and `packages/desktop/src/preload/index.ts` (invoke implementation)

**Interfaces:**

- Produces (renderer side bridge surface, `bridge().chat`):

```ts
chat: {
  getState(matchId: string): Promise<ChatState>;
  send(input: { matchId: string; question: string; seed?: {
    richContext: string; spec: string; ownerName?: string;
    findingsSummary: string } }): Promise<ChatSendResult>;
  cancel(matchId: string): Promise<void>;
};
```

- IPC Channels: `gladlog:chat:getState` / `gladlog:chat:send` / `gladlog:chat:cancel`.
- Consumes: Task 6 `createCoachChatService`.

- [ ] **Step 1: Wiring**

In `ipc.ts`: deps adds `chat: CoachChatService` (type-only import), inside register:

```ts
ipcMain.handle("gladlog:chat:getState", (_e, matchId: string) =>
  deps.chat.getState(String(matchId)),
);
ipcMain.handle("gladlog:chat:send", (_e, input) => deps.chat.send(input));
ipcMain.handle("gladlog:chat:cancel", (_e, matchId: string) =>
  deps.chat.cancel(String(matchId)),
);
```

In `index.ts`: beside createAnalysisService creation point:

```ts
const coachChat = createCoachChatService({
  getSettings: () => settings.get(),
  matchesDir,
});
```

And pass to `registerIpc({ …, chat: coachChat })`. Add chat surface to preload in both places (`api.ts` type + `index.ts` `invoke("gladlog:chat:…")` forwarding).

- [ ] **Step 2: Verification**

Run: `cd packages/desktop && npx vitest run test/pipeline.test.ts && npm run typecheck`
Expected: PASS / 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): coachChat IPC/preload wiring"
```

---

### Task 8: CoachChatCard (renderer) + Mount in AI View

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/CoachChatCard.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (`rpt-ai-main` column where `view === "ai"`, after StructuredAnalysisPanel)
- Modify: `packages/desktop/src/renderer/src/styles.css` (`.coach-chat-*` styles)
- Test: `packages/desktop/test/coachChatCard.test.tsx`

**Interfaces:**

- Consumes: `bridge().chat` (Task 7 surface, access must be optional + try/catch: stubs often lack surface); `buildAnalysisInput` (`../derive/analysisInput`, builds seed on need-reseed); `ensureAnalysisData`; `bridge().analysis.getCached` (fetches findings summary); props `{ source: ReportSource; matchId: string }`.
- Produces: `<CoachChatCard source={source} matchId={resolvedMatchId} />`.

- [ ] **Step 1: Write the failing tests**

`test/coachChatCard.test.tsx`:

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
      send: send ?? (async () => ({ status: "ok", reply: "Reply" })),
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
}

it("unsupported: displays CLI guidance text, no input box", async () => {
  stubChat({ status: "unsupported" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/Requires local CLI backend/);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("not-ready: displays 'Chat is available only after AI analysis starts'", async () => {
  stubChat({ status: "not-ready" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/Chat is available only after AI analysis starts/);
});

it("ready: sending message -> displays user message and coach reply", async () => {
  stubChat({
    status: "ready",
    backend: "claudeCli",
    model: "sonnet",
    messages: [],
    busy: false,
  });
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "Why?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Reply");
  expect(screen.getByText("Why?")).toBeTruthy();
});

it("send failure (error): marks item failed and provides retry button", async () => {
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
  fireEvent.change(input, { target: { value: "question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(/Failed to send/);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && npx vitest run test/coachChatCard.test.tsx`
Expected: FAIL (component does not exist)

- [ ] **Step 3: Write implementation**

CoachChatCard key points:

- State: `chatState` (getState result), `pending` (in-flight question text), `failed` (failed question text waiting retry), `draft` (input text).
- On mount / matchId change: `void refresh()` (getState → setChatState; missing bridge surface caught with try/catch → card renders null). Also subscribe to `bridge().analysis?.onDone?.(…)` (optional surface, refresh if present — unlocks upon analysis completion).
- Send workflow:

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

- Render 4 states: `unsupported` guide / `not-ready` notice "Chat is available only after AI analysis starts" / `ready` message list (`messages` + pending "Coach is thinking…" + failed "Failed to send · Retry" button) + input box (textarea role=textbox) + "Send" button (switches to "Stop" when pending → `bridge().chat.cancel(matchId)`).
- Card footer fixed fine print: "Responses are based on combat log reasoning and may contain errors".
- Header small text: `{backend} · {model}`.
- Mount in MatchReport (after `UncoveredHighlightsCard`):

```tsx
<CoachChatCard source={source} matchId={resolvedMatchId} />
```

- styles.css: `.coach-chat-card` (card matching other cards in `.rpt-ai-main`), `.coach-chat-msgs` (max-height: 320px; overflow-y: auto), `.coach-chat-msg--user` right-aligned / `--coach` left-aligned, input row flex. Add `tabIndex={0}` to scrollable container (axe scrollable-region-focusable requirement).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/desktop && npx vitest run test/coachChatCard.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/CoachChatCard.tsx packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/src/renderer/src/styles.css packages/desktop/test/coachChatCard.test.tsx
git commit -m "feat(desktop): Ask Coach chat card -- 4-state state machine mounted in AI view"
```

---

### Task 9: Full Gate + Real Device Smoke + Visual Baseline

**Files:**

- No new files (may update `packages/desktop/qa/__screenshots__/**` baseline)

- [ ] **Step 1: presubmit**

Run: `npm run presubmit` (repo root)
Expected: EXIT=0. Fix until green before proceeding.

- [ ] **Step 2: Real device smoke (spec completion requirement, do not skip)**

Write temporary script `packages/desktop/scripts/tmp-chat-smoke.mts` (delete after use): Fetch recent round from local matches → `buildAnalysisInput` → call `createAnalysisService` directly (claudeCli backend) for real analysis → assert cached `sessionId` exists → `createCoachChatService.send` ask "Summarize what I should improve most in one sentence" → assert response non-empty and multi-turn (ask follow-up referencing previous answer, e.g., "Elaborate on that point", response should connect). Repeat for agy backend (verify json envelope real-device parsing). Manually verify both conversations connect (record in commit message).

- [ ] **Step 3: Visual baseline (only if AI view screenshot in CI baseline set changes)**

Per desktop-dev recipe: `gh workflow run visual-baseline.yml --ref main` → download → `cmp` to find DIFF → human review each image (changes must be explainable by chat card) → overwrite commit.

- [ ] **Step 4: Commit + push + CI**

```bash
rm -f packages/desktop/scripts/tmp-chat-smoke.mts
git add -A && git commit -m "test(desktop): Ask Coach real-device smoke passes (claudeCli + agy multi-turn continuity)" && git push
RUN=$(gh run list --workflow test.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RUN --exit-status
```

---

## Self-Review Records

- Spec coverage: CLI-only gate (T6/T8), same agent analyzed prerequisite (T6 findAnalysisSession + T8 not-ready state), 3 CLI captures (T1-3) and resume (T5), analysis does not fail on capture failure (T2/T3 fallback tests), 2-step self-healing (T6), per-CLI threads/switching (T6 tests), stop/timeout (T5 AbortSignal + T8 stop button), disclaimer text (T8), real device smoke (T9). deepen remaining out of session: T4 notes writeMerged spread retains sessionId, no changes needed.
- Type consistency: `ChatSendResult`/`ChatState`/`ChatSeed`/`continueCliChat` signatures consistent across T5/T6/T7/T8; `AnalysisResult.sessionId` defined in T4, consumed in T6.
- Placeholders: No TBDs; T7 is pure plumbing wiring verified by typecheck + pipeline tests.
