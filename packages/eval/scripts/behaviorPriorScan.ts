/**
 * behaviorPriorScan.ts — exploratory (2026-08-28): "what do top-ranked players
 * actually do in this state?" as an alternative to hand-written feasibility
 * gates (Maia / AlphaStar supervised-stage idea, see the conversation that
 * produced it).
 *
 * One decision point per crisis crossing, from the SAME predicate the product
 * candidate uses (`crisisDecisionPoints`, `packages/analysis/src/analysis/
 * crisisDecisionPoints.ts` — CLAUDE.md shared-predicate rule): the owner's HP
 * crossed down through `CRISIS_HP_PCT`, and the point records the state
 * (HP%, damage taken in the previous 2s, CC/lockout on owner, feasibility)
 * plus the response taxonomy (selfHeal/wall/external/control/peel/kite)
 * within the shared response window.
 *
 * Rank is NOT absolute rating: it is the percentile of the match's rating
 * within (bracket, ISO week of startTime), because a season's ratings inflate
 * as it goes on (2026-08-28: week-32 Solo median 2158 → week-34 median 1729).
 *
 *   scan        tsx behaviorPriorScan.ts scan --manifest <file> --ledger <dir>
 *                 --out <file.jsonl> [--offset N] [--limit N] [--role healer|dps]
 *   report      tsx behaviorPriorScan.ts report --in <file.jsonl>
 *   emit-table  tsx behaviorPriorScan.ts emit-table --in <file.jsonl> [--corpus <label>]
 */
import {
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
  specToString,
} from "@gladlog/analysis";
import {
  CRISIS_HP_PCT,
  crisisDecisionPoints,
  DecisionPoint,
} from "@gladlog/analysis/src/analysis/crisisDecisionPoints";
import { PATCH_121_GOLIVE_EPOCH_MS } from "@gladlog/analysis/src/utils/drAnalysis";
import { GladLogParser } from "@gladlog/parser";
import {
  CombatUnitReaction,
  toLegacyMatch,
  toLegacyShuffle,
} from "@gladlog/parser-compat";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { gunzipSync } from "zlib";

import {
  BehaviorPriorRow,
  buildBehaviorPriorTable,
  dmgBinOf,
} from "../src/explore/behaviorPriorTable";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => Number(flag(f) ?? d);
/** --role healer (default) | dps : which friendly units become the owner */
const ROLE = flag("--role") ?? "healer";

/** one row per DecisionPoint from the shared predicate
 * (crisisDecisionPoints.ts) — the scan no longer computes its own crossing or
 * response logic; it only adds corpus-scan bookkeeping (match/rank/gate). */
interface Row {
  matchId: string;
  seq: number | null;
  bracket: string;
  week: string;
  rating: number | null;
  pct: number | null; // percentile within (bracket, week), 0–100
  spec: string;
  point: DecisionPoint;
  gateFiredThisRound: boolean; // product death-unused-defensive fired in this round
}

function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk =
    1 +
    Math.round(
      ((d.getTime() - firstThu.getTime()) / 86400000 -
        3 +
        ((firstThu.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

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

/** percentile of each ledger row's rating within (bracket, week) */
function rankLedger(ledger: Map<string, any>): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of ledger.values()) {
    if (!r.playerTeamRating || !r.startTime) continue;
    const k = `${r.bracket}|${isoWeek(r.startTime)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r.playerTeamRating);
  }
  for (const v of groups.values()) v.sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const [id, r] of ledger) {
    if (!r.playerTeamRating || !r.startTime) continue;
    const v = groups.get(`${r.bracket}|${isoWeek(r.startTime)}`)!;
    // rank = share of rows strictly below (midpoint for ties)
    let lo = 0,
      hi = v.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (v[m]! < r.playerTeamRating) lo = m + 1;
      else hi = m;
    }
    let lo2 = lo,
      hi2 = v.length;
    while (lo2 < hi2) {
      const m = (lo2 + hi2) >> 1;
      if (v[m]! <= r.playerTeamRating) lo2 = m + 1;
      else hi2 = m;
    }
    out.set(id, (100 * ((lo + lo2) / 2)) / v.length);
  }
  return out;
}

function oppsOf(
  legacy: any,
  owner: any,
  meta: any,
  pct: number | null,
  matchId: string,
  seq: number | null,
  gateFired: boolean,
): Row[] {
  return crisisDecisionPoints(owner, legacy).map((point) => ({
    matchId,
    seq,
    bracket: meta?.bracket ?? legacy.startInfo?.bracket ?? "?",
    week: isoWeek(meta?.startTime ?? legacy.startTime),
    rating: meta?.playerTeamRating ?? null,
    pct,
    spec: specToString(owner.spec),
    point,
    gateFiredThisRound: gateFired,
  }));
}

async function scan(): Promise<void> {
  const manifestPath = flag("--manifest");
  const ledgerDir = flag("--ledger");
  const out = flag("--out");
  if (!manifestPath || !ledgerDir || !out) {
    console.error(
      "usage: scan --manifest <file> --ledger <dir> --out <file.jsonl> [--offset N] [--limit N]",
    );
    process.exit(1);
  }
  await ensureAnalysisData();
  const ledger = loadLedger(ledgerDir);
  const pctOf = rankLedger(ledger);
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
  let files = readFileSync(manifestPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const offset = num("--offset", 0);
  const limit = num("--limit", 0);
  if (offset) files = files.slice(offset);
  if (limit) files = files.slice(0, limit);

  let scanned = 0,
    oldSeason = 0,
    opps = 0;
  for (const path of files) {
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
    let text: string;
    try {
      const raw = readFileSync(path);
      text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    } catch {
      continue;
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
      continue;
    }
    scanned++;
    let seq = 0;
    const lines: string[] = [];
    for (const legacy of combats) {
      const units: any[] = Object.values(legacy.units ?? {});
      const friends = units.filter(
        (u) => u.info && u.reaction === CombatUnitReaction.Friendly,
      );
      const mySeq = combats.length > 1 ? seq++ : null;
      const owners =
        ROLE === "dps"
          ? friends.filter((u) => !isHealerSpec(u.spec))
          : friends.filter((u) => isHealerSpec(u.spec)).slice(0, 1);
      for (const owner of owners) {
        let gateFired = false;
        try {
          gateFired = extractCandidateFindings(legacy, owner.id).some(
            (c: any) => c.type === "death-unused-defensive",
          );
        } catch {
          /* keep false */
        }
        for (const o of oppsOf(
          legacy,
          owner,
          meta,
          pctOf.get(matchId) ?? null,
          matchId,
          mySeq,
          gateFired,
        )) {
          lines.push(JSON.stringify(o));
          opps++;
        }
      }
    }
    // always record the match as done, even with zero opportunities
    if (!lines.length) lines.push(JSON.stringify({ matchId, empty: true }));
    appendFileSync(out, lines.join("\n") + "\n");
    if (scanned % 100 === 0)
      console.error(
        `… ${scanned} matches, ${opps} opportunities, ${oldSeason} skipped (old season/no ledger)`,
      );
  }
  console.error(`done: scanned=${scanned} opps=${opps} skipped=${oldSeason}`);
}

function bucketOfPct(p: number): string {
  if (p >= 90) return "top10";
  if (p >= 60) return "60-90";
  if (p >= 30) return "30-60";
  return "<30";
}
const BUCKETS = ["<30", "30-60", "60-90", "top10"];

function pctStr(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "—";
}

function report(): void {
  const inPath = flag("--in");
  if (!inPath) {
    console.error("usage: report --in <file.jsonl>");
    process.exit(1);
  }
  const rows: Row[] = [];
  let matches = 0;
  for (const l of readFileSync(inPath, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r.empty) {
        matches++;
        continue;
      }
      rows.push(r);
    } catch {
      /* torn */
    }
  }
  matches += new Set(rows.map((r) => r.matchId)).size;
  const all = rows.filter((r) => r.pct != null);
  const lines: string[] = [];
  lines.push(
    `# behavior prior — owner HP crossed ≤${CRISIS_HP_PCT * 100}% (shared predicate: crisisDecisionPoints.ts)\n`,
  );
  lines.push(
    `matches ${matches}, decision points ${rows.length} (${all.length} ranked).\n`,
  );
  const byBracket = new Map<string, Row[]>();
  for (const r of all)
    (
      byBracket.get(r.bracket) ?? byBracket.set(r.bracket, []).get(r.bracket)!
    ).push(r);

  const RESP: [string, keyof DecisionPoint["responses"]][] = [
    ["self-heal", "selfHeal"],
    ["personal wall", "wall"],
    ["external", "external"],
    ["own control", "control"],
    ["peel", "peel"],
    ["kited", "kite"],
  ];

  for (const [bracket, rs] of byBracket) {
    lines.push(`\n## ${bracket} (${rs.length} decision points)\n`);

    // feasible vs gated — replaces the old hindsight ("died within 10s")
    // tables: whether the player responded is only a fair question when the
    // decision point was feasible (not in CC / not locked out / didn't die
    // in the window — DecisionPoint.feasible, crisisDecisionPoints.ts).
    lines.push(`\n### decision point counts by rank bucket\n`);
    lines.push(
      `| rank bucket | all | feasible | feasible & not responded | n |`,
    );
    lines.push(`|---|---|---|---|---|`);
    for (const b of BUCKETS) {
      const sub = rs.filter((r) => bucketOfPct(r.pct!) === b);
      const feasible = sub.filter((r) => r.point.feasible);
      const notResponded = feasible.filter((r) => !r.point.responded);
      lines.push(
        `| ${b} | ${sub.length} | ${pctStr(feasible.length, sub.length)} | ${pctStr(notResponded.length, feasible.length)} | ${sub.length} |`,
      );
    }

    // response mix — feasible decision points only
    const respTable = (title: string, filt: (r: Row) => boolean) => {
      lines.push(`\n### ${title}\n`);
      lines.push(`| response within window | ${BUCKETS.join(" | ")} |`);
      lines.push(`|---|${BUCKETS.map(() => "---").join("|")}|`);
      for (const [name, key] of RESP) {
        const cells = BUCKETS.map((b) => {
          const sub = rs.filter(
            (r) => filt(r) && r.point.feasible && bucketOfPct(r.pct!) === b,
          );
          return pctStr(
            sub.filter((r) => r.point.responses[key]).length,
            sub.length,
          );
        });
        lines.push(`| ${name} | ${cells.join(" | ")} |`);
      }
      const respondedCells = BUCKETS.map((b) => {
        const sub = rs.filter(
          (r) => filt(r) && r.point.feasible && bucketOfPct(r.pct!) === b,
        );
        return pctStr(sub.filter((r) => r.point.responded).length, sub.length);
      });
      lines.push(`| responded (any) | ${respondedCells.join(" | ")} |`);
      const med = (b: string) => {
        const v = rs
          .filter(
            (r) =>
              filt(r) &&
              r.point.feasible &&
              bucketOfPct(r.pct!) === b &&
              r.point.responses.selfHeal,
          )
          .map((r) => r.point.selfHealPct)
          .sort((a, c) => a - c);
        return v.length ? String(v[Math.floor(v.length / 2)]) : "—";
      };
      lines.push(
        `| median self-heal in window (% maxHP, selfHeal responders) | ${BUCKETS.map(med).join(" | ")} |`,
      );
    };
    respTable("response mix — feasible decision points", () => true);
    respTable(
      "response mix — feasible, dmg2s <10%",
      (r) => dmgBinOf(r.point.dmg2s) === "<10%",
    );
    respTable(
      "response mix — feasible, dmg2s 10-20%",
      (r) => dmgBinOf(r.point.dmg2s) === "10-20%",
    );
    respTable(
      "response mix — feasible, dmg2s ≥20%",
      (r) => dmgBinOf(r.point.dmg2s) === ">=20%",
    );
    respTable(
      "response mix — feasible, enemy burst CD or ≥2 attackers",
      (r) => r.point.enemyBurst || r.point.attackers2s >= 2,
    );

    // product gate cross-reference
    lines.push(
      `\n### product gate cross-reference — rounds where death-unused-defensive fired\n`,
    );
    lines.push(
      `| rank bucket | rounds fired | decision points in those rounds | of which feasible & not responded |`,
    );
    lines.push(`|---|---|---|---|`);
    for (const b of BUCKETS) {
      const sub = rs.filter(
        (r) => bucketOfPct(r.pct!) === b && r.gateFiredThisRound,
      );
      lines.push(
        `| ${b} | ${new Set(sub.map((r) => `${r.matchId}#${r.seq}`)).size} | ${sub.length} | ${sub.filter((r) => r.point.feasible && !r.point.responded).length} |`,
      );
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function emitTable(): Promise<void> {
  const inPath = flag("--in");
  if (!inPath) {
    console.error("usage: emit-table --in <file.jsonl> [--corpus <label>]");
    process.exit(1);
  }
  const rows: BehaviorPriorRow[] = [];
  const weeks = new Set<string>();
  const matches = new Set<string>();
  for (const l of readFileSync(inPath, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      matches.add(r.matchId);
      if (r.empty) continue;
      weeks.add(r.week);
      rows.push({ bracket: r.bracket, pct: r.pct, point: r.point });
    } catch {
      /* torn */
    }
  }
  const table = buildBehaviorPriorTable(rows, {
    generatedAt: new Date().toISOString().slice(0, 10),
    corpus: flag("--corpus") ?? `${matches.size} archived matches`,
    weeks: [...weeks].sort(),
    command: `npx tsx packages/eval/scripts/behaviorPriorScan.ts emit-table --in <scan.jsonl>`,
    predicateVersion: 1,
    topPercentile: 90,
  });
  process.stdout.write(JSON.stringify(table, null, 2) + "\n");
}

if (cmd === "scan") await scan();
else if (cmd === "report") report();
else if (cmd === "emit-table") await emitTable();
else {
  console.error("usage: behaviorPriorScan.ts scan|report|emit-table ...");
  process.exit(1);
}
