import { DEFAULT_OBS_WS_URL } from "../shared/protocol";
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
  testConnection(): Promise<{ ok: boolean; error?: string }>;
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
