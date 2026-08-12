/**
 * 天赋归属谓词的语料矛盾审计(BACKLOG #23-1 精准验收,常驻脚本)。
 *
 * 「不错」方向的铁证:对每一轮、每个有 COMBATANT_INFO 的玩家、该轮实际
 * SPELL_CAST_SUCCESS 过的每个 distinct spellId——表判据
 * `talentOwnershipFromTables`(不吃施法证据,否则审计自证)若判「no」
 * 即为矛盾:玩家明明施放了,表却说他没有。目标 0 矛盾;残余逐条列出
 * (spellId/spec/场次)供查明是数据缺口还是分类错,不许含糊。
 *
 * 附带:
 *  - 消费白名单(deathOutcome 两张表)在对应 spec 单位上的判定分布
 *    (yes/no/unknown)——天赋数据在手时 unknown 必须为 0;
 *  - 白名单技能全语料施法计数(腐烂探测:baseline 分类却全库 0 施法
 *    = 疑似已从游戏移除,如 12.1 的 Netherwalk 196555);
 *  - 数据在手率:有 info 的单位中 talents 可解析的占比(unknown 只许
 *    出现在数据真缺失的轮,这里报出占比)。
 *
 * 用法: npx tsx auditTalentOwnership.ts [--recent=N](缺省全库)
 * 长跑:全库 ~800 场,建议后台运行、大 timeout。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ensureAnalysisData,
  EXTERNAL_DEFENSIVE_SPELLS,
  IMMUNITY_SPELLS,
  talentOwnershipFromTables,
} from "@gladlog/analysis";
import { LogEvent } from "@gladlog/parser-compat";

import { toLegacySafe } from "../src/renderer/src/report/derive/legacySource";

const MATCH_DIR = join(
  homedir(),
  "Library/Application Support/gladlog/matches",
);

function arg(name: string, dflt: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? parseInt(m.split("=")[1], 10) : dflt;
}

async function main() {
  await ensureAnalysisData();
  const recentN = arg("recent", 0);

  const whitelist = new Map<string, Set<string>>(); // spellId -> specs
  for (const [id, s] of Object.entries(IMMUNITY_SPELLS))
    whitelist.set(id, new Set(s.specs as string[]));
  for (const [id, s] of Object.entries(EXTERNAL_DEFENSIVE_SPELLS))
    whitelist.set(id, new Set(s.specs as string[]));

  const index = readFileSync(join(MATCH_DIR, "_index.ndjson"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { id: string; kind?: string });
  const batch = recentN > 0 ? index.slice(-recentN) : index;

  let roundsTotal = 0;
  let unitsWithInfo = 0;
  let unitsTalentsParsed = 0;
  let castPairsChecked = 0;
  let contradictions = 0;
  const contraBySpell = new Map<string, number>();
  const contraExamples: string[] = [];
  // 白名单判定分布: spellId -> {yes,no,unknown} (仅对 spec 匹配的单位判)
  const wlVerdicts = new Map<
    string,
    { yes: number; no: number; unknown: number }
  >();
  const wlCasts = new Map<string, number>(); // 腐烂探测:全语料施法计数
  let failedMatches = 0;

  for (const [i, meta] of batch.entries()) {
    if (i % 100 === 0) console.error(`progress ${i}/${batch.length}`);
    let doc: { kind?: string; data?: { rounds?: unknown[] } };
    try {
      doc = JSON.parse(
        readFileSync(join(MATCH_DIR, meta.id, "match.json"), "utf-8"),
      );
    } catch {
      failedMatches++;
      continue;
    }
    const rounds: unknown[] =
      doc.kind === "shuffle" ? (doc.data?.rounds ?? []) : [doc.data];
    for (const src of rounds) {
      let legacy: { units?: Record<string, unknown> };
      try {
        legacy = toLegacySafe(src) as never;
      } catch {
        continue;
      }
      roundsTotal++;
      for (const u of Object.values(legacy.units ?? {}) as never[]) {
        const unit = u as {
          spec: string;
          info?: { talents?: unknown[] };
          spellCastEvents: {
            spellId: string | null;
            logLine: { event: string };
          }[];
        };
        if (!unit.info) continue;
        unitsWithInfo++;
        if (unit.info.talents?.length) unitsTalentsParsed++;

        const castIds = new Set<string>();
        for (const e of unit.spellCastEvents ?? [])
          if (e.spellId && e.logLine.event === LogEvent.SPELL_CAST_SUCCESS)
            castIds.add(e.spellId);

        // 矛盾判据:实际施放过却被表判「no」
        for (const spellId of castIds) {
          castPairsChecked++;
          if (talentOwnershipFromTables(unit as never, spellId) === "no") {
            contradictions++;
            contraBySpell.set(spellId, (contraBySpell.get(spellId) ?? 0) + 1);
            if (contraExamples.length < 40)
              contraExamples.push(
                `${meta.id.slice(0, 8)} spec=${unit.spec} spell=${spellId}`,
              );
          }
          if (whitelist.has(spellId))
            wlCasts.set(spellId, (wlCasts.get(spellId) ?? 0) + 1);
        }

        // 白名单判定分布(spec 匹配的单位)
        for (const [spellId, specs] of whitelist) {
          if (!specs.has(unit.spec)) continue;
          const v = talentOwnershipFromTables(unit as never, spellId);
          const rec = wlVerdicts.get(spellId) ?? { yes: 0, no: 0, unknown: 0 };
          rec[v]++;
          wlVerdicts.set(spellId, rec);
        }
      }
    }
  }

  const fmtMap = (m: Map<string, number>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  console.log(
    JSON.stringify(
      {
        batch: { matches: batch.length, failedMatches, roundsTotal },
        coverage: { unitsWithInfo, unitsTalentsParsed },
        contradiction: {
          castPairsChecked,
          contradictions,
          bySpell: fmtMap(contraBySpell),
          examples: contraExamples,
        },
        whitelistVerdicts: Object.fromEntries(wlVerdicts),
        whitelistCastCounts: fmtMap(wlCasts),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
