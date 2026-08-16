/**
 * manaCalibrationScan.ts CLI — dumb shell over
 * `../src/explore/candidateCalibration.ts`'s Task 6 (raw-streams calibration)
 * additions for the two raw.txt-consuming candidate builders
 * (`manaPressureEvents`/`manaEfficiencyEvents`,
 * `packages/analysis/src/analysis/candidateFindings.ts`). Sibling to
 * `candidateCalibrationScan.ts` (P1/P2 distillation's own thin CLI) — kept as
 * a SEPARATE file rather than more subcommands bolted onto that one because
 * this tool has a genuinely different per-round cost shape (raw.txt read +
 * `parseRawStreams` per round, not just `match.json`) and a different grid
 * shape (LOW_PCT×MIN_WINDOW_S / FLOOR×MIN_CASTS, not H×crisisHP). Both write
 * no detection/counting logic of their own — every count comes from
 * `candidateCalibration.ts` direct-calling the real production builders
 * (CLAUDE.md shared-predicate rule).
 *
 * Same front-of-terminal discipline as `candidateCalibrationScan.ts`
 * (CLAUDE.md "分批前台"): never backgrounded, `--offset`/`--limit` slices,
 * partial JSONL appended per call so a killed/timed-out batch keeps its
 * progress.
 *
 * Subcommands:
 *   scan       tsx manaCalibrationScan.ts scan --tag <name> [--store DIR] [--offset N] [--limit N]
 *                [--low N] [--window N] [--failed N] [--floor F] [--casts N]
 *                Counts mana-pressure/mana-efficiency at the given thresholds
 *                (omit all four/two -> production module-constant defaults),
 *                PLUS `rawAvailable`/`ownerResolvable` per round. When
 *                mana-pressure fires for a round, ALSO appends that
 *                candidate's own facts (threat/rejected-reason breakdown) to
 *                a sibling `.facts.jsonl` file — cheap because it only
 *                triggers for the (rare) rounds that actually fire, never the
 *                full corpus.
 *   sweep      tsx manaCalibrationScan.ts sweep --tag <name> --kind pressure|efficiency [--store DIR] [--offset N] [--limit N]
 *                Builds each round's context ONCE (raw.txt read once), then
 *                re-counts at every grid cell — cheap, in-memory. `pressure`:
 *                LOW_PCT∈{5,10,15}×MIN_WINDOW_S∈{5,8,12} PLUS a MIN_FAILED
 *                tier row {2,3,5} at the grid's center cell (plan Task 6
 *                verbatim). `efficiency`: FLOOR∈{0.4,0.5,0.6}×MIN_CASTS∈{8,10,15}.
 *   report     tsx manaCalibrationScan.ts report --tag <name> --kind scan|sweep-pressure|sweep-efficiency [--out FILE]
 *   anchor     tsx manaCalibrationScan.ts anchor --matchId <id> [--store DIR]
 *                [--low N] [--window N] [--failed N] [--floor F] [--casts N]
 *                One-off (not corpus-scale) verification print for a single
 *                match — used for the plan's two hard anchors (60ab1e8f must
 *                still fire mana-pressure at the FINAL constants; 0b89beee
 *                stays 0) plus reporting what 60ab's two healers produce for
 *                mana-efficiency.
 *
 * `--tag` namespaces partial files so different runs/kinds never mix (same
 * convention as `candidateCalibrationScan.ts`).
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

import {
  ensureAnalysisData,
  isHealerSpec,
  manaEfficiencyEvents,
  MANA_PRESSURE_LOW_PCT,
  MANA_PRESSURE_MIN_FAILED,
  MANA_PRESSURE_MIN_WINDOW_S,
  parseRawStreams,
  roundDurationSOf,
} from "@gladlog/analysis";

import { resolveEvalHome } from "../src/evalHome.js";
import {
  buildRoundContext,
  type CalibrationSummary,
  countsAtThresholds,
  manaPressureCandidatesAtThresholds,
  type RoundCandidateCounts,
  scanRound,
  summarize,
} from "../src/explore/candidateCalibration.js";
import {
  DEFAULT_MATCH_DIR,
  loadIndex,
  loadLegacyRound,
  readRawText,
} from "../src/explore/storeAccess.js";

const USAGE = `usage:
  manaCalibrationScan.ts scan --tag <name> [--store <dir>] [--offset N] [--limit N] [--low N] [--window N] [--failed N] [--floor F] [--casts N] [--partial-dir <dir>]
  manaCalibrationScan.ts sweep --tag <name> --kind pressure|efficiency [--store <dir>] [--offset N] [--limit N] [--partial-dir <dir>]
  manaCalibrationScan.ts report --tag <name> --kind scan|sweep-pressure|sweep-efficiency [--partial-dir <dir>] [--out <file>]
  manaCalibrationScan.ts anchor --matchId <id> [--store <dir>] [--low N] [--window N] [--failed N] [--floor F] [--casts N]`;

/** Plan Task 6 verbatim: mana-pressure LOW_PCT×MIN_WINDOW_S grid. */
const PRESSURE_LOW_PCT_TIERS = [5, 10, 15] as const;
const PRESSURE_MIN_WINDOW_S_TIERS = [5, 8, 12] as const;
/** MIN_FAILED tiers, held at the grid's CENTER cell (production defaults
 * unless overridden via `--low`/`--window` at sweep time — this script keeps
 * them at the module constants for the sweep, same "one axis moves at a
 * time" discipline `candidateCalibrationScan.ts`'s own threat-window sweep
 * documents). */
const PRESSURE_MIN_FAILED_TIERS = [2, 3, 5] as const;

/** Plan Task 6 verbatim: mana-efficiency FLOOR×MIN_CASTS grid. */
const EFFICIENCY_FLOOR_TIERS = [0.4, 0.5, 0.6] as const;
const EFFICIENCY_MIN_CASTS_TIERS = [8, 10, 15] as const;

function pressureCellKey(lowPct: number, minWindowS: number): string {
  return `L${lowPct}W${minWindowS}`;
}
function failedCellKey(minFailed: number): string {
  return `F${minFailed}`;
}
function efficiencyCellKey(floor: number, minCasts: number): string {
  return `Fl${floor}C${minCasts}`;
}

function scanFile(partialDir: string, tag: string, kind: string): string {
  return join(partialDir, `mana-calibration-${kind}-${tag}.rows.jsonl`);
}
function factsFile(partialDir: string, tag: string): string {
  return join(partialDir, `mana-calibration-scan-${tag}.facts.jsonl`);
}
function processedFile(partialDir: string, tag: string, kind: string): string {
  return join(partialDir, `mana-calibration-${kind}-${tag}.processed.txt`);
}
function errorsFile(partialDir: string, tag: string, kind: string): string {
  return join(partialDir, `mana-calibration-${kind}-${tag}.errors.txt`);
}

function readProcessedIds(
  partialDir: string,
  tag: string,
  kind: string,
): Set<string> {
  const f = processedFile(partialDir, tag, kind);
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/** Mirrors `candidateCalibrationScan.ts`'s own `countRounds` — reads just far
 * enough into `match.json` to get a shuffle round count without loading the
 * full round twice. */
function countRounds(matchesDir: string, matchId: string): number | undefined {
  const doc = JSON.parse(
    readFileSync(join(matchesDir, matchId, "match.json"), "utf8"),
  ) as { kind?: string; data?: { rounds?: unknown[] } };
  if (doc.kind !== "shuffle") return undefined;
  return doc.data?.rounds?.length ?? 0;
}

interface PressureSweepRow {
  matchId: string;
  roundSeq?: number;
  grid: Record<string, number>;
  failedTiers: Record<string, number>;
  rawAvailable: boolean;
}
interface EfficiencySweepRow {
  matchId: string;
  roundSeq?: number;
  grid: Record<string, number>;
}

async function runScan(args: {
  store: string;
  tag: string;
  offset: number;
  limit: number | undefined;
  partialDir: string;
  thresholds: {
    lowPct?: number;
    minWindowS?: number;
    minFailed?: number;
    floor?: number;
    minCasts?: number;
  };
}): Promise<void> {
  await ensureAnalysisData();
  mkdirSync(args.partialDir, { recursive: true });

  const allRows = loadIndex(args.store);
  const already = readProcessedIds(args.partialDir, args.tag, "scan");
  const pending = allRows.filter((r) => !already.has(r.id));
  const slice =
    args.limit !== undefined
      ? pending.slice(args.offset, args.offset + args.limit)
      : pending.slice(args.offset);

  console.log(
    `[manaCalibrationScan:scan] tag=${args.tag} total=${allRows.length} already-done=${already.size} this-run=${slice.length} thresholds=${JSON.stringify(args.thresholds)}`,
  );

  const opts = {
    manaPressureThresholds: {
      lowPct: args.thresholds.lowPct,
      minWindowS: args.thresholds.minWindowS,
      minFailed: args.thresholds.minFailed,
    },
    manaEfficiencyThresholds: {
      floor: args.thresholds.floor,
      minCasts: args.thresholds.minCasts,
    },
  };

  let errors = 0;
  let skippedNoTeams = 0;
  let firedFacts = 0;
  for (const row of slice) {
    try {
      const roundCount = countRounds(args.store, row.id);
      const roundSeqs: (number | undefined)[] =
        roundCount === undefined ? [undefined] : [...Array(roundCount).keys()];
      const rawText = readRawText(args.store, row.id);
      for (const roundSeq of roundSeqs) {
        const { legacy } = loadLegacyRound(args.store, row.id, roundSeq);
        const rawStreams = parseRawStreams(
          rawText,
          legacy.startTime,
          roundDurationSOf(legacy.startTime, legacy.endTime),
        );
        const counts = scanRound(row.id, legacy, roundSeq, opts, rawStreams);
        if (counts === null) {
          skippedNoTeams++;
          continue;
        }
        appendFileSync(
          scanFile(args.partialDir, args.tag, "scan"),
          JSON.stringify(counts) + "\n",
        );
        if (counts.manaPressureCapped > 0) {
          const ctx = buildRoundContext(row.id, legacy, roundSeq, rawStreams);
          if (ctx) {
            const evts = manaPressureCandidatesAtThresholds(
              ctx,
              opts.manaPressureThresholds,
            );
            for (const e of evts) {
              appendFileSync(
                factsFile(args.partialDir, args.tag),
                JSON.stringify({
                  matchId: row.id,
                  roundSeq,
                  threat: e.facts.threat,
                  rejectedCount: e.facts.rejectedCount,
                  rejected: e.facts.rejected,
                }) + "\n",
              );
              firedFacts++;
            }
          }
        }
      }
      appendFileSync(
        processedFile(args.partialDir, args.tag, "scan"),
        row.id + "\n",
      );
    } catch (err) {
      errors++;
      appendFileSync(
        errorsFile(args.partialDir, args.tag, "scan"),
        `${row.id}\t${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  console.log(
    `[manaCalibrationScan:scan] done this-run=${slice.length} errors=${errors} skipped(no-teams)=${skippedNoTeams} firedFacts=${firedFacts} remaining=${pending.length - slice.length}`,
  );
}

async function runSweep(args: {
  store: string;
  tag: string;
  kind: "pressure" | "efficiency";
  offset: number;
  limit: number | undefined;
  partialDir: string;
}): Promise<void> {
  await ensureAnalysisData();
  mkdirSync(args.partialDir, { recursive: true });

  const kindTag = `sweep-${args.kind}`;
  const allRows = loadIndex(args.store);
  const already = readProcessedIds(args.partialDir, args.tag, kindTag);
  const pending = allRows.filter((r) => !already.has(r.id));
  const slice =
    args.limit !== undefined
      ? pending.slice(args.offset, args.offset + args.limit)
      : pending.slice(args.offset);

  console.log(
    `[manaCalibrationScan:sweep:${args.kind}] tag=${args.tag} total=${allRows.length} already-done=${already.size} this-run=${slice.length}`,
  );

  let errors = 0;
  let skippedNoTeams = 0;
  for (const row of slice) {
    try {
      const roundCount = countRounds(args.store, row.id);
      const roundSeqs: (number | undefined)[] =
        roundCount === undefined ? [undefined] : [...Array(roundCount).keys()];
      const rawText =
        args.kind === "pressure" ? readRawText(args.store, row.id) : null;
      for (const roundSeq of roundSeqs) {
        const { legacy } = loadLegacyRound(args.store, row.id, roundSeq);
        const rawStreams =
          args.kind === "pressure"
            ? parseRawStreams(
                rawText,
                legacy.startTime,
                roundDurationSOf(legacy.startTime, legacy.endTime),
              )
            : undefined;
        const ctx = buildRoundContext(row.id, legacy, roundSeq, rawStreams);
        if (ctx === null) {
          skippedNoTeams++;
          continue;
        }
        if (args.kind === "pressure") {
          const grid: Record<string, number> = {};
          for (const lowPct of PRESSURE_LOW_PCT_TIERS) {
            for (const minWindowS of PRESSURE_MIN_WINDOW_S_TIERS) {
              grid[pressureCellKey(lowPct, minWindowS)] = countsAtThresholds(
                ctx,
                { manaPressureThresholds: { lowPct, minWindowS } },
              ).manaPressureCapped;
            }
          }
          const failedTiers: Record<string, number> = {};
          for (const minFailed of PRESSURE_MIN_FAILED_TIERS) {
            failedTiers[failedCellKey(minFailed)] = countsAtThresholds(ctx, {
              manaPressureThresholds: {
                lowPct: MANA_PRESSURE_LOW_PCT,
                minWindowS: MANA_PRESSURE_MIN_WINDOW_S,
                minFailed,
              },
            }).manaPressureCapped;
          }
          const sweepRow: PressureSweepRow = {
            matchId: row.id,
            roundSeq,
            grid,
            failedTiers,
            rawAvailable: ctx.rawStreams.available,
          };
          appendFileSync(
            scanFile(args.partialDir, args.tag, kindTag),
            JSON.stringify(sweepRow) + "\n",
          );
        } else {
          const grid: Record<string, number> = {};
          for (const floor of EFFICIENCY_FLOOR_TIERS) {
            for (const minCasts of EFFICIENCY_MIN_CASTS_TIERS) {
              grid[efficiencyCellKey(floor, minCasts)] = countsAtThresholds(
                ctx,
                { manaEfficiencyThresholds: { floor, minCasts } },
              ).manaEfficiencyCount;
            }
          }
          const sweepRow: EfficiencySweepRow = {
            matchId: row.id,
            roundSeq,
            grid,
          };
          appendFileSync(
            scanFile(args.partialDir, args.tag, kindTag),
            JSON.stringify(sweepRow) + "\n",
          );
        }
      }
      appendFileSync(
        processedFile(args.partialDir, args.tag, kindTag),
        row.id + "\n",
      );
    } catch (err) {
      errors++;
      appendFileSync(
        errorsFile(args.partialDir, args.tag, kindTag),
        `${row.id}\t${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  console.log(
    `[manaCalibrationScan:sweep:${args.kind}] done this-run=${slice.length} errors=${errors} skipped(no-teams)=${skippedNoTeams} remaining=${pending.length - slice.length}`,
  );
}

function loadScanRows(partialDir: string, tag: string): RoundCandidateCounts[] {
  const f = scanFile(partialDir, tag, "scan");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RoundCandidateCounts);
}

function loadFactsRows(
  partialDir: string,
  tag: string,
): Array<{
  matchId: string;
  roundSeq?: number;
  threat: string;
  rejectedCount: string;
  rejected: string;
}> {
  const f = factsFile(partialDir, tag);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function loadPressureSweepRows(
  partialDir: string,
  tag: string,
): PressureSweepRow[] {
  const f = scanFile(partialDir, tag, "sweep-pressure");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PressureSweepRow);
}

function loadEfficiencySweepRows(
  partialDir: string,
  tag: string,
): EfficiencySweepRow[] {
  const f = scanFile(partialDir, tag, "sweep-efficiency");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EfficiencySweepRow);
}

function formatTypeRow(
  name: string,
  t: CalibrationSummary["perType"]["manaPressure"],
): string {
  return `| ${name} | ${t.occurrenceRatePct.toFixed(1)}% | ${t.meanCappedPerRound.toFixed(3)} | ${t.meanRawPerRound.toFixed(3)} |`;
}

function formatScanReport(tag: string, partialDir: string): string {
  const rows = loadScanRows(partialDir, tag);
  const matches = readProcessedIds(partialDir, tag, "scan").size;
  const errFile = errorsFile(partialDir, tag, "scan");
  const errors = existsSync(errFile)
    ? readFileSync(errFile, "utf8").split("\n").filter(Boolean).length
    : 0;
  const s = summarize(rows);
  const facts = loadFactsRows(partialDir, tag);
  const threatYes = facts.filter((f) => f.threat === "yes").length;
  const reasonCounts = new Map<string, number>();
  for (const f of facts) {
    // facts.rejected is `aggregateReasonCounts`'s own formatted string
    // ("reasonA×N、reasonB×M", Chinese enumeration comma — candidateFindings.
    // ts:115-125's own `.join("、")`, every entry always carries `×N`, never
    // a bare reason) — split back into per-reason tallies for the corpus-wide
    // reason-mix breakdown (plan Task 6 deliverable).
    for (const part of f.rejected.split("、")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = /^(.*)×(\d+)$/.exec(trimmed);
      const reason = m ? m[1]! : trimmed;
      const count = m ? Number(m[2]) : 1;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + count);
    }
  }
  const lines = [
    `# mana calibration scan — ${tag}`,
    "",
    `matches processed: ${matches} (errored/skipped: ${errors})`,
    `rounds scanned: ${s.roundsScanned}`,
    `raw.txt available: ${s.rawAvailableRatePct.toFixed(1)}%`,
    `owner resolvable (production round-inclusion gate): ${s.productionGated.roundsOwnerResolvable}/${s.roundsScanned} (${s.roundsScanned === 0 ? "0.0" : ((s.productionGated.roundsOwnerResolvable / s.roundsScanned) * 100).toFixed(1)}%)`,
    "",
    "## per-type (naive denominator = every scanned round)",
    "",
    "| type | 发生率 (% rounds ≥1) | 场均条数 (capped) | 场均条数 (raw, pre-cap) |",
    "|---|---|---|---|",
    formatTypeRow("mana-pressure", s.perType.manaPressure),
    formatTypeRow("mana-efficiency", s.perType.manaEfficiency),
    "",
    "## per-type (production-gated denominator = ownerResolvable rounds only, P1/P2 owner-phantom lesson)",
    "",
    "| type | 发生率 (% rounds ≥1) | 场均条数 (capped) | 场均条数 (raw, pre-cap) |",
    "|---|---|---|---|",
    formatTypeRow("mana-pressure", s.productionGated.manaPressure),
    formatTypeRow("mana-efficiency", s.productionGated.manaEfficiency),
    "",
    "## mana-pressure fired-candidate breakdown",
    "",
    `fired candidates: ${facts.length}`,
    `threat-active share: ${facts.length === 0 ? "n/a" : `${threatYes}/${facts.length} (${((threatYes / facts.length) * 100).toFixed(1)}%)`}`,
    "",
    "| rejected-cast reason | count |",
    "|---|---|",
    ...[...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `| ${reason} | ${count} |`),
    "",
  ];
  return lines.join("\n");
}

function formatPressureSweepReport(tag: string, partialDir: string): string {
  const rows = loadPressureSweepRows(partialDir, tag);
  const matches = readProcessedIds(partialDir, tag, "sweep-pressure").size;
  const n = rows.length;
  const rawAvail = rows.filter((r) => r.rawAvailable).length;
  const lines = [
    `# mana-pressure sensitivity sweep — ${tag}`,
    "",
    `matches processed: ${matches}`,
    `rounds swept: ${n} (raw.txt available: ${n === 0 ? "0.0" : ((rawAvail / n) * 100).toFixed(1)}%)`,
    "",
    `## LOW_PCT × MIN_WINDOW_S (场均条数/round, capped, MIN_FAILED=${MANA_PRESSURE_MIN_FAILED})`,
    "",
    `| lowPct\\minWindowS | ${PRESSURE_MIN_WINDOW_S_TIERS.join("s | ")}s |`,
    `|---|${PRESSURE_MIN_WINDOW_S_TIERS.map(() => "---").join("|")}|`,
  ];
  for (const lowPct of PRESSURE_LOW_PCT_TIERS) {
    const cells = PRESSURE_MIN_WINDOW_S_TIERS.map((minWindowS) => {
      const key = pressureCellKey(lowPct, minWindowS);
      const mean =
        n === 0 ? 0 : rows.reduce((a, r) => a + (r.grid[key] ?? 0), 0) / n;
      return mean.toFixed(3);
    });
    lines.push(`| ${lowPct}% | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    `## MIN_FAILED tiers (场均条数/round, capped, at LOW_PCT=${MANA_PRESSURE_LOW_PCT}%/MIN_WINDOW_S=${MANA_PRESSURE_MIN_WINDOW_S}s)`,
  );
  lines.push("");
  lines.push("| minFailed | 场均条数 |");
  lines.push("|---|---|");
  for (const minFailed of PRESSURE_MIN_FAILED_TIERS) {
    const key = failedCellKey(minFailed);
    const mean =
      n === 0 ? 0 : rows.reduce((a, r) => a + (r.failedTiers[key] ?? 0), 0) / n;
    lines.push(`| ${minFailed} | ${mean.toFixed(3)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatEfficiencySweepReport(tag: string, partialDir: string): string {
  const rows = loadEfficiencySweepRows(partialDir, tag);
  const matches = readProcessedIds(partialDir, tag, "sweep-efficiency").size;
  const n = rows.length;
  const lines = [
    `# mana-efficiency sensitivity sweep — ${tag}`,
    "",
    `matches processed: ${matches}`,
    `rounds swept: ${n}`,
    "",
    "## FLOOR × MIN_CASTS (场均条数/round)",
    "",
    `| floor\\minCasts | ${EFFICIENCY_MIN_CASTS_TIERS.join(" | ")} |`,
    `|---|${EFFICIENCY_MIN_CASTS_TIERS.map(() => "---").join("|")}|`,
  ];
  for (const floor of EFFICIENCY_FLOOR_TIERS) {
    const cells = EFFICIENCY_MIN_CASTS_TIERS.map((minCasts) => {
      const key = efficiencyCellKey(floor, minCasts);
      const mean =
        n === 0 ? 0 : rows.reduce((a, r) => a + (r.grid[key] ?? 0), 0) / n;
      return mean.toFixed(3);
    });
    lines.push(`| ${floor} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function runAnchor(args: {
  store: string;
  matchId: string;
  thresholds: {
    lowPct?: number;
    minWindowS?: number;
    minFailed?: number;
    floor?: number;
    minCasts?: number;
  };
}): Promise<void> {
  await ensureAnalysisData();
  const roundCount = countRounds(args.store, args.matchId);
  const roundSeqs: (number | undefined)[] =
    roundCount === undefined ? [undefined] : [...Array(roundCount).keys()];
  const rawText = readRawText(args.store, args.matchId);
  const opts = {
    manaPressureThresholds: {
      lowPct: args.thresholds.lowPct,
      minWindowS: args.thresholds.minWindowS,
      minFailed: args.thresholds.minFailed,
    },
    manaEfficiencyThresholds: {
      floor: args.thresholds.floor,
      minCasts: args.thresholds.minCasts,
    },
  };
  for (const roundSeq of roundSeqs) {
    const { legacy } = loadLegacyRound(args.store, args.matchId, roundSeq);
    const rawStreams = parseRawStreams(
      rawText,
      legacy.startTime,
      roundDurationSOf(legacy.startTime, legacy.endTime),
    );
    console.log(
      `[anchor] ${args.matchId} roundSeq=${roundSeq} rawAvailable=${rawStreams.available} manaSamples=${rawStreams.manaSamples.length} castFailed=${rawStreams.castFailed.length}`,
    );
    const counts = scanRound(args.matchId, legacy, roundSeq, opts, rawStreams);
    if (counts === null) {
      console.log(`[anchor]   no friendly+enemy player pair — skipped`);
      continue;
    }
    console.log(
      `[anchor]   manaPressure raw=${counts.manaPressureRaw} capped=${counts.manaPressureCapped} manaEfficiency=${counts.manaEfficiencyCount} ownerResolvable=${counts.ownerResolvable}`,
    );
    const ctx = buildRoundContext(args.matchId, legacy, roundSeq, rawStreams);
    if (ctx) {
      const evts = manaPressureCandidatesAtThresholds(
        ctx,
        opts.manaPressureThresholds,
      );
      for (const e of evts) {
        console.log(`[anchor]   mana-pressure: ${JSON.stringify(e.facts)}`);
      }
      // Production's own wiring (candidateFindings.ts's `teamPlayEvents`)
      // only ever considers ONE friendly healer (`friends.find(isHealerSpec)`,
      // first match) for mana-efficiency too — `counts.manaEfficiencyCount`
      // above already reports exactly that. This loop is diagnostic-only
      // (plan Task 6 item: "report what 60ab's two healers produce", no
      // pass/fail anchor ruled either way) — it calls the SAME real builder
      // directly for EVERY healer on EITHER side (friendly AND enemy — a
      // match's "two healers" plan language means one per side here, since
      // 60ab1e8f itself has exactly one friendly healer), so both are
      // visible even though production only ever surfaces the friendly one.
      const healers = [...ctx.friends, ...ctx.enemies].filter((u) =>
        isHealerSpec(u.spec),
      );
      for (const h of healers) {
        const hEvts = manaEfficiencyEvents(
          h,
          h,
          legacy.startTime,
          opts.manaEfficiencyThresholds,
        );
        console.log(
          `[anchor]   mana-efficiency healer=${h.name}: ${hEvts.length} candidate(s)${hEvts[0] ? ` ${JSON.stringify(hEvts[0].facts)}` : ""}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      store: { type: "string" },
      tag: { type: "string" },
      kind: { type: "string" },
      matchId: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      "partial-dir": { type: "string" },
      out: { type: "string" },
      low: { type: "string" },
      window: { type: "string" },
      failed: { type: "string" },
      floor: { type: "string" },
      casts: { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  if (!cmd) throw new Error(USAGE);

  const store = values.store ?? DEFAULT_MATCH_DIR;
  const evalHome = resolveEvalHome();
  const partialDir =
    values["partial-dir"] ??
    join(evalHome, "reports", "mana-calibration-partial");

  const thresholds = {
    lowPct: values.low ? Number(values.low) : undefined,
    minWindowS: values.window ? Number(values.window) : undefined,
    minFailed: values.failed ? Number(values.failed) : undefined,
    floor: values.floor ? Number(values.floor) : undefined,
    minCasts: values.casts ? Number(values.casts) : undefined,
  };

  if (cmd === "scan") {
    if (!values.tag) throw new Error(USAGE);
    await runScan({
      store,
      tag: values.tag,
      offset: values.offset ? Number(values.offset) : 0,
      limit: values.limit ? Number(values.limit) : undefined,
      partialDir,
      thresholds,
    });
  } else if (cmd === "sweep") {
    if (!values.tag) throw new Error(USAGE);
    if (values.kind !== "pressure" && values.kind !== "efficiency") {
      throw new Error(`sweep requires --kind pressure|efficiency\n${USAGE}`);
    }
    await runSweep({
      store,
      tag: values.tag,
      kind: values.kind,
      offset: values.offset ? Number(values.offset) : 0,
      limit: values.limit ? Number(values.limit) : undefined,
      partialDir,
    });
  } else if (cmd === "report") {
    if (!values.tag) throw new Error(USAGE);
    if (
      values.kind !== "scan" &&
      values.kind !== "sweep-pressure" &&
      values.kind !== "sweep-efficiency"
    ) {
      throw new Error(
        `report requires --kind scan|sweep-pressure|sweep-efficiency\n${USAGE}`,
      );
    }
    const report =
      values.kind === "scan"
        ? formatScanReport(values.tag, partialDir)
        : values.kind === "sweep-pressure"
          ? formatPressureSweepReport(values.tag, partialDir)
          : formatEfficiencySweepReport(values.tag, partialDir);
    const out =
      values.out ??
      join(
        evalHome,
        "reports",
        `mana-calibration-${values.kind}-${values.tag}.md`,
      );
    writeFileSync(out, report);
    console.log(`[manaCalibrationScan:report] written: ${out}`);
  } else if (cmd === "anchor") {
    if (!values.matchId) throw new Error(USAGE);
    await runAnchor({ store, matchId: values.matchId, thresholds });
  } else {
    throw new Error(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
});
