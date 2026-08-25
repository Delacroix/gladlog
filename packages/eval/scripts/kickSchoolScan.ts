/**
 * BACKLOG #36(b) validation: run the PRODUCT postKick predicate
 * (`analyzePlayerCCAndTrinket`) over the archive and compare the per-spec
 * switch/idle rates with the research-side anchor (healer-study school_probe,
 * 500 matches):
 *
 *   Disc 76–80% switched / 6–10% idle · Preservation 76–84% / 6–7% ·
 *   RDruid 51–57% / 2–9% · Holy Priest 36–38% / 21–22% ·
 *   RSham 16–24% / 18–32% · Holy Paladin 8% / 36%
 *
 * Same predicate on more data should reproduce the ORDERING; big divergence
 * means the product wiring differs from what the research measured.
 *
 * Usage: npx tsx packages/eval/scripts/kickSchoolScan.ts <archiveRoot> [maxRounds]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  analyzePlayerCCAndTrinket,
  ensureAnalysisData,
  isHealerSpec,
  specToString,
} from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 3300);

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
const bySpec = new Map<
  string,
  { switched: number; acted: number; idle: number }
>();

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
    for (const healer of players.filter((u) => isHealerSpec(u.spec))) {
      const enemies = players.filter((u) => u.reaction !== healer.reaction);
      let summary;
      try {
        summary = analyzePlayerCCAndTrinket(healer, enemies, legacy as never);
      } catch {
        continue;
      }
      const spec = specToString(healer.spec);
      const st = bySpec.get(spec) ?? { switched: 0, acted: 0, idle: 0 };
      for (const k of summary.interruptInstances) st[k.postKick]++;
      bySpec.set(spec, st);
    }
  }
}

console.log(`rounds=${rounds}\n`);
console.log(
  "spec                      switched   acted    idle     n   (research anchor: switched% / idle%)",
);
const ANCHOR: Record<string, string> = {
  "Discipline Priest": "76–80 / 6–10",
  "Preservation Evoker": "76–84 / 6–7",
  "Restoration Druid": "51–57 / 2–9",
  "Holy Priest": "36–38 / 21–22",
  "Restoration Shaman": "16–24 / 18–32",
  "Holy Paladin": "8 / 36",
};
for (const [spec, st] of [...bySpec.entries()].sort((a, b) => {
  const na = a[1].switched + a[1].acted + a[1].idle;
  const nb = b[1].switched + b[1].acted + b[1].idle;
  return nb - na;
})) {
  const n = st.switched + st.acted + st.idle;
  if (n < 20) continue;
  const pc = (x: number) => `${((x / n) * 100).toFixed(0)}%`.padStart(5);
  console.log(
    `${spec.padEnd(26)}${pc(st.switched)}   ${pc(st.acted)}   ${pc(st.idle)}   ${String(n).padStart(5)}   ${ANCHOR[spec] ?? ""}`,
  );
}
