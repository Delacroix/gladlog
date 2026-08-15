/**
 * 薄壳:技能事实地基 Task 4(晕)+ 挂账清理 Task E(恐惧/心控)语料观测线 ——
 * 全库扫描 + diff/观测报告。逻辑(aura 区间追踪 / 施放计数 / 报告拼装)全部在
 * src/explore/uwcObserved.ts,本文件只做:选场 → 读 raw.txt → 调用 → 落盘。
 *
 * Usage: npx tsx packages/eval/scripts/uwcCorpusScan.ts [flags]
 *   --category stun|disorient|incapacitate
 *                          扫描哪个 DR 类别的 aura 集合(默认 stun,保持原有
 *                          行为不变)。disorient = 恐惧类硬控(DB2
 *                          DiminishType 32,见下方"类别口径"),incapacitate =
 *                          心控类硬控(DiminishType 16,变形术/冰冻陷阱/闷棍
 *                          等)——两者是不同的 DR 类别,各自独立扫描/独立落盘,
 *                          从不合并计数。stun 类别的产物路径/报告结构与
 *                          Task 4 完全一致(uwc-diff.md);disorient/
 *                          incapacitate 累积到 reports/uwc-feared-diff.md
 *                          (buildFearedDiffReport,结构不同于三方 diff——
 *                          feared 维度没有官方生成表可对照,见该函数注释)。
 *   --limit N              单次调用最多处理多少场(默认 200;不加 --offset 时
 *                          语义是"扫描场数上限",brief 要求 N>=50)。
 *   --offset N             分批模式:从 loadIndex() 的第 N 场开始(配合
 *                          --limit 作为"这一批处理多少场",默认 0)。
 *   --partial-out PATH     分批累积状态文件(默认见 partialPathFor()),
 *                          每次调用读取-合并-写回,前台多次调用即可覆盖全库,
 *                          任何一批失败/超时都不丢前面几批的数据。
 *   --reset-partial        本次调用前清空累积状态,从空白重新开始。
 *   --disable-window-cap   关闭 MAX_STUN_WINDOW_MS 防御性上限(复现修复前
 *                          行为),用于 before/after 对照,产物路径带
 *                          `-nocap` 后缀,不覆盖默认(已修复)报告。仅对
 *                          --category stun 有意义(disorient/incapacitate
 *                          从未观测到本文件描述的"丢 REMOVED"问题的量级验证,
 *                          但旗标本身在所有类别下都生效,行为一致)。
 *
 * 类别口径(恐惧在 DR 表里的位置——写代码前先核对过,不是猜测):DB2
 * `SpellCategories.DiminishType` 只有 5 类(1=root 4=stun 16=incapacitate
 * 32=disorient 64=silence),**没有 `fear` 这个类别名**。类别归属只能查
 * `DR_CATEGORIES_GENERATED` 本身(逐条核对 `.disorient` 数组的成员 id),
 * 名表(spellNamesZhGenerated.json)只能查一个 id 叫什么名字、**不能**证明它属于
 * 哪个 DR 类别——这两件事分属两个不同的生成表,靠名字"看起来像恐惧"就断言类别
 * 归属是错误的方法论(教训:5782 基础"恐惧"这个 id 中文名确实叫恐惧,但它
 * **不在** `DR_CATEGORIES_GENERATED` 任何类别里,0 命中——语料实际追踪到的是
 * 5484 恐惧嚎叫、6358 诱惑、8122 心灵尖啸、5246 破胆怒吼、118699(恐惧的另一个
 * spellId,真正在 disorient 类里)、360806 梦游、207685 悲苦咒符等**确实在
 * `.disorient` 数组里**的 id,不是 5782 本身)。
 * `incapacitate` 类装的是变形术(118)/冰冻陷阱(3355)/闷棍(6770)/放逐术
 * (710)一类"目标失去主动权"的心控技能,与"恐惧驱赶目标逃跑"是不同的游戏机制,
 * 只是恰好都属于"目标不能按技能"的广义硬控。brief 要求两者分开跑、分开报告,
 * 不合并观测集——本文件的 `--category` 严格一次只选一个类别的 aura 集合。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SPELL_NAMES_ZH_GENERATED } from "@gladlog/analysis";
import { UWC_ANCHORS } from "@gladlog/analysis/scripts/datagen/usableWhileCcAnchors";
import { DR_CATEGORIES_GENERATED } from "@gladlog/analysis/src/data/drCategoriesGenerated";
import { USABLE_WHILE_CC_GENERATED } from "@gladlog/analysis/src/data/usableWhileCcGenerated";
import fs from "fs-extra";

import { resolveEvalHome } from "../src/evalHome";
import { DEFAULT_MATCH_DIR, loadIndex } from "../src/explore/storeAccess";
import {
  buildFearedDiffReport,
  buildUwcDiffReport,
  type CcCategoryScanSummary,
  scanCcWindows,
} from "../src/explore/uwcObserved";

type Category = "stun" | "disorient" | "incapacitate";
const CATEGORIES: Category[] = ["stun", "disorient", "incapacitate"];
/** The two categories Task E scans for the feared/disorient observation
 * line — everything except stun, which keeps the pre-existing Task 4 path
 * untouched. Kept as its own list (not `CATEGORIES.filter(...)`) so the
 * feared-report assembly step's "which categories does this report cover"
 * question has one obvious answer to read, not a derived one. */
const FEARED_REPORT_CATEGORIES: Category[] = ["disorient", "incapacitate"];

/**
 * The pre-migration hand-written USABLE_WHILE_CC_SPELL_IDS table, as it stood
 * before Task 5 (2026-08-14) replaced it with the generated-468 ∪ gap-layer
 * shim now exported under the same name from cooldowns.ts. This report's
 * "手写表 N 条终判材料" section exists to sanity-check THAT specific
 * six-spell hand list against the official/corpus data — it is a frozen
 * point-in-time snapshot, not today's live shim, which is 471 ids (finding
 * #4, 2026-08-14 final review: this used to read `[...USABLE_WHILE_CC_SPELL_IDS]`
 * directly, which silently ballooned this section to 471 rows post-migration
 * and falsified its own "6 条" heading — see also cooldowns.ts's own doc
 * comment on the historical 6-entry list this mirrors).
 *
 * The keys ARE the id set (no separate list to drift): this map is both the
 * display-name lookup and, via Object.keys, the frozen 6-id source below.
 */
const HANDWRITTEN_NAMES: Record<string, string> = {
  "33206": "痛苦压制",
  "22812": "树皮术",
  "47585": "消散",
  "642": "圣盾术",
  "55233": "吸血鬼之血",
  "48792": "冰封之韧",
};
const LEGACY_HAND_SIX_IDS = Object.keys(HANDWRITTEN_NAMES);

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

/**
 * Per-category accumulator, persisted to disk between batched invocations.
 * Field name `totalCastsInStun` is historical (predates Task E's category
 * generalization) and is now category-agnostic in practice — it holds
 * "total window-internal casts" for whichever category this state file
 * belongs to (stun/disorient/incapacitate, one file per category, see
 * `partialPathFor`). Not renamed because `buildUwcDiffReport`'s
 * `UwcDiffReportInputs.totalCastsInStun` (unchanged, stun-report-specific)
 * and the already-complete on-disk `uwc-scan-partial.json` both pin this
 * exact field name — renaming would silently break loading that file's
 * accumulated 1028-match stun scan.
 */
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

/** Default partial-state path for a category — stun keeps the pre-Task-E
 * filename exactly (`uwc-scan-partial[-nocap].json`, no category suffix) so
 * the already-complete 1028-match accumulation on disk keeps loading under
 * its original name; disorient/incapacitate get a category-suffixed
 * sibling file each, kept fully separate per the "never merge categories"
 * rule (module header). */
function partialPathFor(
  reportsDir: string,
  category: Category,
  disableWindowCap: boolean,
): string {
  const capSuffix = disableWindowCap ? "-nocap" : "";
  const catSuffix = category === "stun" ? "" : `-${category}`;
  return join(reportsDir, `uwc-scan-partial${catSuffix}${capSuffix}.json`);
}

function toCategorySummary(
  category: Category,
  state: PartialState,
): CcCategoryScanSummary {
  return {
    category,
    matchesScanned: state.matchesScanned,
    skippedMatches: state.skippedMatches,
    totalWindows: state.totalWindows,
    totalCastsInCc: state.totalCastsInStun,
    totalCastsBySpell: new Map(Object.entries(state.totalCastsBySpell)),
  };
}

/** spellIds with a documented user-vs-tooltip conflict on the feared
 * dimension (`usableWhileCcAnchors.ts`'s 22812/47585 entries, both
 * `feared: null` for exactly this reason) — this task's headline question. */
const FEARED_DISPUTE_SPELL_IDS = ["22812", "47585"];

/**
 * Hand-investigated PAUSE candidates for the feared/disorient observation
 * line (Task E, 2026-08-14) — same discipline as `MANUAL_FINDINGS` above
 * (player-GUID + mid-window + known-proc-talent check per candidate), filled
 * in after the real full-corpus disorient/incapacitate scan numbers were in
 * (1028/1028 matches, both categories complete). Spot-checked directly
 * against raw.txt via a one-off diagnostic (not committed — every hit's
 * caster GUID, the specific disorient-aura id that made the window active,
 * and the cast-to-APPLIED ms gap): all 47 hits across these 5 ids are
 * `Player-` casters (zero pet/vehicle confound, unlike 201754 Stomp/132764
 * Dire Beast in the stun report), and the triggering auras resolve to
 * genuine fear-family spells (8122 心灵尖啸, 5484 恐惧嚎叫, 5246 破胆怒吼,
 * 118699 恐惧, 360806 梦游, 207685 悲苦咒符 — all disorient-category, none a
 * misclassified non-fear effect).
 *
 * **Gap distribution is NOT uniformly clean and must be read tiered, not as
 * one block** (2026-08-14 coordinator review correction — the first pass of
 * this file claimed "22812's 35 hits are evenly spread, none near either
 * boundary," which was false: 9/35 (26%) are sub-500ms, the same class as
 * 47585's single rejected 42ms hit, and 1 of 1022's 7 hits is an exact
 * gapMs=0 tie — the single most extreme queuing-artifact case in the whole
 * dataset, silently dropped from the first pass's "6 of 7 spot-checked"
 * count because the naive diagnostic script didn't replicate production's
 * same-timestamp batching order and missed it). Each note below states its
 * own gap tiering explicitly; do not average or eyeball the raw counts.
 *
 * Framed as PAUSE material, not a unilateral sign-off — only the user can
 * approve promoting any of these into `CURATED_ABILITY_FACTS`
 * (`usable_while_cc_gap`-kind, feared variant) or into `UWC_ANCHORS`, and
 * "flag-for-review" ids below already carry a SIGNED anchor this report's
 * evidence conflicts with — this report does not overturn that decision
 * unilaterally.
 *
 * NOT investigated (explicit scope limit, not silently skipped): the long
 * tail of the disorient/incapacitate observed sets beyond these 5 — several
 * top entries (1223412 灵魂残片/Soul Fragment, 341263 暗影幻灵/Shadowy
 * Apparition, 201754 践踏/Stomp, 119910 法术封锁/Spell Lock) read as
 * proc/pet-driven by ability semantics alone (same confound class as Dire
 * Beast/Wild Call in the stun report) and were NOT individually verified;
 * several others (355941/370960/361195 Evoker heals, 774 回春术) appear at a
 * volume that raises the same "dropped SPELL_AURA_REMOVED, MAX_STUN_WINDOW_MS
 * auto-expiry" suspicion the stun report's module header documents for its
 * own category — whether disorient-category REMOVED events drop at a
 * comparable rate was NOT checked here (would need the same per-aura-id
 * "does a REMOVED ever arrive" audit the stun investigation ran). Per
 * CLAUDE.md's verification-before-completion rule, this is stated as an open
 * gap rather than silently assumed clean.
 */
const FEARED_CANDIDATE_FINDINGS: {
  spellId: string;
  category: string;
  note: string;
  recommend: "sign" | "do-not-sign" | "flag-for-review";
}[] = [
  {
    spellId: "22812",
    category: "disorient",
    recommend: "sign",
    note:
      "树皮术/Barkskin。**本报告的 headline**——35 次观测,100% Player 施放者,触发 aura 覆盖 6 个不同的恐惧类 " +
      "spellId(8122 心灵尖啸/5484 恐惧嚎叫/5246 破胆怒吼/118699 恐惧/360806 梦游/207685 悲苦咒符),跨数十场不同对局/玩家。" +
      "**gap 分层如实披露(2026-08-14 复核后修正,原「无一贴边」的表述不准确)**:35 条里 9 条(26%,42/50/68/82/304/349/451/461/472ms)" +
      "是 sub-500ms——与 47585 被拒收的那条(42ms)同属「边界时序噪声」疑似池,抽验其中一条(caster Player-11-0EB801E4,aura=8122 心灵尖啸," +
      "gapMs=42)是典型的施法排队伪影特征,**不计入支持证据**。真正撑起 sign 推荐的是其余 26/35(539ms-5101ms,跨越全部 6 个 aura、数十场" +
      "不同对局/玩家,不贴任一边界)——这批 26 条依然充分,**结论维持 sign**,但依据只应引用这 26 条,不应笼统说「全部 35 条均匀分布」。" +
      "与 UWC_ANCHORS 的 22812 冲突记录(用户「只有昏迷可用」vs 游戏内 tooltip/wowhead flags「Usable while feared」)三方汇合:" +
      "**语料强证据(26/35 中窗、跨场跨 aura)支持 tooltip/wowhead 一侧,建议裁定 feared=true**,是这次「用户意见 vs tooltip」分歧当中证据量最充分的一格。",
  },
  {
    spellId: "47585",
    category: "disorient",
    recommend: "do-not-sign",
    note:
      "消散/Dispersion。disorient 类窗口内仅观测到 1 次施放成功,且毫秒差仅 42ms(aura=8122 心灵尖啸)——" +
      "这个量级的单例样本、又贴在窗口开始边界,不能排除「边界时序噪声」(玩家几乎同时按下与恐惧命中,而非「恐惧中途主动按下」)," +
      "语料本身**不构成独立的强证据**。与树皮术 35 条里同类的 9 条 sub-500ms 拒收候选性质相同(同属排队伪影疑似池)," +
      "而树皮术真正的支持证据是另外 26 条 539ms-5101ms、跨场跨 aura 分布——本条只有这 1 条,没有对应的「干净中窗」子集撑腰," +
      "不建议仅凭这 1 条语料改判;如果签字,理由应主要落在 wowhead flags(「Usable while feared」)而非本次语料。",
  },
  {
    spellId: "33206",
    category: "disorient",
    recommend: "flag-for-review",
    note:
      "痛苦压制/Pain Suppression。**⚠️ 与已签字锚点冲突**——UWC_ANCHORS 把 33206 的 feared 维度**已裁定为 false**" +
      "(用户 2026-08-14 明确裁决「只有昏迷可以用」)。但本次语料观测到 3 次 disorient 窗口内施放成功,3 条分属 3 个不同对局/玩家," +
      "100% Player 施放者,毫秒差 3167/4596/9150ms(最后一条较贴近 10s 上限,证据强度略打折扣,前两条不贴边)。" +
      "3 条虽不及树皮术的 35 条充分,但已足以构成对一条**已签字**结论的直接语料反证,按 CLAUDE.md 纪律不应被本报告单方改判——" +
      "呈用户复核:是否维持原裁决,或结合这 3 条重新考虑。",
  },
  {
    spellId: "1022",
    category: "disorient",
    recommend: "flag-for-review",
    note:
      "保护祝福。**引用勘误(2026-08-14 复核后修正)**:UWC_ANCHORS 签字 feared=false;原注引用的「用户自己用『好像』表述,置信度不足」" +
      "实际是该锚点 **stunned** 维度的 hedge(usableWhileCcAnchors.ts:220,「好像物理昏迷的时候可以给自己」,导致 stunned 由 false 降级为 null)。" +
      "**feared 维度的真实理由是另一句**:「feared/confused 用户未提出异议,维持 false(wowhead flags 栏也未见任何相关旗标)」——" +
      "是「默认维持、无反证」的剖面,不是「用户自陈低置信度」。两者置信度不是一回事,不能混用。" +
      "本次语料观测到 disorient 窗口内 7 次施放成功。**显式披露**:7 条里有 1 条(match 39cb8f27,caster=Player-76-09801B71," +
      "aura=360806 梦游,gapMs=0)是全数据集最极端的排队伪影——cast 与 aura APPLIED 落在完全相同的时间戳,教科书级边界伪影," +
      "**不计入支持证据**。其余 6/7:100% Player 施放者,分属多场/多玩家,毫秒差 1159/2217/2653/3549/4577/5219ms,分布集中在窗口中段," +
      "不贴边。这 6 条中窗证据本身仍足以撑起 flag-for-review——即便签字理由本来是「默认维持、非低置信度」,6 条清白的中窗观测依然构成" +
      "值得呈用户复核的反证,只是不该再用「用户自己都不确定」这个(错误的维度归因)理由来降低这条锚点原本的可信度。",
  },
  {
    spellId: "853",
    category: "disorient",
    recommend: "do-not-sign",
    note:
      "制裁之锤。UWC_ANCHORS 签字 feared=false(brief 指定反例,用于验证「瞬发攻击技能」本身不隐含被控可用)。" +
      "语料仅观测到 1 次,毫秒差 8512ms——单例且偏靠近 10s 窗口上限,证据强度弱,不足以撼动一条本就是「预期为 false 的反例设计」锚点。" +
      "不建议改判,列出仅供记录。",
  },
];

/** Builds and writes the Task E feared/disorient-family observation report
 * from whichever of the two `FEARED_REPORT_CATEGORIES` partial-state files
 * currently exist on disk (missing ones contribute a zero summary — this
 * lets the report always reflect current progress, same "partial or final"
 * convention as `uwc-diff.md`, regardless of which category's batch call
 * triggered the write). Only called for `--category disorient|incapacitate`
 * runs — `buildUwcDiffReport`'s three-way diff has no feared-dimension
 * equivalent (`USABLE_WHILE_CC_GENERATED` doesn't emit one), so this is a
 * structurally different report, not a variant of the stun one. */
async function writeFearedReport(
  reportsDir: string,
  disableWindowCap: boolean,
): Promise<void> {
  const categories: CcCategoryScanSummary[] = FEARED_REPORT_CATEGORIES.map(
    (category) => {
      const path = partialPathFor(reportsDir, category, disableWindowCap);
      return toCategorySummary(category, loadPartial(path));
    },
  );
  const report = buildFearedDiffReport({
    categories,
    anchors: UWC_ANCHORS.map((a) => ({
      spellId: a.spellId,
      name: a.name,
      feared: a.feared,
      rationale: a.rationale,
    })),
    disputeSpellIds: FEARED_DISPUTE_SPELL_IDS,
    spellName: (id) => SPELL_NAMES_ZH_GENERATED[id],
    candidateFindings: disableWindowCap ? [] : FEARED_CANDIDATE_FINDINGS,
  });
  const outPath = join(
    reportsDir,
    `uwc-feared-diff${disableWindowCap ? "-nocap" : ""}.md`,
  );
  await fs.writeFile(outPath, report + "\n", "utf8");
  console.log(
    `Feared/disorient report (partial or final, reflecting progress so far across both categories) written to ${outPath}`,
  );
}

function parseArgs(): {
  category: Category;
  limit: number;
  offset: number;
  partialOut: string | undefined;
  resetPartial: boolean;
  disableWindowCap: boolean;
} {
  const args = process.argv.slice(2);
  let category: Category = "stun";
  let limit = 200;
  let offset = 0;
  let partialOut: string | undefined;
  let resetPartial = false;
  let disableWindowCap = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--category") {
      const raw = args[i + 1];
      if (!CATEGORIES.includes(raw as Category)) {
        throw new Error(
          `--category must be one of ${CATEGORIES.join("|")}, got ${JSON.stringify(raw)}`,
        );
      }
      category = raw as Category;
    } else if (args[i] === "--limit") limit = Number(args[i + 1] ?? limit);
    else if (args[i] === "--offset") offset = Number(args[i + 1] ?? offset);
    else if (args[i] === "--partial-out") partialOut = args[i + 1];
    else if (args[i] === "--reset-partial") resetPartial = true;
    else if (args[i] === "--disable-window-cap") disableWindowCap = true;
  }
  return {
    category,
    limit,
    offset,
    partialOut,
    resetPartial,
    disableWindowCap,
  };
}

async function main(): Promise<void> {
  const {
    category,
    limit,
    offset,
    partialOut,
    resetPartial,
    disableWindowCap,
  } = parseArgs();

  const auraIds = new Set(DR_CATEGORIES_GENERATED[category] ?? []);
  if (auraIds.size === 0) {
    throw new Error(
      `DR_CATEGORIES_GENERATED.${category} is empty — check the import path`,
    );
  }

  const evalHome = resolveEvalHome();
  const reportsDir = join(evalHome, "reports");
  await fs.ensureDir(reportsDir);
  const statePath =
    partialOut ?? partialPathFor(reportsDir, category, disableWindowCap);
  // stun writes its own three-way diff report (uwc-diff.md); disorient and
  // incapacitate both feed into the single combined feared report instead
  // (see `writeFearedReport`) — `outPath` here is only used for the
  // "already fully processed, see ..." log line, so it must point at
  // whichever file this category actually produces.
  const outPath =
    category === "stun"
      ? join(reportsDir, `uwc-diff${disableWindowCap ? "-nocap" : ""}.md`)
      : join(
          reportsDir,
          `uwc-feared-diff${disableWindowCap ? "-nocap" : ""}.md`,
        );

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
    if (category !== "stun")
      await writeFearedReport(reportsDir, disableWindowCap);
    return;
  }

  const totalCastsBySpell = new Map<string, number>(
    Object.entries(state.totalCastsBySpell),
  );
  let totalWindows = state.totalWindows;
  let totalCastsInWindow = state.totalCastsInStun;
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
    const scan = scanCcWindows(
      rawText,
      auraIds,
      disableWindowCap ? { maxWindowMs: Infinity } : undefined,
    );
    matchesScanned++;
    totalWindows += scan.windowCount;
    for (const [spellId, n] of scan.castsBySpell) {
      totalCastsBySpell.set(spellId, (totalCastsBySpell.get(spellId) ?? 0) + n);
      totalCastsInWindow += n;
    }
  }

  const newNextOffset = startIdx + rows.length;
  const newState: PartialState = {
    matchesScanned,
    skippedMatches,
    totalWindows,
    totalCastsInStun: totalCastsInWindow,
    totalCastsBySpell: Object.fromEntries(totalCastsBySpell),
    nextOffset: newNextOffset,
  };
  await fs.writeFile(statePath, JSON.stringify(newState), "utf8");

  const done = newNextOffset >= allRows.length;
  console.log(
    `Batch done [category=${category}]: processed rows [${startIdx}, ${newNextOffset}) of ${allRows.length}` +
      ` (matchesScanned=${matchesScanned} so far, ${done ? "LIBRARY COMPLETE" : "more remain — rerun with the same --partial-out to continue"}).`,
  );

  if (category !== "stun") {
    await writeFearedReport(reportsDir, disableWindowCap);
    if (done) console.log(`Category ${category} complete.`);
    return;
  }

  const handwrittenSix = LEGACY_HAND_SIX_IDS.map((spellId) => ({
    spellId,
    name: HANDWRITTEN_NAMES[spellId] ?? spellId,
  }));

  const report = buildUwcDiffReport({
    matchesScanned,
    skippedMatches,
    totalWindows,
    totalCastsInStun: totalCastsInWindow,
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
