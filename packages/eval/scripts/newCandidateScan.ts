/* eslint-disable no-console */
/**
 * 新候选三类语料实证扫描(arenacoach 批次1 Task 6):量化
 * death-unused-defensive / external-unused / wasted-trinket 在真实语料上的
 * 发生率(出现场次 / applicable 分母 / 场均条数),并为人工抽检导出每类前
 * 5 条完整 facts + 场源(日志路径 + match/round 起始时间)。
 *
 * applicable 分母定义(task-6-brief.md Step 1):
 *  - death-unused-defensive: owner 本场有死亡
 *  - external-unused:        队友(非 owner)本场有死亡 且 owner 有外减(kit
 *                             里至少一个 isAllyCastableDefensive 大 CD,不要求已用)
 *  - wasted-trinket:         owner 本场用过 PvP 饰品(trinketUseTimes 非空)
 *
 * owner 判定与 candidateFindings 门规一致(playerId 优先,回退友方治疗)—
 * 镜像 packages/desktop/.../report/derive/analysisInput.ts 与
 * packages/eval/scripts/confidenceAudit.ts 的既有逻辑,不许另开一份。
 *
 * Usage: npx tsx packages/eval/scripts/newCandidateScan.ts --manifest <file>
 */
import { readFileSync } from "fs";
import path from "path";

import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { toLegacyMatch, CombatUnitReaction } from "@gladlog/parser-compat";
import {
  analyzePlayerCCAndTrinket,
  ensureAnalysisData,
  extractCandidateFindings,
  extractMajorCooldowns,
  isAllyCastableDefensive,
  isHealerSpec,
  type CandidateEvent,
} from "@gladlog/analysis";

function parseArgs(): { manifest: string } {
  const a = process.argv.slice(2);
  let manifest = "";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--manifest") manifest = a[i + 1] ?? "";
  }
  if (!manifest) {
    console.error("Usage: newCandidateScan --manifest <file>");
    process.exit(1);
  }
  return { manifest };
}

const TYPES = [
  "death-unused-defensive",
  "external-unused",
  "wasted-trinket",
] as const;
type TType = (typeof TYPES)[number];

const SAMPLE_CAP = 5;

interface Sample {
  source: string;
  facts: Record<string, string>;
}

interface TypeStats {
  applicableMatches: number;
  matchesWithEmit: number;
  totalEvents: number;
  samples: Sample[];
}

function freshStats(): TypeStats {
  return {
    applicableMatches: 0,
    matchesWithEmit: 0,
    totalEvents: 0,
    samples: [],
  };
}

async function main() {
  const { manifest } = parseArgs();
  await ensureAnalysisData();

  const files = readFileSync(manifest, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const stats: Record<TType, TypeStats> = {
    "death-unused-defensive": freshStats(),
    "external-unused": freshStats(),
    "wasted-trinket": freshStats(),
  };

  let logsRead = 0;
  let logsUnreadable = 0;
  let matchesTotal = 0;
  let matchesNoOwner = 0;
  let matchesFailed = 0;

  for (const [fileIdx, f] of files.entries()) {
    const t0 = Date.now();
    let content: string;
    try {
      content = readFileSync(f, "utf8");
      logsRead++;
    } catch {
      console.error(`skip unreadable log: ${f}`);
      logsUnreadable++;
      continue;
    }
    // 进度日志(诊断需要:70 个日志、单个可达数百 MB,不逐条打点就没法判断
    // 是卡死/OOM 还是仍在正常跑)。
    console.log(
      `[${fileIdx + 1}/${files.length}] ${path.basename(f)} (${(content.length / 1e6).toFixed(1)}MB) …`,
    );

    const parser = new GladLogParser();
    const items: GladMatch[] = [];
    parser.on("match", (m) => items.push(m));
    parser.on("shuffle", (s) => items.push(...(s.rounds as never[])));
    for (const line of content.split("\n")) parser.push(line);
    parser.end();
    // content 与逐行数组只在本轮迭代内需要;显式释放引用,避免在 70 个大日志
    // 上累积常驻内存(下一轮 readFileSync 前旧内容应已可被 GC)。
    content = "";

    console.log(
      `  parsed: ${items.length} match/round(s), ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    items.forEach((m, idx) => {
      try {
        const legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
        const units = Object.values(legacy.units);
        const players = units.filter((u) => u.info);
        const owner =
          players.find(
            (u) =>
              u.id === legacy.playerId &&
              u.reaction === CombatUnitReaction.Friendly,
          ) ??
          players.find(
            (u) =>
              isHealerSpec(u.spec) &&
              u.reaction === CombatUnitReaction.Friendly,
          );
        matchesTotal++;
        if (!owner) {
          matchesNoOwner++;
          return;
        }

        const source = `${path.basename(f)}#${idx} start=${new Date(legacy.startTime).toISOString()}`;
        const candidates = extractCandidateFindings(legacy, owner.id);

        // --- 分母:death-unused-defensive(owner 本场有死亡) ---
        const ownerDied =
          (legacy.units[owner.id]?.deathRecords ?? []).length > 0;
        if (ownerDied) stats["death-unused-defensive"].applicableMatches++;

        // --- 分母:external-unused(队友有死亡 且 owner 有外减) ---
        const friends = players.filter((u) => u.reaction === owner.reaction);
        const enemies = players.filter((u) => u.reaction !== owner.reaction);
        const teammateDied = friends.some(
          (u) => u.id !== owner.id && (u.deathRecords ?? []).length > 0,
        );
        let ownerHasExternal = false;
        try {
          ownerHasExternal = extractMajorCooldowns(owner, legacy).some((cd) =>
            isAllyCastableDefensive(cd.spellId),
          );
        } catch {
          /* CD 摘要不可算 → 保守视为无外减 */
        }
        if (teammateDied && ownerHasExternal)
          stats["external-unused"].applicableMatches++;

        // --- 分母:wasted-trinket(owner 本场用过饰品) ---
        let ownerUsedTrinket = false;
        try {
          const enemyIds = new Set(enemies.map((u) => u.id));
          const enemyPets = units.filter(
            (u) => u.ownerId && enemyIds.has(u.ownerId),
          );
          ownerUsedTrinket =
            analyzePlayerCCAndTrinket(owner, enemies, legacy, enemyPets)
              .trinketUseTimes.length > 0;
        } catch {
          /* CC/饰品摘要不可算 → 保守视为未用 */
        }
        if (ownerUsedTrinket) stats["wasted-trinket"].applicableMatches++;

        // --- 计数与抽样 ---
        const byType = new Map<string, CandidateEvent[]>();
        for (const c of candidates) {
          if (!TYPES.includes(c.type as TType)) continue;
          const arr = byType.get(c.type) ?? [];
          arr.push(c);
          byType.set(c.type, arr);
        }
        for (const t of TYPES) {
          const evs = byType.get(t) ?? [];
          if (evs.length === 0) continue;
          const s = stats[t];
          s.matchesWithEmit++;
          s.totalEvents += evs.length;
          if (s.samples.length < SAMPLE_CAP) {
            s.samples.push({ source, facts: evs[0]!.facts });
          }
        }
      } catch (err) {
        matchesFailed++;
        console.error(`  match #${idx} failed: ${(err as Error).message}`);
      }
    });
    console.log(
      `  done: total=${matchesTotal} no-owner=${matchesNoOwner} failed=${matchesFailed} (${((Date.now() - t0) / 1000).toFixed(1)}s file total)`,
    );
  }

  console.log(
    `logs: read=${logsRead} unreadable=${logsUnreadable}; matches: total=${matchesTotal} no-owner=${matchesNoOwner} failed=${matchesFailed}`,
  );
  console.log();
  console.log(
    "type".padEnd(26) +
      "emit-matches".padEnd(14) +
      "applicable".padEnd(12) +
      "rate".padEnd(9) +
      "events".padEnd(9) +
      "events/applicable",
  );
  for (const t of TYPES) {
    const s = stats[t];
    const rate =
      s.applicableMatches > 0
        ? ((100 * s.matchesWithEmit) / s.applicableMatches).toFixed(1) + "%"
        : "n/a(denom=0)";
    const perApplicable =
      s.applicableMatches > 0
        ? (s.totalEvents / s.applicableMatches).toFixed(2)
        : "n/a";
    console.log(
      t.padEnd(26) +
        String(s.matchesWithEmit).padEnd(14) +
        String(s.applicableMatches).padEnd(12) +
        rate.padEnd(9) +
        String(s.totalEvents).padEnd(9) +
        perApplicable,
    );
  }

  for (const t of TYPES) {
    console.log(`\n=== ${t}: 抽检样本(前 ${SAMPLE_CAP}) ===`);
    stats[t].samples.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.source}`);
      console.log(`      facts = ${JSON.stringify(s.facts)}`);
    });
    if (stats[t].samples.length === 0) console.log("  (无样本)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
