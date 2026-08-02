import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
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

  it("startRecord 报 already active(gladlog 自己欠账未确认停):当孤儿收尾重试,不永久失败 (C1)", async () => {
    // 场景构造:match1 正常起录(weStartedRecording=true);close 时 OBS 侧
    // stopRecord 失败(网络抖动等,OBS 其实还在录)——按修法,失败不清
    // weStartedRecording,所以它仍然记得"这段还是我欠的账"。match2 开局时
    // 连接始终没断(ensureConnected 短路、不会重新 reconcile),startRecord
    // 直接撞见 OBS 仍在录的 already-active;因为 weStartedRecording 还是
    // true(有正向证据),二道防线才会出手收尾重试——这就是与"用户自己开的
    // 录制"（weStartedRecording=false)分道扬镳的地方。
    let obsStillRecording = false;
    const { client, calls } = fakeClient();
    client.startRecord = async () => {
      calls.push("start");
      if (obsStillRecording) throw new Error("output already active");
      obsStillRecording = true;
    };
    client.stopRecord = async () => {
      calls.push("stop");
      throw new Error("request could not be completed"); // 第一次关闭失败
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

    // 第二次 stopRecord 换成能成功(孤儿收尾会用到)
    client.stopRecord = async () => {
      calls.push("stop");
      obsStillRecording = false;
      return { outputPath: "/tmp/x.mp4" };
    };

    svc.onSegmentOpen({ startTime: T0 + 60_000, bracket: "3v3" });
    await settle();

    expect(svc.getStatus().recording).toBe(true);
    expect(svc.getStatus().lastError).toBeNull();
    expect(recordings.list()).toHaveLength(1); // 孤儿录像也落了索引
  });

  it("OBS 已有用户自己的手动录制(非 gladlog 发起):绝不误停,startRecord 失败走 lastError (复核轮, C1)", async () => {
    // 复核轮抓回的坑:reconcileWithReality 光凭 outputActive 判断,分不清
    // "OBS 在录"是不是"gladlog 让它录的"。这里模拟用户在开对局前就自己在
    // OBS 里点了录制(比如录直播备份)——weStartedRecording 从头到尾是
    // false,gladlog 绝不能因为看见 outputActive=true 就调 StopRecord 把
    // 用户的录制停掉。
    const { client, calls } = fakeClient();
    client.getRecordStatus = async () => {
      calls.push("status");
      return { outputActive: true }; // 用户手动录制,从始至终在录
    };
    client.startRecord = async () => {
      calls.push("start");
      throw new Error("output already active"); // OBS 真实行为:已在录会拒绝
    };
    const { svc, recordings } = setup({ client });

    svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
    await settle();

    expect(calls).not.toContain("stop"); // 从未对用户的录制发过 StopRecord
    expect(svc.getStatus().recording).toBe(false);
    expect(svc.getStatus().lastError).toContain("already active");
    expect(recordings.list()).toHaveLength(0); // 没有孤儿录像被"收尾"入库
  });

  it("断连后没有下一场:segmentClose 凭正证据重连收尾孤儿(真机「打完录像不停」主根因)", async () => {
    // 对局中 websocket 闪断 → onClosed 清 recording=false(去重需要);
    // 打完了没有下一场 → 此前 doClose 首行门禁 no-op,OBS 永远没人去停,
    // 40 分钟安全阀与退出路径也被同一门禁一起废掉。修法:weStartedRecording
    // 正证据在手就重连收孤儿 —— 与「用户自己开的录制」(无正证据)分道。
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

    triggerClosed(); // 对局中断连,OBS 独立续录
    expect(svc.getStatus().recording).toBe(false);

    svc.onSegmentClose({ endTime: T0 + 300_000, aborted: false }); // 最后一场
    await settle();
    expect(calls).toContain("stop"); // 旧代码此断言恒失败:OBS 永不停
    expect(recordings.list()).toHaveLength(1); // 孤儿录像入了索引
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

      triggerClosed(); // 断连;END 永远不来(WoW 缓冲/散场)
      await vi.advanceTimersByTimeAsync(40 * 60_000 + 100); // 安全阀到点
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
        if (hang) return new Promise(() => {}); // OBS 停录请求悬挂
        return Promise.resolve({ outputPath: "/tmp/x.mp4" });
      };
      const { svc } = setup({ client });

      svc.onSegmentOpen({ startTime: T0, bracket: "3v3" });
      await vi.advanceTimersByTimeAsync(20);
      svc.onSegmentClose({ endTime: T0 + 1, aborted: false });
      await vi.advanceTimersByTimeAsync(20_000); // 超过 OBS 调用超时
      expect(svc.getStatus().lastError ?? "").toContain("timed out");

      // 链没被卡死:下一场照常起录(旧代码:安全阀连同一切排队等死)
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
    expect(recordings.list()).toHaveLength(1); // 退出前落索引
  });
});
