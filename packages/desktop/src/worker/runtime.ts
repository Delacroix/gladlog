import { readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type {
  FileStatus,
  MainToWorker,
  WorkerConfig,
  WorkerToMain,
} from "../shared/protocol";
import {
  loadCheckpoints,
  saveCheckpoints,
  type CheckpointRegistry,
} from "./checkpoints";
import { FilePipeline, type ParserLike } from "./pipeline";
import { startLogWatcher, type LogWatcher } from "./watcher";

export interface WorkerTransport {
  post(msg: WorkerToMain): void;
  onMessage(cb: (msg: MainToWorker) => void): void;
}

/** 段静默阀:对局段开着、文件却超过这么久没有任何新字节 → 给录像侧合成
 * aborted close。监听是纯 fs.watch 事件驱动、零轮询,打完后没有新战斗事件
 * 推动 WoW flush 时(END 压在客户端缓冲/散场没有 END/换新文件旧段悬置),
 * 整条停录链在第 2 跳就静止,录像只能等 40 分钟安全阀(2026-08-02 取证,
 * 真机「打完了半天录像不结束」次根因)。阈值远大于对局内任何正常写盘间隙
 * (激战中秒级、shuffle 回合间 ~1 分钟),远小于安全阀。只发信号,不动
 * parser:迟到的真 END 照常入库,第二个 close 由 recorder 幂等消化。 */
const SEGMENT_QUIET_CLOSE_MS = 3 * 60_000;
const QUIET_CHECK_INTERVAL_MS = 30_000;

export function createWorkerRuntime(opts: {
  transport: WorkerTransport;
  watchFn?: typeof import("fs").watch;
  parserFactory?: () => ParserLike;
  fatal?: (msg: string) => void;
  /** 测试用覆盖;生产不传。 */
  segmentQuietCloseMs?: number;
  quietCheckIntervalMs?: number;
}): { dispose(): void } {
  let watcher: LogWatcher | null = null;
  let pipelines = new Map<string, FilePipeline>();
  let registry: CheckpointRegistry = { files: {} };
  let config: WorkerConfig | null = null;
  const quietCloseMs = opts.segmentQuietCloseMs ?? SEGMENT_QUIET_CLOSE_MS;
  const quietCheckMs = opts.quietCheckIntervalMs ?? QUIET_CHECK_INTERVAL_MS;
  /** fileKey → 最近一次消费到新字节的时刻。 */
  const lastGrowthAt = new Map<string, number>();
  /** 已为当前静默期发过合成 close 的 fileKey(新字节到来即清,防重复发)。 */
  const quietClosed = new Set<string>();
  let quietTimer: ReturnType<typeof setInterval> | null = null;

  const post = opts.transport.post;
  const fatal =
    opts.fatal ??
    ((msg) => {
      console.error(msg);
      process.exit(1);
    });

  const fileStatuses = (): FileStatus[] => {
    if (!config) return [];
    const out: FileStatus[] = [];
    for (const [key, p] of pipelines) {
      let size = 0;
      try {
        size = statSync(join(config.logsDir, key)).size;
      } catch {
        /* gone */
      }
      out.push({
        fileKey: key,
        offset: p.currentOffset,
        size,
        quarantined: false,
      });
    }
    for (const q of config.quarantined)
      out.push({ fileKey: q, offset: 0, size: 0, quarantined: true });
    return out;
  };

  const postStatus = (
    watching: boolean,
    current?: { fileKey: string; offset: number },
  ) => {
    post({
      type: "status",
      watching,
      logsDir: config?.logsDir ?? "",
      files: fileStatuses(),
      current,
    });
  };

  const pipelineFor = (fileKey: string): FilePipeline | null => {
    if (!config || config.quarantined.includes(fileKey)) return null;
    let p = pipelines.get(fileKey);
    if (!p) {
      p = new FilePipeline({
        fileKey,
        filePath: join(config.logsDir, fileKey),
        checkpoint: registry.files[fileKey] ?? null,
        emit: post,
        parserFactory: opts.parserFactory,
      });
      pipelines.set(fileKey, p);
    }
    return p;
  };

  const flushFile = (fileKey: string): void => {
    const p = pipelineFor(fileKey);
    if (!p) return;
    postStatus(true, { fileKey, offset: p.currentOffset });
    const before = p.currentOffset;
    try {
      p.processFlush();
    } catch (e) {
      fatal(
        `[gladlog-worker] fatal parse error at ${fileKey}:${p.currentOffset}: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }
    if (p.currentOffset !== before || !lastGrowthAt.has(fileKey)) {
      lastGrowthAt.set(fileKey, Date.now());
      quietClosed.delete(fileKey); // 又有新字节:静默期重新起算
    }
    registry.files[fileKey] = p.checkpoint;
  };

  /** 段静默阀 tick:见 SEGMENT_QUIET_CLOSE_MS 注释。 */
  const quietSweep = (): void => {
    const now = Date.now();
    for (const [key, p] of pipelines) {
      if (!p.hasOpenSegment) continue;
      if (quietClosed.has(key)) continue;
      const seen = lastGrowthAt.get(key);
      if (seen !== undefined && now - seen > quietCloseMs) {
        p.closeOpenSegment(); // 只发合成 close 信号,不动 parser 状态
        quietClosed.add(key);
      }
    }
  };

  const teardown = () => {
    watcher?.close();
    watcher = null;
    if (quietTimer) {
      clearInterval(quietTimer);
      quietTimer = null;
    }
    for (const p of pipelines.values()) p.closeOpenSegment();
    pipelines = new Map();
    lastGrowthAt.clear();
    quietClosed.clear();
  };

  const configure = (next: WorkerConfig): void => {
    teardown();
    config = next;
    registry = loadCheckpoints(next.checkpointsPath);
    let names: string[];
    try {
      names = readdirSync(next.logsDir).filter(
        (n) => n.includes("WoWCombatLog") && n.endsWith(".txt"),
      );
    } catch {
      post({
        type: "diagnostic",
        code: "LOGS_DIR_UNREADABLE",
        detail: next.logsDir,
      });
      postStatus(false);
      return;
    }
    for (const name of names.sort()) flushFile(basename(name));
    saveCheckpoints(next.checkpointsPath, registry);
    watcher = startLogWatcher({
      logsDir: next.logsDir,
      flushIntervalMs: next.flushIntervalMs,
      quietPeriodMs: next.quietPeriodMs,
      watchFn: opts.watchFn,
      onFlush: async (fileNames) => {
        for (const name of fileNames) flushFile(basename(name));
        if (config) saveCheckpoints(config.checkpointsPath, registry);
        postStatus(true);
      },
    });
    // 段静默阀:独立于 fs 事件的常驻低频计时器 —— watcher 的定时器在脏集
    // 清空后自毁,不能指望它;这里必须有自己的心跳才能在「再无任何事件」
    // 的静默态下动手。
    quietTimer = setInterval(quietSweep, quietCheckMs);
    postStatus(true);
  };

  opts.transport.onMessage((msg) => {
    if (msg.type === "configure") configure(msg.config);
  });

  return { dispose: teardown };
}
