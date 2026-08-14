/* eslint-disable no-console */
/**
 * 薄壳:技能事实地基 Task 4 语料观测线 —— 全库扫描 + 三方 diff 报告。
 * 逻辑(aura 区间追踪 / 施放计数 / diff 报告拼装)全部在
 * src/explore/uwcObserved.ts,本文件只做:选场 → 读 raw.txt → 调用 → 落盘。
 *
 * Usage: npx tsx packages/eval/scripts/uwcCorpusScan.ts [flags]
 *   --limit N              单次调用最多处理多少场(默认 200;不加 --offset 时
 *                          语义是"扫描场数上限",brief 要求 N>=50)。
 *   --offset N             分批模式:从 loadIndex() 的第 N 场开始(配合
 *                          --limit 作为"这一批处理多少场",默认 0)。
 *   --partial-out PATH     分批累积状态文件(默认见 defaultPartialPath()),
 *                          每次调用读取-合并-写回,前台多次调用即可覆盖全库,
 *                          任何一批失败/超时都不丢前面几批的数据。
 *   --reset-partial        本次调用前清空累积状态,从空白重新开始。
 *   --disable-window-cap   关闭 MAX_STUN_WINDOW_MS 防御性上限(复现修复前
 *                          行为),用于 before/after 对照,产物路径带
 *                          `-nocap` 后缀,不覆盖默认(已修复)报告。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SPELL_NAMES_ZH_GENERATED } from "@gladlog/analysis";
import { DR_CATEGORIES_GENERATED } from "@gladlog/analysis/src/data/drCategoriesGenerated";
import { USABLE_WHILE_CC_GENERATED } from "@gladlog/analysis/src/data/usableWhileCcGenerated";
import { USABLE_WHILE_CC_SPELL_IDS } from "@gladlog/analysis/src/utils/cooldowns";
import fs from "fs-extra";

import { resolveEvalHome } from "../src/evalHome";
import { DEFAULT_MATCH_DIR, loadIndex } from "../src/explore/storeAccess";
import {
  buildUwcDiffReport,
  scanStunWindows,
} from "../src/explore/uwcObserved";

/** cooldowns.ts USABLE_WHILE_CC_SPELL_IDS carries only inline `//` comments
 * for names (not a structured field) — this display-only name map mirrors
 * those comments (and usableWhileCcAnchors.ts's Chinese names) so the report
 * doesn't print bare ids; it does NOT define the id set itself (that still
 * comes straight from the imported Set, so this can never drift out of sync
 * on which 6 ids are hand-written). */
const HANDWRITTEN_NAMES: Record<string, string> = {
  "33206": "痛苦压制",
  "22812": "树皮术",
  "47585": "消散",
  "642": "圣盾术",
  "55233": "吸血鬼之血",
  "48792": "冰封之韧",
};

/** Mirrors genUsableWhileCc.ts's `TIEBREAK_ANCHORS.stunned` (unsigned,
 * 2026-08-14, "pending Task 4 corpus corroboration" per that file's own
 * header) — that const isn't exported (it's a private datagen scratch list),
 * so this is a deliberate small duplication of 5 short literals rather than
 * widening Task 3's file's public surface for a one-off diagnostic report.
 * Keep in sync with packages/analysis/scripts/datagen/genUsableWhileCc.ts if
 * that list ever changes. */
const TIEBREAK_ANCHORS_STUNNED: {
  spellId: string;
  name: string;
  expected: boolean;
}[] = [
  { spellId: "117588", name: "Meteor", expected: true },
  { spellId: "77616", name: "Dark Simulacrum", expected: true },
  { spellId: "426586", name: "Blade Flurry", expected: true },
  { spellId: "50397", name: "Lichborne", expected: false },
  { spellId: "44461", name: "Living Bomb", expected: false },
];

/**
 * Hand-investigated contradiction candidates from the first full-corpus run
 * (2026-08-14): spot-checked by grepping raw.txt directly for (a) the
 * caster's GUID prefix (all five are 100% `Player-`, not pet/vehicle casts —
 * ruled out the "pet has its own stun" confound that explained 201754 Stomp)
 * and (b) the ms gap between each cast and its matching stun aura's most
 * recent APPLIED (spread roughly 500ms-4000ms into the window across dozens
 * of independent matches/players — NOT clustered near 0, which would have
 * pointed at boundary timing jitter instead).
 *
 * Second round (2026-08-14, coordinator-requested decision-grade
 * corroboration — see `highConfidenceAppendix` below for the full writeup):
 *  - Raw SpellMisc.Attributes_5/Attributes_10 bit values for all 5 ids (same
 *    build cache Task 3 used) confirm none is a near-miss of the adopted
 *    combo (`Attributes_5#3` value 8 ∪ `Attributes_10#13` value 8192) — every
 *    value is a categorically different bit or zero, ruling out "scoring
 *    artifact" and pointing at a different bit/field.
 *  - wowhead Flags-box spot-checks (Task 3's own corroboration method) found
 *    an EXPLICIT "Allow While Stunned by Stun Mechanic" flag on both 498
 *    (Divine Protection) and 119996 (Transcendence: Transfer) — two
 *    independent lines of evidence now agree for these two.
 *  - 132764 (Dire Beast) has NO stun-related flag on wowhead at all, and its
 *    corpus hits cannot be trusted as "player pressed a button through a
 *    stun": Beast Mastery's "Wild Call" talent auto-triggers a free instant
 *    Dire Beast recast on certain crits, logged under the player's own GUID
 *    with zero button press — downgraded from "high confidence" to
 *    "unreliable, do not treat as evidence" pending a proc-vs-manual-cast
 *    disambiguation this task doesn't attempt.
 *
 * Framed as PAUSE material, not a unilateral table edit — only the
 * user/Task 5-6 can decide whether to add 498/403876/119996 to the
 * official-table exception list. */
const MANUAL_FINDINGS: { spellId: string; note: string }[] = [
  {
    spellId: "498",
    note:
      ":圣佑术/Divine Protection(与 403876 同名、同一技能的不同版本 id,合计观测 748 次)。玩家 100% 施放者;毫秒差抽样跨度约 500-4000ms,非贴边。" +
      "wowhead Flags 栏明确列出「Allow While Stunned by Stun Mechanic」(2026-08-14 WebFetch 核实)。" +
      "原始位:Attributes_5=4(bit2)、Attributes_10=0,均非采纳位(5#3=8、10#13=8192)近失配——高置信度,两条独立证据(语料时序 + wowhead 旗标)一致指向真实可用,官方表疑似漏收。",
  },
  {
    spellId: "403876",
    note: "(见 498 条,同一技能同一旗标)。原始位:Attributes_5=4(bit2)、Attributes_10=0,与 498 完全一致——两个版本 id 共享同一枚 Attributes_5 bit2,是下一轮位搜索的具体候选线索。",
  },
  {
    spellId: "51490",
    note:
      ":雷霆风暴/Thunderstorm(萨满击退技能,也是本仓 knockback DR 手写表成员——但此处观测到的是它作为「施放」被按下,与 knockback DR 归类无关)。玩家 100% 施放者,毫秒差抽样跨度约 700-2000ms,非贴边。" +
      "原始位:Attributes_5=0、Attributes_10=0——两个被搜索字段均为 0,若真可用,机制不落在这两列上(需要全 17 列重新搜,本任务未做)。本轮未做 wowhead 核实(coordinator 指定的 WebFetch 名单只含 498/119996/132764),证据比另两条薄一档。",
  },
  {
    spellId: "119996",
    note:
      ":魂体双分：转移/Transcendence: Transfer(萨满传送图腾的瞬移技能)。玩家 100% 施放者,毫秒差抽样约 1000-2500ms,非贴边。" +
      "wowhead Flags 栏明确列出「Allow While Stunned by Stun Mechanic」+「Allow While Stunned By Horror Mechanic」(2026-08-14 WebFetch 核实,双维度双确认)。" +
      "原始位:Attributes_5=0、Attributes_10=4194304(bit22,与采纳位 10#13 即 bit13 不同位)——高置信度,两条独立证据一致,官方表疑似漏收。",
  },
  {
    spellId: "132764",
    note:
      ":凶暴野兽/Dire Beast(猎人召唤技能;同族还有 219199/212382/304051/212396 等不同天赋/职业版本 id,合计约 98 次,多数落在中低频桶)。玩家 100% 施放者。" +
      "**降级为不可靠,不作为证据**:wowhead Flags 栏(2026-08-14 WebFetch 核实)未见任何 stunned/usable while 类旗标;" +
      "野兽大师天赋「野性呼唤/Wild Call」可在暴击时免费自动重触发一次凶暴野兽,该自动触发的 SPELL_CAST_SUCCESS 仍记在玩家自己 GUID 下、但玩家并未按键——" +
      "语料侧的 GUID 归因法**无法区分**「玩家晕中主动按下」与「天赋自动代按」,本条的按键归因不可靠。原始位:Attributes_5=0、Attributes_10=0,与 wowhead 无旗标一致(不支持真可用)。",
  },
];

/** Decision-grade appendix (coordinator-requested, 2026-08-14): the raw
 * SpellMisc bit-value table for the 5 candidates, read from the same build's
 * cache Task 3 used (`genUsableWhileCc.ts`'s data source), plus the
 * interpretation of what "no near-miss" implies. Kept as one literal block
 * (not re-derived by this script, which has no DB2/CSV access of its own) so
 * the report carries the exact values a reviewer already looked up. */
const HIGH_CONFIDENCE_APPENDIX = `**原始 SpellMisc 位值表**(同 build 缓存,Attributes_5 / Attributes_10 是 Task 3 采纳组合所在的两列;采纳组合 = \`Attributes_5#3\`(值 8)∪ \`Attributes_10#13\`(值 8192)):

| id | 名字 | Attributes_5(十进制) | 对应位 | Attributes_10(十进制) | 对应位 | 与采纳位关系 |
|---|---|---|---|---|---|---|
| 498 | 圣佑术 | 4 | bit2 | 0 | — | 非近失配(bit2 ≠ bit3,完全不同位) |
| 403876 | 圣佑术 | 4 | bit2 | 0 | — | 与 498 完全一致 |
| 51490 | 雷霆风暴 | 0 | — | 0 | — | 两列均为 0——若真可用,机制不在这两列 |
| 119996 | 魂体双分:转移 | 0 | — | 4194304 | bit22 | 非近失配(bit22 ≠ bit13) |
| 132764 | 凶暴野兽 | 0 | — | 0 | — | 同 51490 |

**解读**:5 条候选无一是采纳位的"近失配"(不是"差一点点被选中",而是位置完全不同或该列压根没设位)——这排除了"Task 3 打分时把它们和真位混淆"这种解释,支持"存在另一套独立的位/字段控制这些技能的被控可用性,Task 3 的 ≤2 位并集搜索范围没有覆盖到"。498/403876 共享同一枚 \`Attributes_5\` bit2,是最具体的下一轮搜索线索。

**wowhead Flags 栏核实**(2026-08-14 WebFetch,方法同 Task 3 判别锚——不凭记忆,逐条抓取):
- 498 圣佑术/Divine Protection:明确列出「**Allow While Stunned by Stun Mechanic**」。
- 119996 魂体双分:转移/Transcendence: Transfer:明确列出「**Allow While Stunned by Stun Mechanic**」+「Allow While Stunned By Horror Mechanic」。
- 132764 凶暴野兽/Dire Beast:**未见任何**与被控相关的旗标(只有「Always Cast Log」「Allow Class Ability Procs」)。

**Dire Beast 的 proc 混杂问题**:「Allow Class Ability Procs」这枚旗标本身就是信号——野性呼唤(Wild Call,野兽大师天赋)会在特定暴击后免费自动重触发一次凶暴野兽,这类自动触发的 \`SPELL_CAST_SUCCESS\` 事件记录的仍是玩家自己的 GUID(战斗日志无法区分"玩家手动按下"与"天赋自动代按"),而本任务的观测线正是按 GUID 做按键归因——因此 132764(及其同族 id)语料侧观测到的"晕中施放"完全可能是野性呼唤代按,与"玩家晕中真的按下技能键"是两回事。结合 wowhead 无相关旗标,**该条降级为不可靠,不建议作为官方表缺口的证据**,除非能找到区分"玩家主动施放"与"天赋自动触发"的独立信号(本任务未实现)。`;

interface PartialState {
  matchesScanned: number;
  skippedMatches: number;
  totalWindows: number;
  totalCastsInStun: number;
  totalCastsBySpell: Record<string, number>;
  nextOffset: number;
}

function freshState(): PartialState {
  return {
    matchesScanned: 0,
    skippedMatches: 0,
    totalWindows: 0,
    totalCastsInStun: 0,
    totalCastsBySpell: {},
    nextOffset: 0,
  };
}

function loadPartial(path: string): PartialState {
  if (!existsSync(path)) return freshState();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialState;
  } catch {
    return freshState();
  }
}

function parseArgs(): {
  limit: number;
  offset: number;
  partialOut: string | undefined;
  resetPartial: boolean;
  disableWindowCap: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 200;
  let offset = 0;
  let partialOut: string | undefined;
  let resetPartial = false;
  let disableWindowCap = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = Number(args[i + 1] ?? limit);
    else if (args[i] === "--offset") offset = Number(args[i + 1] ?? offset);
    else if (args[i] === "--partial-out") partialOut = args[i + 1];
    else if (args[i] === "--reset-partial") resetPartial = true;
    else if (args[i] === "--disable-window-cap") disableWindowCap = true;
  }
  return { limit, offset, partialOut, resetPartial, disableWindowCap };
}

async function main(): Promise<void> {
  const { limit, offset, partialOut, resetPartial, disableWindowCap } =
    parseArgs();

  const stunAuraIds = new Set(DR_CATEGORIES_GENERATED.stun ?? []);
  if (stunAuraIds.size === 0) {
    throw new Error(
      "DR_CATEGORIES_GENERATED.stun is empty — check the import path",
    );
  }

  const evalHome = resolveEvalHome();
  const reportsDir = join(evalHome, "reports");
  await fs.ensureDir(reportsDir);
  const suffix = disableWindowCap ? "-nocap" : "";
  const statePath =
    partialOut ?? join(reportsDir, `uwc-scan-partial${suffix}.json`);
  const outPath = join(reportsDir, `uwc-diff${suffix}.md`);

  const state = resetPartial ? freshState() : loadPartial(statePath);

  const allRows = loadIndex(DEFAULT_MATCH_DIR);
  // Normal batching flow: omit --offset and let the persisted
  // `state.nextOffset` drive progress — repeated `--limit N` calls then walk
  // the whole library N rows at a time with no caller-side bookkeeping.
  // --offset, when explicitly passed, overrides the persisted position for
  // this one call (ad-hoc re-scan of a specific range); it does not combine
  // with nextOffset.
  const startIdx = offset > 0 ? offset : state.nextOffset;
  const rows = allRows.slice(startIdx, startIdx + limit);

  if (rows.length === 0) {
    console.log(
      `Nothing to scan: startIdx=${startIdx} >= library size ${allRows.length}. Already fully processed — see ${outPath}.`,
    );
    return;
  }

  const totalCastsBySpell = new Map<string, number>(
    Object.entries(state.totalCastsBySpell),
  );
  let totalWindows = state.totalWindows;
  let totalCastsInStun = state.totalCastsInStun;
  let matchesScanned = state.matchesScanned;
  let skippedMatches = state.skippedMatches;

  for (const row of rows) {
    const rawPath = join(DEFAULT_MATCH_DIR, row.id, "raw.txt");
    let rawText: string;
    try {
      rawText = readFileSync(rawPath, "utf8");
    } catch {
      skippedMatches++;
      continue;
    }
    const scan = scanStunWindows(
      rawText,
      stunAuraIds,
      disableWindowCap ? { maxStunWindowMs: Infinity } : undefined,
    );
    matchesScanned++;
    totalWindows += scan.windowCount;
    for (const [spellId, n] of scan.castsBySpell) {
      totalCastsBySpell.set(spellId, (totalCastsBySpell.get(spellId) ?? 0) + n);
      totalCastsInStun += n;
    }
  }

  const newNextOffset = startIdx + rows.length;
  const newState: PartialState = {
    matchesScanned,
    skippedMatches,
    totalWindows,
    totalCastsInStun,
    totalCastsBySpell: Object.fromEntries(totalCastsBySpell),
    nextOffset: newNextOffset,
  };
  await fs.writeFile(statePath, JSON.stringify(newState), "utf8");

  const done = newNextOffset >= allRows.length;
  console.log(
    `Batch done: processed rows [${startIdx}, ${newNextOffset}) of ${allRows.length}` +
      ` (matchesScanned=${matchesScanned} so far, ${done ? "LIBRARY COMPLETE" : "more remain — rerun with the same --partial-out to continue"}).`,
  );

  const handwrittenSix = [...USABLE_WHILE_CC_SPELL_IDS].map((spellId) => ({
    spellId,
    name: HANDWRITTEN_NAMES[spellId] ?? spellId,
  }));

  const report = buildUwcDiffReport({
    matchesScanned,
    skippedMatches,
    totalWindows,
    totalCastsInStun,
    totalCastsBySpell,
    officialStunned: USABLE_WHILE_CC_GENERATED.stunned,
    handwrittenSix,
    tiebreakAnchors: TIEBREAK_ANCHORS_STUNNED,
    spellName: (id) => SPELL_NAMES_ZH_GENERATED[id],
    manualFindings: disableWindowCap ? [] : MANUAL_FINDINGS,
    highConfidenceAppendix: disableWindowCap
      ? undefined
      : HIGH_CONFIDENCE_APPENDIX,
  });

  await fs.writeFile(outPath, report + "\n", "utf8");
  console.log(
    `Report (partial or final, reflecting progress so far) written to ${outPath}`,
  );
  if (done) {
    console.log(report);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
