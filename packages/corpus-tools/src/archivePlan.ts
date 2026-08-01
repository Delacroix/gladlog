import type { DetailedMatchStub } from "./feedClient";

/**
 * 停止翻页的阈值:连续见到这么多个「已在账本里」的场次才认为追上了。
 *
 * 不能是 1 —— feed 里存在零星乱序/重传,遇到第一个已知就停会静默漏掉它后面
 * 的新场次,而漏采在 7 天窗口下是永久损失。200 = 4 页,留足余量。
 */
export const STOP_AFTER_KNOWN = 200;

const BATCH_MAX_COUNT = 200;
const BATCH_MAX_BYTES = 500 * 1024 * 1024;

/**
 * 比赛所属日期(UTC)。用**比赛开始时刻**而非下载时刻 —— 否则补扫时同一天的
 * 比赛会散落到不同目录。UTC 而非本机时区:归档要跨机器可复现。
 */
export function matchDateKey(startTimeMs: number): string {
  return new Date(startTimeMs).toISOString().slice(0, 10);
}

/** 该不该下这一场。 */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: Set<string>,
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (known.has(stub.id)) return false;
  // startTime 缺失/为 0 会把文件归到 1970 目录,污染按天分片的整个结构。
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

export function shouldStopScanning(consecutiveKnown: number): boolean {
  return consecutiveKnown >= STOP_AFTER_KNOWN;
}

export function stagingPathFor(
  stagingRoot: string,
  dateKey: string,
  matchId: string,
): string {
  return `${stagingRoot}/${dateKey}/${matchId}.txt.gz`;
}

/** Drive 上的相对目标目录:2026-08-01 → 2026/08/01。 */
export function driveDestFor(dateKey: string): string {
  return dateKey.replace(/-/g, "/");
}

export interface BatchState {
  count: number;
  bytes: number;
}

/**
 * 该不该冲刷这一批。批太小则每批的 rclone 进程开销占比高,太大则中途崩溃的
 * 重传成本高 —— 200 场或 500MB,取先到者。
 */
export function shouldFlushBatch(state: BatchState): boolean {
  return state.count >= BATCH_MAX_COUNT || state.bytes >= BATCH_MAX_BYTES;
}
