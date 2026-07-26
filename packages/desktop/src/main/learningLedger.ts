/**
 * 学习台账(spec §1):append-only NDJSON,一行 = 一次分析 run(内嵌该场
 * findings)。同场重分析追加新行,读取按 matchId 取 createdAt 最大行 ——
 * last-run-wins 整场替换,免得被新一轮放弃的旧 finding 永久残留。
 *
 * promptVersion 只记录不作废:台账的记忆不被 analysis 缓存失效策略绑架,
 * 这是它独立于 analysis-v2.*.json 存在的核心理由。
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import type {
  LedgerMatch,
  LedgerRun,
} from "@gladlog/analysis/src/learning/types";

/** 行数超过归并后对局数的 1.2 倍(>20% 冗余)才重写 —— spec §6。 */
const COMPACT_REDUNDANCY_FACTOR = 1.2;

export type LearningLedger = ReturnType<typeof createLearningLedger>;

export function createLearningLedger(learningDir: string) {
  const file = join(learningDir, "ledger.ndjson");

  const readMerged = (): {
    byMatch: Map<string, LedgerRun>;
    badLines: number;
    totalLines: number;
  } => {
    const byMatch = new Map<string, LedgerRun>();
    let badLines = 0;
    let totalLines = 0;
    let raw = "";
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return { byMatch, badLines, totalLines };
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      totalLines++;
      try {
        const r = JSON.parse(line) as LedgerRun;
        if (r.v !== 1 || typeof r.matchId !== "string")
          throw new Error("shape");
        const prev = byMatch.get(r.matchId);
        if (!prev || r.createdAt >= prev.createdAt) byMatch.set(r.matchId, r);
      } catch {
        badLines++; // 坏行跳过不静默:计数上抛给 getState 展示
      }
    }
    return { byMatch, badLines, totalLines };
  };

  return {
    file,
    append(runs: LedgerRun[]): void {
      if (runs.length === 0) return;
      mkdirSync(learningDir, { recursive: true });
      appendFileSync(
        file,
        runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    },
    read(): { matches: LedgerMatch[]; badLines: number; totalLines: number } {
      const { byMatch, badLines, totalLines } = readMerged();
      const matches = [...byMatch.values()].map(
        ({ v: _v, promptVersion: _p, createdAt: _c, ...m }) => m,
      );
      return { matches, badLines, totalLines };
    },
    /** 冗余超阈值时重写为归并视图(tmp+rename 原子,与 analysis 缓存同法)。 */
    compact(): void {
      const { byMatch, totalLines } = readMerged();
      if (totalLines <= byMatch.size * COMPACT_REDUNDANCY_FACTOR) return;
      const tmp = `${file}.tmp`;
      writeFileSync(
        tmp,
        [...byMatch.values()].map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
      renameSync(tmp, file);
    },
  };
}
