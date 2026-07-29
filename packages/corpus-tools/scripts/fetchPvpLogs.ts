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
  dedupeByLogObject,
  type ManifestEntry,
  matchesSpecFilter,
  parseSpecArg,
  type SpecRole,
  stubToManifestEntry,
} from "../src/pvpLogFetch";

const BRACKET = process.env.BRACKET ?? "3v3"; // "2v2" | "3v3" | "Rated Solo Shuffle"
// 服务端只有 1400/1800/2100/2400 四档生效(按场均 MMR);传 0 = 不过滤
const MIN_RATING = Number(process.env.MIN_RATING ?? 0);
const SPEC = process.env.SPEC ?? ""; // 逗号分隔,数字 id 或枚举名
const SPEC_ROLE = (process.env.SPEC_ROLE ?? "recorder") as SpecRole;
const LIMIT = Number(process.env.LIMIT ?? 20);
// feed 只留最近 ~7 天,深翻页在对方 Firestore 扣费——兜底防翻到天荒地老
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 40);
const EVAL_HOME =
  process.env.GLADLOG_EVAL_HOME ??
  path.join(os.homedir(), "code/gladlog-eval-private");

if (SPEC_ROLE !== "recorder" && SPEC_ROLE !== "any") {
  console.error(`SPEC_ROLE must be "recorder" or "any", got "${SPEC_ROLE}"`);
  process.exit(1);
}

const specIds = parseSpecArg(SPEC);
const slug = [
  BRACKET.replace(/\s+/g, ""),
  MIN_RATING > 0 ? `r${MIN_RATING}` : "rall",
  specIds.length ? `${SPEC_ROLE}-${specIds.join("_")}` : "allspecs",
].join("-");
const OUT_DIR = process.env.OUT_DIR ?? path.join(EVAL_HOME, "downloads", slug);
const MANIFEST = path.join(OUT_DIR, "manifest.json");

async function downloadWithMeta(
  url: string,
  id: string,
): Promise<{ text: string; meta: NonNullable<ManifestEntry["gcsMeta"]> }> {
  const res = await fetchWithRetry(
    fetch as any,
    url,
    undefined,
    `log download for ${id}`,
  );
  const headers = (res as any).headers;
  const h = (k: string): string => headers?.get?.(k) ?? "";
  return {
    text: await (res as any).text(),
    meta: {
      wowVersion: h("x-goog-meta-wow-version"),
      clientTimezone: h("x-goog-meta-client-timezone"),
      clientYear: h("x-goog-meta-client-year"),
      startTimeUtc: h("x-goog-meta-starttime-utc"),
    },
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
  for (let page = 0; page < MAX_PAGES && fresh < LIMIT; page++) {
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
      const { text, meta } = await downloadWithMeta(stub.logObjectUrl, stub.id);
      if (!text.includes("ARENA_MATCH_START")) {
        console.warn(`  skip ${stub.id}: no ARENA_MATCH_START in payload`);
        continue;
      }
      await fs.writeFile(path.join(OUT_DIR, fileName), text);
      manifest.push({ ...stubToManifestEntry(stub, fileName), gcsMeta: meta });
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
