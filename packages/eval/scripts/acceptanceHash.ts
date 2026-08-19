/** acceptanceHash.ts — 验收基准工具(常驻,2026-08-19 从 zz-tmp 转正)。
 *
 * n 场扫描(healer owner):生产候选菜单 + 完整 findings prompt,输出聚合
 * SHA256 + 逐类候选计数。任何触碰候选/渲染的改动,同判据前后各跑一遍、
 * diff 两份输出 —— 哈希不动=prompt 逐字节不变;哈希动了则逐类计数指认
 * 变化落点,每个非零 delta 都要解释到机制。这是 2026-08 谓词批次以来所有
 * 验收的主口径(CLAUDE.md 验证规则的执行工具)。
 *
 * 覆盖边界(2026-08-18 两次实测教训,勿再踩):它只看 buildFindingsPrompt,
 * **看不见** formatDispelContextForAI(驱散标注)与
 * formatKillWindowTargetSelectionForContext(match context 的 TARGET
 * SELECTION 行)—— 那些路径的改动要配专用探针,拿本工具的「零变化」当
 * 「无影响」是假绿。owner 恒为治疗:DPS-owner 类型(见
 * acceptanceDpsCount.ts)在本口径恒为 0。
 *
 * 用法:npx tsx packages/eval/scripts/acceptanceHash.ts 300 > before.txt
 *(单进程跑,全库扫描一次只跑一个 —— 32GB 机器扛不住并行。)
 */
import { createHash } from "node:crypto";

import {
  buildFindingsPrompt,
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
} from "@gladlog/analysis";
import { parseRawStreams } from "@gladlog/analysis/src/utils/rawStreams";

import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  readRawText,
  splitTeams,
} from "../src/explore/storeAccess";

const N_MATCHES = process.argv[2] !== undefined ? Number(process.argv[2]) : 300;

await ensureAnalysisData();
const rows = loadIndex(DEFAULT_MATCH_DIR);
const picked = N_MATCHES > 0 ? rows.slice(-N_MATCHES) : rows;

const typeCounts = new Map<string, number>();
const hash = createHash("sha256");
let rounds = 0;
let promptsHashed = 0;

for (const row of picked) {
  const rawText = readRawText(DEFAULT_MATCH_DIR, row.id);
  const roundInfos: Array<{
    seq: number | undefined;
    legacy: ReturnType<typeof loadLegacyRound>["legacy"];
  }> = [];
  try {
    const first = loadLegacyRound(DEFAULT_MATCH_DIR, row.id, 0);
    if (first.kind === "shuffle") {
      roundInfos.push({ seq: 0, legacy: first.legacy });
      for (let i = 1; i < 12; i++) {
        try {
          roundInfos.push({
            seq: i,
            legacy: loadLegacyRound(DEFAULT_MATCH_DIR, row.id, i).legacy,
          });
        } catch {
          break;
        }
      }
    } else {
      roundInfos.push({ seq: undefined, legacy: first.legacy });
    }
  } catch {
    continue;
  }

  for (const r of roundInfos) {
    rounds++;
    const legacy = r.legacy;
    const { friends } = splitTeams(legacy);
    const owner = friends.find((u) => isHealerSpec(u.spec));
    if (!owner) continue;
    const durS = (legacy.endTime - legacy.startTime) / 1000;
    const streams =
      rawText !== null
        ? parseRawStreams(rawText, legacy.startTime, durS)
        : undefined;
    let cands: ReturnType<typeof extractCandidateFindings> = [];
    try {
      cands = extractCandidateFindings(legacy, owner.id, streams);
    } catch {
      continue;
    }
    for (const c of cands)
      typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
    try {
      const prompt = buildFindingsPrompt(cands, "", owner.spec);
      hash.update(`${row.id}:${r.seq ?? ""}\n`);
      hash.update(prompt);
      promptsHashed++;
    } catch {
      /* not buildable → excluded on both sides */
    }
  }
}

console.log(`rounds=${rounds} promptsHashed=${promptsHashed}`);
console.log(`aggregate prompt SHA256: ${hash.digest("hex")}`);
console.log(`per-type candidate counts:`);
for (const [t, n] of [...typeCounts.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
))
  console.log(`  ${t}: ${n}`);
