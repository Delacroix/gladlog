/**
 * 语料观测线 (技能事实地基 Task 4) — corpus-empirical corroboration for the
 * "usable while stunned" official table (`USABLE_WHILE_CC_GENERATED.stunned`,
 * `packages/analysis/src/data/usableWhileCcGenerated.ts`): scan real raw.txt
 * combat logs for `SPELL_CAST_SUCCESS` events that landed inside a unit's own
 * active stun-aura window, and count them by spellId.
 *
 * Semantics (see the task brief and CLAUDE.md's 门规谓词即规范 rule): this is
 * an EVIDENCE line, not a ground truth — "observed" only ever proves usable
 * (a cast really happened during an active stun); "never observed" proves
 * nothing (nobody happened to press it while stunned in this sample), so the
 * only directional contradiction this can surface is "official says
 * false/absent but the corpus shows a cast during an active stun of that
 * exact aura" — see uwcCorpusScan.ts for how the diff report frames that.
 *
 * `parseLine` (`@gladlog/parser`) is reused rather than re-deriving a raw-line
 * regex — same timestamp parser / field decoders every other raw.txt consumer
 * in this repo goes through (shared-predicate rule: one fact, one parser).
 *
 * Interval tracking, keyed by dest GUID (the stunned unit):
 *  - `SPELL_AURA_APPLIED` / `_APPLIED_DOSE` / `_AURA_REFRESH` whose spellId is
 *    in `stunAuraIds` adds that aura id to the unit's active-stun set.
 *  - `SPELL_AURA_REMOVED` / `_AURA_BROKEN` / `_AURA_BROKEN_SPELL` removes it
 *    (a REMOVED for an aura never seen APPLIED — e.g. the unit was already
 *    stunned when the log started capturing — is a harmless no-op on an
 *    absent set entry, not an error).
 *  - `_AURA_REMOVED_DOSE` (losing one stack of a multi-stack aura) does NOT
 *    clear the aura — the unit may still be stunned by remaining stacks.
 *  - A unit is "currently stunned" iff its active-stun set is non-empty.
 *  - `SPELL_CAST_SUCCESS`, keyed by src GUID (the caster), counts by its own
 *    spellId when the caster is currently stunned at that instant.
 *
 * Edge cases called out by the brief:
 *  - Same-timestamp tie (a cast at the exact millisecond a stun is removed):
 *    resolved conservatively toward "outside the stun", regardless of which
 *    line the log happens to write first — aura APPLIED/REMOVED events are
 *    applied to the tracked state before any CAST_SUCCESS at the identical
 *    timestamp is evaluated (grouped by `parsed.timestamp`, not by file
 *    position).
 *  - Match/round boundary: `ARENA_MATCH_START` resets all tracked state. A
 *    raw.txt spans an entire session (including every round of a Solo
 *    Shuffle), and player GUIDs are stable across rounds, but stun auras do
 *    not carry over between rounds — an aura applied in round N with no
 *    matching REMOVED before round N+1 starts must not be read as "still
 *    stunned" in the next round.
 *
 * Edge case found empirically (not in the brief's list, added after a first
 * full-corpus run produced a wildly implausible 422/526 "official=false but
 * observed" contradiction rate — including everyday hard-cast heals like
 * Flash of Light and Healing Touch, which nobody is truly casting mid-stun at
 * that volume): WoW's own combat log occasionally DROPS a `SPELL_AURA_REMOVED`
 * event outright. Directly verified in match `229401a0`: Intimidation (24394)
 * applied to a player at 22:12:53.559 has no matching REMOVED before the next
 * APPLIED of the same spellId on the same unit at 22:13:52.498 — 59 seconds
 * later, for a pet stun whose sibling applications in the same match all
 * closed within ~3s. Every one of the mundane high-volume "contradictions"
 * traced this way (774 Rejuvenation, 8936 Healing Touch, 19750 Flash of
 * Light, …) shared the same signature: a stun aura that opened once and
 * never saw its own REMOVED for the rest of the round, silently marking the
 * unit "stunned" for everything that happened afterward. No known hard stun
 * in this DR "stun" category runs anywhere near that long even before DR
 * (DR only ever shortens repeats) — `MAX_STUN_WINDOW_MS` is a generous
 * ceiling above any real single application, purely to auto-expire a window
 * whose REMOVED never arrived, so a dropped log event can't silently poison
 * everything the unit does for the rest of the round.
 */
import { parseLine } from "@gladlog/parser";

const AURA_ADD_SUFFIXES = [
  "_AURA_APPLIED",
  "_AURA_APPLIED_DOSE",
  "_AURA_REFRESH",
];
const AURA_REMOVE_SUFFIXES = [
  "_AURA_REMOVED",
  "_AURA_BROKEN",
  "_AURA_BROKEN_SPELL",
];

/** Ceiling on how long a single stun-aura application is trusted to still be
 * active with no corroborating `SPELL_AURA_REMOVED` — see the module header
 * for the empirical finding that motivated this (dropped REMOVED events in
 * real raw.txt logs). 10s comfortably clears every hard stun's baseline
 * duration in this DR category (the longest, Hammer of Justice, baselines at
 * 6s; DR only ever shortens repeats) while sitting far below the tens of
 * seconds a dropped-REMOVED window drifted to in the corpus. */
export const MAX_STUN_WINDOW_MS = 10_000;

type PendingEvent =
  | { kind: "auraAdd"; guid: string; spellId: string }
  | { kind: "auraRemove"; guid: string; spellId: string }
  | { kind: "cast"; guid: string; spellId: string };

/** Result of the single-pass walk: cast counts (the public contract) plus a
 * `windowCount` telemetry stat — how many times any unit transitioned from
 * "not stunned" to "stunned" (a tracked-aura add landing on a unit that
 * wasn't already stunned). `windowCount` is not itself evidentiary (it
 * doesn't check casts); it exists purely so `uwcCorpusScan.ts` can report "N
 * stun intervals observed" without a second parse pass over the same corpus. */
export interface StunWindowScan {
  castsBySpell: Map<string, number>;
  windowCount: number;
}

/** Is `guid` still within `MAX_STUN_WINDOW_MS` of any stun aura it was seen
 * gaining, as of `atTs`? Checking elapsed time (rather than mere presence in
 * a Set) is what lets a window whose REMOVED was dropped by the log
 * auto-expire instead of poisoning every later cast for the rest of the
 * round — see the module header. */
function isStunnedAt(
  appliedAt: ReadonlyMap<string, number> | undefined,
  atTs: number,
  maxWindowMs: number,
): boolean {
  if (!appliedAt) return false;
  for (const startedAt of appliedAt.values()) {
    if (atTs - startedAt <= maxWindowMs) return true;
  }
  return false;
}

/** The shared single-pass walker both `observedCastsWhileStunned` (pinned to
 * the brief's `Map<string, number>` contract) and the corpus scan's telemetry
 * consume — kept as one function so the aura/cast tracking logic exists in
 * exactly one place.
 *
 * `opts.maxStunWindowMs` overrides `MAX_STUN_WINDOW_MS` (default). Exists
 * solely so `uwcCorpusScan.ts --disable-window-cap` can reproduce the
 * pre-fix (uncapped) behavior on demand for a documented before/after
 * artifact — pass `Infinity` to disable the cap entirely. Production callers
 * (including `observedCastsWhileStunned`, the brief's pinned entry point)
 * never pass this; they get the capped default. */
export function scanStunWindows(
  rawText: string,
  stunAuraIds: ReadonlySet<string>,
  opts?: { maxStunWindowMs?: number },
): StunWindowScan {
  const maxWindowMs = opts?.maxStunWindowMs ?? MAX_STUN_WINDOW_MS;
  const castsBySpell = new Map<string, number>();
  let windowCount = 0;
  // guid -> (active stun aura spellId -> the timestamp it was applied at).
  const activeStuns = new Map<string, Map<string, number>>();

  let pendingTimestamp: number | null = null;
  let pendingBatch: PendingEvent[] = [];

  const flushBatch = (): void => {
    if (pendingBatch.length === 0) return;
    const ts = pendingTimestamp ?? 0;
    // Aura state changes resolve before any cast in the same batch is
    // evaluated — this is what makes the same-timestamp tie-break
    // conservative regardless of the two lines' order in the file.
    for (const ev of pendingBatch) {
      if (ev.kind === "auraAdd") {
        let appliedAt = activeStuns.get(ev.guid);
        if (!appliedAt) {
          appliedAt = new Map();
          activeStuns.set(ev.guid, appliedAt);
        }
        if (!isStunnedAt(appliedAt, ts, maxWindowMs)) windowCount++;
        appliedAt.set(ev.spellId, ts);
      } else if (ev.kind === "auraRemove") {
        activeStuns.get(ev.guid)?.delete(ev.spellId);
      }
    }
    for (const ev of pendingBatch) {
      if (ev.kind !== "cast") continue;
      if (isStunnedAt(activeStuns.get(ev.guid), ts, maxWindowMs)) {
        castsBySpell.set(ev.spellId, (castsBySpell.get(ev.spellId) ?? 0) + 1);
      }
    }
    pendingBatch = [];
  };

  for (const line of rawText.split("\n")) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.eventName === "ARENA_MATCH_START") {
      flushBatch();
      pendingTimestamp = null;
      activeStuns.clear();
      continue;
    }

    if (parsed.timestamp !== pendingTimestamp) {
      flushBatch();
      pendingTimestamp = parsed.timestamp;
    }

    if (AURA_ADD_SUFFIXES.some((s) => parsed.eventName.endsWith(s))) {
      const spellId =
        parsed.spell?.spellId !== undefined ? String(parsed.spell.spellId) : "";
      const guid = parsed.base?.destGuid;
      if (guid && spellId && stunAuraIds.has(spellId)) {
        pendingBatch.push({ kind: "auraAdd", guid, spellId });
      }
    } else if (AURA_REMOVE_SUFFIXES.some((s) => parsed.eventName.endsWith(s))) {
      const spellId =
        parsed.spell?.spellId !== undefined ? String(parsed.spell.spellId) : "";
      const guid = parsed.base?.destGuid;
      if (guid && spellId && stunAuraIds.has(spellId)) {
        pendingBatch.push({ kind: "auraRemove", guid, spellId });
      }
    } else if (parsed.eventName === "SPELL_CAST_SUCCESS") {
      const guid = parsed.base?.srcGuid;
      const spellId =
        parsed.spell?.spellId !== undefined ? String(parsed.spell.spellId) : "";
      if (guid && spellId) {
        pendingBatch.push({ kind: "cast", guid, spellId });
      }
    }
  }
  flushBatch();

  return { castsBySpell, windowCount };
}

/**
 * Task 4's pinned interface (brief's exact signature): raw combat log text in,
 * spellId → observed-cast-count-during-an-active-stun-of-that-unit out. Thin
 * wrapper over `scanStunWindows` — see that function for the actual walk.
 */
export function observedCastsWhileStunned(
  rawText: string,
  stunAuraIds: ReadonlySet<string>,
): Map<string, number> {
  return scanStunWindows(rawText, stunAuraIds).castsBySpell;
}

// ── Aggregation across the corpus + three-way diff report ──────────────────

/** One match's contribution — spellId counts plus how many stun windows it
 * contained, so the caller (uwcCorpusScan.ts) doesn't need to re-derive
 * anything from raw counts. */
export interface UwcMatchScan {
  matchId: string;
  scan: StunWindowScan;
}

/** Sums `castsBySpell` and `windowCount` across every scanned match. */
export function aggregateUwcScans(matches: UwcMatchScan[]): {
  totalCastsBySpell: Map<string, number>;
  totalWindows: number;
  totalCastsInStun: number;
} {
  const totalCastsBySpell = new Map<string, number>();
  let totalWindows = 0;
  let totalCastsInStun = 0;
  for (const { scan } of matches) {
    totalWindows += scan.windowCount;
    for (const [spellId, n] of scan.castsBySpell) {
      totalCastsBySpell.set(spellId, (totalCastsBySpell.get(spellId) ?? 0) + n);
      totalCastsInStun += n;
    }
  }
  return { totalCastsBySpell, totalWindows, totalCastsInStun };
}

/** One line of the hand-written 6-id table (`cooldowns.ts`
 * `USABLE_WHILE_CC_SPELL_IDS`) or a named diagnostic anchor, annotated with
 * what the corpus actually saw. */
export interface UwcAnnotatedId {
  spellId: string;
  name: string;
  /** Official generated table's verdict for the "stunned" dimension. */
  official: boolean;
  /** Number of times the corpus observed a cast of this spellId landing
   * inside an active stun window of the caster (0 = never observed, not a
   * falsification — see module header). */
  observedCount: number;
}

function annotate(
  ids: { spellId: string; name: string }[],
  officialStunned: ReadonlySet<string>,
  totalCastsBySpell: ReadonlyMap<string, number>,
): UwcAnnotatedId[] {
  return ids.map(({ spellId, name }) => ({
    spellId,
    name,
    official: officialStunned.has(spellId),
    observedCount: totalCastsBySpell.get(spellId) ?? 0,
  }));
}

export interface UwcDiffReportInputs {
  matchesScanned: number;
  /** Indexed matches whose raw.txt was missing/unreadable and so were
   * skipped (not counted in `matchesScanned`). 0 in the common case. */
  skippedMatches?: number;
  totalWindows: number;
  totalCastsInStun: number;
  totalCastsBySpell: ReadonlyMap<string, number>;
  officialStunned: ReadonlySet<string>;
  /** cooldowns.ts USABLE_WHILE_CC_SPELL_IDS, in file order. */
  handwrittenSix: { spellId: string; name: string }[];
  /** genUsableWhileCc.ts TIEBREAK_ANCHORS.stunned (unsigned, pending this
   * task's corroboration). */
  tiebreakAnchors: { spellId: string; name: string; expected: boolean }[];
  /** Best-effort id → Chinese name resolver for the free-text diff lists;
   * falls back to the bare id when unresolved. */
  spellName: (id: string) => string | undefined;
  /** Hand-investigated contradiction ids — spot-checked by sampling raw.txt
   * directly (caster GUID prefix, and the ms gap between the cast and its
   * matching aura's APPLIED, to separate "near-boundary timing jitter" from
   * "cast well into the window"). Rendered ahead of the generic contradiction
   * list; the rest of the contradiction set is bucketed by observed count
   * instead of hand-explained one by one (see that section's own text for
   * why exhaustive per-id explanation isn't attempted). */
  manualFindings?: { spellId: string; note: string }[];
  /** Extra hand-investigated markdown (raw SpellMisc bit-value table for the
   * high-confidence candidates, wowhead Flags-box spot-checks, proc-
   * contamination caveats, …) rendered immediately after the "高置信度候选"
   * list. Left free-form because it's curated investigation output this
   * function has no way to derive on its own — see uwcCorpusScan.ts for what
   * is currently supplied. */
  highConfidenceAppendix?: string;
}

/** Builds the Task 4 three-way diff report (Markdown). Framed per the task's
 * directional-error rule (see module header): the ONLY hard failure this
 * report can surface is "官方集 − observed cast" — an id the official table
 * marks NOT usable while stunned, yet the corpus shows a cast of that exact
 * spellId landing inside an active window of that exact stun aura set. Every
 * other quadrant is sample-size commentary, not a contradiction. */
export function buildUwcDiffReport(inputs: UwcDiffReportInputs): string {
  const {
    matchesScanned,
    skippedMatches = 0,
    totalWindows,
    totalCastsInStun,
    totalCastsBySpell,
    officialStunned,
    handwrittenSix,
    tiebreakAnchors,
    spellName,
    manualFindings = [],
    highConfidenceAppendix,
  } = inputs;

  const observedIds = new Set(totalCastsBySpell.keys());
  const intersection = [...observedIds]
    .filter((id) => officialStunned.has(id))
    .sort(
      (a, b) =>
        (totalCastsBySpell.get(b) ?? 0) - (totalCastsBySpell.get(a) ?? 0),
    );
  const contradictions = [...observedIds]
    .filter((id) => !officialStunned.has(id))
    .sort(
      (a, b) =>
        (totalCastsBySpell.get(b) ?? 0) - (totalCastsBySpell.get(a) ?? 0),
    );
  const neverObserved = [...officialStunned].filter(
    (id) => !observedIds.has(id),
  );

  const nameOf = (id: string): string => spellName(id) ?? "(未知名)";
  const fmtRow = (id: string): string =>
    `- ${id} ${nameOf(id)} — 观测 ${totalCastsBySpell.get(id) ?? 0} 次晕中施放成功`;

  const lines: string[] = [];
  lines.push("# UWC 语料观测线三方 diff 报告(技能事实地基 Task 4)");
  lines.push("");
  lines.push(
    `生成时间:${new Date().toISOString()}。判据框架:观测线只能证明"可用"(晕中真发生过一次施放成功),` +
      `不能证明"不可用"(没人在晕里按 ≠ 按不出来)——唯一构成矛盾的方向是"官方集内没有,但语料在该单位活跃的同一枚晕 aura 窗口内观测到该 spellId 施放成功"。`,
  );
  lines.push("");
  lines.push("## 扫描统计");
  lines.push(
    `- 扫描场次(含 shuffle 整把):${matchesScanned}` +
      (skippedMatches > 0
        ? `(另有 ${skippedMatches} 场 raw.txt 缺失/不可读,已跳过)`
        : ""),
  );
  lines.push(`- 晕区间(窗口)总数:${totalWindows}`);
  lines.push(`- 晕中施放成功条目总数:${totalCastsInStun}`);
  lines.push(`- 晕中施放去重 spellId 数(观测集大小):${observedIds.size}`);
  lines.push("");

  lines.push("## 观测集 ∩ 官方集(语料佐证官方判定)");
  lines.push(`共 ${intersection.length} 个 spellId。`);
  for (const id of intersection.slice(0, 40)) lines.push(fmtRow(id));
  if (intersection.length > 40) {
    lines.push(`……以及另外 ${intersection.length - 40} 个(见下方聚合数据)。`);
  }
  lines.push("");

  lines.push("## 观测集 − 官方集(矛盾候选——必须为 0 或逐条解释)");
  if (contradictions.length === 0) {
    lines.push(
      "**0 条。** 语料中没有任何一次晕中施放成功落在官方判定为「不可用」的 spellId 上。",
    );
  } else {
    lines.push(
      `> **对 brief 字面要求的偏离(需用户裁决时一并接受或驳回)**:brief 原文要求矛盾候选「必须为 0 或逐条解释」。` +
        `本报告对全部 ${contradictions.length} 条矛盾候选**没有**逐条解释——只对少数高置信度候选做了深入核查,其余按观测次数分桶列名单。` +
        `这是一处明确的、有意识的偏离,不是悄悄放宽判据;是否接受这种"分桶而非逐条"的处置方式(而非要求补齐剩余条目的逐条解释),` +
        `本身就是本报告 PAUSE 清单的一项,请用户明确表态接受或驳回。`,
    );
    lines.push("");
    lines.push(
      `**${contradictions.length} 条。** 逐条解释在这个规模下不现实——多数是 count=1/2 的孤例,与"晕中恰好一次巧合按出"或残留时序噪声(见下方分桶)区分不开;` +
        `真正值得当作候选证据的,是那些在**大量不同对局/不同玩家**间反复出现、且施放时刻散布在窗口中段(不是紧贴 REMOVED 边界)的高频 id —— 已手动逐条抽样核实的高置信度候选列在下面,其余按观测次数分桶,不做逐条解释。`,
    );
    lines.push("");

    if (manualFindings.length > 0) {
      lines.push(
        "### 高置信度候选(手动抽样核实,疑似官方表覆盖缺口——PAUSE 材料)",
      );
      for (const f of manualFindings) {
        lines.push(
          `- ${f.spellId} ${nameOf(f.spellId)}(观测 ${totalCastsBySpell.get(f.spellId) ?? 0} 次)${f.note}`,
        );
      }
      lines.push("");
      if (highConfidenceAppendix) {
        lines.push(highConfidenceAppendix);
        lines.push("");
      }
    }

    const HIGH = 5;
    const MID = 2;
    const remaining = contradictions.filter(
      (id) => !manualFindings.some((f) => f.spellId === id),
    );
    const highTail = remaining.filter(
      (id) => (totalCastsBySpell.get(id) ?? 0) >= HIGH,
    );
    const midTail = remaining.filter((id) => {
      const n = totalCastsBySpell.get(id) ?? 0;
      return n >= MID && n < HIGH;
    });
    const singletonTail = remaining.filter(
      (id) => (totalCastsBySpell.get(id) ?? 0) < MID,
    );

    if (highTail.length > 0) {
      lines.push(`### 其余高频(观测 ≥${HIGH} 次,未手动核实,建议下一步复核)`);
      for (const id of highTail) lines.push(fmtRow(id));
      lines.push("");
    }
    if (midTail.length > 0) {
      lines.push(`### 中频(观测 ${MID}-${HIGH - 1} 次)`);
      for (const id of midTail) lines.push(fmtRow(id));
      lines.push("");
    }
    lines.push(`### 单次观测(count=1,${singletonTail.length} 条,不逐条解释)`);
    lines.push(
      `这 ${singletonTail.length} 条各只出现过一次,与"孤立巧合"(瞬发豁免边角情况 / 晕后毫秒级时序噪声 / 记号歧义)一致,` +
        `在 ${matchesScanned} 场语料的规模下逐条深挖投入产出比过低——不做逐条解释,列出 id 供留档,不主张其中任何一条是系统性的"可用"证据:`,
    );
    lines.push(
      singletonTail.map((id) => `${id}(${nameOf(id)})`).join("、") || "(无)",
    );
  }
  lines.push("");

  lines.push("## 官方集 − 观测集(语料从未观测到,仅样本量说明,非证伪)");
  lines.push(
    `官方集 ${officialStunned.size} 条中,本次语料 ${matchesScanned} 场从未观测到晕中施放成功的有 ${neverObserved.length} 条` +
      `(占 ${((neverObserved.length / officialStunned.size) * 100).toFixed(1)}%)。这只说明"没人在晕里按过",不构成对官方位判定的证伪——` +
      `官方集里的大多数技能本就是低频防御 CD,晕中恰好被按下需要"晕中 + 恰好这个 CD 没在冷却 + 玩家选择用它"三重巧合同时发生,单次语料样本覆盖不到这个量级也在预期之内。`,
  );
  lines.push("");

  lines.push("## 手写表 6 条终判材料(cooldowns.ts USABLE_WHILE_CC_SPELL_IDS)");
  const annotatedSix = annotate(
    handwrittenSix,
    officialStunned,
    totalCastsBySpell,
  );
  for (const row of annotatedSix) {
    const officialStr = row.official ? "官方=可用" : "官方=不可用/未收录";
    const obsStr =
      row.observedCount > 0
        ? `语料观测到 ${row.observedCount} 次晕中施放成功`
        : "语料未观测到晕中施放(样本量说明,非证伪)";
    lines.push(`- **${row.spellId} ${row.name}**${officialStr},${obsStr}。`);
  }
  lines.push("");
  lines.push(
    "**642(圣盾术)专记**:官方位=" +
      (officialStunned.has("642") ? "可用" : "不可用/未收录") +
      `,语料观测到 ${totalCastsBySpell.get("642") ?? 0} 次晕中施放成功。` +
      "Task 2 用户裁决已认定 642 机制上任何被控状态下都能按下(此前「晕中开不出」系误记),此处只做交叉验证,不改变 Task 2 的机制判定;" +
      "教练规范层面(代价过大、非常规挡控手段)归 Task 6 签字册。",
  );
  lines.push("");
  lines.push(
    "**树皮术(22812)/消散(47585)恐惧格说明**:本报告的观测线只追踪 DR「stun」类 aura,只能对「晕中可用」维度提供语料佐证/证伪——" +
      "两条技能在 Task 2 锚点文件里被记录为「恐惧(feared)维度用户意见与 wowhead flags/游戏内 tooltip 正面冲突,未裁定」," +
      "**本次晕中观测线结构性无法裁决恐惧维度的分歧**(需要一条独立的「恐惧类 aura 观测线」,不在本任务范围内),特此明确说明,不可被误读为「本报告已解决」。",
  );
  lines.push("");

  lines.push(
    "## 判别锚 5 条的语料佐证情况(genUsableWhileCc.ts TIEBREAK_ANCHORS.stunned,未签字,待本任务佐证)",
  );
  const annotatedAnchors = tiebreakAnchors.map((a) => ({
    ...a,
    observedCount: totalCastsBySpell.get(a.spellId) ?? 0,
    official: officialStunned.has(a.spellId),
  }));
  for (const row of annotatedAnchors) {
    // A cast observed during stun only ever corroborates expected=true (proof
    // of usable); it can never corroborate expected=false (absence of proof
    // isn't proof of absence) — so an observed cast against an
    // expected=false anchor is itself the interesting case (flag it, don't
    // silently print "一致").
    const verdict =
      row.observedCount === 0
        ? "N/A(未观测,样本量说明)"
        : row.expected
          ? "与预期一致(佐证可用)"
          : "与预期冲突——语料观测到晕中施放,但该锚点预期为不可用";
    lines.push(
      `- ${row.spellId} ${row.name}:预期 ${row.expected ? "可用" : "不可用"},官方位=${row.official ? "可用" : "不可用/未收录"},` +
        `语料观测 ${row.observedCount} 次晕中施放成功(${verdict})。`,
    );
  }

  return lines.join("\n");
}
