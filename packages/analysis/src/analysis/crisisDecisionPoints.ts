/**
 * Crisis decision points — the ONE predicate behind `crisis-no-response`
 * (candidates/crisisNoResponse.ts) and the behavior-prior corpus scan
 * (packages/eval/scripts/behaviorPriorScan.ts). Both sides must consume this
 * module: the product says "you did not respond", the table says "top-10%
 * players respond X% here" — same crossing, same window, same response
 * taxonomy, or the two numbers are not comparable (CLAUDE.md shared-predicate
 * rule). Changing anything in here REQUIRES regenerating
 * data/behaviorPriorGenerated.json (spec §2 red line).
 *
 * Design: docs/superpowers/specs/2026-08-29-crisis-no-response-design.md.
 * Evidence: eval-private/reports/behavior-prior-2026-08-28/ (18,134 matches).
 */
import { LogEvent } from "@gladlog/parser-compat";

import { classMetadata } from "../data/classSpells";
import { spellClassMap } from "../data/drCategories";
import spellIdLists from "../data/spellIdLists";
import {
  ccSpellIds,
  rootSpellIds,
  spells as spellMeta,
} from "../data/spellTags";
import { SpellTag } from "../data/spellTypes";
import { buildFilteredAuraIntervals } from "../utils/utils";

/** A friendly at or below this HP fraction opens a "crisis" (moved here from
 * packages/eval/src/explore/signalSkillGradient.ts, which now re-exports). */
export const CRISIS_HP_PCT = 0.4;
/** Two crossings closer than this belong to the same crisis. */
export const CRISIS_WINDOW_GAP_MS = 5000;
/** The response window after the crossing — user-ruled 3 s (2026-08-29). */
export const RESPONSE_WINDOW_MS = 3000;
/** A response landed just before the sampled crossing still counts. */
export const RESPONSE_PRE_MS = 1500;
export const DMG_WINDOW_MS = 2000;
export const ENEMY_BURST_LOOKBACK_MS = 8000;
/** Gate 2: an interrupt landing on the owner this close before the crossing
 * means the school is locked — handed to `kick-eaten`, never double-charged. */
export const LOCKOUT_LOOKBACK_MS = 1500;
export const SELF_HEAL_BIG = 0.15;
export const KITE_GAIN_YARDS = 8;
/** Gate 5 (spec §1b, user ruling 2026-08-29): a crossing below this 2s-damage
 * floor doesn't die at a different rate whether the player responded or not
 * (measured: <10% dmg2s died 8.8% unresponded vs 7.8% responded — no
 * gradient; ≥10% died 22–23%). Below the floor, the point is not "dangerous"
 * and never fires the product candidate, and never enters the reference
 * table either — both sides apply this gate, same predicate. */
export const CRISIS_MIN_DMG2S = 0.1;
/** Table-only outcome window (spec §1b): did the owner die within this many
 * ms after the crossing? The producer (candidates/crisisNoResponse.ts) must
 * NEVER read `diedWithin10s` — only the reference-table builder
 * (packages/eval/src/explore/behaviorPriorTable.ts) does. */
export const DEATH_LOOKAHEAD_MS = 10_000;
/** Table-only outcome window (spec §1c, Solo Shuffle only): did ANY friendly
 * player — same `reaction` as the owner, owner included — have a
 * `deathRecords` entry within this many ms after the crossing? A healer
 * diving to 40% in Solo Shuffle usually isn't the kill target (measured:
 * healer-death ÷ crossing is 0.11 in Solo vs 0.29 in 3v3); the cost lands on
 * a teammate instead, so the reference-table builder counts the whole team
 * for Solo cells. The producer (candidates/crisisNoResponse.ts) must NEVER
 * read `friendDiedWithin15s` — only the reference-table builder
 * (packages/eval/src/explore/behaviorPriorTable.ts) does. */
export const TEAM_DEATH_LOOKAHEAD_MS = 15_000;
const POS_TOLERANCE_MS = 1500;
const ATTACKER_POS_TOLERANCE_MS = 2500;

export interface DecisionPointResponses {
  selfHeal: boolean;
  wall: boolean;
  external: boolean;
  control: boolean;
  peel: boolean;
  kite: boolean;
}
export interface DecisionPoint {
  tMs: number;
  tSec: number;
  hpPct: number;
  dmg2s: number;
  attackers2s: number;
  enemyBurst: boolean;
  inCC: boolean;
  lockedOut: boolean;
  diedInWindow: boolean;
  responses: DecisionPointResponses;
  /** owner's own active answer: selfHeal ∨ wall ∨ external ∨ control ∨ kite
   * (peel is a teammate's action — rendered, never credited to the owner) */
  responded: boolean;
  selfHealPct: number;
  /** gates 1, 2 and 4 all pass (gate 3, "has a tool", is trivially true for a
   * healer — v1 is healer-only, spec §2) */
  feasible: boolean;
  /** gate 5: dmg2s >= CRISIS_MIN_DMG2S (spec §1b). Independent of `feasible`
   * — a point can be dangerous but infeasible (e.g. CC'd), or feasible but
   * not dangerous (low damage). The product fires on feasible && dangerous. */
  dangerous: boolean;
  /** OUTCOME — for the reference table only (packages/eval's
   * behaviorPriorTable.ts). The producer must never read this field. */
  diedWithin10s: boolean;
  /** OUTCOME (spec §1c, Solo Shuffle) — for the reference table only
   * (packages/eval's behaviorPriorTable.ts). The producer must never read
   * this field. */
  friendDiedWithin15s: boolean;
}

const PERSONAL_WALL_IDS = new Set<string>(
  spellIdLists.bigDefensiveSpellIds.map(String),
);
const EXTERNAL_IDS = new Set<string>(
  spellIdLists.externalDefensiveSpellIds.map(String),
);
const OFFENSIVE_CD_IDS = new Set<string>(
  classMetadata.flatMap((c: any) =>
    (c.abilities ?? [])
      .filter((a: any) => (a.tags ?? []).includes(SpellTag.Offensive))
      .map((a: any) => String(a.spellId)),
  ),
);
/** hand-typed `interrupts` set (spellTags) — shared by CONTROL_IDS ("owner
 * used an interrupt on an enemy") and SILENCE_IDS ("owner is silenced") so
 * the filter is computed once, not twice. */
const INTERRUPT_IDS = new Set<string>(
  Object.entries(spellMeta)
    .filter(([, m]) => m.type === "interrupts")
    .map(([id]) => id),
);
/** "stop the damage" tools the owner can point at an enemy */
const CONTROL_IDS = new Set<string>([
  ...ccSpellIds,
  ...rootSpellIds,
  ...INTERRUPT_IDS,
]);
// C1 (2026-08-29): the hand-typed `interrupts` set alone covered 3/61 of the
// official DR `silence` category (measured) — Strangulate 47476,
// Garrote-Silence 1330, 356727, 374776 are all observed in the corpus and
// were uncovered, so a silenced healer read as `lockedOut=false`. Union in
// the official category exactly the way spellTags.ts builds
// `officialHardCcIds`: sourced from data/drCategories (not utils/drAnalysis
// — that module imports spellTags, which would cycle).
const OFFICIAL_SILENCE_IDS =
  (spellClassMap.diminishingReturns as Record<string, { spellId: string }[]>)[
    "silence"
  ]?.map((e) => e.spellId) ?? [];
/** silence-type auras also lock the school: hand `interrupts` type
 * (spellTags) ∪ official DR `silence` category. */
const SILENCE_IDS = new Set<string>([
  ...INTERRUPT_IDS,
  ...OFFICIAL_SILENCE_IDS,
]);

interface Sample {
  t: number;
  hp: number;
  max: number;
  x: number | null;
  y: number | null;
}

/** Resolve a damage source to the player id it should be attributed to: the
 * unit itself if it's a player (`info` present), else its owning player if
 * it's a pet/guardian (`unit.ownerId` → owner has `info`), else `null` for
 * environment/unknown sources. Measured 2026-08-29: a 3-enemy Solo Shuffle
 * round rendered "from 15 attackers" — 13 of the 15 raw damage sources were
 * one demonology warlock's imps/hounds, not distinct enemy players. */
function resolveAttackerId(
  src: string,
  unitById: Map<string, any>,
): string | null {
  const u = unitById.get(src);
  if (u?.info) return src;
  if (u?.ownerId) {
    const owner = unitById.get(u.ownerId);
    if (owner?.info) return u.ownerId;
  }
  return null;
}

function samplesOf(u: any): Sample[] {
  return ((u?.advancedActions ?? []) as any[])
    .filter((a) => (a.advancedActorMaxHp ?? 0) > 0)
    .map((a) => ({
      t: a.timestamp,
      hp: a.advancedActorCurrentHp / a.advancedActorMaxHp,
      max: a.advancedActorMaxHp,
      x: a.advancedActorPositionX ?? null,
      y: a.advancedActorPositionY ?? null,
    }))
    .sort((a, b) => a.t - b.t);
}

function nearestSample(
  samples: Sample[],
  t: number,
  tol: number,
): Sample | null {
  let best: Sample | null = null;
  for (const s of samples) {
    const d = Math.abs(s.t - t);
    if (d <= tol && (!best || d < Math.abs(best.t - t))) best = s;
  }
  return best;
}

export function crisisDecisionPoints(owner: any, combat: any): DecisionPoint[] {
  const start: number = combat?.startTime ?? 0;
  const samples = samplesOf(owner);
  if (samples.length < 2) return [];

  const crossings: Sample[] = [];
  let last = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!,
      c = samples[i]!;
    if (p.hp > CRISIS_HP_PCT && c.hp <= CRISIS_HP_PCT && c.hp > 0) {
      if (c.t - last > CRISIS_WINDOW_GAP_MS) crossings.push(c);
      last = c.t;
    }
  }
  if (!crossings.length) return [];

  const units: any[] = Object.values(combat?.units ?? {});
  const players = units.filter((u) => u.info);
  const friendIds = new Set(
    players.filter((u) => u.reaction === owner.reaction).map((u) => u.id),
  );
  // Spec §1c: Solo Shuffle's outcome cells count ANY friendly death, owner
  // included — so this collects deathRecords across every friendly player,
  // not just the owner's own (which `deaths` below still does, for
  // diedInWindow / diedWithin10s).
  const friendDeaths: number[] = [];
  for (const u of players) {
    if (!friendIds.has(u.id)) continue;
    for (const d of (u.deathRecords ?? []) as any[]) {
      friendDeaths.push(d.timestamp as number);
    }
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const enemySamples = new Map<string, Sample[]>();

  const dmgIn = ((owner.damageIn ?? []) as any[]).map((d) => ({
    t: d.timestamp,
    src: d.srcUnitId,
    a: Math.abs(d.effectiveAmount ?? d.amount ?? 0),
  }));
  const healIn = ((owner.healIn ?? []) as any[]).map((h) => ({
    t: h.timestamp,
    src: h.srcUnitId,
    a: Math.abs(h.effectiveAmount ?? h.amount ?? 0),
  }));
  const ownerCasts = ((owner.spellCastEvents ?? []) as any[]).map((c) => ({
    t: c.timestamp,
    id: String(c.spellId ?? ""),
    dest: c.destUnitId,
  }));
  const deaths = ((owner.deathRecords ?? []) as any[]).map(
    (d) => d.timestamp as number,
  );
  const interruptsOnOwner = ((owner.actionIn ?? []) as any[])
    .filter((a) => a.logLine?.event === LogEvent.SPELL_INTERRUPT)
    .map((a) => a.timestamp as number);

  // enemy hard-CC and silence intervals on the owner. I2 (2026-08-29): pairing
  // lives only in auraIntervals.ts's buildAuraIntervals (CLAUDE.md
  // shared-predicate rule) — it handles APPLIED_DOSE, SPELL_AURA_BROKEN,
  // orphan REMOVED (aura already up at round start, backdated by official
  // duration), and the official-duration cap for an aura that never closes,
  // none of which the old hand-rolled APPLIED/REMOVED pairing here did.
  // buildFilteredAuraIntervals (utils/utils.ts) is the ms-shaped thin adapter
  // over it, already used by candidateFindings.ts's burst-ledger path.
  const cc = buildFilteredAuraIntervals(owner, ccSpellIds, combat);
  const silence = buildFilteredAuraIntervals(owner, SILENCE_IDS, combat);

  const enemyBurstCasts: number[] = [];
  const friendControlCasts: { t: number; dest: string }[] = [];
  for (const u of players) {
    for (const c of (u.spellCastEvents ?? []) as any[]) {
      const sid = String(c.spellId ?? "");
      if (!friendIds.has(u.id) && OFFENSIVE_CD_IDS.has(sid))
        enemyBurstCasts.push(c.timestamp);
      if (friendIds.has(u.id) && u.id !== owner.id && CONTROL_IDS.has(sid))
        friendControlCasts.push({ t: c.timestamp, dest: c.destUnitId });
    }
  }

  const out: DecisionPoint[] = [];
  for (const x of crossings) {
    const t = x.t;
    const w0 = t - RESPONSE_PRE_MS,
      w1 = t + RESPONSE_WINDOW_MS;
    const inWin = (tt: number) => tt >= w0 && tt <= w1;
    const recent = dmgIn.filter((d) => d.t > t - DMG_WINDOW_MS && d.t <= t);
    const attackers = new Set(
      recent
        .map((d) => resolveAttackerId(d.src, unitById))
        .filter((id): id is string => id != null),
    );
    const dmg2s = recent.reduce((n, d) => n + d.a, 0) / x.max;
    // Round before comparing against the floor — the rounded value is what
    // gets rendered (facts.dmg2sPct), so `dangerous` must agree with it.
    const dmg2sRounded = Math.round(dmg2s * 100) / 100;
    const dangerous = dmg2sRounded >= CRISIS_MIN_DMG2S;
    const castsIn = ownerCasts.filter((c) => inWin(c.t));
    const selfHeal =
      healIn
        .filter((h) => h.t > t && h.t <= w1 && h.src === owner.id)
        .reduce((n, h) => n + h.a, 0) / x.max;

    let kite = false;
    const p0 = nearestSample(samples, t, POS_TOLERANCE_MS),
      p1 = nearestSample(samples, w1, POS_TOLERANCE_MS);
    if (p0?.x != null && p1?.x != null && attackers.size) {
      const near = (p: Sample, tt: number) => {
        let m = Infinity;
        for (const id of attackers) {
          const u = unitById.get(id);
          if (!u) continue;
          if (!enemySamples.has(id)) enemySamples.set(id, samplesOf(u));
          const q = nearestSample(
            enemySamples.get(id)!,
            tt,
            ATTACKER_POS_TOLERANCE_MS,
          );
          if (q?.x != null)
            m = Math.min(m, Math.hypot(p.x! - q.x, p.y! - q.y!));
        }
        return m;
      };
      const d0 = near(p0, t),
        d1 = near(p1, w1);
      kite = isFinite(d0) && isFinite(d1) && d1 - d0 >= KITE_GAIN_YARDS;
    }

    const responses: DecisionPointResponses = {
      selfHeal: selfHeal >= SELF_HEAL_BIG,
      wall: castsIn.some((c) => PERSONAL_WALL_IDS.has(c.id)),
      external: castsIn.some((c) => EXTERNAL_IDS.has(c.id)),
      control: castsIn.some(
        (c) => CONTROL_IDS.has(c.id) && c.dest && !friendIds.has(c.dest),
      ),
      peel: friendControlCasts.some((c) => inWin(c.t) && attackers.has(c.dest)),
      kite,
    };
    const inCC = cc.some((i) => i.startMs <= t && i.endMs >= t);
    const lockedOut =
      interruptsOnOwner.some(
        (it) => it >= t - LOCKOUT_LOOKBACK_MS && it <= t,
      ) || silence.some((i) => i.startMs <= t && i.endMs >= t);
    const diedInWindow = deaths.some((d) => d >= t && d < w1);
    // Table-only outcome (spec §1b): a death strictly after t, within
    // DEATH_LOOKAHEAD_MS. `(t, t+10000]` — t itself is excluded (that's
    // diedInWindow's job at a shorter horizon), the far edge is inclusive.
    const diedWithin10s = deaths.some(
      (d) => d > t && d <= t + DEATH_LOOKAHEAD_MS,
    );
    // Table-only outcome (spec §1c): same (t, t+…] shape as diedWithin10s,
    // wider horizon, and across every friendly player instead of just the
    // owner.
    const friendDiedWithin15s = friendDeaths.some(
      (d) => d > t && d <= t + TEAM_DEATH_LOOKAHEAD_MS,
    );
    const responded =
      responses.selfHeal ||
      responses.wall ||
      responses.external ||
      responses.control ||
      responses.kite;
    out.push({
      tMs: t,
      tSec: (t - start) / 1000,
      hpPct: Math.round(x.hp * 100),
      dmg2s: dmg2sRounded,
      attackers2s: attackers.size,
      enemyBurst: enemyBurstCasts.some(
        (b) => b > t - ENEMY_BURST_LOOKBACK_MS && b <= t,
      ),
      inCC,
      lockedOut,
      diedInWindow,
      dangerous,
      diedWithin10s,
      friendDiedWithin15s,
      responses,
      responded,
      selfHealPct: Math.round(selfHeal * 100),
      feasible: !inCC && !lockedOut && !diedInWindow,
    });
  }
  return out;
}
