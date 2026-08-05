import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlackFrameJudgment, judgeBlackFrame } from "../shared/blackFrame";
import type {
  BackendHealth,
  CaptureBackend,
  CaptureChunk,
} from "./captureBackend";
import { SCENE_NAME } from "./obsConfigWriter";
import type { ManagedObsWs } from "./managedObsClient";
import { realManagedObsWs } from "./managedObsClient";

/** 每次 websocket 调用的超时(task-4 brief 规则 4)。 */
const CALL_TIMEOUT_MS = 15_000;
/** splitChunk() 等 RecordFileChanged 的超时(brief 规则 3)。 */
const SPLIT_EVENT_TIMEOUT_MS = 5_000;
/** startContinuous() 等首分片 RecordStateChanged(STARTED)事件的超时——超了才
 * 兜底扫描 recDir(brief 规则 1)。取值与 split 等待一致,同属"等一次 websocket
 * 事件往返"的量级,没有独立依据要求不同的数字。 */
const FIRST_CHUNK_EVENT_TIMEOUT_MS = 5_000;

/** 托管实例里 game_capture 输入的固定名字——不进场景 JSON(design doc §5.4:
 * "采集源不写进场景 JSON"),运行时用 CreateInput 现建。 */
const GAME_CAPTURE_INPUT_NAME = "gladlog-capture";

/** 编码器 stage 1 PINNED(brief 规则 5:没有 websocket 编码器枚举 API,design doc
 * §2.5 源码级事实)。NVENC 选择是 stage 2 项。 */
const PINNED_ENCODER = "obs_x264";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 给一个 promise 包 15s(或调用方指定)超时——超时/失败都不让异常越过这层抛给
 * CaptureBackend 的调用方(brief 规则 7:"recording failures never throw into
 * the caller")。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时(${ms}ms)`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 目录下最新的 mp4 —— 首分片路径的兜底(brief 规则 1)。目录只有我们写,取最新
 * mtime 是安全的(design doc §5.5)。 */
function scanNewestMp4(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!/\.mp4$/i.test(name)) continue;
    const p = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs };
  }
  return newest ? newest.path : null;
}

/**
 * 极简 24bpp 未压缩 BMP 解码器,只取逐像素亮度。选 BMP(而不是 PNG)是本任务的
 * 实现决定,不是设计文档强制的格式:PNG 要走 DEFLATE 解压,零依赖(任务约束:
 * 不加新包)下要么自己写一个 inflate,要么引入库;BMP 是无压缩位图,首部 54
 * 字节定长、像素按行倒序排列、行按 4 字节对齐补零,几十行就能吃透,SaveSourceScreenshot
 * 的 imageFormat 参数本来就允许任意 Qt 支持的格式,bmp 在列。
 */
function decodeBmpLuminance(buf: Buffer): number[] {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error("不是有效的 BMP(缺 'BM' 幻数或文件过短)");
  }
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const heightRaw = buf.readInt32LE(22);
  const bitCount = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bitCount !== 24 || compression !== 0) {
    throw new Error(
      `不支持的 BMP 格式(bitCount=${bitCount}, compression=${compression});captureProbe 只请求 24bpp 无压缩`,
    );
  }
  const height = Math.abs(heightRaw);
  const bottomUp = heightRaw > 0;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const out: number[] = new Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = bottomUp ? height - 1 - row : row;
    const rowStart = dataOffset + row * rowSize;
    for (let x = 0; x < width; x++) {
      const off = rowStart + x * 3;
      const b = buf[off]!;
      const g = buf[off + 1]!;
      const r = buf[off + 2]!;
      // Standard luma weights.
      out[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return out;
}

export interface ManagedObsBackendDeps {
  ensureProcess: () => Promise<{ wsUrl: string; wsPassword: string }>;
  recDir: string;
  clientFactory?: () => ManagedObsWs;
  now?: () => number;
}

export type ManagedObsBackend = CaptureBackend & {
  configureSession(): Promise<void>;
  captureProbe(): Promise<{ shotPath: string; black: boolean }>;
};

export function createManagedObsBackend(
  deps: ManagedObsBackendDeps,
): ManagedObsBackend {
  const nowFn = deps.now ?? Date.now;
  const makeClient = deps.clientFactory ?? realManagedObsWs;

  let client: ManagedObsWs | null = null;
  let connected = false;
  let listenersAttached = false;
  let continuousActive = false;
  let sessionConfigured = false;
  let encoder: string | null = null;
  let sourceActive = false;
  let lastError: string | null = null;
  let currentChunk: CaptureChunk | null = null;

  const openChunkListeners = new Set<(c: CaptureChunk) => void>();
  const pendingFirstChunkWaiters = new Set<() => void>();
  const pendingSplitWaiters = new Set<(closed: CaptureChunk | null) => void>();

  function notifyOpened(c: CaptureChunk): void {
    for (const cb of openChunkListeners) cb(c);
  }

  function openFirstChunk(path: string): void {
    if (currentChunk) return; // race between event and fallback scan — first wins
    currentChunk = { videoPath: path, startedAt: nowFn(), stoppedAt: null };
    const waiters = [...pendingFirstChunkWaiters];
    pendingFirstChunkWaiters.clear();
    for (const w of waiters) w();
    notifyOpened(currentChunk);
  }

  function handleChunkSplitEvent(newPath: string): void {
    const closed: CaptureChunk | null = currentChunk
      ? { ...currentChunk, stoppedAt: nowFn() }
      : null;
    currentChunk = { videoPath: newPath, startedAt: nowFn(), stoppedAt: null };
    const waiters = [...pendingSplitWaiters];
    pendingSplitWaiters.clear();
    for (const w of waiters) w(closed);
    notifyOpened(currentChunk);
  }

  function attachListeners(c: ManagedObsWs): void {
    if (listenersAttached) return;
    listenersAttached = true;
    // 规则 1:监听必须在 StartRecord 之前挂好 —— attachListeners() 的所有调用点
    // 都在任何 call("StartRecord") 之前(ensureConnected 里),这里不重复断言,
    // fake 测试按调用顺序断言。
    c.on("RecordStateChanged", (data) => {
      const outputState = data.outputState;
      const outputPath = data.outputPath;
      if (
        typeof outputState === "string" &&
        /STARTED/i.test(outputState) &&
        typeof outputPath === "string" &&
        outputPath.length > 0
      ) {
        openFirstChunk(outputPath);
      }
    });
    c.on("RecordFileChanged", (data) => {
      const newOutputPath = data.newOutputPath;
      if (typeof newOutputPath === "string" && newOutputPath.length > 0) {
        handleChunkSplitEvent(newOutputPath);
      }
    });
  }

  /** 等首分片事件到达,超时返回(不 reject——调用方随后走兜底扫描)。 */
  function waitForFirstChunkEvent(ms: number): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let settled = false;
    let resolveFn!: () => void;
    const promise = new Promise<void>((res) => {
      resolveFn = res;
    });
    const waiterFn = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingFirstChunkWaiters.delete(waiterFn);
      resolveFn();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingFirstChunkWaiters.delete(waiterFn);
      resolveFn();
    }, ms);
    pendingFirstChunkWaiters.add(waiterFn);
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingFirstChunkWaiters.delete(waiterFn);
      },
    };
  }

  /** 等 RecordFileChanged,超时返回 `undefined`(超时哨兵,区别于事件带来的合法
   * `null`——currentChunk 恰好为空时的关闭结果)。 */
  function waitForSplitEvent(ms: number): {
    promise: Promise<CaptureChunk | null | undefined>;
    cancel: () => void;
  } {
    let settled = false;
    let resolveFn!: (v: CaptureChunk | null | undefined) => void;
    const promise = new Promise<CaptureChunk | null | undefined>((res) => {
      resolveFn = res;
    });
    const waiterFn = (closed: CaptureChunk | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingSplitWaiters.delete(waiterFn);
      resolveFn(closed);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingSplitWaiters.delete(waiterFn);
      resolveFn(undefined);
    }, ms);
    pendingSplitWaiters.add(waiterFn);
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingSplitWaiters.delete(waiterFn);
      },
    };
  }

  async function callWithTimeout(
    req: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!client) {
      lastError = `${req} 失败: 未连接`;
      return null;
    }
    try {
      return await withTimeout(client.call(req, data), CALL_TIMEOUT_MS, req);
    } catch (err) {
      lastError = `${req} 失败: ${errMessage(err)}`;
      return null;
    }
  }

  /** 确保 process 已就绪 + client 已连接 + 监听器已挂好。configureSession() 和
   * startContinuous() 都可能是"第一个真正建立连接的调用",谁先调用谁做这份工作,
   * 幂等。 */
  async function ensureConnected(): Promise<boolean> {
    if (connected && client) {
      attachListeners(client);
      return true;
    }
    let proc: { wsUrl: string; wsPassword: string };
    try {
      proc = await deps.ensureProcess();
    } catch (err) {
      lastError = `ensureProcess 失败: ${errMessage(err)}`;
      return false;
    }
    if (!client) client = makeClient();
    attachListeners(client);
    try {
      await withTimeout(
        client.connect(proc.wsUrl, proc.wsPassword),
        CALL_TIMEOUT_MS,
        "connect",
      );
    } catch (err) {
      lastError = `连接失败: ${errMessage(err)}`;
      return false;
    }
    connected = true;
    return true;
  }

  async function startContinuous(): Promise<void> {
    if (continuousActive) return; // 幂等(规则 10)
    const ok = await ensureConnected();
    if (!ok) return;

    const firstChunkWait = currentChunk
      ? null
      : waitForFirstChunkEvent(FIRST_CHUNK_EVENT_TIMEOUT_MS);
    const result = await callWithTimeout("StartRecord");
    if (result === null) {
      firstChunkWait?.cancel();
      return;
    }
    continuousActive = true;

    if (firstChunkWait) {
      await firstChunkWait.promise;
      if (!currentChunk) {
        const scanned = scanNewestMp4(deps.recDir);
        if (scanned) {
          openFirstChunk(scanned);
        } else {
          lastError = `首个分片路径未知:STARTED 事件未带 outputPath 且 ${deps.recDir} 下没有 mp4 文件`;
        }
      }
    }
  }

  async function stopContinuous(): Promise<CaptureChunk | null> {
    if (!client) return null;
    // 规则 1:StopRecord 的响应体绝不读取(分片后 outputPath 恒返回第一个分片)
    // —— 下面只调用,完全不触碰返回值。
    await callWithTimeout("StopRecord");
    continuousActive = false;
    if (!currentChunk) return null;
    const closed: CaptureChunk = { ...currentChunk, stoppedAt: nowFn() };
    currentChunk = null;
    return closed;
  }

  async function splitChunk(): Promise<CaptureChunk | null> {
    if (!client || !connected) {
      lastError = "splitChunk: 未连接";
      return null;
    }
    // 先注册等待者,再发请求 —— 避免事件比"开始等待"更早到达导致漏接(brief 规则
    // 3 的等待顺序,也是让这条路径在同步 fake 与异步真实事件下都不出竞态的关键)。
    const wait = waitForSplitEvent(SPLIT_EVENT_TIMEOUT_MS);
    const result = await callWithTimeout("SplitRecordFile");
    if (result === null) {
      wait.cancel();
      return null;
    }
    const closed = await wait.promise;
    if (closed === undefined) {
      lastError = `SplitRecordFile: 等待 RecordFileChanged 超时(${SPLIT_EVENT_TIMEOUT_MS}ms)`;
      return null;
    }
    return closed;
  }

  function onChunkOpened(cb: (c: CaptureChunk) => void): () => void {
    openChunkListeners.add(cb);
    return () => openChunkListeners.delete(cb);
  }

  async function markChapter(name: string): Promise<void> {
    // 规则 6:纯增强,失败静默 —— 不设 lastError,不抛出。
    if (!client || !connected) return;
    try {
      await withTimeout(
        client.call("CreateRecordChapter", { chapterName: name }),
        CALL_TIMEOUT_MS,
        "CreateRecordChapter",
      );
    } catch {
      // 静默吞掉——hybrid_mp4 之外的容器本来就会失败,这是预期路径。
    }
  }

  async function probe(): Promise<BackendHealth> {
    return {
      ready: connected && sessionConfigured,
      encoder,
      sourceActive,
      lastError,
    };
  }

  async function shutdown(): Promise<void> {
    const c = client;
    if (c && connected) {
      try {
        await withTimeout(c.disconnect(), CALL_TIMEOUT_MS, "disconnect");
      } catch (err) {
        lastError = `disconnect 失败: ${errMessage(err)}`;
      }
    }
    client = null;
    connected = false;
    listenersAttached = false;
    continuousActive = false;
    sessionConfigured = false;
    encoder = null;
    currentChunk = null;
  }

  async function configureSession(): Promise<void> {
    const ok = await ensureConnected();
    if (!ok) return;
    const created = await callWithTimeout("CreateInput", {
      sceneName: SCENE_NAME,
      inputName: GAME_CAPTURE_INPUT_NAME,
      inputKind: "game_capture",
      inputSettings: {
        capture_mode: "any_fullscreen",
        // priority 存的是枚举值 CLASS=0/TITLE=1/EXE=2,不是下拉框位置——
        // design doc §5.4;2 = 按 exe 匹配,插件默认。
        priority: 2,
        anti_cheat_hook: true,
      },
    });
    if (created === null) return; // lastError 已设置,sessionConfigured 保持 false
    sessionConfigured = true;
    encoder = PINNED_ENCODER;
    await captureProbe();
  }

  async function captureProbe(): Promise<{ shotPath: string; black: boolean }> {
    if (!client || !connected) {
      lastError = "captureProbe: 未连接";
      sourceActive = false;
      return { shotPath: "", black: true };
    }
    const shotPath = join(tmpdir(), `gladlog-obs-probe-${nowFn()}.bmp`);
    const result = await callWithTimeout("SaveSourceScreenshot", {
      sourceName: GAME_CAPTURE_INPUT_NAME,
      imageFormat: "bmp",
      imageFilePath: shotPath,
    });
    if (result === null) {
      sourceActive = false;
      return { shotPath, black: true };
    }
    let judgment: BlackFrameJudgment;
    try {
      const luminances = decodeBmpLuminance(readFileSync(shotPath));
      judgment = judgeBlackFrame(luminances);
    } catch (err) {
      lastError = `captureProbe: 读取/解码截图失败: ${errMessage(err)}`;
      sourceActive = false;
      return { shotPath, black: true };
    }
    sourceActive = !judgment.black;
    return { shotPath, black: judgment.black };
  }

  return {
    startContinuous,
    stopContinuous,
    splitChunk,
    onChunkOpened,
    markChapter,
    probe,
    shutdown,
    configureSession,
    captureProbe,
  };
}
