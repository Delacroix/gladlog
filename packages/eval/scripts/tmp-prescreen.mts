import { readFileSync } from "node:fs";
import { ensureAnalysisData } from "@gladlog/analysis";
import { runQuery } from "../src/explore/matchExplore";
import { prescreen } from "../src/explore/buildSession";
import { DEFAULT_MATCH_DIR, loadLegacyRound } from "../src/explore/storeAccess";
const [file, matchId, roundArg] = process.argv.slice(2);
await ensureAnalysisData();
const deep = JSON.parse(readFileSync(file, "utf8"));
const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, matchId, roundArg ? Number(roundArg) : undefined);
const q = (argv: string[]) => runQuery(legacy, argv);
const counts: Record<string, number> = {};
const bad: string[] = [];
deep.forEach((f: any, i: number) => {
  for (const r of prescreen(f.evidence, q)) {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    if (r.verdict !== "verified") bad.push(`claim${i + 1} [${r.cmd}] ${r.line.slice(0, 90)}`);
  }
});
console.log(JSON.stringify(counts));
bad.forEach((b) => console.log("BAD", b));
