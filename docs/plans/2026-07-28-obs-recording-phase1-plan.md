# OBS Recording Integration Phase 1 (External Control via obs-websocket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic start/stop of match recording (controlling user's installed OBS externally), recording ↔ match time window association, and video replay synchronized with the replay clock inside ReplayView.

**Architecture:** Route C Phase 1 (evaluation in `docs/plans/2026-07-27-obs-recording-integration-eval.md`). parser emits new segmentOpen/segmentClose lifecycle events → worker forwards → main's recorderService starts/stops OBS recording via obs-websocket, recording index stored in standalone `recordings/recordings.ndjson` (time window association with matchId), privileged `vod://` protocol serves video, renderer's VideoDock acts as a follower to replay clock `t` — 10+ existing seek entrypoints take effect with zero modifications. Capture side is abstracted into a "time window + anchor" data contract; replay/association layers remain untouched when replacing with embedded recording engine in Phase 2.

**Tech Stack:** TypeScript monorepo; `obs-websocket-js@^5` (OBS 28+ built-in websocket v5); Electron `protocol.handle`; vitest.

## Global Constraints

- Branch: All work in `feature/obs-recording`, do not touch main.
- Explicitly out of scope for Phase 1: Embedded recording engine, video trimming / transcoding, missing start compensation (video starts at match detection; missing a few to tens of seconds at start is acceptable), macOS recording, cross-machine video transfer.
- Recording failures / OBS not running **only degrade, never throw** — never affect parsing, persistence, or analysis main pipelines.
- Video files and index **must never** be placed in `<userData>/matches/<id>/` (matchStore self-healing path runs `rmSync` on entire directory, `matchStore.ts:443`).
- renderer/preload can only `import type` from `src/main/*`; cross-boundary constants belong in `src/shared/` (v0.0.4 build incident).
- Replay clock `t` remains local to ReplayView; video acts as follower, do not lift state.
- Before push: `npm run presubmit` (full workspace, do not run components manually); never run `test:visual` locally.
- Compound commands do not use `cd`; gate chains must not include pipes (swallows exit codes).
- New dependency `obs-websocket-js` must go into `packages/desktop`'s `dependencies` (externalizeDepsPlugin externalizes → packaging relies on production node_modules).

---

### Task 1: parser Lifecycle Events segmentOpen / segmentClose

**Files:**

- Modify: `packages/parser/src/l2/segmenter.ts`
- Modify: `packages/parser/src/api.ts`
- Test: `packages/parser/test/l2.lifecycleEvents.test.ts`

**Interfaces:**

- Produces: `SegmentOpenInfo { bracket: string; zoneId: string; isRated: boolean; startTime: number }`, `SegmentCloseInfo { endTime: number | null; aborted: boolean }` (both exported); `GladLogParser.on("segmentOpen"|"segmentClose", cb)`. Semantics: **emit open only on IDLE→open transition** (once for entire shuffle lobby; DOUBLE_START segment switch does not re-emit), **emit close only on open→IDLE transition** (`end()` abnormal closure → `{endTime: null, aborted: true}`). Timestamps are line epoch ms (`line.timestamp`).

- [ ] **Step 1: Write failing test** (patterned after `line()`/`CAST` helpers in `test/l2.openSegment.test.ts`):

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
  it("match: START emits open (with bracket/time), END emits close", () => {
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

  it("shuffle: entire lobby opens/closes only once each", () => {
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

  it("end() abnormal closure → aborted close; end() at IDLE does not emit", () => {
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

  it("DOUBLE_START does not emit duplicate open", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.push(line(1, "ARENA_MATCH_START,1825,41,3v3,1"));
    expect(opens).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/parser/test/l2.lifecycleEvents.test.ts`
Expected: FAIL (`on("segmentOpen")` type/event does not exist)

- [ ] **Step 3: Implement segmenter callbacks**

`segmenter.ts`: Add two exported interfaces at top of file (see Interfaces); inside class add:

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

Trigger points (**only where actual state transitions occur**):

1. In `push()` under `ARENA_MATCH_START` branch, in the two sub-branches of `if (this.state === "IDLE")` (shuffle/match), after setting `currentSegment` add:

```ts
this.openCallback?.({
  bracket: line.arenaStart?.bracket ?? "",
  zoneId: line.arenaStart?.zoneId ?? "",
  isRated: line.arenaStart?.isRated ?? false,
  startTime: line.timestamp,
});
```

(Do **not** add to DOUBLE_START or shuffle round progression branches.)
2. In `ARENA_MATCH_END` branches for `IN_MATCH` and `IN_SHUFFLE`, after `this.state = "IDLE"` add:

```ts
this.closeCallback?.({ endTime: line.timestamp, aborted: false });
```

3. In `end()` under `if (this.state !== "IDLE")` block at the end add:

```ts
this.closeCallback?.({ endTime: null, aborted: true });
```

`api.ts`: Add `segmentOpen: (info: SegmentOpenInfo) => void; segmentClose: (info: SegmentCloseInfo) => void;` to EventMap (import type from `./l2/segmenter` and re-export); in constructor:

```ts
this.segmenter.onOpen((info) => this.emit("segmentOpen", info));
this.segmenter.onClose((info) => this.emit("segmentClose", info));
```

Note that `line.timestamp` field name follows `ParsedLine` in `l1/types.ts` (compose.ts:72 uses `seg.startLine.timestamp`, same field). If parser package has `src/index.ts` barrel file, add both Info types to exports.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/parser/test/l2.lifecycleEvents.test.ts && npx vitest run packages/parser/test/l2.openSegment.test.ts packages/parser/test/l2.segmenter.synthetic.test.ts`
Expected: All PASS (existing segmenter tests do not regress)

- [ ] **Step 5: Commit**

```bash
git add packages/parser/src/l2/segmenter.ts packages/parser/src/api.ts packages/parser/test/l2.lifecycleEvents.test.ts
git commit -m "feat(parser): segmentOpen/segmentClose lifecycle events (for OBS recording trigger)"
```

---

### Task 2: worker → main Forwarding (Including Rotation Aborted Close)

**Files:**

- Modify: `packages/desktop/src/shared/protocol.ts`
- Modify: `packages/desktop/src/worker/pipeline.ts`
- Test: `packages/desktop/src/worker/pipeline.lifecycle.test.ts`

**Interfaces:**

- Consumes: Task 1 `segmentOpen`/`segmentClose` events.
- Produces: `WorkerToMain` new members
  `{ type: "segmentOpen"; fileKey: string; bracket: string; zoneId: string; isRated: boolean; startTime: number }`,
  `{ type: "segmentClose"; fileKey: string; endTime: number | null; aborted: boolean }`.
  On rotation (`r.rotated`), if old parser had an open segment, emit synthetic `segmentClose {endTime: null, aborted: true}` before reconstructing parser.

- [ ] **Step 1: Write failing test** (pipeline uses real parser + temp files; pattern: write file → `processFlush()` → assert emitted messages):

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
  it("START → segmentOpen; END → segmentClose (with fileKey)", () => {
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

  it("file rotation mid-match → synthetic aborted close", () => {
    const { file, msgs, p } = setup();
    appendFileSync(file, line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.processFlush();
    // Rotation: entire file replaced (first line checksum changes)
    writeFileSync(file, line(0, "ARENA_MATCH_START,1504,40,2v2,1"));
    p.processFlush();
    const closes = msgs.filter((m) => m.type === "segmentClose");
    expect(closes).toEqual([
      expect.objectContaining({ endTime: null, aborted: true }),
    ]);
    // New match in new parser opens normally
    expect(msgs.filter((m) => m.type === "segmentOpen")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/worker/pipeline.lifecycle.test.ts`
Expected: FAIL (type lacks segmentOpen member / no messages)

- [ ] **Step 3: Implement**

Add two members to `WorkerToMain` union in `protocol.ts` (see Interfaces).

`pipeline.ts`:

1. Expand `ParserLike.on` event name union to `"match" | "shuffle" | "diagnostic" | "segmentOpen" | "segmentClose"`.
2. Add subscriptions in `createParser()`:

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

3. Modify rotation branch in `processFlush()` (**emit synthetic close before rebuilding**):

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

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/worker/pipeline.lifecycle.test.ts && npm test --workspace=packages/desktop`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/protocol.ts packages/desktop/src/worker/pipeline.ts packages/desktop/src/worker/pipeline.lifecycle.test.ts
git commit -m "feat(desktop): worker forwards match lifecycle events (synthetic aborted close on rotation)"
```

---

### Task 3: RecordingsStore (Standalone Index + Time Window Association + Retention Policy)

**Files:**

- Create: `packages/desktop/src/main/recordingsStore.ts`
- Test: `packages/desktop/src/main/recordingsStore.test.ts`

**Interfaces:**

- Produces:

```ts
export interface RecordingEntry {
  videoPath: string;
  startedAt: number; // StartRecord wall clock epoch ms — playback anchor
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

- Association criteria (**defined in one place, recorder only calls it**): Recording window `[startedAt, stoppedAt]` overlaps with match window `[startTime - TOL, endTime + TOL]` (`TOLERANCE_MS = 60_000` exported) and `matchId === null`. Recording start being later than match start is normal (log lag); test for overlap, not strict containment.

- [ ] **Step 1: Write failing test**

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
  it("add + list persistence (persists across new instances)", () => {
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

  it("associate: overlap matches (recording start later than match start), writes back matchId", () => {
    const { dir, store } = setup();
    const v = fakeVideo(dir, "a.mp4");
    // Match starts T0, recording starts T0+8s (log lag)
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
    expect(new RecordingsStore(dir).getForMatch("m1")).not.toBeNull(); // Written to disk
  });

  it("associate: windows completely disjoint → null; already associated entries not stolen", () => {
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

  it("prune: keep N descending by startedAt, delete remaining files + rows; 0 = no prune", () => {
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

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/main/recordingsStore.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**

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
  /* See Interfaces */
}

/** Recording index (independent of matchStore — whose self-healing path runs rmSync on match dirs, recordings must never live together).
 * One entry per ndjson line; atomic rewrite for write-backs (association/cleanup) using tmp + rename. */
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

  /** Time window overlap association; writes back upon hit. Picks closest startedAt if multiple overlap. */
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
        /* File locked, etc. Row still removed */
      }
    }
    if (drop.length > 0) this.rewrite(keep);
    return { deleted: drop.length };
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/main/recordingsStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/recordingsStore.ts packages/desktop/src/main/recordingsStore.test.ts
git commit -m "feat(desktop): recordings index RecordingsStore (time window association + retention policy, separate from matchStore)"
```

---

### Task 4: obsClient + recorderService

**Files:**

- Modify: `packages/desktop/package.json` (add `"obs-websocket-js": "^5.0.8"` to dependencies; `npm install` at root)
- Create: `packages/desktop/src/main/obsClient.ts`
- Create: `packages/desktop/src/main/recorder.ts`
- Test: `packages/desktop/src/main/recorder.test.ts`

**Interfaces:**

- Consumes: Task 3 `RecordingsStore`; `GladlogSettings` in `settingsStore` (Task 5 fields, decoupled in this task with `getSettings: () => Pick<GladlogSettings, ...>` structured subset signature — implementation directly consumes `recordingEnabled`/`obsWebsocketUrl`/`obsWebsocketPassword`/`recordingKeepCount`, cleanly matching types landed in Task 5).
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
  stop(): Promise<void>; // app exit: stop active recording, disconnect
}
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455"; // Note: renderer imports from shared (Task 5 puts in shared/protocol.ts, re-exported here)
export function createRecorderService(deps: {
  getSettings: () => {
    recordingEnabled: boolean;
    obsWebsocketUrl: string | null;
    obsWebsocketPassword: string | null;
    recordingKeepCount: number;
  };
  recordings: RecordingsStore;
  clientFactory: () => ObsClientLike;
  emit: (channel: string, payload: unknown) => void; // "gladlog:recorder:status" pushes RecorderStatus
  now?: () => number; // Test injection; defaults to Date.now
}): RecorderService;
```

Behavioral Specifications (All covered by tests):

1. `recordingEnabled === false` → open/close are no-ops (does not connect to OBS).
2. open: Lazy connect (if not connected, `connect(url ?? DEFAULT_OBS_WS_URL, password ?? undefined)`) → `startRecord()` → record `startedAt = now()` (**anchor is invocation timestamp**, OBS start delay <1s is acceptable tolerance) → `recording = true` → emit status. Already recording (back-to-back DOUBLE_START) → ignore.
3. close: Not recording → ignore; recording → `stopRecord()` → `recordings.add({videoPath: outputPath, startedAt, stoppedAt: now(), matchId: null})` → use **metaBuffer** (latest 20 associated metas) to backfill associations via `recordings.associate` → `recordings.prune(keepCount)` → emit status.
4. `associate(meta)`: Push into metaBuffer (cap 20), then immediately call `recordings.associate(meta)` — **bidirectional fallback**: if match message arrives before close (parser sends match before close), metaBuffer catches it; if recording finishes first, direct associate catches it.
5. Any OBS call failure: catch → `lastError = String(err)` → emit status → **do not throw**; `recording` stays false on connection failure.
6. Safety valve: 40 minutes after open with no close → treated as `{endTime: null, aborted: true}` and forced stop (`setTimeout` stores handle, cleared on close).
7. All open/close/stop operations are serialized via a single promise chain (`chain = chain.then(fn).catch(() => {})`), preventing start/stop interleaving on back-to-back matches.
8. `stop()`: Clear timer; if recording, stopRecord and persist index; disconnect.

- [ ] **Step 1: Install dependency**

Run: `npm install --save-exact=false obs-websocket-js@^5.0.8 --workspace=packages/desktop`
Expected: `obs-websocket-js` appears in package.json dependencies

- [ ] **Step 2: Write failing test** (fake client + fake settings; no real OBS/timer used, test safety valve with `vi.useFakeTimers`, real time for remainder):

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

// Serial chain is asynchronous; settle after each step
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("recorderService", () => {
  it("disabled → does not touch OBS at all", async () => {
    const { svc, calls } = setup({ enabled: false });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(calls).toEqual([]);
  });

  it("open→close: starts/stops + persists index; meta arriving early (buffered) still associates", async () => {
    const { svc, recordings, calls } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(calls).toEqual(["connect", "start"]);
    // match message arrives before segmentClose (standard parser event order)
    svc.associate({ id: "m1", startTime: T0, endTime: T0 + 300_000 });
    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false });
    await settle();
    expect(recordings.getForMatch("m1")).not.toBeNull();
  });

  it("meta arriving late (recording already saved) associates directly", async () => {
    const { svc, recordings } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false });
    await settle();
    svc.associate({ id: "m2", startTime: T0, endTime: T0 + 300_000 });
    expect(recordings.getForMatch("m2")).not.toBeNull();
  });

  it("connect failure: sets lastError, does not throw, close is no-op", async () => {
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

  it("duplicate open ignored; stop() stops active recording and disconnects", async () => {
    const { svc, calls, recordings } = setup();
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentOpen({ startTime: T0 + 1, bracket: "3v3" });
    await settle();
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
    await svc.stop();
    expect(calls).toContain("stop");
    expect(calls).toContain("disconnect");
    expect(recordings.list()).toHaveLength(1); // Persists index before exiting
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/main/recorder.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 4: Implement obsClient.ts**

```ts
import OBSWebSocket from "obs-websocket-js";

export interface ObsClientLike {
  /* See Interfaces */
}

/** Real implementation is a thin shell: surface area reduced to 4+1 methods, recorder unit tests use fakes. */
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

- [ ] **Step 5: Implement recorder.ts**

Implement according to behavioral specifications 1–8:

```ts
import type { ObsClientLike } from "./obsClient";
import { RecordingsStore, type RecordingEntry } from "./recordingsStore";
import { DEFAULT_OBS_WS_URL } from "../shared/protocol";

export { DEFAULT_OBS_WS_URL };
const SAFETY_STOP_MS = 40 * 60_000;
const META_BUFFER_CAP = 20;

type Deps = {
  getSettings: () => {
    recordingEnabled: boolean;
    obsWebsocketUrl: string | null;
    obsWebsocketPassword: string | null;
    recordingKeepCount: number;
  };
  recordings: RecordingsStore;
  clientFactory: () => ObsClientLike;
  emit: (channel: string, payload: unknown) => void;
  now?: () => number;
};

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
        /* Index corruption does not affect match storage */
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
            /* Exit path best-effort */
          }
          try {
            await client?.disconnect();
          } catch {
            /* Same as above */
          }
          connected = false;
          res();
        }),
      );
    },
  };
}
```

- [ ] **Step 6: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/main/recorder.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/package.json package-lock.json packages/desktop/src/main/obsClient.ts packages/desktop/src/main/recorder.ts packages/desktop/src/main/recorder.test.ts
git commit -m "feat(desktop): recorderService — obs-websocket external start/stop + time window association + safety valve"
```

---

### Task 5: Recording Settings (Fields + Masking + Validation)

**Files:**

- Modify: `packages/desktop/src/shared/protocol.ts`
- Modify: `packages/desktop/src/main/settingsStore.ts`
- Modify: `packages/desktop/src/main/recorder.ts` (re-export constant)
- Test: `packages/desktop/src/main/settingsStore.recording.test.ts`

**Interfaces:**

- Produces: `GladlogSettings` new fields `recordingEnabled: boolean` (default false), `obsWebsocketUrl: string | null` (null → UI displays `DEFAULT_OBS_WS_URL`), `obsWebsocketPassword: string | null`, `recordingKeepCount: number` (default 50, 0 = no prune); `shared/protocol.ts` new constants `OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__"`, `DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455"`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { redactSettings, sanitizeSettingsPatch } from "./settingsStore";
import { OBS_PASSWORD_REDACTED } from "../shared/protocol";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SettingsStore } from "./settingsStore";

describe("recording settings", () => {
  it("reading legacy config file populates default values", () => {
    const s = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "settings.json"),
    );
    const v = s.get();
    expect(v.recordingEnabled).toBe(false);
    expect(v.recordingKeepCount).toBe(50);
    expect(v.obsWebsocketUrl).toBeNull();
  });

  it("redact: password replaced with sentinel; null remains null", () => {
    const base = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "s.json"),
    ).get();
    expect(
      redactSettings({ ...base, obsWebsocketPassword: "hunter2" })
        .obsWebsocketPassword,
    ).toBe(OBS_PASSWORD_REDACTED);
    expect(redactSettings(base).obsWebsocketPassword).toBeNull();
  });

  it("sanitize: sentinel not written back; invalid keepCount discarded", () => {
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

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/main/settingsStore.recording.test.ts`
Expected: FAIL (fields/constants do not exist)

- [ ] **Step 3: Implement**

In `shared/protocol.ts` (alongside `API_KEY_REDACTED`):

```ts
/** Readback sentinel for OBS websocket password (matches API_KEY_REDACTED pattern). */
export const OBS_PASSWORD_REDACTED = "__gladlog_obs_password_set__";
/** Default OBS 28+ websocket address (single source shared between renderer placeholder and main connection). */
export const DEFAULT_OBS_WS_URL = "ws://127.0.0.1:4455";
```

`settingsStore.ts`:

- Add 4 fields to `GladlogSettings` (comment noting 2026-07-28 Route C Phase 1); add `recordingEnabled: false, obsWebsocketUrl: null, obsWebsocketPassword: null, recordingKeepCount: 50` to `DEFAULTS`.
- In `redactSettings` return value add:

```ts
obsWebsocketPassword: s.obsWebsocketPassword ? OBS_PASSWORD_REDACTED : null,
```

- In `sanitizeSettingsPatch` add two blocks:

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

`recorder.ts`: Remove local `DEFAULT_OBS_WS_URL` definition, change to `import { DEFAULT_OBS_WS_URL } from "../shared/protocol";` and retain re-export.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/main/settingsStore.recording.test.ts packages/desktop/src/main/recorder.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/protocol.ts packages/desktop/src/main/settingsStore.ts packages/desktop/src/main/recorder.ts packages/desktop/src/main/settingsStore.recording.test.ts
git commit -m "feat(desktop): 4 recording settings fields (password sentinel masking + keepCount validation)"
```

---

### Task 6: vod:// Serving Protocol (Range Support)

**Files:**

- Create: `packages/desktop/src/shared/vod.ts` (pure functions, electron-free, testable)
- Create: `packages/desktop/src/main/vodProtocol.ts` (electron wiring)
- Test: `packages/desktop/src/shared/vod.test.ts`

**Interfaces:**

- Produces:

```ts
// shared/vod.ts
export const VOD_SCHEME = "vod";
export function vodUrl(path: string): string; // vod://v/<base64url(path)> — token in path segment, avoiding Chrome host lowercase normalization
export function vodUrlToPath(url: string): string | null;
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null;

// main/vodProtocol.ts
export function registerVodScheme(): void; // Must be called before app ready (module top-level in index.ts)
export function handleVodProtocol(isServable: (path: string) => boolean): void; // Called in whenReady
```

- Security: `isServable` passed by caller as `(p) => recordings.list().some((r) => r.videoPath === p)` — only serves recognized files in index, preventing arbitrary file reads.

- [ ] **Step 1: Write failing test** (testing pure functions):

```ts
import { describe, expect, it } from "vitest";
import { parseRange, vodUrl, vodUrlToPath } from "./vod";

describe("vodUrl roundtrip", () => {
  it("Windows path + Chinese characters + casing fully preserved", () => {
    for (const p of [
      "C:\\Users\\Player\\Videos\\2026-07-28 20-11-05.mp4",
      "/Users/a/Movies/OBS/Match.MP4",
    ]) {
      expect(vodUrlToPath(vodUrl(p))).toBe(p);
    }
  });
  it("invalid url → null", () => {
    expect(vodUrlToPath("vod://v/%%%")).toBeNull();
    expect(vodUrlToPath("http://x/")).toBeNull();
  });
});

describe("parseRange", () => {
  it("regular range / open range / suffix range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("out of bounds end clamped to size-1; start out of bounds/inverted/missing → null", () => {
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBeNull();
    expect(parseRange("bytes=9-3", 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("chunks=0-1", 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/shared/vod.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement shared/vod.ts**

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

/** HTTP Range single segment parsing; missing/invalid → null (caller responds with full 200). */
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

- [ ] **Step 4: Implement main/vodProtocol.ts**

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

- [ ] **Step 5: Run test to confirm pass + typecheck**

Run: `npx vitest run packages/desktop/src/shared/vod.test.ts && npm run typecheck`
Expected: All PASS / 0 errors

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/shared/vod.ts packages/desktop/src/shared/vod.test.ts packages/desktop/src/main/vodProtocol.ts
git commit -m "feat(desktop): vod:// privileged serving protocol (Range support; serves index-recognized files only)"
```

---

### Task 7: main Wiring + IPC + preload

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/api.ts`
- Modify: `packages/desktop/src/preload/index.ts`

**Interfaces:**

- Consumes: Task 2 new WorkerToMain messages, Task 4 `RecorderService`, Task 6 `registerVodScheme/handleVodProtocol/vodUrl`.
- Produces: Preload surface:

```ts
recorder: {
  getStatus(): Promise<RecorderStatus>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  /** Associated recording for match; null if none. url is vod:// address; startedAt is playback anchor (epoch ms). */
  getForMatch(matchId: string): Promise<{ url: string; startedAt: number; stoppedAt: number } | null>;
  onStatus(cb: (s: RecorderStatus) => void): () => void;
};
```

- [ ] **Step 1: Wire main/index.ts**

1. In imports add:

```ts
import { createRecorderService, type RecorderService } from "./recorder";
import { realObsClient } from "./obsClient";
import { RecordingsStore } from "./recordingsStore";
import { handleVodProtocol, registerVodScheme } from "./vodProtocol";
```

2. At module top level (after `app.setName("gladlog")`, before any ready): `registerVodScheme();`
3. In module state variables: `let recorder: RecorderService | null = null;`
4. In `onWorkerMessage` `match|shuffle` branch, after `store.store` add:

```ts
if (r.stored && r.meta) {
  recorder?.associate(r.meta);
  win?.webContents.send("gladlog:logs:matchStored", r.meta);
}
```

5. At end of `onWorkerMessage` add two branches:

```ts
} else if (msg.type === "segmentOpen") {
  recorder?.onSegmentOpen({ startTime: msg.startTime, bracket: msg.bracket });
} else if (msg.type === "segmentClose") {
  recorder?.onSegmentClose({ endTime: msg.endTime, aborted: msg.aborted });
}
```

6. Inside `whenReady` (after `icons`, before `registerIpc`):

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

7. In `registerIpc` deps add `recorder: recorder!,`.
8. Update `window-all-closed`:

```ts
app.on("window-all-closed", () => {
  void recorder?.stop();
  host?.stop();
  app.quit();
});
```

- [ ] **Step 2: ipc.ts**

Add `recorder: RecorderService;` to deps type (`import type { RecorderService } from "./recorder";`), add handlers in function body:

```ts
import { vodUrl } from "../shared/vod";

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

- [ ] **Step 3: Update preload in two places**

`api.ts`: Add `recorder` surface to `GladlogApi` (see Interfaces).
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

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test --workspace=packages/desktop`
Expected: 0 errors / All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): recorder wiring — worker event routing / IPC / preload / vod serving / exit cleanup"
```

---

### Task 8: VideoDock (Replay Video Follower Component)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/VideoDock.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx` (add `matchId?: string` to props; mount above controls)
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (pass `matchId={resolvedMatchId}` to `<ReplayView ...>` at line 305)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx`

**Interfaces:**

- Consumes: Task 7 preload `recorder.getForMatch`; ReplayView local `t` (absolute ms) / `playing` / `speed`.
- Produces: `<VideoDock matchId t playing speed />`. **video is a follower of `t`**: realigns `currentTime = (t - startedAt)/1000` when drift exceeds ±0.35s; does not write back to `t`. If no associated recording → entire component renders null (zero DOM placeholder).

- [ ] **Step 1: Write failing test**

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
  it("no associated recording → does not render", async () => {
    stubBridge(null);
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("has recording → renders video, src uses vod url, currentTime aligns to anchor", async () => {
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

  it("bridge fixture missing recorder surface → silently renders nothing without throwing", async () => {
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {};
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx`
Expected: FAIL (component does not exist)

- [ ] **Step 3: Implement VideoDock.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import { bridge } from "../../bridge";

interface RecInfo {
  url: string;
  startedAt: number;
  stoppedAt: number;
}

/** Match recording (OBS external control Phase 1). video is a follower of replay clock t —
 * does not drive its own clock, only realigns when drift >0.35s, allowing 10+ existing seek entrypoints to work with zero modifications.
 * Missing start (log lag before recording starts) manifests as video pausing on frame 0 during first few seconds, acceptable for Phase 1. */
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
      // Test fixtures often lack recorder surface — hide silently if missing
      void bridge()
        .recorder?.getForMatch(matchId)
        .then((r) => {
          if (alive) setRec(r);
        })
        .catch(() => {});
    } catch {
      /* Bridge lacks surface */
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
      /* jsdom lacks media implementation */
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
        🎥 Recording{open ? " ▾" : " ▸"}
      </button>
      {open &&
        (failed ? (
          <p className="rpt-dim">
            Unable to play this recording (recommend setting OBS recording format to Hybrid MP4)
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

- [ ] **Step 4: Mount component**

`ReplayView.tsx`:

- Add `matchId?: string;` to props interface (comment: `/** Query associated recording; omitted (export page / testbench) → does not display video */`), destructure `matchId` in function signature.
- Import `import { VideoDock } from "./VideoDock";`.
- Before `<div className="rpt-replay-controls">` insert:

```tsx
{
  matchId && (
    <VideoDock matchId={matchId} t={t} playing={playing} speed={speed} />
  );
}
```

In `MatchReport.tsx` add `matchId={resolvedMatchId}` to `<ReplayView` (line 305).

At end of `styles.css`:

```css
/* ── Recording Dock (OBS External Control Phase 1) ── */
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

- [ ] **Step 5: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx && npm test --workspace=packages/desktop`
Expected: All PASS (existing ReplayView tests do not regress — matchId is optional prop)

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/VideoDock.tsx packages/desktop/src/renderer/src/report/components/VideoDock.test.tsx packages/desktop/src/renderer/src/report/components/ReplayView.tsx packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): VideoDock — match video playback following replay clock (zero changes needed for seek entrypoints)"
```

---

### Task 9: SettingsPanel Recording Group

**Files:**

- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`

**Interfaces:**

- Consumes: Task 5 settings fields and `OBS_PASSWORD_REDACTED`/`DEFAULT_OBS_WS_URL` (imported from `../../../shared/protocol` — **shared, not main**); Task 7 preload `recorder.testConnection`.

- [ ] **Step 1: Implement**

1. Add `"recording"` to `SettingsGroup`: `type SettingsGroup = "game" | "ai" | "recording";`
2. Add state:

```tsx
const [obsUrlInput, setObsUrlInput] = useState("");
const [obsPwInput, setObsPwInput] = useState("");
const [obsTest, setObsTest] = useState<string | null>(null);
```

In initial `useEffect`: `setObsUrlInput(s.obsWebsocketUrl ?? "");`.
3. Add new section after AI section `</section>` (following existing 3-column grid pattern):

```tsx
<section className="dash-card">
  {groupHead("Match Recording (OBS)", "recording")}
  <div className="settings-grid">
    <span className="settings-k">Auto Recording</span>
    <span className="settings-v">
      Requires OBS 28+ with WebSocket server enabled (Tools → WebSocket Server Settings);
      Recommended recording format is Hybrid MP4. Automatically starts on match begin, stops on match end, and associates with the match.
    </span>
    <button
      onClick={() =>
        void save(
          { recordingEnabled: !settings.recordingEnabled },
          settings.recordingEnabled ? "Auto recording disabled" : "Auto recording enabled",
          "recording",
        )
      }
    >
      {settings.recordingEnabled ? "Disable" : "Enable"}
    </button>

    <span className="settings-k">WebSocket Address</span>
    <input
      placeholder={DEFAULT_OBS_WS_URL}
      value={obsUrlInput}
      onChange={(e) => setObsUrlInput(e.target.value)}
      onBlur={() =>
        void save(
          { obsWebsocketUrl: obsUrlInput.trim() || null },
          "Address saved",
          "recording",
        )
      }
    />
    <span />

    <span className="settings-k">WebSocket Password</span>
    <span className="settings-key-cell">
      {settings.obsWebsocketPassword === OBS_PASSWORD_REDACTED ? (
        <span className="settings-pill-ok">Configured</span>
      ) : (
        <span className="settings-v">Not configured (leave empty if OBS authentication is disabled)</span>
      )}
      <input
        type="password"
        placeholder="Enter to change"
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
            "Password saved",
            "recording",
          );
          setObsPwInput("");
        }}
      >
        Save
      </button>
      <button
        onClick={() =>
          void bridge()
            .recorder.testConnection()
            .then((r) =>
              setObsTest(r.ok ? "✓ Connection successful" : `✗ ${r.error ?? "Connection failed"}`),
            )
        }
      >
        Test Connection
      </button>
    </span>

    <span className="settings-k">Retain Recordings</span>
    <span>
      <input
        type="number"
        min={0}
        style={{ width: "5em" }}
        value={settings.recordingKeepCount}
        onChange={(e) =>
          void save(
            { recordingKeepCount: Math.max(0, Number(e.target.value) || 0) },
            "Retention policy saved",
            "recording",
          )
        }
      />
      <span className="settings-note">
        Latest N matches, 0 = keep all (excess videos are deleted from disk)
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

Import `OBS_PASSWORD_REDACTED, DEFAULT_OBS_WS_URL` from `"../../../shared/protocol"`.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test --workspace=packages/desktop`
Expected: 0 errors / All PASS

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(desktop): settings panel recording group (toggle / address / password mask / test connection / retention policy)"
```

---

### Task 10: Wrap-up — Presubmit, Cross-AI Review, Documentation

- [ ] **Step 1: Full Gate**

Run: `npm run presubmit`
Expected: All green (whole repo lint + typecheck + all workspace tests + verify:vision + electron-vite build; build step catches renderer importing main values). Fix any failures until all pass; do not add pipes.

- [ ] **Step 2: Update BACKLOG**

Append a line to the blockquote in `docs/BACKLOG.md` #1:

```
> **2026-07-28 Phase 1 kick-off**: Route C external control obs-websocket, `feature/obs-recording`
> branch; plan `docs/plans/2026-07-28-obs-recording-phase1-plan.md`.
```

- [ ] **Step 3: Commit + push branch**

```bash
git add docs/BACKLOG.md docs/plans/2026-07-28-obs-recording-phase1-plan.md
git commit -m "docs: OBS recording phase 1 implementation plan + backlog status"
git push -u origin feature/obs-recording
```

- [ ] **Step 4: Cross-AI Review (agy-review skill)**

Export `git diff main...feature/obs-recording` following `.claude/skills/agy-review` workflow, focusing on: race conditions in recorder promise chain (back-to-back matches), vod protocol path validation, settings sentinel roundtrip, pipeline rotation branch. Address items following skill criteria, rerun presubmit after fixes.

- [ ] **Step 5: CI Observation**

Run `gh run list --branch feature/obs-recording`, find run by headSha, then `gh run watch <id> --exit-status`. If changes to SettingsPanel/ReplayView cause `report-*`/settings visual baselines to fail red, regenerate using desktop-dev CI baseline recipe + human review (**never run test:visual locally**).

**Phase 1 Acceptance Criteria** (report honestly, state clearly what cannot be done):
- Unit test layer: parser lifecycle 4 tests, pipeline forwarding 2, recordingsStore 4, recorder 5, settings 3, vod 4, VideoDock 3 all green.
- Hardware/system layer: Requires real Windows + OBS testing (play an arena match: auto start/stop recording, `recordings.ndjson` records association row, replay page displays video with responsive seeking). **Cannot be completed on local machine (macOS, without WoW/OBS environment); logged as post-push user testing item**, do not claim "end-to-end verified".
