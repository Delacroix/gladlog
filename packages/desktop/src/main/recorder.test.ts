import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureBackend, CaptureChunk } from "./captureBackend";
import type { ObsClientLike } from "./obsClient";
import { createRecorderService, isManagedActive } from "./recorder";
import { RecordingsStore } from "./recordingsStore";

const T0 = 1_750_000_000_000;

function fakeClient(overrides?: Partial<ObsClientLike>) {
  const calls: string[] = [];
  let closedCb: (() => void) | null = null;
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
    getRecordStatus: async () => {
      calls.push("status");
      return { outputActive: false };
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    onClosed: (cb) => {
      closedCb = cb;
    },
    ...overrides,
  };
  // Test-only: simulate a websocket disconnect (fires the onClosed the recorder
  // registered on the client).
  return { client, calls, triggerClosed: () => closedCb?.() };
}

function setup(opts?: {
  enabled?: boolean;
  client?: ObsClientLike;
  keep?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
  const video = join(dir, "out.mp4");
  writeFileSync(video, "x");
  const fake = fakeClient();
  fake.client.stopRecord = async () => {
    fake.calls.push("stop");
    return { outputPath: video };
  };
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
      recordingMaxBytes: Number.POSITIVE_INFINITY,
    }),
    recordings,
    clientFactory: () => client,
    emit: (_ch, p) => statuses.push(p),
    now: () => (t += 1000),
  });
  return { svc, recordings, calls: fake.calls, statuses, video };
}

// The serial chain is async; wait a beat after each step
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
    expect(calls).toEqual(["connect", "status", "start"]);
    // the match message arrives before segmentClose (that's the parser's event
    // order)
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
    const { client, calls } = fakeClient({
      connect: async () => {
        calls.push("connect");
        throw new Error("refused");
      },
    });
    const { svc } = setup({ client });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(svc.getStatus().lastError).toContain("refused");
    expect(svc.getStatus().recording).toBe(false);
    expect(calls).toEqual(["connect"]);
  });

  it("stopRecord 抛错:recording 不粘死,下一场照常起录(agy #3)", async () => {
    let failNext = true;
    const { client, calls } = fakeClient();
    client.stopRecord = async () => {
      calls.push("stop");
      if (failNext) {
        failNext = false;
        throw new Error("output not active");
      }
      return { outputPath: "/tmp/x.mp4" };
    };
    const { svc } = setup({ client });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(svc.getStatus().recording).toBe(false);
    svc.onSegmentOpen({ startTime: T0 + 60_000, bracket: "3v3" });
    await settle();
    expect(calls.filter((c) => c === "start")).toHaveLength(2);
  });

  it("stopRecord 抛错时失败路径仍走配额回收(prune 不再只挂在成功路径上)", async () => {
    const { client, calls } = fakeClient();
    client.stopRecord = async () => {
      calls.push("stop");
      throw new Error("output not active");
    };
    const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
    const recordings = new RecordingsStore(dir);
    // Pre-seed an over-quota entry from a prior session: with recordingMaxBytes
    // set to 1 byte below, the byte fuse alone must evict it -- proving the
    // eviction actually ran on THIS (failing) segment-close, not just the
    // happy path.
    const excess = join(dir, "excess.mp4");
    writeFileSync(excess, Buffer.alloc(1000, 0));
    recordings.add({
      schema: 2,
      videoPath: excess,
      startedAt: T0 - 10_000,
      stoppedAt: T0 - 9_000,
      matchIds: ["old-match"],
    });
    const svc = createRecorderService({
      getSettings: () => ({
        recordingEnabled: true,
        obsWebsocketUrl: null,
        obsWebsocketPassword: null,
        recordingKeepCount: 0,
        recordingMaxBytes: 1,
      }),
      recordings,
      clientFactory: () => client,
      emit: () => {},
      now: () => T0,
    });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(svc.getStatus().lastError).toContain("output not active");
    // The current segment could not be indexed (stopRecord failed), but the
    // pre-existing over-quota entry must still be reclaimed -- this is the
    // bug the task fixes: prune() used to be called only from the success
    // path, so a run of failures never reclaimed anything.
    expect(recordings.getForMatch("old-match")).toBeNull();
  });

  it("对局中途停用设置:close 仍停录(agy #4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
    const { client, calls } = fakeClient();
    const flags = { enabled: true };
    const svc = createRecorderService({
      getSettings: () => ({
        recordingEnabled: flags.enabled,
        obsWebsocketUrl: null,
        obsWebsocketPassword: null,
        recordingKeepCount: 0,
        recordingMaxBytes: Number.POSITIVE_INFINITY,
      }),
      recordings: new RecordingsStore(dir),
      clientFactory: () => client,
      emit: () => {},
      now: () => T0,
    });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    flags.enabled = false; // user turns off auto-recording mid-match
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(calls).toContain("stop");
    expect(svc.getStatus().recording).toBe(false);
  });

  it("testConnection 优先用未保存输入;空密码/无覆盖回退已存(UX 修复)", async () => {
    const seen: Array<{ url: string; password?: string }> = [];
    const { client } = fakeClient();
    client.connect = async (url, password) => {
      seen.push({ url, password });
    };
    const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
    const svc = createRecorderService({
      getSettings: () => ({
        recordingEnabled: true,
        obsWebsocketUrl: null,
        obsWebsocketPassword: "storedpw",
        recordingKeepCount: 0,
        recordingMaxBytes: Number.POSITIVE_INFINITY,
      }),
      recordings: new RecordingsStore(dir),
      clientFactory: () => client,
      emit: () => {},
      now: () => T0,
    });
    // unsaved url + password in the input fields → use the input for both
    await svc.testConnection({ url: "ws://127.0.0.1:4466", password: "typed" });
    expect(seen[0]).toEqual({ url: "ws://127.0.0.1:4466", password: "typed" });
    // url field cleared (→ default), password field empty (→ the stored value)
    await svc.testConnection({ url: null });
    expect(seen[1]).toEqual({
      url: "ws://127.0.0.1:4455",
      password: "storedpw",
    });
    // no overrides → use the stored values for everything
    await svc.testConnection();
    expect(seen[2]).toEqual({
      url: "ws://127.0.0.1:4455",
      password: "storedpw",
    });
  });

  it("connectAtStartup 成功:status 报告已连接(review Important #2)", async () => {
    const { svc, calls, statuses } = setup();
    await svc.connectAtStartup();
    expect(calls).toEqual(["connect", "status"]);
    expect(svc.getStatus().connected).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
    // pushStatus fired at least once with the connected status (the
    // banner/settings row subscribe via onStatus, not just getStatus())
    expect(
      (statuses as Array<{ connected: boolean }>).some((s) => s.connected),
    ).toBe(true);
  });

  it("connectAtStartup 失败:lastError 置位、不抛(iron rule 同 pruneNow)", async () => {
    const { client, calls } = fakeClient({
      connect: async () => {
        calls.push("connect");
        throw new Error("refused");
      },
    });
    const { svc } = setup({ client });
    await expect(svc.connectAtStartup()).resolves.toBeUndefined();
    expect(svc.getStatus().connected).toBe(false);
    expect(svc.getStatus().lastError).toContain("refused");
  });

  it("connectAtStartup:recordingEnabled=false 时完全不碰 OBS", async () => {
    const { svc, calls } = setup({ enabled: false });
    await svc.connectAtStartup();
    expect(calls).toEqual([]);
    expect(svc.getStatus().connected).toBe(false);
  });

  it("testConnection 成功后更新 connected 并推送 status(review Important #2:点「测试连接」成功后这一行不该还说未连接)", async () => {
    const { svc, statuses } = setup();
    expect(svc.getStatus().connected).toBe(false);
    const result = await svc.testConnection();
    expect(result.ok).toBe(true);
    expect(svc.getStatus().connected).toBe(true);
    expect(
      (statuses as Array<{ connected: boolean }>).some((s) => s.connected),
    ).toBe(true);
  });

  it("testConnection 成功不该让 ensureConnected 短路在死客户端上(re-review FIX 1)", async () => {
    // Unlike every other test in this file, clientFactory here returns a
    // DIFFERENT client object each call -- matching obsClient.ts in
    // production (a brand-new OBSWebSocket per call). Every other test
    // shares one fake for both the persistent client and testConnection's
    // throwaway client, which is exactly why this bug was invisible to the
    // suite before.
    const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-"));
    const video = join(dir, "out.mp4");
    writeFileSync(video, "x");
    const calls: string[] = [];
    let closedCbA: (() => void) | null = null;
    // The persistent client used by connectAtStartup. "Dies" (its further
    // calls reject, simulating a dropped websocket) once its onClosed fires
    // -- there is no `client = null` anywhere else in recorder.ts, so a
    // buggy testConnection resurrecting `connected` would leave this exact
    // dead object referenced by the persistent `client` variable.
    let aAlive = true;
    const clientA: ObsClientLike = {
      connect: async () => {
        if (!aAlive) throw new Error("A: socket is closed");
        calls.push("A:connect");
      },
      startRecord: async () => {
        if (!aAlive) throw new Error("A: socket is closed");
        calls.push("A:start");
      },
      stopRecord: async () => {
        if (!aAlive) throw new Error("A: socket is closed");
        calls.push("A:stop");
        return { outputPath: video };
      },
      getRecordStatus: async () => {
        if (!aAlive) throw new Error("A: socket is closed");
        calls.push("A:status");
        return { outputActive: false };
      },
      disconnect: async () => {
        calls.push("A:disconnect");
      },
      onClosed: (cb) => {
        closedCbA = cb;
      },
    };
    // Wrapped in its own function (same shape as fakeClient()'s
    // triggerClosed above) rather than read inline: TS's control-flow
    // narrowing collapses a closure-captured `let` read directly in the
    // declaring scope to `never` under strict mode; reading it from inside a
    // nested function sidesteps that.
    const triggerClosedA = () => closedCbA?.();
    // The throwaway client testConnection builds internally -- healthy
    // throughout, just like a real successful probe.
    const clientB: ObsClientLike = {
      connect: async () => {
        calls.push("B:connect");
      },
      startRecord: async () => {
        calls.push("B:start");
      },
      stopRecord: async () => {
        calls.push("B:stop");
        return { outputPath: video };
      },
      getRecordStatus: async () => {
        calls.push("B:status");
        return { outputActive: false };
      },
      disconnect: async () => {
        calls.push("B:disconnect");
      },
      onClosed: () => {},
    };
    // The fresh persistent client the next real ensureConnected() must build
    // -- proves the recorder actually reconnects instead of short-circuiting
    // onto dead A.
    const clientC: ObsClientLike = {
      connect: async () => {
        calls.push("C:connect");
      },
      startRecord: async () => {
        calls.push("C:start");
      },
      stopRecord: async () => {
        calls.push("C:stop");
        return { outputPath: video };
      },
      getRecordStatus: async () => {
        calls.push("C:status");
        return { outputActive: false };
      },
      disconnect: async () => {
        calls.push("C:disconnect");
      },
      onClosed: () => {},
    };
    const queue = [clientA, clientB, clientC];
    let idx = 0;
    const recordings = new RecordingsStore(dir);
    let t = T0;
    const svc = createRecorderService({
      getSettings: () => ({
        recordingEnabled: true,
        obsWebsocketUrl: null,
        obsWebsocketPassword: null,
        recordingKeepCount: 0,
        recordingMaxBytes: Number.POSITIVE_INFINITY,
      }),
      recordings,
      clientFactory: () => queue[idx++]!,
      emit: () => {},
      now: () => (t += 1000),
    });

    // Startup: connects with A.
    await svc.connectAtStartup();
    expect(svc.getStatus().connected).toBe(true);
    expect(calls).toEqual(["A:connect", "A:status"]);

    // OBS restarts: A's onClosed fires, connected flips false -- but nothing
    // in recorder.ts ever nulls the persistent `client` reference, which
    // still points at now-dead A.
    aAlive = false;
    triggerClosedA();
    expect(svc.getStatus().connected).toBe(false);

    // User clicks 测试连接 (自动配置 routes through the same call): a
    // THROWAWAY client (B) is used for the probe, and success must not
    // resurrect `connected` for the still-dead persistent client.
    const result = await svc.testConnection();
    expect(result.ok).toBe(true);
    expect(calls).toContain("B:connect");
    expect(calls).toContain("B:disconnect");
    expect(svc.getStatus().connected).toBe(true);

    // A segment opens next: the recorder must genuinely reconnect (client C)
    // instead of short-circuiting `if (connected && client) return` onto dead
    // A and failing to record. Before the fix this assertion fails: recording
    // stays false and lastError carries "A: socket is closed".
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(calls).toContain("C:connect");
    expect(calls).toContain("C:start");
    expect(svc.getStatus().recording).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
  });

  it("断连期间 OBS 独立续录:重连后先收尾孤儿录像再起新段 (C1)", async () => {
    const { client, calls, triggerClosed } = fakeClient();
    let obsStillRecording = false;
    client.getRecordStatus = async () => {
      calls.push("status");
      return { outputActive: obsStillRecording };
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(calls).toEqual(["connect", "status", "start"]);
    expect(svc.getStatus().recording).toBe(true);

    // websocket disconnect: OBS doesn't know and keeps recording; locally
    // onClosed resets us to "not recording"
    obsStillRecording = true;
    triggerClosed();
    expect(svc.getStatus().connected).toBe(false);
    expect(svc.getStatus().recording).toBe(false);

    // next match starts: ensureConnected reconnects, GetRecordStatus finds OBS
    // still recording → first stopRecord to close out the orphan recording and
    // store it, then startRecord a new segment as usual
    svc.onSegmentOpen({ startTime: T0 + 600_000, bracket: "3v3" });
    await settle();
    expect(calls).toEqual([
      "connect",
      "status",
      "start",
      "connect",
      "status",
      "stop",
      "start",
    ]);
    expect(svc.getStatus().recording).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
    // the orphan recording is stored (matchId null, waiting for an associate
    // event to link it / or already linked)
    expect(recordings.list()).toHaveLength(1);
  });

  it("startRecord 报 already active(gladlog 自己欠账未确认停):当孤儿收尾重试,不永久失败 (C1)", async () => {
    // Scenario: match1 starts recording normally (weStartedRecording=true); at
    // close, OBS's stopRecord fails (network hiccup etc., OBS is in fact still
    // recording) — per the fix, a failure does NOT clear weStartedRecording, so
    // we still remember "this segment is my outstanding debt". When match2
    // starts the connection never dropped (ensureConnected short-circuits and
    // does not reconcile again), so startRecord runs straight into OBS's
    // already-active error; because weStartedRecording is still true (positive
    // evidence), the second line of defense steps in and retries the close-out
    // — this is exactly where we part ways with "a recording the user started
    // themselves" (weStartedRecording=false).
    let obsStillRecording = false;
    const { client, calls } = fakeClient();
    client.startRecord = async () => {
      calls.push("start");
      if (obsStillRecording) throw new Error("output already active");
      obsStillRecording = true;
    };
    client.stopRecord = async () => {
      calls.push("stop");
      throw new Error("request could not be completed"); // first close fails
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(svc.getStatus().recording).toBe(true);

    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    expect(svc.getStatus().recording).toBe(false);
    expect(svc.getStatus().lastError).toContain(
      "request could not be completed",
    );

    // make the second stopRecord succeed (the orphan close-out needs it)
    client.stopRecord = async () => {
      calls.push("stop");
      obsStillRecording = false;
      return { outputPath: "/tmp/x.mp4" };
    };

    svc.onSegmentOpen({ startTime: T0 + 60_000, bracket: "3v3" });
    await settle();

    expect(svc.getStatus().recording).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
    expect(recordings.list()).toHaveLength(1); // the orphan recording is indexed too
  });

  it("OBS 已有用户自己的手动录制(非 gladlog 发起):绝不误停,startRecord 失败走 lastError (复核轮, C1)", async () => {
    // Trap caught in the review round: judging by outputActive alone,
    // reconcileWithReality cannot tell whether "OBS is recording" means
    // "gladlog told it to". This simulates the user hitting record in OBS
    // themselves before the match (e.g. a stream backup) — weStartedRecording
    // is false throughout, and gladlog must never call StopRecord and kill the
    // user's recording just because it sees outputActive=true.
    const { client, calls } = fakeClient();
    client.getRecordStatus = async () => {
      calls.push("status");
      return { outputActive: true }; // user's manual recording, active throughout
    };
    client.startRecord = async () => {
      calls.push("start");
      throw new Error("output already active"); // real OBS behavior: refuses when already recording
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();

    expect(calls).not.toContain("stop"); // never sent StopRecord against the user's recording
    expect(svc.getStatus().recording).toBe(false);
    expect(svc.getStatus().lastError).toContain("already active");
    expect(recordings.list()).toHaveLength(0); // no orphan recording was "closed out" and stored
  });

  it("断连后没有下一场:segmentClose 凭正证据重连收尾孤儿(真机「打完录像不停」主根因)", async () => {
    // A websocket blip mid-match → onClosed sets recording=false (needed for
    // de-duplication); the match ends with no next match → doClose's first-line
    // guard used to make it a no-op, so nobody ever stopped OBS, and the same
    // guard also killed the 40-minute safety valve and the exit path. The fix:
    // with weStartedRecording as positive evidence in hand, reconnect and close
    // out the orphan — parting ways with "a recording the user started
    // themselves" (no positive evidence).
    const { client, calls, triggerClosed } = fakeClient();
    let obsStillRecording = false;
    client.startRecord = async () => {
      calls.push("start");
      obsStillRecording = true;
    };
    client.getRecordStatus = async () => {
      calls.push("status");
      return { outputActive: obsStillRecording };
    };
    client.stopRecord = async () => {
      calls.push("stop");
      obsStillRecording = false;
      return { outputPath: "/tmp/x.mp4" };
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    expect(svc.getStatus().recording).toBe(true);

    triggerClosed(); // disconnect mid-match; OBS keeps recording on its own
    expect(svc.getStatus().recording).toBe(false);

    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false }); // last match
    await settle();
    expect(calls).toContain("stop"); // under the old code this assertion always failed: OBS never stopped
    expect(recordings.list()).toHaveLength(1); // the orphan recording made it into the index
  });

  it("40 分钟安全阀在断连态不再是死的:同一正证据路径收尾(fake timers,还计划欠账)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls, triggerClosed } = fakeClient();
      let obsStillRecording = false;
      client.startRecord = async () => {
        calls.push("start");
        obsStillRecording = true;
      };
      client.getRecordStatus = async () => {
        calls.push("status");
        return { outputActive: obsStillRecording };
      };
      client.stopRecord = async () => {
        calls.push("stop");
        obsStillRecording = false;
        return { outputPath: "/tmp/x.mp4" };
      };
      const { svc } = setup({ client });

      svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
      await vi.advanceTimersByTimeAsync(20);
      expect(svc.getStatus().recording).toBe(true);

      triggerClosed(); // disconnect; END never arrives (WoW buffering / everyone leaves)
      await vi.advanceTimersByTimeAsync(40 * 60_000 + 100); // safety valve fires
      expect(calls).toContain("stop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("OBS 调用悬挂不卡死串行链:超时置错,后续场次照常(fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = fakeClient();
      let hang = true;
      client.stopRecord = () => {
        calls.push("stop");
        if (hang) return new Promise(() => {}); // the OBS stop request hangs
        return Promise.resolve({ outputPath: "/tmp/x.mp4" });
      };
      const { svc } = setup({ client });

      svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
      await vi.advanceTimersByTimeAsync(20);
      svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
      await vi.advanceTimersByTimeAsync(20_000); // past the OBS call timeout
      expect(svc.getStatus().lastError ?? "").toContain("timed out");

      // the chain isn't wedged: the next match records as usual (old code:
      // the safety valve and everything else queued up behind it forever)
      hang = false;
      svc.onSegmentOpen({ startTime: T0 + 60_000, bracket: "3v3" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.filter((c) => c === "start")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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
    expect(recordings.list()).toHaveLength(1); // index written before exit
  });
});

describe("isManagedActive (task-5 brief 复核 B2/NEW-2, single-source gate)", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("三项与式:enabled && mode==='managed' && win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(
      isManagedActive({ recordingEnabled: true, recordingMode: "managed" }),
    ).toBe(true);
    expect(
      isManagedActive({ recordingEnabled: false, recordingMode: "managed" }),
    ).toBe(false);
    expect(
      isManagedActive({ recordingEnabled: true, recordingMode: "external" }),
    ).toBe(false);
    expect(
      isManagedActive({ recordingEnabled: true, recordingMode: undefined }),
    ).toBe(false);
  });

  it("非 win32 一律 false,哪怕其余两项都满足", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(
      isManagedActive({ recordingEnabled: true, recordingMode: "managed" }),
    ).toBe(false);
  });
});

describe("recorderService 托管循环 (task-5 brief 5c, Step 3)", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  function fakeManagedBackend(overrides?: Partial<CaptureBackend>) {
    const calls: string[] = [];
    let chunkCb: ((c: CaptureChunk) => void) | null = null;
    const backend: CaptureBackend = {
      startContinuous: async () => {
        calls.push("startContinuous");
      },
      stopContinuous: async () => {
        calls.push("stopContinuous");
        return null;
      },
      splitChunk: async () => {
        calls.push("splitChunk");
        return null;
      },
      onChunkOpened: (cb) => {
        calls.push("onChunkOpened:subscribe");
        chunkCb = cb;
        return () => {
          chunkCb = null;
        };
      },
      markChapter: async (name: string) => {
        calls.push(`markChapter:${name}`);
      },
      probe: async () => {
        calls.push("probe");
        return {
          ready: true,
          encoder: "obs_x264",
          sourceActive: true,
          lastError: null,
        };
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
      ...overrides,
    };
    return {
      backend,
      calls,
      triggerChunkOpened: (c: CaptureChunk) => chunkCb?.(c),
    };
  }

  function setupManaged(opts?: {
    enabled?: boolean;
    mode?: "managed" | "external";
    backendOverrides?: Partial<CaptureBackend>;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "gladlog-recorder-managed-"));
    const recordings = new RecordingsStore(dir);
    const fb = fakeManagedBackend(opts?.backendOverrides);
    const statuses: unknown[] = [];
    const bypassCalls: string[] = [];
    const bypassClient: ObsClientLike = {
      connect: async () => {
        bypassCalls.push("connect");
      },
      startRecord: async () => {
        bypassCalls.push("start");
      },
      stopRecord: async () => {
        bypassCalls.push("stop");
        return { outputPath: "/tmp/should-not-be-used.mp4" };
      },
      getRecordStatus: async () => {
        bypassCalls.push("status");
        return { outputActive: false };
      },
      disconnect: async () => {
        bypassCalls.push("disconnect");
      },
      onClosed: () => {},
    };
    let t = T0;
    const settings = {
      recordingEnabled: opts?.enabled ?? true,
      obsWebsocketUrl: null,
      obsWebsocketPassword: null,
      recordingKeepCount: 0,
      recordingMaxBytes: Number.POSITIVE_INFINITY,
      recordingMode: opts?.mode ?? ("managed" as const),
    };
    const svc = createRecorderService({
      getSettings: () => settings,
      recordings,
      clientFactory: () => bypassClient,
      emit: (_ch, p) => statuses.push(p),
      now: () => (t += 1000),
      managedBackend: fb.backend,
    });
    return { svc, recordings, fb, statuses, bypassCalls, dir };
  }

  it("① managedActive=false 三例(未启用/external/非win32)→ 零 backend 调用", async () => {
    const a = setupManaged({ enabled: false, mode: "managed" });
    a.svc.onWowUp();
    await settle();
    expect(a.fb.calls).toEqual([]);

    const b = setupManaged({ enabled: true, mode: "external" });
    b.svc.onWowUp();
    await settle();
    expect(b.fb.calls).toEqual([]);

    Object.defineProperty(process, "platform", { value: "darwin" });
    const c = setupManaged({ enabled: true, mode: "managed" });
    c.svc.onWowUp();
    await settle();
    expect(c.fb.calls).toEqual([]);
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  it("② WoW up → startContinuous;chunk 开启事件 → recordings.openChunk", async () => {
    const { svc, recordings, fb } = setupManaged();
    svc.onWowUp();
    await settle();
    expect(fb.calls).toContain("startContinuous");
    fb.triggerChunkOpened({
      videoPath: "/tmp/c1.mp4",
      startedAt: T0,
      stoppedAt: null,
    });
    expect(recordings.list()).toHaveLength(1);
    expect(recordings.list()[0]).toMatchObject({
      videoPath: "/tmp/c1.mp4",
      startedAt: T0,
      stoppedAt: null,
    });
  });

  it("③ segmentOpen 后空闲定时器暂停;斗内绝不 split(哪怕过了 10 分钟)", async () => {
    vi.useFakeTimers();
    try {
      const { svc, fb } = setupManaged();
      svc.onWowUp();
      await vi.advanceTimersByTimeAsync(10);
      fb.triggerChunkOpened({
        videoPath: "/tmp/c1.mp4",
        startedAt: T0,
        stoppedAt: null,
      });
      svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
      await vi.advanceTimersByTimeAsync(11 * 60_000); // past the idle window
      expect(fb.calls.filter((c) => c === "splitChunk")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("④ segmentClose 后:markChapter(match end) → splitChunk → closeChunk → pruneNow,空闲定时器重启", async () => {
    const { svc, recordings, fb } = setupManaged();
    const pruneSpy = vi.spyOn(recordings, "prune");
    svc.onWowUp();
    await settle();
    fb.triggerChunkOpened({
      videoPath: "/tmp/c1.mp4",
      startedAt: T0,
      stoppedAt: null,
    });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    fb.backend.splitChunk = async () => {
      fb.calls.push("splitChunk");
      return {
        videoPath: "/tmp/c1.mp4",
        startedAt: T0,
        stoppedAt: T0 + 300_000,
      };
    };
    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false });
    await settle();
    expect(fb.calls).toContain("markChapter:match end");
    expect(fb.calls).toContain("splitChunk");
    expect(recordings.list()[0]!.stoppedAt).toBe(T0 + 300_000);
    expect(pruneSpy).toHaveBeenCalled();
  });

  it("⑤ 空闲每 10 分钟(IDLE_SPLIT_MS)自动 split(不在对局中时)", async () => {
    vi.useFakeTimers();
    try {
      const { svc, recordings, fb } = setupManaged();
      svc.onWowUp();
      await vi.advanceTimersByTimeAsync(10);
      fb.triggerChunkOpened({
        videoPath: "/tmp/c1.mp4",
        startedAt: T0,
        stoppedAt: null,
      });
      fb.backend.splitChunk = async () => {
        fb.calls.push("splitChunk");
        return {
          videoPath: "/tmp/c1.mp4",
          startedAt: T0,
          stoppedAt: T0 + 10 * 60_000,
        };
      };
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
      expect(fb.calls).toContain("splitChunk");
      expect(recordings.list()[0]!.stoppedAt).toBe(T0 + 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⑥ WoW down → stopContinuous → closeChunk 尾分片", async () => {
    const { svc, recordings, fb } = setupManaged();
    svc.onWowUp();
    await settle();
    fb.triggerChunkOpened({
      videoPath: "/tmp/c1.mp4",
      startedAt: T0,
      stoppedAt: null,
    });
    fb.backend.stopContinuous = async () => {
      fb.calls.push("stopContinuous");
      return {
        videoPath: "/tmp/c1.mp4",
        startedAt: T0,
        stoppedAt: T0 + 500_000,
      };
    };
    svc.onWowDown();
    await settle();
    expect(fb.calls).toContain("stopContinuous");
    expect(recordings.list()[0]!.stoppedAt).toBe(T0 + 500_000);
  });

  it("⑦ MAX_CHUNK_MS(40 分钟)超时 → 强制 splitChunk + console.warn", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { svc, recordings, fb } = setupManaged();
      svc.onWowUp();
      await vi.advanceTimersByTimeAsync(10);
      fb.triggerChunkOpened({
        videoPath: "/tmp/c1.mp4",
        startedAt: T0,
        stoppedAt: null,
      });
      fb.backend.splitChunk = async () => {
        fb.calls.push("splitChunk");
        return {
          videoPath: "/tmp/c1.mp4",
          startedAt: T0,
          stoppedAt: T0 + 40 * 60_000,
        };
      };
      await vi.advanceTimersByTimeAsync(40 * 60_000 + 100);
      expect(fb.calls).toContain("splitChunk");
      expect(recordings.list()[0]!.stoppedAt).toBe(T0 + 40 * 60_000);
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("单分片超 40 分钟"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⑧ backend 全程抛错:只落 lastError,不抛出;associate/入库不受影响", async () => {
    const { svc, recordings } = setupManaged({
      backendOverrides: {
        startContinuous: async () => {
          throw new Error("start blew up");
        },
        stopContinuous: async () => {
          throw new Error("stop blew up");
        },
        splitChunk: async () => {
          throw new Error("split blew up");
        },
        markChapter: async () => {
          throw new Error("chapter blew up");
        },
      },
    });
    svc.onWowUp();
    await settle();
    expect(svc.getStatus().lastError).toContain("start blew up");
    // markChapter's failure is silent per CaptureBackend's own contract --
    // must not throw and must not even touch lastError.
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
    await settle();
    svc.onWowDown();
    await settle();
    // Nothing above threw synchronously (the test itself would have failed
    // already if it had); ingestion is untouched by any of it.
    expect(() =>
      svc.associate({ id: "m1", startTime: T0, endTime: T0 + 1 }),
    ).not.toThrow();
    expect(recordings.list()).toEqual([]); // no bogus/partial rows got indexed
  });

  it("⑨ 托管模式下 connectAtStartup 是 no-op(不拨用户的 4455 端口)", async () => {
    const { svc, fb, bypassCalls } = setupManaged();
    await svc.connectAtStartup();
    expect(fb.calls).toEqual([]);
    expect(bypassCalls).toEqual([]);
    expect(svc.getStatus().connected).toBe(false);
  });
});
