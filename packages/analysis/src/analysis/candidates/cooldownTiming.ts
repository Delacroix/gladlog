/**
 * Cooldown-timing candidate producers — `missed-sync-window`,
 * `unsynced-burst`, `cd-hoarded` and `cd-spent-idle`, plus the enemy-healer
 * CC window and friendly-crisis predicates they all key off.
 *
 * Split out of `candidateFindings.ts` on 2026-08-16 (mechanical split by
 * theme); logic moved verbatim. All four ask the same question from different
 * angles — was this button pressed at the moment the team's window wanted it —
 * which is why the shared window predicates live here with them.
 */
import { costNormPhrase } from "../../data/curatedAbilityFacts";
import { spellEffectData } from "../../data/spellEffectData";
import { reachesAlly } from "../../data/spellTargeting";
import { burstCastSpan } from "../../utils/burstLedger";
import {
  canHelpAnotherUnit,
  cdAvailableAt,
  DEFENSIVE_TAGS,
  getUnitHpAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  isHealerSpec,
  THROUGHPUT_EMPOWER_DEFENSIVE_IDS,
  type IMajorCooldownInfo,
} from "../../utils/cooldowns";
import {
  analyzeOutgoingCCChains,
  DR_CATEGORY_MAP,
} from "../../utils/drAnalysis";
import { castFailedInWindow, type RawStreams } from "../../utils/rawStreams";
import { renderedWindowSeconds, toRenderSecond } from "../../utils/renderGrid";
import { type MatchThreatLevel } from "../../utils/threatAssessment";
import { fmtFactNum as fmt } from "../factFormat";
import { CandidateEvent } from "../types";
import { filterIntentGuardEvidence, formatAttemptedFact } from "./shared";

/**
 * HARD_CC_CATEGORIES (P1 sync-lens, 2026-08-15, `missedSyncWindowEvents` /
 * `unsyncedBurstEvents`): the DR categories that count as "the enemy healer
 * is locked out of casting" — mirrors `DR_CATEGORY_MAP`'s full PvP-relevant
 * label set (drAnalysis.ts's `SCM_CATEGORY_LABELS` already excludes
 * 'taunt'/'root' at the source, "not relevant for PvP CC analysis") minus
 * "Root" defensively (currently a no-op — no spell maps to it — kept in case
 * a future DR-category addition ever does). Two existing precedents back this
 * exact split, not a fresh invention:
 *  - `ccBreakAnalysis.ts`'s `rootBreakCount` bucket: "kept in its own bucket,
 *    never mixed into hard CC (a broken root is often a tactically correct
 *    trade, not a mistake to coach)".
 *  - `matchArchetype.ts`'s `classifiedFriendlyCCEvents`: CC events whose
 *    spell IS in the DR category map are already this file's established
 *    "hard CC" measurement; the remainder ("roots, minor incapacitates, or
 *    unmapped spells") is explicitly documented as "not hard CC".
 * Every application `analyzeOutgoingCCChains` returns is already restricted
 * to `ccSpellIds` (spellCategories' `type === "cc"`, the same set
 * `isCastBlockingAuraType` treats as cast-blocking) — this filter narrows
 * that further to the subset with recognized DR bookkeeping, matching the
 * matchArchetype.ts precedent rather than re-deriving a parallel "hard CC"
 * notion from spellCategories directly.
 */
export const HARD_CC_CATEGORIES: ReadonlySet<string> = new Set(
  Object.values(DR_CATEGORY_MAP).filter((category) => category !== "Root"),
);

export interface IEnemyHealerCcWindow {
  fromSeconds: number;
  toSeconds: number;
  spellName: string;
  spellId: string;
  healerName: string;
}

/**
 * Shared "敌治疗硬控窗" extraction (CLAUDE.md shared-predicate rule): both
 * `missedSyncWindowEvents` and `unsyncedBurstEvents` consume the exact same
 * windows so a "the healer was locked" fact can never disagree between the
 * two candidate types. Built on `analyzeOutgoingCCChains` — the same
 * outgoing-CC data source `dr-clipped-cc` already reads — filtered to
 * targets `isHealerSpec` classifies as the enemy healer, then narrowed to
 * `HARD_CC_CATEGORIES` (see its doc comment for the category decision).
 * `friends`/`enemies` decide caster/target sides exactly as every other
 * `teamPlayEvents` caller passes them; matching a chain to "the enemy healer"
 * is by `targetName` because `IOutgoingCCChain` does not carry a target unit
 * id (analyzeOutgoingCCChains' own return shape).
 *
 * Exported (review fix round 1, 2026-08-15): originally file-private, kept
 * exported so tests can call it directly instead of re-deriving its logic.
 * `missedSyncWindowEvents`/`unsyncedBurstEvents` are wired into
 * `teamPlayEvents` (candidateFindings.ts) and both flags have been ON since
 * 2026-08-15 — see docs/predicate-index.md's `Feature flag state` table for
 * the current expected value of every flag.
 */
export function enemyHealerCcWindows(
  friends: any[],
  enemies: any[],
  combat: any,
): IEnemyHealerCcWindow[] {
  const healerNames = new Set(
    enemies.filter((e) => isHealerSpec(e.spec)).map((e) => e.name as string),
  );
  if (healerNames.size === 0) return [];
  const out: IEnemyHealerCcWindow[] = [];
  for (const chain of analyzeOutgoingCCChains(friends, enemies, combat)) {
    if (!healerNames.has(chain.targetName)) continue;
    for (const app of chain.applications) {
      if (!HARD_CC_CATEGORIES.has(app.drInfo.category)) continue;
      out.push({
        fromSeconds: app.atSeconds,
        toSeconds: app.atSeconds + app.durationSeconds,
        spellName: app.spellName,
        spellId: app.spellId,
        healerName: chain.targetName,
      });
    }
  }
  return out.sort((a, b) => a.fromSeconds - b.fromSeconds);
}

/** Lowest HP% across all enemy players sampled at every rendered second inside
 * [fromSeconds, toSeconds] (inclusive) — the ACCELERATOR-only fact
 * `missed-sync-window` attaches (B8: never a gate). Render-grid discipline
 * (CLAUDE.md): the query instants are `toRenderSecond`-floored before
 * sampling, same as `trinketTeamMinHpPctAt`, so this cannot contradict the
 * whole-second [STATE] HP the prompt timeline separately renders. Returns
 * null only when NO sample succeeded anywhere in the window (no advanced
 * logging) — the caller must treat null as "omit the fact", never as "0%".
 */
export function enemyMinHpPctInWindow(
  enemies: any[],
  combat: { startTime: number },
  fromSeconds: number,
  toSeconds: number,
  hpLookup: (
    unit: any,
    timestampMs: number,
    maxDtMs: number,
  ) => number | null = getUnitHpAtTimestamp,
): number | null {
  const fromR = toRenderSecond(fromSeconds);
  const toR = toRenderSecond(toSeconds);
  let min: number | null = null;
  for (let t = fromR; t <= toR; t++) {
    for (const e of enemies) {
      const hp = hpLookup(e, combat.startTime + t * 1000, HP_SAMPLE_RADIUS_MS);
      if (hp === null) continue;
      if (min === null || hp < min) min = hp;
    }
  }
  return min;
}

/** Per-match cap for missed-sync-window. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — full-corpus scan (1028
 * matches/3441 rounds, at B8's fixed no-HP-gate definition, which Task 5 has
 * no threshold lever over) measured 场均条数(capped) 1.37 (raw pre-cap 3.20),
 * comfortably inside the 0.5–2 target band; the cap is doing real
 * truncation work (raw > capped), not sitting idle. 发生率 76.4% sits above
 * every OTHER type's precedent (max 63.6%) — but that is a property of B8's
 * user-ruled "no HP gate" design already locked before Task 5, not a
 * threshold this constant can move; a lower cap would only shrink how many
 * of an already-firing round's windows get reported, not how often the type
 * fires at all. 双向误差注: a lower cap would drop real, distinct missed
 * windows from an already-high-occurrence round (each window is an
 * independent "we had the lock and didn't press it" fact); a higher cap
 * would let a single grindy round dominate the menu even more than the
 * 3.20 raw average already implies it wants to. */
const MISSED_SYNC_WINDOW_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * missed-sync-window (P1 起爆-1, 2026-08-15, user-ruled definition): a window
 * where the enemy healer sat in hard CC (`enemyHealerCcWindows`) while >=1
 * friendly offensive major cooldown was ready (`cdAvailableAt`, checked at
 * the window's start — the instant the opportunity opened) AND no friendly
 * offensive major was cast anywhere inside the window (the team had the lock
 * and the tool, and did not press it).
 *
 * B8 red line (user-ruled, non-negotiable, CI-pinned by a dedicated test):
 * NO HP gate. Enemy HP is carried in facts as an accelerator only — the B1
 * finale evidence was 93% HP burned dead in 4s once the sync actually
 * happened, so gating on a blood threshold would have suppressed the exact
 * case the whole P1 finding exists to catch. `minHp === null` (no advanced
 * logging) still emits; the fact is simply omitted, never treated as a
 * reason to withhold the candidate.
 *
 * Fact/suggestion split (CLAUDE.md decision-point-card discipline): facts
 * carry only what happened (the window existed, the CC, the ready list, the
 * observed HP) — "you should have burst" lives in buildFindingsPrompt's
 * legend text, never phrased into a fact value here.
 *
 * Severity/cap: sorted by rendered window length (CC_LOCKED-style — a longer
 * lock is a bigger missed opportunity, the same "how much time was on the
 * table" logic `cc-held` already sorts by), then capped (see the constant's
 * doc comment for the TEMPORARY-until-calibration cap value).
 */
export function missedSyncWindowEvents(
  ccWindows: Pick<
    IEnemyHealerCcWindow,
    "fromSeconds" | "toSeconds" | "spellName" | "spellId" | "healerName"
  >[],
  offensiveCds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "casts" | "cooldownSeconds" | "neverUsed"
  >[],
  probes: {
    /** Wired to enemyMinHpPctInWindow in production. Accelerator-only, see
     * the B8 doc comment above — must NEVER gate the candidate. */
    enemyMinHpPctAt: (fromSeconds: number, toSeconds: number) => number | null;
  },
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  const cap = overrides?.cap ?? MISSED_SYNC_WINDOW_CAP;
  const candidates: Array<{
    w: (typeof ccWindows)[number];
    ready: string[];
    minHp: number | null;
  }> = [];
  for (const w of ccWindows) {
    const ready = offensiveCds
      .filter((cd) => cdAvailableAt(cd, w.fromSeconds))
      .map((cd) => cd.spellName);
    if (ready.length === 0) continue;
    const castDuring = offensiveCds.some((cd) =>
      cd.casts.some(
        (c) => c.timeSeconds >= w.fromSeconds && c.timeSeconds <= w.toSeconds,
      ),
    );
    if (castDuring) continue;
    candidates.push({
      w,
      ready,
      // B8: this value only ever feeds `facts` below — it is read AFTER the
      // ready/castDuring gates above have already decided emission.
      minHp: probes.enemyMinHpPctAt(w.fromSeconds, w.toSeconds),
    });
  }
  return candidates
    .sort(
      (a, b) =>
        renderedWindowSeconds(b.w.fromSeconds, b.w.toSeconds) -
        renderedWindowSeconds(a.w.fromSeconds, a.w.toSeconds),
    )
    .slice(0, cap)
    .map(({ w, ready, minHp }) => {
      const t = toRenderSecond(w.fromSeconds);
      const windowEndT = toRenderSecond(w.toSeconds);
      return {
        // spellId disambiguates two CC windows on the same healer that floor
        // to the same rendered second (review fix round 2, 2026-08-15) — the
        // other three new candidate types (unsynced-burst/cd-hoarded/
        // cd-spent-idle) all include a spellId in their id already; this was
        // the one exception. The menu id is the eventIds reference key, so a
        // collision here corrupts adoption attribution, not just cosmetics.
        id: `missed-sync-window:${w.healerName}:${w.spellId}:${t}`,
        type: "missed-sync-window",
        t,
        unitNames: [w.healerName],
        spell: w.spellName,
        spellId: w.spellId,
        facts: {
          t: String(t),
          windowEndT: String(windowEndT),
          healer: w.healerName,
          cc: w.spellName,
          // Render-grid anchoring (CLAUDE.md 门规谓词即规范, task-2 review fix
          // round 1): must be derived from the ALREADY-floored t/windowEndT,
          // not from the raw fractional w.fromSeconds/w.toSeconds — otherwise
          // durationS can silently disagree with windowEndT - t by up to ~1s
          // whenever the CC application's real timestamps aren't whole
          // seconds (the common case on real matches).
          durationS: String(windowEndT - t),
          readyCds: ready.join("、"),
          ...(minHp !== null ? { enemyMinHpPct: fmt(minHp) } : {}),
        },
      };
    });
}

/** Per-match cap for unsynced-burst. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — same full-corpus scan as
 * `MISSED_SYNC_WINDOW_CAP` above, this type's own definition equally fixed
 * before Task 5 (no HP gate, complements `unconverted-burst` deliberately).
 * 场均条数(capped) 1.17 (raw pre-cap 1.98), inside the 0.5–2 band; 发生率
 * 69.5%, same "already-locked definition, not a Task 5 lever" caveat as
 * MISSED_SYNC_WINDOW_CAP's doc comment. 双向误差注: same shape as that
 * constant's — a lower cap drops real independent unsynced presses from an
 * already-firing round; a higher cap lets one round's raw ~2 average
 * dominate the menu further. */
const UNSYNCED_BURST_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * unsynced-burst (P1 起爆-2, 2026-08-15, user-ruled definition): a friendly
 * offensive major cooldown was cast whose effect window contained ZERO hard
 * CC on the enemy healer — the burst went out with the enemy healer free to
 * answer it. Complements the existing `unconverted-burst` (an OUTCOME fact:
 * the target didn't die) — this type is CAUSE-level (no sync happened at
 * all) and is deliberately NOT deduped against it: the same cast can produce
 * both candidates (their `id`s/eventIds are independent) because "didn't
 * convert" and "wasn't synced" are two different coaching facts about the
 * same button press.
 *
 * Effect window: `burstCastSpan` — the exact predicate the burst ledger
 * already uses for "how long is this CD's effect active", built from
 * `spellEffectData[spellId].durationSeconds` with a documented fallback
 * (`MIN_BURST_SPAN_S` = `BURST_CLUSTER_SECONDS`, enemyCDs.ts/burstLedger.ts's
 * own established default for a CD whose buff duration is unknown/instant) —
 * reused here rather than inventing a second duration-with-fallback rule.
 *
 * Severity/cap: sorted by the cooldown's own length (`cooldownSeconds`
 * descending) — the biggest-cooldown CDs are the highest-value presses to
 * burn unsynced (a 30s CD misfiring is routine; a 3-minute CD misfiring is
 * not), ties broken chronologically (stable sort). Capped per the constant's
 * doc comment above.
 *
 * `healerNames` (§29b fix, 2026-08-15): the "no hard CC overlapped this
 * cast" gate below reads `ccWindows`, which `enemyHealerCcWindows` already
 * pools across EVERY enemy healer (its `Pick<..., "fromSeconds" |
 * "toSeconds">` signature drops which healer each window belongs to on
 * purpose — this function only ever asks "was ANY enemy healer locked
 * during this span"). A pass (no window overlaps) therefore proves ALL
 * enemy healers were free, not just one — so the fact must name the full
 * set, not `enemies.find(...)`'s first match. Before this fix the wiring
 * call site passed only the first enemy healer's name, which in a
 * dual-healer comp could point at a healer who was never the one actually
 * free to answer (or omit a second healer who also was) — see BACKLOG
 * §29(b). `healerNames.length === 0` (no enemy healer on the roster) still
 * returns [] — same "no object to talk sync about" rationale the previous
 * single-name null check had.
 */
export function unsyncedBurstEvents(
  casts: Array<{
    ownerName: string;
    spellId: string;
    spellName: string;
    castTimeSeconds: number;
    cooldownSeconds: number;
  }>,
  ccWindows: Pick<IEnemyHealerCcWindow, "fromSeconds" | "toSeconds">[],
  healerNames: string[],
  /** Feasibility gate (2026-08-22 corpus adjudication): did the TEAM have any
   * hard CC off cooldown when this cooldown went out? The advice is "line the
   * cooldown up with CC on their healer next time", which is not advice if the
   * CC was down — you cannot spend a resource you do not have. */
  teamCcReadyAt: (tSeconds: number) => boolean,
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  if (healerNames.length === 0) return [];
  const cap = overrides?.cap ?? UNSYNCED_BURST_CAP;
  const candidates: Array<{
    cast: (typeof casts)[number];
    windowEndT: number;
  }> = [];
  for (const cast of casts) {
    const span = burstCastSpan({
      spellId: cast.spellId,
      spellName: cast.spellName,
      castTimeSeconds: cast.castTimeSeconds,
      cooldownSeconds: cast.cooldownSeconds,
      availableAgainAtSeconds: cast.castTimeSeconds + cast.cooldownSeconds,
      buffEndSeconds:
        cast.castTimeSeconds +
        (spellEffectData[cast.spellId]?.durationSeconds ?? 0),
    });
    // 2026-08-23 用户裁定「重复吧」:这条指控印的是「**你的**爆发 CD 出去时对面
    // 治疗没被控」,而一个**给出去的** buff 不是施法者自己的爆发 —— 能量灌注是牧师
    // 按在法师身上让**法师**爆发的,法师那一下已经被单独指控过一次,把它同时记在
    // 牧师头上就是同一次爆发数两遍。实测(S2 归档 120 文件、治疗视角 375 条指控):
    // 能量灌注 66 条,其中与另一条 ±3s 同窗的 8 条。
    // 同一把尺子顺带兜住三个**根本不是爆发**的:黑暗 196718(40% 团减)、猛虎之志
    // 116841(给队友的解控/加速)、恢复萨的升腾 114052 —— 它们只是被打了 Offensive
    // 牌子才混进 teamOffensiveCds,「你的黑暗没和控制对齐」不是一句能成立的话。
    // 元素/增强萨的升腾(114050/114051)不够得着队友,照旧留在指控范围内。
    if (reachesAlly(cast.spellId)) continue;
    const hasHardCc = ccWindows.some(
      (w) => w.fromSeconds < span.to && w.toSeconds > span.from,
    );
    if (hasHardCc) continue;
    // 2026-08-22, ~278 sampled instances of the 12.1 archive: in **0%** of them
    // had the team failed to CC the enemy healer at all that round — every
    // accused team did sync elsewhere (median 13-18s away), so "you don't line
    // burst up with CC" was never the actual failure. The type fired on 66-70%
    // of all offensive cooldowns with a flat skill gradient (-0.1pp), i.e. it
    // was describing normal play: CC and burst cooldowns run independently and
    // cannot always overlap. Only accuse when a hard CC was actually ready.
    if (!teamCcReadyAt(cast.castTimeSeconds)) continue;
    candidates.push({ cast, windowEndT: toRenderSecond(span.to) });
  }
  return candidates
    .sort(
      (a, b) =>
        b.cast.cooldownSeconds - a.cast.cooldownSeconds ||
        a.cast.castTimeSeconds - b.cast.castTimeSeconds,
    )
    .slice(0, cap)
    .map(({ cast, windowEndT }) => {
      const t = toRenderSecond(cast.castTimeSeconds);
      return {
        id: `unsynced-burst:${cast.ownerName}:${cast.spellId}:${t}`,
        type: "unsynced-burst",
        t,
        unitNames: [cast.ownerName, ...healerNames],
        spell: cast.spellName,
        spellId: cast.spellId,
        facts: {
          t: String(t),
          windowEndT: String(windowEndT),
          owner: cast.ownerName,
          spell: cast.spellName,
          // §29b fix: the gate proves ALL enemy healers were free (see the
          // function doc comment), so the fact names the full set — same
          // "、"-joined convention missedSyncWindowEvents' readyCds uses,
          // not an arbitrary first match.
          healer: healerNames.join("、"),
        },
      };
    });
}

/** cd-hoarded (P2 起爆-1, 2026-08-15): minimum idle-then-late gap before a "CD
 * sat ready" claim is worth surfacing — a CD used a few seconds after
 * readiness is normal button-press latency, not hoarding. <标定定稿
 * 2026-08-15,报告 p1p2-calibration.md>: raised from the 20s placeholder to
 * 45s. Sensitivity grid (H∈{10,20,30,45}s × crisis HP∈{35,45}%, 210
 * matches/400 rounds swept) found EVERY cell in-band on 场均条数 (1.19–1.71,
 * comfortably inside the 0.5–2 target) but every cell's 发生率 (67.0–89.5%)
 * sat above this repo's highest prior candidate-type precedent (63.6%,
 * arenacoach batch-1's COOLDOWN class) — the grid's own strictest corner
 * (H45/C35, 67.0%) was the only one close to that ceiling, so it was picked
 * rather than a middle cell. 双向误差注: a shorter H (the 20s placeholder,
 * 88.5% at its paired C45) risks flooding the menu the way this file's own
 * MISSED_CLEANSE/MISSED_PURGE/CC_LOCKED/WASTED_TRINKET throttling block
 * (above) already documents as a real failure mode; a longer H than tested
 * would start excluding genuine hoards resolved just past the 45s mark,
 * understating the pattern. */
export const CD_HOARD_MIN_LATE_S = 45; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** cd-hoarded: the own-team HP floor a hoarded window's worst moment must
 * have crossed to count as a "crisis" happened during the hoard, not just
 * "someone took a scratch". Deliberately a separate number/constant from
 * `CD_WASTE_PRESSURE_HP_PCT` — that gate asks "was the WHOLE ROUND
 * pressured", this one asks "was THIS SPECIFIC hoarded window a crisis" —
 * same shape as the cd-waste/cd-hoarded split documented on
 * `THREAT_LEVEL_LOW_MIN_HP_PCT` in threatAssessment.ts. <标定定稿 2026-08-15,
 * 报告 p1p2-calibration.md>: lowered from the 45% placeholder to 35%,
 * paired with `CD_HOARD_MIN_LATE_S`'s own strictest-tested-corner choice
 * above (same sensitivity grid, see that constant's doc comment for the
 * full occurrence-rate citation). 双向误差注: a higher bar (45%, the
 * placeholder) admits moderate-pressure dips that are not really a
 * "crisis" as a hoarding crisis, pushing 发生率 up toward 88.5%; a bar
 * below 35% (untested) would start excluding real near-death windows that
 * bottomed out in the high-20s/low-30s rather than under 35, understating
 * the pattern the same direction as too-large an H. */
export const CD_HOARD_CRISIS_HP_PCT = 35; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** Per-match cap for cd-hoarded. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed adequate at its 2-per-round placeholder —
 * raw (pre-cap) counts routinely exceed 2 even at the tightened H45/C35
 * thresholds above, so the cap is doing real truncation work, not sitting
 * unused; kept at 2 to match every other per-round-capped type in this file
 * rather than inventing a type-specific number with no comparative
 * justification. */
const CD_HOARD_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** A single citable "crisis moment" inside a window: the worst HP% any
 * friendly reached, which friendly it was, and the rendered second it
 * happened on — cd-hoarded's fact needs a point to cite ("ally at 34% at
 * 6:30"), not just a floor value. */
export interface ICrisisMoment {
  t: number;
  unitName: string;
  hpPct: number;
}

/**
 * Worst HP% any friendly reached inside [fromSeconds, toSeconds], render-grid
 * sampled at every rendered second — same scan shape as `enemyMinHpPctInWindow`
 * (Task 2), mirrored onto the owner's own team and extended to carry back
 * WHICH unit and WHICH render second produced the worst reading (cd-hoarded's
 * crisis fact needs a citable moment, not just a number). Render-grid
 * discipline (CLAUDE.md): the caller must pass already-`toRenderSecond`-floored
 * `fromSeconds`/`toSeconds` (cd-hoarded's own `readyT`/`castT`) so the scanned
 * range can never disagree with the window shown in facts; this function
 * floors again defensively but that must be a no-op on an already-floored
 * input, never load-bearing. Returns null only when NO sample anywhere in the
 * window succeeded (no advanced logging) — the caller must treat null as
 * "cannot confirm a crisis happened", never as "0%".
 */
export function friendlyCrisisMomentInWindow(
  friends: any[],
  combat: { startTime: number },
  fromSeconds: number,
  toSeconds: number,
  hpLookup: (
    unit: any,
    timestampMs: number,
    maxDtMs: number,
  ) => number | null = getUnitHpAtTimestamp,
  /** GH #28: restrict the scan to ONE unit. cd-hoarded passes the owner's own
   *  name when the hoarded cooldown cannot help anybody else (Desperate Prayer
   *  heals the caster only), so a teammate's dip can never become the crisis
   *  that a self-heal is accused of ignoring. Absent = scan every friendly, the
   *  behaviour every other caller keeps. */
  onlyUnitName?: string,
): ICrisisMoment | null {
  const fromR = toRenderSecond(fromSeconds);
  const toR = toRenderSecond(toSeconds);
  const scanned =
    onlyUnitName === undefined
      ? friends
      : friends.filter((f) => f.name === onlyUnitName);
  let worst: ICrisisMoment | null = null;
  for (let t = fromR; t <= toR; t++) {
    for (const f of scanned) {
      const hp = hpLookup(f, combat.startTime + t * 1000, HP_SAMPLE_RADIUS_MS);
      if (hp === null) continue;
      if (worst === null || hp < worst.hpPct) {
        worst = { t, unitName: f.name, hpPct: hp };
      }
    }
  }
  return worst;
}

/**
 * cd-hoarded (P2 起爆-1, 2026-08-15, deep-dive-derived definition): a major
 * cooldown sat available (`IMajorCooldownInfo.availableWindows` — the
 * existing talent-corrected ledger, not recomputed here) for at least
 * `CD_HOARD_MIN_LATE_S` before it was actually pressed, AND a friendly
 * crossed below `CD_HOARD_CRISIS_HP_PCT` sometime during that same hoarded
 * window (60ab-AW shape: Avenging Wrath ready 6:20, an ally at 34% at 6:30,
 * not cast until 6:54 — the button sat on a crisis instead of answering it).
 *
 * Covers EVERY `availableWindows` entry, not just ones closed by a
 * subsequent cast (fix round 1, 2026-08-15 review — the spec text, 「大 CD
 * 转好后 ≥H 秒未按,且期间出现危机窗...→ 候选」, names no requirement of a
 * later cast). The original implementation only fired on windows closed by
 * an actual cast (`cd.casts` containing an entry at exactly `w.toSeconds`)
 * and excluded the trailing window that runs to match end with no further
 * cast, on the rationale that shape is `cd-waste`'s territory — that
 * rationale does not hold: `cd-waste` only gates on `cd.neverUsed`
 * (`casts.length === 0`, cooldowns.ts), so a CD cast once early and then
 * hoarded through a crisis to match end (`casts.length >= 1`, so
 * `neverUsed === false`) fell through BOTH types uncaught. Both shapes now
 * emit, distinguished in facts by `closedByCast`:
 *  - closed window: `castT` is the render second of the actual closing
 *    cast (still an exact-value match against `cd.casts`, not a tolerance
 *    comparison — `w.toSeconds` IS that cast's `timeSeconds`, no
 *    arithmetic in between).
 *  - trailing/unresolved window (`w.toSeconds === matchDurationSeconds`,
 *    no matching cast): `unresolved` carries the fact-not-prescription
 *    string "未再施放直至战斗结束" instead of `castT` — the button sat
 *    through the crisis and was never pressed again this match at all,
 *    arguably the worst form of the pattern this type names.
 * `lateS` means "how long the button sat idle" in both shapes — elapsed
 * ready-time to the closing cast, or elapsed ready-time to match end.
 *
 * cd-hoarded can fire on ANY major CD (offensive or defensive) — unlike
 * `cd-waste`/`cd-spent-idle`, hoarding a throughput CD like Avenging Wrath
 * during a crisis is exactly the shape this type exists to catch.
 *
 * Render-grid anchoring (CLAUDE.md): `readyT`/`endT` are floored via
 * `toRenderSecond` FIRST; `lateS` is derived from those floored endpoints
 * (never from the raw fractional `w.fromSeconds`/`w.toSeconds`), and the
 * floored endpoints — not the raw window — are what gets passed to
 * `probes.crisisMomentAt`, so the crisis this candidate cites can never fall
 * outside the window the facts display. This also means a CD that comes
 * ready in the match's final stretch, with less than `CD_HOARD_MIN_LATE_S`
 * left before `matchDurationSeconds`, is excluded by the SAME `lateS` gate
 * that governs closed windows — no separate "too close to the end" check is
 * needed, the floored-endpoint math already produces a small `lateS` for
 * that shape.
 *
 * `probes.crisisMomentAt` is wired to `friendlyCrisisMomentInWindow` in
 * production (kept as an injectable probe, same "no raw combat traversal
 * inside the pure mapper" shape every other builder in this file uses, e.g.
 * `missedSyncWindowEvents`'s `enemyMinHpPctAt`) — unlike that B8 accelerator,
 * this probe genuinely GATES the candidate (no confirmed crisis → no
 * candidate), so it must run before emission, not just annotate facts after.
 *
 * Cost-norm guard (#25 precedent, same as `cdWasteEvents`/
 * `deathUnusedDefensiveEvents`): a cost_norm ability (Divine Shield/Ice
 * Block) sitting ready through a crisis is not "you should have used it
 * sooner" — it's a last-resort tool being correctly saved. The fact still
 * carries `costNorm`; the prompt explains it.
 *
 * Severity/cap: sorted by `lateS` descending (the longer the button sat idle
 * through the crisis, the bigger the miss — unresolved windows count toward
 * the same cap as closed ones), capped at `CD_HOARD_CAP` (see that
 * constant's own doc comment for the 2026-08-15 corpus calibration).
 */
export function cdHoardedEvents(
  cds: (Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "casts" | "availableWindows"
  > &
    /** GH #28 层 4:调用方知道 tag 就传下来 —— 静态 classMetadata 之外还有
     *  运行时注入(终极苦修)和名字正则发现两条路会产生 Defensive CD,只按
     *  id 集合判断会把它们漏出门外。可选,缺省退回 id 集合。 */
    Partial<Pick<IMajorCooldownInfo, "tag">>)[],
  owner: { id: string; name: string },
  probes: {
    /** Wired to friendlyCrisisMomentInWindow in production. A real gate, not
     * an accelerator — see the doc comment above. */
    crisisMomentAt: (
      fromSeconds: number,
      toSeconds: number,
      /** GH #28: when set, only this unit's HP counts as a crisis (the
       *  cooldown in question cannot help anybody else). Production wires it
       *  straight to friendlyCrisisMomentInWindow's own parameter. */
      onlyUnitName?: string,
    ) => ICrisisMoment | null;
    /** #29 (2026-08-17): the owner's own successful-cast instants (seconds,
     * any spell — `owner.spellCastEvents` timestamps re-based to match
     * start), consumed only by `filterIntentGuardEvidence`'s gcd-locked
     * exclusion. Optional — absent skips that exclusion (graceful
     * degradation, same convention as `rawStreams?` itself). */
    ownCastSuccessSeconds?: number[];
  },
  // Calibration-only override (Task 5, packages/eval/src/explore/
  // candidateCalibration.ts): every field defaults to its module constant, so
  // every production call site (which passes no 4th arg) is byte-identical to
  // before this was added. Exists so the corpus threshold-sensitivity sweep
  // calls this REAL builder at swept values instead of a second,
  // drift-prone reimplementation (CLAUDE.md shared-predicate rule).
  overrides?: { minLateS?: number; crisisHpPct?: number; cap?: number },
  /**
   * Intent guard (BACKLOG #26 Task 2): optional, absent/`available:false` →
   * byte-identical to before this param existed (Global Constraint: raw
   * degradation is always silent). When present, each candidate's own
   * [readyT, endT] window — the SAME already-`toRenderSecond`-floored
   * instants used for `crisisMomentAt` and written into `facts.t`/`castT` —
   * is queried for `CAST_FAILED` hits on this exact `cd.spellId`; a hit means
   * the player did try to press it, so "hoarded" is downgraded from a clean
   * negligence claim to an attempted-but-rejected one (see `facts.attempted`
   * and auditFindings.ts's matching severity downgrade).
   */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  const minLateS = overrides?.minLateS ?? CD_HOARD_MIN_LATE_S;
  const crisisHpPct = overrides?.crisisHpPct ?? CD_HOARD_CRISIS_HP_PCT;
  const cap = overrides?.cap ?? CD_HOARD_CAP;
  const candidates: Array<{
    cd: (typeof cds)[number];
    readyT: number;
    endT: number;
    lateS: number;
    crisis: ICrisisMoment;
    closedByCast: boolean;
  }> = [];
  for (const cd of cds) {
    for (const w of cd.availableWindows) {
      const readyT = toRenderSecond(w.fromSeconds);
      const endT = toRenderSecond(w.toSeconds);
      const lateS = endT - readyT;
      if (lateS < minLateS) continue;
      // GH #28: a cooldown that cannot reach anybody else (Desperate Prayer,
      // Ice Block, Barkskin …) may only be accused of ignoring the OWNER's own
      // crisis. Before this gate the crisis probe scanned every friendly, so a
      // self-heal sitting unused while a TEAMMATE dipped to 13% produced
      // "你本该按绝望祷言" — mechanically impossible advice. Measured on 60
      // matches / 80 healer rounds: 15 such events, 0 after.
      const crisis = probes.crisisMomentAt(
        readyT,
        endT,
        canHelpAnotherUnit(cd.spellId, cd.tag) ? undefined : owner.name,
      );
      if (!crisis || crisis.hpPct >= crisisHpPct) continue;
      const closedByCast = cd.casts.some((c) => c.timeSeconds === w.toSeconds);
      candidates.push({ cd, readyT, endT, lateS, crisis, closedByCast });
    }
  }
  return candidates
    .sort((a, b) => b.lateS - a.lateS)
    .slice(0, cap)
    .map(({ cd, readyT, endT, lateS, crisis, closedByCast }) => {
      const costNorm = costNormPhrase(cd.spellId);
      // #29 (2026-08-17): raw hits are filtered through the shared
      // GCD-artifact exclusions before they count as "pressed but rejected"
      // — see filterIntentGuardEvidence's doc comment (shared.ts) for the
      // corpus numbers (96.9% of 尚未恢复 hits were GCD spam, and 37.4% of
      // guard-hit candidates carried nothing else).
      const failedHits = rawStreams
        ? filterIntentGuardEvidence(
            castFailedInWindow(
              rawStreams,
              owner.id,
              readyT,
              endT,
              Number(cd.spellId),
            ),
            cd.casts.map((cc) => cc.timeSeconds),
            { ownCastSuccessSeconds: probes.ownCastSuccessSeconds },
          )
        : [];
      const attempted = formatAttemptedFact(failedHits);
      return {
        id: `cd-hoarded:${owner.id}:${cd.spellId}:${readyT}`,
        type: "cd-hoarded",
        t: readyT,
        unitNames: [owner.name, crisis.unitName],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: String(readyT),
          lateS: String(lateS),
          spell: cd.spellName,
          unit: owner.name,
          crisisT: String(crisis.t),
          crisisUnit: crisis.unitName,
          crisisHpPct: fmt(crisis.hpPct),
          ...(closedByCast
            ? { castT: String(endT) }
            : { unresolved: "未再施放直至战斗结束" }),
          ...(costNorm ? { costNorm } : {}),
          ...(attempted ? { attempted } : {}),
        },
      };
    });
}

/** Per-match cap for cd-spent-idle. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — full-corpus scan
 * measured 场均条数(capped) only 0.14 (raw 0.15, essentially uncapped —
 * B6's red line already does almost all the limiting: 35.1% of rounds are
 * "low" threat and return `[]` before any cast is even probed), 发生率 just
 * 11.9%, the lowest of the four new types and well under every precedent.
 * 双向误差注: a lower cap has essentially no effect (raw already sits at
 * 0.15, nowhere near 2); a higher cap likewise has no effect for the same
 * reason — this type's volume is governed by the B6 threat gate, not by
 * this cap, so there is no evidence for moving it off the shared
 * per-round-cap default. */
const CD_SPENT_IDLE_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * cd-spent-idle (P2 起爆-2, 2026-08-15, deep-dive-derived definition): a
 * defensive/survival major cooldown was cast at a moment with no active
 * enemy threat (圣佑/Blessing-of-Sanctuary blind-cast shape: pressing a
 * survival tool into dead air instead of holding it for the next real
 * window).
 *
 * "Defensive/survival CD" identification follows the exact filter this
 * file's own `slowDefensiveResponseEvents` wiring already uses in
 * `teamPlayEvents` (`DEFENSIVE_TAGS.has(cd.tag) && !cd.isThroughput` —
 * `DEFENSIVE_TAGS` = Defensive ∪ External spell tags, cooldowns.ts) rather
 * than inventing a second definition of "defensive".
 *
 * Threat gate is `threatAssessment.ts`'s single-source predicates, consumed
 * (never re-implemented) via injected probes:
 *  - per-cast gate: `probes.threatActiveAt(t)` false at the (render-floored)
 *    cast instant → candidate; true → no candidate.
 *  - **Red line B6** (non-negotiable, user-ruled): if `matchThreat` — the
 *    caller's already-computed `matchThreatLevel(...)` for the whole match —
 *    is `"low"`, this function returns `[]` before even looking at any cast,
 *    and `probes.threatActiveAt` is never invoked (pinned by a dedicated
 *    spy test: in a low-threat match, using CDs on cooldown is correct play,
 *    not a coaching point).
 *
 * Render-grid anchoring (CLAUDE.md): the cast instant is floored via
 * `toRenderSecond` BEFORE it is used for the threat gate or written into
 * facts — the same instant must decide both, or the fact could disagree
 * with the gate that produced it.
 *
 * Cost-norm guard (#25 precedent, same as `cdHoardedEvents` above): a
 * cost_norm ability spent into a lull still carries `costNorm` in facts so
 * the prompt can explain the "last resort only" caveat rather than reading
 * as a routine "you cast into nothing" callout.
 *
 * Severity/cap: sorted chronologically (earliest idle spend first — no
 * damage-value data is wired in here, mirroring `unsyncedBurstEvents`'
 * documented no-new-CD-logic constraint), capped at `CD_SPENT_IDLE_CAP`
 * (see that constant's own doc comment for the 2026-08-15 corpus
 * calibration).
 */
export function cdSpentIdleEvents(
  cds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "tag" | "isThroughput" | "casts"
  >[],
  owner: { id: string; name: string },
  matchThreat: MatchThreatLevel,
  probes: {
    /** Wired to threatAssessment.ts's threatActiveAt in production. */
    threatActiveAt: (tSeconds: number) => boolean;
  },
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  if (matchThreat === "low") return []; // B6 red line — never even probes.
  const cap = overrides?.cap ?? CD_SPENT_IDLE_CAP;
  // GH #29 阶段 2b:这条指控是「你把**保命大 CD** 按在了没威胁的空气里」。
  // `!isThroughput` 只等于「不是 Offensive-tagged」,挡不住那些挂着 Defensive
  // 牌子、实为**治疗产出强化**的 CD —— 而产出 CD 本来就该在安全窗口 pump,
  // 那是正确操作,不是浪费。签字册 kind `throughput_role` 就是这一维的单源
  // (用户 2026-08-22 裁定:神圣显灵是治疗大技能;复仇十字军随专精,奶骑是
  // 主要治疗)。250 场 / 312 治疗轮实测:cd-spent-idle 46 → 43,去掉的 3 条
  // 全是复仇十字军;光环大师那 5 条**保留**(用户同日裁定 20% 全团减伤,
  // 已进 MITIGATION_OVERRIDES,它是真墙)。
  const defensiveCds = cds.filter(
    (cd) =>
      DEFENSIVE_TAGS.has(cd.tag) &&
      !cd.isThroughput &&
      !THROUGHPUT_EMPOWER_DEFENSIVE_IDS.has(cd.spellId),
  );
  const candidates: Array<{ cd: (typeof cds)[number]; t: number }> = [];
  for (const cd of defensiveCds) {
    for (const cast of cd.casts) {
      const t = toRenderSecond(cast.timeSeconds);
      if (probes.threatActiveAt(t)) continue;
      candidates.push({ cd, t });
    }
  }
  return candidates
    .sort((a, b) => a.t - b.t)
    .slice(0, cap)
    .map(({ cd, t }) => {
      const costNorm = costNormPhrase(cd.spellId);
      return {
        id: `cd-spent-idle:${owner.id}:${cd.spellId}:${t}`,
        type: "cd-spent-idle",
        t,
        unitNames: [owner.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: String(t),
          spell: cd.spellName,
          unit: owner.name,
          ...(costNorm ? { costNorm } : {}),
        },
      };
    });
}
