import { latestById, type LedgerEntry } from "./archiveLedger";
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

/**
 * 该不该下这一场。
 *
 * 双键去重:id **与** logObjectUrl 都要查。SS 一场 6 轮共享同一个日志对象但 id
 * 各不相同,只查 id 会把同一个 GCS 对象跨页/跨运行反复下载,并在 Drive 上存成
 * 多份(`fetchPvpLogs.ts:148-153` 的 have/haveLogs 是同一套判据的先例)。
 *
 * 调用方必须在**本轮运行内**边下边把 id/URL 加进这两个集合 —— feed 是活的,
 * 翻页期间新场次会把列表整体下移,上一页末尾的 stub 会在下一页开头原样再现。
 */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: Set<string>,
  knownLogUrls: ReadonlySet<string> = new Set(),
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (known.has(stub.id)) return false;
  if (stub.logObjectUrl && knownLogUrls.has(stub.logObjectUrl)) return false;
  // startTime 缺失/为 0 会把文件归到 1970 目录,污染按天分片的整个结构。
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

export function shouldStopScanning(consecutiveKnown: number): boolean {
  return consecutiveKnown >= STOP_AFTER_KNOWN;
}

/** 暂存文件后缀 —— 拼路径与反解 id 共用同一个常量,别两处各写一遍。 */
export const STAGED_SUFFIX = ".txt.gz";

export function stagingPathFor(
  stagingRoot: string,
  dateKey: string,
  matchId: string,
): string {
  return `${stagingRoot}/${dateKey}/${matchId}${STAGED_SUFFIX}`;
}

/** 从暂存文件名反解 matchId;非暂存文件(index.jsonl / .DS_Store)返回 null。 */
export function stagedMatchIdFrom(fileName: string): string | null {
  if (!fileName.endsWith(STAGED_SUFFIX)) return null;
  const id = fileName.slice(0, -STAGED_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** 目录列表里所有暂存场次的 id。 */
export function stagedIdsFrom(fileNames: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of fileNames) {
    const id = stagedMatchIdFrom(f);
    if (id) out.add(id);
  }
  return out;
}

export interface StagingPlan {
  /** 有账本条目且尚未上传 —— 这批才该传、才该记账、才该删。 */
  toUpload: LedgerEntry[];
  /** 账本已记 uploaded:true 却还留在本地 —— 直接删,不重传也不重复记账。 */
  alreadyUploaded: string[];
  /** 盘上有文件但账本里查无此条 —— 落盘与记账之间被 kill 的残留。 */
  orphans: string[];
}

/**
 * 对齐「盘上有什么」与「账本说什么」,再决定这一天怎么冲刷。
 *
 * 起因:`rclone copy <dir>` 传的是目录里**全部** .txt.gz,而记账和删除只覆盖调用方
 * 手里的那一批,两者一旦不一致就留下三种孤儿:
 * - 记账后、删除前被 kill:该条已 uploaded:true,下次按 !uploaded 过滤会漏掉它,
 *   文件永久留在本地,并且每轮都白触发一次 rclone。
 * - 落盘后、记账前被 kill:没有账本条目,却会被 copy 盲传上 Drive(可能是半截 gz),
 *   而且不会出现在 index.jsonl 里 —— 云端多一个索引查不到的文件。
 * - 这一批为空:仍会写 index、spawn rclone、往账本 append 一个空串。
 *
 * 孤儿一律删本地而不是盲传:feed 还有 7 天窗口,重下一次是可控代价,传上去一个
 * 无法校验、索引里也没有的文件是永久污染。
 */
export function reconcileStaging(
  fileNames: readonly string[],
  entries: readonly LedgerEntry[],
): StagingPlan {
  const byId = new Map(latestById([...entries]).map((e) => [e.id, e]));
  const plan: StagingPlan = { toUpload: [], alreadyUploaded: [], orphans: [] };
  for (const f of fileNames) {
    const id = stagedMatchIdFrom(f);
    if (!id) continue;
    const e = byId.get(id);
    if (!e) plan.orphans.push(id);
    else if (e.uploaded) plan.alreadyUploaded.push(id);
    else plan.toUpload.push(e);
  }
  return plan;
}

/**
 * 节流类环境变量的下限。空串/非数字/0 一律退回默认值 —— `Number("")` 是 0、
 * `Number("2s")` 是 NaN 而 `setTimeout(r, NaN)` 等价 0ms,两者都会让节流**完全消失**
 * 且不报一声。上游是志愿者项目,礼貌频率是硬约束,不得默认为 0。
 */
export const MIN_DOWNLOAD_SLEEP_MS = 250;

export function parseThrottleEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
): { value: number; usedFallback: boolean } {
  if (raw === undefined || raw.trim() === "") {
    return { value: fallback, usedFallback: false };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min)
    return { value: fallback, usedFallback: true };
  return { value: n, usedFallback: false };
}

/**
 * 连续失败多少次就中止本轮。
 *
 * 单场异常(下载重试耗尽、超大 SS 日志解压抛错、写盘 ENOSPC)不该打断 22 小时的
 * 首次全量,但持续失败就该停 —— 继续空转只是在敲对方的 GCS。
 */
export const MAX_CONSECUTIVE_FAILURES = 20;

export function shouldAbortAfterFailures(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
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
