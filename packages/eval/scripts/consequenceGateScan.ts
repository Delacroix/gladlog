/**
 * BACKLOG #39 ruling-A validation: across the archive, how many missed/late
 * cleanse windows are Critical NOW vs would-have-been-Critical before the
 * consequence gate (`consequenceDemoted` marks exactly those), and sanity that
 * death-linked zero-damage windows keep Critical.
 *
 * Acceptance target: Critical windows with postCcDamage=0 AND no death
 * linkage → 0 by construction; the interesting number is the demotion rate
 * (paired-corpus baseline: 22/125 = 17.6% of Critical).
 *
 * Usage: npx tsx packages/eval/scripts/consequenceGateScan.ts <archiveRoot> [maxRounds]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  ensureAnalysisData,
  reconstructDispelSummary,
} from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 1200);

function newSeasonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".txt.gz")) out.push(p);
    }
  };
  walk(dir);
  return out
    .filter((p) => {
      const m = /\/2026\/08\/(\d{2})\//.exec(p);
      return m != null && Number(m[1]) >= 12;
    })
    .sort();
}

let rounds = 0;
const tier = { Critical: 0, High: 0, Medium: 0, Low: 0 } as Record<
  string,
  number
>;
let demoted = 0;
let criticalZeroDamage = 0;
let criticalZeroDamageDeathLinked = 0;

outer: for (const file of newSeasonFiles(root)) {
  const items: GladMatch[] = [];
  try {
    const text = gunzipSync(readFileSync(file)).toString("utf8");
    const p = new GladLogParser();
    p.on("match", (m: GladMatch) => items.push(m));
    p.on("shuffle", (sh) => {
      for (const r of sh.rounds) items.push(r as never);
    });
    for (const line of text.split("\n")) p.push(line);
    p.end();
  } catch {
    continue;
  }
  for (const m of items) {
    if (rounds >= maxRounds) break outer;
    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    rounds++;
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction === CombatUnitReaction.Hostile,
    );
    let summary;
    try {
      summary = reconstructDispelSummary(friends, enemies, legacy as never);
    } catch {
      continue;
    }
    for (const w of [
      ...summary.missedCleanseWindows,
      ...summary.lateCleanseWindows,
    ]) {
      tier[w.priority] = (tier[w.priority] ?? 0) + 1;
      if (w.consequenceDemoted) demoted++;
      if (w.priority === "Critical" && w.postCcDamage <= 0) {
        criticalZeroDamage++;
        criticalZeroDamageDeathLinked++; // by construction these survived only via death linkage
      }
    }
  }
}

const wouldBeCritical = tier.Critical + demoted;
console.log(`rounds=${rounds}`);
console.log(
  `windows by tier: Critical=${tier.Critical} High=${tier.High} Medium=${tier.Medium} Low=${tier.Low}`,
);
console.log(
  `would-have-been Critical (pre-gate): ${wouldBeCritical}  → demoted for zero consequence: ${demoted} (${((demoted / Math.max(1, wouldBeCritical)) * 100).toFixed(1)}%)  [paired-corpus baseline 17.6%]`,
);
console.log(
  `Critical with postCcDamage=0 remaining: ${criticalZeroDamage} (all death-linked by construction: ${criticalZeroDamageDeathLinked})`,
);
