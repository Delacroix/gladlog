/**
 * Value gate for the mana-cooldown wiring: find a REAL archive round where a
 * Resto Druid cast Innervate, build the actual prompt, and print the cast lines
 * verbatim — before deciding whether the line earns its place.
 *
 * Innervate was in HEALING_AMPLIFIER_SPELL_IDS until 2026-08-23 and got the
 * HPS/overheal block, whose cast ranking (`overhealPct*1000 - maxBucketHps`)
 * showed the model the WORST-scoring cast. Measured on 200 archive files it is
 * a mana cooldown: SPELL_PERIODIC_ENERGIZE ticks (258), target mana up in 55 of
 * 58 windows (0 down, median +9.5pp).
 *
 * Usage: npx tsx packages/eval/scripts/manaCdExample.ts <archiveRoot> [examples]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  buildMatchContext,
  ensureAnalysisData,
  extractMajorCooldowns,
  isHealerSpec,
} from "@gladlog/analysis";
import { MANA_COOLDOWN_SPELL_IDS } from "@gladlog/analysis/src/context/timelineHelpers";
import { spellEffectData } from "@gladlog/analysis/src/data/spellEffectData";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const wanted = Number(process.argv[3] ?? 3);
const INNERVATE = "29166";

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
  // Cheap pre-filter: skip a file that never mentions Innervate at all.
  let text: string;
  try {
    text = gunzipSync(readFileSync(file)).toString("utf8");
  } catch {
    continue;
  }
  if (!text.includes(`,${INNERVATE},`)) continue;

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
    const druid = friends.find(
      (u) =>
        isHealerSpec(u.spec) &&
        u.spellCastEvents.some((c) => c.spellId === INNERVATE),
    );
    if (!druid) continue;

    if (process.env.DEBUG_LEDGER) {
      const cds = extractMajorCooldowns(druid, legacy as never);
      for (const cd of cds) {
        if (!/Innervate/i.test(cd.spellName) && cd.spellId !== INNERVATE) continue;
        console.log(
          `  [debug] ledger spellId=${JSON.stringify(cd.spellId)} name=${cd.spellName} tag=${cd.tag} ` +
            `inManaSet=${MANA_COOLDOWN_SPELL_IDS.has(cd.spellId)} ` +
            `duration=${spellEffectData[cd.spellId]?.durationSeconds} casts=${cd.casts.length}`,
        );
      }
    }

    let prompt: string;
    try {
      prompt = buildMatchContext(legacy, friends, enemies, { owner: druid });
    } catch {
      continue;
    }
    const lines = prompt.split("\n");
    const hits = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => /Innervate|\[MANA\]/.test(l));
    if (hits.length === 0) continue;

    shown++;
    console.log(
      `\n══════ example ${shown}  file=${path.basename(file)}  owner=${druid.name} (${druid.spec})`,
    );
    const printed = new Set<number>();
    for (const [, i] of hits) {
      for (
        let j = Math.max(0, i - 1);
        j <= Math.min(lines.length - 1, i + 3);
        j++
      ) {
        if (printed.has(j)) continue;
        printed.add(j);
        console.log(`  ${lines[j]}`);
      }
      console.log("  ---");
    }
    if (shown >= wanted) break outer;
  }
}

console.log(`\nrounds scanned=${roundsSeen}, examples printed=${shown}`);
