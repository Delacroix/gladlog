/** acceptanceDpsCount.ts — DPS 视角验收计数(常驻,2026-08-19 从 zz-tmp 转正)。
 *
 * acceptanceHash 的 owner 恒为治疗,DPS-owner 候选类型(burst-into-immunity /
 * burst-into-mitigation / dr-clipped-cc / attempt-into-trinket …)在那份计数
 * 里恒为 0 —— 单靠它验收 DPS 侧改动会假绿(#15 退役时差点发生)。本工具对
 * 每个 DPS 友方各跑一遍 extractCandidateFindings,逐类求和。约为 healer
 * 扫描 2–3 倍耗时。
 *
 * 用法:npx tsx packages/eval/scripts/acceptanceDpsCount.ts 300 > before.txt
 */
import {
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
} from "@gladlog/analysis";

import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  splitTeams,
} from "../src/explore/storeAccess";

const N = process.argv[2] !== undefined ? Number(process.argv[2]) : 300;
await ensureAnalysisData();

const counts = new Map<string, number>();
let rounds = 0;

const index = loadIndex(DEFAULT_MATCH_DIR);
for (const meta of N > 0 ? index.slice(-N) : index) {
  const legacies: unknown[] = [];
  try {
    const first = loadLegacyRound(DEFAULT_MATCH_DIR, meta.id, 0);
    legacies.push(first.legacy);
    if (first.kind === "shuffle")
      for (let i = 1; i < 12; i++) {
        try {
          legacies.push(loadLegacyRound(DEFAULT_MATCH_DIR, meta.id, i).legacy);
        } catch {
          break;
        }
      }
  } catch {
    continue;
  }
  for (const legacy of legacies) {
    rounds++;
    const { friends } = splitTeams(legacy as Parameters<typeof splitTeams>[0]);
    for (const f of friends) {
      if (isHealerSpec(f.spec)) continue;
      let cands;
      try {
        cands = extractCandidateFindings(
          legacy as Parameters<typeof extractCandidateFindings>[0],
          f.id,
        );
      } catch {
        continue;
      }
      for (const c of cands) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
    }
  }
}

console.log(`rounds=${rounds}(每轮多个 DPS owner,计数为 owner 视角求和)`);
for (const [t, n] of [...counts.entries()].sort()) console.log(`  ${t}: ${n}`);
