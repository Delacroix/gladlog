/**
 * signalSkillGradientScan.ts CLI — dumb shell over
 * `../src/explore/signalSkillGradient.ts` (which holds the design rationale,
 * the denominator table and every aggregation rule; per the repo convention
 * this file contains no analysis logic of its own).
 *
 * Walks the PvP log archive (raw .gz, one match per file), joins each match to
 * its ledger row for the RATING — the external ground truth this experiment
 * turns on — and emits one JSONL row per healer-owner round: which signals
 * fired, plus the exposure counts that serve as their opportunity denominators.
 *
 *   scan    tsx signalSkillGradientScan.ts scan --manifest <file> --ledger <dir>
 *             --out <file.jsonl> [--offset N] [--limit N]
 *           Resumable: appends, and skips matches already present in --out.
 *   report  tsx signalSkillGradientScan.ts report --in <file.jsonl> [--md <out>]
 *
 * Run scans in a few shards at most: a 2026-08-18 incident froze this machine
 * with 74 concurrent corpus-scanning node processes (~150GB).
 */
import { existsSync, readFileSync, appendFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { gunzipSync } from "zlib";

import {
  ccSpellIds,
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
  specToString,
} from "@gladlog/analysis";
import { getDispelType } from "@gladlog/analysis/src/utils/dispelAnalysis";
import { GladLogParser } from "@gladlog/parser";
import {
  CombatUnitReaction,
  toLegacyMatch,
  toLegacyShuffle,
} from "@gladlog/parser-compat";

import {
  bucketOf,
  formatStratifiedReport,
  type RoundExposure,
  type RoundRecord,
} from "../src/explore/signalSkillGradient";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => Number(flag(f) ?? d);

/** ledger JSONL rows → matchId → { rating, bracket, win-side, startTime } */
function loadLedger(dir: string): Map<string, any> {
  const out = new Map<string, any>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // the archiver keys its ledger rows `id` (= the GCS object name, which
        // is also the archived file's basename)
        if (r.id) out.set(String(r.id), r);
      } catch {
        /* a torn last line is expected while the archiver is running */
      }
    }
  }
  return out;
}

/** Exposure counts: plain event tallies over the round, no analysis re-entry.
 * Field names follow parser-compat's legacy shape (auraEvents carry
 * `logLine.event` + `auraType`, damage amounts are NEGATIVE, casts live in
 * `castStartEvents`, max HP only exists on `advancedActions` samples). */
function exposureOf(legacy: any, owner: any, friends: any[]): RoundExposure {
  const e: RoundExposure = {
    rounds: 1,
    ccOnOwner: 0,
    enemyCcOnTeam: 0,
    cleansableOnTeam: 0,
    enemyBuffsPurgeable: 0,
    friendlyDeaths: 0,
    ownerHardCasts: 0,
    friendlyDamageSpikes: 0,
  };
  const friendIds = new Set(friends.map((u) => u.id));
  for (const u of Object.values(legacy.units ?? {}) as any[]) {
    for (const ev of (u.auraEvents ?? []) as any[]) {
      if (ev.logLine?.event !== "SPELL_AURA_APPLIED") continue;
      const sid = String(ev.spellId ?? "");
      if (!sid) continue;
      const destFriendly = friendIds.has(ev.destUnitId);
      const srcFriendly = friendIds.has(ev.srcUnitId);
      if (destFriendly && !srcFriendly && ev.auraType === "DEBUFF") {
        if (ccSpellIds.has(sid)) {
          e.enemyCcOnTeam++;
          if (ev.destUnitId === owner.id) e.ccOnOwner++;
        }
        if (getDispelType(sid)) e.cleansableOnTeam++;
      }
      if (!destFriendly && !srcFriendly && ev.auraType === "BUFF" && getDispelType(sid))
        e.enemyBuffsPurgeable++;
    }
    if (friendIds.has(u.id)) e.friendlyDeaths += ((u.deathRecords ?? []) as any[]).length;
    if (u.id === owner.id) e.ownerHardCasts += ((u.castStartEvents ?? []) as any[]).length;
  }
  // Damage spikes on the owner's team: ≥20% of max HP inside 2s. Counted only
  // as an opportunity denominator for "slow defensive response" — never rendered,
  // so it deliberately does not import matchTimeline's DMG SPIKE predicate.
  for (const u of friends) {
    const maxHp = Math.max(
      0,
      ...((u.advancedActions ?? []) as any[]).map((a) => a.advancedActorMaxHp ?? 0),
    );
    if (!maxHp) continue;
    const dmg = ((u.damageIn ?? []) as any[])
      .map((d) => ({ t: d.timestamp, a: Math.abs(d.effectiveAmount ?? d.amount ?? 0) }))
      .sort((x, y) => x.t - y.t);
    if (!dmg.length) continue;
    let i = 0;
    let sum = 0;
    for (let j = 0; j < dmg.length; j++) {
      sum += dmg[j]!.a;
      while (dmg[i]!.t < dmg[j]!.t - 2000) { sum -= dmg[i]!.a; i++; }
      if (sum >= maxHp * 0.2) {
        e.friendlyDamageSpikes++;
        i = j + 1;
        sum = 0;
      }
    }
  }
  return e;
}

async function scan(): Promise<void> {
  const manifestPath = flag("--manifest");
  const ledgerDir = flag("--ledger");
  const out = flag("--out");
  if (!manifestPath || !ledgerDir || !out) {
    console.error("usage: scan --manifest <file> --ledger <dir> --out <file.jsonl> [--offset N] [--limit N]");
    process.exit(1);
  }
  await ensureAnalysisData();
  const ledger = loadLedger(ledgerDir);
  const done = new Set<string>();
  if (existsSync(out))
    for (const l of readFileSync(out, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        done.add(JSON.parse(l).matchId);
      } catch {
        /* torn line */
      }
    }
  let files = readFileSync(manifestPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const offset = num("--offset", 0);
  const limit = num("--limit", 0);
  if (offset) files = files.slice(offset);
  if (limit) files = files.slice(0, limit);

  let scanned = 0, skipped = 0, rounds = 0, noLedger = 0;
  for (const path of files) {
    const matchId = basename(path).replace(/\.txt\.gz$|\.gz$|\.txt$/, "");
    if (done.has(matchId)) { skipped++; continue; }
    const meta = ledger.get(matchId);
    if (!meta) noLedger++;
    let text: string;
    try {
      const raw = readFileSync(path);
      text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    } catch { continue; }
    const combats: any[] = [];
    try {
      const parser = new GladLogParser();
      parser.on("match", (m: any) => combats.push(toLegacyMatch(m)));
      parser.on("shuffle", (sh: any) => {
        for (const r of toLegacyShuffle(sh).rounds ?? []) combats.push(r);
      });
      for (const line of text.split("\n")) parser.push(line);
      parser.end();
    } catch { continue; }
    scanned++;
    let seq = 0;
    const lines: string[] = [];
    for (const legacy of combats) {
      const units: any[] = Object.values(legacy.units ?? {});
      const players = units.filter((u) => u.info);
      const friends = players.filter((u) => u.reaction === CombatUnitReaction.Friendly);
      const owner = friends.find((u) => isHealerSpec(u.spec));
      const mySeq = combats.length > 1 ? seq++ : null;
      if (!owner) continue;
      const winningTeamId = legacy.winningTeamId;
      const ownerTeamId = owner.info?.teamId;
      const win = winningTeamId != null && ownerTeamId != null
        ? String(winningTeamId) === String(ownerTeamId)
        : null;
      const rating = meta?.playerTeamRating || meta?.team0MMR || null;
      let fired: string[] = [];
      try {
        fired = [...new Set(extractCandidateFindings(legacy, owner.id).map((c) => c.type))];
      } catch { continue; }
      const rec: RoundRecord = {
        matchId,
        seq: mySeq,
        bracket: meta?.bracket ?? legacy.startInfo?.bracket ?? "?",
        startTime: meta?.startTime ?? legacy.startTime ?? 0,
        rating,
        bucket: bucketOf(rating),
        win,
        ownerSpec: specToString(owner.spec),
        durationS: (legacy.endTime - legacy.startTime) / 1000,
        fired,
        exposure: exposureOf(legacy, owner, friends),
      };
      lines.push(JSON.stringify(rec));
      rounds++;
    }
    if (lines.length) appendFileSync(out, lines.join("\n") + "\n");
    if (scanned % 100 === 0)
      console.error(`… ${scanned} matches, ${rounds} healer rounds, ${noLedger} without ledger meta`);
  }
  console.error(`done: scanned=${scanned} skipped=${skipped} rounds=${rounds} noLedgerMeta=${noLedger}`);
}

function report(): void {
  const inPath = flag("--in");
  if (!inPath) { console.error("usage: report --in <file.jsonl> [--md <out>]"); process.exit(1); }
  const records: RoundRecord[] = [];
  for (const l of readFileSync(inPath, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { records.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  const withBucket = records.filter((r) => r.bucket);
  const meta = `rounds: ${records.length} (${withBucket.length} with a rating), matches: ${new Set(records.map((r) => r.matchId)).size}`;
  const md = formatStratifiedReport(withBucket, meta);
  const mdOut = flag("--md");
  if (mdOut) { appendFileSync(mdOut, md); console.error(`wrote ${mdOut}`); }
  else process.stdout.write(md);
}

if (cmd === "scan") await scan();
else if (cmd === "report") report();
else { console.error("usage: signalSkillGradientScan.ts scan|report ..."); process.exit(1); }
