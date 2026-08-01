// PvP log 长期归档:扫 feed → 下载原始 gzip 字节 → 传 Drive → 记账去重。
// 设计见 docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md
// 合规见 docs/DATA-COMPLIANCE.md
//
// 用法:npx tsx scripts/archivePvpLogs.ts
// 环境变量:ARCHIVE_ROOT / RCLONE_REMOTE / DOWNLOAD_SLEEP_MS / MAX_PAGES / DRY_RUN
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
// 同一模块只 import 一次(eslint no-duplicate-imports)
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
/** 剩余空间低于此值即停止本次运行,别撑爆系统盘。 */
const MIN_FREE_BYTES = 20 * 1024 ** 3;

// 节流参数不能用裸 Number():`??` 拦不住空串,`Number("")` 是 0、`Number("2s")`
// 是 NaN,而 setTimeout(r, NaN) 等价 0ms —— 两者都会静默取消对上游的礼貌节流。
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

/** 本进程是否真的持有锁 —— 没持有就绝不能删锁文件(那是别人的)。 */
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
      // EPERM = 进程存在但我们没权限给它发信号 —— 那是**活着**。
      // 只有 ESRCH(查无此进程)才算死。统一 catch 成「未存活」会把活进程
      // 误判为陈旧锁并接管,后果是两个实例并发扫同一段 feed、重复下载,
      // 白花上游志愿者项目的流量 —— 正是这把锁要防的事。
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };
  // isLockStale 还带 48h 绝对年龄兜底:pid 判据挡不住重启后的 pid 复用,
  // 否则一把死锁能让归档永久静默停摆(见 runLock.ts 的 LOCK_MAX_AGE_MS)。
  if (!isLockStale(existing, alive)) return false;
  // 原子写(先写临时文件再 rename):直接写 LOCK 时若进程在写一半时被 kill,
  // 留下的半截 JSON 会被 parseLock 判成 null,而 null 与「压根没有锁」同义 ——
  // 下一个实例会认为无锁而接管,与真进程并发。rename 在同一文件系统上是原子的,
  // 读到的要么是完整旧内容要么是完整新内容。
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
 * 暂存根目录下的日期分片目录名。
 *
 * 两道过滤缺一不可:`isDateKeyDir` 挡掉 `.DS_Store` 这类非日期条目(Finder 打开
 * 一次就有,且字典序排在所有日期之前),`isDirectory()` 挡掉恰好叫日期名的普通
 * 文件 —— 两者都会让后续的 `readdirSync` 抛 ENOTDIR,冲到 `main().catch` exit 1,
 * 于是 feed 根本没扫、连「新增 0 场」那条唯一的告警都走不到,永久静默停摆。
 */
function stagingDateDirs(): string[] {
  return fs
    .readdirSync(STAGING, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isDateKeyDir(e.name))
    .map((e) => e.name);
}

/**
 * 冲刷某一天的暂存:对齐盘上与账本 → 传 → 确认成功才记账 → 删本地。
 * 返回本次确认上传的场数。
 */
function flushDay(dateKey: string): number {
  // DRY_RUN 必须在这里就整段返回:`rclone copy --dry-run` 什么也没传却退 0,
  // 再往下走就会 append 一行 uploaded:true —— 下轮预冲刷据此删掉本地字节、
  // 去重据此永不重下,7 天后这一场永久消失。演练不该有任何持久化副作用。
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
  // rclone copy 传的是目录里**全部** .txt.gz,所以「传什么」必须按盘上实际内容
  // 算,不能只按调用方手里的那一批 —— 两者不一致就会留下孤儿(见 reconcileStaging)。
  const plan = reconcileStaging(fs.readdirSync(dir), prior);

  // 下面这些删除不再各自判 DRY_RUN:函数顶部已经整段返回,能走到这里就一定是真跑。
  for (const id of plan.alreadyUploaded) {
    // 账本已确认上传却还在本地:记账与删除之间被 kill 的残留。删掉即可 ——
    // 重传是白花流量,而放着不管会让它每轮都白触发一次 rclone。
    fs.removeSync(stagingPathFor(STAGING, dateKey, id));
  }
  for (const id of plan.orphans) {
    // 落盘与记账之间被 kill:可能是半截 gz,且不会进 index。删掉靠 feed 的
    // 7 天窗口重下,别把一个无法校验、索引里也查不到的文件传上去。
    console.warn(`  暂存孤儿(账本无条目)${dateKey}/${id} —— 删除,等待重下`);
    fs.removeSync(stagingPathFor(STAGING, dateKey, id));
  }
  // 这一批为空就彻底不动:不写 index、不 spawn rclone、不往账本 append 空串。
  if (plan.toUpload.length === 0) return 0;

  const driveDest = driveDestFor(dateKey);
  // index.jsonl 与 .txt.gz 一起传:它是这批的元数据,单独传会出现两者不同步。
  // 先读云端已有索引再合并 —— 本地账本只留 10 天,换机/丢账本后按本地重建会把
  // 云端整天的索引截断成只剩新批次(文件还在,但从索引里消失)。
  const cat = spawnSync(
    "rclone",
    buildIndexCatArgs({ remote: RCLONE_REMOTE, driveDest }),
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const fetched = classifyIndexFetch(cat.status ?? 1, cat.stderr ?? "");
  if (fetched === "error") {
    // 读不到就不敢写:把读失败当空索引处理,等于用这一批覆盖掉云端完整索引。
    console.error(
      `  读云端 index 失败(${dateKey}),保留暂存待下次重试:${(cat.stderr ?? "").slice(0, 300)}`,
    );
    return 0;
  }
  // uploaded:true 只在 ledgerEntriesToAppend 里盖章(DRY_RUN 下它返回空,与顶部
  // 的 shouldSkipFlush 是同一条判据的两道闸门 —— 记早一场就是永久丢一场)。
  const uploadedNow = ledgerEntriesToAppend(plan.toUpload, DRY_RUN);
  // latestById 折叠同 id 的多条(分片是 append-only:同一场先写 false 再写 true),
  // 否则 index 会出现重复行。
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
  // 确认成功之后才记账 —— 记早了就是永久丢一场
  fs.ensureDirSync(LEDGER);
  fs.appendFileSync(shard, uploadedNow.map(serializeEntry).join("\n") + "\n");
  for (const e of uploadedNow)
    fs.removeSync(stagingPathFor(STAGING, dateKey, e.id));
  return uploadedNow.length;
}

async function main() {
  // 预检必须在扫 feed **之前**:rclone 没装或 remote 名打错时,下面会把 ~39,000 场、
  // 16.5GB 从志愿者项目的 GCS 全量下到本地,却一个字节都传不上去。这笔出口流量
  // 记在对方账上。同包 syncPvpLogsToDrive.ts 早就是这么做的。
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
  // 先冲刷上次遗留的暂存,再扫 feed —— 否则「下载成功、上传失败」的场次
  // 因未进账本会被重新下载,白白再花对方一次流量。
  // 计进 fresh:某轮的产出可能全部来自补传上一轮的暂存,丢掉返回值会让
  // 「本次新增 0 场」那条唯一的告警在一切正常时误报,把它变成噪声。
  for (const d of stagingDateDirs()) {
    const staged = stagedIdsFrom(fs.readdirSync(path.join(STAGING, d)));
    if (staged.size === 0) continue;
    console.log(`冲刷遗留暂存 ${d}:${staged.size} 场`);
    fresh += flushDay(d);
  }

  // 冲刷后**仍**留在暂存里的 = 这轮也没传上去的。字节已经在本地,必须算已知,
  // 否则下面的扫描会把它们全部重下 —— 而暂存存在的原因恰恰是上传失败,
  // 上面那条「不白白再花对方一次流量」的保护就在最需要它的时候失效了。
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
