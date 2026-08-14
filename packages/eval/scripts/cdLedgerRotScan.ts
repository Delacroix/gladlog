/**
 * cdLedgerRotScan.ts CLI — dumb shell over `../src/explore/cdLedgerRot.ts`
 * for the Task 7 (B3) corpus-wide "cd-ledger-rot" scan. Per the plan's
 * global constraint this file writes no detection logic of its own (that
 * lives in `cdLedgerRot.ts`, unit-tested) — it only walks the local match
 * library, loads each round via the same `storeAccess.ts` loader
 * `matchExplore.ts` uses, and hands each one to `scanRoundForCdLedgerRot`.
 *
 * A full-corpus run is slow (1000+ matches, each a JSON parse +
 * `toLegacyMatch` conversion + a cooldown extraction per unit) — this script
 * is meant to be invoked repeatedly in `--offset/--limit` slices from a
 * front-of-terminal shell loop (never backgrounded: CLAUDE.md's "分批前台"
 * discipline), appending to a partial JSONL file each call so a killed/timed
 * -out batch doesn't lose prior progress.
 *
 *   scan:   tsx cdLedgerRotScan.ts scan --tag before [--store DIR] [--offset N] [--limit N] [--partial-dir DIR]
 *   report: tsx cdLedgerRotScan.ts report --tag before [--partial-dir DIR] [--out FILE]
 *
 * `--tag` namespaces the partial files (e.g. "before"/"after" for a
 * pre/post-fix comparison) so two scan generations never mix in one file.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ensureAnalysisData } from "@gladlog/analysis";

import { resolveEvalHome } from "../src/evalHome.js";
import {
  type CdLedgerRotHit,
  dedupeHits,
  formatReport,
  scanRoundForCdLedgerRot,
} from "../src/explore/cdLedgerRot.js";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
} from "../src/explore/storeAccess.js";

const USAGE = `usage:
  cdLedgerRotScan.ts scan --tag <name> [--store <dir>] [--offset N] [--limit N] [--partial-dir <dir>]
  cdLedgerRotScan.ts report --tag <name> [--partial-dir <dir>] [--out <file>]`;

function hitsFile(partialDir: string, tag: string): string {
  return join(partialDir, `cd-ledger-rot-${tag}.hits.jsonl`);
}
function processedFile(partialDir: string, tag: string): string {
  return join(partialDir, `cd-ledger-rot-${tag}.processed.txt`);
}
function errorsFile(partialDir: string, tag: string): string {
  return join(partialDir, `cd-ledger-rot-${tag}.errors.txt`);
}

function readProcessedIds(partialDir: string, tag: string): Set<string> {
  const f = processedFile(partialDir, tag);
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

async function runScan(args: {
  store: string;
  tag: string;
  offset: number;
  limit: number | undefined;
  partialDir: string;
}): Promise<void> {
  await ensureAnalysisData();
  mkdirSync(args.partialDir, { recursive: true });

  const allRows = loadIndex(args.store);
  const already = readProcessedIds(args.partialDir, args.tag);
  const pending = allRows.filter((r) => !already.has(r.id));
  const slice =
    args.limit !== undefined
      ? pending.slice(args.offset, args.offset + args.limit)
      : pending.slice(args.offset);

  console.log(
    `[cdLedgerRotScan] tag=${args.tag} total=${allRows.length} already-done=${already.size} this-run=${slice.length}`,
  );

  let errors = 0;
  for (const row of slice) {
    try {
      // Shuffle docs carry multiple rounds; scan every one. Match docs are
      // single-round (loadLegacyRound's own roundSeq=undefined path).
      const roundCount = countRounds(args.store, row.id);
      const roundSeqs: (number | undefined)[] =
        roundCount === undefined ? [undefined] : [...Array(roundCount).keys()];

      for (const roundSeq of roundSeqs) {
        const { legacy } = loadLegacyRound(args.store, row.id, roundSeq);
        const hits = scanRoundForCdLedgerRot(row.id, legacy, roundSeq);
        if (hits.length) {
          appendFileSync(
            hitsFile(args.partialDir, args.tag),
            hits.map((h) => JSON.stringify(h)).join("\n") + "\n",
          );
        }
      }
      appendFileSync(processedFile(args.partialDir, args.tag), row.id + "\n");
    } catch (err) {
      errors++;
      appendFileSync(
        errorsFile(args.partialDir, args.tag),
        `${row.id}\t${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  console.log(
    `[cdLedgerRotScan] done this-run=${slice.length} errors=${errors} remaining=${pending.length - slice.length}`,
  );
}

/** Reads `match.json`'s envelope just far enough to get the shuffle round
 * count (mirrors `loadLegacyRound`'s own kind/rounds parsing — kept local
 * since this script, not `storeAccess.ts`, is the one that needs to iterate
 * every round rather than load exactly one). Returns undefined for a
 * non-shuffle ("match") doc, which `loadLegacyRound` treats as single-round. */
function countRounds(matchesDir: string, matchId: string): number | undefined {
  const doc = JSON.parse(
    readFileSync(join(matchesDir, matchId, "match.json"), "utf8"),
  ) as { kind?: string; data?: { rounds?: unknown[] } };
  if (doc.kind !== "shuffle") return undefined;
  return doc.data?.rounds?.length ?? 0;
}

function runReport(args: {
  tag: string;
  partialDir: string;
  out: string;
}): void {
  const hf = hitsFile(args.partialDir, args.tag);
  const hits: CdLedgerRotHit[] = existsSync(hf)
    ? readFileSync(hf, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CdLedgerRotHit)
    : [];
  const matchesScanned = readProcessedIds(args.partialDir, args.tag).size;
  const ef = errorsFile(args.partialDir, args.tag);
  const errors = existsSync(ef)
    ? readFileSync(ef, "utf8").split("\n").filter(Boolean).length
    : 0;

  const report = formatReport({ tag: args.tag, matchesScanned, errors, hits });
  writeFileSync(args.out, report);
  console.log(
    `[cdLedgerRotScan] report written: ${args.out} (matches=${matchesScanned} errors=${errors} hits=${dedupeHits(hits).length} raw-lines=${hits.length})`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      store: { type: "string" },
      tag: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      "partial-dir": { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  if (!cmd || !values.tag) throw new Error(USAGE);

  const store = values.store ?? DEFAULT_MATCH_DIR;
  const evalHome = resolveEvalHome();
  const partialDir =
    values["partial-dir"] ?? join(evalHome, "reports", "cd-ledger-rot-partial");

  if (cmd === "scan") {
    await runScan({
      store,
      tag: values.tag,
      offset: values.offset ? Number(values.offset) : 0,
      limit: values.limit ? Number(values.limit) : undefined,
      partialDir,
    });
  } else if (cmd === "report") {
    runReport({
      tag: values.tag,
      partialDir,
      out:
        values.out ??
        join(evalHome, "reports", `cd-ledger-rot-${values.tag}.md`),
    });
  } else {
    throw new Error(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
});
