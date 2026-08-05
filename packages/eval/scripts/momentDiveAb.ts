/**
 * Moment deep-dive A/B acceptance script (SDD 2026-08-05, Task 7 — a permanent
 * acceptance tool per CLAUDE.md's "修复要给前后数字" rule, not a one-off).
 *
 * Loads the N most recent matches / shuffle-rounds from THIS MACHINE's local
 * match library (~/Library/Application Support/gladlog/matches) that carry a
 * friendly-death anchor, and for each anchor's [deathT-10, deathT+10] window
 * runs the exact production pipeline twice through the SAME judge:
 *   A = buildWindowPack(..., opts=undefined)       -- current window pipeline
 *   B = buildWindowPack(..., { snapshot: true })   -- dense moment snapshot (Task 1/2)
 * Both prompts (buildDeepDivePrompt(..., "window")) go to the same
 * `claude -p --output-format text --model claude-sonnet-5` (prompt on stdin,
 * an inlined zh-coach system line prepended — mirrors `claudeCliClientFactory`
 * in packages/desktop/src/main/localAiBackends.ts, which eval cannot import),
 * and both responses are scored by the SAME auditDeepDives (shared-predicate
 * rule: one judge for A and B, never a separate pass/fail path per arm). B
 * additionally gets `checkSnapshotFactsConsistency` (Task 3's 6th hardFailure
 * class) run against its raw prompt text — this is that check's first live
 * run against real corpus prompts.
 *
 * Usage: npx tsx packages/eval/scripts/momentDiveAb.ts [N=10]
 * (N=2 smoke test recommended first — each claude call can take 60-300s.)
 *
 * ---- 首轮基线(2026-08-05,N=10,本机对局库,claude-sonnet-5)----
 * 10 个死亡锚点(3 个双臂 buildWindowPack 均无信号,7 个有信号):
 * A 均值 0.40 条/场(有信号子集 0.57)· B 均值 0.30 条/场(有信号子集 0.43)·
 * B 第 6 类(checkSnapshotFactsConsistency)违规 3 处 / 7 个 B prompt 中 2 个命中
 * ——该门规首次在真实语料上通电,证明它真的会响,不是只在单测里过。
 * 本轮 B ≤ A,未达「B 更优」的验收预期(详见 spec「验收」节的 DONE_WITH_CONCERNS
 * 记录与两条静音归因:一条败给裸数字纪律——模型把合法 key 直接写成 "p11" 而不是
 * "{{p11.field}}",被审计当成裸数字打回;另一条败给 JSON 转义——中文正文里的直角
 * 引号("...")破坏了 JSON.parse,不是快照证据本身的问题)。样本量小(N=10,3 个
 * 双臂空信号进一步稀释了能比较的锚点到 7 个),结论仅供参考,不是最终定论。
 * 完整表见 docs/superpowers/specs/2026-08-05-moment-deep-dive-design.md 的「验收」节。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  auditDeepDives,
  buildDeepDivePrompt,
  buildWindowAnchorFinding,
  buildWindowPack,
  type CandidateEvent,
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
  parseModelJsonArray,
  SNAPSHOT_KINDS,
  specToString,
} from "@gladlog/analysis";
import type { GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

import { checkSnapshotFactsConsistency } from "../src/quality/promptQualityCheck";

const MATCH_DIR = join(
  homedir(),
  "Library/Application Support/gladlog/matches",
);

const N = Number(process.argv[2] ?? 10);

// Same nature as `buildCoachSystemPrompt("zh")` in packages/desktop/src/main/ai.ts
// (eval cannot import desktop/main) — an inlined equivalent, not a byte-for-byte
// copy; A and B use this identical string, so fairness does not depend on
// matching the product's exact wording.
const SYSTEM =
  "You are a World of Warcraft arena coach reviewing a player's match. Be direct, specific, and grounded strictly in the provided events. Respond entirely in Simplified Chinese (简体中文). Keep spell/ability names in English exactly as written in the data.";

// Named MatchLibraryEntry, not IndexEntry: this is a row of the match
// LIBRARY's `_index.ndjson` (id/kind only) — a different shape entirely from
// buildCorpus.ts's `IndexEntry` (ordinal/file/matchId/spec/result/ownerName,
// one row per prompt corpus entry). The two used to share the name "IndexEntry"
// by coincidence; predicateIndex.test.ts's single-declaration check flagged it
// as a false-positive duplicate (verified: genuinely different data, not a
// shared predicate to consolidate — see docs/predicate-index.md "尚未统一").
interface MatchLibraryEntry {
  id: string;
  kind?: string;
}

/** `_index.ndjson` grows by append; a match re-touched by the 2026-07-26 slim
 * migration appears twice with the same id — last occurrence wins (most
 * complete record), same convention as the file itself (last write is truth). */
function loadIndex(): MatchLibraryEntry[] {
  const lines = readFileSync(join(MATCH_DIR, "_index.ndjson"), "utf8")
    .trim()
    .split("\n");
  const byId = new Map<string, MatchLibraryEntry>();
  for (const line of lines) {
    const e = JSON.parse(line) as MatchLibraryEntry;
    byId.set(e.id, e);
  }
  return [...byId.values()];
}

interface Anchor {
  matchId: string;
  roundSeq?: number;
  spec: string;
  ownerName: string;
  deathT: number;
  fromS: number;
  toS: number;
  legacy: unknown;
  candidates: CandidateEvent[];
}

function findOwner(legacy: {
  units?: Record<string, unknown>;
  playerId?: string;
}) {
  const players = Object.values(legacy.units ?? {}).filter(
    (
      u,
    ): u is {
      id: string;
      name: string;
      info: unknown;
      reaction: unknown;
      spec: unknown;
    } => !!(u as { info?: unknown }).info,
  );
  return (
    players.find(
      (u) =>
        u.id === legacy.playerId && u.reaction === CombatUnitReaction.Friendly,
    ) ??
    players.find(
      (u) =>
        isHealerSpec(u.spec as never) &&
        u.reaction === CombatUnitReaction.Friendly,
    )
  );
}

/** eval's legacy-conversion convention (NOT desktop's `toLegacySafe`, which
 * eval cannot import — see confidenceAudit.ts / evidenceDist.ts / every
 * deepDive*.ts scan script: `toLegacyMatch({ ...m, rawLines: [] })` wrapped in
 * try/catch). Real library matches are complete records (not trimmed render-
 * test fixtures), so `toLegacySafe`'s missing-array padding has no effect here
 * anyway — see legacySource.ts's own header comment. */
function tryAnchor(
  roundData: GladMatch,
  matchId: string,
  roundSeq?: number,
): Anchor | null {
  let legacy;
  try {
    legacy = toLegacyMatch({ ...roundData, rawLines: [] } as GladMatch) as {
      units: Record<string, unknown>;
      playerId?: string;
      startTime: number;
      endTime: number;
    };
  } catch {
    return null;
  }
  const owner = findOwner(legacy);
  if (!owner) return null;
  const candidates = extractCandidateFindings(legacy, owner.id);
  const death = candidates
    .filter((c) => c.type === "death" && c.facts.side === "friendly")
    .sort((a, b) => b.t - a.t)[0];
  if (!death) return null;
  const durS = (legacy.endTime - legacy.startTime) / 1000;
  const fromS = Math.max(0, death.t - 10);
  const toS = Math.min(durS, death.t + 10);
  return {
    matchId,
    roundSeq,
    spec: specToString(owner.spec as never),
    ownerName: owner.name,
    deathT: death.t,
    fromS,
    toS,
    legacy,
    candidates,
  };
}

/** Newest-first scan of the local library, one anchor per distinct match/
 * shuffle (diversity across N different games rather than N rounds of the
 * same shuffle) — the first round (in file order) that yields a friendly-
 * death anchor wins; a shuffle with no death in any round is skipped
 * entirely, same cost-control shape as verify-production.ts's `pickSources`. */
function collectAnchors(n: number): Anchor[] {
  const entries = [...loadIndex()].reverse();
  const anchors: Anchor[] = [];
  for (const e of entries) {
    if (anchors.length >= n) break;
    let doc: { data?: unknown };
    try {
      doc = JSON.parse(
        readFileSync(join(MATCH_DIR, e.id, "match.json"), "utf8"),
      ) as { data?: unknown };
    } catch {
      continue;
    }
    const data = doc.data as { rounds?: unknown[] } | undefined;
    if (!data) continue;
    const rounds: unknown[] =
      e.kind === "shuffle" ? (data.rounds ?? []) : [data];
    for (const r of rounds) {
      const roundSeq = (r as { sequenceNumber?: number }).sequenceNumber;
      const a = tryAnchor(
        r as GladMatch,
        e.id,
        e.kind === "shuffle" ? roundSeq : undefined,
      );
      if (a) {
        anchors.push(a);
        break;
      }
    }
  }
  return anchors;
}

function callClaude(prompt: string): string {
  return execFileSync(
    "claude",
    ["-p", "--output-format", "text", "--model", "claude-sonnet-5"],
    {
      input: `${SYSTEM}\n${prompt}`,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 280_000,
    },
  );
}

interface ArmResult {
  auditedCount: number;
  /** Raw model text for entries the model produced but auditDeepDives
   * rejected (parsed-but-not-kept) — for the silence-rate manual attribution
   * the brief asks for. A model that proactively emits [] is NOT counted here
   * (that is honest abstention, not an audit drop). */
  droppedTexts: string[];
  snapshotItemCount: number;
  /** Task 3's 6th hardFailure class; only meaningful for the B (snapshot) arm. */
  snapshotViolations: number;
}

function runArm(
  anchor: Anchor,
  snapshot: boolean,
): { arm: ArmResult; note?: string } {
  const empty: ArmResult = {
    auditedCount: 0,
    droppedTexts: [],
    snapshotItemCount: 0,
    snapshotViolations: 0,
  };
  const built = buildWindowPack(
    anchor.legacy,
    anchor.fromS,
    anchor.toS,
    anchor.candidates,
    anchor.ownerName,
    snapshot ? { snapshot: true } : undefined,
  );
  if (!built) return { arm: empty, note: "无信号(buildWindowPack=null)" };
  const { pack, kind } = built;
  const finding = buildWindowAnchorFinding(
    pack,
    anchor.fromS,
    anchor.toS,
    kind,
  );
  const prompt = buildDeepDivePrompt(
    [pack],
    [finding],
    anchor.spec,
    anchor.ownerName,
    "window",
  );
  const snapshotItemCount = pack.items.filter((it) =>
    SNAPSHOT_KINDS.has(it.kind),
  ).length;
  const snapshotViolations = snapshot
    ? checkSnapshotFactsConsistency(prompt).length
    : 0;

  let raw: string;
  try {
    raw = callClaude(prompt);
  } catch (err) {
    return {
      arm: { ...empty, snapshotItemCount, snapshotViolations },
      note: `claude 调用失败:${(err as Error).message}`,
    };
  }
  const parsed = parseModelJsonArray(raw);
  if (parsed === null) {
    const trimmed = raw.trim();
    return {
      arm: {
        auditedCount: 0,
        droppedTexts: trimmed
          ? [`[JSON 解析失败] ${trimmed.slice(0, 400)}`]
          : [],
        snapshotItemCount,
        snapshotViolations,
      },
    };
  }
  const kept = auditDeepDives(parsed, [pack]);
  const droppedTexts: string[] = [];
  for (const entry of parsed as Array<{ deepDive?: string }>) {
    if (typeof entry.deepDive !== "string") continue;
    // auditDeepDives processes entries independently (no cross-entry state),
    // so re-running it on a singleton array reproduces the exact per-entry
    // verdict without a fragile "match by interpolated text" heuristic.
    const survivesAlone = auditDeepDives([entry], [pack]).length > 0;
    if (!survivesAlone) droppedTexts.push(entry.deepDive);
  }
  return {
    arm: {
      auditedCount: kept.length,
      droppedTexts,
      snapshotItemCount,
      snapshotViolations,
    },
  };
}

async function main() {
  await ensureAnalysisData();
  const anchors = collectAnchors(N);
  console.log(
    `装载 ${anchors.length}/${N} 个带死亡锚点的场次(来源 ${MATCH_DIR})`,
  );

  const rows: Array<{
    tag: string;
    aCount: number;
    bCount: number;
    bSnapshotItems: number;
    bViolations: number;
  }> = [];
  const allDroppedB: string[] = [];

  for (const anchor of anchors) {
    const tag = `${anchor.matchId.slice(0, 8)}${
      anchor.roundSeq !== undefined ? `/r${anchor.roundSeq}` : ""
    }@${anchor.deathT.toFixed(0)}s`;
    console.error(`  处理 ${tag} ...`);
    const a = runArm(anchor, false);
    const b = runArm(anchor, true);
    if (a.note) console.error(`    A: ${a.note}`);
    if (b.note) console.error(`    B: ${b.note}`);
    rows.push({
      tag,
      aCount: a.arm.auditedCount,
      bCount: b.arm.auditedCount,
      bSnapshotItems: b.arm.snapshotItemCount,
      bViolations: b.arm.snapshotViolations,
    });
    allDroppedB.push(...b.arm.droppedTexts);
  }

  console.log(
    "\n锚点 | A 条数(审计后) | B 条数(审计后) | B 快照 item 数 | B 第6类违规数",
  );
  for (const r of rows)
    console.log(
      `${r.tag} | ${r.aCount} | ${r.bCount} | ${r.bSnapshotItems} | ${r.bViolations}`,
    );
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  const totalViolations = rows.reduce((s, r) => s + r.bViolations, 0);
  console.log(
    `均值 | ${avg(rows.map((r) => r.aCount)).toFixed(2)} | ${avg(
      rows.map((r) => r.bCount),
    ).toFixed(
      2,
    )} | ${avg(rows.map((r) => r.bSnapshotItems)).toFixed(2)} | ${totalViolations}`,
  );

  console.log(
    `\nB 组被审计丢弃的条目原文(静音率人工归因,共 ${allDroppedB.length} 条):`,
  );
  allDroppedB.forEach((t, i) => console.log(`  [${i + 1}] ${t}`));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
