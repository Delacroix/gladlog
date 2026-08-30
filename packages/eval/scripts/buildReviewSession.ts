/**
 * buildReviewSession.ts CLI — dumb shell over `../src/explore/buildSession.ts`.
 * Per the plan's global constraint this file carries zero new logic (not
 * covered by `npm run typecheck`, so any logic here would be untested logic)
 * — it only parses `argv`, wires the calls, and writes the result to disk.
 *
 *   npx tsx packages/eval/scripts/buildReviewSession.ts --name <name> --match <id> [--round N] [--store <dir>]
 *
 * Reads `<evalHome>/review-sessions/<name>.deep.json` (a hand-written or
 * scripted `DeepFindingInput[]`), loads the match round off the local
 * library (`--store`, defaulting to `DEFAULT_MATCH_DIR`; `--round` is the
 * array-index semantic `loadLegacyRound` documents), calls `buildSession`
 * (prescreen + baseline merge + seeded shuffle, all Task 5's own module), and
 * writes `<evalHome>/review-sessions/<name>.session.json` atomically — a tmp
 * file plus `renameSync`, so a crash mid-write never leaves a half-written
 * session file behind. `resolveEvalHome()` throws unless `$GLADLOG_EVAL_HOME`
 * (or its default) already exists and is an initialized git repo; only the
 * `review-sessions/` subdirectory itself is created on demand here.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ensureAnalysisData } from "@gladlog/analysis";

import { resolveEvalHome } from "../src/evalHome.js";
import { buildSession } from "../src/explore/buildSession.js";
import type { DeepFindingInput } from "../src/explore/reviewTypes.js";
import {
  DEFAULT_MATCH_DIR,
  loadLegacyRound,
} from "../src/explore/storeAccess.js";

const USAGE =
  "usage: buildReviewSession.ts --name <name> --match <id> [--round N] [--store <dir>]";

await ensureAnalysisData();

try {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      match: { type: "string" },
      round: { type: "string" },
      store: { type: "string" },
    },
  });

  const name = values.name;
  const matchId = values.match;
  if (!name || !matchId) throw new Error(USAGE);
  const roundSeq =
    values.round !== undefined ? Number(values.round) : undefined;
  const matchesDir = values.store ?? DEFAULT_MATCH_DIR;

  const evalHome = resolveEvalHome();
  const reviewSessionsDir = join(evalHome, "review-sessions");
  mkdirSync(reviewSessionsDir, { recursive: true });

  const deepPath = join(reviewSessionsDir, `${name}.deep.json`);
  const deep = JSON.parse(readFileSync(deepPath, "utf8")) as DeepFindingInput[];

  const { legacy, analysisId } = loadLegacyRound(matchesDir, matchId, roundSeq);
  const session = buildSession({
    name,
    matchId,
    roundSeq,
    analysisId,
    deep,
    legacy,
    matchesDir,
  });

  const outPath = join(reviewSessionsDir, `${name}.session.json`);
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  renameSync(tmpPath, outPath);

  const deepCount = session.cards.filter((c) => c.source === "deep").length;
  const baselineCount = session.cards.filter(
    (c) => c.source === "baseline",
  ).length;
  console.log(
    `wrote ${outPath} (${session.cards.length} cards: deep=${deepCount} baseline=${baselineCount})`,
  );
  if (baselineCount === 0) {
    console.error(
      "WARNING: baseline=0 — this session has no persisted analysis-cache" +
        " findings for this match/round (see runbook Step 0); re-check" +
        " --store/--match/--round before reviewing a degenerate session.",
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
}
