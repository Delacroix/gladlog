import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManagedObsBackend } from "./managedObsBackend";
import type { ManagedObsWs } from "./managedObsClient";

/** POISON marker: task-4 brief rule 1 — StopRecord.outputPath keeps
 * returning the FIRST chunk after any split and must NEVER be read by the
 * backend. Modeled as a throwing getter so any access — not just a wrong
 * value slipping through — fails the test immediately ("读了就炸"). */
function poisonOutputPath(): { readonly outputPath: string } {
  return {
    get outputPath(): string {
      throw new Error(
        "POISON: StopRecord.outputPath 被读取了(规则1:分片后它只返回第一个分片,绝不可信)",
      );
    },
  };
}

/** Minimal writable 24bpp BMP encoder — just enough for captureProbe's
 * decoder to round-trip a fixed luminance. Real OBS writes the file at
 * imageFilePath as a side effect of SaveSourceScreenshot resolving; this
 * fake does the same so captureProbe's disk-read path is exercised for
 * real, not mocked away. */
function writeSolidBmp(
  path: string,
  width: number,
  height: number,
  gray: number,
): void {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;
  const buf = Buffer.alloc(fileSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y++) {
    const rowStart = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const off = rowStart + x * 3;
      buf[off] = gray; // B
      buf[off + 1] = gray; // G
      buf[off + 2] = gray; // R
    }
    // Remaining bytes in the row (padding to a 4-byte boundary) are already
    // zero from Buffer.alloc — nothing further to write.
  }
  writeFileSync(path, buf);
}

/** Records call/on ordering globally so tests can assert "listeners attached
 * before StartRecord" (task-4 brief rule 1). */
class FakeManagedObsWs implements ManagedObsWs {
  connectCalls: Array<{ url: string; password: string }> = [];
  callLog: Array<{ req: string; data?: Record<string, unknown> }> = [];
  onLog: string[] = [];
  callOrder: string[] = [];
  disconnectCalls = 0;
  listeners = new Map<string, Array<(d: Record<string, unknown>) => void>>();

  /** Test hook: what call() should do for a given request. Defaults below;
   * individual tests override entries to simulate failures/timeouts/side
   * effects (e.g. emitting an event synchronously, matching how close in
   * time obs-websocket's request-response and event delivery really are). */
  handlers: Record<
    string,
    (data?: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    StartRecord: async () => ({}),
    StopRecord: async () =>
      poisonOutputPath() as unknown as Record<string, unknown>,
    SplitRecordFile: async () => ({}),
    CreateInput: async () => ({ inputUuid: "fake-uuid" }),
    CreateRecordChapter: async () => ({}),
    SaveSourceScreenshot: async () => ({}),
  };

  async connect(url: string, password: string): Promise<void> {
    this.connectCalls.push({ url, password });
  }

  async call(
    req: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.callLog.push({ req, data });
    this.callOrder.push(`call:${req}`);
    const h = this.handlers[req];
    if (!h) throw new Error(`FakeManagedObsWs: 未预设的请求 ${req}`);
    return h(data);
  }

  on(event: string, cb: (data: Record<string, unknown>) => void): void {
    this.onLog.push(event);
    this.callOrder.push(`on:${event}`);
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }

  /** Test-only: fire every registered listener for `event`. */
  emit(event: string, data: Record<string, unknown>): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }
}

let recDir: string;
let fake: FakeManagedObsWs;
let ensureProcess: ReturnType<typeof vi.fn>;
let nowMs: number;
let now: () => number;

beforeEach(() => {
  recDir = mkdtempSync(join(tmpdir(), "gladlog-managed-obs-backend-"));
  fake = new FakeManagedObsWs();
  ensureProcess = vi.fn(async () => ({
    wsUrl: "ws://127.0.0.1:4466",
    wsPassword: "pw",
  }));
  nowMs = 1_000_000;
  now = () => nowMs;
});

afterEach(() => {
  rmSync(recDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeBackend() {
  return createManagedObsBackend({
    ensureProcess,
    recDir,
    clientFactory: () => fake,
    now,
  });
}

describe("startContinuous — 监听顺序 + 首分片", () => {
  it("attaches RecordStateChanged/RecordFileChanged listeners BEFORE calling StartRecord", async () => {
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    const backend = makeBackend();
    await backend.startContinuous();
    const onIdx = fake.callOrder.indexOf("on:RecordStateChanged");
    const callIdx = fake.callOrder.indexOf("call:StartRecord");
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(onIdx).toBeLessThan(callIdx);
    const onFileIdx = fake.callOrder.indexOf("on:RecordFileChanged");
    expect(onFileIdx).toBeGreaterThanOrEqual(0);
    expect(onFileIdx).toBeLessThan(callIdx);
  });

  it("takes the first chunk's path from RecordStateChanged STARTED (undocumented outputPath), never from a directory scan when the event is present", async () => {
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputActive: true,
        outputPath: "/rec/chunk-from-event.mp4",
      });
      return {};
    };
    // Poison the directory scan path: if the backend falls back to scanning
    // despite having a perfectly good event, it would pick this file up and
    // get the WRONG path.
    writeFileSync(join(recDir, "decoy.mp4"), "decoy");

    const backend = makeBackend();
    const opened: Array<{ videoPath: string }> = [];
    backend.onChunkOpened((c) => opened.push(c));
    await backend.startContinuous();

    expect(opened).toHaveLength(1);
    expect(opened[0]!.videoPath).toBe("/rec/chunk-from-event.mp4");
  });

  it("falls back to scanning recDir for the newest mp4 when STARTED never carries outputPath", async () => {
    // StartRecord succeeds but (unlike the happy-path fake above) never
    // emits RecordStateChanged at all — simulating the undocumented
    // behavior simply not showing up.
    writeFileSync(join(recDir, "older.mp4"), "old");
    // Deterministic mtime ordering (no real-time sleep, which would be
    // pointless once fake timers freeze the clock below): backdate the
    // "older" file explicitly instead of racing the filesystem's clock
    // resolution.
    utimesSync(join(recDir, "older.mp4"), new Date(0), new Date(0));
    writeFileSync(join(recDir, "newest.mp4"), "new");

    vi.useFakeTimers();
    const backend = makeBackend();
    const opened: Array<{ videoPath: string }> = [];
    backend.onChunkOpened((c) => opened.push(c));
    const p = backend.startContinuous();
    await vi.runAllTimersAsync();
    await p;

    expect(opened).toHaveLength(1);
    expect(opened[0]!.videoPath).toBe(join(recDir, "newest.mp4"));
  });

  it("is idempotent: calling startContinuous twice only calls StartRecord once", async () => {
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    const backend = makeBackend();
    await backend.startContinuous();
    await backend.startContinuous();
    const startCalls = fake.callLog.filter((c) => c.req === "StartRecord");
    expect(startCalls).toHaveLength(1);
  });
});

describe("splitChunk — 等事件才 resolve", () => {
  async function openFirstChunk(backend: ReturnType<typeof makeBackend>) {
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    await backend.startContinuous();
  }

  it("waits for RecordFileChanged before resolving, and the closed chunk's stoppedAt/videoPath are correct", async () => {
    const backend = makeBackend();
    await openFirstChunk(backend);
    nowMs = 1_000_500;

    fake.handlers.SplitRecordFile = async () => {
      // Event arrives asynchronously, after the request resolves —
      // exercising the "wait" path for real rather than a synchronous emit.
      queueMicrotask(() =>
        fake.emit("RecordFileChanged", { newOutputPath: "/rec/chunk2.mp4" }),
      );
      return {};
    };

    const closed = await backend.splitChunk();
    expect(closed).not.toBeNull();
    expect(closed!.videoPath).toBe("/rec/chunk1.mp4");
    expect(closed!.startedAt).toBe(1_000_000);
    expect(closed!.stoppedAt).toBe(1_000_500);
  });

  it("chains correctly across two splits: second split's closed chunk is chunk2, not chunk1", async () => {
    const backend = makeBackend();
    await openFirstChunk(backend);

    fake.handlers.SplitRecordFile = async () => {
      queueMicrotask(() =>
        fake.emit("RecordFileChanged", { newOutputPath: "/rec/chunk2.mp4" }),
      );
      return {};
    };
    nowMs = 1_000_500;
    const closed1 = await backend.splitChunk();
    expect(closed1!.videoPath).toBe("/rec/chunk1.mp4");

    fake.handlers.SplitRecordFile = async () => {
      queueMicrotask(() =>
        fake.emit("RecordFileChanged", { newOutputPath: "/rec/chunk3.mp4" }),
      );
      return {};
    };
    nowMs = 1_001_000;
    const closed2 = await backend.splitChunk();
    expect(closed2!.videoPath).toBe("/rec/chunk2.mp4");
    expect(closed2!.startedAt).toBe(1_000_500);
    expect(closed2!.stoppedAt).toBe(1_001_000);
  });

  it("times out after 5s if RecordFileChanged never arrives, and records lastError", async () => {
    vi.useFakeTimers();
    const backend = makeBackend();
    await openFirstChunk(backend);

    fake.handlers.SplitRecordFile = async () => ({}); // never emits the event

    const splitPromise = backend.splitChunk();
    await vi.advanceTimersByTimeAsync(5_001);
    const closed = await splitPromise;

    expect(closed).toBeNull();
    const health = await backend.probe();
    expect(health.lastError).toMatch(/RecordFileChanged|超时/);
  });
});

describe("stopContinuous — 绝不读 StopRecord.outputPath", () => {
  it("returns the tracked current chunk (poisoned outputPath never accessed)", async () => {
    const backend = makeBackend();
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    await backend.startContinuous();
    nowMs = 1_002_000;

    const closed = await backend.stopContinuous();
    expect(closed).not.toBeNull();
    expect(closed!.videoPath).toBe("/rec/chunk1.mp4");
    expect(closed!.stoppedAt).toBe(1_002_000);
    // If the implementation had touched `.outputPath` on StopRecord's
    // response, the poisoned getter above would have thrown synchronously
    // inside the call and this test would already have failed loudly.
  });
});

describe("markChapter — 失败静默", () => {
  it("does not throw and does not surface an error when CreateRecordChapter rejects", async () => {
    const backend = makeBackend();
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    await backend.startContinuous();
    const before = (await backend.probe()).lastError;

    fake.handlers.CreateRecordChapter = async () => {
      throw new Error("hybrid_mp4 only, this container doesn't support it");
    };
    await expect(backend.markChapter("first blood")).resolves.toBeUndefined();

    const after = (await backend.probe()).lastError;
    expect(after).toBe(before);
  });

  it("calls CreateRecordChapter with the chapter name on success", async () => {
    const backend = makeBackend();
    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    await backend.startContinuous();
    await backend.markChapter("first blood");
    const call = fake.callLog.find((c) => c.req === "CreateRecordChapter");
    expect(call?.data).toEqual({ chapterName: "first blood" });
  });
});

describe("onChunkOpened — 退订生效", () => {
  it("stops receiving callbacks after unsubscribing", async () => {
    const backend = makeBackend();
    const opened: string[] = [];
    const unsubscribe = backend.onChunkOpened((c) => opened.push(c.videoPath));

    fake.handlers.StartRecord = async () => {
      fake.emit("RecordStateChanged", {
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "/rec/chunk1.mp4",
      });
      return {};
    };
    await backend.startContinuous();
    expect(opened).toEqual(["/rec/chunk1.mp4"]);

    unsubscribe();

    fake.handlers.SplitRecordFile = async () => {
      queueMicrotask(() =>
        fake.emit("RecordFileChanged", { newOutputPath: "/rec/chunk2.mp4" }),
      );
      return {};
    };
    await backend.splitChunk();
    expect(opened).toEqual(["/rec/chunk1.mp4"]); // unchanged — no chunk2 entry
  });
});

describe("configureSession + captureProbe — 黑帧判定进 sourceActive", () => {
  it("configureSession creates the game_capture input with the pinned settings", async () => {
    const backend = makeBackend();
    fake.handlers.SaveSourceScreenshot = async (data) => {
      writeSolidBmp(data!.imageFilePath as string, 4, 4, 0); // black
      return {};
    };
    await backend.configureSession();

    const create = fake.callLog.find((c) => c.req === "CreateInput");
    expect(create?.data).toMatchObject({
      inputKind: "game_capture",
      inputSettings: {
        capture_mode: "any_fullscreen",
        priority: 2,
        anti_cheat_hook: true,
      },
    });
    const health = await backend.probe();
    expect(health.encoder).toBe("obs_x264");
  });

  it("captureProbe calls SaveSourceScreenshot and a black screenshot flips sourceActive to false", async () => {
    const backend = makeBackend();
    fake.handlers.SaveSourceScreenshot = async (data) => {
      writeSolidBmp(data!.imageFilePath as string, 4, 4, 0); // all-black
      return {};
    };
    await backend.configureSession();

    const shotCall = fake.callLog.find((c) => c.req === "SaveSourceScreenshot");
    expect(shotCall).toBeDefined();

    const { black } = await backend.captureProbe();
    expect(black).toBe(true);
    const health = await backend.probe();
    expect(health.sourceActive).toBe(false);
  });

  it("captureProbe with a normal (bright) screenshot flips sourceActive to true", async () => {
    const backend = makeBackend();
    fake.handlers.SaveSourceScreenshot = async (data) => {
      writeSolidBmp(data!.imageFilePath as string, 4, 4, 180); // bright
      return {};
    };
    await backend.configureSession();

    const { black } = await backend.captureProbe();
    expect(black).toBe(false);
    const health = await backend.probe();
    expect(health.sourceActive).toBe(true);
  });
});
