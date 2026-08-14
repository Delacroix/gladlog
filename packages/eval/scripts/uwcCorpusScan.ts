/* eslint-disable no-console */
/**
 * 薄壳:技能事实地基 Task 4 语料观测线 —— 全库扫描 + 三方 diff 报告。
 * 逻辑(aura 区间追踪 / 施放计数 / diff 报告拼装)全部在
 * src/explore/uwcObserved.ts,本文件只做:选场 → 读 raw.txt → 调用 → 落盘。
 *
 * Usage: npx tsx packages/eval/scripts/uwcCorpusScan.ts [--limit N]
 *   --limit N   扫描场数上限(默认 200,含 shuffle 整把;brief 要求 N>=50)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SPELL_NAMES_ZH_GENERATED } from "@gladlog/analysis";
import { DR_CATEGORIES_GENERATED } from "@gladlog/analysis/src/data/drCategoriesGenerated";
import { USABLE_WHILE_CC_GENERATED } from "@gladlog/analysis/src/data/usableWhileCcGenerated";
import { USABLE_WHILE_CC_SPELL_IDS } from "@gladlog/analysis/src/utils/cooldowns";
import fs from "fs-extra";

import { resolveEvalHome } from "../src/evalHome";
import { DEFAULT_MATCH_DIR, loadIndex } from "../src/explore/storeAccess";
import {
  aggregateUwcScans,
  buildUwcDiffReport,
  scanStunWindows,
  type UwcMatchScan,
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
 * caster's GUID prefix (all four are 100% `Player-`, not pet/vehicle casts —
 * ruled out the "pet has its own stun" confound that explained 201754 Stomp)
 * and (b) the ms gap between each cast and its matching stun aura's most
 * recent APPLIED (spread roughly 500ms-4000ms into the window across dozens
 * of independent matches/players — NOT clustered near 0, which would have
 * pointed at boundary timing jitter instead). Both checks are consistent
 * with "this ability really is usable while stunned" and NOT consistent with
 * a scan artifact — these are the strongest candidates in this run for real
 * gaps in the official table (Task 3's search was restricted to a <=2-bit
 * OR-union over SpellMisc.Attributes_*, a scope limit documented in that
 * file's own header; an ability whose true CC-immunity flag needs a 3rd bit
 * or lives in a different table would be silently absent from the 468-id
 * set even though it is genuinely usable while stunned). Framed as PAUSE
 * material, not an unilateral table edit — only the user/Task 5-6 can decide
 * whether to add these to the official-table exception list. */
const MANUAL_FINDINGS: { spellId: string; note: string }[] = [
  {
    spellId: "498",
    note: ":圣佑术/Divine Protection(与 403876 同名、同一技能的不同版本 id,合计观测 748 次)。玩家 100% 施放者;施放时刻相对该单位晕开始的毫秒差抽样跨度约 500-4000ms,非贴边——高置信度候选:paladin 外置减伤 CD 疑似真实可用而官方表漏收。",
  },
  {
    spellId: "403876",
    note: "(见 498 条,同一技能)。",
  },
  {
    spellId: "51490",
    note: ":雷霆风暴/Thunderstorm(萨满击退技能,也是本仓 knockback DR 手写表成员——但此处观测到的是它作为「施放」被按下,与 knockback DR 归类无关)。玩家 100% 施放者,毫秒差抽样跨度约 700-2000ms,非贴边——高置信度候选。",
  },
  {
    spellId: "119996",
    note: ":魂体双分：转移/Transcendence: Transfer(萨满传送图腾的瞬移技能)。玩家 100% 施放者,毫秒差抽样约 1000-2500ms,非贴边——高置信度候选,常被玩家社区当作「晕中脱离手段」使用,与语料吻合。",
  },
  {
    spellId: "132764",
    note: ":凶暴野兽/Dire Beast(猎人召唤技能;同族还有 219199/212382/304051/212396 等不同天赋/职业版本 id,合计约 98 次,多数落在中低频桶)。玩家 100% 施放者——中高置信度候选,建议连同同族 id 一并复核。",
  },
];

function parseArgs(): { limit: number } {
  const args = process.argv.slice(2);
  let limit = 200;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = Number(args[i + 1] ?? limit);
  }
  return { limit };
}

async function main(): Promise<void> {
  const { limit } = parseArgs();

  const stunAuraIds = new Set(DR_CATEGORIES_GENERATED.stun ?? []);
  if (stunAuraIds.size === 0) {
    throw new Error(
      "DR_CATEGORIES_GENERATED.stun is empty — check the import path",
    );
  }

  const rows = loadIndex(DEFAULT_MATCH_DIR).slice(0, limit);
  if (rows.length < 50) {
    console.error(
      `Warning: only ${rows.length} matches in the library (< 50, brief's N minimum) — scanning all of them anyway.`,
    );
  }

  const matchScans: UwcMatchScan[] = [];
  let skipped = 0;
  for (const row of rows) {
    const rawPath = join(DEFAULT_MATCH_DIR, row.id, "raw.txt");
    let rawText: string;
    try {
      rawText = readFileSync(rawPath, "utf8");
    } catch {
      skipped++;
      continue;
    }
    const scan = scanStunWindows(rawText, stunAuraIds);
    matchScans.push({ matchId: row.id, scan });
  }

  const { totalCastsBySpell, totalWindows, totalCastsInStun } =
    aggregateUwcScans(matchScans);

  const handwrittenSix = [...USABLE_WHILE_CC_SPELL_IDS].map((spellId) => ({
    spellId,
    name: HANDWRITTEN_NAMES[spellId] ?? spellId,
  }));

  const report = buildUwcDiffReport({
    matchesScanned: matchScans.length,
    skippedMatches: skipped,
    totalWindows,
    totalCastsInStun,
    totalCastsBySpell,
    officialStunned: USABLE_WHILE_CC_GENERATED.stunned,
    handwrittenSix,
    tiebreakAnchors: TIEBREAK_ANCHORS_STUNNED,
    spellName: (id) => SPELL_NAMES_ZH_GENERATED[id],
    manualFindings: MANUAL_FINDINGS,
  });

  console.log(report);
  console.log("");
  console.log(
    `(raw.txt missing/unreadable for ${skipped} of ${rows.length} indexed matches, skipped.)`,
  );

  const evalHome = resolveEvalHome();
  const reportsDir = join(evalHome, "reports");
  await fs.ensureDir(reportsDir);
  const outPath = join(reportsDir, "uwc-diff.md");
  await fs.writeFile(outPath, report + "\n", "utf8");
  console.log(`\nWritten to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
