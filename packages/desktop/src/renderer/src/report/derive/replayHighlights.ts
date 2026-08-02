import { burstCastSpan, reconstructEnemyCDTimeline } from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

/** Active intervals of an enemy's offensive major cooldowns (absolute ms) —
 *  used by the replay's red glow pulse. */
export interface BurstAuraSpan {
  fromMs: number;
  toMs: number;
  spellName: string;
}

/**
 * Burst visuals in the replay (a side item of DPS D1): the active offensive-CD
 * intervals for every enemy player.
 * CD detection = reconstructEnemyCDTimeline, span = burstCastSpan — exactly the
 * same stretch of time the burst ledger audits, so wherever the pulse covers,
 * the ledger audits.
 */
export function deriveBurstAuras(
  source: ReportSource,
): Record<string, BurstAuraSpan[]> {
  try {
    const legacy = toLegacySafe(source);
    const enemies = Object.values(legacy.units).filter(
      (u) => u.info && u.reaction === CombatUnitReaction.Hostile,
    );
    if (enemies.length === 0) return {};
    const idByName = new Map(enemies.map((e) => [e.name, e.id]));

    const out: Record<string, BurstAuraSpan[]> = {};
    for (const p of reconstructEnemyCDTimeline(enemies, legacy).players) {
      const unitId = idByName.get(p.playerName);
      if (!unitId) continue;
      out[unitId] = p.offensiveCDs.map((cd) => {
        const span = burstCastSpan(cd);
        return {
          fromMs: legacy.startTime + span.from * 1000,
          toMs: legacy.startTime + span.to * 1000,
          spellName: cd.spellName,
        };
      });
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Same-second focus fire (a side item of DPS D1): unitId → { relative whole
 * second → number of hostile players hitting it in that second }, keeping only
 * seconds with ≥2 attackers. Pet damage is attributed to the owner (the same
 * criterion used when merging damageOut), and the second is
 * floor(relative ms / 1000), on the same grid as the replay clock.
 */
export function deriveFocusFire(
  source: ReportSource,
): Record<string, Record<number, number>> {
  try {
    const legacy = toLegacySafe(source);
    const units = Object.values(legacy.units);
    const players = units.filter((u) => u.info);
    const playerIds = new Set(players.map((p) => p.id));
    // Pets/guardians → owner (focus fire counts heads by player)
    const ownerOf = new Map<string, string>();
    for (const u of units) {
      if (u.ownerId && playerIds.has(u.ownerId)) ownerOf.set(u.id, u.ownerId);
    }

    const out: Record<string, Record<number, number>> = {};
    for (const victim of players) {
      const bySecond = new Map<number, Set<string>>();
      for (const d of victim.damageIn) {
        const src = ownerOf.get(d.srcUnitId) ?? d.srcUnitId;
        if (!playerIds.has(src) || src === victim.id) continue;
        if (Math.abs(d.effectiveAmount) <= 0) continue;
        const sec = Math.floor((d.logLine.timestamp - legacy.startTime) / 1000);
        let set = bySecond.get(sec);
        if (!set) bySecond.set(sec, (set = new Set()));
        set.add(src);
      }
      const focused: Record<number, number> = {};
      for (const [sec, srcs] of bySecond) {
        if (srcs.size >= 2) focused[sec] = srcs.size;
      }
      if (Object.keys(focused).length > 0) out[victim.id] = focused;
    }
    return out;
  } catch {
    return {};
  }
}
