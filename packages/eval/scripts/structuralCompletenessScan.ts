/**
 * Full-corpus measurement for the structural completeness predicate
 * (packages/parser/src/completeness.ts) -- the sibling of parserInvariants.ts.
 *
 * For every log in the manifest: parse → run checkStructuralCompleteness on
 * every match and every shuffle → aggregate by code and by bracket. Unlike the
 * invariants sweep this is a *measurement*, not a gate: a partial shuffle is a
 * real thing that happens (disconnects, log rotation mid-run), the product's
 * job is to label it, so the exit code is always 0 and the numbers are what
 * matters. It also prints the bracket strings seen so EXPECTED_ROSTER_SIZE can
 * be checked for completeness (Curated-List rule).
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=8192 \
 *   npx tsx packages/eval/scripts/structuralCompletenessScan.ts --manifest <file>
 */

import {
  checkStructuralCompleteness,
  GladLogParser,
  type GladMatch,
  type GladShuffle,
} from "@gladlog/parser";
import fs from "fs-extra";
import { gunzipSync } from "zlib";

function parseArgs(): { manifest: string } {
  const args = process.argv.slice(2);
  let manifest = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") manifest = args[i + 1] ?? "";
  }
  if (!manifest) {
    console.error("Error: --manifest <file> is required");
    process.exit(1);
  }
  return { manifest };
}

interface Agg {
  count: number;
  samples: string[];
}

async function main() {
  const { manifest } = parseArgs();
  const logPaths = (await fs.readFile(manifest, "utf-8"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const byCode = new Map<string, Agg>();
  const byBracket = new Map<string, { docs: number; flagged: number }>();
  const shuffleRoundCounts = new Map<number, number>();
  let docs = 0;
  let flaggedDocs = 0;

  const record = (label: string, doc: GladMatch | GladShuffle) => {
    docs++;
    const bracket =
      doc.kind === "shuffle"
        ? (doc.rounds[0]?.bracket ?? "(empty shuffle)")
        : doc.bracket;
    const b = byBracket.get(bracket) ?? { docs: 0, flagged: 0 };
    b.docs++;
    if (doc.kind === "shuffle") {
      const n = doc.rounds.length;
      shuffleRoundCounts.set(n, (shuffleRoundCounts.get(n) ?? 0) + 1);
    }
    const issues = checkStructuralCompleteness(doc);
    if (issues.length > 0) {
      flaggedDocs++;
      b.flagged++;
    }
    byBracket.set(bracket, b);
    for (const v of issues) {
      const agg = byCode.get(v.code) ?? { count: 0, samples: [] };
      agg.count++;
      if (agg.samples.length < 5)
        agg.samples.push(
          `${label}${v.roundSeq !== undefined ? `#r${v.roundSeq}` : ""}: ${v.detail}`,
        );
      byCode.set(v.code, agg);
    }
  };

  for (const logPath of logPaths) {
    let content: string;
    try {
      const raw = await fs.readFile(logPath);
      content = (logPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString(
        "utf8",
      );
    } catch (err) {
      console.error(`skip ${logPath}: ${(err as Error).message}`);
      continue;
    }
    const parser = new GladLogParser();
    parser.on("match", (m) => record(m.id, m));
    parser.on("shuffle", (s) => record(s.rounds[0]?.id ?? "?", s));
    for (const line of content.split("\n")) parser.push(line);
    parser.end();
  }

  console.log(
    `structural completeness — ${docs} docs (matches + shuffles) from ${logPaths.length} logs`,
  );
  console.log(
    `flagged docs: ${flaggedDocs}/${docs} (${((100 * flaggedDocs) / Math.max(1, docs)).toFixed(1)}%)`,
  );
  console.log("\nby bracket (docs / flagged):");
  for (const [bracket, b] of [...byBracket.entries()].sort()) {
    console.log(`  ${JSON.stringify(bracket)}: ${b.docs} / ${b.flagged}`);
  }
  console.log("\nshuffle round-count distribution:");
  for (const [n, c] of [...shuffleRoundCounts.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    console.log(`  ${n} rounds: ${c}`);
  }
  for (const [code, agg] of [...byCode.entries()].sort()) {
    console.log(`\n[${code}] ×${agg.count}`);
    for (const s of agg.samples) console.log(`  ${s}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
