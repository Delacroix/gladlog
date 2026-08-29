/**
 * crisis-no-response — "your HP crossed ≤40% while taking dangerous damage
 * (gate 5: dmg2s >= CRISIS_MIN_DMG2S), you were free to act, and you did
 * nothing for 3 s". Replaces the hindsight framing of death-unused-defensive
 * ("the wall was ready") with the one behaviour that actually separates
 * outcomes in the corpus: acting at all. Task 10 / spec §1b (2026-08-29
 * amendment, after the value gate): the reference cited is OUTCOME-based
 * (how often did NOT/DID responders die within 10 s), never rank-based — the
 * producer must never read `diedWithin10s` itself, only
 * data/behaviorPrior.ts's pre-aggregated reference. The model may cite these
 * numbers, never prescribe from them.
 * Spec: docs/superpowers/specs/2026-08-29-crisis-no-response-design.md.
 */
import type { BehaviorPriorRef } from "../../data/behaviorPrior";
import type { DecisionPoint } from "../crisisDecisionPoints";
import { fmtFactNum as fmt } from "../factFormat";
import type { CandidateEvent } from "../types";

export const CRISIS_NO_RESPONSE_CAP = 2;

export function crisisNoResponseEvents(
  points: DecisionPoint[],
  owner: { id: string; name: string },
  bracket: string,
  probes: { lookup: (dmg2s: number) => BehaviorPriorRef | null },
  overrides?: { cap?: number },
): CandidateEvent[] {
  const cap = overrides?.cap ?? CRISIS_NO_RESPONSE_CAP;
  const eligible = points.filter(
    (p) => p.feasible && p.dangerous && !p.responded,
  );
  // danger order — enemyBurst, then attackers, then damage; NEVER outcome
  const ranked = [...eligible].sort(
    (a, b) =>
      Number(b.enemyBurst) - Number(a.enemyBurst) ||
      b.attackers2s - a.attackers2s ||
      b.dmg2s - a.dmg2s,
  );
  const out: CandidateEvent[] = [];
  for (const p of ranked.slice(0, cap)) {
    const ref = probes.lookup(p.dmg2s);
    if (!ref) continue; // no baseline → no accusation
    out.push({
      id: `crisis-no-response:${owner.id}:${Math.round(p.tSec)}`,
      type: "crisis-no-response",
      t: p.tSec,
      unitNames: [owner.name],
      facts: {
        t: fmt(p.tSec),
        unit: owner.name,
        hpPct: String(p.hpPct),
        dmg2sPct: String(Math.round(p.dmg2s * 100)),
        attackers: String(p.attackers2s),
        burst: p.enemyBurst ? "yes" : "no",
        refNNoResp: String(ref.nNoResp),
        refDeathNoResp: String(ref.deathNoRespPct),
        refNResp: String(ref.nResp),
        refDeathResp: String(ref.deathRespPct),
        refTop: ref.top.map(([k, v]) => `${k} ${v}%`).join("; "), // "; " — ", " is the facts separator the gate splits on
        cellKey: ref.cellKey,
        fellBack: ref.fellBack ? "yes" : "no",
      },
    });
  }
  // Selection above is by danger; the emitted array is in time order, like
  // every sibling producer in candidates/ (spec §4) — the danger sort only
  // decides which ≤cap points survive, not the order they are reported in.
  return out.sort((a, b) => a.t - b.t);
}
