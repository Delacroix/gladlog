import { dateKeyOf, latestById, type LedgerEntry } from "./archiveLedger";
import type { DetailedMatchStub } from "./feedClient";
import {
  checkDecompressedPayload,
  checkRawPayloadBytes,
  type CompletenessResult,
} from "./pvpLogFetch";

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
 * 比赛会散落到不同目录。格式化本身走 `dateKeyOf`(账本分片名同源,别写第二遍)。
 */
export function matchDateKey(startTimeMs: number): string {
  return dateKeyOf(startTimeMs);
}

/** 日期目录名的形状:`YYYY-MM-DD`,与 `dateKeyOf` 的输出同构。 */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 这个名字是不是一个日期分片目录(`YYYY-MM-DD`)。
 *
 * 暂存根目录下**不保证只有日期目录**:Finder 打开一次就会留下 `.DS_Store`,
 * 而它按字典序排在所有日期之前。不过滤就会对一个普通文件 `readdirSync` 抛 ENOTDIR,
 * 冲到 `main().catch` 里 exit 1 —— 一条都冲刷不到、feed 根本没扫、连「新增 0 场」
 * 那条唯一的告警都走不到,此后每轮都在同一处静默停摆。
 */
export function isDateKeyDir(name: string): boolean {
  return DATE_KEY_RE.test(name);
}

/**
 * 这一场是不是**已知**(已归档 / 已在暂存 / 本轮已下过)。
 *
 * 双键:id **与** logObjectUrl 都要查。SS 一场 6 轮共享同一个日志对象但 id 各不
 * 相同,只查 id 会把同一个 GCS 对象跨页/跨运行反复下载,并在 Drive 上存成多份
 * (`fetchPvpLogs.ts:148-153` 的 have/haveLogs 是同一套判据的先例)。
 * 空 `logObjectUrl` 必须先过真值守卫 —— 否则集合里一旦混进空串,所有缺该字段的
 * stub 会被一并判为已知。
 *
 * `shouldArchive`(收不收)与编排壳的 `consecutiveKnown`(何时停页)必须共用这
 * **同一个**谓词:前者判错是重下(花钱),后者判错是早停(漏采 = 7 天后永久丢失)。
 */
export function isKnownStub(
  stub: DetailedMatchStub,
  known: ReadonlySet<string>,
  knownLogUrls: ReadonlySet<string> = new Set(),
): boolean {
  if (known.has(stub.id)) return true;
  if (stub.logObjectUrl && knownLogUrls.has(stub.logObjectUrl)) return true;
  return false;
}

/**
 * 该不该下这一场。
 *
 * 调用方必须在**本轮运行内**边下边把 id/URL 加进这两个集合 —— feed 是活的,
 * 翻页期间新场次会把列表整体下移,上一页末尾的 stub 会在下一页开头原样再现。
 */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: ReadonlySet<string>,
  knownLogUrls: ReadonlySet<string> = new Set(),
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (isKnownStub(stub, known, knownLogUrls)) return false;
  // startTime 缺失/为 0 会把文件归到 1970 目录,污染按天分片的整个结构。
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

/**
 * 归档路径的完整性判据。三层,任一不过就整场丢弃 —— 并且**必须计入连续失败计数**:
 * 系统性失败(如再来一次「压缩尺寸比解压长度」那种 bug)会让每一场都判不过,
 * 不计数就等于把整个 feed 全量下载再全部丢弃,每轮 ~2.4GB 志愿者出口流量 × 4 轮/天
 * 地空转,而 `shouldAbortAfterFailures` 那道刹车永远踩不到。
 *
 * 1. `content-encoding` 必须是 `gzip`。GCS 在没收到 `Accept-Encoding: gzip` 时会
 *    服务端转码(解压后再发、且不带 content-length),此时字节校验因
 *    `expectedBytes === undefined` 直接放行 —— 落盘的就是**明文**,文件名却是
 *    `.txt.gz`,体积 11.4x,且以后任何按 gzip 读它的人都会炸。
 * 2. 压缩字节数与 GCS 声明一致(`checkRawPayloadBytes`,必须在**未解压**字节上比)。
 * 3. 解压后含两个哨兵(`checkDecompressedPayload`)。
 *
 * `decode` 传 thunk 而不是已解压的字符串:前两层不过时就不必白花一次 gunzip。
 */
export function checkArchivePayload(input: {
  contentEncoding: string;
  byteLength: number;
  expectedBytes: number | undefined;
  decode: () => string;
}): CompletenessResult {
  if (input.contentEncoding !== "gzip") {
    return {
      ok: false,
      reason: `content-encoding 不是 gzip(实为 "${input.contentEncoding}")—— 明文不能以 .txt.gz 落盘`,
    };
  }
  const bytes = checkRawPayloadBytes(input.byteLength, input.expectedBytes);
  if (!bytes.ok) return bytes;
  return checkDecompressedPayload(input.decode());
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
 * DRY_RUN 下必须**整段跳过**冲刷:不写 index、不 spawn rclone、不记账、不删本地。
 *
 * 起因(2026-08-01 复核 C1):`rclone copy --dry-run` 什么也没传、退出码 0、
 * stderr 是 `NOTICE: ... Skipped copy as --dry-run is set`,于是 `uploadSucceeded`
 * 判成功,账本 append 一行 `uploaded:true`。下一次正常运行:预冲刷的
 * `reconcileStaging` 判它 `alreadyUploaded` → 删掉本地那份字节;`knownKeysFrom`
 * 判它已知 → 永不重下。7 天后 feed 窗口一过,这一场**永久丢失** —— 只因为跑过
 * 一次「什么也不做」的演练。
 *
 * 所以判据是「有没有真的传上去」,而 `--dry-run` 的定义就是没有。
 */
export function shouldSkipFlush(dryRun: boolean): boolean {
  return dryRun;
}

/**
 * 冲刷确认成功后,该往账本 append 哪些条目 —— `uploaded: true` **只在这里**盖章。
 *
 * `dryRun` 为真时返回空:与 `shouldSkipFlush` 是同一条判据的两道闸门(编排壳早已
 * 在 `flushDay` 顶部返回,理论上到不了这里)。故意重复,因为判错的代价是永久丢场,
 * 而两道闸门各自都有单测钉住。
 */
export function ledgerEntriesToAppend(
  toUpload: readonly LedgerEntry[],
  dryRun: boolean,
): LedgerEntry[] {
  if (dryRun) return [];
  return toUpload.map((e) => ({ ...e, uploaded: true }));
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
