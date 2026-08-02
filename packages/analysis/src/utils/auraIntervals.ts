import { ICombatUnit, LogEvent } from "@gladlog/parser-compat";

import { spellEffectData } from "../data/spellEffectData";

/**
 * auraIntervals.ts -- aura interval sets (phase 4 item 4, the WoWAnalyzer Auras
 * pattern).
 *
 * Pairs the aura event stream on a unit (applied/dose/refresh/removed/broken)
 * into intervals, for every consumer that asks "when was this buff up" --
 * uptime bars, point-in-time queries, and so on. Single-source predicate: the
 * pairing logic exists only here.
 *
 * 2026-07-25 production fix (user reported "dashed lines starting at 0s and
 * lasting several minutes"):
 *  1) Opens are keyed by spellId+srcUnitId -- with a single key, the second
 *     APPLIED of the same spell from two sources (two priests' shields /
 *     multiple rune instances) was swallowed and its REMOVED found no open
 *     segment, producing a phantom 0->removeT dashed line (user measured 2802
 *     orphaned REMOVEDs over 10 matches: 萦绕符文 x876, Frostbolt x190).
 *     Closing tries the exact key first, then falls back to any key of the same
 *     spell.
 *  2) SPELL_AURA_APPLIED_DOSE also opens a segment (the first event of a
 *     stacking aura can be a DOSE).
 *  3) Inferred boundaries are **capped by the official duration**
 *     (spellEffectData.durationSeconds, official data): inferredStart backs up
 *     at most D seconds and inferredEnd extends at most D seconds -- Frostbolt
 *     (8s) can be dashed for at most 8 seconds, while the "already up before
 *     the pull" semantics of long buffs like Power Word: Fortitude / arena
 *     preparation are unaffected. No official duration -> previous behavior.
 *
 * Normalization trace: the inferredStart / inferredEnd flags are unchanged; the
 * renderer draws them as dashed.
 */

export interface IAuraInterval {
  spellId: string;
  /** Consumers resolve the English name via getEnglishSpellName; this stores
   * the raw log text. */
  spellName: string;
  srcUnitName: string;
  fromS: number;
  toS: number;
  inferredStart: boolean;
  inferredEnd: boolean;
}

const CLOSE_EVENTS = new Set<string>([
  LogEvent.SPELL_AURA_REMOVED,
  LogEvent.SPELL_AURA_BROKEN,
  LogEvent.SPELL_AURA_BROKEN_SPELL,
]);

const OPEN_EVENTS = new Set<string>([
  LogEvent.SPELL_AURA_APPLIED,
  "SPELL_AURA_APPLIED_DOSE",
]);

/** Official aura duration in seconds; no data -> null (no cap). */
function officialDurationS(spellId: string): number | null {
  const d = spellEffectData[spellId]?.durationSeconds;
  return typeof d === "number" && d > 0 ? d : null;
}

/**
 * Interval set for every aura on this unit (dest = this unit), sorted by
 * ascending fromS.
 */
export function buildAuraIntervals(
  unit: ICombatUnit,
  combat: { startTime: number; endTime: number },
): IAuraInterval[] {
  const durationS = (combat.endTime - combat.startTime) / 1000;
  const rel = (ts: number) =>
    Math.min(durationS, Math.max(0, (ts - combat.startTime) / 1000));

  interface Open {
    fromS: number;
    inferredStart: boolean;
    spellName: string;
    srcUnitName: string;
  }
  const open = new Map<string, Open>();
  const keyOf = (spellId: string, srcUnitId: string) =>
    `${spellId}:${srcUnitId}`;
  const out: IAuraInterval[] = [];

  const events = [...unit.auraEvents]
    .filter((a) => a.destUnitId === unit.id && a.spellId)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const a of events) {
    const id = a.spellId!;
    const key = keyOf(id, a.srcUnitId ?? "");
    const ev = a.logLine.event as string;
    if (OPEN_EVENTS.has(ev)) {
      if (!open.has(key)) {
        open.set(key, {
          fromS: rel(a.timestamp),
          inferredStart: false,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
        });
      }
    } else if (ev === LogEvent.SPELL_AURA_REFRESH) {
      if (!open.has(key)) {
        // Already up but no APPLIED was seen: back up by at most the official
        // duration
        const t = rel(a.timestamp);
        const d = officialDurationS(id);
        open.set(key, {
          fromS: d === null ? 0 : Math.max(0, t - d),
          inferredStart: true,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
        });
      }
    } else if (CLOSE_EVENTS.has(ev)) {
      // Closing: exact key first, then fall back to any source of the same
      // spell (a REMOVED's src is often inconsistent with / missing from the
      // APPLIED, which must not be read as "already up before the pull")
      let hitKey: string | null = open.has(key) ? key : null;
      if (hitKey === null) {
        for (const k of open.keys())
          if (k.startsWith(`${id}:`)) {
            hitKey = k;
            break;
          }
      }
      const o = hitKey === null ? undefined : open.get(hitKey);
      if (o && hitKey !== null) {
        open.delete(hitKey);
        out.push({
          spellId: id,
          spellName: o.spellName,
          srcUnitName: o.srcUnitName,
          fromS: o.fromS,
          toS: rel(a.timestamp),
          inferredStart: o.inferredStart,
          inferredEnd: false,
        });
      } else {
        // Already up before the pull; this match only saw it fall off. Back up
        // by at most the official duration
        const t = rel(a.timestamp);
        const d = officialDurationS(id);
        out.push({
          spellId: id,
          spellName: a.spellName ?? "",
          srcUnitName: a.srcUnitName,
          fromS: d === null ? 0 : Math.max(0, t - d),
          toS: t,
          inferredStart: true,
          inferredEnd: false,
        });
      }
    }
  }

  for (const [key, o] of open) {
    const id = key.slice(0, key.indexOf(":"));
    // No REMOVED seen: extend by at most the official duration (short auras no
    // longer stay dashed all the way to the end of the match)
    const d = officialDurationS(id);
    out.push({
      spellId: id,
      spellName: o.spellName,
      srcUnitName: o.srcUnitName,
      fromS: o.fromS,
      toS: d === null ? durationS : Math.min(durationS, o.fromS + d),
      inferredStart: o.inferredStart,
      inferredEnd: true,
    });
  }

  return out.sort(
    (a, b) => a.fromS - b.fromS || a.spellId.localeCompare(b.spellId),
  );
}
