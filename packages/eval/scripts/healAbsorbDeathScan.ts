/**
 * Is heal absorption material AT A DEATH — the place a coach would want it?
 *
 * Before wiring `SPELL_HEAL_ABSORBED` into the prompt, check the framing holds:
 * "the heal that would have saved you was eaten" is only worth a line if a real
 * share of deaths actually carry eaten healing, and if the amount is big enough
 * next to what did land. A signal that is real corpus-wide but absent at the
 * moment it would be quoted is a signal in the wrong place.
 *
 * Window: [death - 10s, death], matching DEATH_CC_LOOKBACK_S's sibling framing
 * for death-anchored evidence.
 *
 * Usage: npx tsx packages/eval/scripts/healAbsorbDeathScan.ts <archiveRoot> [maxRounds]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { ensureAnalysisData, getEnglishSpellName } from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";

await ensureAnalysisData();

const root = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 1000);
const WINDOW_MS = 10_000;

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
let deaths = 0;
let deathsWithEaten = 0;
const eatenShare: number[] = [];
const eatenAmounts: number[] = [];
const byDebuff = new Map<string, number>();
let sumEaten = 0;
let sumReceived = 0;
// How often the eaten amount alone exceeds the victim's remaining HP pool —
// i.e. it is not a rounding-level nuisance but a plausible save.
let eatenOverMaxHp = 0;

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
    rounds++;
    for (const u of Object.values(m.units)) {
      if (!String(u.id).startsWith("Player-")) continue;
      for (const d of u.deaths) {
        const from = d.timestamp - WINDOW_MS;
        const to = d.timestamp;
        deaths++;

        let received = 0;
        for (const h of u.healIn) {
          if (h.timestamp < from || h.timestamp > to) continue;
          const amt = Math.abs(h.effectiveAmount);
          if (Number.isFinite(amt)) received += amt;
        }
        let eaten = 0;
        for (const ha of u.healAbsorbsIn) {
          if (ha.timestamp < from || ha.timestamp > to) continue;
          if (!Number.isFinite(ha.absorbedAmount)) continue;
          eaten += ha.absorbedAmount;
          const key = String(ha.absorbSpellId);
          byDebuff.set(key, (byDebuff.get(key) ?? 0) + ha.absorbedAmount);
        }

        sumReceived += received;
        sumEaten += eaten;
        if (eaten <= 0) continue;
        deathsWithEaten++;
        eatenAmounts.push(eaten);
        if (received + eaten > 0) {
          eatenShare.push((eaten / (received + eaten)) * 100);
        }
        const maxHp = u.advancedSamples.at(-1)?.maxHp ?? 0;
        if (maxHp > 0 && eaten >= maxHp * 0.2) eatenOverMaxHp++;
      }
    }
  }
}

const n = (x: number) => Math.round(x).toLocaleString();
const pct = (a: number, b: number) =>
  b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`;
const q = (xs: number[], f: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
};

console.log(`rounds=${rounds}  friendly+enemy player deaths=${n(deaths)}`);
console.log(
  `\ndeaths with ANY healing eaten in the last 10s: ${n(deathsWithEaten)} (${pct(deathsWithEaten, deaths)})`,
);
console.log(
  `  eaten amount at those deaths: p10=${n(q(eatenAmounts, 0.1))} p50=${n(q(eatenAmounts, 0.5))} p90=${n(q(eatenAmounts, 0.9))}`,
);
console.log(
  `  eaten as a share of (landed + eaten) healing: p10=${q(eatenShare, 0.1).toFixed(1)}% p50=${q(eatenShare, 0.5).toFixed(1)}% p90=${q(eatenShare, 0.9).toFixed(1)}%`,
);
console.log(
  `  deaths where the eaten amount alone was >=20% of the victim's max HP: ${n(eatenOverMaxHp)} (${pct(eatenOverMaxHp, deaths)} of all deaths)`,
);
console.log(
  `\ncorpus totals in death windows: landed ${n(sumReceived)}, eaten ${n(sumEaten)} (${pct(sumEaten, sumReceived + sumEaten)})`,
);
console.log(`\ntop heal-absorb debuffs at deaths:`);
for (const [id, amt] of [...byDebuff.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)) {
  console.log(`  ${id} ${getEnglishSpellName(id) ?? "?"}: ${n(amt)}`);
}
