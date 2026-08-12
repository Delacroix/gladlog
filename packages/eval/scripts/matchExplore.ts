/**
 * matchExplore.ts CLI — dumb shell over `../src/explore/{storeAccess,matchExplore}.ts`
 * for the deep-dive review agent to drive interactively. Per the plan's
 * global constraint, this file writes ZERO new logic (it is not covered by
 * `npm run typecheck`, so any logic here would be untested logic) — it only
 * parses `argv`, wires the two calls, and prints their string arrays.
 *
 *   npx tsx packages/eval/scripts/matchExplore.ts pick [--min-duration 120] [--store <dir>]
 *   npx tsx packages/eval/scripts/matchExplore.ts <matchId> [--round N] [--store <dir>] <sub> [--t X | --from A --to B [--step S]]
 *
 * `pick` lists local-library rows (id / kind / 时长 / playerName / result /
 * bracket, tab-separated, header on line 1) via `loadIndex` + `pickRows`. The
 * second form loads one round (`loadLegacyRound`, `--round` is an ARRAY INDEX
 * into `doc.data.rounds`, not `sequenceNumber` — see storeAccess.ts's own
 * header) and hands the trailing `<sub> [flags…]` slice straight to the
 * shared `runQuery` dispatch untouched — this script never re-derives how a
 * subcommand's own flags (`--t`/`--from`/`--to`/`--step`) are parsed.
 *
 * Locating that trailing slice robustly (across `parseArgs`'s `strict:
 * false` misclassifying an unrecognized flag like `--t` as a valueless
 * option rather than a positional — verified interactively) is done via
 * `tokens: true`: the subcommand's *raw* index into the original `args`
 * array is read off its positional token, and everything from that index
 * onward is passed to `runQuery` byte-for-byte.
 */
import { parseArgs } from "node:util";

import { ensureAnalysisData, fmtTime } from "@gladlog/analysis";

import { runQuery } from "../src/explore/matchExplore.js";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  pickRows,
} from "../src/explore/storeAccess.js";

const USAGE = `usage:
  matchExplore.ts pick [--min-duration N] [--store <dir>]
  matchExplore.ts <matchId> [--round N] [--store <dir>] <sub> [--t S | --from S --to S [--step S]]`;

await ensureAnalysisData();

const args = process.argv.slice(2);
const { values, tokens } = parseArgs({
  args,
  options: {
    store: { type: "string" },
    round: { type: "string" },
    "min-duration": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
  tokens: true,
});

const positionalTokens = tokens.filter((t) => t.kind === "positional");
const matchesDir = values.store ?? DEFAULT_MATCH_DIR;

try {
  const first = positionalTokens[0]?.value;
  if (first === undefined) throw new Error(USAGE);

  if (first === "pick") {
    const minDurationS = Number(values["min-duration"] ?? 0);
    const rows = pickRows(loadIndex(matchesDir), { minDurationS });
    const lines = [
      ["id", "kind", "时长", "playerName", "result", "bracket"].join("\t"),
      ...rows.map((r) =>
        [
          r.id,
          r.kind ?? "",
          r.durationS !== undefined ? fmtTime(r.durationS) : "",
          r.playerName ?? "",
          r.result ?? "",
          r.bracket ?? "",
        ].join("\t"),
      ),
    ];
    console.log(lines.join("\n"));
  } else {
    const matchId = first;
    const roundSeq =
      values.round !== undefined ? Number(values.round) : undefined;
    const subToken = positionalTokens[1];
    if (!subToken) throw new Error(USAGE);

    const { legacy } = loadLegacyRound(matchesDir, matchId, roundSeq);
    const queryArgv = args.slice(subToken.index);
    console.log(runQuery(legacy, queryArgv).join("\n"));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
}
