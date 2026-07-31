import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { ObsClientLike } from "./obsClient";
import { createRecorderService } from "./recorder";
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
  // 测试专用:模拟 websocket 断连(触发 recorder 注册在 client 上的 onClosed)。
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
    expect(calls).toEqual(["connect", "status", "start"]);
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
      }),
      recordings: new RecordingsStore(dir),
      clientFactory: () => client,
      emit: () => {},
      now: () => T0,
    });
    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();
    flags.enabled = false; // 用户对局中关掉自动录像
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
      }),
      recordings: new RecordingsStore(dir),
      clientFactory: () => client,
      emit: () => {},
      now: () => T0,
    });
    // 输入框里有未保存的地址+密码 → 全用输入
    await svc.testConnection({ url: "ws://127.0.0.1:4466", password: "typed" });
    expect(seen[0]).toEqual({ url: "ws://127.0.0.1:4466", password: "typed" });
    // 地址框清空(→ 默认)、密码框空(→ 已存真值)
    await svc.testConnection({ url: null });
    expect(seen[1]).toEqual({
      url: "ws://127.0.0.1:4455",
      password: "storedpw",
    });
    // 无覆盖 → 全走已存
    await svc.testConnection();
    expect(seen[2]).toEqual({
      url: "ws://127.0.0.1:4455",
      password: "storedpw",
    });
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

    // websocket 断连:OBS 侧不知情,继续录;本地被 onClosed 清成「没在录」
    obsStillRecording = true;
    triggerClosed();
    expect(svc.getStatus().connected).toBe(false);
    expect(svc.getStatus().recording).toBe(false);

    // 下一场开局:ensureConnected 重连,GetRecordStatus 发现 OBS 仍在录
    // → 先 stopRecord 收尾孤儿录像入库,再正常 startRecord 开新段
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
    // 孤儿录像已入库(matchId 为 null,等 associate 事件到来关联/或已关联)
    expect(recordings.list()).toHaveLength(1);
  });

  it("startRecord 报 already active:当孤儿收尾重试,不永久失败 (C1)", async () => {
    let startAttempts = 0;
    const { client, calls } = fakeClient();
    client.startRecord = async () => {
      startAttempts += 1;
      calls.push("start");
      if (startAttempts === 1) throw new Error("output already active");
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();

    expect(calls).toEqual(["connect", "status", "start", "stop", "start"]);
    expect(svc.getStatus().recording).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
    expect(recordings.list()).toHaveLength(1); // 孤儿录像也落了索引
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
