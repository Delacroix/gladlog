/**
 * Kill attempts, anchored on control flow (2026-08-18 redesign, user ruling:
 * "没有控制流的伤害基本没有任何意义" — damage without control is mostly
 * meaningless; only very high burst is an exception).
 *
 * This replaces the analysis UNIT, not just a threshold: the old "kill
 * window" (`computeOffensiveWindows`) is a long-lived STATE — "this enemy has
 * no major defensive up" — with a corpus median of 36s, 80.3% of windows
 * overlapping another enemy's and 37% fully covered by one (2026-08-18
 * measurement), which made every per-window exclusivity judgement
 * arithmetically self-contradictory. A kill attempt is an EVENT: a stun chain
 * landing on one target with real team damage behind it, lasting seconds.
 *
 * Anchor = STUNS ONLY, not "hard CC". Corpus validation (same day, 8,791
 * hard-CC landings): kills convert through stuns at 4.8% (prime tier) while
 * Incapacitate converts at 1.1% and Cyclone at 0.0% — breakable/
 * damage-immune CC is setup, not a kill window. See GH #16 tier-validation
 * report.
 *
 * Deliberately reused predicates (CLAUDE.md shared-predicate rule — every
 * number here is somebody else's established constant, none invented):
 *  - chain grouping: two stuns on the same target belong to one attempt iff
 *    they belong to one DR chain — `drResetMsAt` (era-aware 16s/20s), the
 *    same window `getDRLevel` walks;
 *  - "real damage behind it": `KW_BURST_MIN_DAMAGE` (30k), offensiveWindows'
 *    existing "qualifies as a kill attempt" floor;
 *  - kill credit: death within `KILL_CREDIT_SLACK_S` (5s) after the span —
 *    burstLedger's existing credit slack;
 *  - opportunity tier at attempt start: `killOpportunityAt` (the corpus-
 *    validated three-tier model, single source in killWindowTargetSelection).
 *
 * Failure attribution answers "this attempt did NOT convert — why", from
 * flags observable inside the span. `defensivePopped` / `externalReceived` /
 * `outhealed` are exactly the facts the 2026-08-18 tier validation showed to
 * be REVERSE-causal as prospective signals (already-active DR converts at
 * 8.4%, the highest of any cut, because it marks a kill already in progress)
 * — they belong here, after the fact, and must never migrate into the
 * opportunity tier.
 *
 * v1 scope: stun-anchored attempts only. The user's second path for
 * attempt-hood — "no control but very high burst" (ruling: 看大技能使用 或者看
 * dps事后的分布) — needs its own grounding pass for the burst bar and is NOT
 * implemented; a no-stun kill therefore produces no attempt record here.
 */
import {
  IArenaMatch,
  ICombatUnit,
  IShuffleRound,
  LogEvent,
} from "@gladlog/parser-compat";

import { MITIGATION_TABLE } from "../data/mitigationData";
import spellIdListsData from "../data/spellIdLists";

import { analyzeOutgoingCCChains, drResetMsAt, DRLevel } from "./drAnalysis";
import { KILL_CREDIT_SLACK_S } from "./burstLedger";
import { KW_BURST_MIN_DAMAGE } from "./offensiveWindows";
import {
  IKillOpportunity,
  killOpportunityAt,
  PVP_TRINKET_SPELL_IDS,
  STUN_USABLE_MIT_IDS,
} from "./killWindowTargetSelection";

const EXTERNAL_DEF_IDS = new Set<string>(
  (spellIdListsData as unknown as { externalDefensiveSpellIds?: string[] })
    .externalDefensiveSpellIds ?? [],
);

/** Immunities in the official table are recorded as pct 100 (spec decision in
 * mitigationData.ts). Baiting one out is a WIN per the user ruling ("冰箱圣盾
 * 不管,交了也算我们赚") — so it is its own attribution, never a reproach. */
const IMMUNITY_IDS = new Set<string>(
  Object.entries(MITIGATION_TABLE)
    .filter(([, e]) => e.pct === 100)
    .map(([id]) => id),
);

/** 20–99% self-mitigation aura ids (the non-immune official table slice) —
 * "the target popped a real defensive during the attempt". */
const MITIGATION_AURA_IDS = new Set<string>(
  Object.entries(MITIGATION_TABLE)
    .filter(([, e]) => e.pct >= 20 && e.pct < 100)
    .map(([id]) => id),
);

export interface IKillAttemptStun {
  atSeconds: number;
  durationSeconds: number;
  spellName: string;
  casterName: string;
  drLevel: DRLevel;
}

/** Why a non-converted attempt failed. Flags are independently observable;
 * `primary` picks the first true one in declaration order (trinket beats
 * defensive beats external beats healing), `"pressure"` is the residual —
 * nothing visible saved the target, the damage simply wasn't enough. */
export interface IKillAttemptAttribution {
  trinketed: boolean;
  immunityBaited: boolean;
  defensivePopped: string[];
  externalReceived: string[];
  outhealed: boolean;
  primary:
    | "trinketed"
    | "immunity-baited"
    | "defensive"
    | "external"
    | "outhealed"
    | "pressure";
}

export interface IKillAttempt {
  targetUnitId: string;
  targetName: string;
  /** First stun landing → last stun expiry. */
  fromSeconds: number;
  toSeconds: number;
  stuns: IKillAttemptStun[];
  /** Opportunity tier of the target when the attempt STARTED (prospective —
   * the corpus-validated model; see killOpportunityAt). */
  opportunity: IKillOpportunity;
  /** DR level of the opening stun (Full = the chain started clean). */
  openingDrLevel: DRLevel;
  /** Team damage inside [from, to + KILL_CREDIT_SLACK_S]. */
  teamDamageToTarget: number;
  teamDamageTotal: number;
  /** 0–100: share of team damage that landed on the attempt's target. */
  teamOnTargetPct: number;
  killed: boolean;
  /** Present exactly when !killed. */
  attribution?: IKillAttemptAttribution;
}

interface StunApp {
  atSeconds: number;
  durationSeconds: number;
  spellName: string;
  casterName: string;
  drLevel: DRLevel;
}

/**
 * Extracts stun-anchored kill attempts. `friendlies` are the attackers,
 * `enemies` the potential targets — pass them exactly as the other
 * `analyzeOutgoingCCChains` product call sites do.
 */
export function extractKillAttempts(
  friendlies: ICombatUnit[],
  enemies: ICombatUnit[],
  combat: IArenaMatch | IShuffleRound,
): IKillAttempt[] {
  const matchStartMs = combat.startTime;
  const chainGapS = drResetMsAt(matchStartMs) / 1000;
  const enemyByName = new Map(enemies.map((e) => [e.name, e]));

  // 1) Stun landings per target (Full/50% only — an Immune landing has no
  //    duration and anchors nothing).
  const stunsByTarget = new Map<string, StunApp[]>();
  for (const chain of analyzeOutgoingCCChains(friendlies, enemies, combat)) {
    if (!enemyByName.has(chain.targetName)) continue;
    for (const app of chain.applications) {
      if (app.drInfo.category !== "Stun") continue;
      if (app.drInfo.level !== "Full" && app.drInfo.level !== "50%") continue;
      const arr = stunsByTarget.get(chain.targetName) ?? [];
      arr.push({
        atSeconds: app.atSeconds,
        durationSeconds: app.durationSeconds,
        spellName: app.spellName,
        casterName: app.casterName,
        drLevel: app.drInfo.level,
      });
      stunsByTarget.set(chain.targetName, arr);
    }
  }

  const attempts: IKillAttempt[] = [];
  for (const [targetName, stuns] of stunsByTarget) {
    const target = enemyByName.get(targetName)!;
    stuns.sort((a, b) => a.atSeconds - b.atSeconds);

    // 2) Group into DR chains: next stun joins the attempt iff it starts
    //    within the DR reset window of the previous stun's end — the exact
    //    walk getDRLevel does, so "one attempt" can never disagree with
    //    "one DR chain".
    const groups: StunApp[][] = [];
    for (const stun of stuns) {
      const cur = groups[groups.length - 1];
      const prevEnd = cur
        ? cur[cur.length - 1].atSeconds + cur[cur.length - 1].durationSeconds
        : -Infinity;
      if (cur && stun.atSeconds - prevEnd < chainGapS) cur.push(stun);
      else groups.push([stun]);
    }

    for (const group of groups) {
      const fromSeconds = group[0].atSeconds;
      const last = group[group.length - 1];
      const toSeconds = Math.max(
        last.atSeconds + last.durationSeconds,
        fromSeconds,
      );
      const spanFromMs = matchStartMs + fromSeconds * 1000;
      const spanToMs = matchStartMs + (toSeconds + KILL_CREDIT_SLACK_S) * 1000;

      // 3) Team damage inside the span (target + all enemies, one pass).
      let teamDamageToTarget = 0;
      let teamDamageTotal = 0;
      const enemyIds = new Set(enemies.map((e) => e.id));
      for (const f of friendlies) {
        for (const d of f.damageOut) {
          const ts = d.logLine.timestamp;
          if (ts < spanFromMs || ts > spanToMs) continue;
          if (!enemyIds.has(d.destUnitId)) continue;
          const amount = Math.abs(d.effectiveAmount);
          teamDamageTotal += amount;
          if (d.destUnitId === target.id) teamDamageToTarget += amount;
        }
      }
      // CC without real damage behind it is peel/setup, not a kill attempt —
      // same floor offensiveWindows uses for its burst sub-windows.
      if (teamDamageToTarget < KW_BURST_MIN_DAMAGE) continue;

      const killed = target.deathRecords.some((rec) => {
        const t = rec.timestamp;
        return t >= spanFromMs && t <= spanToMs;
      });

      const attempt: IKillAttempt = {
        targetUnitId: target.id,
        targetName,
        fromSeconds,
        toSeconds,
        stuns: group,
        opportunity: killOpportunityAt(target, fromSeconds, matchStartMs),
        openingDrLevel: group[0].drLevel,
        teamDamageToTarget,
        teamDamageTotal,
        teamOnTargetPct:
          teamDamageTotal > 0
            ? Math.round((100 * teamDamageToTarget) / teamDamageTotal)
            : 0,
        killed,
      };
      if (!killed) {
        attempt.attribution = attributeFailure(
          target,
          enemies,
          spanFromMs,
          spanToMs,
        );
      }
      attempts.push(attempt);
    }
  }
  attempts.sort((a, b) => a.fromSeconds - b.fromSeconds);
  return attempts;
}

function attributeFailure(
  target: ICombatUnit,
  enemies: ICombatUnit[],
  spanFromMs: number,
  spanToMs: number,
): IKillAttemptAttribution {
  const inSpan = (ts: number): boolean => ts >= spanFromMs && ts <= spanToMs;

  let trinketed = false;
  for (const cast of target.spellCastEvents) {
    if (cast.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
    if (!cast.spellId || !PVP_TRINKET_SPELL_IDS.has(cast.spellId)) continue;
    if (inSpan(cast.logLine.timestamp)) {
      trinketed = true;
      break;
    }
  }

  let immunityBaited = false;
  const defensivePopped: string[] = [];
  for (const aura of target.auraEvents) {
    if (aura.destUnitId !== target.id) continue;
    if ((aura.logLine.event as string) !== LogEvent.SPELL_AURA_APPLIED)
      continue;
    if (!aura.spellId || !inSpan(aura.logLine.timestamp)) continue;
    if (IMMUNITY_IDS.has(aura.spellId)) immunityBaited = true;
    // The stun-usable subset is called out by name — those are the cards the
    // gated tier told the coach to bait; seeing one here closes that loop.
    if (
      MITIGATION_AURA_IDS.has(aura.spellId) ||
      STUN_USABLE_MIT_IDS.has(aura.spellId)
    ) {
      defensivePopped.push(aura.spellName ?? aura.spellId);
    }
  }

  const externalReceived: string[] = [];
  for (const mate of enemies) {
    if (mate.id === target.id) continue;
    for (const cast of mate.spellCastEvents) {
      if (cast.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
      if (!cast.spellId || !EXTERNAL_DEF_IDS.has(cast.spellId)) continue;
      if (cast.destUnitId !== target.id) continue;
      if (inSpan(cast.logLine.timestamp)) {
        externalReceived.push(cast.spellName ?? cast.spellId);
      }
    }
  }

  let healedIn = 0;
  for (const h of target.healIn) {
    if (inSpan(h.logLine.timestamp)) healedIn += Math.abs(h.effectiveAmount);
  }
  let damageIn = 0;
  for (const d of target.damageIn) {
    if (inSpan(d.logLine.timestamp)) damageIn += Math.abs(d.effectiveAmount);
  }
  const outhealed = healedIn > damageIn;

  const primary: IKillAttemptAttribution["primary"] = trinketed
    ? "trinketed"
    : immunityBaited
      ? "immunity-baited"
      : defensivePopped.length > 0
        ? "defensive"
        : externalReceived.length > 0
          ? "external"
          : outhealed
            ? "outhealed"
            : "pressure";

  return {
    trinketed,
    immunityBaited,
    defensivePopped,
    externalReceived,
    outhealed,
    primary,
  };
}
