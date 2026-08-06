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
 * Usage: npx tsx packages/eval/scripts/momentDiveAb.ts [N=20] [--skip=K]
 * (N=2 smoke test recommended first — each claude call can take 60-300s; the
 * blind pairwise judge adds up to two more short calls per anchor.)
 * --skip=K resumes a previously interrupted run: keeps the first K rows
 * already recorded in $GLADLOG_EVAL_HOME/momentDiveAb-results.jsonl (anchor
 * selection is a deterministic newest-first scan, so anchor K is the same
 * anchor across invocations as long as the local match library hasn't
 * changed) and recomputes anchors K..N-1 fresh. Without --skip (the default,
 * skip=0), the results file is truncated and the whole N-anchor set is
 * computed from scratch — a full re-run must never silently blend with a
 * stale/contaminated prior file.
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
 * N 默认改 20(可传参覆盖)。
 *
 * ---- v3 防污染修复(2026-08-05)----
 * 第一次 N=20 正式跑撞上了 session/额度限制:claude CLI 返回的限额错误文本被
 * 当成"模型答了但没写出可教内容"吞掉,从第 3 个锚点起两臂几乎全 0/0,污染到
 * 后面所有行都不可用——而且当时是等跑完 18 行才发现,白跑一轮。修法:
 * (a) callClaude 抛异常 / 输出为空 / 输出含 "limit"/"rate"(不分大小写)→
 *     该臂 status 记 "call-error",与「模型答了、审计后 0 条」的 "ok" 状态严格
 *     分开,绝不混进条数均值 / 存活率 / 配对判优的分母(call-error 的锚点在
 *     配对判优里单独记一类,既不算「跳过(真无信号)」也不会被误判成对侧的
 *     一次"直接胜"——那会把额度噪音记成真实的质量信号)。
 * (b) 连续 ≥2 个锚点任一臂出现 call-error → 立刻打印醒目错误并中止整轮(退出
 *     码 2),不再产出后面 N-i 行毒数据。
 * (c) 每处理完一个锚点,立刻把该行结果 append 到
 *     $GLADLOG_EVAL_HOME/momentDiveAb-results.jsonl;--skip=K 续跑时只信这个
 *     文件的前 K 行(会先把文件截断到刚好 K 行,丢掉任何 call-error 尾巴),
 *     其余重新计算——额度恢复后不必从头重跑。
 *
 * ---- v4 多条契约轮(2026-08-05,窗口深挖多条化 Task 3)----
 * `auditDeepDives` 放开「同 findingIndex 多条(仅 window 模式,≤4 条)」后,本脚本
 * 跟进适配:两臂调用改为 `auditDeepDives(parsed, [pack], { mode: "window" })`
 * (共享谓词——A、B 用同一套多条契约,不给任一臂开小灶);「条数」(aCount/bCount,
 * 即表格与均值行的「审计后条数」)现在真的可以 >1(此前 window 模式代码侧硬性
 * 上限就是 1,条数列只可能是 0 或 1);盲配对判优喂给判官的文本从「该臂唯一存
 * 活条目的 text」改为「该臂全部存活条目按 title+正文拼接」(单条臂退化为原行
 * 为不变)。droppedTexts/静音归因、call-error 防护、--skip 续跑、第 6 类统计
 * (checkSnapshotFactsConsistency)机制均未改动。
 *
 * 注意:上面 v1 小节的「N=10」数字用的是旧判据(只比审计后条数,尚未加盲配对判
 * 官),v2 小节起才加入盲配对;而 spec 前作(`docs/superpowers/specs/
 * 2026-08-05-moment-deep-dive-design.md`)记录的「N=20,B 胜率 35.7%」是单条形态
 * 下的盲配对结果(那一轮 window 模式代码侧上限还是 1 条,不是本轮的 1-4 条)。
 * 这两轮的「条数」/「胜率」都不能和本轮(多条契约)数字直接对比——形态变了,分
 * 母的含义也变了。
 *
 * ---- v5 跨 AI 评测(2026-08-05,`--gen`/`--judge`)----
 * 此前所有轮次生成与判官都是同一个后端(claude sonnet)——两个已知盲区:样本量
 * 偏小(N≤20),以及"生成方与判官同族"意味着判官的偏好可能只是同一模型自我认同
 * 的偏好,不是跨模型都认的质量差异。本轮加两个正交参数,支持两组独立评测:
 * (1) N=50、生成仍用 claude sonnet,但判官换成双判官(claude + agy/Gemini)—— 目
 *     的是测"同族偏差":如果 claude 判官和 agy 判官对同一对 A/B 文本经常给出相反
 *     方向,说明第一轮至今的胜负结论有相当一部分是评分者自己的偏好而非文本本身
 *     的质量差异;
 * (2) N=20、生成换成 agy pro(`--gen=agy`),双判官——目的是外推到生产环境实际会
 *     用到的本地 CLI 后端(desktop 产品里 claude/agy/codex 三个都是一等公民),
 *     不只验证"claude 生成、claude 判"这一条路径。
 * `--gen=claude|agy`(默认 claude):生成臂调用的后端,两臂(A/B)必须用同一个
 * `--gen` 值——共享谓词原则同样适用于"用什么模型生成",不能 A 用 claude、B 用
 * agy。agy 生成调法照搬 `packages/desktop/src/main/localAiBackends.ts` 的
 * `agyClientFactory` 直调二进制样式(`agy --print <prompt> --model "Gemini 3.1
 * Pro (High)" --print-timeout 110s --new-project --sandbox`,execFileSync 数组
 * 传参,不落盘——macOS 的 argv 长度上限远高于 Windows 那条 30K 门槛,单条战报
 * prompt 放得下)。
 * `--judge=claude|agy|both`(默认 claude):盲配对判官的后端。agy 判官用
 * "Gemini 3.5 Flash (Medium)"(轻量模型,判官只答"甲/乙/平"三选一,不需要 pro
 * 档位)。`both` = 每对存活文本各跑两套独立判官(各自两次换位置消偏),分别记账
 * ——输出两行独立的胜负统计(claude 判官 / agy 判官),再加一行"判官一致率":在
 * 两个判官都对同一对给出了明确结论(甲/乙/平三者之一,judge-fail 不算"给出结
 * 论")的锚点里,两者方向一致(同为 A 胜、同为 B 胜、或同为平)的占比;"一方判
 * 平、另一方判出胜负"单独计一类不一致(不与"两个判官方向相反"的不一致混在同一
 * 个数里,那是两种不同性质的分歧)。
 * results 文件名按配置区分(`momentDiveAb-results-<gen>-<judge>.jsonl`),
 * `--skip` 只在同一个 `<gen>-<judge>` 文件上续跑——不同配置的结果绝不会互相
 * 覆盖或误续。call-error 检测(`looksLikeCallFailure`)对 agy 的输出同样适用;
 * agy 特有的失败形态还有非零退出码与超时(`execFileSync` 本身抛异常),两者都
 * 落进既有的 try/catch → "call-error" 分支,不需要新判据。agy 的 execFileSync
 * 超时给 150_000ms(比 `--print-timeout 110s` 多留约 36% 余量,判官与生成两种
 * 调用统一用这个值,因为超时上限由 agy CLI 自己的 `--print-timeout` 决定,跟
 * 是判官问答还是长篇生成无关)。
 *
 * ---- v6 drop-reason 归因(2026-08-05,agy 存活率崩塌定量归因)----
 * `--gen=agy` 的实测正式轮里 A 臂(生产 buildWindowPack 管线)审计后存活 0/20——
 * 此前的诊断只知道"0 条通过",不知道是哪道门在拦(占位符 key 校验/claimChecker/
 * 裸数字/裸数字 title/causalLint/同 index 上限,还是 findingIndex 对不上)。
 * `auditDeepDives` 现多出可选的 `opts.onDrop` 钩子(analysis 包改动,零裁决行为
 * 变化——不传 onDrop 时字节级不变,见该函数的实现与单测):每次丢弃一条model输
 * 出前,回调携带 `{ reason, detail, text, findingIndex }`,reason 取自固定 8
 * 值枚举(与函数内 8 个 continue 一一对应)。本脚本两臂都传 onDrop 收集进
 * `ArmResult.drops`,随行写入 `ResultRow.aDrops`/`bDrops`(旧结果文件没有这两个
 * 字段,聚合时用 `?? []` 兜底,不因续跑而炸)。表格后新增"drop-reason 分布"段:
 * 按臂 × reason 计数,一眼看出 A 臂 0/20 是被同一道门集中拦下,还是分散在多道
 * 门——这决定了下一步是"放宽某一条具体门规"还是"prompt 本身没引导出可教内容"。
 * 原来"B 组被审计丢弃的条目原文"段扩成 A/B 两组,每条都附 reason/detail(不再是
 * 裸文本列表)。JSON 解析失败(`parseModelJsonArray` 返回 null,压根没有 parsed
 * 数组可让 auditDeepDives 遍历)是审计门之外的另一种失败形态,不套用 8 个 reason
 * 之一,单独记 `parseFailureText` 字段、单独打印,不混进 drop-reason 分布表。
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  auditDeepDives,
  type AuditDropInfo,
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

import { resolveEvalHome } from "../src/evalHome";
import { checkSnapshotFactsConsistency } from "../src/quality/promptQualityCheck";

const MATCH_DIR = join(
  homedir(),
  "Library/Application Support/gladlog/matches",
);

type GenBackend = "claude" | "agy";
type JudgeArg = "claude" | "agy" | "both";

function parseArgs(argv: string[]): {
  n: number;
  skip: number;
  gen: GenBackend;
  judge: JudgeArg;
} {
  let skip = 0;
  let n: number | undefined;
  let gen: GenBackend = "claude";
  let judge: JudgeArg = "claude";
  for (const a of argv) {
    const skipMatch = /^--skip=(\d+)$/.exec(a);
    if (skipMatch) {
      skip = Number(skipMatch[1]);
      continue;
    }
    const genMatch = /^--gen=(claude|agy)$/.exec(a);
    if (genMatch) {
      gen = genMatch[1] as GenBackend;
      continue;
    }
    const judgeMatch = /^--judge=(claude|agy|both)$/.exec(a);
    if (judgeMatch) {
      judge = judgeMatch[1] as JudgeArg;
      continue;
    }
    if (n === undefined && /^\d+$/.test(a)) n = Number(a);
  }
  return { n: n ?? 20, skip, gen, judge };
}
const {
  n: N,
  skip: SKIP,
  gen: GEN,
  judge: JUDGE,
} = parseArgs(process.argv.slice(2));
/** `--judge=both` runs each pair through both backends independently; a single
 * `--judge` value runs only that one. Order matters for nothing (each backend
 * is fully independent), but keeping claude first means single-backend runs
 * (the common case) print in the same position as before v5. */
const JUDGE_BACKENDS: GenBackend[] =
  JUDGE === "both" ? ["claude", "agy"] : [JUDGE];

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
 * entirely, same cost-control shape as verify-production.ts's `pickSources`.
 * Deterministic given an unchanged local library, which is what makes
 * `--skip=K` a safe resume: anchors[K] is the same anchor across
 * invocations. */
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

// ---- agy (Gemini via Antigravity CLI) backend, v5 ----

/** Model names are the literal agy CLI `--model` strings (verified against
 * `AI_MODELS.agy` in packages/desktop/src/shared/aiModels.ts's `cliName`
 * field — these are already the CLI-facing names, not ids needing
 * `agyCliModelName` translation, since this script never goes through the
 * product's model-id-selection UI). Pro for generation (matches the product's
 * default `agy` model id "pro"); a lighter Flash tier for the judge, which
 * only ever answers 甲/乙/平. */
const AGY_MODEL_GEN = "Gemini 3.1 Pro (High)";
const AGY_MODEL_JUDGE = "Gemini 3.5 Flash (Medium)";
/** Shared by generation and judge agy calls: the node-side ceiling is a
 * property of the `agy` process's own `--print-timeout 110s`, not of what
 * question is being asked, so both roles use the same margin over it. */
const AGY_TIMEOUT_MS = 150_000;

/** Resolved once in main() (only when `--gen=agy` or `--judge=agy|both` is
 * actually requested — a plain N=2 claude-only smoke run must not pay an agy
 * detection cost or fail if agy is not installed). Defaults to the bare
 * command name, which resolves via PATH when nothing better is found. */
let AGY_CMD = "agy";

/** Prefer the product's own detection cache (packages/desktop/src/main/
 * cliDetect.ts's `detectLocalCliCached`) so this script finds agy exactly
 * where the desktop app would — but eval must keep working on a checkout
 * that lacks the desktop package (or whose build output moved), so any
 * failure to import or resolve falls back to the literal `"agy"` command
 * name (confirmed present on PATH by the `agy --version` preflight in
 * main()). Mirrors modelFormatAudit.ts's dynamic `import("../../desktop/...")`
 * pattern for the same "borrow the product's real implementation, but don't
 * hard-depend on it" reason. */
async function resolveAgyCmd(): Promise<string> {
  try {
    const { detectLocalCliCached } =
      (await import("../../desktop/src/main/cliDetect")) as typeof import("../../desktop/src/main/cliDetect");
    const detected = await detectLocalCliCached("agy");
    if (detected) return detected;
  } catch {
    // desktop package unavailable from this checkout, or detection itself
    // found nothing — either way, fall back below.
  }
  return "agy";
}

/** Direct-spawn agy call, argv shape copied from `agyClientFactory` in
 * packages/desktop/src/main/localAiBackends.ts (`--print <prompt> --model
 * <name> --print-timeout 110s --new-project --sandbox`) — no spill-file
 * branch here: that branch exists only for Windows's much lower argv ceiling
 * (30K chars, 0 for a .cmd/.bat shim), and this script only runs on macOS
 * (see the module header), whose argv limit is far above a single window
 * prompt's size. `--new-project` avoids silently reusing a prior agy project
 * and resetting cwd to its root; `--sandbox` keeps this a read-only call with
 * no write permission, matching the judge/narration use case exactly. */
function callAgy(prompt: string): string {
  return execFileSync(
    AGY_CMD,
    [
      "--print",
      `${SYSTEM}\n${prompt}`,
      "--model",
      AGY_MODEL_GEN,
      "--print-timeout",
      "110s",
      "--new-project",
      "--sandbox",
    ],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: AGY_TIMEOUT_MS,
    },
  );
}

/** Generation-arm dispatch: A and B always share the same `--gen` value (the
 * shared-predicate rule applies to "which model generated this" too — an A/B
 * comparison across two different generation backends would not isolate the
 * variable under test, the window-pack shape). */
function callGen(prompt: string): string {
  return GEN === "claude" ? callClaude(prompt) : callAgy(prompt);
}

/** Anything that isn't a real narration attempt — an execFileSync throw, an
 * empty reply, or text carrying a quota/rate-limit marker. Deliberately loose
 * (case-insensitive substring, not a strict schema) because the actual
 * observed failure mode was free-form CLI error text, not a structured error
 * — the v2 run's silent corruption came from treating exactly this kind of
 * text as "the model wrote nothing worth keeping" instead of "the call never
 * really happened". A false positive here (a legitimate zh narration
 * happening to contain the English word "limit"/"rate") costs one wrongly-
 * dropped arm; a false negative costs a repeat of the whole-run pollution
 * this exists to prevent — the asymmetry favors the loose check. */
function looksLikeCallFailure(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return true;
  return /limit|rate/i.test(t);
}

type ArmStatus = "ok" | "no-signal" | "call-error";

interface ArmResult {
  status: ArmStatus;
  auditedCount: number;
  /** Authoritative per-entry drop diagnostics (v6, 2026-08-05): one row per
   * model entry that `auditDeepDives` discarded, sourced from its `onDrop`
   * hook on the SAME call that produces `auditedCount`/`survivedText` below —
   * purely observational (never changes which entries survive), and more
   * complete than the old isolated single-entry recheck used for
   * `citedKeysCounts` (that recheck can never observe a per-index-cap drop,
   * since a lone entry never hits the cap). Empty when `parsed` itself never
   * existed (see `parseFailureText`) or the arm short-circuited before
   * parsing (no-signal / call-error). */
  drops: AuditDropInfo[];
  /** Set only when `parseModelJsonArray` returned null — the model's raw
   * output wasn't valid JSON at all, so there was no `parsed` array for
   * `auditDeepDives`/`onDrop` to ever see. A distinct failure mode from any of
   * the 8 audit-gate reasons in `drops`; kept separate so it's never counted
   * into the drop-reason distribution as if it were a real gate rejection. */
  parseFailureText?: string;
  snapshotItemCount: number;
  /** Task 3's 6th hardFailure class; only meaningful for the B (snapshot) arm. */
  snapshotViolations: number;
  /** All surviving entries' title+text concatenated in survival order (v4,
   * multi-finding contract: `auditDeepDives(..., { mode: "window" })` now
   * allows up to 4 entries per findingIndex, so "the one surviving entry"
   * from the single-entry era no longer holds) — the blind pairwise judge's
   * raw material. null when nothing survived the audit. */
  survivedText: string | null;
  /** citedKeys length of each entry that survived the audit alone (used for
   * the citedKeys-diversity average; up to 4 entries per arm under the v4
   * multi-finding contract, so this array can now hold more than one count). */
  citedKeysCounts: number[];
}

function runArm(
  anchor: Anchor,
  snapshot: boolean,
): { arm: ArmResult; note?: string } {
  const empty: ArmResult = {
    status: "ok",
    auditedCount: 0,
    drops: [],
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
  if (!built)
    return {
      arm: { ...empty, status: "no-signal" },
      note: "无信号(buildWindowPack=null)",
    };
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
    raw = callGen(prompt);
  } catch (err) {
    return {
      arm: {
        ...empty,
        status: "call-error",
        snapshotItemCount,
        snapshotViolations,
      },
      // Covers both a claude execFileSync throw and an agy one (non-zero
      // exit / timeout — agy has no separate "quota" text shape, it just
      // fails the process outright), same call-error bucket either way.
      note: `${GEN} 调用失败:${(err as Error).message}`,
    };
  }
  if (looksLikeCallFailure(raw)) {
    const trimmed = raw.trim();
    return {
      arm: {
        ...empty,
        status: "call-error",
        snapshotItemCount,
        snapshotViolations,
      },
      note: `疑似限额/限流响应(不进条数统计):${
        trimmed ? trimmed.slice(0, 200) : "(空输出)"
      }`,
    };
  }
  const parsed = parseModelJsonArray(raw);
  if (parsed === null) {
    const trimmed = raw.trim();
    return {
      arm: {
        status: "ok",
        auditedCount: 0,
        drops: [],
        parseFailureText: trimmed
          ? `[JSON 解析失败] ${trimmed.slice(0, 400)}`
          : undefined,
        snapshotItemCount,
        snapshotViolations,
        survivedText: null,
        citedKeysCounts: [],
      },
    };
  }
  // mode: "window" on both arms (shared-predicate rule: A and B must be
  // judged by the identical contract) — this is what lets an arm now keep up
  // to 4 entries per findingIndex instead of the pre-Task-1 single-entry cap.
  // onDrop (v6) rides this exact call — drops is authoritative for what got
  // rejected and why, not a second re-derivation.
  const drops: AuditDropInfo[] = [];
  const kept = auditDeepDives(parsed, [pack], {
    mode: "window",
    onDrop: (d) => drops.push(d),
  });
  const citedKeysCounts: number[] = [];
  for (const entry of parsed as Array<{
    deepDive?: string;
    citedKeys?: unknown;
  }>) {
    if (typeof entry.deepDive !== "string") continue;
    // auditDeepDives processes entries independently (no cross-entry state),
    // so re-running it on a singleton array reproduces the exact per-entry
    // verdict without a fragile "match by interpolated text" heuristic. This
    // is used ONLY for citedKeysCounts (a per-index-cap drop would wrongly
    // "survive alone" here, since a lone entry never hits the cap — `drops`
    // above is the authoritative source for reason attribution, this loop
    // is not). Same mode as the batch pass above (window) so a lone entry
    // gets exactly the same title/digit gate it would inside the full batch.
    const survivesAlone =
      auditDeepDives([entry], [pack], { mode: "window" }).length > 0;
    if (survivesAlone && Array.isArray(entry.citedKeys))
      citedKeysCounts.push(entry.citedKeys.length);
  }
  // Judge material = ALL surviving entries for this arm, title+text joined in
  // survival order (v4 brief: "该臂全部条目 title+正文按序拼接") — a single-
  // entry arm degenerates to the old kept[0]-only behavior unchanged.
  const survivedText = kept.length
    ? kept.map((k) => (k.title ? `${k.title}:${k.text}` : k.text)).join("\n")
    : null;
  return {
    arm: {
      status: "ok",
      auditedCount: kept.length,
      drops,
      snapshotItemCount,
      snapshotViolations,
      survivedText,
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

/** Judge-backend dispatch (v5): the judge prompt/parsing/position-bias logic
 * below is identical regardless of which model answers it — only the process
 * invocation differs. claude gets the same `-p --model claude-sonnet-5` call
 * as before v5 unchanged; agy gets the lighter Flash tier (`AGY_MODEL_JUDGE`)
 * since the judge question is a short forced-choice, not a narration, and
 * shares `AGY_TIMEOUT_MS` with the generation arm (see that constant's
 * comment — the ceiling is a property of agy's own `--print-timeout`, not of
 * the question being asked). */
function callJudgeBackend(backend: GenBackend, judgePrompt: string): string {
  if (backend === "claude") {
    return execFileSync(
      "claude",
      ["-p", "--output-format", "text", "--model", "claude-sonnet-5"],
      {
        input: judgePrompt,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: JUDGE_TIMEOUT_MS,
      },
    );
  }
  return execFileSync(
    AGY_CMD,
    [
      "--print",
      judgePrompt,
      "--model",
      AGY_MODEL_JUDGE,
      "--print-timeout",
      "110s",
      "--new-project",
      "--sandbox",
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: AGY_TIMEOUT_MS,
    },
  );
}

/** One judge call for one (甲, 乙) assignment. Returns null on ANY failure —
 * process timeout/error, or a reply that doesn't parse — both count as
 * "judge failure" upstream, never as a tie (a tie means the judge weighed in
 * and called it even; a failure means it never rendered a usable verdict). */
function judgeOnce(
  backend: GenBackend,
  jiaText: string,
  yiText: string,
): "甲" | "乙" | "平" | null {
  let raw: string;
  try {
    raw = callJudgeBackend(backend, buildJudgePrompt(jiaText, yiText));
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
function pairedJudge(
  backend: GenBackend,
  aText: string,
  bText: string,
): PairVerdict {
  const firstAIsJia = Math.random() < 0.5;
  const v1 = judgeOnce(
    backend,
    firstAIsJia ? aText : bText,
    firstAIsJia ? bText : aText,
  );
  if (v1 === null) return "judge-fail";
  const r1 = normalize(v1, firstAIsJia);

  const secondAIsJia = !firstAIsJia;
  const v2 = judgeOnce(
    backend,
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
 * all and must not enter the win/loss/tie tally as either a tie or a loss.
 * NOTE: the caller must route call-error anchors around this function
 * entirely (see `verdict` in main()) — a call-error arm also has
 * `survivedText === null`, indistinguishable from a genuine "no signal" arm
 * at this function's level, and quota noise must never be allowed to read as
 * a real "the other arm produced a clean win" result.
 * `backend` (v5) selects which model answers — with `--judge=both` this is
 * called once per backend per anchor, each an independent judgment (its own
 * random position assignment, its own process), never shared state between
 * the two backends' opinions. */
function judgeAnchor(
  backend: GenBackend,
  aText: string | null,
  bText: string | null,
): PairVerdict | "skip" {
  if (aText && bText) return pairedJudge(backend, aText, bText);
  if (aText && !bText) return "A";
  if (!aText && bText) return "B";
  return "skip";
}

// ---- Incremental results file (v3, quota-pollution fix 2026-08-05) ----

interface ResultRow {
  index: number;
  tag: string;
  aStatus: ArmStatus;
  bStatus: ArmStatus;
  aCount: number;
  bCount: number;
  bSnapshotItems: number;
  bViolations: number;
  /** v5: one verdict per requested judge backend (was a single `verdict`
   * field pre-v5 — replaced rather than kept alongside, since the results
   * file is already namespaced by `<gen>-<judge>` in its filename, so no
   * pre-v5 file is ever read back through this shape). "call-error" is set
   * identically for every requested backend on a call-error anchor (the
   * failure is upstream of judging, at the generation arm, so it is not a
   * per-judge-backend fact). */
  verdicts: Partial<Record<GenBackend, PairVerdict | "skip" | "call-error">>;
  aCitedKeys: number[];
  bCitedKeys: number[];
  aSurvived: boolean;
  bSurvived: boolean;
  /** v6 (2026-08-05, agy 存活率崩塌定量归因): per-entry drop diagnostics for
   * BOTH arms now (v4's `bDroppedTexts` was B-only, back when only B's
   * silence rate was under study — v6 is diagnosing an A-arm collapse, so A
   * needs the same visibility). Optional on read: a results file written
   * before this change has neither field, and `?? []` at every aggregation
   * site treats that as "no diagnostics available", never as "zero drops". */
  aDrops?: AuditDropInfo[];
  bDrops?: AuditDropInfo[];
  /** Set only when that arm's raw model output failed to parse as JSON at all
   * — see `ArmResult.parseFailureText`'s doc comment for why this is kept
   * separate from `aDrops`/`bDrops`. */
  aParseFailure?: string;
  bParseFailure?: string;
}

function loadRows(path: string): ResultRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as ResultRow);
}

function appendRow(path: string, row: ResultRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

const avg = (xs: number[]) =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

async function main() {
  await ensureAnalysisData();

  // v5: resolve + version-probe agy only when actually requested — a
  // claude-only run (still the common case, and every pre-v5 invocation)
  // must not pay an agy detection cost or fail on a machine without agy.
  const needsAgy = GEN === "agy" || JUDGE_BACKENDS.includes("agy");
  if (needsAgy) {
    AGY_CMD = await resolveAgyCmd();
    try {
      execFileSync(AGY_CMD, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (err) {
      throw new Error(
        `agy 探活失败(cmd=${AGY_CMD}):${(err as Error).message} —— 确认 agy 已安装且在 PATH 中`,
      );
    }
    console.error(`agy 探活成功(cmd=${AGY_CMD})`);
  }

  const anchors = collectAnchors(N);
  console.log(
    `装载 ${anchors.length}/${N} 个带死亡锚点的场次(来源 ${MATCH_DIR})—— gen=${GEN} judge=${JUDGE}`,
  );

  const evalHome = resolveEvalHome();
  // v5: filename carries the <gen>-<judge> config tag so --skip only ever
  // resumes a run made under the exact same configuration — a claude-gen/
  // both-judge file and an agy-gen/claude-judge file never collide or
  // silently blend.
  const resultsPath = join(
    evalHome,
    `momentDiveAb-results-${GEN}-${JUDGE}.jsonl`,
  );

  let rows: ResultRow[];
  if (SKIP > 0) {
    const prior = loadRows(resultsPath);
    if (prior.length < SKIP) {
      throw new Error(
        `--skip=${SKIP} 但既有结果文件 ${resultsPath} 只有 ${prior.length} 行 —— 无法续跑`,
      );
    }
    rows = prior.slice(0, SKIP);
    // Drop anything beyond the kept prefix (including any call-error tail
    // from the run being resumed) so this invocation's fresh rows never
    // collide with stale ones at the same index.
    writeFileSync(
      resultsPath,
      rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
      "utf8",
    );
    console.log(`续跑:沿用既有 ${rows.length} 行(--skip=${SKIP}),其余重新计算`);
  } else {
    // Fresh full run: a previous file (possibly quota-polluted) must never
    // silently blend with this run's data.
    writeFileSync(resultsPath, "", "utf8");
    rows = [];
  }

  let consecutiveCallErrors = 0;

  for (let i = SKIP; i < anchors.length; i++) {
    const anchor = anchors[i];
    const tag = `${anchor.matchId.slice(0, 8)}${
      anchor.roundSeq !== undefined ? `/r${anchor.roundSeq}` : ""
    }@${anchor.deathT.toFixed(0)}s`;
    console.error(`  处理 [${i}] ${tag} ...`);
    const a = runArm(anchor, false);
    const b = runArm(anchor, true);
    if (a.note) console.error(`    A: ${a.note}`);
    if (b.note) console.error(`    B: ${b.note}`);

    const anchorCallError =
      a.arm.status === "call-error" || b.arm.status === "call-error";
    // Quota noise must never be misread as "the other arm produced a clean
    // win" — route call-error anchors around the judge entirely instead of
    // letting judgeAnchor see a null survivedText it can't tell apart from a
    // genuine empty arm. On a call-error anchor every requested backend gets
    // the same "call-error" verdict (the failure is upstream of judging, at
    // the generation arm — it is not a per-judge-backend fact); otherwise
    // each requested backend runs its own independent judgeAnchor call (v5:
    // `--judge=both` means two separate model opinions on the same pair, not
    // one shared verdict).
    const verdicts: ResultRow["verdicts"] = {};
    for (const backend of JUDGE_BACKENDS) {
      verdicts[backend] = anchorCallError
        ? "call-error"
        : judgeAnchor(backend, a.arm.survivedText, b.arm.survivedText);
      console.error(`    配对判优(${backend}): ${verdicts[backend]}`);
    }

    const row: ResultRow = {
      index: i,
      tag,
      aStatus: a.arm.status,
      bStatus: b.arm.status,
      aCount: a.arm.auditedCount,
      bCount: b.arm.auditedCount,
      bSnapshotItems: b.arm.snapshotItemCount,
      bViolations: b.arm.snapshotViolations,
      verdicts,
      aCitedKeys: a.arm.citedKeysCounts,
      bCitedKeys: b.arm.citedKeysCounts,
      aSurvived: !!a.arm.survivedText,
      bSurvived: !!b.arm.survivedText,
      aDrops: a.arm.drops,
      bDrops: b.arm.drops,
      aParseFailure: a.arm.parseFailureText,
      bParseFailure: b.arm.parseFailureText,
    };
    rows.push(row);
    appendRow(resultsPath, row);

    consecutiveCallErrors = anchorCallError ? consecutiveCallErrors + 1 : 0;
    if (consecutiveCallErrors >= 2) {
      console.error(`\n${"!".repeat(70)}`);
      console.error(
        `!!! 连续 ${consecutiveCallErrors} 个锚点 call-error(疑似限额/限流)—— 立刻中止,不产出更多毒数据`,
      );
      console.error(
        `!!! 已记录 ${rows.length}/${anchors.length} 行,写在 ${resultsPath}`,
      );
      console.error(
        `!!! 额度恢复后用 --skip=<好行数> 续跑(会自动截掉文件里这段 call-error 尾巴)`,
      );
      console.error("!".repeat(70));
      process.exit(2);
    }
  }

  // ---- Aggregation: call-error rows are excluded from every average/rate
  // denominator per-arm (they never produced real data), but stay visible as
  // their own explicit count — the exact distinction the v2 run lacked. ----
  const okA = rows.filter((r) => r.aStatus !== "call-error");
  const okB = rows.filter((r) => r.bStatus !== "call-error");
  const aCallErrors = rows.length - okA.length;
  const bCallErrors = rows.length - okB.length;

  console.log(
    "\n锚点 | A 状态 | A 条数(审计后) | B 状态 | B 条数(审计后) | B 快照 item 数 | B 第6类违规数 | 配对判优",
  );
  for (const r of rows) {
    const verdictCol = JUDGE_BACKENDS.map(
      (b) => `${b}=${r.verdicts[b] ?? "?"}`,
    ).join("/");
    console.log(
      `[${r.index}] ${r.tag} | ${r.aStatus} | ${r.aCount} | ${r.bStatus} | ${r.bCount} | ${r.bSnapshotItems} | ${r.bViolations} | ${verdictCol}`,
    );
  }
  const totalViolations = okB.reduce((s, r) => s + r.bViolations, 0);
  console.log(
    `均值(排除 call-error) | n=${okA.length} | ${avg(okA.map((r) => r.aCount)).toFixed(2)} | n=${okB.length} | ${avg(
      okB.map((r) => r.bCount),
    ).toFixed(
      2,
    )} | ${avg(okB.map((r) => r.bSnapshotItems)).toFixed(2)} | ${totalViolations} |`,
  );
  console.log(
    `call-error(疑似限额/限流,单列,不进上面任何均值/胜率分母):A ${aCallErrors} / B ${bCallErrors}`,
  );

  // v5: one win/tie/failure line PER requested judge backend — with
  // `--judge=both` these are two independent tallies over the exact same set
  // of anchors, not one shared tally (that is the whole point: comparing
  // them is how same-family judge bias gets caught).
  for (const backend of JUDGE_BACKENDS) {
    const aWins = rows.filter((r) => r.verdicts[backend] === "A").length;
    const bWins = rows.filter((r) => r.verdicts[backend] === "B").length;
    const ties = rows.filter((r) => r.verdicts[backend] === "tie").length;
    const judgeFailures = rows.filter(
      (r) => r.verdicts[backend] === "judge-fail",
    ).length;
    const skipped = rows.filter((r) => r.verdicts[backend] === "skip").length;
    const callErrorAnchors = rows.filter(
      (r) => r.verdicts[backend] === "call-error",
    ).length;
    const pairedTotal = aWins + bWins + ties;
    console.log(
      `\n盲配对判优(判官=${backend}):A 胜 ${aWins} / B 胜 ${bWins} / 平 ${ties} / 判官失败 ${judgeFailures} / 跳过(双臂皆空) ${skipped} / call-error(未进判优)${callErrorAnchors}`,
    );
    console.log(
      `B 配对胜率(判官=${backend},不计判官失败/跳过/call-error,n=${pairedTotal}):${
        pairedTotal ? ((bWins / pairedTotal) * 100).toFixed(1) : "N/A"
      }%`,
    );
  }

  // v5: judge agreement rate — only meaningful with `--judge=both` (a single
  // judge backend trivially "agrees with itself"). Comparable pairs = anchors
  // where BOTH backends actually rendered a verdict (A/B/tie) — judge-fail,
  // skip, and call-error are excluded from the denominator because those are
  // not an opinion about which text is better at all (a judge-fail is "the
  // model never answered", a skip/call-error is "there was nothing/nothing
  // trustworthy to compare"), and letting them into the denominator would
  // manufacture agreement out of anchors neither backend actually judged.
  // Within comparable pairs: same value (both A, both B, or both tie) counts
  // as agreement; one A / other B is a direction disagreement; one tie /
  // other A-or-B is kept as its own separate bucket per the brief (a
  // judge calling it "even" is a materially different kind of disagreement
  // from two judges picking opposite winners).
  if (JUDGE === "both") {
    const [b1, b2] = JUDGE_BACKENDS;
    const comparable = rows.filter((r) => {
      const v1 = r.verdicts[b1];
      const v2 = r.verdicts[b2];
      return (
        (v1 === "A" || v1 === "B" || v1 === "tie") &&
        (v2 === "A" || v2 === "B" || v2 === "tie")
      );
    });
    const agree = comparable.filter(
      (r) => r.verdicts[b1] === r.verdicts[b2],
    ).length;
    const tieMismatch = comparable.filter((r) => {
      const v1 = r.verdicts[b1];
      const v2 = r.verdicts[b2];
      return v1 !== v2 && (v1 === "tie" || v2 === "tie");
    }).length;
    const opposite = comparable.length - agree - tieMismatch;
    console.log(
      `\n判官一致率(${b1} vs ${b2},n=两判官均给出甲/乙/平的锚点数=${comparable.length}):` +
        `${
          comparable.length
            ? ((agree / comparable.length) * 100).toFixed(1)
            : "N/A"
        }% 一致 —— 一致 ${agree} / 方向相反 ${opposite} / 一方判平另一方判出胜负(单列)${tieMismatch}`,
    );
  }
  console.log(
    `存活率(审计后有存活文本 / 该臂非 call-error 锚点数):A ${
      okA.length
        ? ((okA.filter((r) => r.aSurvived).length / okA.length) * 100).toFixed(
            1,
          )
        : "N/A"
    }% (n=${okA.length}) / B ${
      okB.length
        ? ((okB.filter((r) => r.bSurvived).length / okB.length) * 100).toFixed(
            1,
          )
        : "N/A"
    }% (n=${okB.length})`,
  );
  const citedKeysA = okA.flatMap((r) => r.aCitedKeys);
  const citedKeysB = okB.flatMap((r) => r.bCitedKeys);
  console.log(
    `两臂平均 citedKeys 数(引证多样性,n=存活条目数):A ${avg(citedKeysA).toFixed(2)}(n=${citedKeysA.length}) / B ${avg(citedKeysB).toFixed(2)}(n=${citedKeysB.length})`,
  );

  // ---- drop-reason 分布(v6, 2026-08-05):按臂 × reason 计数 —— `?? []` on
  // every read below is deliberate (a results file from before v6 has neither
  // field on its rows; that must read as "no diagnostics", never as "zero
  // drops actually happened"). ----
  const tallyByReason = (
    pick: (r: ResultRow) => AuditDropInfo[] | undefined,
  ): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows)
      for (const d of pick(r) ?? [])
        m.set(d.reason, (m.get(d.reason) ?? 0) + 1);
    return m;
  };
  const aReasonCounts = tallyByReason((r) => r.aDrops);
  const bReasonCounts = tallyByReason((r) => r.bDrops);
  const allReasons = [
    ...new Set([...aReasonCounts.keys(), ...bReasonCounts.keys()]),
  ].sort();
  console.log(
    "\ndrop-reason 分布(按臂 × reason 计数,来源=auditDeepDives 的 onDrop):",
  );
  if (allReasons.length === 0) {
    console.log(
      "  (两臂均无审计门丢弃 —— 全部无信号 / call-error / 全部通过审计)",
    );
  } else {
    for (const reason of allReasons) {
      console.log(
        `  ${reason.padEnd(22)} A=${aReasonCounts.get(reason) ?? 0}  B=${bReasonCounts.get(reason) ?? 0}`,
      );
    }
  }
  const aParseFailures = rows.filter((r) => r.aParseFailure).length;
  const bParseFailures = rows.filter((r) => r.bParseFailure).length;
  if (aParseFailures || bParseFailures) {
    console.log(
      `  (JSON 解析失败,非审计门丢弃,不计入上表)A=${aParseFailures}  B=${bParseFailures}`,
    );
  }

  const totalADrops = rows.reduce((s, r) => s + (r.aDrops?.length ?? 0), 0);
  const totalBDrops = rows.reduce((s, r) => s + (r.bDrops?.length ?? 0), 0);
  console.log(
    `\nA/B 组被审计丢弃的条目原文(静音率人工归因,附 reason/detail,共 A ${totalADrops} / B ${totalBDrops} 条):`,
  );
  let printed = 0;
  for (const r of rows) {
    for (const d of r.aDrops ?? []) {
      printed++;
      console.log(
        `  [A/${r.tag}] reason=${d.reason} detail=${d.detail}\n      text=${d.text}`,
      );
    }
    if (r.aParseFailure) console.log(`  [A/${r.tag}] ${r.aParseFailure}`);
    for (const d of r.bDrops ?? []) {
      printed++;
      console.log(
        `  [B/${r.tag}] reason=${d.reason} detail=${d.detail}\n      text=${d.text}`,
      );
    }
    if (r.bParseFailure) console.log(`  [B/${r.tag}] ${r.bParseFailure}`);
  }
  if (printed === 0 && !aParseFailures && !bParseFailures)
    console.log("  (无)");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
