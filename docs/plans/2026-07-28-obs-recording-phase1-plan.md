# OBS 录像集成一期(外控 obs-websocket)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对局自动起录/停录(外控用户自装的 OBS)、录像↔对局按时间窗关联、ReplayView 内与回放时钟同步的视频回放。

**Architecture:** 路线 C 一期(评估见 `docs/plans/2026-07-27-obs-recording-integration-eval.md`)。parser 新增 segmentOpen/segmentClose 生命周期事件 → worker 转发 → main 的 recorderService 经 obs-websocket 起停 OBS 录制,录像索引存独立 `recordings/recordings.ndjson`(时间窗关联 matchId),`vod://` 特权协议供片,renderer 的 VideoDock 做回放时钟 `t` 的从动件——10+ 处既有 seek 入口零改动生效。采集端抽象为「时间窗+锚点」数据契约,二期换内嵌引擎时播放/关联层不动。

**Tech Stack:** TypeScript monorepo;`obs-websocket-js@^5`(OBS 28+ 内置 websocket v5);Electron `protocol.handle`;vitest。

## Global Constraints

- 分支:全部工作在 `feature/obs-recording`,不动 main。
- 一期明确不做:内嵌录制引擎、视频裁剪/转码、缺头补偿(视频从开场检测时刻起,缺头几秒~几十秒是接受的)、macOS 录像、跨机视频搬运。
- 录像失败/OBS 未开**只降级不上抛**——绝不影响解析入库与分析主链路。
- 视频文件与索引**绝不放** `<userData>/matches/<id>/` 内(matchStore 自愈路径 `rmSync` 整目录,`matchStore.ts:443`)。
- renderer/preload 从 `src/main/*` 只能 `import type`;跨界常量放 `src/shared/`(v0.0.4 构建事故)。
- 回放时钟 `t` 保持 ReplayView 局部,video 做从动件,不提升 state。
- push 前:`npm run presubmit`(全 workspace,别手敲三件套);本机绝不跑 `test:visual`。
- 复合命令不 `cd`;门禁链不加管道(退出码会被吞)。
- 新依赖 `obs-websocket-js` 必须进 `packages/desktop` 的 `dependencies`(externalizeDepsPlugin 外部化 → 打包靠生产 node_modules)。

---

### Task 1: parser 生命周期事件 segmentOpen / segmentClose

**Files:**

- Modify: `packages/parser/src/l2/segmenter.ts`
- Modify: `packages/parser/src/api.ts`
- Test: `packages/parser/test/l2.lifecycleEvents.test.ts`

**Interfaces:**

- Produces:`SegmentOpenInfo { bracket: string; zoneId: string; isRated: boolean; startTime: number }`、`SegmentCloseInfo { endTime: number | null; aborted: boolean }`(均 export);`GladLogParser.on("segmentOpen"|"segmentClose", cb)`。语义:**仅 IDLE→open 翻转发 open**(shuffle 整 lobby 一次;DOUBLE_START 换段不重发)、**仅 open→IDLE 翻转发 close**(`end()` 异常闭合 → `{endTime: null, aborted: true}`)。时间为该行 epoch ms(`line.timestamp`)。

- [ ] **Step 1: 写失败测试**(模仿 `test/l2.openSegment.test.ts` 的 `line()`/`CAST` 辅助):

```ts
import { GladLogParser } from "../src/api";

function line(i: number, s: string): string {
  return `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}`;
}
const CAST =
  'SPELL_CAST_SUCCESS,Player-1-A,"Alice-X",0x512,0x80000000,0000000000000000,nil,0x80000000,0x80000000,2983,"Sprint",0x1,Player-1-A,0000000000000000,100,100,0,0,0,0,0,0,3,10,10,0,1.00,-1.00,0,1.0,70';

function collect(p: GladLogParser) {
  const opens: unknown[] = [];
  const closes: unknown[] = [];
  p.on("segmentOpen", (i) => opens.push(i));
  p.on("segmentClose", (i) => closes.push(i));
  return { opens, closes };
}

describe("segment lifecycle events", () => {
  it("match:START 发 open(带 bracket/时间),END 发 close", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens, closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ bracket: "3v3", zoneId: "1825" });
    expect(typeof (opens[0] as { startTime: number }).startTime).toBe("number");
    expect(closes).toHaveLength(0);
    p.push(line(1, CAST));
    p.push(line(2, "ARENA_MATCH_END,1,30,1500,1501"));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ aborted: false });
    expect((closes[0] as { endTime: number }).endTime).toBeGreaterThan(
      (opens[0] as { startTime: number }).startTime,
    );
  });

  it("shuffle:整个 lobby 只 open/close 各一次", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens, closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0"));
    p.push(line(1, CAST));
    p.push(line(2, "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0"));
    p.push(line(3, CAST));
    p.push(line(4, "ARENA_MATCH_END,1,30,1500,1501"));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it("end() 异常闭合 → aborted close;IDLE 时 end() 不发", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.end();
    expect(closes).toEqual([{ endTime: null, aborted: true }]);
    const q = new GladLogParser({ timezone: "UTC" });
    const c2 = collect(q);
    q.end();
    expect(c2.closes).toHaveLength(0);
  });

  it("DOUBLE_START 不重复发 open", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.push(line(1, "ARENA_MATCH_START,1825,41,3v3,1"));
    expect(opens).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/parser/test/l2.lifecycleEvents.test.ts`
Expected: FAIL(`on("segmentOpen")` 类型/事件不存在)

- [ ] **Step 3: 实现 segmenter 回调**

`segmenter.ts`:文件顶部加两个 export interface(见 Interfaces);类内加:

```ts
private openCallback?: (info: SegmentOpenInfo) => void;
private closeCallback?: (info: SegmentCloseInfo) => void;

public onOpen(cb: (info: SegmentOpenInfo) => void): void {
  this.openCallback = cb;
}
public onClose(cb: (info: SegmentCloseInfo) => void): void {
  this.closeCallback = cb;
}
```

触发点(**只在状态真翻转处**):

1. `push()` 的 `ARENA_MATCH_START` 分支里,`if (this.state === "IDLE")` 的两个子分支(shuffle/match)在设置 `currentSegment` 之后各加:

```ts
this.openCallback?.({
  bracket: line.arenaStart?.bracket ?? "",
  zoneId: line.arenaStart?.zoneId ?? "",
  isRated: line.arenaStart?.isRated ?? false,
  startTime: line.timestamp,
});
```

(DOUBLE_START 与 shuffle 轮推进分支**不加**。) 2. `ARENA_MATCH_END` 的 `IN_MATCH` 与 `IN_SHUFFLE` 两个分支,在 `this.state = "IDLE"` 之后各加:

```ts
this.closeCallback?.({ endTime: line.timestamp, aborted: false });
```

3. `end()` 里 `if (this.state !== "IDLE")` 块末尾加:

```ts
this.closeCallback?.({ endTime: null, aborted: true });
```

`api.ts`:EventMap 加 `segmentOpen: (info: SegmentOpenInfo) => void; segmentClose: (info: SegmentCloseInfo) => void;`(从 `./l2/segmenter` import type 并 re-export);构造函数里:

```ts
this.segmenter.onOpen((info) => this.emit("segmentOpen", info));
this.segmenter.onClose((info) => this.emit("segmentClose", info));
```

注意 `line.timestamp` 字段名以 `l1/types.ts` 的 `ParsedLine` 为准(compose.ts:72 用 `seg.startLine.timestamp`,同字段)。若 parser 包有 `src/index.ts` 桶文件,把两个 Info 类型加进导出。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/parser/test/l2.lifecycleEvents.test.ts && npx vitest run packages/parser/test/l2.openSegment.test.ts packages/parser/test/l2.segmenter.synthetic.test.ts`
Expected: 全 PASS(既有 segmenter 测试不回归)

- [ ] **Step 5: Commit**

```bash
git add packages/parser/src/l2/segmenter.ts packages/parser/src/api.ts packages/parser/test/l2.lifecycleEvents.test.ts
git commit -m "feat(parser): segmentOpen/segmentClose 生命周期事件(OBS 录像触发用)"
```

---

### Task 2: worker → main 转发(含轮转异常闭合)

**Files:**

- Modify: `packages/desktop/src/shared/protocol.ts`
- Modify: `packages/desktop/src/worker/pipeline.ts`
- Test: `packages/desktop/src/worker/pipeline.lifecycle.test.ts`

**Interfaces:**

- Consumes:Task 1 的 `segmentOpen`/`segmentClose` 事件。
- Produces:`WorkerToMain` 新成员
  `{ type: "segmentOpen"; fileKey: string; bracket: string; zoneId: string; isRated: boolean; startTime: number }`、
  `{ type: "segmentClose"; fileKey: string; endTime: number | null; aborted: boolean }`。
  轮转(`r.rotated`)时若旧 parser 有 open 段,先发合成 `segmentClose {endTime: null, aborted: true}` 再重建 parser。

- [ ] **Step 1: 写失败测试**(pipeline 用真 parser + 临时文件;模式:写文件 → `processFlush()` → 断言 emit 收到的消息):

```ts
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { FilePipeline } from "./pipeline";
import type { WorkerToMain } from "../shared/protocol";

function line(i: number, s: string): string {
  return `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}\n`;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-pipeline-"));
  const file = join(dir, "WoWCombatLog.txt");
  writeFileSync(file, "");
  const msgs: WorkerToMain[] = [];
  const p = new FilePipeline({
    fileKey: "WoWCombatLog.txt",
    filePath: file,
    checkpoint: null,
    emit: (m) => msgs.push(m),
  });
  return { file, msgs, p };
}

describe("pipeline lifecycle forwarding", () => {
  it("START → segmentOpen;END → segmentClose(带 fileKey)", () => {
    const { file, msgs, p } = setup();
    appendFileSync(file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.processFlush();
    const open = msgs.find((m) => m.type === "segmentOpen");
    expect(open).toMatchObject({ fileKey: "WoWCombatLog.txt", bracket: "3v3" });
    appendFileSync(file, line(1, "ARENA_MATCH_END,1,30,1500,1501"));
    p.processFlush();
    const close = msgs.find((m) => m.type === "segmentClose");
    expect(close).toMatchObject({ aborted: false });
  });

  it("对局中文件轮转 → 合成 aborted close", () => {
    const { file, msgs, p } = setup();
    appendFileSync(file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.processFlush();
    // 轮转:整文件被替换(首行 checksum 变)
    writeFileSync(file, line(0, "ARENA_MATCH_START,1504,40,2v2,1"));
    p.processFlush();
    const closes = msgs.filter((m) => m.type === "segmentClose");
    expect(closes).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);
    // 新 parser 的新对局照常 open
    expect(msgs.filter((m) => m.type === "segmentOpen")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/worker/pipeline.lifecycle.test.ts`
Expected: FAIL(类型无 segmentOpen 成员 / 无消息)

- [ ] **Step 3: 实现**

`protocol.ts` 的 `WorkerToMain` union 加两个成员(见 Interfaces)。

`pipeline.ts`:

1. `ParserLike.on` 的事件名联合扩为 `"match" | "shuffle" | "diagnostic" | "segmentOpen" | "segmentClose"`。
2. `createParser()` 里加订阅:

```ts
this.parser.on("segmentOpen", (payload) => {
  const i = payload as {
    bracket: string;
    zoneId: string;
    isRated: boolean;
    startTime: number;
  };
  this.emit({ type: "segmentOpen", fileKey: this.fileKey, ...i });
});
this.parser.on("segmentClose", (payload) => {
  const i = payload as { endTime: number | null; aborted: boolean };
  this.emit({ type: "segmentClose", fileKey: this.fileKey, ...i });
});
```

3. `processFlush()` 的轮转分支改为(**先合成 close 再重建**):

```ts
if (r.rotated) {
  if (this.parser.hasOpenSegment()) {
    this.emit({
      type: "segmentClose",
      fileKey: this.fileKey,
      endTime: null,
      aborted: true,
    });
  }
  this.createParser();
  this.cp = { offset: 0, firstLineChecksum: r.state.firstLineChecksum };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/desktop/src/worker/pipeline.lifecycle.test.ts && npm test --workspace=packages/desktop`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/protocol.ts packages/desktop/src/worker/pipeline.ts packages/desktop/src/worker/pipeline.lifecycle.test.ts
git commit -m "feat(desktop): worker 转发对局生命周期事件(轮转合成 aborted close)"
```

---

### Task 3: RecordingsStore(独立索引 + 时间窗关联 + 保留策略)

**Files:**

- Create: `packages/desktop/src/main/recordingsStore.ts`
- Test: `packages/desktop/src/main/recordingsStore.test.ts`

**Interfaces:**

- Produces:

```ts
export interface RecordingEntry {
  videoPath: string;
  startedAt: number; // StartRecord 墙钟 epoch ms —— 播放锚点
  stoppedAt: number;
  matchId: string | null;
}
export class RecordingsStore {
  constructor(dir: string); // <userData>/recordings
  list(): RecordingEntry[];
  add(entry: RecordingEntry): void;
  associate(meta: {
    id: string;
    startTime: number;
    endTime: number;
  }): RecordingEntry | null;
  getForMatch(matchId: string): RecordingEntry | null;
  prune(keepCount: number): { deleted: number };
}
```

- 关联判据(**一处定义,recorder 只调用**):录像窗 `[startedAt, stoppedAt]` 与对局窗 `[startTime - TOL, endTime + TOL]` 重叠(`TOLERANCE_MS = 60_000` export)且 `matchId === null`。录像起点晚于开场是常态(日志滞后),重叠而非包含。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RecordingsStore } from "./recordingsStore";

const T0 = 1_750_000_000_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-rec-"));
  return { dir, store: new RecordingsStore(dir) };
}
function fakeVideo(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "x");
  return p;
}

describe("RecordingsStore", () => {
  it("add + list 持久化(重开实例仍在)", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    store.add({
      videoPath: v,
      startedAt: T0,
      stoppedAt: T0 + 300_000,
      matchId: null,
    });
    expect(new RecordingsStore(dir).list()).toHaveLength(1);
  });

  it("associate:重叠即命中(录像起点晚于开场),写回 matchId", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    // 开场 T0,录像 T0+8s 起(日志滞后)
    store.add({
      videoPath: v,
      startedAt: T0 + 8_000,
      stoppedAt: T0 + 300_000,
      matchId: null,
    });
    const hit = store.associate({
      id: "m1",
      startTime: T0,
      endTime: T0 + 290_000,
    });
    expect(hit?.matchId).toBe("m1");
    expect(store.getForMatch("m1")?.videoPath).toBe(v);
    expect(new RecordingsStore(dir).getForMatch("m1")).not.toBeNull(); // 落盘
  });

  it("associate:窗口不沾边 → null;已关联的不再被抢", () => {
    const { dir, store } = setup();
    store.add({
      videoPath: fakeVideo(dir, "a.mp4"),
      startedAt: T0,
      stoppedAt: T0 + 60_000,
      matchId: null,
    });
    expect(
      store.associate({
        id: "far",
        startTime: T0 + 10_000_000,
        endTime: T0 + 10_060_000,
      }),
    ).toBeNull();
    store.associate({ id: "m1", startTime: T0, endTime: T0 + 50_000 });
    expect(
      store.associate({ id: "m2", startTime: T0, endTime: T0 + 50_000 }),
    ).toBeNull();
  });

  it("prune:按 startedAt 降序保留 N,其余删文件+删行;0 = 不删", () => {
    const { dir, store } = setup();
    const old = fakeVideo(dir, "old.mp4");
    const neu = fakeVideo(dir, "new.mp4");
    store.add({
      videoPath: old,
      startedAt: T0,
      stoppedAt: T0 + 1,
      matchId: null,
    });
    store.add({
      videoPath: neu,
      startedAt: T0 + 10_000,
      stoppedAt: T0 + 10_001,
      matchId: null,
    });
    expect(store.prune(0)).toEqual({ deleted: 0 });
    expect(store.prune(1)).toEqual({ deleted: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(neu)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/main/recordingsStore.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export const TOLERANCE_MS = 60_000;

export interface RecordingEntry {
  /* 见 Interfaces */
}

/** 录像索引(独立于 matchStore —— 其自愈路径会 rmSync 整场目录,录像绝不能同住)。
 * ndjson 一行一条;写回(关联/清理)整文件原子重写(tmp + rename)。 */
export class RecordingsStore {
  constructor(private dir: string) {}
  private indexPath(): string {
    return join(this.dir, "recordings.ndjson");
  }

  list(): RecordingEntry[] {
    try {
      return readFileSync(this.indexPath(), "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as RecordingEntry);
    } catch {
      return [];
    }
  }

  private rewrite(entries: RecordingEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexPath()}.tmp`;
    writeFileSync(
      tmp,
      entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length ? "\n" : ""),
    );
    renameSync(tmp, this.indexPath());
  }

  add(entry: RecordingEntry): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.indexPath(), JSON.stringify(entry) + "\n");
  }

  /** 时间窗重叠关联;命中即写回。多录像重叠取 startedAt 最近的一条。 */
  associate(meta: {
    id: string;
    startTime: number;
    endTime: number;
  }): RecordingEntry | null {
    const entries = this.list();
    const candidates = entries.filter(
      (e) =>
        e.matchId === null &&
        e.startedAt <= meta.endTime + TOLERANCE_MS &&
        e.stoppedAt >= meta.startTime - TOLERANCE_MS,
    );
    if (candidates.length === 0) return null;
    const hit = candidates.sort(
      (a, b) =>
        Math.abs(a.startedAt - meta.startTime) -
        Math.abs(b.startedAt - meta.startTime),
    )[0]!;
    hit.matchId = meta.id;
    this.rewrite(entries);
    return hit;
  }

  getForMatch(matchId: string): RecordingEntry | null {
    return this.list().find((e) => e.matchId === matchId) ?? null;
  }

  prune(keepCount: number): { deleted: number } {
    if (keepCount <= 0) return { deleted: 0 };
    const entries = this.list().sort((a, b) => b.startedAt - a.startedAt);
    const keep = entries.slice(0, keepCount);
    const drop = entries.slice(keepCount);
    for (const e of drop) {
      try {
        if (existsSync(e.videoPath)) unlinkSync(e.videoPath);
      } catch {
        /* 文件被占用等,行照删 */
      }
    }
    if (drop.length > 0) this.rewrite(keep);
    return { deleted: drop.length };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/desktop/src/main/recordingsStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/recordingsStore.ts packages/desktop/src/main/recordingsStore.test.ts
git commit -m "feat(desktop): 录像索引 RecordingsStore(时间窗关联 + 保留策略,独立于 matchStore)"
```

---

### Task 4: obsClient + recorderService

**Files:**

- Modify: `packages/desktop/package.json`(dependencies 加 `"obs-websocket-js": "^5.0.8"`;根目录 `npm install`)
- Create: `packages/desktop/src/main/obsClient.ts`
- Create: `packages/desktop/src/main/recorder.ts`
- Test: `packages/desktop/src/main/recorder.test.ts`

**Interfaces:**

- Consumes:Task 3 的 `RecordingsStore`;`settingsStore` 的 `GladlogSettings`(Task 5 字段,本 task 先以 `getSettings: () => Pick<GladlogSettings, ...>` 的结构化子集签名解耦——实现处直接用 `recordingEnabled`/`obsWebsocketUrl`/`obsWebsocketPassword`/`recordingKeepCount` 四字段,Task 5 落定类型后无缝对上)。
- Produces:

```ts
// obsClient.ts
export interface ObsClientLike {
  connect(url: string, password?: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string }>;
  disconnect(): Promise<void>;
  onClosed(cb: () => void): void;
}
export function realObsClient(): ObsClientLike;

// recorder.ts
export interface RecorderStatus {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
}
export interface RecorderService {
  onSegmentOpen(info: { startTime: number; bracket: string }): void;
  onSegmentClose(info: { endTime: number | null; aborted: boolean }): void;
  associate(meta: { id: string; startTime: number; endTime: number }): void;
  getForMatch(matchId: string): RecordingEntry | null;
  getStatus(): RecorderStatus;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>; // app 退出:停在录的、断连
}
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455"; // 注意:renderer 需要的话从 shared 拿(Task 5 放 shared/protocol.ts,此处 re-export)
export function createRecorderService(deps: {
  getSettings: () => {
    recordingEnabled: boolean;
    obsWebsocketUrl: string | null;
    obsWebsocketPassword: string | null;
    recordingKeepCount: number;
  };
  recordings: RecordingsStore;
  clientFactory: () => ObsClientLike;
  emit: (channel: string, payload: unknown) => void; // "gladlog:recorder:status" 推 RecorderStatus
  now?: () => number; // 测试注入;默认 Date.now
}): RecorderService;
```

行为规格(全部在测试覆盖):

1. `recordingEnabled === false` → open/close 全 no-op(不连 OBS)。
2. open:懒连接(未连则 `connect(url ?? DEFAULT_OBS_WS_URL, password ?? undefined)`)→ `startRecord()` → 记 `startedAt = now()`(**锚点是发起时刻**,OBS 启动延迟 <1s 属可接受误差)→ `recording = true` → emit status。已在录(背靠背 DOUBLE_START)→ 忽略。
3. close:未在录 → 忽略;在录 → `stopRecord()` → `recordings.add({videoPath: outputPath, startedAt, stoppedAt: now(), matchId: null})` → 用 **metaBuffer**(最近 20 条 associate 进来的 meta)逐条 `recordings.associate` 补关联 → `recordings.prune(keepCount)` → emit status。
4. `associate(meta)`:先 push 进 metaBuffer(cap 20),再立即 `recordings.associate(meta)`——**双向兜底**:match 消息先于 close 到(parser 先发 match 后发 close)靠 metaBuffer,录像先落靠直接 associate。
5. 任何 OBS 调用失败:catch → `lastError = String(err)` → emit status → **不上抛**;连接失败时 `recording` 保持 false。
6. 安全阀:open 后 40 分钟无 close → 视作 `{endTime: null, aborted: true}` 强制停录(`setTimeout` 存 handle,close 时 clear)。
7. 所有 open/close/stop 走一条 promise 链串行化(`chain = chain.then(fn).catch(() => {})`),防止背靠背场次的起停交错。
8. `stop()`:清 timer;在录则 stopRecord 并落索引;断连。

- [ ] **Step 1: 装依赖**

Run: `npm install --save-exact=false obs-websocket-js@^5.0.8 --workspace=packages/desktop`
Expected: package.json dependencies 出现 `obs-websocket-js`

- [ ] **Step 2: 写失败测试**(fake client + fake settings;不碰真 OBS/timer 用 `vi.useFakeTimers` 只测安全阀一条,其余真时间):

```ts
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { RecordingsStore } from "./recordingsStore";
import { createRecorderService, type RecorderService } from "./recorder";
import type { ObsClientLike } from "./obsClient";

const T0 = 1_750_000_000_000;

function fakeClient(overrides?: Partial<ObsClientLike>) {
  const calls: string[] = [];
  const client: ObsClientLike = {
    connect: async () => {
      calls.push("connect");
    },
    startRecord: async () => {
      calls.push("start");
    },
    stopRecord: async () => {
      calls.push("stop");
      return { outputPath: "/tmp/does-not-matter.mp4" };
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    onClosed: () => {},
    ...overrides,
  };
  return { client, calls };
}

function setup(opts?: {
  enabled?: boolean;
  client?: ObsClientLike;
  keep?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
  const video = join(dir, "out.mp4");
  writeFileSync(video, "x");
  const fake = fakeClient({ stopRecord: async () => ({ outputPath: video }) });
  const client = opts?.client ?? fake.client;
  let t = T0;
  const recordings = new RecordingsStore(dir);
  const statuses: unknown[] = [];
  const svc = createRecorderService({
    getSettings: () => ({
      recordingEnabled: opts?.enabled ?? true,
      obsWebsocketUrl: null,
      obsWebsocketPassword: null,
      recordingKeepCount: opts?.keep ?? 0,
    }),
    recordings,
    clientFactory: () => client,
    emit: (_ch, p) => statuses.push(p),
    now: () => (t += 1000),
  });
  return { svc, recordings, calls: fake.calls, statuses, video };
}

// 串行链是异步的;每步后等一拍
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("recorderService", () => {
  it("disabled → 完全不碰 OBS", async () => {
    const { svc, calls } = setup({ enabled: false });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(calls).toEqual([]);
  });

  it("open→close:起停 + 索引落盘;meta 先到(缓冲)也能关联", async () => {
    const { svc, recordings, calls } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(calls).toEqual(["connect", "start"]);
    // match 消息先于 segmentClose 到(parser 事件顺序如此)
    svc.associate({ id: "m1", startTime: T0, endTime: T0 + 300_000 });
    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false });
    await settle();
    expect(recordings.getForMatch("m1")).not.toBeNull();
  });

  it("meta 后到(录像已落)走直接关联", async () => {
    const { svc, recordings } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false });
    await settle();
    svc.associate({ id: "m2", startTime: T0, endTime: T0 + 300_000 });
    expect(recordings.getForMatch("m2")).not.toBeNull();
  });

  it("connect 失败:lastError 置位、不抛、close no-op", async () => {
    const { client } = fakeClient({
      connect: async () => {
        throw new Error("refused");
      },
    });
    const { svc, calls } = setup({ client });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(svc.getStatus().lastError).toContain("refused");
    expect(svc.getStatus().recording).toBe(false);
    expect(calls).not.toContain("stop");
  });

  it("重复 open 忽略;stop() 停在录并断连", async () => {
    const { svc, calls, recordings } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentOpen({ startTime: T0 + 1, bracket: "3v3" });
    await settle();
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
    await svc.stop();
    expect(calls).toContain("stop");
    expect(calls).toContain("disconnect");
    expect(recordings.list()).toHaveLength(1); // 退出前落索引
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/main/recorder.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 4: 实现 obsClient.ts**

```ts
import OBSWebSocket from "obs-websocket-js";

export interface ObsClientLike {
  /* 见 Interfaces */
}

/** 真实现是薄壳:类型面收敛到 4+1 个方法,recorder 的单测全走 fake。 */
export function realObsClient(): ObsClientLike {
  const obs = new OBSWebSocket();
  return {
    async connect(url, password) {
      await obs.connect(url, password);
    },
    async startRecord() {
      await obs.call("StartRecord");
    },
    async stopRecord() {
      const r = await obs.call("StopRecord");
      return { outputPath: r.outputPath };
    },
    async disconnect() {
      await obs.disconnect();
    },
    onClosed(cb) {
      obs.on("ConnectionClosed", cb);
    },
  };
}
```

(若 `obs-websocket-js` 的默认导出形态是 `{ OBSWebSocket }` 具名导出,按包的 d.ts 实际形态调整 import——编译期即知。)

- [ ] **Step 5: 实现 recorder.ts**

按行为规格 1–8 实现;骨架:

```ts
import type { ObsClientLike } from "./obsClient";
import { RecordingsStore, type RecordingEntry } from "./recordingsStore";
import { DEFAULT_OBS_WS_URL } from "../shared/protocol";

export { DEFAULT_OBS_WS_URL };
const SAFETY_STOP_MS = 40 * 60_000;
const META_BUFFER_CAP = 20;

export function createRecorderService(deps: Deps): RecorderService {
  let client: ObsClientLike | null = null;
  let connected = false;
  let recording = false;
  let startedAt = 0;
  let lastError: string | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  const metaBuffer: Array<{ id: string; startTime: number; endTime: number }> =
    [];
  let chain: Promise<void> = Promise.resolve();
  const now = deps.now ?? Date.now;

  const status = (): RecorderStatus => ({
    enabled: deps.getSettings().recordingEnabled,
    connected,
    recording,
    lastError,
  });
  const pushStatus = () => deps.emit("gladlog:recorder:status", status());
  const run = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(() => {});
  };

  async function ensureConnected(): Promise<void> {
    if (connected && client) return;
    const s = deps.getSettings();
    client = deps.clientFactory();
    client.onClosed(() => {
      connected = false;
      recording = false;
      pushStatus();
    });
    await client.connect(
      s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL,
      s.obsWebsocketPassword ?? undefined,
    );
    connected = true;
  }

  async function doClose(): Promise<void> {
    if (!recording || !client) return;
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    const { outputPath } = await client.stopRecord();
    recording = false;
    const entry: RecordingEntry = {
      videoPath: outputPath,
      startedAt,
      stoppedAt: now(),
      matchId: null,
    };
    deps.recordings.add(entry);
    for (const m of metaBuffer) deps.recordings.associate(m);
    deps.recordings.prune(deps.getSettings().recordingKeepCount);
  }

  return {
    onSegmentOpen() {
      if (!deps.getSettings().recordingEnabled) return;
      run(async () => {
        if (recording) return;
        try {
          await ensureConnected();
          await client!.startRecord();
          startedAt = now();
          recording = true;
          lastError = null;
          safetyTimer = setTimeout(
            () =>
              run(async () => {
                try {
                  await doClose();
                } catch (e) {
                  lastError = String(e);
                } finally {
                  pushStatus();
                }
              }),
            SAFETY_STOP_MS,
          );
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
    onSegmentClose() {
      if (!deps.getSettings().recordingEnabled) return;
      run(async () => {
        try {
          await doClose();
        } catch (e) {
          lastError = String(e);
        }
        pushStatus();
      });
    },
    associate(meta) {
      metaBuffer.push(meta);
      if (metaBuffer.length > META_BUFFER_CAP) metaBuffer.shift();
      try {
        deps.recordings.associate(meta);
      } catch {
        /* 索引损坏也不影响入库 */
      }
    },
    getForMatch: (id) => deps.recordings.getForMatch(id),
    getStatus: status,
    async testConnection() {
      try {
        const c = deps.clientFactory();
        const s = deps.getSettings();
        await c.connect(
          s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL,
          s.obsWebsocketPassword ?? undefined,
        );
        await c.disconnect();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    async stop() {
      await new Promise<void>((res) =>
        run(async () => {
          try {
            await doClose();
          } catch {
            /* 退出路径尽力而为 */
          }
          try {
            await client?.disconnect();
          } catch {
            /* 同上 */
          }
          connected = false;
          res();
        }),
      );
    },
  };
}
```

(`DEFAULT_OBS_WS_URL` 常量本体在 Task 5 加进 `shared/protocol.ts`;本 task 可先在 recorder.ts 里定义、Task 5 挪到 shared 并改成 re-export——**两步之间保持编译绿即可**。)

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run packages/desktop/src/main/recorder.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/package.json package-lock.json packages/desktop/src/main/obsClient.ts packages/desktop/src/main/recorder.ts packages/desktop/src/main/recorder.test.ts
git commit -m "feat(desktop): recorderService —— obs-websocket 外控起停 + 时间窗关联 + 安全阀"
```

---

### Task 5: 录像设置(字段 + 掩码 + 校验)

**Files:**

- Modify: `packages/desktop/src/shared/protocol.ts`
- Modify: `packages/desktop/src/main/settingsStore.ts`
- Modify: `packages/desktop/src/main/recorder.ts`(常量改 re-export)
- Test: `packages/desktop/src/main/settingsStore.recording.test.ts`

**Interfaces:**

- Produces:`GladlogSettings` 新字段 `recordingEnabled: boolean`(默认 false)、`obsWebsocketUrl: string | null`(null → UI 显示默认 `DEFAULT_OBS_WS_URL`)、`obsWebsocketPassword: string | null`、`recordingKeepCount: number`(默认 50,0 = 不清理);`shared/protocol.ts` 新常量 `OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__"`、`DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455"`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { redactSettings, sanitizeSettingsPatch } from "./settingsStore";
import { OBS_PASSWORD_REDACTED } from "../shared/protocol";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SettingsStore } from "./settingsStore";

describe("recording settings", () => {
  it("旧配置文件读回带默认值", () => {
    const s = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "settings.json"),
    );
    const v = s.get();
    expect(v.recordingEnabled).toBe(false);
    expect(v.recordingKeepCount).toBe(50);
    expect(v.obsWebsocketUrl).toBeNull();
  });

  it("redact:密码替换为哨兵;null 保持 null", () => {
    const base = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "s.json"),
    ).get();
    expect(
      redactSettings({ ...base, obsWebsocketPassword: "hunter2" })
        .obsWebsocketPassword,
    ).toBe(OBS_PASSWORD_REDACTED);
    expect(redactSettings(base).obsWebsocketPassword).toBeNull();
  });

  it("sanitize:哨兵不回写;keepCount 非法值丢弃", () => {
    expect(
      sanitizeSettingsPatch({ obsWebsocketPassword: OBS_PASSWORD_REDACTED }),
    ).not.toHaveProperty("obsWebsocketPassword");
    expect(
      sanitizeSettingsPatch({ recordingKeepCount: -3 }),
    ).not.toHaveProperty("recordingKeepCount");
    expect(
      sanitizeSettingsPatch({ recordingKeepCount: Number.NaN }),
    ).not.toHaveProperty("recordingKeepCount");
    expect(sanitizeSettingsPatch({ recordingKeepCount: 10 })).toEqual({
      recordingKeepCount: 10,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/main/settingsStore.recording.test.ts`
Expected: FAIL(字段/常量不存在)

- [ ] **Step 3: 实现**

`shared/protocol.ts` 末尾(`API_KEY_REDACTED` 旁):

```ts
/** OBS websocket 密码的回读哨兵(同 API_KEY_REDACTED 模式)。 */
export const OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__";
/** OBS 28+ websocket 默认地址(renderer 占位与 main 连接共用,单源)。 */
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455";
```

`settingsStore.ts`:

- `GladlogSettings` 加四字段(注释注明 2026-07-28 路线C一期);`DEFAULTS` 补 `recordingEnabled: false, obsWebsocketUrl: null, obsWebsocketPassword: null, recordingKeepCount: 50`。
- `redactSettings` 返回值加:

```ts
obsWebsocketPassword: s.obsWebsocketPassword ? OBS_PASSWORD_REDACTED : null,
```

(import 从 `../shared/protocol` 补 `OBS_PASSWORD_REDACTED`。)

- `sanitizeSettingsPatch` 加两段(照 `anthropicApiKey` 哨兵分支形态):

```ts
if (out.obsWebsocketPassword === OBS_PASSWORD_REDACTED) {
  const { obsWebsocketPassword: _redacted, ...rest } = out;
  out = rest;
}
if (
  out.recordingKeepCount !== undefined &&
  (!Number.isFinite(out.recordingKeepCount) || out.recordingKeepCount < 0)
) {
  const { recordingKeepCount: _bad, ...rest } = out;
  out = rest;
}
```

`recorder.ts`:删本地 `DEFAULT_OBS_WS_URL` 定义,改 `import { DEFAULT_OBS_WS_URL } from "../shared/protocol";` 并保留 re-export。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/desktop/src/main/settingsStore.recording.test.ts packages/desktop/src/main/recorder.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/protocol.ts packages/desktop/src/main/settingsStore.ts packages/desktop/src/main/recorder.ts packages/desktop/src/main/settingsStore.recording.test.ts
git commit -m "feat(desktop): 录像设置四字段(密码哨兵掩码 + keepCount 校验)"
```

---

### Task 6: vod:// 供片协议(Range 支持)

**Files:**

- Create: `packages/desktop/src/shared/vod.ts`(纯函数,electron-free,可测)
- Create: `packages/desktop/src/main/vodProtocol.ts`(electron 接线)
- Test: `packages/desktop/src/shared/vod.test.ts`

**Interfaces:**

- Produces:

```ts
// shared/vod.ts
export const VOD_SCHEME = "vod";
export function vodUrl(path: string): string; // vod://v/<base64url(path)> —— token 放 path 段,避开 Chrome 对 host 的小写规范化
export function vodUrlToPath(url: string): string | null;
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null;

// main/vodProtocol.ts
export function registerVodScheme(): void; // 必须在 app ready 前调用(index.ts 模块顶层)
export function handleVodProtocol(isServable: (path: string) => boolean): void; // whenReady 里调用
```

- 安全:`isServable` 由调用方传 `(p) => recordings.list().some((r) => r.videoPath === p)` —— 只供索引里认识的文件,杜绝任意路径读取。

- [ ] **Step 1: 写失败测试**(只测纯函数):

```ts
import { describe, expect, it } from "vitest";
import { parseRange, vodUrl, vodUrlToPath } from "./vod";

describe("vodUrl 往返", () => {
  it("Windows 路径 + 中文 + 大小写全部保真", () => {
    for (const p of [
      "C:\\Users\\玩家\\Videos\\2026-07-28 20-11-05.mp4",
      "/Users/a/Movies/OBS/Match.MP4",
    ]) {
      expect(vodUrlToPath(vodUrl(p))).toBe(p);
    }
  });
  it("非法 url → null", () => {
    expect(vodUrlToPath("vod://v/%%%")).toBeNull();
    expect(vodUrlToPath("http://x/")).toBeNull();
  });
});

describe("parseRange", () => {
  it("常规区间/开区间/尾部区间", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("越界 end 截到 size-1;start 越界/倒置/无头 → null", () => {
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBeNull();
    expect(parseRange("bytes=9-3", 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("chunks=0-1", 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/shared/vod.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 shared/vod.ts**

```ts
export const VOD_SCHEME = "vod";

export function vodUrl(path: string): string {
  return `${VOD_SCHEME}://v/${Buffer.from(path, "utf-8").toString("base64url")}`;
}

export function vodUrlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${VOD_SCHEME}:`) return null;
    const token = u.pathname.replace(/^\//, "");
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    return Buffer.from(token, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

/** HTTP Range 单段解析;无/非法 → null(调用方整文件 200)。 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  if (s === "") {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(s);
  const end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}
```

(注:preload/renderer 均不 import 本文件的 Buffer 路径 —— vodUrl 只在 main 侧调用;shared 放置是为了 electron-free 单测。)

- [ ] **Step 4: 实现 main/vodProtocol.ts**

```ts
import { protocol } from "electron";
import { createReadStream, statSync } from "fs";
import { extname } from "path";
import { Readable } from "stream";
import { parseRange, vodUrlToPath, VOD_SCHEME } from "../shared/vod";

export function registerVodScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VOD_SCHEME,
      privileges: {
        standard: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
};

export function handleVodProtocol(isServable: (path: string) => boolean): void {
  protocol.handle(VOD_SCHEME, (req) => {
    try {
      const path = vodUrlToPath(req.url);
      if (!path || !isServable(path))
        return new Response("forbidden", { status: 403 });
      const size = statSync(path).size;
      const range = parseRange(req.headers.get("range"), size);
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      const stream = Readable.toWeb(
        createReadStream(path, { start, end }),
      ) as ReadableStream;
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          "content-type": MIME[extname(path).toLowerCase()] ?? "video/mp4",
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
          ...(range
            ? { "content-range": `bytes ${start}-${end}/${size}` }
            : {}),
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `npx vitest run packages/desktop/src/shared/vod.test.ts && npm run typecheck`
Expected: 全 PASS / 零错误

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/shared/vod.ts packages/desktop/src/shared/vod.test.ts packages/desktop/src/main/vodProtocol.ts
git commit -m "feat(desktop): vod:// 特权供片协议(Range 支持;仅供索引内文件)"
```

---

### Task 7: main 接线 + IPC + preload

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/api.ts`
- Modify: `packages/desktop/src/preload/index.ts`

**Interfaces:**

- Consumes:Task 2 的 WorkerToMain 新消息、Task 4 的 `RecorderService`、Task 6 的 `registerVodScheme/handleVodProtocol/vodUrl`。
- Produces:preload 面

```ts
recorder: {
  getStatus(): Promise<RecorderStatus>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  /** 该对局关联录像;无 → null。url 为 vod:// 地址;startedAt 为播放锚点(epoch ms)。 */
  getForMatch(matchId: string): Promise<{ url: string; startedAt: number; stoppedAt: number } | null>;
  onStatus(cb: (s: RecorderStatus) => void): () => void;
};
```

(`RecorderStatus` 在 `preload/api.ts` 用 `import type { RecorderStatus } from "../main/recorder";` —— type-only,合规。)

- [ ] **Step 1: main/index.ts 接线**

1. import 区加:

```ts
import { createRecorderService, type RecorderService } from "./recorder";
import { realObsClient } from "./obsClient";
import { RecordingsStore } from "./recordingsStore";
import { handleVodProtocol, registerVodScheme } from "./vodProtocol";
```

2. 模块顶层(`app.setName("gladlog")` 之后、任何 ready 之前):`registerVodScheme();`
3. 模块级可变量区(`let host` 旁):`let recorder: RecorderService | null = null;`
4. `onWorkerMessage` 的 `match|shuffle` 分支,`store.store` 之后加:

```ts
if (r.stored && r.meta) {
  recorder?.associate(r.meta);
  win?.webContents.send("gladlog:logs:matchStored", r.meta);
}
```

(即在原 send 之前插 `recorder?.associate(r.meta);`,同一 if 内。) 5. `onWorkerMessage` 末尾加两个分支:

```ts
} else if (msg.type === "segmentOpen") {
  recorder?.onSegmentOpen({ startTime: msg.startTime, bracket: msg.bracket });
} else if (msg.type === "segmentClose") {
  recorder?.onSegmentClose({ endTime: msg.endTime, aborted: msg.aborted });
}
```

6. `whenReady` 内(`icons` 之后、`registerIpc` 之前):

```ts
const recordings = new RecordingsStore(join(userData(), "recordings"));
recorder = createRecorderService({
  getSettings: () => settings.get(),
  recordings,
  clientFactory: realObsClient,
  emit: (ch, payload) => win?.webContents.send(ch, payload),
});
handleVodProtocol((p) => recordings.list().some((r) => r.videoPath === p));
```

7. `registerIpc` deps 加 `recorder: recorder!,`。
8. `window-all-closed` 改:

```ts
app.on("window-all-closed", () => {
  void recorder?.stop();
  host?.stop();
  app.quit();
});
```

- [ ] **Step 2: ipc.ts**

deps 类型加 `recorder: RecorderService;`(`import type { RecorderService } from "./recorder";`),函数体加:

```ts
import { vodUrl } from "../shared/vod"; // 文件顶部

ipcMain.handle("gladlog:recorder:getStatus", () => deps.recorder.getStatus());
ipcMain.handle("gladlog:recorder:testConnection", () =>
  deps.recorder.testConnection(),
);
ipcMain.handle("gladlog:recorder:getForMatch", (_e, matchId: string) => {
  const r = deps.recorder.getForMatch(String(matchId));
  return r
    ? {
        url: vodUrl(r.videoPath),
        startedAt: r.startedAt,
        stoppedAt: r.stoppedAt,
      }
    : null;
});
```

- [ ] **Step 3: preload 两处**

`api.ts`:`GladlogApi` 加 `recorder` 面(见 Interfaces,含 doc 注释)。
`index.ts`:

```ts
recorder: {
  getStatus: () => ipcRenderer.invoke("gladlog:recorder:getStatus"),
  testConnection: () => ipcRenderer.invoke("gladlog:recorder:testConnection"),
  getForMatch: (matchId) =>
    ipcRenderer.invoke("gladlog:recorder:getForMatch", matchId),
  onStatus: sub("gladlog:recorder:status"),
},
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm test --workspace=packages/desktop`
Expected: 零错误 / 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): recorder 接线 —— worker 事件路由 / IPC / preload / vod 供片 / 退出停录"
```

---

### Task 8: VideoDock(回放视频从动件)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/VideoDock.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx`(props 加 `matchId?: string`;controls 上方挂载)
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx`(`<ReplayView ...>` 传 `matchId={resolvedMatchId}`,`MatchReport.tsx:305` 处)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx`

**Interfaces:**

- Consumes:Task 7 preload `recorder.getForMatch`;ReplayView 局部 `t`(绝对 ms)/`playing`/`speed`。
- Produces:`<VideoDock matchId t playing speed />`。**video 是 `t` 的从动件**:±0.35s 外重对齐 `currentTime = (t - startedAt)/1000`;不回写 `t`。无关联录像 → 整个组件渲染 null(零占位)。

- [ ] **Step 1: 写失败测试**

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VideoDock } from "./VideoDock";

const T0 = 1_750_000_000_000;

function stubBridge(
  rec: { url: string; startedAt: number; stoppedAt: number } | null,
) {
  (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
    recorder: { getForMatch: async () => rec },
  };
}

describe("VideoDock", () => {
  it("无关联录像 → 不渲染", async () => {
    stubBridge(null);
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("有录像 → 渲染 video,src 用 vod url,currentTime 对齐锚点", async () => {
    stubBridge({
      url: "vod://v/dG9rZW4",
      startedAt: T0 - 10_000,
      stoppedAt: T0 + 60_000,
    });
    render(<VideoDock matchId="m1" t={T0} playing={false} speed={1} />);
    const video = (await screen.findByTestId(
      "video-dock-el",
    )) as HTMLVideoElement;
    expect(video.src).toContain("vod://");
    await waitFor(() => expect(video.currentTime).toBeCloseTo(10, 1)); // (T0 - (T0-10s))/1000
  });

  it("bridge 桩缺 recorder 面 → 静默不渲染(不抛)", async () => {
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {};
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 实现 VideoDock.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import { bridge } from "../../bridge";

interface RecInfo {
  url: string;
  startedAt: number;
  stoppedAt: number;
}

/** 对局录像(OBS 外控一期)。video 是回放时钟 t 的从动件——不自走时钟,
 * 偏差 >0.35s 才重对齐,10+ 处既有 seek 入口因此零改动生效。缺头(日志
 * 滞后起录)表现为开场前几秒视频停在第 0 帧,属接受的一期行为。 */
export function VideoDock({
  matchId,
  t,
  playing,
  speed,
}: {
  matchId: string;
  t: number;
  playing: boolean;
  speed: number;
}) {
  const [rec, setRec] = useState<RecInfo | null>(null);
  const [open, setOpen] = useState(true);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let alive = true;
    try {
      // 桩经常缺 recorder 面(fixture/测试台)—— 缺面时静默隐藏
      void bridge()
        .recorder?.getForMatch(matchId)
        .then((r) => {
          if (alive) setRec(r);
        })
        .catch(() => {});
    } catch {
      /* 桩缺面 */
    }
    return () => {
      alive = false;
    };
  }, [matchId]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !rec) return;
    const expected = Math.max(0, (t - rec.startedAt) / 1000);
    if (Math.abs(v.currentTime - expected) > 0.35) v.currentTime = expected;
  }, [t, rec]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !rec) return;
    try {
      if (playing) void Promise.resolve(v.play()).catch(() => {});
      else v.pause();
    } catch {
      /* jsdom 无媒体实现 */
    }
  }, [playing, rec]);

  useEffect(() => {
    const v = ref.current;
    if (v) v.playbackRate = speed;
  }, [speed, rec]);

  if (!rec) return null;
  return (
    <div className="rpt-video-dock" data-testid="video-dock">
      <button className="rpt-video-toggle" onClick={() => setOpen((o) => !o)}>
        🎥 录像{open ? " ▾" : " ▸"}
      </button>
      {open &&
        (failed ? (
          <p className="rpt-dim">
            无法播放该录像(建议 OBS 录制格式设为 Hybrid MP4)
          </p>
        ) : (
          <video
            ref={ref}
            data-testid="video-dock-el"
            src={rec.url}
            muted
            playsInline
            onError={() => setFailed(true)}
          />
        ))}
    </div>
  );
}
```

- [ ] **Step 4: 挂载**

`ReplayView.tsx`:

- props 接口加 `matchId?: string;`(注释:`/** 录像关联查询用;缺省(导出页/测试台)→ 不显示视频 */`),函数签名解构加 `matchId`。
- import 加 `import { VideoDock } from "./VideoDock";`。
- `<div className="rpt-replay-controls">` 之前插入:

```tsx
{
  matchId && (
    <VideoDock matchId={matchId} t={t} playing={playing} speed={speed} />
  );
}
```

`MatchReport.tsx` 的 `<ReplayView`(`:305`)加一行 `matchId={resolvedMatchId}`。

`styles.css` 末尾:

```css
/* ── 录像 dock(OBS 外控一期)── */
.rpt-video-dock {
  margin: 4px 0;
}
.rpt-video-dock video {
  width: 100%;
  max-height: 300px;
  background: #000;
  border-radius: 6px;
}
.rpt-video-toggle {
  font-size: 12px;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx && npm test --workspace=packages/desktop`
Expected: 全 PASS(ReplayView 既有测试不回归——matchId 是可选 prop)

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/VideoDock.tsx packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx packages/desktop/src/renderer/src/report/components/ReplayView.tsx packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): VideoDock —— 回放时钟从动的对局录像播放(seek 入口零改动生效)"
```

---

### Task 9: SettingsPanel 录像分组

**Files:**

- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`

**Interfaces:**

- Consumes:Task 5 settings 字段与 `OBS_PASSWORD_REDACTED`/`DEFAULT_OBS_WS_URL`(从 `../../../shared/protocol` import——**shared,不是 main**);Task 7 preload `recorder.testConnection`。

- [ ] **Step 1: 实现**

1. `type SettingsGroup = "game" | "ai" | "recording";`
2. state 加:

```tsx
const [obsUrlInput, setObsUrlInput] = useState("");
const [obsPwInput, setObsPwInput] = useState("");
const [obsTest, setObsTest] = useState<string | null>(null);
```

初始 `useEffect` 里 `setObsUrlInput(s.obsWebsocketUrl ?? "");`。3. AI 分组 `</section>` 之后新增分组(三列 grid 照抄现有模式):

```tsx
<section className="dash-card">
  {groupHead("对局录像(OBS)", "recording")}
  <div className="settings-grid">
    <span className="settings-k">自动录像</span>
    <span className="settings-v">
      需 OBS 28+ 并开启 WebSocket 服务器(工具 → WebSocket 服务器设置);
      录制格式建议 Hybrid MP4。开场自动起录、结束自动停录并关联到对局。
    </span>
    <button
      onClick={() =>
        void save(
          { recordingEnabled: !settings.recordingEnabled },
          settings.recordingEnabled ? "已停用自动录像" : "已启用自动录像",
          "recording",
        )
      }
    >
      {settings.recordingEnabled ? "停用" : "启用"}
    </button>

    <span className="settings-k">WebSocket 地址</span>
    <input
      placeholder={DEFAULT_OBS_WS_URL}
      value={obsUrlInput}
      onChange={(e) => setObsUrlInput(e.target.value)}
      onBlur={() =>
        void save(
          { obsWebsocketUrl: obsUrlInput.trim() || null },
          "地址已保存",
          "recording",
        )
      }
    />
    <span />

    <span className="settings-k">WebSocket 密码</span>
    <span className="settings-key-cell">
      {settings.obsWebsocketPassword === OBS_PASSWORD_REDACTED ? (
        <span className="settings-pill-ok">已设置</span>
      ) : (
        <span className="settings-v">未设置(OBS 未开鉴权则留空)</span>
      )}
      <input
        type="password"
        placeholder="输入以更换"
        value={obsPwInput}
        onChange={(e) => setObsPwInput(e.target.value)}
      />
    </span>
    <span className="settings-actions">
      <button
        disabled={!obsPwInput.trim()}
        onClick={() => {
          void save(
            { obsWebsocketPassword: obsPwInput.trim() },
            "密码已保存",
            "recording",
          );
          setObsPwInput("");
        }}
      >
        保存
      </button>
      <button
        onClick={() =>
          void bridge()
            .recorder.testConnection()
            .then((r) =>
              setObsTest(r.ok ? "✓ 连接成功" : `✗ ${r.error ?? "连接失败"}`),
            )
        }
      >
        测试连接
      </button>
    </span>

    <span className="settings-k">保留录像</span>
    <span>
      <input
        type="number"
        min={0}
        style={{ width: "5em" }}
        value={settings.recordingKeepCount}
        onChange={(e) =>
          void save(
            { recordingKeepCount: Math.max(0, Number(e.target.value) || 0) },
            "保留策略已保存",
            "recording",
          )
        }
      />
      <span className="settings-note">
        最近 N 场,0 = 不清理(超出的连视频文件一起删)
      </span>
    </span>
    <span />

    {obsTest && (
      <>
        <span className="settings-k" />
        <span className="settings-v">{obsTest}</span>
        <span />
      </>
    )}
  </div>
</section>
```

import 行:`OBS_PASSWORD_REDACTED, DEFAULT_OBS_WS_URL` 并入现有 `from "../../../shared/protocol"`。

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npm test --workspace=packages/desktop`
Expected: 零错误 / 全 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(desktop): 设置页录像分组(启停/地址/密码掩码/测试连接/保留策略)"
```

---

### Task 10: 收尾 —— presubmit、跨 AI 复核、文档

- [ ] **Step 1: 全量门禁**

Run: `npm run presubmit`
Expected: 全绿(lint 全仓 + typecheck + 全 workspace test + verify:vision + electron-vite build;build 步专抓 renderer 值引入 main)。红了修到绿,别加管道裁输出。

- [ ] **Step 2: BACKLOG 更新**

`docs/BACKLOG.md` #1 的引用块追加一行:

```
> **2026-07-28 一期开工**:路线 C 之外控 obs-websocket,`feature/obs-recording`
> 分支;计划 `docs/plans/2026-07-28-obs-recording-phase1-plan.md`。
```

- [ ] **Step 3: Commit + push 分支**

```bash
git add docs/BACKLOG.md docs/plans/2026-07-28-obs-recording-phase1-plan.md
git commit -m "docs: OBS 录像一期实施计划 + backlog 状态"
git push -u origin feature/obs-recording
```

- [ ] **Step 4: 跨 AI 复核(agy-review skill)**

按 `.claude/skills/agy-review` 流程导出 `git diff main...feature/obs-recording`,重点让它看:recorder 串行链的竞态(背靠背场次)、vod 协议的路径校验、settings 哨兵回写、pipeline 轮转分支。采纳/驳回按 skill 判据,修完重跑 presubmit。

- [ ] **Step 5: CI 观察**

`gh run list --branch feature/obs-recording` 按 headSha 取本次 run,`gh run watch <id> --exit-status`。改了 SettingsPanel/ReplayView → `report-*`/settings 视觉基线若红,按 desktop-dev 的 CI 基线配方重生成 + 人审(**本机绝不直跑 test:visual**)。

**一期验收口径**(诚实汇报,做不到就写做不到):单测层——parser 生命周期 4 用例、pipeline 转发 2、recordingsStore 4、recorder 5、settings 3、vod 4、VideoDock 3 全绿;真机层——需要 Windows + OBS 实测(开一场竞技场:自动起录/停录、`recordings.ndjson` 出现关联行、回放页出视频且 seek 跟手),**本机(mac,无 WoW/OBS 环境)完不成,列为 push 后的用户实测项**,不得声称"端到端已验证"。
