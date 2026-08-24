/**
 * Value gate for the `[EMPOWER L?]` annotation: real archive rounds with an
 * Evoker owner, real prompts, printed verbatim.
 *
 * Usage: npx tsx packages/eval/scripts/empowerExample.ts <archiveRoot> [examples]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { buildMatchContext, ensureAnalysisData } from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const wanted = Number(process.argv[3] ?? 4);

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

let shown = 0;
let roundsSeen = 0;

outer: for (const file of newSeasonFiles(root)) {
  let text: string;
  try {
    text = gunzipSync(readFileSync(file)).toString("utf8");
  } catch {
    continue;
  }
  if (!text.includes("SPELL_EMPOWER_END")) continue;

  const items: GladMatch[] = [];
  try {
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
    roundsSeen++;
    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction === CombatUnitReaction.Hostile,
    );
    const owner = friends.find((u) => (u.empowerEnds ?? []).length > 0);
    if (!owner) continue;

    let prompt: string;
    try {
      prompt = buildMatchContext(legacy, friends, enemies, { owner });
    } catch {
      continue;
    }
    const lines = prompt.split("\n");
    const hits = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.includes("[EMPOWER"));
    if (hits.length === 0) continue;

    shown++;
    console.log(
      `\n══════ example ${shown}  file=${path.basename(file)}  owner=${owner.name} (spec ${owner.spec})  empowerEnds=${owner.empowerEnds?.length}`,
    );
    const printed = new Set<number>();
    for (const [, i] of hits.slice(0, 6)) {
      for (
        let j = Math.max(0, i - 1);
        j <= Math.min(lines.length - 1, i + 1);
        j++
      ) {
        if (printed.has(j)) continue;
        printed.add(j);
        console.log(`  ${lines[j]}`);
      }
      console.log("  ---");
    }
    console.log(`  [tagged lines this round: ${hits.length}]`);
    if (shown >= wanted) break outer;
  }
}

console.log(`\nrounds scanned=${roundsSeen}, examples printed=${shown}`);
