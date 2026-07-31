import { DEFAULT_OBS_WS_URL, OBS_PASSWORD_REDACTED } from "../shared/protocol";
import type { ObsClientLike } from "./obsClient";
import type { RecordingEntry, RecordingsStore } from "./recordingsStore";

export { DEFAULT_OBS_WS_URL };

/** 对局开着却一直等不到 close(worker 挂了/日志断流)的安全阀。 */
const SAFETY_STOP_MS = 40 * 60_000;
const META_BUFFER_CAP = 20;

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
  /** overrides = 设置页当前(可能未保存)的输入:url 传 null 表示用默认
   * 地址;password 空/未传/哨兵 → 回退已保存真值。真机踩坑:输完密码直接
   * 点测试、没点保存 → 测试用的是空密码,报 missing authentication string。 */
  testConnection(overrides?: {
    url?: string | null;
    password?: string | null;
  }): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
}

interface RecorderSettings {
  recordingEnabled: boolean;
  obsWebsocketUrl: string | null;
  obsWebsocketPassword: string | null;
  recordingKeepCount: number;
}

/** 外控 OBS 起停录制(路线C一期)。铁律:任何 OBS 失败只降级置 lastError,
 * 绝不上抛 —— 解析入库与分析主链路不受录像影响。起停走单条 promise 链
 * 串行化,防背靠背场次交错。 */
export function createRecorderService(deps: {
  getSettings: () => RecorderSettings;
  recordings: RecordingsStore;
  clientFactory: () => ObsClientLike;
  emit: (channel: string, payload: unknown) => void;
  now?: () => number;
}): RecorderService {
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

  function isAlreadyActiveError(e: unknown): boolean {
    return /already active/i.test(String(e));
  }

  /** C1 糊涂账收尾:OBS 侧仍在录、本地以为没在录(典型触发:websocket 断连
   * 期间 OBS 独立续录)。选择的语义是「停掉这段孤儿录像并尽量入库」而不是
   * 「认领它继续当新一段」——认领会让新对局的时间窗被旧录像污染,且
   * associate() 的重叠判定也会更难对齐。用还记得的 startedAt(断连前没被
   * 清掉)作为这段孤儿录像的起点;如果连 startedAt 都没有(理论上不会走到,
   * 防御性兜底)退化为用当前时刻,不让入库直接崩。stopRecord 本身失败(比如
   * GetRecordStatus 和 StopRecord 之间 OBS 又被手动停了)也吞掉,不让恢复
   * 流程整体失败——下一步 startRecord 的 already-active 兜底会再顶一次。 */
  async function closeOrphanRecording(): Promise<void> {
    if (!client) return;
    try {
      const { outputPath } = await client.stopRecord();
      const entry: RecordingEntry = {
        videoPath: outputPath,
        startedAt: startedAt || now(),
        stoppedAt: now(),
        matchId: null,
      };
      deps.recordings.add(entry);
      for (const m of metaBuffer) deps.recordings.associate(m);
    } catch {
      /* 尽力而为:见上方注释 */
    } finally {
      recording = false;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    }
  }

  /** 每次(重新)建连后对账一次:query 一下 OBS 的真实录制态,和本地内存位
   * 比对。只在刚连上时做——一旦 connected 为 true,ensureConnected 后续调用
   * 直接短路,不会重复对账(没必要,状态没有失配的新来源)。 */
  async function reconcileWithReality(): Promise<void> {
    if (!client) return;
    let obsRecording: boolean;
    try {
      obsRecording = (await client.getRecordStatus()).outputActive;
    } catch {
      return; // 查不到就维持现状,startRecord 的 already-active 兜底顶上
    }
    if (obsRecording && !recording) {
      await closeOrphanRecording();
    } else if (!obsRecording && recording) {
      // 反向糊涂账:OBS 已经停了(手动/崩溃重启),本地别再以为在录
      recording = false;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    }
  }

  async function ensureConnected(): Promise<void> {
    if (connected && client) return;
    const s = deps.getSettings();
    client = deps.clientFactory();
    client.onClosed(() => {
      connected = false;
      // recording 仍然清 false——这是「本地不再信任自己在管这段录像」的
      // 信号,不是「OBS 真的停了」的断言(OBS 断连后大概率还在独立录制)。
      // 清掉它是必要的:onSegmentOpen 靠 `if (recording) return` 去重
      // 背靠背 DOUBLE_START,断连后若不清掉,下一场开局会被这个去重挡住,
      // 连重连都不会尝试。真正的 OBS 现实由重连后 reconcileWithReality()
      // 去问,发现「其实还在录」就当孤儿收尾(见 closeOrphanRecording)。
      recording = false;
      pushStatus();
    });
    await client.connect(
      s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL,
      s.obsWebsocketPassword ?? undefined,
    );
    connected = true;
    await reconcileWithReality();
  }

  async function doClose(): Promise<void> {
    if (!recording || !client) return;
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    // 先出「在录」态:stopRecord 抛错(OBS 侧被手动停录等)不能把 recording
    // 卡在 true,否则后续对局全部拒录(agy flash 复核 #3)。
    recording = false;
    const { outputPath } = await client.stopRecord();
    const entry: RecordingEntry = {
      videoPath: outputPath,
      startedAt,
      stoppedAt: now(),
      matchId: null,
    };
    deps.recordings.add(entry);
    // 双向兜底之一:match 消息先于 segmentClose 到,meta 已在缓冲里
    for (const m of metaBuffer) deps.recordings.associate(m);
    deps.recordings.prune(deps.getSettings().recordingKeepCount);
  }

  return {
    onSegmentOpen() {
      if (!deps.getSettings().recordingEnabled) return;
      run(async () => {
        if (recording) return; // 背靠背/DOUBLE_START:同一段录像继续覆盖
        try {
          await ensureConnected();
          try {
            await client!.startRecord();
          } catch (e) {
            // 二道防线:reconcileWithReality() 是 connect 那一刻的快照,
            // GetRecordStatus 和这里的 startRecord 之间仍有极小 TOCTOU
            // 窗口(比如 OBS 刚重启、状态还没同步)。命中「already active」
            // 就当孤儿收尾再重试一次,而不是直接判这场失败、把 lastError
            // 卡死到下一场(C1 消费的核心 consequence:重试永久失败)。
            if (!isAlreadyActiveError(e)) throw e;
            await closeOrphanRecording();
            await client!.startRecord();
          }
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
      // 不按 recordingEnabled 拦:对局中途关掉设置也必须能停录
      // (doClose 未在录时本就 no-op;agy flash 复核 #4)。
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
    async testConnection(overrides) {
      try {
        const c = deps.clientFactory();
        const s = deps.getSettings();
        const url =
          overrides && "url" in overrides
            ? (overrides.url ?? DEFAULT_OBS_WS_URL)
            : (s.obsWebsocketUrl ?? DEFAULT_OBS_WS_URL);
        const typed = overrides?.password;
        const password =
          typed && typed !== OBS_PASSWORD_REDACTED
            ? typed
            : (s.obsWebsocketPassword ?? undefined);
        await c.connect(url, password);
        await c.disconnect();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    async stop() {
      await new Promise<void>((res) =>
        run(async () => {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
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
