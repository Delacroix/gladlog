/**
 * Corpus-wide measurement for BACKLOG #28 — `buildAuraIntervals`
 * (`packages/analysis/src/utils/auraIntervals.ts`) double-close race: when a
 * CLOSE event (REMOVED/BROKEN/BROKEN_SPELL) for a spellId finds no matching
 * open interval, it falls into the "already up before the pull" branch and
 * backdates a phantom interval using the official duration — but the same
 * real control being reported by two different CLOSE events in a short
 * window hits that branch on the SECOND event too, producing a fabricated
 * interval that overlaps the real one.
 *
 * This module mirrors `buildAuraIntervals`'s own pairing algorithm closely
 * enough to reproduce exactly which events hit the fallback branch (the
 * production function does not expose that decision to callers), then adds
 * ONE independent measurement the production algorithm does not compute:
 * for every fallback trigger, the gap in seconds between the fallback
 * event's timestamp and the most recently emitted CLOSE for the same
 * spellId+unit (any source) — regardless of whether that prior close came
 * from a real pairing or an earlier fallback. A small gap is the discriminant
 * BACKLOG #28's "修法方向" proposes for the eventual fix (a duplicate CLOSE
 * event arriving shortly after the one that already closed the real
 * interval), so this scan's histogram is what picks the threshold constant.
 *
 * This is a diagnostic-only reimplementation (per CLAUDE.md's "配套" note,
 * scoped to a one-time corpus measurement, not a competing source of truth):
 * it does not replace `buildAuraIntervals` and nothing downstream consumes
 * its output.
 */
import { type ICombatUnit, LogEvent } from "@gladlog/parser-compat";

import { type LegacyRound } from "./storeAccess";

export interface DoubleCloseHit {
  matchId: string;
  roundSeq?: number;
  unitName: string;
  spellId: string;
  spellName: string;
  closeEvent: string;
  atS: number;
  /** Seconds since the most recent CLOSE emitted for this spellId+unit (any
   * source); `null` when there was no prior close at all (genuine
   * "already-up-before-the-pull, only ever saw it fall off" case). */
  gapSincePriorCloseS: number | null;
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

/** Scans one unit's aura event stream for fallback-branch triggers, mirroring
 * `buildAuraIntervals`'s open/close pairing (exact key first, then any
 * same-spellId key) plus the extra `lastCloseToS` bookkeeping described in
 * the module header. */
function scanUnit(
  matchId: string,
  roundSeq: number | undefined,
  unit: ICombatUnit,
  combat: { startTime: number; endTime: number },
): DoubleCloseHit[] {
  const rel = (ts: number) => (ts - combat.startTime) / 1000;
  const hits: DoubleCloseHit[] = [];

  interface OpenEntry {
    fromS: number;
  }
  const open = new Map<string, OpenEntry>();
  const lastCloseToSBySpellId = new Map<string, number>();
  const keyOf = (spellId: string, srcUnitId: string) =>
    `${spellId}:${srcUnitId}`;

  const events = [...unit.auraEvents]
    .filter((a) => a.destUnitId === unit.id && a.spellId)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const a of events) {
    const id = a.spellId!;
    const key = keyOf(id, a.srcUnitId ?? "");
    const ev = a.logLine.event as string;

    if (OPEN_EVENTS.has(ev)) {
      if (!open.has(key)) open.set(key, { fromS: rel(a.timestamp) });
    } else if (ev === LogEvent.SPELL_AURA_REFRESH) {
      if (!open.has(key)) open.set(key, { fromS: rel(a.timestamp) });
    } else if (CLOSE_EVENTS.has(ev)) {
      let hitKey: string | null = open.has(key) ? key : null;
      if (hitKey === null) {
        for (const k of open.keys())
          if (k.startsWith(`${id}:`)) {
            hitKey = k;
            break;
          }
      }
      const t = rel(a.timestamp);
      if (hitKey !== null) {
        open.delete(hitKey);
        lastCloseToSBySpellId.set(id, t);
      } else {
        // Fallback branch: this is what BACKLOG #28 is about.
        const priorT = lastCloseToSBySpellId.get(id);
        hits.push({
          matchId,
          roundSeq,
          unitName: unit.name,
          spellId: id,
          spellName: a.spellName ?? "",
          closeEvent: ev,
          atS: t,
          gapSincePriorCloseS: priorT === undefined ? null : t - priorT,
        });
        lastCloseToSBySpellId.set(id, t);
      }
    }
  }
  return hits;
}

/** Scans one already-loaded round for double-close fallback triggers, across
 * every unit that carries aura events (players, pets, NPCs alike — the same
 * population `buildAuraIntervals` would be called on by any consumer). */
export function scanRoundForDoubleClose(
  matchId: string,
  legacy: LegacyRound,
  roundSeq?: number,
): DoubleCloseHit[] {
  const combat = { startTime: legacy.startTime, endTime: legacy.endTime };
  const hits: DoubleCloseHit[] = [];
  for (const unit of Object.values(
    legacy.units as Record<string, ICombatUnit>,
  )) {
    if (!unit.auraEvents?.length) continue;
    hits.push(...scanUnit(matchId, roundSeq, unit, combat));
  }
  return hits;
}
