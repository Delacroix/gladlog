// Long-term PvP log archive: scan feed → download raw gzip bytes → upload to Drive → ledger dedup.
// Design: docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md
// Compliance: docs/DATA-COMPLIANCE.md
//
// Usage: npx tsx scripts/archivePvpLogs.ts
// Env vars: ARCHIVE_ROOT / RCLONE_REMOTE / DOWNLOAD_SLEEP_MS / MAX_PAGES / DRY_RUN
import { spawnSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { statfsSync } from "fs";

import {
  checkArchivePayload,
  driveDestFor,
  isDateKeyDir,
  isKnownStub,
  ledgerEntriesToAppend,
  matchDateKey,
  MIN_DOWNLOAD_SLEEP_MS,
  parseThrottleEnv,
  reconcileStaging,
  shouldAbortAfterFailures,
  shouldArchive,
  shouldFlushBatch,
  shouldSkipFlush,
  shouldStopScanning,
  stagedIdsFrom,
  stagingPathFor,
} from "../src/archivePlan";
import {
  knownKeysFrom,
  latestById,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  mergeIndexLines,
  parseShard,
  recentDateKeys,
  serializeEntry,
} from "../src/archiveLedger";
import {
  buildArchiveUploadArgs,
  buildIndexCatArgs,
  classifyIndexFetch,
  rclonePreflightError,
  uploadSucceeded,
} from "../src/archiveUpload";
import { parseListRemotes } from "../src/driveSync";
import {
  decodeRawPayload,
  downloadRaw,
  fetchDetailedStubs,
} from "../src/feedClient";
// Import each module only once (eslint no-duplicate-imports)
import {
  buildGcsMeta,
  dedupeByLogObject,
  KNOWN_BRACKETS,
  shouldSleepBeforeDownload,
  shouldSleepBeforePage,
} from "../src/pvpLogFetch";
import { isLockStale, parseLock, serializeLock } from "../src/runLock";

const ARCHIVE_ROOT =
  process.env.ARCHIVE_ROOT ??
  path.join(os.homedir(), "code/gladlog-eval-private/archive");
const RCLONE_REMOTE = process.env.RCLONE_REMOTE ?? "gdrive";
const DEFAULT_DOWNLOAD_SLEEP_MS = 2000;
const DEFAULT_MAX_PAGES = 2000;
const PAGE_SLEEP_MS = 500;
const DRY_RUN = process.env.DRY_RUN === "1";
/** Stop this run once free space drops below this — don't fill up the system disk. */
const MIN_FREE_BYTES = 20 * 1024 ** 3;

// Throttle params must not use bare Number(): `??` doesn't catch empty strings,
// `Number("")` is 0 and `Number("2s")` is NaN, and setTimeout(r, NaN) equals 0ms —
// either would silently cancel the polite throttling toward the upstream.
const downloadSleep = parseThrottleEnv(
  process.env.DOWNLOAD_SLEEP_MS,
  DEFAULT_DOWNLOAD_SLEEP_MS,
  MIN_DOWNLOAD_SLEEP_MS,
);
if (downloadSleep.usedFallback) {
  console.warn(
    `DOWNLOAD_SLEEP_MS="${process.env.DOWNLOAD_SLEEP_MS}" 无效或低于下限 ${MIN_DOWNLOAD_SLEEP_MS}ms —— 退回 ${downloadSleep.value}ms`,
  );
}
const DOWNLOAD_SLEEP_MS = downloadSleep.value;
const maxPages = parseThrottleEnv(process.env.MAX_PAGES, DEFAULT_MAX_PAGES, 1);
if (maxPages.usedFallback) {
  console.warn(
    `MAX_PAGES="${process.env.MAX_PAGES}" 无效或小于 1 —— 退回 ${maxPages.value}`,
  );
}
const MAX_PAGES = maxPages.value;

const STAGING = path.join(ARCHIVE_ROOT, "staging");
const LEDGER = path.join(ARCHIVE_ROOT, "ledger");
const LOCK = path.join(ARCHIVE_ROOT, ".lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether this process actually holds the lock — if not, never delete the lock file (it belongs to someone else). */
let holdsLock = false;

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function releaseLock(): void {
  if (!holdsLock) return;
  holdsLock = false;
  fs.removeSync(LOCK);
}

function acquireLock(): boolean {
  fs.ensureDirSync(ARCHIVE_ROOT);
  const existing = fs.existsSync(LOCK)
    ? parseLock(fs.readFileSync(LOCK, "utf8"))
    : null;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM = the process exists but we lack permission to signal it — that is **alive**.
      // Only ESRCH (no such process) counts as dead. Catching everything as "not alive"
      // would misjudge a live process as a stale lock and take over, causing two instances
      // to scan the same feed segment concurrently and download duplicates, wasting the
      // upstream volunteer project's bandwidth — exactly what this lock exists to prevent.
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };
  // isLockStale also has a 48h absolute-age fallback: the pid check can't catch pid
  // reuse after a reboot, and otherwise one dead lock could silently stall archiving
  // forever (see LOCK_MAX_AGE_MS in runLock.ts).
  if (!isLockStale(existing, alive)) return false;
  // Atomic write (temp file then rename): if we wrote LOCK directly and got killed
  // mid-write, the half-written JSON would parse to null in parseLock, and null means
  // the same as "no lock at all" — the next instance would assume no lock and take over,
  // running concurrently with the real process. rename is atomic on the same filesystem,
  // so readers see either the complete old content or the complete new content.
  const tmp = `${LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    serializeLock({ pid: process.pid, startedAt: Date.now() }),
  );
  fs.renameSync(tmp, LOCK);
  holdsLock = true;
  return true;
}

/**
 * Date-shard directory names under the staging root.
 *
 * Both filters are required: `isDateKeyDir` blocks non-date entries like `.DS_Store`
 * (appears after opening the dir in Finder once, and sorts lexicographically before all
 * dates), and `isDirectory()` blocks regular files that happen to be named like a date —
 * either would make the later `readdirSync` throw ENOTDIR, bubbling to `main().catch`
 * exit 1, so the feed never gets scanned and even the sole "0 new matches" alert is
 * never reached: a permanent silent stall.
 */
function stagingDateDirs(): string[] {
  return fs
    .readdirSync(STAGING, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isDateKeyDir(e.name))
    .map((e) => e.name);
}

/**
 * Flush one day's staging: reconcile disk vs ledger → upload → record only after
 * confirmed success → delete local. Returns the number of matches confirmed uploaded.
 */
function flushDay(dateKey: string): number {
  // DRY_RUN must bail out entirely right here: `rclone copy --dry-run` transfers
  // nothing yet exits 0, so continuing would append an uploaded:true line — the next
  // pre-flush would delete the local bytes based on it, dedup would never re-download,
  // and after the 7-day window the match is gone forever. A rehearsal must have no
  // persistent side effects.
  if (shouldSkipFlush(DRY_RUN)) {
    console.log(`  DRY_RUN:跳过冲刷 ${dateKey} —— 不传、不记账、不删本地`);
    return 0;
  }
  const dir = path.join(STAGING, dateKey);
  if (!fs.existsSync(dir)) return 0;
  const shard = ledgerShardPath(LEDGER, dateKey);
  const prior = fs.existsSync(shard)
    ? parseShard(fs.readFileSync(shard, "utf8"))
    : [];
  // rclone copy uploads **all** .txt.gz in the directory, so "what gets uploaded" must
  // be computed from what's actually on disk, not just the batch the caller has in hand —
  // any mismatch leaves orphans behind (see reconcileStaging).
  const plan = reconcileStaging(fs.readdirSync(dir), prior);

  // The deletions below no longer check DRY_RUN individually: the function already
  // returned wholesale at the top, so reaching here means this is a real run.
  for (const id of plan.alreadyUploaded) {
    // Ledger says uploaded but still on disk: leftover from being killed between
    // recording and deletion. Just delete — re-uploading wastes bandwidth, and leaving
    // it makes every round trigger a pointless rclone run.
    fs.removeSync(stagingPathFor(STAGING, dateKey, id));
  }
  for (const id of plan.orphans) {
    // Killed between writing to disk and recording: possibly a truncated gz, and it
    // will never enter the index. Delete and rely on the feed's 7-day window to
    // re-download — don't upload a file that can't be verified and isn't findable
    // in the index.
    console.warn(`  暂存孤儿(账本无条目)${dateKey}/${id} —— 删除,等待重下`);
    fs.removeSync(stagingPathFor(STAGING, dateKey, id));
  }
  // Empty batch: touch nothing — no index write, no rclone spawn, no empty append to the ledger.
  if (plan.toUpload.length === 0) return 0;

  const driveDest = driveDestFor(dateKey);
  // index.jsonl uploads together with the .txt.gz files: it's this batch's metadata, and
  // uploading it separately would let the two drift out of sync. Read the existing cloud
  // index first, then merge — the local ledger only keeps 10 days, so rebuilding from
  // local after a machine switch / ledger loss would truncate the cloud's whole-day index
  // to just the new batch (files still there, but gone from the index).
  const cat = spawnSync(
    "rclone",
    buildIndexCatArgs({ remote: RCLONE_REMOTE, driveDest }),
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const fetched = classifyIndexFetch(cat.status ?? 1, cat.stderr ?? "");
  if (fetched === "error") {
    // If we can't read, we dare not write: treating a read failure as an empty index
    // would overwrite the complete cloud index with just this batch.
    console.error(
      `  读云端 index 失败(${dateKey}),保留暂存待下次重试:${(cat.stderr ?? "").slice(0, 300)}`,
    );
    return 0;
  }
  // uploaded:true is stamped only inside ledgerEntriesToAppend (under DRY_RUN it returns
  // empty — same criterion as shouldSkipFlush at the top, two gates on one predicate:
  // recording a match too early means losing it forever).
  const uploadedNow = ledgerEntriesToAppend(plan.toUpload, DRY_RUN);
  // latestById collapses multiple entries per id (shards are append-only: a match writes
  // false first, then true) — otherwise the index would contain duplicate lines.
  const localView = latestById([...prior, ...uploadedNow]).filter(
    (e) => e.uploaded,
  );
  fs.writeFileSync(
    path.join(dir, "index.jsonl"),
    mergeIndexLines(fetched === "ok" ? (cat.stdout ?? "") : "", localView),
  );

  const args = buildArchiveUploadArgs({
    stagingDir: dir,
    remote: RCLONE_REMOTE,
    driveDest,
    dryRun: DRY_RUN,
  });
  const r = spawnSync("rclone", args, { encoding: "utf8" });
  if (!uploadSucceeded(r.status ?? 1, r.stderr ?? "")) {
    console.error(
      `  上传失败(${dateKey}),保留暂存待下次重试:${r.stderr?.slice(0, 300)}`,
    );
    return 0;
  }
  // Record only after confirmed success — recording early means losing the match forever
  fs.ensureDirSync(LEDGER);
  fs.appendFileSync(shard, uploadedNow.map(serializeEntry).join("\n") + "\n");
  for (const e of uploadedNow)
    fs.removeSync(stagingPathFor(STAGING, dateKey, e.id));
  return uploadedNow.length;
}

async function main() {
  // Preflight must run **before** scanning the feed: with rclone missing or the remote
  // name misspelled, the code below would download all ~39,000 matches / 16.5GB from the
  // volunteer project's GCS without being able to upload a single byte. That egress is
  // billed to them. syncPvpLogsToDrive.ts in this package has done it this way all along.
  const preflight = rclonePreflightError({
    rcloneMissing: !!spawnSync("rclone", ["version"], { encoding: "utf8" })
      .error,
    remotes: parseListRemotes(
      spawnSync("rclone", ["listremotes"], { encoding: "utf8" }).stdout ?? "",
    ),
    remote: RCLONE_REMOTE,
  });
  if (preflight) {
    console.error(preflight);
    process.exit(1);
  }

  if (!acquireLock()) {
    console.log("已有归档进程在跑,本次退出");
    return;
  }
  fs.ensureDirSync(STAGING);
  fs.ensureDirSync(LEDGER);

  let fresh = 0;
  // Flush leftover staging from the previous run before scanning the feed — otherwise
  // "downloaded OK, upload failed" matches, absent from the ledger, would be re-downloaded,
  // spending the upstream's bandwidth again for nothing.
  // Count into fresh: a round's output may consist entirely of re-uploading the previous
  // round's staging; dropping the return value would make the sole "0 new matches" alert
  // fire when everything is fine, turning it into noise.
  for (const d of stagingDateDirs()) {
    const staged = stagedIdsFrom(fs.readdirSync(path.join(STAGING, d)));
    if (staged.size === 0) continue;
    console.log(`冲刷遗留暂存 ${d}:${staged.size} 场`);
    fresh += flushDay(d);
  }

  // Whatever **still** sits in staging after the flush = also failed to upload this
  // round. The bytes are already local, so they must count as known — otherwise the scan
  // below would re-download them all, and since staging exists precisely because upload
  // failed, the "don't spend their bandwidth twice" protection above would fail exactly
  // when it's needed most.
  const stagedIds = new Set<string>();
  for (const d of stagingDateDirs()) {
    for (const id of stagedIdsFrom(fs.readdirSync(path.join(STAGING, d)))) {
      stagedIds.add(id);
    }
  }

  const known = new Set<string>(stagedIds);
  const knownLogs = new Set<string>();
  for (const k of recentDateKeys(Date.now(), LEDGER_WINDOW_DAYS)) {
    const p = ledgerShardPath(LEDGER, k);
    if (!fs.existsSync(p)) continue;
    const keys = knownKeysFrom(
      parseShard(fs.readFileSync(p, "utf8")),
      stagedIds,
    );
    for (const id of keys.ids) known.add(id);
    for (const u of keys.logUrls) knownLogs.add(u);
  }
  console.log(
    `账本已知 ${known.size} 场(最近 ${LEDGER_WINDOW_DAYS} 天;其中暂存待传 ${stagedIds.size} 场)`,
  );

  let downloads = 0;
  let consecutiveFailures = 0;
  let metaMissing = 0;
  let aborted = false;
  for (const bracket of KNOWN_BRACKETS) {
    if (aborted) break;
    let consecutiveKnown = 0;
    let limitReached = false;
    const batchDays = new Set<string>();
    let state = { count: 0, bytes: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      if (freeBytes(ARCHIVE_ROOT) < MIN_FREE_BYTES) {
        console.error("磁盘剩余空间不足 20GB,停止本次运行");
        aborted = true;
        break;
      }
      if (shouldSleepBeforePage(page)) await sleep(PAGE_SLEEP_MS);
      const { stubs, queryLimitReached } = await fetchDetailedStubs({
        bracket,
        offset: page * 50,
        count: 50,
      });
      if (queryLimitReached) {
        // 服务端截断了深翻页。丢掉这个标志就会看到一个空页 → break → 本轮少收
        // 一大截,而 fresh > 0 让「新增 0 场」告警不响 —— 静默漏采,7 天后永久丢失。
        // 处理完本页再停(本页数据是好的)。`fetchPublicLogs.ts:104-105` 同款。
        console.warn(
          `${bracket}: 服务端 queryLimitReached —— 深翻页被截断,处理完本页即停止翻页(本轮可能少收)`,
        );
        limitReached = true;
      }
      if (stubs.length === 0) break;
      for (const stub of dedupeByLogObject(stubs)) {
        if (!shouldArchive(stub, known, knownLogs)) {
          // 「已知」判据与 shouldArchive 共用 isKnownStub —— 这里判错是早停,
          // 而早停 = 漏采 = 7 天窗口一过就永久丢失,比重下贵得多。
          if (isKnownStub(stub, known, knownLogs)) consecutiveKnown++;
          continue;
        }
        consecutiveKnown = 0;
        if (shouldSleepBeforeDownload(downloads))
          await sleep(DOWNLOAD_SLEEP_MS);
        downloads++;
        try {
          const raw = await downloadRaw(
            stub.logObjectUrl,
            `archive ${stub.id}`,
          );
          // 三层完整性(gzip / 压缩字节数 / 解压哨兵)走同一个谓词,失败**计入**
          // 连续失败计数:系统性失败(每场都判不过)否则会把整个 feed 全量下载
          // 再全部丢弃,每轮 ~2.4GB 志愿者出口流量地空转,而刹车永远踩不到。
          const check = checkArchivePayload({
            contentEncoding: raw.contentEncoding,
            byteLength: raw.bytes.length,
            expectedBytes: raw.expectedBytes,
            decode: () => decodeRawPayload(raw),
          });
          if (!check.ok) {
            consecutiveFailures++;
            console.warn(
              `  skip ${stub.id}(连续第 ${consecutiveFailures} 次):${check.reason}`,
            );
            if (shouldAbortAfterFailures(consecutiveFailures)) {
              console.error(
                `连续 ${consecutiveFailures} 场失败,中止本轮 —— 继续空转只是在敲对方的 GCS`,
              );
              aborted = true;
              break;
            }
            continue;
          }
          // GCS 对象约 30 天后消失,这四个 header 不在归档时存下就再也拿不到 ——
          // 日志正文的时间戳无年份且是上传者本地时区,重建绝对时间只能靠它们。
          // 逐场 warn 会在 5,570 场/天的量级上刷屏,改为汇总计数。
          const { meta, missingFields } = buildGcsMeta({
            wowVersion: raw.header("x-goog-meta-wow-version"),
            clientTimezone: raw.header("x-goog-meta-client-timezone"),
            clientYear: raw.header("x-goog-meta-client-year"),
            startTimeUtc: raw.header("x-goog-meta-starttime-utc"),
          });
          if (missingFields.length > 0) metaMissing++;
          const dateKey = matchDateKey(stub.startTime);
          const p = stagingPathFor(STAGING, dateKey, stub.id);
          fs.ensureDirSync(path.dirname(p));
          fs.writeFileSync(p, raw.bytes);
          const entry: LedgerEntry = {
            id: stub.id,
            logObjectUrl: stub.logObjectUrl,
            dateKey,
            bracket: stub.bracket || bracket,
            startTime: stub.startTime,
            playerTeamRating: stub.playerTeamRating,
            team0MMR: stub.team0MMR,
            team1MMR: stub.team1MMR,
            playerTeamId: stub.playerTeamId,
            winningTeamId: stub.winningTeamId,
            durationInSeconds: stub.durationInSeconds,
            specs: stub.units.filter((u) => u.info).map((u) => u.spec),
            bytes: raw.bytes.length,
            gcsMeta: meta,
            uploaded: false,
          };
          // 先落一条 uploaded:false 的账 —— 进程崩了下次靠它认出遗留暂存
          fs.appendFileSync(
            ledgerShardPath(LEDGER, dateKey),
            serializeEntry(entry) + "\n",
          );
          // 本轮内立刻登记双键。feed 是活的:翻页期间新场次把列表整体下移,
          // 上一页末尾的 stub 会在下一页开头原样再现;不登记就会在同一次运行里
          // 把它再下一遍(写进账本文件不算数 —— shouldArchive 查的是内存集合)。
          known.add(stub.id);
          knownLogs.add(stub.logObjectUrl);
          batchDays.add(dateKey);
          state = {
            count: state.count + 1,
            bytes: state.bytes + raw.bytes.length,
          };
          consecutiveFailures = 0;
        } catch (err) {
          // 单场异常(下载重试耗尽、超大 SS 日志解压抛错、写盘 ENOSPC)不该
          // 打断 22 小时的首次全量;已落盘的靠遗留冲刷补传,不会丢数据。
          consecutiveFailures++;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `  失败 ${stub.id}(连续第 ${consecutiveFailures} 次):${msg}`,
          );
          if (shouldAbortAfterFailures(consecutiveFailures)) {
            console.error(
              `连续 ${consecutiveFailures} 场失败,中止本轮 —— 继续空转只是在敲对方的 GCS`,
            );
            aborted = true;
            break;
          }
          continue;
        }
        if (shouldFlushBatch(state)) {
          for (const d of batchDays) fresh += flushDay(d);
          batchDays.clear();
          state = { count: 0, bytes: 0 };
        }
      }
      if (aborted) break;
      if (limitReached) break;
      if (shouldStopScanning(consecutiveKnown)) {
        console.log(
          `${bracket}: 连续 ${consecutiveKnown} 场已知,追上,停止翻页`,
        );
        break;
      }
      if (stubs.length < 50) break;
    }
    for (const d of batchDays) fresh += flushDay(d);
  }

  console.log(
    `done: 新归档 ${fresh} 场,下载尝试 ${downloads} 次${metaMissing > 0 ? `,${metaMissing} 场缺 x-goog-meta 字段` : ""}${aborted ? "(中途中止)" : ""}`,
  );
  // DRY_RUN 下不冲刷,fresh 必然是 0 —— 那是演练的定义,不是故障,别误报。
  if (fresh === 0 && !DRY_RUN) {
    // 正常每次都该有上千场。0 说明 feed 挂了或查询失效(如对方改 schema),
    // 而这种故障静默持续一周就是永久丢一周数据。
    console.error("警告:本次新增 0 场 —— 检查 feed 是否可用或 schema 是否变更");
  }
  releaseLock();
}

main().catch((e) => {
  // 只删自己持有的锁:acquireLock 判定「别人在跑」而退出时,锁不是我们的。
  releaseLock();
  console.error("archivePvpLogs failed:", e);
  process.exit(1);
});
