import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CaptureBackend, CaptureChunk } from "./captureBackend";
import type { ManagedObsBackend } from "./managedObsBackend";
import type { RecorderStatus } from "./recorder";
import {
  assembleManagedRecording,
  createManagedAssemblyState,
  teardownManagedRecording,
  type AssembleManagedRecordingDeps,
} from "./managedAssembly";

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p });
}

/** One mutable bag of counters/refs the fake deps below all write into --
 * simpler for these tests than per-field getters, and easy to read at the
 * assertion site. */
class Harness {
  order: string[] = [];
  statuses: RecorderStatus[] = [];
  installed: boolean;
  recorderManagedBackend: CaptureBackend | null = null;
  recorderManagedProcessStop: (() => Promise<void>) | null = null;
  watchStartCalls = 0;
  watchStopCalls = 0;
  onWowUpCalls = 0;
  onWowDownCalls = 0;
  handleStopCalls = 0;
  state = createManagedAssemblyState();
  deps: AssembleManagedRecordingDeps;

  constructor(opts?: {
    enabled?: boolean;
    mode?: "managed" | "external";
    installed?: boolean;
    configureSession?: () => Promise<void>;
    probe?: () => Promise<{
      ready: boolean;
      encoder: string | null;
      sourceActive: boolean;
      lastError: string | null;
    }>;
  }) {
    this.installed = opts?.installed ?? true;
    const backend: ManagedObsBackend = {
      startContinuous: async () => {},
      stopContinuous: async () => null,
      splitChunk: async () => null,
      onChunkOpened: (_cb: (c: CaptureChunk) => void) => () => {},
      markChapter: async () => {},
      probe:
        opts?.probe ??
        (async () => {
          this.order.push("probe");
          return {
            ready: true,
            encoder: "obs_x264",
            sourceActive: true,
            lastError: null,
          };
        }),
      shutdown: async () => {},
      configureSession:
        opts?.configureSession ??
        (async () => {
          this.order.push("configureSession");
        }),
      captureProbe: async () => ({ shotPath: "", black: false }),
    };

    this.deps = {
      state: this.state,
      getSettings: () => ({
        recordingEnabled: opts?.enabled ?? true,
        recordingMode: opts?.mode ?? "managed",
      }),
      getWsPassword: () => {
        this.order.push("getWsPassword");
        return "deadbeef";
      },
      recDir: "/tmp/gladlog-recdir",
      assets: {
        root: "/tmp/gladlog-obs-root",
        installed: () => {
          this.order.push("assets.installed");
          return this.installed;
        },
      },
      writeObsConfig: () => {
        this.order.push("writeObsConfig");
      },
      clearSentinels: () => {
        this.order.push("clearSentinels");
      },
      spawnManagedObs: () => {
        this.order.push("spawnManagedObs");
        return {
          ready: Promise.resolve({ wsUrl: "ws://127.0.0.1:4466" }),
          onLogLine: () => () => {},
          stop: async () => {
            this.handleStopCalls++;
            this.order.push("handle.stop");
          },
          killSync: () => {
            this.order.push("handle.killSync");
          },
          exited: () => null,
          pid: () => 4321,
        };
      },
      createManagedObsBackend: () => {
        this.order.push("createManagedObsBackend");
        return backend;
      },
      createWowProcessWatch: () => {
        this.order.push("createWowProcessWatch");
        return {
          start: () => {
            this.order.push("watch.start");
            this.watchStartCalls++;
          },
          stop: () => {
            this.order.push("watch.stop");
            this.watchStopCalls++;
          },
        };
      },
      setRecorderManagedBackend: (b) => {
        this.recorderManagedBackend = b;
      },
      setRecorderManagedProcessStop: (fn) => {
        this.recorderManagedProcessStop = fn;
      },
      onWowUp: () => {
        this.onWowUpCalls++;
      },
      onWowDown: () => {
        this.onWowDownCalls++;
      },
      emitStatus: (status) => {
        this.statuses.push(status);
      },
    };
  }
}

describe("assembleManagedRecording (task-5b Step 1 测试矩阵)", () => {
  // isManagedActive()'s third term requires win32 — same convention as
  // recorder.test.ts's "recorderService 托管循环" describe block.
  beforeEach(() => {
    setPlatform("win32");
  });
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("① 未安装 → 不 spawn、不下载,status 报「待安装」,不标记 running", async () => {
    const h = new Harness({ installed: false });
    await assembleManagedRecording(h.deps);
    expect(h.order).toEqual(["assets.installed"]);
    expect(h.state.running).toBe(false);
    expect(h.statuses).toHaveLength(1);
    expect(h.statuses[0]!.lastError).toContain("未安装");
    expect(h.statuses[0]!.connected).toBe(false);
  });

  it("② 已安装 → 配置写入→spawn→configureSession→watch 启动的顺序;watcher 恰好启动一次", async () => {
    const h = new Harness({ installed: true });
    await assembleManagedRecording(h.deps);
    expect(h.order).toEqual([
      "assets.installed",
      "getWsPassword",
      "writeObsConfig",
      "clearSentinels",
      "spawnManagedObs",
      "createManagedObsBackend",
      "configureSession",
      "probe", // 复核 I3: post-configureSession health check (see doAssemble)
      "createWowProcessWatch",
      "watch.start",
    ]);
    expect(h.state.running).toBe(true);
    expect(h.watchStartCalls).toBe(1);
    expect(h.recorderManagedBackend).not.toBeNull();
    expect(h.recorderManagedProcessStop).not.toBeNull();
  });

  it("③ configureSession 抛错 → app 不崩(函数正常返回)、lastError 置位,顺序不变(configureSession 仍先于 watch 启动)", async () => {
    const h = new Harness({
      installed: true,
      configureSession: async () => {
        h.order.push("configureSession:throw");
        throw new Error("CreateInput 超时");
      },
    });
    await expect(assembleManagedRecording(h.deps)).resolves.toBeUndefined();
    expect(h.order.indexOf("configureSession:throw")).toBeLessThan(
      h.order.indexOf("createWowProcessWatch"),
    );
    expect(h.order).toContain("watch.start"); // assembly still completes (degraded mode)
    expect(h.state.running).toBe(true);
    const lastStatus = h.statuses.at(-1);
    expect(lastStatus?.lastError).toContain("CreateInput 超时");
  });

  it("I3(review round 2): configureSession 静默失败(真实 backend 契约,不抛)→ 事后 probe() 不 ready → emitStatus 携带 probe().lastError,而非报虚假『未连接、无错误』", async () => {
    const h = new Harness({
      installed: true,
      // The REAL managedObsBackend.ts contract: ensureConnected()/CreateInput
      // failing degrades to the backend's own internal lastError, configureSession
      // itself resolves normally (never throws) -- so the try/catch around it
      // in doAssemble is dead code for this, the DOMINANT real failure mode.
      configureSession: async () => {
        h.order.push("configureSession:silent-fail");
      },
      probe: async () => {
        h.order.push("probe");
        return {
          ready: false,
          encoder: null,
          sourceActive: false,
          lastError: "connect 失败: ECONNREFUSED",
        };
      },
    });
    await expect(assembleManagedRecording(h.deps)).resolves.toBeUndefined();
    expect(h.order.indexOf("configureSession:silent-fail")).toBeLessThan(
      h.order.indexOf("probe"),
    );
    expect(h.order.indexOf("probe")).toBeLessThan(
      h.order.indexOf("createWowProcessWatch"),
    );
    expect(h.order).toContain("watch.start"); // still completes (degraded mode)
    expect(h.state.running).toBe(true);
    expect(h.statuses).toHaveLength(1); // the ONLY status pushed comes from the probe check
    expect(h.statuses[0]?.lastError).toContain("ECONNREFUSED");
    expect(h.statuses[0]?.connected).toBe(false);
  });

  it("④ managedActive=false(三种子情形:未启用/external/非win32)→ 全程零调用", async () => {
    for (const opts of [
      { enabled: false, mode: "managed" as const },
      { enabled: true, mode: "external" as const },
    ]) {
      const h = new Harness(opts);
      await assembleManagedRecording(h.deps);
      expect(h.order).toEqual([]);
      expect(h.statuses).toEqual([]);
      expect(h.state.running).toBe(false);
    }
    setPlatform("darwin");
    try {
      const h = new Harness({ enabled: true, mode: "managed" });
      await assembleManagedRecording(h.deps);
      expect(h.order).toEqual([]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  it("幂等:并发/重复调用不二次 spawn(state.running 在首个 await 之前同步置位)", async () => {
    const h = new Harness({ installed: true });
    const p1 = assembleManagedRecording(h.deps);
    const p2 = assembleManagedRecording(h.deps); // fired before p1 has settled
    await Promise.all([p1, p2]);
    expect(h.order.filter((c) => c === "spawnManagedObs")).toHaveLength(1);
    expect(h.watchStartCalls).toBe(1);
  });

  it("配置写入抛错(同步 fs 错误):running 回退为 false,可重试", async () => {
    const h = new Harness({ installed: true });
    h.deps.writeObsConfig = () => {
      throw new Error("EACCES");
    };
    await assembleManagedRecording(h.deps);
    expect(h.state.running).toBe(false);
    expect(h.statuses.at(-1)?.lastError).toContain("EACCES");
    expect(h.order).not.toContain("spawnManagedObs");
  });
});

describe("teardownManagedRecording + toggle 序列 (复核 NEW-3)", () => {
  beforeEach(() => {
    setPlatform("win32");
  });
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("running=false 时 no-op", async () => {
    const state = createManagedAssemblyState();
    let stopCalls = 0;
    await teardownManagedRecording({
      state,
      stopRecorder: async () => {
        stopCalls++;
      },
      setRecorderManagedBackend: () => {},
      setRecorderManagedProcessStop: () => {},
      recordingEnabled: true,
      emitStatus: () => {},
    });
    expect(stopCalls).toBe(0);
  });

  it("toggle false→true→false→true:每轮 assemble 都重新 spawn,teardown 都停 watch + 调 stopRecorder + 清空 backend 引用", async () => {
    const h = new Harness({ installed: true });
    await assembleManagedRecording(h.deps);
    expect(h.state.running).toBe(true);
    expect(h.watchStartCalls).toBe(1);

    let stopRecorderCalls = 0;
    const teardownStatuses: RecorderStatus[] = [];
    await teardownManagedRecording({
      state: h.state,
      stopRecorder: async () => {
        stopRecorderCalls++;
      },
      setRecorderManagedBackend: h.deps.setRecorderManagedBackend,
      setRecorderManagedProcessStop: h.deps.setRecorderManagedProcessStop,
      recordingEnabled: true,
      emitStatus: (s) => teardownStatuses.push(s),
    });
    expect(h.state.running).toBe(false);
    expect(h.watchStopCalls).toBe(1);
    expect(stopRecorderCalls).toBe(1);
    expect(h.recorderManagedBackend).toBeNull();
    expect(h.recorderManagedProcessStop).toBeNull();
    // 复核 I6: teardown pushes its own clean status (defense-in-depth beyond
    // recorder.stop()'s own pushStatus, which recorder.test.ts covers
    // separately).
    expect(teardownStatuses).toHaveLength(1);
    expect(teardownStatuses[0]).toMatchObject({
      connected: false,
      recording: false,
      lastError: null,
    });

    // Second assemble after teardown must re-run the full sequence, not no-op.
    h.order.length = 0;
    await assembleManagedRecording(h.deps);
    expect(h.order).toContain("spawnManagedObs");
    expect(h.watchStartCalls).toBe(2);
    expect(h.state.running).toBe(true);
  });
});
