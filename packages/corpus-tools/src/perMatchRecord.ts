import {
  computeDpsMetrics,
  computeHealerMetrics,
  enemyCompArchetype,
  enemyCompSignature,
  extractRotations,
  isHealerSpec,
  specToString,
} from "@gladlog/analysis";
import { GladLogParser } from "@gladlog/parser";
import {
  CombatUnitReaction,
  toLegacyMatch,
  toLegacyShuffle,
} from "@gladlog/parser-compat";

import type { PerMatchRecord } from "./cellAggregator";
import { assignBuildGroup, type KeystoneGate } from "./keystoneGates";

/** One combat → one record per Friendly player (healers get IHealerMetrics,
 * DPS get IDpsMetrics; a pure function, so a synthetic combat can unit-test it).
 * Follows the Friendly-only convention (the recorder's side has the most
 * complete data); disjoint specs guarantee a single metric set within a cell. */
export function combatToRecords(
  combat: any,
  gates: KeystoneGate[],
): PerMatchRecord[] {
  const players = (Object.values(combat.units) as any[]).filter((u) => u.info);
  const friendly = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const out: PerMatchRecord[] = [];
  for (const unit of friendly) {
    const enemies = players.filter((u) => u.reaction !== unit.reaction);
    const healer = isHealerSpec(unit.spec);
    let metrics;
    try {
      metrics = healer
        ? computeHealerMetrics(combat, unit.name)
        : computeDpsMetrics(combat, unit.name);
    } catch {
      continue;
    }
    const archetype = enemyCompArchetype(enemies);
    // P2: comp signature + duration + who died first (comp-cell aggregates)
    const enemyComp = enemyCompSignature(
      enemies.map((e: any) => specToString(e.spec)),
    );
    const durationS = Math.max(
      0,
      Math.round(((combat.endTime ?? 0) - (combat.startTime ?? 0)) / 1000),
    );
    let firstEnemyKillSpec = "";
    let firstDeathTs = Infinity;
    for (const e of enemies) {
      for (const d of e.deathRecords ?? []) {
        if (d.timestamp < firstDeathTs) {
          firstDeathTs = d.timestamp;
          firstEnemyKillSpec = specToString(e.spec);
        }
      }
    }
    const rotations = extractRotations(unit, combat);
    const spec = specToString(unit.spec);
    const gate = gates.find((g) => g.spec === spec);
    const talents = (unit.info?.talents ?? [])
      .map((t: any) => t.id1)
      .filter(Boolean);
    const buildGroup = gate ? assignBuildGroup(talents, gate) : "*";
    out.push({
      spec,
      bracket: combat.startInfo?.bracket ?? "unknown",
      archetype,
      buildGroup,
      enemyComp,
      durationS,
      firstEnemyKillSpec,
      metrics,
      crisisEvents: rotations.crisisEvents,
    });
  }
  return out;
}

/** One log → parse → per-match records. A thin shell; the real parsing
 *  integration is verified in the T8 live run. */
export function buildPerMatchRecords(
  logText: string,
  gates: KeystoneGate[],
): PerMatchRecord[] {
  const parser = new GladLogParser();
  const combats: any[] = [];
  parser.on("match", (m: any) => combats.push(toLegacyMatch(m)));
  parser.on("shuffle", (sh: any) => {
    const legacy = toLegacyShuffle(sh);
    (legacy.rounds ?? []).forEach((r: any) => combats.push(r));
  });
  for (const line of logText.split("\n")) parser.push(line);
  parser.end();
  return combats.flatMap((c) => combatToRecords(c, gates));
}
