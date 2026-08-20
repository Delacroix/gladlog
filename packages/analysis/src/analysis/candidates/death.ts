/**
 * Death-anchored candidate producers — the precursor chain (`death-setup`),
 * `death-unused-defensive`, `external-unused` and `questionable-external`.
 *
 * Split out of `candidateFindings.ts` on 2026-08-16 (mechanical split by
 * theme); logic moved verbatim. These four share the death window and the
 * free-to-act predicates, which is why they travel together.
 */
import { DEATH_CC_LOOKBACK_S } from "../../context/criticalMoments";
import { lastCastBefore } from "../../context/timelineHelpers";
import { costNormPhrase } from "../../data/curatedAbilityFacts";
import {
  cdAvailableAt,
  FORBEARANCE_GATED_IDS,
  selfForbearanceActiveAt,
  SELF_CAST_NOOP_EXTERNAL_IDS,
  USABLE_WHILE_CC_SPELL_IDS,
  type IMajorCooldownInfo,
} from "../../utils/cooldowns";
import { isStunCcInstance } from "../../utils/drAnalysis";
import { castFailedInWindow, type RawStreams } from "../../utils/rawStreams";
import { fmtFactNum as fmt } from "../factFormat";
import { CandidateEvent } from "../types";
import { filterIntentGuardEvidence, formatAttemptedFact } from "./shared";

/** death-setup: maximum lookback (seconds) from a death to a precursor event —
 * resource spends earlier than this are too causally weak for that death. */
export const DEATH_SETUP_LOOKBACK_S = 90;
/** death-setup: minimum healer CC duration (seconds) — a short incapacitate
 * does not make the kill window unhealable. */
const HEALER_LOCK_MIN_S = 3;
/** Max precursor events attached to one death (priority: healer-locked >
 * trinket-early > defensive-early). */
const SETUPS_PER_DEATH = 2;

export interface DeathSetupParts {
  deathT: number;
  victim: { id: string; name: string };
  /** The victim's CC/trinket summary (the relevant slice of
   * analyzePlayerCCAndTrinket). */
  victimCC?: {
    ccInstances: Array<{
      atSeconds: number;
      durationSeconds: number;
      spellName: string;
      trinketState: string;
      /** DR category of this CC instance (e.g. "Stun"/"Incapacitate"/
       * "Disorient"/…), when known — same field as ICCInstance.drInfo.category
       * (DR_CATEGORIES_GENERATED, shared-predicate rule). Used by
       * deathUnusedDefensiveEvents to gate the USABLE_WHILE_CC_SPELL_IDS check
       * (finding #1, 2026-08-14 final review): that table is stunned-only —
       * a non-stun CC active at death must exempt unconditionally rather than
       * being checked against it. Optional/nullable so hand-built test
       * fixtures without DR data still type-check (absence reads as "not
       * stun", the conservative direction). */
      drInfo?: { category: string } | null;
    }>;
    trinketUseTimes: number[];
  };
  /** The victim's major cooldowns (extractMajorCooldowns). */
  victimCDs?: Array<
    Pick<
      IMajorCooldownInfo,
      | "spellId"
      | "spellName"
      | "tag"
      | "cooldownSeconds"
      | "casts"
      | "neverUsed"
    >
  >;
  /** CC summary for the friendly healer (when the healer is not the victim). */
  healerCC?: {
    healerName: string;
    ccInstances: Array<{
      atSeconds: number;
      durationSeconds: number;
      /** Optional: real callers pass an ICCInstance that carries the id; test
       * fixtures may omit it (it only feeds the icon). */
      spellId?: string;
      spellName: string;
      sourceName: string;
    }>;
  };
}

/**
 * death-setup candidates (reasoning chain): trace a friendly death back to an
 * earlier precursor moment, giving the model a citable "other end of the
 * chain". Pure function (unit-testable with hand-built fixtures); every
 * verdict mirrors the existing predicates of buildDeathRootCauseTrace:
 *  - healer-locked: healer CC covers the DEATH_CC_LOOKBACK_S window before the
 *    death (same window constant);
 *  - trinket-early: the victim was CC'd inside the death window with
 *    trinketState=on_cooldown (the trace's CC row); the precursor moment is
 *    the earlier trinket press;
 *  - defensive-early: a victim's major defensive was ON COOLDOWN at death and
 *    its last use was labeled Early by the timing audit (the trace's
 *    [last use: EARLY] row); the precursor moment is that cast.
 */
export function deathSetupEvents(parts: DeathSetupParts): CandidateEvent[] {
  const { deathT, victim } = parts;
  const out: CandidateEvent[] = [];
  const inWindow = (cc: { atSeconds: number; durationSeconds: number }) =>
    cc.atSeconds <= deathT &&
    cc.atSeconds + cc.durationSeconds >= deathT - DEATH_CC_LOOKBACK_S;

  // healer-locked: healer was CC'd for >=3s inside the kill window, starting
  // before the moment of death
  const lock = parts.healerCC?.ccInstances.find(
    (cc) =>
      inWindow(cc) &&
      cc.durationSeconds >= HEALER_LOCK_MIN_S &&
      cc.atSeconds < deathT,
  );
  if (lock) {
    out.push({
      id: `death-setup:${victim.id}:${Math.round(deathT)}:healer-locked`,
      type: "death-setup",
      t: lock.atSeconds,
      unitNames: [parts.healerCC!.healerName, victim.name],
      spell: lock.spellName,
      spellId: lock.spellId,
      facts: {
        t: fmt(lock.atSeconds),
        kind: "healer-locked",
        deathT: fmt(deathT),
        victim: victim.name,
        healer: parts.healerCC!.healerName,
        cc: lock.spellName,
        duration: lock.durationSeconds.toFixed(1),
      },
    });
  }

  // trinket-early: CC'd inside the death window with the trinket on cooldown;
  // the precursor is that earlier trinket press
  const deadInCC = parts.victimCC?.ccInstances.find(
    (cc) => inWindow(cc) && cc.trinketState === "on_cooldown",
  );
  if (deadInCC) {
    const trinketT = [...(parts.victimCC?.trinketUseTimes ?? [])]
      .filter(
        (t) => t < deadInCC.atSeconds && t >= deathT - DEATH_SETUP_LOOKBACK_S,
      )
      .pop();
    if (trinketT !== undefined) {
      out.push({
        id: `death-setup:${victim.id}:${Math.round(deathT)}:trinket-early`,
        type: "death-setup",
        t: trinketT,
        unitNames: [victim.name],
        facts: {
          t: fmt(trinketT),
          kind: "trinket-early",
          deathT: fmt(deathT),
          victim: victim.name,
          ccAtDeath: deadInCC.spellName,
          gapS: fmt(deathT - trinketT),
        },
      });
    }
  }

  // defensive-early: ON COOLDOWN at death and its last use was labeled Early
  // by the timing audit
  for (const cd of parts.victimCDs ?? []) {
    if (cd.tag !== "Defensive" || cd.neverUsed) continue;
    const last = lastCastBefore(cd as IMajorCooldownInfo, deathT);
    if (!last) continue;
    // available at death → this is not a "spent it too early" chain
    if (cdAvailableAt(cd as IMajorCooldownInfo, deathT)) continue;
    if (last.timingLabel !== "Early") continue;
    if (last.timeSeconds < deathT - DEATH_SETUP_LOOKBACK_S) continue;
    out.push({
      id: `death-setup:${victim.id}:${Math.round(deathT)}:defensive-early`,
      type: "death-setup",
      t: last.timeSeconds,
      unitNames: [victim.name],
      spell: cd.spellName,
      spellId: cd.spellId,
      facts: {
        t: fmt(last.timeSeconds),
        kind: "defensive-early",
        deathT: fmt(deathT),
        victim: victim.name,
        spell: cd.spellName,
        gapS: fmt(deathT - last.timeSeconds),
      },
    });
    // at most one defensive-early per death (take the first matching wall)
    break;
  }

  return out.slice(0, SETUPS_PER_DEATH);
}

/** Max number of available survival abilities listed in a death's facts. */
const UNUSED_DEFENSIVE_MAX_LISTED = 3;

/**
 * death-unused-defensive: the owner died with a survival ability available and
 * never pressed it (arenacoach DEATH-001 predicate, same thresholds). "Free"
 * verdict: not in CC at the moment of death, or in CC but with the trinket
 * usable (available_unused/available), or the ability is castable while CC'd
 * (USABLE_WHILE_CC_SPELL_IDS). Divine Shield-class abilities do not count as
 * available during Forbearance.
 */
export function deathUnusedDefensiveEvents(
  parts: DeathSetupParts,
  victim: { isOwner: boolean; unit?: any },
  combat?: any,
  /**
   * Intent guard (BACKLOG #26 Task 2): optional, absent/`available:false` →
   * byte-identical to before this param existed. For each listed wall, the
   * window queried is [the wall's own most-recent-cast-before-death +
   * cooldownSeconds (or 0 if never cast), deathT] — the same "available
   * since" instant the `walls` filter above already established via
   * `cdAvailableAt`, so the query window can never disagree with why the
   * wall was already counted as available.
   */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  if (!victim.isOwner) return [];
  // When victimCC is absent (summary not computable) we must NOT default to
  // "not in CC" — that would wrongly land freeState on "yes" and falsely blame
  // a death that may well have happened under CC. Better to emit nothing than
  // to blame falsely.
  if (!parts.victimCC) return [];
  const { deathT } = parts;
  const ccAtDeath = parts.victimCC.ccInstances.find(
    (cc) =>
      cc.atSeconds <= deathT && cc.atSeconds + cc.durationSeconds >= deathT,
  );
  const freeState = !ccAtDeath
    ? "yes"
    : ccAtDeath.trinketState === "available_unused"
      ? "trinket_in_hand"
      : null; // in CC and the trinket is not actively usable
  // (passive_trinket/used/on_cooldown): not free overall, and only
  // USABLE_WHILE_CC abilities are exempt, and only when the CC active at
  // death is itself Stun-category (finding #1, 2026-08-14 final review):
  // USABLE_WHILE_CC_SPELL_IDS is a stunned-only table (DB2's "usable while
  // stunned" attribute), so a Fear/Disorient/Incapacitate at death must
  // exempt unconditionally rather than being checked against it — see
  // wasLockedOutByStunOnly (deathOutcomeAnalysis.ts) for the fuller story
  // behind the same fix applied there for the windowed lockout case.
  const ccAtDeathIsStunOnly = !!ccAtDeath && isStunCcInstance(ccAtDeath);

  // selfForbearanceActiveAt needs the whole-match unit list and matchStartMs —
  // derived from the same source as units/start in extractCandidateFindings
  // (see the top of that function).
  const allUnits: any[] = combat ? Object.values(combat.units ?? {}) : [];
  const matchStartMs: number = combat?.startTime ?? 0;

  const walls = (parts.victimCDs ?? []).filter((cd) => {
    if (cd.tag !== "Defensive") return false;
    if ((cd as IMajorCooldownInfo).isThroughput) return false;
    if (!cdAvailableAt(cd as IMajorCooldownInfo, deathT)) return false;
    if (freeState === null) {
      if (!ccAtDeathIsStunOnly) return false;
      if (!USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId)) return false;
    }
    if (
      FORBEARANCE_GATED_IDS.has(cd.spellId) &&
      victim.unit &&
      combat &&
      selfForbearanceActiveAt(victim.unit, allUnits, deathT, matchStartMs)
    )
      return false;
    // A damage-redirect external self-cast is a mechanical no-op (Blessing of
    // Sacrifice transfers damage TO the caster), so it is not a wall this
    // player could have pressed to survive. Shares the set with the prompt's
    // death line and with cooldowns.ts's "cheaper available" guard.
    if (SELF_CAST_NOOP_EXTERNAL_IDS.has(cd.spellId)) return false;
    return true;
  });
  if (walls.length === 0) return [];
  const listedWalls = walls.slice(0, UNUSED_DEFENSIVE_MAX_LISTED);
  // Cost-norm guard (#25, 2026-08-14): the first listed wall that is a
  // signed-off cost_norm ability (Divine Shield/Ice Block) supplies the
  // caveat — "off cooldown and unused" reads exactly like "you should have
  // pressed it" bait for an ability whose real cost rule is "last resort
  // only". Same precedent as missed-cleanse's ownerCanDispel gate: the fact
  // carries the guard, buildFindingsPrompt explains the field.
  const costNorm = listedWalls
    .map((w) => costNormPhrase(w.spellId))
    .find((phrase): phrase is string => phrase !== null);
  // Intent guard (BACKLOG #26 Task 2): per listed wall, "available since" is
  // its own most-recent cast before death + its cooldown (0 if never cast) —
  // the same instant that made `cdAvailableAt` accept it into `walls` above,
  // so this can never disagree with why the wall counts as available. Hits
  // across all listed walls are pooled into one `attempted` fact (the
  // candidate is one-per-death, not one-per-wall).
  // #29 (2026-08-17): raw hits are filtered through the shared GCD-artifact
  // exclusions before they count as "pressed but rejected" — see
  // filterIntentGuardEvidence's doc comment (shared.ts). The gcd-locked
  // exclusion consumes the victim's own successful-cast instants, derived
  // from the same `victim.unit`/`matchStartMs` pair the Forbearance check
  // above already threads; when the caller passes no unit (older call
  // shapes), the exclusion silently no-ops, same convention as `rawStreams?`.
  const ownCastSuccessSeconds: number[] | undefined = victim.unit
    ? (victim.unit.spellCastEvents ?? []).map(
        (e: any) => (e.timestamp - matchStartMs) / 1000,
      )
    : undefined;
  const failedHits = rawStreams
    ? listedWalls.flatMap((w) => {
        const lastCast = [...w.casts]
          .filter((c) => c.timeSeconds <= deathT)
          .pop();
        const fromS = Math.max(
          0,
          lastCast ? lastCast.timeSeconds + w.cooldownSeconds : 0,
        );
        return filterIntentGuardEvidence(
          castFailedInWindow(
            rawStreams,
            parts.victim.id,
            fromS,
            deathT,
            Number(w.spellId),
          ),
          w.casts.map((c) => c.timeSeconds),
          { ownCastSuccessSeconds },
        );
      })
    : [];
  const attempted = formatAttemptedFact(failedHits);
  return [
    {
      id: `death-unused-defensive:${parts.victim.id}:${Math.round(deathT)}`,
      type: "death-unused-defensive",
      t: deathT,
      unitNames: [parts.victim.name],
      facts: {
        t: fmt(deathT),
        unit: parts.victim.name,
        walls: listedWalls.map((w) => w.spellName).join(", "),
        free: freeState ?? "usable_in_cc",
        ...(costNorm ? { costNorm } : {}),
        ...(attempted ? { attempted } : {}),
      },
    },
  ];
}

/** external-unused: lookback window before the death (seconds) and the owner's
 * minimum free gap (seconds). Threshold provenance: arenacoach DEATH-003's
 * "you were free to cast it" (the 1.5s reaction allowance matches theirs
 * site-wide); the 5s window is the near-end sub-window of
 * DEATH_CC_LOOKBACK_S. */
// 2026-08-20 接地登记(GH #16,用户裁定保留):171 次可指控死亡实测,
// free-gap p50=3.9s、1.5–2.5s 边界带仅 9.9%(1.5 线不承重);窗宽敏感性
// 3s→62.6% / 5s→69.6% / 8s→87.1% 指控率 —— 以死亡为锚无法用结果选窗
// (循环),5/1.5 居中稳健,维持。数字在 issue #16 的三小件接地评论。
export const EXTERNAL_FREE_WINDOW_S = 5;
export const EXTERNAL_FREE_MIN_GAP_S = 1.5;

/**
 * external-unused: a teammate died while the owner (usually the healer) had an
 * external damage reduction available (the isAllyCastableDefensive whitelist)
 * and never gave it (arenacoach DEATH-003). "Owner was free" verdict: within
 * the EXTERNAL_FREE_WINDOW_S seconds before the death, after subtracting CC
 * coverage there was still a contiguous gap of >=EXTERNAL_FREE_MIN_GAP_S
 * seconds — purely a reaction-time allowance; the owner is not expected to
 * press exactly at the moment of death. If the owner was already dead at that
 * point (e.g. a double death), nothing is reported.
 */
export function externalUnusedEvents(input: {
  deathT: number;
  victim: { id: string; name: string };
  owner: { id: string; name: string };
  ownerExternals: Array<
    Pick<
      IMajorCooldownInfo,
      "spellId" | "spellName" | "cooldownSeconds" | "casts" | "neverUsed"
    >
  >;
  ownerCC: Array<{ atSeconds: number; durationSeconds: number }>;
  ownerAliveAt: (t: number) => boolean;
}): CandidateEvent[] {
  const { deathT, victim, owner } = input;
  if (!input.ownerAliveAt(deathT)) return [];

  // Owner's free gap: the largest contiguous gap left in the window
  // [deathT-5, deathT] after subtracting CC coverage
  const from = Math.max(0, deathT - EXTERNAL_FREE_WINDOW_S);
  const covers = input.ownerCC
    .map((c) => [c.atSeconds, c.atSeconds + c.durationSeconds] as const)
    .filter(([a, b]) => b > from && a < deathT)
    .sort((a, b) => a[0] - b[0]);
  let cursor = from;
  let maxGap = 0;
  for (const [a, b] of covers) {
    maxGap = Math.max(maxGap, a - cursor);
    cursor = Math.max(cursor, b);
  }
  maxGap = Math.max(maxGap, deathT - cursor);
  if (maxGap < EXTERNAL_FREE_MIN_GAP_S) return [];

  const avail = input.ownerExternals.find((cd) => cdAvailableAt(cd, deathT));
  if (!avail) return [];
  return [
    {
      id: `external-unused:${owner.id}:${victim.id}:${Math.round(deathT)}`,
      type: "external-unused",
      t: deathT,
      unitNames: [owner.name, victim.name],
      spell: avail.spellName,
      spellId: avail.spellId,
      facts: {
        t: fmt(deathT),
        victim: victim.name,
        owner: owner.name,
        external: avail.spellName,
        freeGapS: fmt(maxGap),
      },
    },
  ];
}

/**
 * questionable-external (17a): the consumer of annotateDefensiveTimings' sixth
 * tier ("Unnecessary") — an external (EXTERNAL_DEFENSIVE_IDS /
 * isAllyCastableDefensive whitelist) handed out in a no-pressure window
 * (target at high HP + no damage spike + no burst alignment; all three
 * conditions are already decided inside annotate, so here we only filter on
 * timingLabel). For the corpus-measured occurrence rate see the task-3 report
 * (the pre-gate numbers).
 * Filed under category "cooldowns"; NOT in OFFENSIVE_CANDIDATE_TYPES
 * (deepDive.ts), so it routes to survival by default — "spending what you
 * should have saved" is a survival-discipline issue, not an offensive one.
 *
 * nearestBurstGapS is read straight off cast.nearestBurstGapS —
 * annotateDefensiveTimings already computed it while deciding Unnecessary,
 * holding enemyCDTimeline.alignedBurstWindows; we do not re-derive the window
 * geometry here (single-source predicate).
 */
export function questionableExternalEvents(
  cds: Pick<IMajorCooldownInfo, "spellId" | "spellName" | "casts">[],
  caster: { id: string; name: string },
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  for (const cd of cds) {
    for (const cast of cd.casts) {
      if (cast.timingLabel !== "Unnecessary") continue;
      const t = cast.timeSeconds;
      out.push({
        id: `questionable-external:${caster.id}:${Math.round(t)}`,
        type: "questionable-external",
        t,
        unitNames: [caster.name, cast.targetName ?? caster.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: fmt(t),
          spell: cd.spellName,
          caster: caster.name,
          target: cast.targetName ?? caster.name,
          targetHp:
            cast.targetHpPct !== undefined ? fmt(cast.targetHpPct) : "n/a",
          nearestBurstGapS:
            cast.nearestBurstGapS !== undefined
              ? fmt(cast.nearestBurstGapS)
              : "n/a",
        },
      });
    }
  }
  return out;
}
