/** killWindowOutcomeProbe.ts — GH #31 groundwork (2026-09-02, THROWAWAY).
 * Predictive validity of the CURRENT kill-window definition: per vulnerability
 * span / burst sub-window, did the span's target actually die within 15s?
 * Uses the product's own computeOffensiveWindows + computeBurstSubWindows. */
import { ensureAnalysisData } from "@gladlog/analysis";
import {
  computeBurstSubWindows,
  computeOffensiveWindows,
} from "@gladlog/analysis/src/utils/offensiveWindows";
import { PATCH_121_GOLIVE_EPOCH_MS } from "@gladlog/analysis/src/utils/drAnalysis";
import { GladLogParser } from "@gladlog/parser";
import {
  CombatUnitReaction,
  toLegacyMatch,
  toLegacyShuffle,
} from "@gladlog/parser-compat";
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { gunzipSync } from "zlib";

const argv = process.argv.slice(2);
const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const num = (f: string, d: number) => Number(flag(f) ?? d);

function loadLedger(dir: string): Map<string, any> {
  const out = new Map<string, any>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id) out.set(String(r.id), r); } catch { /* torn */ }
    }
  }
  return out;
}

async function main() {
  await ensureAnalysisData();
  const ledger = loadLedger(flag("--ledger")!);
  let files = readFileSync(flag("--manifest")!, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  files = files.slice(num("--offset", 0), num("--offset", 0) + num("--limit", 200));
  const agg: Record<string, { spans: number; spanKill: number; bursts: number; burstKill: number; burstsPerSpanSum: number; zeroBurstSpans: number; spanSecs: number[] }> = {};
  let scanned = 0;
  for (const path of files) {
    const matchId = basename(path).replace(/\.txt\.gz$|\.gz$|\.txt$/, "");
    const meta = ledger.get(matchId);
    if (!meta?.startTime || meta.startTime < PATCH_121_GOLIVE_EPOCH_MS) continue;
    let text: string;
    try { text = gunzipSync(readFileSync(path)).toString("utf8"); } catch { continue; }
    const combats: any[] = [];
    try {
      const parser = new GladLogParser();
      parser.on("match", (m: any) => combats.push(toLegacyMatch(m)));
      parser.on("shuffle", (sh: any) => { for (const r of toLegacyShuffle(sh).rounds ?? []) combats.push(r); });
      for (const line of text.split("\n")) parser.push(line);
      parser.end();
    } catch { continue; }
    scanned++;
    for (const combat of combats) {
      const units: any[] = Object.values(combat?.units ?? {});
      const players = units.filter(u => u.info);
      const friends = players.filter(u => u.reaction === CombatUnitReaction.Friendly);
      const enemies = players.filter(u => u.reaction === CombatUnitReaction.Hostile);
      if (friends.length < 2 || enemies.length < 2) continue;
      const startMs = combat.startTime;
      let windows: any[];
      try { windows = computeOffensiveWindows(enemies, friends, combat); } catch { continue; }
      const b = meta.bracket ?? "?";
      const a = (agg[b] ??= { spans: 0, spanKill: 0, bursts: 0, burstKill: 0, burstsPerSpanSum: 0, zeroBurstSpans: 0, spanSecs: [] });
      for (const w of windows) {
        const target = enemies.find(e => e.id === w.targetUnitId);
        const deaths: number[] = ((target?.deathRecords ?? []) as any[]).map(d => (d.timestamp - startMs) / 1000);
        a.spans++;
        a.spanSecs.push(w.toSeconds - w.fromSeconds);
        if (deaths.some(d => d >= w.fromSeconds && d <= w.toSeconds + 15)) a.spanKill++;
        // burst sub-windows from the target's friendly damage events, product predicate
        const dmg: Array<{ t: number; amount: number }> = [];
        for (const f of friends)
          for (const e of (f.damageOut ?? []) as any[])
            if (e.destUnitId === w.targetUnitId) {
              const t = (e.timestamp - startMs) / 1000;
              if (t >= w.fromSeconds && t <= w.toSeconds) dmg.push({ t, amount: Math.abs(Number(e.effectiveAmount ?? e.amount ?? 0)) });
            }
        const bursts = computeBurstSubWindows(dmg, w.fromSeconds, w.toSeconds);
        a.burstsPerSpanSum += bursts.length;
        if (bursts.length === 0) a.zeroBurstSpans++;
        for (const bu of bursts) {
          a.bursts++;
          if (deaths.some(d => d >= bu.fromSeconds && d <= bu.toSeconds + 15)) a.burstKill++;
        }
      }
    }
  }
  console.log(`scanned=${scanned}`);
  for (const [b, a] of Object.entries(agg)) {
    const med = a.spanSecs.sort((x, y) => x - y)[Math.floor(a.spanSecs.length / 2)] ?? 0;
    console.log(
      `${b}: spans=${a.spans} (medianDur=${med.toFixed(0)}s) spanKill15=${(100 * a.spanKill / Math.max(1, a.spans)).toFixed(1)}% | bursts=${a.bursts} (${(a.burstsPerSpanSum / Math.max(1, a.spans)).toFixed(2)}/span) burstKill15=${(100 * a.burstKill / Math.max(1, a.bursts)).toFixed(1)}% | zeroBurstSpans=${(100 * a.zeroBurstSpans / Math.max(1, a.spans)).toFixed(1)}%`,
    );
  }
}
main().catch(e => { console.error(e); process.exit(1); });
