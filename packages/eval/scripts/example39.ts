/**
 * BACKLOG #39's own prescribed next step: produce a REAL product output for a
 * "priority=Critical + measured zero post-CC damage" missed-cleanse
 * accusation, for the user to rule on (absorb the consequence into the tier,
 * or keep the prior and down-weight at the candidate layer).
 *
 * Case: match 2eb0ff2b (user's own library, Solo Shuffle, Minilay), rows from
 * video-log-xcheck busy.jsonl: Fear @166.4s and Howl of Terror @143.7s, both
 * priority=Critical, postCcDamageK=0, castBusyS=0 (the healer was completely
 * free — no excuse, and also no consequence).
 *
 * Usage: npx tsx packages/eval/scripts/example39.ts <matchDir>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildMatchContext,
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
} from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const dir = process.argv[2];
const TARGETS = [166.415, 143.687];
const OWNER_NAME = "Minilay-Illidan-US";

const rounds: GladMatch[] = [];
{
  const p = new GladLogParser();
  p.on("match", (m: GladMatch) => rounds.push(m));
  p.on("shuffle", (sh) => {
    for (const r of sh.rounds) rounds.push(r as never);
  });
  for (const line of readFileSync(path.join(dir, "raw.txt"), "utf8").split(
    "\n",
  ))
    p.push(line);
  p.end();
}
console.log(`rounds parsed: ${rounds.length}`);

for (const m of rounds) {
  let legacy;
  try {
    legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
  } catch {
    continue;
  }
  const players = Object.values(legacy.units).filter((u) => u.info);
  const owner = players.find((u) => u.name === OWNER_NAME);
  if (!owner || !isHealerSpec(owner.spec)) continue;

  let candidates;
  try {
    candidates = extractCandidateFindings(legacy, owner.id);
  } catch {
    continue;
  }
  const hits = candidates.filter(
    (c) =>
      c.type.includes("cleanse") && TARGETS.some((t) => Math.abs(c.t - t) < 3),
  );
  if (hits.length === 0) continue;

  console.log(`\n══════ round startTime=${legacy.startTime}`);
  for (const c of hits) {
    console.log(`\n── candidate ${c.type} @ t=${c.t}`);
    console.log(JSON.stringify(c.facts, null, 1));
  }

  // the same accusation as the model sees it: the prompt's missed-cleanse line
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction === CombatUnitReaction.Hostile,
  );
  try {
    const prompt = buildMatchContext(legacy, friends, enemies, { owner });
    const lines = prompt.split("\n");
    for (const [l, i] of lines.map((l, i) => [l, i] as const)) {
      if (/MISSED CLEANSE|missed-cleanse|Fear|Howl of Terror/.test(l)) {
        const t = /^(\d+):(\d{2})/.exec(l.trim());
        if (t) {
          const sec = Number(t[1]) * 60 + Number(t[2]);
          if (!TARGETS.some((x) => Math.abs(sec - x) < 8)) continue;
        }
        console.log(`  [prompt] ${lines[i]}`);
      }
    }
  } catch {
    /* prompt build optional */
  }
}
