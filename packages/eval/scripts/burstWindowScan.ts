/**
 * burstWindowScan.ts — GH #60 phase 1 corpus scan for the enemy-burst-window
 * decision points.
 *
 * Same shape (and much of the same plumbing) as `behaviorPriorScan.ts`: one
 * row per bounded burst window, produced by the SHARED predicate
 * `packages/analysis/src/analysis/burstWindowDecisionPoints.ts` — the scan
 * computes no window, no response and no feasibility logic of its own, so the
 * reference table it emits and whatever the product later says are, by
 * construction, about the same windows (CLAUDE.md shared-predicate rule).
 *
 *   scan        tsx burstWindowScan.ts scan --manifest <file> --ledger <dir>
 *                 --out <file.jsonl> [--offset N] [--limit N]
 *   sweep       tsx burstWindowScan.ts sweep --manifest <file> --ledger <dir>
 *                 [--limit N]           # lapse floor × lapse seconds grid
 *   report      tsx burstWindowScan.ts report --in <file.jsonl>
 *   emit-table  tsx burstWindowScan.ts emit-table --in <file.jsonl>
 *                 --out <file.json> [--corpus <label>]
 *
 * `emit-table` writes through a temp file and copies it into place: never
 * redirect `>` straight into the imported json — a crashed script truncates
 * the file that the product imports.
 */
import { ensureAnalysisData } from "@gladlog/analysis";
import {
  boundedBurstSegments,
  BURST_LAPSE_DMG_PCT_PER_S,
  BURST_RESPONSE_WINDOW_SEC,
  BURST_LAPSE_SECONDS,
  type BurstWindowDecisionPoint,
  burstWindowDecisionPoints,
} from "@gladlog/analysis/src/analysis/burstWindowDecisionPoints";
import { lookupBurstWindowPrior } from "@gladlog/analysis/src/data/burstWindowPrior";
import { PATCH_121_GOLIVE_EPOCH_MS } from "@gladlog/analysis/src/utils/drAnalysis";
import { reconstructEnemyCDTimeline } from "@gladlog/analysis/src/utils/enemyCDs";
import { fmtTime } from "@gladlog/analysis/src/utils/renderGrid";
import { GladLogParser } from "@gladlog/parser";
import { toLegacyMatch, toLegacyShuffle } from "@gladlog/parser-compat";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { gunzipSync } from "zlib";

import {
  buildBurstWindowPriorTable,
  type BurstWindowPriorRow,
} from "../src/explore/burstWindowPriorTable";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => Number(flag(f) ?? d);

/** one row per bounded burst window; `point` is the shared predicate's own
 * output, trimmed of the per-friendly outcome detail the table never reads */
interface Row {
  kind?: undefined;
  matchId: string;
  seq: number | null;
  bracket: string;
  /** did the friendly team win this round (null when unknown) */
  win: boolean | null;
  point: Omit<BurstWindowDecisionPoint, "friendlyOutcomes"> & {
    /** name + min HP of the friendly that dipped lowest — kept for the
     * value-gate examples, dropped for the rest of the team */
    lowestFriendly: { name: string; minHpPct: number | null } | null;
  };
}
/** one row per round: the UNBOUNDED builder windows, so the report can state
 * the window-length p50 before and after bounding under the same corpus */
interface RoundRow {
  kind: "round";
  matchId: string;
  seq: number | null;
  bracket: string;
  win: boolean | null;
  /** duration in seconds of each `alignedBurstWindows` entry, unbounded */
  parentDurs: number[];
}
type AnyRow = Row | RoundRow | { matchId: string; empty: true };

function loadLedger(dir: string): Map<string, any> {
  const out = new Map<string, any>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.id) out.set(String(r.id), r);
      } catch {
        /* torn */
      }
    }
  }
  return out;
}

function parseRounds(path: string): any[] {
  let text: string;
  try {
    const raw = readFileSync(path);
    text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
  } catch {
    return [];
  }
  const combats: any[] = [];
  try {
    const parser = new GladLogParser();
    parser.on("match", (m: any) => combats.push(toLegacyMatch(m)));
    parser.on("shuffle", (sh: any) => {
      for (const r of toLegacyShuffle(sh).rounds ?? []) combats.push(r);
    });
    for (const line of text.split("\n")) parser.push(line);
    parser.end();
  } catch {
    return [];
  }
  return combats;
}

function friendlyTeamIdOf(legacy: any): string | null {
  for (const u of Object.values(legacy.units ?? {}) as any[])
    if (u.info && u.reaction === 1) return String(u.info.teamId);
  return null;
}
function winOf(legacy: any): boolean | null {
  const team = friendlyTeamIdOf(legacy);
  if (team == null || legacy.winningTeamId == null) return null;
  return String(legacy.winningTeamId) === team;
}

function manifestFiles(): string[] {
  const manifestPath = flag("--manifest")!;
  let files = readFileSync(manifestPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const offset = num("--offset", 0);
  const limit = num("--limit", 0);
  if (offset) files = files.slice(offset);
  if (limit) files = files.slice(0, limit);
  return files;
}

async function scan(): Promise<void> {
  const out = flag("--out");
  if (!flag("--manifest") || !flag("--ledger") || !out) {
    console.error(
      "usage: scan --manifest <file> --ledger <dir> --out <file.jsonl> [--offset N] [--limit N]",
    );
    process.exit(1);
  }
  await ensureAnalysisData();
  const ledger = loadLedger(flag("--ledger")!);
  const done = new Set<string>();
  if (existsSync(out))
    for (const l of readFileSync(out, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        done.add(JSON.parse(l).matchId);
      } catch {
        /* torn */
      }
    }
  let scanned = 0,
    oldSeason = 0,
    windows = 0;
  for (const path of manifestFiles()) {
    const matchId = basename(path).replace(/\.txt\.gz$|\.gz$|\.txt$/, "");
    if (done.has(matchId)) continue;
    const meta = ledger.get(matchId);
    if (
      !meta ||
      !meta.startTime ||
      meta.startTime < PATCH_121_GOLIVE_EPOCH_MS
    ) {
      oldSeason++;
      continue;
    }
    const combats = parseRounds(path);
    if (!combats.length) continue;
    scanned++;
    const bracket = meta.bracket ?? "?";
    const lines: string[] = [];
    let seq = 0;
    for (const legacy of combats) {
      const mySeq = combats.length > 1 ? seq++ : null;
      const win = winOf(legacy);
      let points: BurstWindowDecisionPoint[] = [];
      let parentDurs: number[] = [];
      try {
        points = burstWindowDecisionPoints(legacy);
        parentDurs = unboundedDurations(legacy);
      } catch {
        continue;
      }
      lines.push(
        JSON.stringify({
          kind: "round",
          matchId,
          seq: mySeq,
          bracket,
          win,
          parentDurs,
        } as RoundRow),
      );
      for (const p of points) {
        const { friendlyOutcomes, ...rest } = p;
        let lowest: { name: string; minHpPct: number | null } | null = null;
        for (const f of friendlyOutcomes)
          if (
            f.minHpPct !== null &&
            (lowest === null ||
              lowest.minHpPct === null ||
              f.minHpPct < lowest.minHpPct)
          )
            lowest = { name: f.name, minHpPct: f.minHpPct };
        lines.push(
          JSON.stringify({
            matchId,
            seq: mySeq,
            bracket,
            win,
            point: { ...rest, lowestFriendly: lowest },
          } as unknown as Row),
        );
        windows++;
      }
    }
    if (!lines.length) lines.push(JSON.stringify({ matchId, empty: true }));
    appendFileSync(out, lines.join("\n") + "\n");
    if (scanned % 100 === 0)
      console.error(
        `… ${scanned} matches, ${windows} windows, ${oldSeason} skipped (old season/no ledger)`,
      );
  }
  console.error(
    `done: scanned=${scanned} windows=${windows} skipped=${oldSeason}`,
  );
}

/** duration of every UNBOUNDED builder window of one round — the "before"
 * half of the p50 claim. Reads the same `reconstructEnemyCDTimeline` the
 * engine reads, through the engine's own module boundary. */
function unboundedDurations(legacy: any): number[] {
  const units: any[] = Object.values(legacy.units ?? {});
  const players = units.filter((u) => u.info);
  const enemies = players.filter((u) => u.reaction !== 1);
  if (!enemies.length) return [];
  const t = reconstructEnemyCDTimeline(enemies, legacy);
  return t.alignedBurstWindows.map((w: any) =>
    Math.max(0, Math.floor(w.toSeconds) - Math.floor(w.fromSeconds)),
  );
}

// ────────────────────────────────────────────────────────────── sweep ──────
/** Pick the lapse predicate from the data (the GH #60 brief): how the bounded
 * window length distribution and the window count move across a grid of
 * (damage floor, lapse seconds). */
async function sweep(): Promise<void> {
  if (!flag("--manifest") || !flag("--ledger")) {
    console.error("usage: sweep --manifest <file> --ledger <dir> [--limit N]");
    process.exit(1);
  }
  await ensureAnalysisData();
  const ledger = loadLedger(flag("--ledger")!);
  const floors = [0.01, 0.02, 0.03, 0.05];
  const lapses = [2, 3, 4, 5];
  /** the literal GH #60 wording ("no offensive CD buff active AND no damage")
   * as a control row — measured a no-op, see the report */
  const cdRow = { dmgFloor: 0.02, lapseSeconds: 3, cdBuffIsPressure: true };
  const durs = new Map<string, number[]>();
  const unbounded: number[] = [];
  let matches = 0;
  for (const path of manifestFiles()) {
    const matchId = basename(path).replace(/\.txt\.gz$|\.gz$|\.txt$/, "");
    const meta = ledger.get(matchId);
    if (!meta?.startTime || meta.startTime < PATCH_121_GOLIVE_EPOCH_MS)
      continue;
    const combats = parseRounds(path);
    if (!combats.length) continue;
    matches++;
    for (const legacy of combats) {
      unbounded.push(...unboundedDurations(legacy));
      {
        const arr = durs.get("cdBuff") ?? durs.set("cdBuff", []).get("cdBuff")!;
        try {
          for (const seg of boundedBurstSegments(legacy, cdRow).segments)
            arr.push(
              Math.max(
                0,
                Math.floor(seg.toSeconds) - Math.floor(seg.fromSeconds),
              ),
            );
        } catch {
          /* skip */
        }
      }
      for (const f of floors)
        for (const l of lapses) {
          const k = `${f}|${l}`;
          const arr = durs.get(k) ?? durs.set(k, []).get(k)!;
          try {
            // segmentation only — the sweep needs window lengths, not the
            // response/feasibility/outcome pass (16 configs × that would be
            // 16× the corpus cost for numbers it never reads)
            for (const seg of boundedBurstSegments(legacy, {
              dmgFloor: f,
              lapseSeconds: l,
            }).segments)
              arr.push(
                Math.max(
                  0,
                  Math.floor(seg.toSeconds) - Math.floor(seg.fromSeconds),
                ),
              );
          } catch {
            /* skip */
          }
        }
    }
    if (matches % 50 === 0) console.error(`… ${matches} matches`);
  }
  const q = (v: number[], p: number) => {
    if (!v.length) return NaN;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  };
  const lines: string[] = [];
  lines.push(`# burst-window lapse sweep (${matches} matches)\n`);
  lines.push(
    `unbounded builder windows: n=${unbounded.length} p50=${q(unbounded, 0.5)}s p90=${q(unbounded, 0.9)}s mean=${(unbounded.reduce((a, b) => a + b, 0) / Math.max(1, unbounded.length)).toFixed(1)}s\n`,
  );
  lines.push(`| dmg floor %/s | lapse s | windows | p50 s | p75 s | p90 s |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const f of floors)
    for (const l of lapses) {
      const v = durs.get(`${f}|${l}`) ?? [];
      lines.push(
        `| ${(f * 100).toFixed(0)}% | ${l} | ${v.length} | ${q(v, 0.5)} | ${q(v, 0.75)} | ${q(v, 0.9)} |`,
      );
    }
  {
    const v = durs.get("cdBuff") ?? [];
    lines.push(
      `| 2% + "CD buff counts as pressure" (literal GH #60 wording) | 3 | ${v.length} | ${q(v, 0.5)} | ${q(v, 0.75)} | ${q(v, 0.9)} |`,
    );
  }
  lines.push(
    `\ncurrent code default: ${(BURST_LAPSE_DMG_PCT_PER_S * 100).toFixed(0)}% / ${BURST_LAPSE_SECONDS}s`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

// ───────────────────────────────────────────────────────────── report ──────
function readRows(inPath: string): { rows: Row[]; rounds: RoundRow[] } {
  const rows: Row[] = [];
  const rounds: RoundRow[] = [];
  for (const l of readFileSync(inPath, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as AnyRow;
      if ("empty" in r) continue;
      if ((r as RoundRow).kind === "round") rounds.push(r as RoundRow);
      else rows.push(r as Row);
    } catch {
      /* torn */
    }
  }
  return { rows, rounds };
}
const pctStr = (n: number, d: number) =>
  d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "—";
const q = (v: number[], p: number) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

function report(): void {
  const inPath = flag("--in");
  if (!inPath) {
    console.error("usage: report --in <file.jsonl>");
    process.exit(1);
  }
  const { rows, rounds } = readRows(inPath);
  const matches = new Set(rounds.map((r) => r.matchId));
  const parentDurs = rounds.flatMap((r) => r.parentDurs);
  const lines: string[] = [];
  lines.push(`# enemy burst windows — GH #60 phase 1 corpus scan\n`);
  lines.push(
    `matches ${matches.size}, rounds ${rounds.length}, bounded windows ${rows.length}.\n`,
  );
  lines.push(
    `window length — UNBOUNDED builder windows: n=${parentDurs.length} p50=${q(parentDurs, 0.5)}s p75=${q(parentDurs, 0.75)}s p90=${q(parentDurs, 0.9)}s`,
  );
  const bd = rows.map((r) => r.point.durationSec);
  lines.push(
    `window length — BOUNDED (this engine): n=${bd.length} p50=${q(bd, 0.5)}s p75=${q(bd, 0.75)}s p90=${q(bd, 0.9)}s\n`,
  );

  const feas = rows.filter((r) => r.point.feasible);
  lines.push(
    `feasibility gate: ${pctStr(feas.length, rows.length)} of windows had a friendly with a tool ready and not hard-CC'd for the full 8 s.\n`,
  );

  // opportunity normalisation (Value-Gate rule 4): windows per match, split by
  // the round's own outcome — so a "responders win more" reading can be
  // checked against how many windows each side even faced.
  const perRound = (f: (r: RoundRow) => boolean) => {
    const rs = rounds.filter(f);
    const ids = new Set(rs.map((r) => `${r.matchId}|${r.seq}`));
    const n = rows.filter(
      (r) => ids.has(`${r.matchId}|${r.seq}`) && r.point.feasible,
    ).length;
    return rs.length ? (n / rs.length).toFixed(2) : "—";
  };
  // CLAUDE.md Value-Gate rule 5: never pool brackets — bracket composition
  // shifts with rating, and a pooled number fabricates effects (the
  // death-unused-defensive Simpson case).
  lines.push(`opportunity denominator (Value-Gate rule 4 + 5)\n`);
  lines.push(`| bracket | feasible windows / won round | / lost round |`);
  lines.push(`|---|---|---|`);
  const allBrackets = [...new Set(rounds.map((r) => r.bracket))].sort();
  for (const b of ["ALL", ...allBrackets])
    lines.push(
      `| ${b} | ${perRound((r) => r.win === true && (b === "ALL" || r.bracket === b))} | ${perRound((r) => r.win === false && (b === "ALL" || r.bracket === b))} |`,
    );
  lines.push("");

  const brackets = [...new Set(rows.map((r) => r.bracket))].sort();
  lines.push(`## per bracket (feasible windows only)\n`);
  lines.push(
    `| bracket | windows | responded | death-in-window RESP | death-in-window NO-RESP | Δ pp | median first-response s |`,
  );
  lines.push(`|---|---|---|---|---|---|---|`);
  const bracketLine = (label: string, rs: Row[]) => {
    const resp = rs.filter((r) => r.point.responded);
    const no = rs.filter((r) => !r.point.responded);
    const dr = resp.filter((r) => r.point.anyFriendlyDeath).length;
    const dn = no.filter((r) => r.point.anyFriendlyDeath).length;
    const rate = (a: number, b: number) => (b ? (100 * a) / b : NaN);
    const delta = rate(dn, no.length) - rate(dr, resp.length);
    const lat = resp
      .map((r) => r.point.firstResponseSec)
      .filter((v): v is number => v != null);
    lines.push(
      `| ${label} | ${rs.length} | ${pctStr(resp.length, rs.length)} | ${pctStr(dr, resp.length)} | ${pctStr(dn, no.length)} | ${isNaN(delta) ? "—" : delta.toFixed(1)} | ${lat.length ? q(lat, 0.5) : "—"} |`,
    );
  };
  bracketLine("ALL", feas);
  for (const b of brackets)
    bracketLine(
      b,
      feas.filter((r) => r.bracket === b),
    );

  lines.push(`\n## response mix (feasible windows)\n`);
  const KEYS = ["wall", "external", "healCd", "control", "kite"] as const;
  lines.push(`| response | share of feasible windows |`);
  lines.push(`|---|---|`);
  for (const k of KEYS)
    lines.push(
      `| ${k} | ${pctStr(feas.filter((r) => r.point.responses[k]).length, feas.length)} |`,
    );

  lines.push(`\n## latency of the first response (feasible + responded)\n`);
  const lat = feas
    .filter((r) => r.point.responded)
    .map((r) => r.point.firstResponseSec)
    .filter((v): v is number => v != null);
  lines.push(
    `n=${lat.length} p25=${q(lat, 0.25)}s p50=${q(lat, 0.5)}s p75=${q(lat, 0.75)}s p90=${q(lat, 0.9)}s\n`,
  );

  lines.push(`## top lead CDs (feasible windows)\n`);
  const byLead = new Map<string, Row[]>();
  for (const r of feas) {
    const k = `${r.point.leadCd.spellId}|${r.point.leadCd.spellName}`;
    (byLead.get(k) ?? byLead.set(k, []).get(k)!).push(r);
  }
  lines.push(
    `| lead CD | windows | responded | death RESP | death NO-RESP | Δ pp |`,
  );
  lines.push(`|---|---|---|---|---|---|`);
  for (const [k, rs] of [...byLead.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)) {
    const resp = rs.filter((r) => r.point.responded);
    const no = rs.filter((r) => !r.point.responded);
    const dr = resp.filter((r) => r.point.anyFriendlyDeath).length;
    const dn = no.filter((r) => r.point.anyFriendlyDeath).length;
    const rate = (a: number, b: number) => (b ? (100 * a) / b : NaN);
    const delta = rate(dn, no.length) - rate(dr, resp.length);
    lines.push(
      `| ${k.split("|")[1]} (${k.split("|")[0]}) | ${rs.length} | ${pctStr(resp.length, rs.length)} | ${pctStr(dr, resp.length)} | ${pctStr(dn, no.length)} | ${isNaN(delta) ? "—" : delta.toFixed(1)} |`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ────────────────────────────────────────────────────────── emit-table ─────
async function emitTable(): Promise<void> {
  const inPath = flag("--in");
  const outPath = flag("--out");
  if (!inPath || !outPath) {
    console.error(
      "usage: emit-table --in <file.jsonl> --out <file.json> [--corpus <label>]",
    );
    process.exit(1);
  }
  const { rows, rounds } = readRows(inPath);
  const tableRows: BurstWindowPriorRow[] = rows.map((r) => ({
    bracket: r.bracket,
    point: r.point as unknown as BurstWindowDecisionPoint,
  }));
  const table = buildBurstWindowPriorTable(tableRows, {
    generatedAt: new Date().toISOString().slice(0, 10),
    corpus:
      flag("--corpus") ??
      `${new Set(rounds.map((x) => x.matchId)).size} archived matches`,
    command:
      "npx tsx packages/eval/scripts/burstWindowScan.ts emit-table --in <scan.jsonl> --out <file.json>",
    predicateVersion: 1,
  });
  // NEVER `>` into the imported json: write a temp file, then copy it in.
  const tmp = join(dirname(outPath), `.${basename(outPath)}.tmp`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(table, null, 2) + "\n");
  copyFileSync(tmp, outPath);
  console.error(
    `wrote ${Object.keys(table.cells).length} cells → ${outPath} (via ${tmp})`,
  );
}

/**
 * examples — the Value-Gate rule 1 step: print COMPLETE real-match outputs
 * (window facts + the reference numbers the product would quote) for the
 * user to approve or kill BEFORE anything is wired. Reads raw local logs, not
 * the archive, so the examples come from the user's own library.
 */
/**
 * The exact sentence the product would say, composed ONLY from engine facts
 * and reference-table numbers — no adjectives the data cannot back. This is
 * the Value-Gate rule 1 artefact: it exists to be shown to the user and
 * approved (or killed) before any wiring.
 */
function renderExample(
  file: string,
  seq: number | null,
  bracket: string,
  p: BurstWindowDecisionPoint,
  ref: ReturnType<typeof lookupBurstWindowPrior>,
): string {
  // only the CDs that landed inside the 8 s the sentence judges: a CD cast
  // 21 s later is part of a different exchange and reads as if it had opened
  // with the lead one (real case: match 2195ab6e round 1, window 2:17–2:58).
  const inWindowExtras = p.extraCds.filter(
    (c) => c.castSec <= p.tSec + BURST_RESPONSE_WINDOW_SEC,
  );
  const extras = inWindowExtras.length
    ? `(+${inWindowExtras.map((c) => `${c.spellName} ${fmtTime(c.castSec)}`).join("、")})`
    : "";
  const lowest = [...p.friendlyOutcomes]
    .filter((f) => f.minHpPct !== null)
    .sort((a, b) => a.minHpPct! - b.minHpPct!)[0];
  const hpClause = lowest
    ? `${lowest.name} 在窗口内被打到 ${lowest.minHpPct}%${lowest.died ? "、并在窗口内阵亡" : ""}`
    : "窗口内没有可用的 HP 采样";
  const refClause = ref
    ? `语料参照(n=${ref.nResp + ref.nNoResp} 个${ref.fellBack ? `${ref.cellKey} 回退` : ` ${p.leadCd.spellName} `}爆发窗):8 秒内有应对的窗口内死人 ${ref.deathRespPct}%(n=${ref.nResp});没应对的 ${ref.deathNoRespPct}%(n=${ref.nNoResp})。`
    : "语料参照:该 lead CD 的样本量未过下限,不出面。";
  const head = `${fmtTime(p.tSec)} 对方开了 ${p.leadCd.spellName}${extras}(${p.leadCd.casterSpec} ${p.leadCd.casterName})`;
  const body = p.responded
    ? `应对了:${p.responseCasts
        .map((r) => `${r.casterName} 交了 ${r.spellName},latency ${r.latencySec} 秒`)
        .join(";")}${p.responseCasts.length === 0 && p.responses.kite ? "拉开了距离(无施法)" : ""}`
    : `8 秒内你们没有任何应对——当时 ${p.feasibleUnits.join("、")} 手上有可用的减伤/救人/控制大招,且没有被硬控整整 8 秒`;
  return [
    `## ${file}${seq === null ? "" : ` round ${seq}`} · ${bracket} · window ${fmtTime(p.tSec)}–${fmtTime(p.endSec)} (${p.durationSec}s)`,
    `${head},${body};${hpClause}。${refClause}`,
    "",
  ].join("\n");
}

async function examples(): Promise<void> {
  if (!flag("--manifest")) {
    console.error(
      "usage: examples --manifest <file> [--limit N] [--responded]",
    );
    process.exit(1);
  }
  await ensureAnalysisData();
  const wantResponded = argv.includes("--responded");
  const render = argv.includes("--render");
  const out: string[] = [];
  for (const path of manifestFiles()) {
    const combats = parseRounds(path);
    let seq = 0;
    for (const legacy of combats) {
      const mySeq = combats.length > 1 ? seq++ : null;
      let points: BurstWindowDecisionPoint[] = [];
      try {
        points = burstWindowDecisionPoints(legacy);
      } catch {
        continue;
      }
      const bracket = legacy.startInfo?.bracket ?? "?";
      for (const p of points) {
        if (!p.feasible) continue;
        if (p.responded !== wantResponded) continue;
        const ref = lookupBurstWindowPrior(bracket, p.leadCd.spellId);
        if (render) {
          out.push(renderExample(basename(path), mySeq, bracket, p, ref));
          continue;
        }
        out.push(
          JSON.stringify({
            file: basename(path),
            seq: mySeq,
            bracket,
            win: winOf(legacy),
            tSec: p.tSec,
            endSec: p.endSec,
            durationSec: p.durationSec,
            lead: p.leadCd,
            extras: p.extraCds,
            responses: p.responses,
            responseCasts: p.responseCasts,
            firstResponseSec: p.firstResponseSec,
            feasibleUnits: p.feasibleUnits,
            deathsInWindow: p.deathsInWindow,
            minFriendlyHpPct: p.minFriendlyHpPct,
            friendlyOutcomes: p.friendlyOutcomes,
            ref,
          }),
        );
      }
    }
  }
  process.stdout.write(out.join("\n") + "\n");
  console.error(`${out.length} example windows`);
}

if (cmd === "scan") await scan();
else if (cmd === "examples") await examples();
else if (cmd === "sweep") await sweep();
else if (cmd === "report") report();
else if (cmd === "emit-table") await emitTable();
else {
  console.error(
    "usage: burstWindowScan.ts scan|sweep|report|emit-table|examples ...",
  );
  process.exit(1);
}