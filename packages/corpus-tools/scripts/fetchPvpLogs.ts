// 按专精/分数过滤,批量下载他人 PvP 原始 combat log(wowarenalogs feed)。
// 用法见 .claude/skills/fetch-pvp-logs;典型:
//   SPEC=Shaman_Restoration MIN_RATING=2100 LIMIT=20 npx tsx scripts/fetchPvpLogs.ts
import fs from "fs-extra";
import fetch from "node-fetch";
import os from "os";
import path from "path";

import { fetchDetailedStubs, fetchWithRetry } from "../src/feedClient";
import {
  buildCompQueryString,
  buildGcsMeta,
  checkPayloadCompleteness,
  dedupeByLogObject,
  expectedByteLength,
  isKnownBracket,
  KNOWN_BRACKETS,
  type ManifestEntry,
  matchesSpecFilter,
  parseSpecArg,
  shouldSleepBeforeDownload,
  shouldSleepBeforePage,
  type SpecRole,
  stubToManifestEntry,
  upsertManifestEntry,
} from "../src/pvpLogFetch";

const BRACKET = process.env.BRACKET ?? "3v3"; // "2v2" | "3v3" | "Rated Solo Shuffle"
// 服务端只有 1400/1800/2100/2400 四档生效(按场均 MMR);传 0 = 不过滤
const MIN_RATING = Number(process.env.MIN_RATING ?? 0);
const SPEC = process.env.SPEC ?? ""; // 逗号分隔,数字 id 或枚举名
const SPEC_ROLE = (process.env.SPEC_ROLE ?? "recorder") as SpecRole;
const LIMIT = Number(process.env.LIMIT ?? 20);
// feed 只留最近 ~7 天,深翻页在对方 Firestore 扣费——兜底防翻到天荒地老
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 40);
// 志愿者项目(wowarenalogs)的 Firestore/GCS 账单不是我们的——礼貌性节流:
// 翻页之间固定歇一下。见 .claude/skills/fetch-pvp-logs「礼貌频率」一条:
// 对方无限流,但别并发轰、别翻空页。
const PAGE_SLEEP_MS = 500;
// 下载额度与翻页额度分开:翻页打的是 Firestore 读,下载打的是 GCS 出口带宽,
// 单场 log 可达 ~30MB —— 按页间隔类比会严重低估下载侧的代价。默认 2s 且串行,
// 相当于峰值 ~15MB/s 的零头;赶语料时可用 DOWNLOAD_SLEEP_MS 调,但别调成 0。
const DOWNLOAD_SLEEP_MS = Number(process.env.DOWNLOAD_SLEEP_MS ?? 2000);
const EVAL_HOME =
  process.env.GLADLOG_EVAL_HOME ??
  path.join(os.homedir(), "code/gladlog-eval-private");

if (!isKnownBracket(BRACKET)) {
  console.error(
    `BRACKET must be one of ${KNOWN_BRACKETS.map((b) => `"${b}"`).join(", ")}, got "${BRACKET}"`,
  );
  process.exit(1);
}

if (SPEC_ROLE !== "recorder" && SPEC_ROLE !== "any") {
  console.error(`SPEC_ROLE must be "recorder" or "any", got "${SPEC_ROLE}"`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const specIds = parseSpecArg(SPEC);
const slug = [
  BRACKET.replace(/\s+/g, ""),
  MIN_RATING > 0 ? `r${MIN_RATING}` : "rall",
  specIds.length ? `${SPEC_ROLE}-${specIds.join("_")}` : "allspecs",
].join("-");
// 默认落在仓外($GLADLOG_EVAL_HOME);OUT_DIR= 可覆盖到任意路径——若改到仓库内,
// 靠根 .gitignore 的 `**/downloads/` + packages/corpus-tools/.gitignore 兜底,
// 但别指望它:manifest.json + 原始 log 含他人 name/rating,严禁 git add -A 带进
// 公开仓库(2026-07 差点因一次 scratch 目录覆盖发生过)。
const OUT_DIR = process.env.OUT_DIR ?? path.join(EVAL_HOME, "downloads", slug);
const MANIFEST = path.join(OUT_DIR, "manifest.json");

async function downloadWithMeta(
  url: string,
  id: string,
): Promise<{
  text: string;
  meta: NonNullable<ManifestEntry["gcsMeta"]>;
  expectedBytes: number | undefined;
}> {
  const res = await fetchWithRetry(
    fetch as any,
    url,
    undefined,
    `log download for ${id}`,
  );
  const headers = (res as any).headers;
  const h = (k: string): string => headers?.get?.(k) ?? "";
  const { meta, missingFields } = buildGcsMeta({
    wowVersion: h("x-goog-meta-wow-version"),
    clientTimezone: h("x-goog-meta-client-timezone"),
    clientYear: h("x-goog-meta-client-year"),
    startTimeUtc: h("x-goog-meta-starttime-utc"),
  });
  if (missingFields.length > 0) {
    // 老上传客户端/CDN 剥离 header 都会触发——不是致命错误(不拦下载),
    // 但必须留痕:空信号字段无提示地混进 manifest 是将来绝对时间重建的地雷。
    console.warn(
      `  warn ${id}: missing gcsMeta headers: ${missingFields.join(", ")}`,
    );
  }
  return {
    text: await (res as any).text(),
    meta,
    expectedBytes: expectedByteLength({
      contentLength: h("content-length"),
      storedContentLength: h("x-goog-stored-content-length"),
    }),
  };
}

async function main() {
  await fs.ensureDir(OUT_DIR);
  // 断点续传:manifest 里已有且文件在盘上的场次直接跳过
  const manifest: ManifestEntry[] = (await fs.pathExists(MANIFEST))
    ? await fs.readJson(MANIFEST)
    : [];
  const have = new Set(
    manifest
      .filter((e) => fs.pathExistsSync(path.join(OUT_DIR, e.fileName)))
      .map((e) => e.id),
  );
  const haveLogs = new Set(
    manifest.filter((e) => have.has(e.id)).map((e) => e.logObjectUrl),
  );

  console.log(
    `bracket=${BRACKET} minRating=${MIN_RATING || "off"} spec=${specIds.join(",") || "all"} role=${SPEC_ROLE} limit=${LIMIT}`,
  );
  console.log(`out: ${OUT_DIR} (resume: ${have.size} already downloaded)`);

  let fresh = 0;
  let scanned = 0;
  let pagesFetched = 0;
  let downloadsAttempted = 0;
  for (let page = 0; page < MAX_PAGES && fresh < LIMIT; page++) {
    // 首页不必空等(没有更早的请求要错开);之后每翻一页先歇 PAGE_SLEEP_MS。
    // 「该不该歇」的判据(shouldSleepBeforePage)有单测覆盖;main() 本身是
    // 顶层立即执行的脚本(无 fetchPvpLogs.test.ts,和 MAX_PAGES/断点续传等
    // 既有逻辑一样未被单测直接跑到),把它接进真实 setTimeout 循环里不再
    // 额外补测——真出问题靠真机日志里的翻页间隔就能看出来。
    if (shouldSleepBeforePage(page)) await sleep(PAGE_SLEEP_MS);
    const { stubs } = await fetchDetailedStubs({
      bracket: BRACKET,
      minRating: MIN_RATING > 0 ? MIN_RATING : undefined,
      // 服务端 comp 预过滤(某一队含这些 spec);recorder 语义再客户端细筛
      compQueryString: specIds.length
        ? buildCompQueryString(specIds)
        : undefined,
      offset: page * 50,
      count: 50,
    });
    if (stubs.length === 0) break;
    pagesFetched++;
    scanned += stubs.length;
    // shuffle 6 轮共享同一 log 对象:页内去重 + 对已下载去重
    const candidates = dedupeByLogObject(stubs).filter(
      (s) =>
        !have.has(s.id) &&
        !haveLogs.has(s.logObjectUrl) &&
        matchesSpecFilter(s, specIds, SPEC_ROLE),
    );
    for (const stub of candidates) {
      if (fresh >= LIMIT) break;
      const fileName = `${stub.id}.txt`;
      // 计**尝试**次数而非成功次数:不完整的下载同样已经消耗了对方出口带宽,
      // 不该因为我们丢弃了结果就免掉它的间隔。
      if (shouldSleepBeforeDownload(downloadsAttempted))
        await sleep(DOWNLOAD_SLEEP_MS);
      downloadsAttempted++;
      const { text, meta, expectedBytes } = await downloadWithMeta(
        stub.logObjectUrl,
        stub.id,
      );
      const completeness = checkPayloadCompleteness(text, expectedBytes);
      if (!completeness.ok) {
        // 不写文件/不进 manifest/不进 dedup 集合:feed 只留 ~7 天,留到下次运行
        // 重试;一旦提前记进去就永久跳过,而 stub 过期后再也补不回来。
        console.warn(
          `  skip ${stub.id}: incomplete download (${completeness.reason})`,
        );
        continue;
      }
      await fs.writeFile(path.join(OUT_DIR, fileName), text);
      upsertManifestEntry(manifest, {
        ...stubToManifestEntry(stub, fileName),
        gcsMeta: meta,
      });
      // 每场落一次 manifest:中断也不丢已下载场次的元数据
      await fs.writeJson(MANIFEST, manifest, { spaces: 2 });
      have.add(stub.id);
      haveLogs.add(stub.logObjectUrl);
      fresh++;
      console.log(
        `  [${fresh}/${LIMIT}] ${stub.id} ${stub.bracket} teamRating=${stub.playerTeamRating} recorderSpec=${stub.units.find((u) => u.id === stub.playerId)?.spec ?? "?"} ${Math.round(text.length / 1024)}KB`,
      );
    }
    if (stubs.length < 50) break; // 短页 = feed 末尾
  }

  console.log(
    `done: ${fresh} new logs (scanned ${scanned} stubs over ${pagesFetched} pages), manifest ${manifest.length} entries`,
  );
  if (fresh < LIMIT) {
    console.log(
      `note: feed 只覆盖最近约 7 天;没凑满 LIMIT 说明该过滤条件下近期就这么多,过几天再跑会有新场次(断点续传自动跳过已下载)。`,
    );
  }
}

main().catch((e) => {
  console.error("fetchPvpLogs failed:", e);
  process.exit(1);
});
