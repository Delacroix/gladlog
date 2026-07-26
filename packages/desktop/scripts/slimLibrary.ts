/**
 * 全库瘦身迁移(2026-07-26 审计后续,用户拍板):把 slim 谓词(出厂路径与
 * 自愈路径已在用的同一个 slimStoredDoc)批量应用到还没瘦过的存档。
 *
 * 安全性设计:
 * - raw.txt 永不触碰(字节精确源头,match.json 任何时候可由 parser 重建);
 * - 逐场原子:写 match.json.slimtmp → 回读逐字节比对 → 结构不变量校验
 *   (kind/id/units 键集/各事件数组长度/rounds 数)→ rename 覆盖;
 * - 可中断续跑:meta.slimmed=true 即跳过,Ctrl-C 后重跑从断点继续;
 * - 顺写 meta.roundLinesTotal(shuffle)供 rawLine 免 parse 取行偏移。
 *
 * 用法:npx tsx packages/desktop/scripts/slimLibrary.ts [matchesDir]
 *   缺省 matchesDir = ~/Library/Application Support/gladlog/matches
 *   GLADLOG_SLIM_LIMIT=N 只处理前 N 场(试跑用)。
 */
import { readFileSync, writeFileSync, renameSync, statSync } from "fs";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { slimStoredDoc } from "../src/shared/slimDoc";

const dir =
  process.argv[2] ??
  join(homedir(), "Library/Application Support/gladlog/matches");
const limit = Number(process.env.GLADLOG_SLIM_LIMIT ?? Infinity);

type Doc = {
  kind?: string;
  data?: {
    id?: string;
    kind?: string;
    units?: Record<string, Record<string, unknown>>;
    rounds?: Array<{
      sequenceNumber: number;
      linesTotal: number;
      units?: Record<string, Record<string, unknown>>;
    }>;
  };
};

/** 结构不变量指纹:slim 只裁 params 位/物化 crit,这些必须逐项不变。 */
function fingerprint(doc: Doc): string {
  const unitSig = (units?: Record<string, Record<string, unknown>>) =>
    Object.entries(units ?? {})
      .map(
        ([id, u]) =>
          `${id}:` +
          Object.entries(u)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => `${k}=${(v as unknown[]).length}`)
            .sort()
            .join(","),
      )
      .sort()
      .join(";");
  const d = doc.data ?? {};
  const rounds = Array.isArray(d.rounds)
    ? d.rounds.map((r) => `[${r.sequenceNumber}:${unitSig(r.units)}]`).join("")
    : unitSig(d.units);
  return `${doc.kind}|${d.id ?? ""}|${rounds}`;
}

async function main(): Promise<void> {
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const t0 = Date.now();

  for (const id of ids) {
    if (done + skipped >= limit) break;
    const matchPath = join(dir, id, "match.json");
    const metaPath = join(dir, id, "meta.json");
    if (!existsSync(matchPath) || !existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        slimmed?: boolean;
        kind?: string;
        roundLinesTotal?: Array<{ seq: number; lines: number }> | number[];
      };
      const legacyForm =
        Array.isArray(meta.roundLinesTotal) &&
        typeof meta.roundLinesTotal[0] === "number";
      if (meta.slimmed && !legacyForm) {
        skipped++;
        continue;
      }
      // legacyForm:首版脚本写过丢 seq 的 number[],doc 已瘦,只需重读补 meta
      const before = statSync(matchPath).size;
      const doc = JSON.parse(readFileSync(matchPath, "utf-8")) as Doc;
      const fpBefore = fingerprint(doc);
      const changed = slimStoredDoc(doc);

      if (changed) {
        const out = JSON.stringify(doc);
        // 结构不变量:裁剪后指纹必须一致(unit 键集、各事件数组长度)
        const fpAfter = fingerprint(doc);
        if (fpAfter !== fpBefore)
          throw new Error(`结构指纹变了,拒绝写入: ${id}`);
        const tmp = matchPath + ".slimtmp";
        writeFileSync(tmp, out);
        // 回读逐字节比对:防半写/磁盘错误
        const back = readFileSync(tmp, "utf-8");
        if (back !== out) throw new Error(`回读不一致,拒绝覆盖: ${id}`);
        renameSync(tmp, matchPath);
      }
      // meta 回填(shuffle 顺写行偏移表)
      meta.slimmed = true;
      if (Array.isArray(doc.data?.rounds)) {
        // 对偶形式 {seq, lines}:rawLine 的偏移判据是 sequenceNumber <
        // roundSeq,不能假设轮号 0 起连续 —— 丢 seq 的裸数组不够用。
        meta.roundLinesTotal = [...doc.data.rounds]
          .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
          .map((r) => ({ seq: r.sequenceNumber, lines: r.linesTotal }));
      }
      writeFileSync(metaPath + ".slimtmp", JSON.stringify(meta, null, 2));
      renameSync(metaPath + ".slimtmp", metaPath);

      const after = statSync(matchPath).size;
      bytesBefore += before;
      bytesAfter += after;
      done++;
      if (done % 25 === 0)
        console.log(
          `[slim] ${done} done (${skipped} skipped, ${failed} failed) ` +
            `${(bytesBefore / 1e9).toFixed(1)}GB→${(bytesAfter / 1e9).toFixed(1)}GB ` +
            `${Math.round((Date.now() - t0) / 1000)}s`,
        );
      // 让位:别把机器 IO 打满
      await new Promise((r) => setImmediate(r));
    } catch (err) {
      failed++;
      console.error(`[slim] FAIL ${id}: ${String(err)}`);
    }
  }
  console.log(
    `[slim] 完成: ${done} 场瘦身, ${skipped} 已瘦跳过, ${failed} 失败; ` +
      `处理档 ${(bytesBefore / 1e9).toFixed(2)}GB → ${(bytesAfter / 1e9).toFixed(2)}GB ` +
      `(-${bytesBefore ? Math.round((1 - bytesAfter / bytesBefore) * 100) : 0}%), ` +
      `耗时 ${Math.round((Date.now() - t0) / 1000)}s`,
  );
}

void main();
