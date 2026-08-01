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
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
} from "../src/archivePlan";
import {
  knownIdsFrom,
  latestById,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "../src/archiveLedger";
import { buildArchiveUploadArgs, uploadSucceeded } from "../src/archiveUpload";
import {
  decodeRawPayload,
  downloadRaw,
  fetchDetailedStubs,
} from "../src/feedClient";
// 同一模块只 import 一次(eslint no-duplicate-imports)
import {
  checkDecompressedPayload,
  checkRawPayloadBytes,
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
const DOWNLOAD_SLEEP_MS = Number(process.env.DOWNLOAD_SLEEP_MS ?? 2000);
const PAGE_SLEEP_MS = 500;
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 2000);
const DRY_RUN = process.env.DRY_RUN === "1";
/** 剩余空间低于此值即停止本次运行,别撑爆系统盘。 */
const MIN_FREE_BYTES = 20 * 1024 ** 3;

const STAGING = path.join(ARCHIVE_ROOT, "staging");
const LEDGER = path.join(ARCHIVE_ROOT, "ledger");
const LOCK = path.join(ARCHIVE_ROOT, ".lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
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
  return true;
}

/** 冲刷某一天的暂存:上传 → 成功则记账并删本地。 */
function flushDay(dateKey: string, pending: LedgerEntry[]): number {
  const dir = path.join(STAGING, dateKey);
  if (!fs.existsSync(dir)) return 0;
  // index.jsonl 与 .txt.gz 一起传:它是这批的元数据,单独传会出现两者不同步。
  const shard = ledgerShardPath(LEDGER, dateKey);
  const prior = fs.existsSync(shard)
    ? parseShard(fs.readFileSync(shard, "utf8"))
    : [];
  // latestById 折叠同 id 的多条(分片是 append-only:同一场先写 false 再写 true),
  // 否则 index 会出现重复行。
  const all = latestById([
    ...prior,
    ...pending.map((e) => ({ ...e, uploaded: true })),
  ]).filter((e) => e.uploaded);
  fs.writeFileSync(
    path.join(dir, "index.jsonl"),
    all.map(toIndexLine).join("\n") + "\n",
  );

  const args = buildArchiveUploadArgs({
    stagingDir: dir,
    remote: RCLONE_REMOTE,
    driveDest: driveDestFor(dateKey),
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
  fs.appendFileSync(
    shard,
    pending.map((e) => serializeEntry({ ...e, uploaded: true })).join("\n") +
      (pending.length ? "\n" : ""),
  );
  if (!DRY_RUN) {
    for (const e of pending)
      fs.removeSync(stagingPathFor(STAGING, dateKey, e.id));
  }
  return pending.length;
}

async function main() {
  if (!acquireLock()) {
    console.log("已有归档进程在跑,本次退出");
    return;
  }
  fs.ensureDirSync(STAGING);
  fs.ensureDirSync(LEDGER);

  // 先冲刷上次遗留的暂存,再扫 feed —— 否则「下载成功、上传失败」的场次
  // 因未进账本会被重新下载,白白再花对方一次流量。
  for (const d of fs.readdirSync(STAGING)) {
    const files = fs
      .readdirSync(path.join(STAGING, d))
      .filter((f) => f.endsWith(".txt.gz"));
    if (files.length === 0) continue;
    console.log(`冲刷遗留暂存 ${d}:${files.length} 场`);
    const shard = ledgerShardPath(LEDGER, d);
    const prior = fs.existsSync(shard)
      ? parseShard(fs.readFileSync(shard, "utf8"))
      : [];
    const byId = new Map(latestById(prior).map((e) => [e.id, e]));
    const pending = files
      .map((f) => byId.get(f.replace(/\.txt\.gz$/, "")))
      .filter((e): e is LedgerEntry => !!e && !e.uploaded);
    flushDay(d, pending);
  }

  const known = new Set<string>();
  for (const k of recentDateKeys(Date.now(), LEDGER_WINDOW_DAYS)) {
    const p = ledgerShardPath(LEDGER, k);
    if (fs.existsSync(p)) {
      for (const id of knownIdsFrom(parseShard(fs.readFileSync(p, "utf8")))) {
        known.add(id);
      }
    }
  }
  console.log(`账本已知 ${known.size} 场(最近 ${LEDGER_WINDOW_DAYS} 天)`);

  let fresh = 0;
  let downloads = 0;
  for (const bracket of KNOWN_BRACKETS) {
    let consecutiveKnown = 0;
    const batch = new Map<string, LedgerEntry[]>();
    let state = { count: 0, bytes: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      if (freeBytes(ARCHIVE_ROOT) < MIN_FREE_BYTES) {
        console.error("磁盘剩余空间不足 20GB,停止本次运行");
        break;
      }
      if (shouldSleepBeforePage(page)) await sleep(PAGE_SLEEP_MS);
      const { stubs } = await fetchDetailedStubs({
        bracket,
        offset: page * 50,
        count: 50,
      });
      if (stubs.length === 0) break;
      for (const stub of dedupeByLogObject(stubs)) {
        if (!shouldArchive(stub, known)) {
          if (known.has(stub.id)) consecutiveKnown++;
          continue;
        }
        consecutiveKnown = 0;
        if (shouldSleepBeforeDownload(downloads))
          await sleep(DOWNLOAD_SLEEP_MS);
        downloads++;
        const raw = await downloadRaw(stub.logObjectUrl, `archive ${stub.id}`);
        const byteCheck = checkRawPayloadBytes(
          raw.bytes.length,
          raw.expectedBytes,
        );
        if (!byteCheck.ok) {
          console.warn(`  skip ${stub.id}: ${byteCheck.reason}`);
          continue;
        }
        const textCheck = checkDecompressedPayload(decodeRawPayload(raw));
        if (!textCheck.ok) {
          console.warn(`  skip ${stub.id}: ${textCheck.reason}`);
          continue;
        }
        const dateKey = matchDateKey(stub.startTime);
        const p = stagingPathFor(STAGING, dateKey, stub.id);
        fs.ensureDirSync(path.dirname(p));
        fs.writeFileSync(p, raw.bytes);
        const entry: LedgerEntry = {
          id: stub.id,
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
          uploaded: false,
        };
        // 先落一条 uploaded:false 的账 —— 进程崩了下次靠它认出遗留暂存
        fs.appendFileSync(
          ledgerShardPath(LEDGER, dateKey),
          serializeEntry(entry) + "\n",
        );
        batch.set(dateKey, [...(batch.get(dateKey) ?? []), entry]);
        state = {
          count: state.count + 1,
          bytes: state.bytes + raw.bytes.length,
        };
        if (shouldFlushBatch(state)) {
          for (const [d, es] of batch) fresh += flushDay(d, es);
          batch.clear();
          state = { count: 0, bytes: 0 };
        }
      }
      if (shouldStopScanning(consecutiveKnown)) {
        console.log(
          `${bracket}: 连续 ${consecutiveKnown} 场已知,追上,停止翻页`,
        );
        break;
      }
      if (stubs.length < 50) break;
    }
    for (const [d, es] of batch) fresh += flushDay(d, es);
  }

  console.log(`done: 新归档 ${fresh} 场,下载尝试 ${downloads} 次`);
  if (fresh === 0) {
    // 正常每次都该有上千场。0 说明 feed 挂了或查询失效(如对方改 schema),
    // 而这种故障静默持续一周就是永久丢一周数据。
    console.error("警告:本次新增 0 场 —— 检查 feed 是否可用或 schema 是否变更");
  }
  fs.removeSync(LOCK);
}

main().catch((e) => {
  fs.removeSync(LOCK);
  console.error("archivePvpLogs failed:", e);
  process.exit(1);
});
