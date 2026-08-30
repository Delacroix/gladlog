/**
 * Enemy-burst-window decision points — GH #60 phase 1 (engine + reference
 * table only; nothing here is wired into the product yet).
 *
 * The shape is deliberately the same pipeline as `crisisDecisionPoints.ts`
 * (decision point → responses → feasibility gate → table-only outcomes), for
 * the same reason: the product's future "you had no answer to this burst" and
 * the corpus reference's "how often does a team that answered still lose
 * someone here" must be the SAME window, the SAME response taxonomy and the
 * SAME feasibility gate, or the two numbers are not comparable (CLAUDE.md
 * shared-predicate rule).
 *
 * The decision point is the START of an enemy burst window. Windows come from
 * the existing builder (`utils/enemyCDs.ts` → `reconstructEnemyCDTimeline`,
 * whose `alignedBurstWindows` is the one place that decides what an enemy
 * burst is), then get **bounded per exchange** here: GH #60 coarse spot 3 —
 * the builder's groups are unbounded (corpus p50 21.6 s) because a cast within
 * `BURST_CLUSTER_SECONDS` of ANY earlier group cast keeps extending the group,
 * so "inside the window" spans several exchanges. `boundBurstWindow` cuts a
 * group wherever pressure lapses (no enemy offensive CD buff running AND
 * incoming damage under a floor, for `BURST_LAPSE_SECONDS` consecutive
 * seconds) and re-qualifies each piece with the builder's own qualification
 * rule.
 *
 * Render-grid discipline (CLAUDE.md): every HP number this module produces
 * comes from `gridHpPct` — the `[STATE]` tick's own sampler — read at WHOLE
 * seconds, and never at a second `isDeadAtRenderSecond` says the unit did not
 * live to see. `tSec`/`endSec` are the seconds `fmtTime` will display.
 */
import { type ICombatUnit } from "@gladlog/parser-compat";

import { HEALING_VERDICTS } from "../data/healingVerdicts";
import { getEnglishSpellName } from "../data/spellEffectData";
import spellIdLists from "../data/spellIdLists";
import {
  ccSpellIds,
  rootSpellIds,
  spells as spellMeta,
} from "../data/spellTags";
import {
  cdAvailableAt,
  extractMajorCooldowns,
  gridHpPct,
  type IMajorCooldownInfo,
  isDeadAtRenderSecond,
  isProcOnlyActivation,
  specToString,
  TEAM_HEAL_CD_IDS,
} from "../utils/cooldowns";
import {
  type IAlignedBurstWindow,
  type IEnemyCDTimeline,
  reconstructEnemyCDTimeline,
  SOLO_WINDOW_MIN_WEIGHT,
} from "../utils/enemyCDs";
import { spellDangerWeight } from "../utils/spellDanger";
import { buildFilteredAuraIntervals } from "../utils/utils";
import { kitedAway } from "./crisisDecisionPoints";

/** How long after the window start any friendly may answer and still count
 * (GH #60's agreed shape: "response = within 8 s of window start, by ANY
 * friendly"). Also the minimum outcome horizon — see `outcomeEndSec`. */
export const BURST_RESPONSE_WINDOW_MS = 8000;
export const BURST_RESPONSE_WINDOW_SEC = BURST_RESPONSE_WINDOW_MS / 1000;
/** A wall pressed just BEFORE the enemy's first offensive cast is a pre-wall,
 * not a non-response; the same allowance `crisisDecisionPoints` gives a
 * response that lands just before the sampled crossing (`RESPONSE_PRE_MS`),
 * kept numerically identical on purpose — two decision-point engines that
 * disagree about "how early still counts" would produce two different response
 * rates for the same log. */
export const BURST_RESPONSE_PRE_MS = 1500;
/** Consecutive lapsed seconds that end a burst window. */
export const BURST_LAPSE_SECONDS = 3;
/**
 * A second counts as "pressure" when the friendly team took at least this
 * fraction of a health bar in it (summed over friendlies, each normalised by
 * its own max HP, so the floor is bracket- and gear-independent). A second
 * carrying one of the window's own casts always counts.
 *
 * **The literal GH #60 wording — "no enemy offensive CD buff is active AND no
 * enemy damage ≥ floor" — was measured to be a no-op** and is deliberately not
 * what this implements. 605 archived 12.1 matches, 2,627 builder windows
 * (`eval-private/reports/burst-window-2026-08-31/lapse-sweep.md`): with the
 * CD-buff term ORed in, the bounded distribution is p50 20 s / p90 33 s —
 * identical to the unbounded builder's own p50 20 s / p90 33 s, across the
 * whole 4×4 grid of floors and lapse lengths. The reason is structural: the
 * builder's window ENDS at the last buff end, so "a buff is still running" is
 * true for essentially every second inside it (the median window is one 20 s
 * offensive CD), and no 3-second lapse can ever open.
 *
 * Dropping the CD-buff term makes the bounding a damage predicate, which is
 * also the coaching semantic — a 20 s buff that stopped landing damage at
 * second 8 is over as an EXCHANGE at second 8. Sweep at lapse 3 s:
 * 1% → p50 17 s, 2% → 16 s, 3% → 15 s, 5% → 10 s (window count moves only
 * 2,672 → 2,771, so the cuts trim quiet tails rather than split bursts).
 * 3% is taken: it brings the p50 down 20 s → 15 s while keeping the window
 * comfortably longer than the 8 s response horizon it is judged against —
 * at 5% half the windows are shorter than that horizon and "the window" and
 * "the response window" stop being distinguishable objects.
 */
export const BURST_LAPSE_DMG_PCT_PER_S = 0.03;

export interface BurstWindowResponses {
  /** a friendly pressed a personal wall (`bigDefensiveSpellIds`) */
  wall: boolean;
  /** a friendly pressed an external (`externalDefensiveSpellIds`) */
  external: boolean;
  /** a friendly pressed a major healing cooldown (`BURST_HEAL_CD_IDS`) */
  healCd: boolean;
  /** a friendly aimed hard CC / a root / an interrupt AT one of the burst's
   * own casters (dest = caster) */
  control: boolean;
  /** the most-pressured friendly opened `KITE_GAIN_YARDS` on the nearest
   * burst caster across the response window */
  kite: boolean;
}

export interface BurstCdRef {
  spellId: string;
  spellName: string;
  casterName: string;
  casterSpec: string;
  castSec: number;
}

export interface BurstResponseCast {
  category: "wall" | "external" | "healCd" | "control";
  spellId: string;
  spellName: string;
  casterName: string;
  /** whole second the cast lands on (the second `fmtTime` displays) */
  tSec: number;
  /** seconds after the window start; may be negative down to
   * `-BURST_RESPONSE_PRE_MS/1000` (a pre-wall) */
  latencySec: number;
}

export interface BurstFriendlyOutcome {
  unitId: string;
  name: string;
  /** min `gridHpPct` over the window's whole seconds, skipping seconds the
   * unit was already dead at; null when no sample is in reach */
  minHpPct: number | null;
  /** the whole second `minHpPct` was read at */
  minHpSec: number | null;
  died: boolean;
}

export interface BurstWindowDecisionPoint {
  /** window start re-anchored on the render grid: `startTime + tSec * 1000` */
  tMs: number;
  /** WHOLE seconds since round start — what `fmtTime` displays */
  tSec: number;
  /** last whole second of the bounded window */
  endSec: number;
  /** `endSec - tSec` (rendered seconds, never raw) */
  durationSec: number;
  /** the CD that OPENED the window (earliest cast; a same-second tie goes to
   * the heavier `spellDangerWeight`) */
  leadCd: BurstCdRef;
  /** every other CD inside the window, cast order */
  extraCds: BurstCdRef[];
  /** unit ids of the enemies who cast this window's CDs */
  casterIds: string[];
  responses: BurstWindowResponses;
  responded: boolean;
  /** latency of the FIRST response cast, seconds after `tSec`; null when the
   * only response was a kite (no cast instant) or there was none */
  firstResponseSec: number | null;
  responseCasts: BurstResponseCast[];
  /** Value-Gate rule 3: at least one friendly had a relevant tool off
   * cooldown at `tSec` and was not hard-CC'd for the whole response window. */
  feasible: boolean;
  /** names of the friendlies that satisfied the gate (empty ⇒ !feasible) */
  feasibleUnits: string[];
  // ── OUTCOMES — reference table only. The product producer must NEVER read
  // these four fields (same red line as crisisDecisionPoints' diedWithin10s).
  /** any friendly `deathRecords` entry inside the outcome horizon */
  anyFriendlyDeath: boolean;
  deathsInWindow: number;
  /** the lowest `minHpPct` across friendlies */
  minFriendlyHpPct: number | null;
  friendlyOutcomes: BurstFriendlyOutcome[];
}

/** The outcome fields the producer must not read. Exported so a test can pin
 * the list rather than trusting the comment above it. */
export const BURST_OUTCOME_FIELDS = [
  "anyFriendlyDeath",
  "deathsInWindow",
  "minFriendlyHpPct",
  "friendlyOutcomes",
] as const;

const PERSONAL_WALL_IDS = new Set<string>(
  spellIdLists.bigDefensiveSpellIds.map(String),
);
const EXTERNAL_IDS = new Set<string>(
  spellIdLists.externalDefensiveSpellIds.map(String),
);
/**
 * "A major healing cooldown" — composed from two tables that are ALREADY
 * hand-maintained and already registered in `data/curatedIdRegistry.ts`
 * (`TEAM_HEAL_CD_IDS` and `HEALING_VERDICTS`), rather than a third hand list:
 * the Curated-List Completeness Rule's cost is per list, and a new one here
 * would need its own rot scan for no new information. The `HEALING_VERDICTS`
 * half is filtered to the user-signed `burst-answer` verdict — the register's
 * own question is literally "爆发已经打在脸上,按这个技能算不算一个答案", which
 * is exactly this module's question — and to entries whose official facts say
 * they heal somebody (a pure immunity is already a `wall` here).
 */
export const BURST_HEAL_CD_IDS = new Set<string>([
  ...TEAM_HEAL_CD_IDS,
  ...Object.entries(HEALING_VERDICTS)
    .filter(
      ([, v]) =>
        v.verdict === "burst-answer" &&
        (v.official.healsSelf || v.official.healsOthers),
    )
    .map(([id]) => id),
]);

const INTERRUPT_IDS = new Set<string>(
  Object.entries(spellMeta)
    .filter(([, m]) => m.type === "interrupts")
    .map(([id]) => id),
);
/** "stop the caster" tools — same union crisisDecisionPoints uses for its own
 * `control` response. */
const CONTROL_IDS = new Set<string>([
  ...ccSpellIds,
  ...rootSpellIds,
  ...INTERRUPT_IDS,
]);

export interface BoundedSegment {
  fromSeconds: number;
  toSeconds: number;
  casts: IAlignedBurstWindow["activeCDs"];
}

/** cast key into the per-player offensive-CD ledger (buff end + cooldown) */
const castKey = (playerName: string, spellId: string, castSeconds: number) =>
  `${playerName}|${spellId}|${castSeconds}`;

interface CastFacts {
  buffEndSeconds: number;
  cooldownSeconds: number;
}

function castFactsOf(timeline: IEnemyCDTimeline): Map<string, CastFacts> {
  const out = new Map<string, CastFacts>();
  for (const p of timeline.players)
    for (const cd of p.offensiveCDs)
      out.set(castKey(p.playerName, cd.spellId, cd.castTimeSeconds), {
        buffEndSeconds: cd.buffEndSeconds,
        cooldownSeconds: cd.cooldownSeconds,
      });
  return out;
}

/** `spellDangerWeight` of a cast, 0 when the ledger has no cooldown for it. */
function weightOf(
  c: IAlignedBurstWindow["activeCDs"][number],
  facts: Map<string, CastFacts>,
): number {
  const f = facts.get(castKey(c.playerName, c.spellId, c.castSeconds));
  return f ? spellDangerWeight(c.spellId, f.cooldownSeconds) : 0;
}

/**
 * Cut one unbounded builder window into per-exchange pieces.
 *
 * `dmgPctPerSec[s]` is the friendly team's incoming damage during whole second
 * `s`, as a sum of per-unit fractions of max HP. A second is "pressured" when
 * one of the window's own CD buffs is still running in it, or that damage
 * reaches `BURST_LAPSE_DMG_PCT_PER_S`. `BURST_LAPSE_SECONDS` consecutive
 * unpressured seconds close the current piece; the next cast opens a new one.
 *
 * Exported for the corpus scan's window-length sweep and for the unit tests —
 * the bounding rule is the thing GH #60 changes, so it is testable on its own.
 */
export function boundBurstWindow(
  window: IAlignedBurstWindow,
  facts: Map<string, CastFacts>,
  dmgPctPerSec: Map<number, number>,
  opts: {
    lapseSeconds?: number;
    dmgFloor?: number;
    cdBuffIsPressure?: boolean;
  } = {},
): BoundedSegment[] {
  const lapseSeconds = opts.lapseSeconds ?? BURST_LAPSE_SECONDS;
  const dmgFloor = opts.dmgFloor ?? BURST_LAPSE_DMG_PCT_PER_S;
  const cdBuffIsPressure = opts.cdBuffIsPressure ?? false;
  const casts = [...window.activeCDs].sort(
    (a, b) => a.castSeconds - b.castSeconds,
  );
  if (!casts.length) return [];

  const buffEnd = (c: IAlignedBurstWindow["activeCDs"][number]) =>
    facts.get(castKey(c.playerName, c.spellId, c.castSeconds))
      ?.buffEndSeconds ?? c.castSeconds;

  const segments: BoundedSegment[] = [];
  let current: IAlignedBurstWindow["activeCDs"][number][] = [];
  let lapse = 0;
  let nextCast = 0;
  let lastPressured = -Infinity;
  const lastSec = Math.ceil(
    Math.max(window.toSeconds, casts[casts.length - 1]!.castSeconds),
  );
  const flush = () => {
    if (!current.length) return;
    const from = current[0]!.castSeconds;
    // The piece ends when its own CDs' buffs do, but never after the pressure
    // did: a 20 s offensive buff that stopped landing damage at second 8 is
    // over as an EXCHANGE at second 8, and the outcome horizon must not keep
    // collecting deaths through the quiet tail.
    const to = Math.max(
      from,
      Math.min(Math.max(...current.map(buffEnd)), lastPressured),
    );
    segments.push({ fromSeconds: from, toSeconds: to, casts: current });
    current = [];
  };

  for (let s = Math.floor(casts[0]!.castSeconds); s <= lastSec; s++) {
    // casts landing in second s join the current piece (and reopen one)
    let opened = false;
    while (nextCast < casts.length && casts[nextCast]!.castSeconds < s + 1) {
      current.push(casts[nextCast]!);
      nextCast++;
      opened = true;
    }
    const cdActive =
      cdBuffIsPressure &&
      current.some((c) => c.castSeconds <= s + 1 && buffEnd(c) >= s);
    const pressured =
      opened || cdActive || (dmgPctPerSec.get(s) ?? 0) >= dmgFloor;
    if (pressured) {
      lapse = 0;
      if (current.length) lastPressured = s;
    } else {
      lapse++;
      if (lapse >= lapseSeconds) {
        flush();
        lapse = 0;
      }
    }
  }
  flush();
  return segments;
}

/** The builder's own qualification rule, re-applied to a bounded piece: 2+
 * CDs, or one CD heavy enough to be a solo kill window. */
function qualifies(
  seg: BoundedSegment,
  facts: Map<string, CastFacts>,
): boolean {
  return (
    seg.casts.length >= 2 ||
    seg.casts.some((c) => weightOf(c, facts) >= SOLO_WINDOW_MIN_WEIGHT)
  );
}

function maxHpOf(u: any): number {
  let m = 0;
  for (const a of (u?.advancedActions ?? []) as any[])
    if ((a.advancedActorMaxHp ?? 0) > m) m = a.advancedActorMaxHp;
  return m;
}

/** friendly incoming damage per whole second, as a sum of per-unit fractions
 * of that unit's own max HP */
function damagePctPerSecond(
  friendlies: any[],
  startMs: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of friendlies) {
    const max = maxHpOf(f);
    if (max <= 0) continue;
    for (const d of (f.damageIn ?? []) as any[]) {
      const ts = d.timestamp ?? d.logLine?.timestamp;
      if (ts == null) continue;
      const s = Math.floor((ts - startMs) / 1000);
      const amt = Math.abs(d.effectiveAmount ?? d.amount ?? 0) / max;
      out.set(s, (out.get(s) ?? 0) + amt);
    }
  }
  return out;
}

function coveredThroughout(
  intervals: { startMs: number; endMs: number }[],
  fromMs: number,
  toMs: number,
): boolean {
  let cursor = fromMs;
  for (const iv of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    if (iv.startMs > cursor) return false;
    cursor = Math.max(cursor, iv.endMs);
    if (cursor >= toMs) return true;
  }
  return cursor >= toMs;
}

/**
 * The bounded burst windows of one round, WITHOUT the response / feasibility /
 * outcome work. Used by `burstWindowDecisionPoints` below and by the corpus
 * scan's `sweep` (which needs only window lengths across a parameter grid and
 * must not pay for 16 full passes) — one segmentation implementation, two
 * callers (CLAUDE.md shared-predicate rule).
 */
export function boundedBurstSegments(
  combat: any,
  opts: {
    lapseSeconds?: number;
    dmgFloor?: number;
    friendlyReaction?: number;
  } = {},
): { facts: Map<string, CastFacts>; segments: BoundedSegment[] } {
  const empty = {
    facts: new Map<string, CastFacts>(),
    segments: [] as BoundedSegment[],
  };
  const start: number = combat?.startTime ?? 0;
  const players: any[] = Object.values(combat?.units ?? {}).filter(
    (u: any) => u.info,
  );
  // CombatUnitReaction.Friendly === 1 (parser-compat enums.ts)
  const friendlyReaction = opts.friendlyReaction ?? 1;
  const friendlies = players.filter((u) => u.reaction === friendlyReaction);
  const enemies = players.filter((u) => u.reaction !== friendlyReaction);
  if (!friendlies.length || !enemies.length) return empty;
  const timeline = reconstructEnemyCDTimeline(enemies as ICombatUnit[], combat);
  if (!timeline.alignedBurstWindows.length) return empty;
  const facts = castFactsOf(timeline);
  const dmgPctPerSec = damagePctPerSecond(friendlies, start);
  const segments: BoundedSegment[] = [];
  for (const w of timeline.alignedBurstWindows)
    for (const seg of boundBurstWindow(w, facts, dmgPctPerSec, opts))
      if (qualifies(seg, facts)) segments.push(seg);
  return { facts, segments };
}

export interface BurstWindowOptions {
  /** which side is "friendly"; defaults to the logging player's team */
  friendlyReaction?: number;
  lapseSeconds?: number;
  dmgFloor?: number;
}

/**
 * All bounded enemy burst windows of one round, each with its response,
 * feasibility and (table-only) outcome facts.
 */
export function burstWindowDecisionPoints(
  combat: any,
  opts: BurstWindowOptions = {},
): BurstWindowDecisionPoint[] {
  const start: number = combat?.startTime ?? 0;
  const units: any[] = Object.values(combat?.units ?? {});
  const players = units.filter((u) => u.info);
  if (!players.length) return [];
  // CombatUnitReaction.Friendly === 1 (parser-compat enums.ts)
  const friendlyReaction = opts.friendlyReaction ?? 1;
  const friendlies = players.filter((u) => u.reaction === friendlyReaction);
  const enemies = players.filter((u) => u.reaction !== friendlyReaction);
  if (!friendlies.length || !enemies.length) return [];

  const { facts, segments } = boundedBurstSegments(combat, opts);
  if (!segments.length) return [];

  const enemyByName = new Map<string, any>(enemies.map((u) => [u.name, u]));
  // every friendly cast once, tagged with the categories it can answer with
  interface FriendlyCast {
    unitId: string;
    unitName: string;
    spellId: string;
    dest: string | undefined;
    tMs: number;
  }
  const friendlyCasts: FriendlyCast[] = [];
  for (const u of friendlies)
    for (const c of (u.spellCastEvents ?? []) as any[]) {
      const sid = String(c.spellId ?? "");
      if (!sid) continue;
      friendlyCasts.push({
        unitId: u.id,
        unitName: u.name,
        spellId: sid,
        dest: c.destUnitId,
        tMs: c.timestamp ?? c.logLine?.timestamp,
      });
    }
  friendlyCasts.sort((a, b) => a.tMs - b.tMs);

  // per-friendly ledgers, computed once per round (not per window)
  const cdsByUnit = new Map<string, IMajorCooldownInfo[]>();
  const ccByUnit = new Map<string, { startMs: number; endMs: number }[]>();
  for (const u of friendlies) {
    let cds: IMajorCooldownInfo[] = [];
    try {
      cds = extractMajorCooldowns(u, combat);
    } catch {
      cds = [];
    }
    cdsByUnit.set(
      u.id,
      cds.filter(
        (cd) =>
          !isProcOnlyActivation(cd.spellId) &&
          (cd.tag === "Control" ||
            (!cd.isThroughput &&
              (PERSONAL_WALL_IDS.has(cd.spellId) ||
                EXTERNAL_IDS.has(cd.spellId) ||
                BURST_HEAL_CD_IDS.has(cd.spellId)))),
      ),
    );
    ccByUnit.set(u.id, buildFilteredAuraIntervals(u, ccSpellIds, combat));
  }

  const out: BurstWindowDecisionPoint[] = [];
  {
    for (const seg of segments) {
      const tSec = Math.floor(seg.fromSeconds);
      const tMs = start + tSec * 1000;
      const endSec = Math.max(tSec, Math.floor(seg.toSeconds));
      // Outcome horizon: the bounded window, but never shorter than the
      // response window it is judged against — a piece whose only CD carries
      // no official duration ends on its own cast second, and "did anybody die
      // inside 0 seconds" is not an outcome, it is a rounding artefact.
      const outcomeEndSec = Math.max(endSec, tSec + BURST_RESPONSE_WINDOW_SEC);
      const outcomeEndMs = start + outcomeEndSec * 1000;

      const ordered = [...seg.casts].sort(
        (a, b) => a.castSeconds - b.castSeconds,
      );
      const refOf = (
        c: IAlignedBurstWindow["activeCDs"][number],
      ): BurstCdRef => {
        const caster = enemyByName.get(c.playerName);
        return {
          spellId: c.spellId,
          spellName: getEnglishSpellName(c.spellId, c.spellName),
          casterName: c.playerName,
          casterSpec: caster ? specToString(caster.spec) : "?",
          castSec: Math.floor(c.castSeconds),
        };
      };
      // lead = the FIRST cast of the window, heavier `spellDangerWeight`
      // breaking a same-second tie. GH #60 wrote this "first/heaviest"; first
      // is the half that keeps the rendered sentence true — the decision point
      // is the window START, so "at M:SS they opened <leadCd>" must name what
      // was actually pressed at M:SS. Taking the heaviest instead named a CD
      // cast up to 16 s later in real windows (match 2195ab6e round 4: window
      // opens on Recklessness at 0:09, heaviest is Trueshot at 0:25).
      let leadRaw = ordered[0]!;
      let leadW = weightOf(leadRaw, facts);
      for (const c of ordered) {
        if (Math.floor(c.castSeconds) !== Math.floor(leadRaw.castSeconds))
          break;
        const cw = weightOf(c, facts);
        if (cw > leadW) {
          leadW = cw;
          leadRaw = c;
        }
      }
      const leadCd = refOf(leadRaw);
      const extraCds = ordered.filter((c) => c !== leadRaw).map(refOf);
      const casterIds = [
        ...new Set(
          ordered
            .map((c) => enemyByName.get(c.playerName)?.id)
            .filter((id): id is string => !!id),
        ),
      ];

      // ── responses: any friendly, [tMs - pre, tMs + 8s] ──────────────────
      const w0 = tMs - BURST_RESPONSE_PRE_MS;
      const w1 = tMs + BURST_RESPONSE_WINDOW_MS;
      const casterIdSet = new Set(casterIds);
      const responseCasts: BurstResponseCast[] = [];
      for (const c of friendlyCasts) {
        if (c.tMs < w0) continue;
        if (c.tMs > w1) break;
        const category: BurstResponseCast["category"] | null =
          PERSONAL_WALL_IDS.has(c.spellId)
            ? "wall"
            : EXTERNAL_IDS.has(c.spellId)
              ? "external"
              : BURST_HEAL_CD_IDS.has(c.spellId)
                ? "healCd"
                : CONTROL_IDS.has(c.spellId) &&
                    c.dest != null &&
                    casterIdSet.has(c.dest)
                  ? "control"
                  : null;
        if (!category) continue;
        responseCasts.push({
          category,
          spellId: c.spellId,
          spellName: getEnglishSpellName(c.spellId),
          casterName: c.unitName,
          tSec: Math.floor((c.tMs - start) / 1000),
          latencySec:
            Math.round(((c.tMs - tMs) / 1000 + Number.EPSILON) * 10) / 10,
        });
      }
      // kite is measured on the friendly the burst is actually hitting
      let pressuredUnit: any = null;
      let topDmg = -1;
      for (const f of friendlies) {
        const dmg = ((f.damageIn ?? []) as any[])
          .filter((d) => {
            const ts = d.timestamp ?? d.logLine?.timestamp;
            return ts != null && ts >= tMs && ts <= outcomeEndMs;
          })
          .reduce(
            (n, d) => n + Math.abs(d.effectiveAmount ?? d.amount ?? 0),
            0,
          );
        if (dmg > topDmg) {
          topDmg = dmg;
          pressuredUnit = f;
        }
      }
      const kite =
        topDmg > 0 &&
        pressuredUnit != null &&
        kitedAway(
          pressuredUnit,
          casterIds.map((id) => units.find((u) => u.id === id)),
          tMs,
          w1,
        );
      const responses: BurstWindowResponses = {
        wall: responseCasts.some((r) => r.category === "wall"),
        external: responseCasts.some((r) => r.category === "external"),
        healCd: responseCasts.some((r) => r.category === "healCd"),
        control: responseCasts.some((r) => r.category === "control"),
        kite,
      };
      const responded =
        responses.wall ||
        responses.external ||
        responses.healCd ||
        responses.control ||
        responses.kite;
      const firstResponseSec = responseCasts.length
        ? Math.min(...responseCasts.map((r) => r.latencySec))
        : null;

      // ── feasibility (Value-Gate rule 3) ─────────────────────────────────
      const feasibleUnits: string[] = [];
      for (const u of friendlies) {
        const ready = (cdsByUnit.get(u.id) ?? []).some((cd) =>
          cdAvailableAt(cd, tSec),
        );
        if (!ready) continue;
        const cc = ccByUnit.get(u.id) ?? [];
        if (coveredThroughout(cc, tMs, w1)) continue; // hard-CC'd the whole time
        feasibleUnits.push(u.name);
      }

      // ── outcomes (TABLE ONLY) ───────────────────────────────────────────
      const friendlyOutcomes: BurstFriendlyOutcome[] = friendlies.map((f) => {
        let minHpPct: number | null = null;
        let minHpSec: number | null = null;
        for (let s = tSec; s <= outcomeEndSec; s++) {
          if (isDeadAtRenderSecond(f, start, s)) break;
          const hp = gridHpPct(f, start + s * 1000);
          if (hp === null) continue;
          if (minHpPct === null || hp < minHpPct) {
            minHpPct = hp;
            minHpSec = s;
          }
        }
        const died = ((f.deathRecords ?? []) as any[]).some(
          (d) => d.timestamp >= tMs && d.timestamp <= outcomeEndMs,
        );
        return { unitId: f.id, name: f.name, minHpPct, minHpSec, died };
      });
      const deathsInWindow = friendlyOutcomes.filter((f) => f.died).length;
      const mins = friendlyOutcomes
        .map((f) => f.minHpPct)
        .filter((v): v is number => v !== null);

      out.push({
        tMs,
        tSec,
        endSec,
        durationSec: endSec - tSec,
        leadCd,
        extraCds,
        casterIds,
        responses,
        responded,
        firstResponseSec,
        responseCasts,
        feasible: feasibleUnits.length > 0,
        feasibleUnits,
        anyFriendlyDeath: deathsInWindow > 0,
        deathsInWindow,
        minFriendlyHpPct: mins.length ? Math.min(...mins) : null,
        friendlyOutcomes,
      });
    }
  }
  out.sort((a, b) => a.tSec - b.tSec);
  return out;
}
