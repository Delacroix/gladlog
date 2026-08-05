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
 * Usage: npx tsx packages/eval/scripts/momentDiveAb.ts [N=20]
 * (N=2 smoke test recommended first — each claude call can take 60-300s; the
 * blind pairwise judge adds up to two more short calls per anchor.)
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
 *
 * ---- v2 增强(2026-08-05,复测前置,retest-prep)----
 * 首轮基线的判据只比"审计后条数",没有直接问"哪段更好"——这一轮加盲配对判优:
 * 当 A、B 两臂审计后都留有存活文本时,把两段原文以随机顺序标「甲/乙」,问同一
 * 判官(claude -p --model claude-sonnet-5,与生产/审题判官同型号但独立调用)
 * "同一场对局同一时刻的两段教练点评,哪段对玩家更具体、更可操作?只答 甲/乙/
 * 平"。同一对再问第二次、交换位置——两次结果一致(换算回 A/B 后同向)才记胜负,
 * 不一致记平(位置偏差消解法)。一臂存活一臂空 → 存活方直接记胜,不必劳烦判官;
 * 两臂都空 → 跳过,不进任何胜负统计。判官调用本身超时或输出解析不出甲/乙/平
 * → 记「判官失败」,同样不进胜负统计(不可与"平"混为一谈——那是判官答不出,不
 * 是判官认为两段一样好)。汇总新增:B 胜/平/负计数与配对胜率、两臂存活率、两臂
 * 平均 citedKeys 数(引证多样性,数值越高代表证据来源越分散,不是词数或长度）。
 * N 默认改 20(可传参覆盖)。尚未重跑正式一轮——上面首轮 N=10 的数字是旧判据
 * (只比条数)下产出的,新判据的数字要等下一次正式跑出来后另行记录,不覆盖这段。
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

const N = Number(process.argv[2] ?? 20);

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
  /** Interpolated text of the one surviving entry, or null if nothing
   * survived the audit (window mode has exactly one finding, so at most one
   * entry can ever survive) — the blind pairwise judge's raw material. */
  survivedText: string | null;
  /** citedKeys length of each entry that survived the audit alone (used for
   * the citedKeys-diversity average; window mode yields at most one, but the
   * field stays an array so the aggregation code doesn't special-case it). */
  citedKeysCounts: number[];
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
    survivedText: null,
    citedKeysCounts: [],
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
        survivedText: null,
        citedKeysCounts: [],
      },
    };
  }
  const kept = auditDeepDives(parsed, [pack]);
  const droppedTexts: string[] = [];
  const citedKeysCounts: number[] = [];
  for (const entry of parsed as Array<{
    deepDive?: string;
    citedKeys?: unknown;
  }>) {
    if (typeof entry.deepDive !== "string") continue;
    // auditDeepDives processes entries independently (no cross-entry state),
    // so re-running it on a singleton array reproduces the exact per-entry
    // verdict without a fragile "match by interpolated text" heuristic.
    const survivesAlone = auditDeepDives([entry], [pack]).length > 0;
    if (!survivesAlone) droppedTexts.push(entry.deepDive);
    else if (Array.isArray(entry.citedKeys))
      citedKeysCounts.push(entry.citedKeys.length);
  }
  return {
    arm: {
      auditedCount: kept.length,
      droppedTexts,
      snapshotItemCount,
      snapshotViolations,
      survivedText: kept[0]?.text ?? null,
      citedKeysCounts,
    },
  };
}

// ---- Blind pairwise judge (v2, retest-prep 2026-08-05) ----

/** Explicit timeout (per the project's judge-call convention): a short
 * "which is better" question, so 60s is generous headroom over callClaude's
 * 280s narration budget. */
const JUDGE_TIMEOUT_MS = 60_000;

function buildJudgePrompt(jiaText: string, yiText: string): string {
  return [
    "以下是同一场对局、同一时刻的两段教练点评,分别标记为「甲」「乙」。",
    "",
    `甲:${jiaText}`,
    "",
    `乙:${yiText}`,
    "",
    "哪段对玩家更具体、更可操作?只答“甲”、“乙”或“平”,不要输出其他内容。",
  ].join("\n");
}

/** Parses a judge reply into 甲/乙/平, or null when the reply doesn't
 * unambiguously commit to one (timeout/process failure is handled by the
 * caller before this ever runs — this only covers "the call succeeded but
 * the text isn't a clean verdict"). */
function parseVerdict(raw: string): "甲" | "乙" | "平" | null {
  const t = raw.trim();
  const hasJia = /甲/.test(t);
  const hasYi = /乙/.test(t);
  if (hasJia && !hasYi) return "甲";
  if (hasYi && !hasJia) return "乙";
  if (!hasJia && !hasYi && /平/.test(t)) return "平";
  return null;
}

/** One judge call for one (甲, 乙) assignment. Returns null on ANY failure —
 * process timeout/error, or a reply that doesn't parse — both count as
 * "judge failure" upstream, never as a tie (a tie means the judge weighed in
 * and called it even; a failure means it never rendered a usable verdict). */
function judgeOnce(jiaText: string, yiText: string): "甲" | "乙" | "平" | null {
  let raw: string;
  try {
    raw = execFileSync(
      "claude",
      ["-p", "--output-format", "text", "--model", "claude-sonnet-5"],
      {
        input: buildJudgePrompt(jiaText, yiText),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: JUDGE_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
  return parseVerdict(raw);
}

function normalize(v: "甲" | "乙" | "平", aIsJia: boolean): "A" | "B" | "tie" {
  if (v === "平") return "tie";
  if (v === "甲") return aIsJia ? "A" : "B";
  return aIsJia ? "B" : "A";
}

type PairVerdict = "A" | "B" | "tie" | "judge-fail";

/** Runs the judge twice on the same (aText, bText) pair, swapping which side
 * is labeled 甲 the second time (position-bias cancellation). Only agreement
 * after normalizing back to A/B counts as a win/loss; disagreement records a
 * tie (the two calls contradicted each other, so neither side earned a clean
 * win); either call failing outright records "judge-fail" (excluded from
 * win/loss/tie tallies entirely — a failure is not the same claim as "even"). */
function pairedJudge(aText: string, bText: string): PairVerdict {
  const firstAIsJia = Math.random() < 0.5;
  const v1 = judgeOnce(
    firstAIsJia ? aText : bText,
    firstAIsJia ? bText : aText,
  );
  if (v1 === null) return "judge-fail";
  const r1 = normalize(v1, firstAIsJia);

  const secondAIsJia = !firstAIsJia;
  const v2 = judgeOnce(
    secondAIsJia ? aText : bText,
    secondAIsJia ? bText : aText,
  );
  if (v2 === null) return "judge-fail";
  const r2 = normalize(v2, secondAIsJia);

  return r1 === r2 ? r1 : "tie";
}

/** Anchor-level dispatch: only calls the judge when both arms actually have
 * something to compare. A lone survivor wins without spending a judge call
 * (there's nothing to blindly compare); both empty is not a comparison at
 * all and must not enter the win/loss/tie tally as either a tie or a loss. */
function judgeAnchor(
  aText: string | null,
  bText: string | null,
): PairVerdict | "skip" {
  if (aText && bText) return pairedJudge(aText, bText);
  if (aText && !bText) return "A";
  if (!aText && bText) return "B";
  return "skip";
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
    verdict: PairVerdict | "skip";
  }> = [];
  const allDroppedB: string[] = [];
  const citedKeysA: number[] = [];
  const citedKeysB: number[] = [];
  let survivedA = 0;
  let survivedB = 0;
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let judgeFailures = 0;
  let skipped = 0;

  for (const anchor of anchors) {
    const tag = `${anchor.matchId.slice(0, 8)}${
      anchor.roundSeq !== undefined ? `/r${anchor.roundSeq}` : ""
    }@${anchor.deathT.toFixed(0)}s`;
    console.error(`  处理 ${tag} ...`);
    const a = runArm(anchor, false);
    const b = runArm(anchor, true);
    if (a.note) console.error(`    A: ${a.note}`);
    if (b.note) console.error(`    B: ${b.note}`);

    if (a.arm.survivedText) survivedA++;
    if (b.arm.survivedText) survivedB++;
    citedKeysA.push(...a.arm.citedKeysCounts);
    citedKeysB.push(...b.arm.citedKeysCounts);

    const verdict = judgeAnchor(a.arm.survivedText, b.arm.survivedText);
    console.error(`    配对判优: ${verdict}`);
    if (verdict === "A") aWins++;
    else if (verdict === "B") bWins++;
    else if (verdict === "tie") ties++;
    else if (verdict === "judge-fail") judgeFailures++;
    else skipped++;

    rows.push({
      tag,
      aCount: a.arm.auditedCount,
      bCount: b.arm.auditedCount,
      bSnapshotItems: b.arm.snapshotItemCount,
      bViolations: b.arm.snapshotViolations,
      verdict,
    });
    allDroppedB.push(...b.arm.droppedTexts);
  }

  console.log(
    "\n锚点 | A 条数(审计后) | B 条数(审计后) | B 快照 item 数 | B 第6类违规数 | 配对判优",
  );
  for (const r of rows)
    console.log(
      `${r.tag} | ${r.aCount} | ${r.bCount} | ${r.bSnapshotItems} | ${r.bViolations} | ${r.verdict}`,
    );
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  const totalViolations = rows.reduce((s, r) => s + r.bViolations, 0);
  console.log(
    `均值 | ${avg(rows.map((r) => r.aCount)).toFixed(2)} | ${avg(
      rows.map((r) => r.bCount),
    ).toFixed(
      2,
    )} | ${avg(rows.map((r) => r.bSnapshotItems)).toFixed(2)} | ${totalViolations} |`,
  );

  const pairedTotal = aWins + bWins + ties;
  console.log(
    `\n盲配对判优:A 胜 ${aWins} / B 胜 ${bWins} / 平 ${ties} / 判官失败 ${judgeFailures} / 跳过(双臂皆空) ${skipped}`,
  );
  console.log(
    `B 配对胜率(不计判官失败/跳过,n=${pairedTotal}):${
      pairedTotal ? ((bWins / pairedTotal) * 100).toFixed(1) : "N/A"
    }%`,
  );
  console.log(
    `存活率(审计后有存活文本 / 总锚点 ${anchors.length}):A ${((survivedA / (anchors.length || 1)) * 100).toFixed(1)}% / B ${((survivedB / (anchors.length || 1)) * 100).toFixed(1)}%`,
  );
  console.log(
    `两臂平均 citedKeys 数(引证多样性,n=存活条目数):A ${avg(citedKeysA).toFixed(2)}(n=${citedKeysA.length}) / B ${avg(citedKeysB).toFixed(2)}(n=${citedKeysB.length})`,
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
