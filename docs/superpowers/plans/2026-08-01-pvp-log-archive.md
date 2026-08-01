# PvP log 长期归档管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每 6 小时扫一次 wowarenalogs feed,把新出现的公开 PvP combat log 以**原始 gzip 字节**下载、上传到 Google Drive 按天分目录归档,本地只留账本。

**Architecture:** 纯逻辑(谓词/账本/rclone args/锁)从 IO 里剥出来单测,IO 编排留在 `scripts/archivePvpLogs.ts` 壳里 —— 与 `driveSync.ts` / `pvpLogFetch.ts` 现有分层一致。下载层抽一个 `downloadRaw()` 返回未解压字节,归档器直接落盘、`fetchPvpLogs` 在其上解压。

**Tech Stack:** TypeScript (ESM), node-fetch v3, node:zlib, fs-extra, vitest, rclone(外部二进制), launchd(macOS)

设计依据:`docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`
合规依据:`docs/DATA-COMPLIANCE.md`

## Global Constraints

- 所有出站请求必须经 `fetchWithRetry`(它挂 `USER_AGENT`,是唯一出站咽喉)。绝不新写裸 `fetch`。
- 翻页间隔 500ms;下载间隔 2s(`DOWNLOAD_SLEEP_MS` 可调,不得默认为 0)。串行,绝不并发。
- 账本只在**确认上传成功后**才写。记早了 = 永久丢一场(feed 窗口仅 7 天)。
- 每次运行**先冲刷上次遗留的暂存,再扫 feed**。
- 停止阈值 K = 200(4 页);账本加载窗口 = 10 天;上传批 = 200 场或 500MB 取先到;磁盘剩余 < 20GB 即停止本次运行。
- 代码注释与提交信息用中文,与本仓一致。字符串用双引号(prettier 已配置)。
- 每个 task 结束前必须跑:`npm test --workspace=packages/corpus-tools` 与 `npm run typecheck`,两者都必须绿。

---

### Task 1: 修下载完整性校验的压缩/解压口径 bug,并抽出 `downloadRaw()`

**背景(必读):** `c9c463e`(2026-07-31 审计)加的字节数校验拿 `content-length`(GCS 上是**压缩**尺寸)去比**解压后**文本的字节数,两者永不相等 —— `fetchPvpLogs.ts` 目前**每一场都判为不完整并跳过,一场也下不下来**。2026-08-01 实测:`content-length: 109885`,解压后 1463618 字节,`checkPayloadCompleteness` 返回 `{ok:false, reason:"byte length mismatch: expected 109885, got 1463618"}`。

修法是把两件事分开:字节数校验属于**原始字节层**(比 `content-length` 与实收压缩字节),哨兵校验属于**解压文本层**。

**Files:**

- Modify: `packages/corpus-tools/src/pvpLogFetch.ts`(替换 `checkPayloadCompleteness`)
- Modify: `packages/corpus-tools/src/feedClient.ts`(新增 `downloadRaw`)
- Modify: `packages/corpus-tools/scripts/fetchPvpLogs.ts`(`downloadWithMeta` 改用 `downloadRaw` + 解压)
- Test: `packages/corpus-tools/src/pvpLogFetch.test.ts`
- Test: `packages/corpus-tools/src/feedClient.test.ts`

**Interfaces:**

- Consumes: `fetchWithRetry(f, url, init, label, opts)`、`expectedByteLength({contentLength, storedContentLength})`(均已存在,签名不变)
- Produces:
  - `downloadRaw(url: string, label: string, fetchImpl?: any): Promise<RawDownload>`
  - `interface RawDownload { bytes: Buffer; contentEncoding: string; header(name: string): string; expectedBytes: number | undefined }`
  - `checkRawPayloadBytes(receivedBytes: number, expectedBytes: number | undefined): CompletenessResult`
  - `checkDecompressedPayload(text: string): CompletenessResult`
  - `decodeRawPayload(raw: RawDownload): string`

- [ ] **Step 1: 写失败测试(字节层与文本层分开)**

在 `packages/corpus-tools/src/pvpLogFetch.test.ts` 末尾追加:

```ts
describe("checkRawPayloadBytes(原始压缩字节层)", () => {
  it("实收字节数与 content-length 相等即通过", () => {
    expect(checkRawPayloadBytes(109885, 109885)).toEqual({ ok: true });
  });
  it("实收少于期望 = 截断,必须拒收", () => {
    const r = checkRawPayloadBytes(50000, 109885);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/109885/);
  });
  it("拿不到期望字节数时不做该项校验(仍交给哨兵层)", () => {
    expect(checkRawPayloadBytes(50000, undefined)).toEqual({ ok: true });
  });
});

describe("checkDecompressedPayload(解压文本层)", () => {
  it("两个哨兵齐全即通过", () => {
    const t = "x ARENA_MATCH_START,2373 y ARENA_MATCH_END,1 z";
    expect(checkDecompressedPayload(t)).toEqual({ ok: true });
  });
  it("缺 ARENA_MATCH_START 必须拒收", () => {
    expect(checkDecompressedPayload("ARENA_MATCH_END,1").ok).toBe(false);
  });
  it("缺 ARENA_MATCH_END 必须拒收(SS 整场以唯一一次 END 收尾)", () => {
    expect(checkDecompressedPayload("ARENA_MATCH_START,2373").ok).toBe(false);
  });
  it("不再按解压文本比对压缩字节数 —— 这正是 c9c463e 的 bug", () => {
    // 1.4MB 解压文本 + 109885 压缩 content-length:旧实现在这里误判为截断,
    // 导致每一场都被跳过。新实现的文本层压根不看字节数。
    const t = "ARENA_MATCH_START," + "x".repeat(1_400_000) + "ARENA_MATCH_END,";
    expect(checkDecompressedPayload(t)).toEqual({ ok: true });
  });
});
```

在该文件顶部 import 里加入 `checkRawPayloadBytes`、`checkDecompressedPayload`(移除对 `checkPayloadCompleteness` 的引用及其旧测试块)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- pvpLogFetch`
Expected: FAIL —— `checkRawPayloadBytes is not a function` / `checkDecompressedPayload is not a function`

- [ ] **Step 3: 实现两个校验函数,删掉旧的**

在 `packages/corpus-tools/src/pvpLogFetch.ts` 中,把 `checkPayloadCompleteness` 整个函数(连同其 JSDoc)替换为:

```ts
/**
 * 原始字节层校验:实收压缩字节数必须与 GCS 给的 content-length 严格相等。
 *
 * HTTP 200 但连接中途断流(SS 整场可达 30MB)靠这条拦下。**必须在未解压的
 * 字节上比**——GCS 侧对象是 gzip 存储(content-encoding: gzip),content-length
 * 是压缩尺寸;拿它去比解压后的文本长度永不相等,那正是 c9c463e 引入、
 * 2026-08-01 实测确认的「每一场都被判为截断」的 bug。
 */
export function checkRawPayloadBytes(
  receivedBytes: number,
  expectedBytes: number | undefined,
): CompletenessResult {
  if (expectedBytes === undefined) return { ok: true };
  if (receivedBytes !== expectedBytes) {
    return {
      ok: false,
      reason: `byte length mismatch: expected ${expectedBytes}, got ${receivedBytes}`,
    };
  }
  return { ok: true };
}

/**
 * 解压文本层校验:两个哨兵都必须在。
 *
 * ARENA_MATCH_END 也要查——Solo Shuffle 6 轮共享同一 log 对象,轮次切换只发新的
 * START,只有整场打完才发唯一一次 END(segmenter.ts 实证),所以完整 payload 与
 * 普通对局同构地以 END 收尾,判据不必按 bracket 分支。
 *
 * 这一层**不看字节数**:字节数是原始压缩字节的事,见 checkRawPayloadBytes。
 */
export function checkDecompressedPayload(text: string): CompletenessResult {
  if (!text.includes("ARENA_MATCH_START")) {
    return { ok: false, reason: "missing ARENA_MATCH_START" };
  }
  if (!text.includes("ARENA_MATCH_END")) {
    return { ok: false, reason: "missing ARENA_MATCH_END" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- pvpLogFetch`
Expected: PASS

- [ ] **Step 5: 写 `downloadRaw` 的失败测试**

在 `packages/corpus-tools/src/feedClient.test.ts` 末尾追加:

```ts
describe("downloadRaw(不解压,原始字节)", () => {
  it("以 compress:false 请求并返回未解压字节与 content-length", async () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
    const fake = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (k: string) =>
          ({
            "content-length": String(body.length),
            "content-encoding": "gzip",
          })[k.toLowerCase()] ?? null,
      },
      arrayBuffer: async () => body.buffer.slice(0, body.length),
      json: async () => ({}),
    });
    const raw = await downloadRaw("https://x/y", "probe", fake as any);
    // compress:false 是关键——否则 node-fetch 会自动解压,拿不到原始字节
    expect(fake.mock.calls[0][1].compress).toBe(false);
    expect(raw.bytes.length).toBe(body.length);
    expect(raw.contentEncoding).toBe("gzip");
    expect(raw.expectedBytes).toBe(body.length);
    // UA 仍必须挂上(唯一出站咽喉的约束)
    expect(fake.mock.calls[0][1].headers["user-agent"]).toBe(USER_AGENT);
  });
});
```

在该文件顶部 import 里加入 `downloadRaw`。

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- feedClient`
Expected: FAIL —— `downloadRaw is not a function`

- [ ] **Step 7: 实现 `downloadRaw`**

先把 `expectedByteLength` **从 `pvpLogFetch.ts` 移到 `feedClient.ts`**(连同它的 JSDoc),
再在 `pvpLogFetch.ts` 原位置放一行 `export { expectedByteLength } from "./feedClient";`。

为什么要搬:`downloadRaw` 需要它,而 `feedClient` 不能 import `pvpLogFetch` 的**值**
(pvpLogFetch 已经从 feedClient import 类型,反向再引值就成运行时循环)。搬过去 +
再导出既消除重复实现,又让 `pvpLogFetch.test.ts` 里现有的 `expectedByteLength` 测试
原封不动继续通过。

然后在 `packages/corpus-tools/src/feedClient.ts` 末尾追加:

```ts
export interface RawDownload {
  /** 未解压的响应体字节。GCS 上对象是 gzip 存储,这里就是那份压缩字节。 */
  bytes: Buffer;
  /** 响应的 content-encoding,通常是 "gzip";空串表示未压缩。 */
  contentEncoding: string;
  /** 取响应头(小写名),缺失返回空串。 */
  header(name: string): string;
  /** GCS 声明的字节数(= 压缩尺寸),拿不到则 undefined。 */
  expectedBytes: number | undefined;
}

/**
 * 下载但**不解压**。
 *
 * node-fetch 默认 compress:true 会自动 gunzip,于是 content-length(压缩尺寸)
 * 与拿到的正文长度对不上,既没法校验截断,也逼着我们把对方压缩好的数据解压后
 * 再存(实测膨胀 11.4x)。compress:false 让我们拿到原始字节:归档器直接落盘,
 * 需要文本的调用方自己 decodeRawPayload。
 */
export async function downloadRaw(
  url: string,
  label: string,
  fetchImpl?: FetchLike,
): Promise<RawDownload> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const res: any = await fetchWithRetry(f, url, { compress: false }, label);
  const header = (name: string): string =>
    res.headers?.get?.(name.toLowerCase()) ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    contentEncoding: header("content-encoding"),
    header,
    expectedBytes: expectedByteLength({
      contentLength: header("content-length"),
      storedContentLength: header("x-goog-stored-content-length"),
    }),
  };
}

/** 原始字节 → 文本。按 content-encoding 决定是否 gunzip。 */
export function decodeRawPayload(raw: RawDownload): string {
  if (raw.contentEncoding === "gzip") {
    return gunzipSync(raw.bytes).toString("utf8");
  }
  return raw.bytes.toString("utf8");
}
```

在 `feedClient.ts` 顶部加 `import { gunzipSync } from "node:zlib";`。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- feedClient`
Expected: PASS

- [ ] **Step 9: 把 `fetchPvpLogs.ts` 切到新路径**

在 `packages/corpus-tools/scripts/fetchPvpLogs.ts` 中:

把 import 行 `import { fetchDetailedStubs, fetchWithRetry } from "../src/feedClient";` 改为
`import { decodeRawPayload, downloadRaw, fetchDetailedStubs } from "../src/feedClient";`

把 `checkPayloadCompleteness` 的 import 改为 `checkDecompressedPayload, checkRawPayloadBytes`。

把整个 `downloadWithMeta` 函数替换为:

```ts
async function downloadWithMeta(
  url: string,
  id: string,
): Promise<{
  text: string;
  meta: NonNullable<ManifestEntry["gcsMeta"]>;
  rawCheck: ReturnType<typeof checkRawPayloadBytes>;
}> {
  const raw = await downloadRaw(url, `log download for ${id}`);
  const { meta, missingFields } = buildGcsMeta({
    wowVersion: raw.header("x-goog-meta-wow-version"),
    clientTimezone: raw.header("x-goog-meta-client-timezone"),
    clientYear: raw.header("x-goog-meta-client-year"),
    startTimeUtc: raw.header("x-goog-meta-starttime-utc"),
  });
  if (missingFields.length > 0) {
    console.warn(`  ${id}: gcsMeta 缺字段 ${missingFields.join(",")}`);
  }
  // 字节数校验必须在**未解压**字节上做,解压后再比是 c9c463e 的 bug。
  const rawCheck = checkRawPayloadBytes(raw.bytes.length, raw.expectedBytes);
  return { text: rawCheck.ok ? decodeRawPayload(raw) : "", meta, rawCheck };
}
```

把下载循环里的完整性判断(原 `const completeness = checkPayloadCompleteness(text, expectedBytes);`)替换为:

```ts
const { text, meta, rawCheck } = await downloadWithMeta(
  stub.logObjectUrl,
  stub.id,
);
const completeness = rawCheck.ok ? checkDecompressedPayload(text) : rawCheck;
```

(原先解构出的 `expectedBytes` 不再需要,一并删掉;`expectedByteLength` 在本文件已不再被引用,从 import 里一并删掉。)

- [ ] **Step 10: typecheck + 全量单测**

Run: `npm run typecheck && npm test --workspace=packages/corpus-tools`
Expected: 均通过

- [ ] **Step 11: 真机验证 —— 这是本 task 的验收判据**

Run: `cd packages/corpus-tools && BRACKET=3v3 LIMIT=2 OUT_DIR=/tmp/pvp-fix-check npx tsx scripts/fetchPvpLogs.ts`

Expected: 输出 `[1/2] ... KB` 与 `[2/2] ... KB` 两行,`done: 2 new logs`。
**修复前的同一条命令是 `skip <id>: incomplete download (byte length mismatch...)` × N、`done: 0 new logs`** —— 提交信息里要写上这组前后数字。

清理:`rm -rf /tmp/pvp-fix-check`

- [ ] **Step 12: 提交**

```bash
git add packages/corpus-tools/src/pvpLogFetch.ts packages/corpus-tools/src/feedClient.ts packages/corpus-tools/scripts/fetchPvpLogs.ts packages/corpus-tools/src/pvpLogFetch.test.ts packages/corpus-tools/src/feedClient.test.ts
git commit -m "fix(corpus-tools): 下载完整性校验分层 —— 字节数比压缩字节,哨兵比解压文本

c9c463e 的字节数校验拿 content-length(GCS 上是压缩尺寸)去比解压后文本长度,
两者永不相等,导致 fetchPvpLogs 每一场都判为截断、一场也下不下来。

真机前后(BRACKET=3v3 LIMIT=2):修复前 done: 0 new logs(全部 skip byte length
mismatch);修复后 done: 2 new logs。

顺带抽出 downloadRaw()(compress:false 取未解压字节)与 decodeRawPayload(),
为归档器直接落盘压缩字节铺路。"
```

---

### Task 2: `archivePlan.ts` —— 归档的纯谓词

**Files:**

- Create: `packages/corpus-tools/src/archivePlan.ts`
- Test: `packages/corpus-tools/src/archivePlan.test.ts`

**Interfaces:**

- Consumes: `DetailedMatchStub`(来自 `./feedClient`,已存在)
- Produces:
  - `STOP_AFTER_KNOWN = 200`
  - `matchDateKey(startTimeMs: number): string` → `"2026-08-01"`(UTC)
  - `shouldArchive(stub: DetailedMatchStub, known: Set<string>): boolean`
  - `shouldStopScanning(consecutiveKnown: number): boolean`
  - `stagingPathFor(stagingRoot: string, dateKey: string, matchId: string): string`
  - `driveDestFor(dateKey: string): string` → `"2026/08/01"`
  - `interface BatchState { count: number; bytes: number }`
  - `shouldFlushBatch(state: BatchState): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/corpus-tools/src/archivePlan.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DetailedMatchStub } from "./feedClient";
import {
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
  STOP_AFTER_KNOWN,
} from "./archivePlan";

function stub(over: Partial<DetailedMatchStub> = {}): DetailedMatchStub {
  return {
    typename: "ArenaMatchDataStub",
    id: "m1",
    logObjectUrl: "https://storage.googleapis.com/x/m1",
    playerId: "Player-1",
    hasAdvancedLogging: true,
    durationInSeconds: 120,
    bracket: "3v3",
    units: [],
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    result: 1,
    playerTeamRating: 2100,
    winningTeamId: "0",
    playerTeamId: "0",
    team0MMR: 2100,
    team1MMR: 2100,
    ...over,
  };
}

describe("matchDateKey", () => {
  it("按 UTC 归日,不受本机时区影响", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe("2026-08-01");
  });
  it("UTC 零点边界:23:59 与 00:01 分属两天", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
    expect(matchDateKey(Date.UTC(2026, 7, 2, 0, 0, 1))).toBe("2026-08-02");
  });
  it("月末跨月", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 31, 23, 59, 0))).toBe("2026-08-31");
  });
});

describe("shouldArchive", () => {
  it("新场次且有 advanced logging → 收", () => {
    expect(shouldArchive(stub(), new Set())).toBe(true);
  });
  it("已在账本里 → 不收", () => {
    expect(shouldArchive(stub({ id: "m1" }), new Set(["m1"]))).toBe(false);
  });
  it("没有 advanced logging → 不收(用户拍板跳过)", () => {
    expect(shouldArchive(stub({ hasAdvancedLogging: false }), new Set())).toBe(
      false,
    );
  });
  it("startTime 为 0(元数据损坏)→ 不收,否则会归到 1970 目录", () => {
    expect(shouldArchive(stub({ startTime: 0 }), new Set())).toBe(false);
  });
});

describe("shouldStopScanning", () => {
  it("连续已知未达阈值时继续扫", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN - 1)).toBe(false);
  });
  it("达到阈值才停 —— 防 feed 零星乱序导致的静默漏采", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN)).toBe(true);
  });
  it("阈值是 200(4 页),不是 1", () => {
    expect(STOP_AFTER_KNOWN).toBe(200);
    expect(shouldStopScanning(1)).toBe(false);
  });
});

describe("路径", () => {
  it("暂存路径按日期分目录,文件名是 matchId.txt.gz", () => {
    expect(stagingPathFor("/s", "2026-08-01", "abc")).toBe(
      "/s/2026-08-01/abc.txt.gz",
    );
  });
  it("Drive 目标是 YYYY/MM/DD", () => {
    expect(driveDestFor("2026-08-01")).toBe("2026/08/01");
  });
});

describe("shouldFlushBatch", () => {
  it("满 200 场即冲刷", () => {
    expect(shouldFlushBatch({ count: 200, bytes: 1 })).toBe(true);
  });
  it("满 500MB 即冲刷(场数未满也要)", () => {
    expect(shouldFlushBatch({ count: 3, bytes: 500 * 1024 * 1024 })).toBe(true);
  });
  it("两者都未满则继续攒", () => {
    expect(shouldFlushBatch({ count: 199, bytes: 1024 })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- archivePlan`
Expected: FAIL —— 找不到模块 `./archivePlan`

- [ ] **Step 3: 实现**

创建 `packages/corpus-tools/src/archivePlan.ts`:

```ts
import type { DetailedMatchStub } from "./feedClient";

/**
 * 停止翻页的阈值:连续见到这么多个「已在账本里」的场次才认为追上了。
 *
 * 不能是 1 —— feed 里存在零星乱序/重传,遇到第一个已知就停会静默漏掉它后面
 * 的新场次,而漏采在 7 天窗口下是永久损失。200 = 4 页,留足余量。
 */
export const STOP_AFTER_KNOWN = 200;

const BATCH_MAX_COUNT = 200;
const BATCH_MAX_BYTES = 500 * 1024 * 1024;

/**
 * 比赛所属日期(UTC)。用**比赛开始时刻**而非下载时刻 —— 否则补扫时同一天的
 * 比赛会散落到不同目录。UTC 而非本机时区:归档要跨机器可复现。
 */
export function matchDateKey(startTimeMs: number): string {
  return new Date(startTimeMs).toISOString().slice(0, 10);
}

/** 该不该下这一场。 */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: Set<string>,
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (known.has(stub.id)) return false;
  // startTime 缺失/为 0 会把文件归到 1970 目录,污染按天分片的整个结构。
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

export function shouldStopScanning(consecutiveKnown: number): boolean {
  return consecutiveKnown >= STOP_AFTER_KNOWN;
}

export function stagingPathFor(
  stagingRoot: string,
  dateKey: string,
  matchId: string,
): string {
  return `${stagingRoot}/${dateKey}/${matchId}.txt.gz`;
}

/** Drive 上的相对目标目录:2026-08-01 → 2026/08/01。 */
export function driveDestFor(dateKey: string): string {
  return dateKey.replace(/-/g, "/");
}

export interface BatchState {
  count: number;
  bytes: number;
}

/**
 * 该不该冲刷这一批。批太小则每批的 rclone 进程开销占比高,太大则中途崩溃的
 * 重传成本高 —— 200 场或 500MB,取先到者。
 */
export function shouldFlushBatch(state: BatchState): boolean {
  return state.count >= BATCH_MAX_COUNT || state.bytes >= BATCH_MAX_BYTES;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- archivePlan`
Expected: PASS(20 个用例)

- [ ] **Step 5: 提交**

```bash
git add packages/corpus-tools/src/archivePlan.ts packages/corpus-tools/src/archivePlan.test.ts
git commit -m "feat(corpus-tools): 归档纯谓词 archivePlan —— 日期归属/收不收/何时停/何时冲刷"
```

---

### Task 3: `archiveLedger.ts` —— 按天分片的账本

**Files:**

- Create: `packages/corpus-tools/src/archiveLedger.ts`
- Test: `packages/corpus-tools/src/archiveLedger.test.ts`

**Interfaces:**

- Consumes: `matchDateKey`(Task 2)
- Produces:
  - `LEDGER_WINDOW_DAYS = 10`
  - `interface LedgerEntry { id: string; dateKey: string; bracket: string; startTime: number; playerTeamRating: number; team0MMR: number; team1MMR: number; playerTeamId: string; winningTeamId: string; durationInSeconds: number; specs: string[]; bytes: number; uploaded: boolean }`
  - `ledgerShardPath(ledgerRoot: string, dateKey: string): string`
  - `recentDateKeys(todayMs: number, days: number): string[]`
  - `parseShard(text: string): LedgerEntry[]`
  - `serializeEntry(e: LedgerEntry): string`
  - `knownIdsFrom(entries: LedgerEntry[]): Set<string>`
  - `toIndexLine(e: LedgerEntry): string`

- [ ] **Step 1: 写失败测试**

创建 `packages/corpus-tools/src/archiveLedger.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  knownIdsFrom,
  latestById,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "./archiveLedger";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "m1",
    dateKey: "2026-08-01",
    bracket: "3v3",
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    playerTeamRating: 2100,
    team0MMR: 2090,
    team1MMR: 2110,
    playerTeamId: "0",
    winningTeamId: "1",
    durationInSeconds: 120,
    specs: ["105", "265"],
    bytes: 309855,
    uploaded: true,
    ...over,
  };
}

describe("recentDateKeys", () => {
  it("返回最近 N 天,含今天,新到旧", () => {
    const keys = recentDateKeys(Date.UTC(2026, 7, 3, 5, 0, 0), 3);
    expect(keys).toEqual(["2026-08-03", "2026-08-02", "2026-08-01"]);
  });
  it("默认窗口是 10 天 —— 比 feed 的 7 天留 3 天余量", () => {
    expect(LEDGER_WINDOW_DAYS).toBe(10);
    expect(
      recentDateKeys(Date.UTC(2026, 7, 3), LEDGER_WINDOW_DAYS),
    ).toHaveLength(10);
  });
  it("跨月边界正确", () => {
    expect(recentDateKeys(Date.UTC(2026, 8, 1), 2)).toEqual([
      "2026-09-01",
      "2026-08-31",
    ]);
  });
});

describe("分片路径", () => {
  it("一天一个 jsonl", () => {
    expect(ledgerShardPath("/l", "2026-08-01")).toBe("/l/2026-08-01.jsonl");
  });
});

describe("序列化", () => {
  it("一行一条,可往返", () => {
    const e = entry();
    expect(parseShard(serializeEntry(e))).toEqual([e]);
  });
  it("忽略空行与坏行,不让一行脏数据毁掉整个分片", () => {
    const text = `${serializeEntry(entry())}\n\n{不是json\n${serializeEntry(entry({ id: "m2" }))}\n`;
    expect(parseShard(text).map((e) => e.id)).toEqual(["m1", "m2"]);
  });
});

describe("knownIdsFrom", () => {
  it("只有 uploaded 为真的才算已归档 —— 上传失败的必须允许重下", () => {
    const ids = knownIdsFrom([
      entry({ id: "ok", uploaded: true }),
      entry({ id: "pending", uploaded: false }),
    ]);
    expect(ids.has("ok")).toBe(true);
    expect(ids.has("pending")).toBe(false);
  });
});

describe("latestById", () => {
  it("同一 id 后写的胜出 —— 分片是 append-only,同一场会先写 false 再写 true", () => {
    const out = latestById([
      entry({ id: "m1", uploaded: false }),
      entry({ id: "m1", uploaded: true }),
      entry({ id: "m2", uploaded: false }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.id === "m1")!.uploaded).toBe(true);
    expect(out.find((e) => e.id === "m2")!.uploaded).toBe(false);
  });
  it("保持首次出现的顺序,便于 index 稳定", () => {
    const out = latestById([
      entry({ id: "a" }),
      entry({ id: "b" }),
      entry({ id: "a" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("toIndexLine", () => {
  it("导出给 Drive 的 index 不带本地状态字段", () => {
    const line = JSON.parse(toIndexLine(entry()));
    expect(line.uploaded).toBeUndefined();
    expect(line.id).toBe("m1");
    expect(line.team0MMR).toBe(2090);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- archiveLedger`
Expected: FAIL —— 找不到模块 `./archiveLedger`

- [ ] **Step 3: 实现**

创建 `packages/corpus-tools/src/archiveLedger.ts`:

```ts
/**
 * 归档账本:记录哪些场次已经**确认上传**到 Drive。
 *
 * 按天分片、只加载最近 LEDGER_WINDOW_DAYS 天:超过 feed 7 天窗口的比赛不可能
 * 再出现在扫描结果里,去重根本不需要查全部历史。这让内存里只有约 5.6 万条,
 * 而不是逐年累积的几百万条。
 *
 * 账本与上传到 Drive 的 index.jsonl 是同一份数据的两个视图 —— 账本是超集
 * (多一个 uploaded 状态),index 由 toIndexLine 导出。
 */

/** 账本加载窗口(天)。比 feed 的 ~7 天留 3 天余量。 */
export const LEDGER_WINDOW_DAYS = 10;

export interface LedgerEntry {
  id: string;
  dateKey: string;
  bracket: string;
  startTime: number;
  playerTeamRating: number;
  team0MMR: number;
  team1MMR: number;
  playerTeamId: string;
  winningTeamId: string;
  durationInSeconds: number;
  /** 场上全员 specId。日志正文里有,但存一份省得为查专精解压整个文件。 */
  specs: string[];
  /** 已归档文件的压缩字节数。 */
  bytes: number;
  /** 只有确认上传成功才为 true —— 记早了就是永久丢一场。 */
  uploaded: boolean;
}

export function ledgerShardPath(ledgerRoot: string, dateKey: string): string {
  return `${ledgerRoot}/${dateKey}.jsonl`;
}

/** 最近 days 天的 dateKey,含今天,新到旧。 */
export function recentDateKeys(todayMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function serializeEntry(e: LedgerEntry): string {
  return JSON.stringify(e);
}

/**
 * 解析一个分片。坏行跳过而不是抛错 —— 进程被 kill 时最后一行可能只写了一半,
 * 让一行残缺毁掉整天的去重信息,代价是那天全部重下。
 */
export function parseShard(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LedgerEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 已归档 id 集合。**只算 uploaded 为真的** —— 下载成功但上传失败的必须能重来。 */
export function knownIdsFrom(entries: LedgerEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.uploaded).map((e) => e.id));
}

/**
 * 同一 id 只保留最后一条(保持首次出现的顺序)。
 *
 * 分片是 append-only:同一场先写一条 uploaded:false(用于崩溃后认出遗留暂存),
 * 上传确认后再写一条 uploaded:true。不折叠的话 index 会出现重复行。
 */
export function latestById(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  const order: string[] = [];
  for (const e of entries) {
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  return order.map((id) => byId.get(id)!);
}

/** 导出给 Drive 的 index 行:去掉本地状态字段。 */
export function toIndexLine(e: LedgerEntry): string {
  const { uploaded: _uploaded, ...rest } = e;
  return JSON.stringify(rest);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- archiveLedger`
Expected: PASS(10 个用例)

- [ ] **Step 5: 提交**

```bash
git add packages/corpus-tools/src/archiveLedger.ts packages/corpus-tools/src/archiveLedger.test.ts
git commit -m "feat(corpus-tools): 按天分片的归档账本 —— 只加载最近 10 天,只认已上传"
```

---

### Task 4: `archiveUpload.ts` —— rclone 上传参数与结果判读

**Files:**

- Create: `packages/corpus-tools/src/archiveUpload.ts`
- Test: `packages/corpus-tools/src/archiveUpload.test.ts`

**Interfaces:**

- Consumes: 无(纯字符串处理)
- Produces:
  - `ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive"`
  - `interface ArchiveUploadConfig { stagingDir: string; remote: string; driveDest: string; dryRun: boolean }`
  - `buildArchiveUploadArgs(cfg: ArchiveUploadConfig): string[]`
  - `uploadSucceeded(exitCode: number, stderr: string): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/corpus-tools/src/archiveUpload.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REMOTE_ROOT,
  buildArchiveUploadArgs,
  uploadSucceeded,
} from "./archiveUpload";

const cfg = {
  stagingDir: "/s/2026-08-01",
  remote: "gdrive",
  driveDest: "2026/08/01",
  dryRun: false,
};

describe("buildArchiveUploadArgs", () => {
  it("copy 到 remote:根/YYYY/MM/DD", () => {
    const a = buildArchiveUploadArgs(cfg);
    expect(a[0]).toBe("copy");
    expect(a[1]).toBe("/s/2026-08-01");
    expect(a[2]).toBe(`gdrive:${ARCHIVE_REMOTE_ROOT}/2026/08/01`);
  });
  it("用 copy 而非 sync —— sync 会按本地删云端,而本地是传完即删的暂存", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("sync");
  });
  it("不加 --ignore-existing —— index.jsonl 每批都会变大,必须允许覆盖", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--ignore-existing");
  });
  it("dryRun 时带 --dry-run", () => {
    expect(buildArchiveUploadArgs({ ...cfg, dryRun: true })).toContain(
      "--dry-run",
    );
  });
  it("非 dryRun 时不带 --dry-run", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--dry-run");
  });
});

describe("uploadSucceeded", () => {
  it("退出码 0 且无致命错误 → 成功", () => {
    expect(uploadSucceeded(0, "Transferred: 12 / 12")).toBe(true);
  });
  it("非 0 退出码 → 失败", () => {
    expect(uploadSucceeded(1, "")).toBe(false);
  });
  it("退出码 0 但 stderr 报 ERROR → 失败(rclone 有时部分失败仍退 0)", () => {
    expect(uploadSucceeded(0, "ERROR : m1.txt.gz: Failed to copy")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- archiveUpload`
Expected: FAIL —— 找不到模块 `./archiveUpload`

- [ ] **Step 3: 实现**

创建 `packages/corpus-tools/src/archiveUpload.ts`:

```ts
/** Drive 上的归档根目录。 */
export const ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive";

export interface ArchiveUploadConfig {
  /** 本地某一天的暂存目录,如 /staging/2026-08-01 */
  stagingDir: string;
  /** rclone remote 名,如 gdrive */
  remote: string;
  /** Drive 上的相对目标,如 2026/08/01 */
  driveDest: string;
  dryRun: boolean;
}

/**
 * 用 `copy` 而不是 `sync`:暂存目录是传完即删的中转,`sync` 会按本地状态去删
 * 云端已归档的文件 —— 那是灾难性的。
 *
 * 也不加 `--ignore-existing`:index.jsonl 每批都会变大,必须允许覆盖
 * (与 driveSync.ts 同一条教训)。
 */
export function buildArchiveUploadArgs(cfg: ArchiveUploadConfig): string[] {
  return [
    "copy",
    cfg.stagingDir,
    `${cfg.remote}:${ARCHIVE_REMOTE_ROOT}/${cfg.driveDest}`,
    "--transfers",
    "4",
    "--checkers",
    "8",
    "--exclude",
    ".DS_Store",
    ...(cfg.dryRun ? ["--dry-run"] : []),
  ];
}

/**
 * 上传是否成功。除退出码外还要看 stderr:rclone 在部分文件失败时仍可能退 0,
 * 而我们**只在确认成功后才记账**,判宽了就是永久丢文件。
 */
export function uploadSucceeded(exitCode: number, stderr: string): boolean {
  if (exitCode !== 0) return false;
  return !/\bERROR\b/.test(stderr);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- archiveUpload`
Expected: PASS(8 个用例)

- [ ] **Step 5: 提交**

```bash
git add packages/corpus-tools/src/archiveUpload.ts packages/corpus-tools/src/archiveUpload.test.ts
git commit -m "feat(corpus-tools): 归档上传 rclone 参数与成功判据(copy 非 sync,退 0 也要查 ERROR)"
```

---

### Task 5: `runLock.ts` —— 防重入运行锁

**Files:**

- Create: `packages/corpus-tools/src/runLock.ts`
- Test: `packages/corpus-tools/src/runLock.test.ts`

**Interfaces:**

- Consumes: 无
- Produces:
  - `interface LockInfo { pid: number; startedAt: number }`
  - `parseLock(text: string): LockInfo | null`
  - `serializeLock(info: LockInfo): string`
  - `isLockStale(info: LockInfo | null, isAlive: (pid: number) => boolean): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/corpus-tools/src/runLock.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isLockStale,
  type LockInfo,
  parseLock,
  serializeLock,
} from "./runLock";

describe("锁文件序列化", () => {
  it("可往返", () => {
    const info: LockInfo = { pid: 4242, startedAt: 1_700_000_000_000 };
    expect(parseLock(serializeLock(info))).toEqual(info);
  });
  it("坏内容 → null(当作没有锁)", () => {
    expect(parseLock("")).toBeNull();
    expect(parseLock("垃圾")).toBeNull();
    expect(parseLock('{"pid":"不是数字"}')).toBeNull();
  });
});

describe("isLockStale", () => {
  it("没有锁 → 可以接管", () => {
    expect(isLockStale(null, () => true)).toBe(true);
  });
  it("持锁进程还活着 → 不可接管(必须退出,防重复下载)", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => true)).toBe(false);
  });
  it("持锁进程已消失 → 陈旧锁,可接管", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => false)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace=packages/corpus-tools -- runLock`
Expected: FAIL —— 找不到模块 `./runLock`

- [ ] **Step 3: 实现**

创建 `packages/corpus-tools/src/runLock.ts`:

```ts
/**
 * 运行锁。调度是每 6 小时一次,而首次全量跑约 22 小时 —— 不加锁会有多个实例
 * 同时扫同一段 feed、重复下载同一批文件,白白多花对方的流量。
 */

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export function serializeLock(info: LockInfo): string {
  return JSON.stringify(info);
}

export function parseLock(text: string): LockInfo | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.pid !== "number" || typeof o?.startedAt !== "number") {
      return null;
    }
    return { pid: o.pid, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/**
 * 能不能接管这把锁。
 *
 * 用「持锁 pid 是否还活着」而不是超时时间做判据:首次全量跑 22 小时,任何
 * 合理的超时都会误杀正常运行的实例。isAlive 由调用方注入(生产用
 * `process.kill(pid, 0)`),便于单测。
 */
export function isLockStale(
  info: LockInfo | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!info) return true;
  return !isAlive(info.pid);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace=packages/corpus-tools -- runLock`
Expected: PASS(5 个用例)

- [ ] **Step 5: 提交**

```bash
git add packages/corpus-tools/src/runLock.ts packages/corpus-tools/src/runLock.test.ts
git commit -m "feat(corpus-tools): 归档运行锁(按 pid 存活判陈旧,不用超时误杀 22 小时的首次全量)"
```

---

### Task 6: `scripts/archivePvpLogs.ts` —— 编排壳与真机冒烟

**Files:**

- Create: `packages/corpus-tools/scripts/archivePvpLogs.ts`
- Modify: `packages/corpus-tools/src/index.ts`(导出新模块)

**Interfaces:**

- Consumes: Task 1–5 全部产出 + `fetchDetailedStubs`、`dedupeByLogObject`、`shouldSleepBeforePage`、`shouldSleepBeforeDownload`、`checkRawPayloadBytes`、`checkDecompressedPayload`、`decodeRawPayload`、`downloadRaw`
- Produces: 可执行脚本,无导出

- [ ] **Step 1: 写编排壳**

创建 `packages/corpus-tools/scripts/archivePvpLogs.ts`:

```ts
// PvP log 长期归档:扫 feed → 下载原始 gzip 字节 → 传 Drive → 记账去重。
// 设计见 docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md
// 合规见 docs/DATA-COMPLIANCE.md
//
// 用法:npx tsx scripts/archivePvpLogs.ts
// 环境变量:ARCHIVE_ROOT / RCLONE_REMOTE / DOWNLOAD_SLEEP_MS / MAX_PAGES / DRY_RUN
import { spawnSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { statfsSync } from "fs";

import {
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
} from "../src/archivePlan";
import {
  knownIdsFrom,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "../src/archiveLedger";
import { buildArchiveUploadArgs, uploadSucceeded } from "../src/archiveUpload";
import {
  decodeRawPayload,
  downloadRaw,
  fetchDetailedStubs,
} from "../src/feedClient";
// 同一模块只 import 一次(eslint no-duplicate-imports)
import {
  checkDecompressedPayload,
  checkRawPayloadBytes,
  dedupeByLogObject,
  KNOWN_BRACKETS,
  shouldSleepBeforeDownload,
  shouldSleepBeforePage,
} from "../src/pvpLogFetch";
import { isLockStale, parseLock, serializeLock } from "../src/runLock";

const ARCHIVE_ROOT =
  process.env.ARCHIVE_ROOT ??
  path.join(os.homedir(), "code/gladlog-eval-private/archive");
const RCLONE_REMOTE = process.env.RCLONE_REMOTE ?? "gdrive";
const DOWNLOAD_SLEEP_MS = Number(process.env.DOWNLOAD_SLEEP_MS ?? 2000);
const PAGE_SLEEP_MS = 500;
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 2000);
const DRY_RUN = process.env.DRY_RUN === "1";
/** 剩余空间低于此值即停止本次运行,别撑爆系统盘。 */
const MIN_FREE_BYTES = 20 * 1024 ** 3;

const STAGING = path.join(ARCHIVE_ROOT, "staging");
const LEDGER = path.join(ARCHIVE_ROOT, "ledger");
const LOCK = path.join(ARCHIVE_ROOT, ".lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function acquireLock(): boolean {
  fs.ensureDirSync(ARCHIVE_ROOT);
  const existing = fs.existsSync(LOCK)
    ? parseLock(fs.readFileSync(LOCK, "utf8"))
    : null;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM = 进程存在但我们没权限给它发信号 —— 那是**活着**。
      // 只有 ESRCH(查无此进程)才算死。统一 catch 成「未存活」会把活进程
      // 误判为陈旧锁并接管,后果是两个实例并发扫同一段 feed、重复下载,
      // 白花上游志愿者项目的流量 —— 正是这把锁要防的事。
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };
  if (!isLockStale(existing, alive)) return false;
  // 原子写(先写临时文件再 rename):直接写 LOCK 时若进程在写一半时被 kill,
  // 留下的半截 JSON 会被 parseLock 判成 null,而 null 与「压根没有锁」同义 ——
  // 下一个实例会认为无锁而接管,与真进程并发。rename 在同一文件系统上是原子的,
  // 读到的要么是完整旧内容要么是完整新内容。
  const tmp = `${LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    serializeLock({ pid: process.pid, startedAt: Date.now() }),
  );
  fs.renameSync(tmp, LOCK);
  return true;
}

/** 冲刷某一天的暂存:上传 → 成功则记账并删本地。 */
function flushDay(dateKey: string, pending: LedgerEntry[]): number {
  const dir = path.join(STAGING, dateKey);
  if (!fs.existsSync(dir)) return 0;
  // index.jsonl 与 .txt.gz 一起传:它是这批的元数据,单独传会出现两者不同步。
  const shard = ledgerShardPath(LEDGER, dateKey);
  const prior = fs.existsSync(shard)
    ? parseShard(fs.readFileSync(shard, "utf8"))
    : [];
  // latestById 折叠同 id 的多条(分片是 append-only:同一场先写 false 再写 true),
  // 否则 index 会出现重复行。
  const all = latestById([
    ...prior,
    ...pending.map((e) => ({ ...e, uploaded: true })),
  ]).filter((e) => e.uploaded);
  fs.writeFileSync(
    path.join(dir, "index.jsonl"),
    all.map(toIndexLine).join("\n") + "\n",
  );

  const args = buildArchiveUploadArgs({
    stagingDir: dir,
    remote: RCLONE_REMOTE,
    driveDest: driveDestFor(dateKey),
    dryRun: DRY_RUN,
  });
  const r = spawnSync("rclone", args, { encoding: "utf8" });
  if (!uploadSucceeded(r.status ?? 1, r.stderr ?? "")) {
    console.error(
      `  上传失败(${dateKey}),保留暂存待下次重试:${r.stderr?.slice(0, 300)}`,
    );
    return 0;
  }
  // 确认成功之后才记账 —— 记早了就是永久丢一场
  fs.ensureDirSync(LEDGER);
  fs.appendFileSync(
    shard,
    pending.map((e) => serializeEntry({ ...e, uploaded: true })).join("\n") +
      (pending.length ? "\n" : ""),
  );
  if (!DRY_RUN) {
    for (const e of pending)
      fs.removeSync(stagingPathFor(STAGING, dateKey, e.id));
  }
  return pending.length;
}

async function main() {
  if (!acquireLock()) {
    console.log("已有归档进程在跑,本次退出");
    return;
  }
  fs.ensureDirSync(STAGING);
  fs.ensureDirSync(LEDGER);

  // 先冲刷上次遗留的暂存,再扫 feed —— 否则「下载成功、上传失败」的场次
  // 因未进账本会被重新下载,白白再花对方一次流量。
  for (const d of fs.readdirSync(STAGING)) {
    const files = fs
      .readdirSync(path.join(STAGING, d))
      .filter((f) => f.endsWith(".txt.gz"));
    if (files.length === 0) continue;
    console.log(`冲刷遗留暂存 ${d}:${files.length} 场`);
    const shard = ledgerShardPath(LEDGER, d);
    const prior = fs.existsSync(shard)
      ? parseShard(fs.readFileSync(shard, "utf8"))
      : [];
    const byId = new Map(latestById(prior).map((e) => [e.id, e]));
    const pending = files
      .map((f) => byId.get(f.replace(/\.txt\.gz$/, "")))
      .filter((e): e is LedgerEntry => !!e && !e.uploaded);
    flushDay(d, pending);
  }

  const known = new Set<string>();
  for (const k of recentDateKeys(Date.now(), LEDGER_WINDOW_DAYS)) {
    const p = ledgerShardPath(LEDGER, k);
    if (fs.existsSync(p)) {
      for (const id of knownIdsFrom(parseShard(fs.readFileSync(p, "utf8")))) {
        known.add(id);
      }
    }
  }
  console.log(`账本已知 ${known.size} 场(最近 ${LEDGER_WINDOW_DAYS} 天)`);

  let fresh = 0;
  let downloads = 0;
  for (const bracket of KNOWN_BRACKETS) {
    let consecutiveKnown = 0;
    const batch = new Map<string, LedgerEntry[]>();
    let state = { count: 0, bytes: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      if (freeBytes(ARCHIVE_ROOT) < MIN_FREE_BYTES) {
        console.error("磁盘剩余空间不足 20GB,停止本次运行");
        break;
      }
      if (shouldSleepBeforePage(page)) await sleep(PAGE_SLEEP_MS);
      const { stubs } = await fetchDetailedStubs({
        bracket,
        offset: page * 50,
        count: 50,
      });
      if (stubs.length === 0) break;
      for (const stub of dedupeByLogObject(stubs)) {
        if (!shouldArchive(stub, known)) {
          if (known.has(stub.id)) consecutiveKnown++;
          continue;
        }
        consecutiveKnown = 0;
        if (shouldSleepBeforeDownload(downloads))
          await sleep(DOWNLOAD_SLEEP_MS);
        downloads++;
        const raw = await downloadRaw(stub.logObjectUrl, `archive ${stub.id}`);
        const byteCheck = checkRawPayloadBytes(
          raw.bytes.length,
          raw.expectedBytes,
        );
        if (!byteCheck.ok) {
          console.warn(`  skip ${stub.id}: ${byteCheck.reason}`);
          continue;
        }
        const textCheck = checkDecompressedPayload(decodeRawPayload(raw));
        if (!textCheck.ok) {
          console.warn(`  skip ${stub.id}: ${textCheck.reason}`);
          continue;
        }
        const dateKey = matchDateKey(stub.startTime);
        const p = stagingPathFor(STAGING, dateKey, stub.id);
        fs.ensureDirSync(path.dirname(p));
        fs.writeFileSync(p, raw.bytes);
        const entry: LedgerEntry = {
          id: stub.id,
          dateKey,
          bracket: stub.bracket || bracket,
          startTime: stub.startTime,
          playerTeamRating: stub.playerTeamRating,
          team0MMR: stub.team0MMR,
          team1MMR: stub.team1MMR,
          playerTeamId: stub.playerTeamId,
          winningTeamId: stub.winningTeamId,
          durationInSeconds: stub.durationInSeconds,
          specs: stub.units.filter((u) => u.info).map((u) => u.spec),
          bytes: raw.bytes.length,
          uploaded: false,
        };
        // 先落一条 uploaded:false 的账 —— 进程崩了下次靠它认出遗留暂存
        fs.appendFileSync(
          ledgerShardPath(LEDGER, dateKey),
          serializeEntry(entry) + "\n",
        );
        batch.set(dateKey, [...(batch.get(dateKey) ?? []), entry]);
        state = {
          count: state.count + 1,
          bytes: state.bytes + raw.bytes.length,
        };
        if (shouldFlushBatch(state)) {
          for (const [d, es] of batch) fresh += flushDay(d, es);
          batch.clear();
          state = { count: 0, bytes: 0 };
        }
      }
      if (shouldStopScanning(consecutiveKnown)) {
        console.log(
          `${bracket}: 连续 ${consecutiveKnown} 场已知,追上,停止翻页`,
        );
        break;
      }
      if (stubs.length < 50) break;
    }
    for (const [d, es] of batch) fresh += flushDay(d, es);
  }

  console.log(`done: 新归档 ${fresh} 场,下载尝试 ${downloads} 次`);
  if (fresh === 0) {
    // 正常每次都该有上千场。0 说明 feed 挂了或查询失效(如对方改 schema),
    // 而这种故障静默持续一周就是永久丢一周数据。
    console.error("警告:本次新增 0 场 —— 检查 feed 是否可用或 schema 是否变更");
  }
  fs.removeSync(LOCK);
}

main().catch((e) => {
  fs.removeSync(LOCK);
  console.error("archivePvpLogs failed:", e);
  process.exit(1);
});
```

- [ ] **Step 2: 导出新模块**

在 `packages/corpus-tools/src/index.ts` 末尾追加:

```ts
export * from "./archivePlan";
export * from "./archiveLedger";
export * from "./archiveUpload";
export * from "./runLock";
```

- [ ] **Step 3: typecheck + 全量单测**

Run: `npm run typecheck && npm test --workspace=packages/corpus-tools`
Expected: 均通过

- [ ] **Step 4: DRY_RUN 冒烟(不真传)**

Run:

```bash
cd packages/corpus-tools
ARCHIVE_ROOT=/tmp/pvp-archive-smoke DRY_RUN=1 MAX_PAGES=1 npx tsx scripts/archivePvpLogs.ts
```

Expected: 打印「账本已知 0 场」、若干下载行、`done: 新归档 N 场`(N>0)。
检查 `/tmp/pvp-archive-smoke/staging/<日期>/` 下有 `.txt.gz` 与 `index.jsonl`;
`file` 确认是 gzip:`file /tmp/pvp-archive-smoke/staging/*/*.txt.gz` 应显示 `gzip compressed data`。
DRY_RUN 下文件**不会**被删(因为没真传),这是预期。

- [ ] **Step 5: 真机冒烟(真传一次)**

前置:`rclone listremotes` 里要有 `gdrive:`。若没有,跳过本步并在提交信息里注明未验证。

Run:

```bash
cd packages/corpus-tools
ARCHIVE_ROOT=/tmp/pvp-archive-real MAX_PAGES=1 npx tsx scripts/archivePvpLogs.ts
```

Expected: `done: 新归档 N 场`;`rclone ls gdrive:gladlog-pvp-archive` 能看到文件;
`/tmp/pvp-archive-real/staging/` 下的 `.txt.gz` 已被删除(上传确认后删本地);
`/tmp/pvp-archive-real/ledger/<日期>.jsonl` 里对应条目 `"uploaded":true`。

再跑**第二次**同一命令验证去重。

**判据不是「0 新增」** —— feed 是活的,约 5,570 场/天(≈4 场/分钟),两次运行间隔
几分钟就会有真的新场次进来,要求 0 新增是不可能达成的目标。正确判据是
**已归档的场次一个都不许重下**,从账本直接验:

```bash
python3 - <<'EOF'
import json,glob,collections
up=collections.Counter()
for f in glob.glob("/tmp/pvp-archive-real/ledger/*.jsonl"):
    for line in open(f,encoding="utf-8"):
        line=line.strip()
        if not line: continue
        try: e=json.loads(line)
        except: continue
        if e.get("uploaded"): up[e["id"]]+=1
dup=[k for k,v in up.items() if v>1]
print("唯一 id:",len(up)," 重复 uploaded:true 的 id 数:",len(dup))
EOF
```

Expected: 重复数为 **0**。同一 id 出现两次 `uploaded:true` 就意味着第二次跑重下了
已归档的场次 = 去重失效。

清理:`rm -rf /tmp/pvp-archive-smoke /tmp/pvp-archive-real`,并
`rclone purge gdrive:gladlog-pvp-archive` 清掉冒烟数据(正式跑之前)。

- [ ] **Step 6: 提交**

```bash
git add packages/corpus-tools/scripts/archivePvpLogs.ts packages/corpus-tools/src/index.ts
git commit -m "feat(corpus-tools): PvP log 归档编排壳 —— 扫 feed/存压缩字节/传 Drive/记账去重

真机冒烟:首次 N 场入库并确认 Drive 上可见、本地暂存已删、账本 uploaded:true;
紧接着第二次同命令 done: 新归档 0 场、下载尝试 0 —— 去重生效。"
```

---

### Task 7: launchd 定时 + 文档

**Files:**

- Create: `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`
- Create: `docs/pvp-log-archive.md`(**英文,正名**)
- Create: `docs/pvp-log-archive.zh-CN.md`(中文版,内容等价)
- Modify: `packages/corpus-tools/README.md`(只加一段指向上面那对文档的链接)
- Modify: `docs/BACKLOG.md`(#19 标注第一步已落地)
- Modify: `CLAUDE.md`(把新文档登记进「文档双语成对」清单)

**Interfaces:**

- Consumes: `scripts/archivePvpLogs.ts`(Task 6)
- Produces: 无代码接口

- [ ] **Step 1: 写 plist**

创建 `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`(其中 `<仓库路径>`
安装时替换成本机绝对路径,是 XML 里唯一的占位符):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.gladlog.pvp-archive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd &lt;仓库路径&gt;/packages/corpus-tools &amp;&amp; npx tsx scripts/archivePvpLogs.ts</string>
  </array>
  <!-- 每 6 小时一次。用 launchd 而非 cron:合盖错过的任务,launchd 会在唤醒后补跑。 -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/gladlog-pvp-archive.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/gladlog-pvp-archive.err</string>
</dict>
</plist>
```

- [ ] **Step 2: 写双语文档对**

本仓的「文档双语成对」规则(见 `CLAUDE.md`):**英文是正名、中文带 `.zh-CN` 后缀**,
两版内容必须等价;每篇 H1 正下方一行语言条(当前语言加粗不带链接,另一语言是链接);
互链同语言闭环。照 `docs/FAQ.md` / `docs/FAQ.zh-CN.md` 的现成写法。

创建 `docs/pvp-log-archive.md`,H1 下第一行是 `**English** · [中文](pvp-log-archive.zh-CN.md)`,
内容涵盖:这是什么(每 6 小时扫 wowarenalogs feed,把新出现的公开对局以**原始 gzip
字节**下载并上传到 Google Drive 按天分目录归档)、怎么跑、环境变量表、为什么存压缩
(GCS 侧本就是 gzip 存储,原样落盘比解压后存省 11.4x 实测,5TB Drive 因此从约 27 周
变成约 6 年)、怎么装成定时任务、以及运维注意事项。指向 `docs/DATA-COMPLIANCE.md`
说明合规依据,指向 `docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md` 说明设计。

环境变量表必须包含这五项,取值与 `scripts/archivePvpLogs.ts` 里的默认值逐字一致:

| 变量                | 默认                                      | 说明                                     |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| `ARCHIVE_ROOT`      | `$HOME/code/gladlog-eval-private/archive` | 暂存与账本根目录                         |
| `RCLONE_REMOTE`     | `gdrive`                                  | rclone remote 名                         |
| `DOWNLOAD_SLEEP_MS` | `2000`                                    | 下载间隔,**别调成 0**(上游是志愿者项目)  |
| `MAX_PAGES`         | `2000`                                    | 每 bracket 翻页上限                      |
| `DRY_RUN`           | 空                                        | `1` = rclone 带 `--dry-run`,本地暂存不删 |

两条运维注意必须写进去:

1. **新增 0 场要当故障看** —— 正常每次都该有上千场,0 说明 feed 挂了或查询失效
   (如上游改 schema),静默一周就是永久丢一周数据(feed 窗口仅 ~7 天)。
2. **启用时机由使用者决定** —— plist 只是放进仓库,**不会**自动装载。当前计划是
   2026-08 下旬新赛季开始时再启用:基线本就该反映当前赛季的 meta,赛季初开始攒是
   干净的起点。装载命令写清楚(拷到 `~/Library/LaunchAgents/` 后 `launchctl load`)。

然后创建 `docs/pvp-log-archive.zh-CN.md`,H1 下第一行是
`[English](pvp-log-archive.md) · **中文**`,内容与英文版等价(不是逐字直译,但每个
小节、每个表格行、两条运维注意都要有对应)。

最后在 `packages/corpus-tools/README.md` 末尾追加一小节(该 README 是中文的,
所以这段用中文),只做指路,不重复内容:

```markdown
## PvP log 长期归档(archivePvpLogs)

每 6 小时扫一次 feed,把新出现的公开对局以原始 gzip 字节下载并归档到 Google Drive。
用法、环境变量、运维注意见 [PvP log 归档](../../docs/pvp-log-archive.zh-CN.md)
([English](../../docs/pvp-log-archive.md));设计见
`docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`,合规见
`docs/DATA-COMPLIANCE.md`。
```

- [ ] **Step 3: BACKLOG 标注**

在 `docs/BACKLOG.md` 的 `## 19.` 标题行末尾加上 ` —— 第一步(采集归档)已落地 2026-08-01`,
并在该节「可能形态」的第 1 条「轮询归档器」后加一行:

```markdown
**✅ 已实现**(`scripts/archivePvpLogs.ts`,设计见
`docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`)。范围收敛为
只采集不加工;配额矩阵按用户拍板取消,改为全量收(一场 6 人 = 6 个专精观测,
按专精筛反而更费对方 Firestore 且砍掉 5/6 样本)。
```

- [ ] **Step 3b: 把新文档登记进 CLAUDE.md 的双语清单**

`CLAUDE.md` 的「文档双语成对(bilingual docs rule)」一节现在列的是 9 篇。把
`docs/pvp-log-archive.md` 加进去,并把开头的「以下 9 篇文档」改成「以下 10 篇文档」。
不加登记的话,下次有人改其中一版不会想到要同步另一版。

- [ ] **Step 4: 验证文档无坏链**

Run: `npx prettier --check docs/pvp-log-archive.md docs/pvp-log-archive.zh-CN.md packages/corpus-tools/README.md docs/BACKLOG.md CLAUDE.md`
Expected: 通过(不通过则 `npx prettier --write` 后重跑)

- [ ] **Step 5: 提交**

```bash
git add packages/corpus-tools/ops/app.gladlog.pvp-archive.plist docs/pvp-log-archive.md docs/pvp-log-archive.zh-CN.md packages/corpus-tools/README.md docs/BACKLOG.md CLAUDE.md
git commit -m "docs: PvP log 归档器双语文档 + launchd plist + BACKLOG #19 第一步标注"
```

---

## 完成判据

全部 task 做完后应满足:

1. `npm test --workspace=packages/corpus-tools` 与 `npm run typecheck` 全绿
2. `BRACKET=3v3 LIMIT=2 npx tsx scripts/fetchPvpLogs.ts` 能真下到 2 场(Task 1 修的 bug 的前后数字)
3. `npx tsx scripts/archivePvpLogs.ts` 跑两次:第一次有新增,第二次 0 新增 0 下载
4. Drive 上 `gladlog-pvp-archive/YYYY/MM/DD/` 有 `.txt.gz` 与 `index.jsonl`
5. 本地 `archive/staging/` 在上传确认后为空,`archive/ledger/*.jsonl` 有 `"uploaded":true` 条目
