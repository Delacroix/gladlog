/**
 * auraDoubleCloseScan.ts CLI — dumb shell over
 * `../src/explore/auraDoubleClose.ts` for the BACKLOG #28 corpus measurement
 * (`buildAuraIntervals` double-close phantom-interval bug). Mirrors
 * `cdLedgerRotScan.ts`'s batching/partial-persistence shape exactly: walks
 * the local match library in `--offset/--limit` slices, appends hits to a
 * JSONL partial file per call so a killed/timed-out batch never loses prior
 * progress (CLAUDE.md "分批前台" discipline — never backgrounded).
 *
 *   scan:   tsx auraDoubleCloseScan.ts scan --tag before [--store DIR] [--offset N] [--limit N] [--partial-dir DIR]
 *   report: tsx auraDoubleCloseScan.ts report --tag before [--partial-dir DIR] [--out FILE]
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
  type DoubleCloseHit,
  scanRoundForDoubleClose,
} from "../src/explore/auraDoubleClose.js";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
} from "../src/explore/storeAccess.js";

const USAGE = `usage:
  auraDoubleCloseScan.ts scan --tag <name> [--store <dir>] [--offset N] [--limit N] [--partial-dir <dir>]
  auraDoubleCloseScan.ts report --tag <name> [--partial-dir <dir>] [--out <file>]`;

function hitsFile(partialDir: string, tag: string): string {
  return join(partialDir, `aura-double-close-${tag}.hits.jsonl`);
}
function processedFile(partialDir: string, tag: string): string {
  return join(partialDir, `aura-double-close-${tag}.processed.txt`);
}
function errorsFile(partialDir: string, tag: string): string {
  return join(partialDir, `aura-double-close-${tag}.errors.txt`);
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

function countRounds(matchesDir: string, matchId: string): number | undefined {
  const doc = JSON.parse(
    readFileSync(join(matchesDir, matchId, "match.json"), "utf8"),
  ) as { kind?: string; data?: { rounds?: unknown[] } };
  if (doc.kind !== "shuffle") return undefined;
  return doc.data?.rounds?.length ?? 0;
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
    `[auraDoubleCloseScan] tag=${args.tag} total=${allRows.length} already-done=${already.size} this-run=${slice.length}`,
  );

  let errors = 0;
  for (const row of slice) {
    try {
      const roundCount = countRounds(args.store, row.id);
      const roundSeqs: (number | undefined)[] =
        roundCount === undefined ? [undefined] : [...Array(roundCount).keys()];

      for (const roundSeq of roundSeqs) {
        const { legacy } = loadLegacyRound(args.store, row.id, roundSeq);
        const hits = scanRoundForDoubleClose(row.id, legacy, roundSeq);
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
    `[auraDoubleCloseScan] done this-run=${slice.length} errors=${errors} remaining=${pending.length - slice.length}`,
  );
}

function runReport(args: {
  tag: string;
  partialDir: string;
  out: string;
}): void {
  const hf = hitsFile(args.partialDir, args.tag);
  let hits: DoubleCloseHit[] = existsSync(hf)
    ? readFileSync(hf, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as DoubleCloseHit)
    : [];
  const matchesScanned = readProcessedIds(args.partialDir, args.tag).size;
  const ef = errorsFile(args.partialDir, args.tag);
  const errors = existsSync(ef)
    ? readFileSync(ef, "utf8").split("\n").filter(Boolean).length
    : 0;

  // Two `scan --tag full` invocations briefly overlapped mid-run (each
  // computed its own "pending" slice off the processed-file snapshot before
  // the other's writes landed), so a handful of matches got scanned twice
  // and their hits appended twice. The scan itself is a pure function of
  // (matchId, roundSeq, unit, log) — a genuine duplicate hit is byte-identical
  // JSON — so dedupe by exact JSON equality before counting anything.
  const seen = new Set<string>();
  const dedupedHits: DoubleCloseHit[] = [];
  for (const h of hits) {
    const k = JSON.stringify(h);
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedHits.push(h);
  }
  hits = dedupedHits;

  const matchesWithHits = new Set(hits.map((h) => h.matchId));
  const gaps = hits
    .map((h) => h.gapSincePriorCloseS)
    .filter((g): g is number => g !== null);
  const buckets = [0.01, 0.1, 0.5, 1, 2, 5, 10, 30];
  const bucketCounts = buckets.map(
    (b) => gaps.filter((g) => g >= 0 && g <= b).length,
  );
  const noPrior = hits.length - gaps.length;
  const negative = gaps.filter((g) => g < 0).length;

  const lines = [
    `# aura-double-close scan report (tag=${args.tag})`,
    "",
    `matches scanned: ${matchesScanned}`,
    `errors: ${errors}`,
    `fallback-branch triggers (total): ${hits.length}`,
    `matches with >=1 fallback trigger: ${matchesWithHits.size}`,
    `fallback triggers with NO prior close for spellId (genuine "already up before pull"): ${noPrior}`,
    `fallback triggers with a prior close at a NEGATIVE gap (out-of-order timestamps, should not happen): ${negative}`,
    "",
    "gap-since-prior-close histogram (cumulative, seconds):",
    ...buckets.map((b, i) => `  <= ${b}s: ${bucketCounts[i]}`),
    "",
    "sample hits with gap <= 2s (up to 30):",
    ...hits
      .filter(
        (h) =>
          h.gapSincePriorCloseS !== null &&
          h.gapSincePriorCloseS >= 0 &&
          h.gapSincePriorCloseS <= 2,
      )
      .slice(0, 30)
      .map(
        (h) =>
          `  ${h.matchId}${h.roundSeq !== undefined ? `#${h.roundSeq}` : ""} ${h.unitName} spell=${h.spellName}(${h.spellId}) ${h.closeEvent} at=${h.atS.toFixed(3)}s gap=${h.gapSincePriorCloseS!.toFixed(3)}s`,
      ),
  ];

  writeFileSync(args.out, lines.join("\n") + "\n");
  console.log(`[auraDoubleCloseScan] report written: ${args.out}`);
  console.log(lines.slice(0, 12).join("\n"));
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
    values["partial-dir"] ??
    join(evalHome, "reports", "aura-double-close-partial");

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
        join(evalHome, "reports", `aura-double-close-${values.tag}.md`),
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
