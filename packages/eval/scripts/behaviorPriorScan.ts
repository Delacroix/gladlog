/**
 * behaviorPriorScan.ts — exploratory (2026-08-28): "what do top-ranked players
 * actually do in this state?" as an alternative to hand-written feasibility
 * gates (Maia / AlphaStar supervised-stage idea, see the conversation that
 * produced it).
 *
 * One decision point per "the healer-owner's own HP crossed down through
 * CRISIS_HP_PCT with at least one personal wall available". Records the
 * state (HP%, damage taken in the previous 2s, CC on owner, walls ready) and
 * the ACTION the player took within ACTION_WINDOW_MS (pressed a wall or not),
 * plus whether the owner died within DEATH_LOOKAHEAD_MS.
 *
 * Rank is NOT absolute rating: it is the percentile of the match's rating
 * within (bracket, ISO week of startTime), because a season's ratings inflate
 * as it goes on (2026-08-28: week-32 Solo median 2158 → week-34 median 1729).
 *
 *   scan    tsx behaviorPriorScan.ts scan --manifest <file> --ledger <dir>
 *             --out <file.jsonl> [--offset N] [--limit N]
 *   report  tsx behaviorPriorScan.ts report --in <file.jsonl>
 */
import {
  ccSpellIds,
  classMetadata,
  ensureAnalysisData,
  extractCandidateFindings,
  isHealerSpec,
  specToString,
  spellIdLists,
} from "@gladlog/analysis";
import {
  rootSpellIds,
  spells as spellMeta,
} from "@gladlog/analysis/src/data/spellTags";
import { SpellTag } from "@gladlog/analysis/src/data/spellTypes";
import { TEAM_HEAL_CD_IDS } from "@gladlog/analysis/src/utils/cooldowns";
import {
  cdAvailableAt,
  extractMajorCooldowns,
  isProcOnlyActivation,
} from "@gladlog/analysis/src/utils/cooldowns";
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
  CRISIS_HP_PCT,
  CRISIS_WINDOW_GAP_MS,
} from "../src/explore/signalSkillGradient";

const ACTION_WINDOW_MS = 3000;
const ACTION_PRE_MS = 1500; // a wall pressed just before the crossing counts too
const DEATH_LOOKAHEAD_MS = 10000;
const DMG_WINDOW_MS = 2000;
// context windows (v3, 2026-08-29)
const ENEMY_BURST_LOOKBACK_MS = 8000;
const EXTERNAL_LOOKBACK_MS = 5000;

/** enemy offensive cooldowns — same derivation as signalSkillGradientScan */
const OFFENSIVE_CD_IDS = new Set<string>(
  classMetadata.flatMap((c: any) =>
    (c.abilities ?? [])
      .filter((a: any) => (a.tags ?? []).includes(SpellTag.Offensive))
      .map((a: any) => String(a.spellId)),
  ),
);
/** owner-side "stop the damage" tools: hard CC ∪ roots ∪ typed interrupts */
const CONTROL_IDS = new Set<string>([
  ...ccSpellIds,
  ...rootSpellIds,
  ...Object.entries(spellMeta)
    .filter(([, m]) => m.type === "interrupts")
    .map(([id]) => id),
]);
const RESPONSE_WINDOW_MS = 3000;
const MOVE_YARDS = 15;
const KITE_GAIN_YARDS = 8;
const SELF_HEAL_BIG = 0.15;
/** PERSONAL walls only — the curated bigDefensiveSpellIds. extractMajorCooldowns
 * tags externals (Pain Suppression, Ironbark…) and team-heal CDs (Divine Hymn,
 * Tranquility, Aura Mastery…) as "Defensive" too; v1–v3 of this scan counted
 * all of them as "a wall". Found 2026-08-29, fixed in v4. */
const PERSONAL_WALL_IDS = new Set<string>(
  (spellIdLists as any).bigDefensiveSpellIds.map(String),
);
const EXTERNAL_IDS = new Set<string>(
  (spellIdLists as any).externalDefensiveSpellIds.map(String),
);

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => Number(flag(f) ?? d);

interface Opp {
  matchId: string;
  seq: number | null;
  bracket: string;
  week: string;
  rating: number | null;
  pct: number | null; // percentile within (bracket, week), 0–100
  spec: string;
  tSec: number;
  hpPct: number;
  dmg2s: number; // fraction of max HP taken in previous 2s
  inCC: boolean;
  wallsReady: number;
  wallsInKit: number;
  pressed: boolean; // a ready wall cast within [-1.5s, +3s]
  pressedId: string | null;
  pressedDelayMs: number | null;
  diedIn10s: boolean;
  gateFiredThisRound: boolean; // product death-unused-defensive fired in this round
  /** ms since the owner's most recent wall cast before the crossing (any wall,
   * ready or not); null = never cast one yet. A small value with wallsReady=0
   * means "walled pre-emptively before the HP ever got here". */
  lastWallCastAgoMs: number | null;
  // ---- context (v3) ----
  /** an enemy cast an offensive major CD within the last 8s */
  enemyBurst: boolean;
  /** distinct enemy sources that damaged the owner in the prior 2s */
  attackers2s: number;
  /** a teammate cast an external defensive ON the owner within the last 5s */
  externalRecent: boolean;
  /** lowest teammate (not owner) HP% at the crossing, null if unknown */
  lowestAllyHp: number | null;
  // ---- responses in [−1.5s, +3s] (v4) ----
  /** owner cast a throughput / team-heal major CD */
  rThroughputCd: boolean;
  /** owner cast an external defensive (on anyone) */
  rExternalCast: boolean;
  /** owner cast a team-heal CD */
  rTeamHealCd: boolean;
  /** owner self-healed ≥15% max HP inside 3s */
  rSelfHeal: boolean;
  selfHeal3s: number;
  allyHeal3s: number;
  /** owner cast hard CC / root / interrupt on an enemy */
  rOwnerControl: boolean;
  /** a teammate cast CC / root / interrupt on one of the owner's attackers */
  rPeel: boolean;
  /** owner displaced ≥15yd over the 3s */
  rMoved: boolean;
  moved3s: number | null;
  /** distance to nearest attacker grew ≥8yd over the 3s */
  rKited: boolean;
  /** owner healed someone other than themself inside 3s */
  rHealedOthers: boolean;
  /** owner cast nothing at all in the window */
  rIdle: boolean;
  hpAfter5s: number | null;
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
): Opp[] {
  const start = legacy.startTime;
  const samples = ((owner.advancedActions ?? []) as any[])
    .filter((a) => (a.advancedActorMaxHp ?? 0) > 0)
    .map((a) => ({
      t: a.timestamp,
      hp: a.advancedActorCurrentHp / a.advancedActorMaxHp,
      max: a.advancedActorMaxHp,
    }))
    .sort((a, b) => a.t - b.t);
  if (samples.length < 2) return [];
  // downward crossings of CRISIS_HP_PCT, merged within CRISIS_WINDOW_GAP_MS
  const crossings: { t: number; hp: number; max: number }[] = [];
  let last = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!,
      c = samples[i]!;
    if (p.hp > CRISIS_HP_PCT && c.hp <= CRISIS_HP_PCT && c.hp > 0) {
      if (c.t - last > CRISIS_WINDOW_GAP_MS) crossings.push(c);
      last = c.t;
    }
  }
  if (!crossings.length) return [];

  let cds: any[] = [];
  try {
    cds = extractMajorCooldowns(owner, legacy);
  } catch {
    return [];
  }
  const wallCds = cds.filter(
    (cd) =>
      cd.tag === "Defensive" &&
      !cd.isThroughput &&
      !isProcOnlyActivation(cd.spellId) &&
      PERSONAL_WALL_IDS.has(String(cd.spellId)),
  );
  if (!wallCds.length) return [];
  const wallIds = new Set(wallCds.map((c) => String(c.spellId)));
  const wallCasts = ((owner.spellCastEvents ?? []) as any[])
    .filter((c) => wallIds.has(String(c.spellId)))
    .map((c) => ({ t: c.timestamp, id: String(c.spellId) }))
    .sort((a, b) => a.t - b.t);
  const dmg = ((owner.damageIn ?? []) as any[])
    .map((d) => ({
      t: d.timestamp,
      a: Math.abs(d.effectiveAmount ?? d.amount ?? 0),
    }))
    .sort((a, b) => a.t - b.t);
  const deaths = ((owner.deathRecords ?? []) as any[]).map((d) => d.timestamp);
  // CC intervals on owner (enemy hard CC debuffs)
  const cc: { from: number; to: number }[] = [];
  const open = new Map<string, number>();
  const auras = ((owner.auraEvents ?? []) as any[])
    .filter(
      (e) => e.destUnitId === owner.id && ccSpellIds.has(String(e.spellId)),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const e of auras) {
    const key = `${e.srcUnitId}:${e.spellId}`;
    const ev = e.logLine?.event;
    if (ev === "SPELL_AURA_APPLIED") open.set(key, e.timestamp);
    else if (ev === "SPELL_AURA_REMOVED" && open.has(key)) {
      cc.push({ from: open.get(key)!, to: e.timestamp });
      open.delete(key);
    }
  }
  for (const [, from] of open) cc.push({ from, to: from + 8000 });

  // ---- context sources ----
  const units: any[] = Object.values(legacy.units ?? {});
  const friendIds = new Set(
    units
      .filter((u) => u.info && u.reaction === CombatUnitReaction.Friendly)
      .map((u) => u.id),
  );
  const enemyBurstCasts: number[] = [];
  const externalsOnOwner: number[] = [];
  for (const u of units) {
    if (!u.info) continue;
    for (const c of (u.spellCastEvents ?? []) as any[]) {
      const sid = String(c.spellId ?? "");
      if (!friendIds.has(u.id) && OFFENSIVE_CD_IDS.has(sid))
        enemyBurstCasts.push(c.timestamp);
      if (
        friendIds.has(u.id) &&
        u.id !== owner.id &&
        EXTERNAL_IDS.has(sid) &&
        c.destUnitId === owner.id
      )
        externalsOnOwner.push(c.timestamp);
    }
  }
  enemyBurstCasts.sort((a, b) => a - b);
  externalsOnOwner.sort((a, b) => a - b);
  const dmgSrc = ((owner.damageIn ?? []) as any[]).map((d) => ({
    t: d.timestamp,
    src: d.srcUnitId,
  }));
  const allySamples = units
    .filter((u) => friendIds.has(u.id) && u.id !== owner.id)
    .map((u) =>
      ((u.advancedActions ?? []) as any[])
        .filter((a) => (a.advancedActorMaxHp ?? 0) > 0)
        .map((a) => ({
          t: a.timestamp,
          hp: a.advancedActorCurrentHp / a.advancedActorMaxHp,
        })),
    );
  // v4 response sources
  const ownerCasts = ((owner.spellCastEvents ?? []) as any[]).map((c) => ({
    t: c.timestamp,
    id: String(c.spellId ?? ""),
    dest: c.destUnitId,
  }));
  // every non-personal-wall, non-control major CD the owner owns
  const externalIds = new Set(
    cds
      .filter((cd) => EXTERNAL_IDS.has(String(cd.spellId)))
      .map((cd) => String(cd.spellId)),
  );
  const teamHealIds = new Set(
    cds
      .filter((cd) => TEAM_HEAL_CD_IDS.has(String(cd.spellId)))
      .map((cd) => String(cd.spellId)),
  );
  const throughputIds = new Set(
    cds
      .filter(
        (cd) =>
          cd.tag !== "Control" &&
          !PERSONAL_WALL_IDS.has(String(cd.spellId)) &&
          !externalIds.has(String(cd.spellId)) &&
          !teamHealIds.has(String(cd.spellId)) &&
          !isProcOnlyActivation(cd.spellId),
      )
      .map((cd) => String(cd.spellId)),
  );
  const healIn = ((owner.healIn ?? []) as any[]).map((h) => ({
    t: h.timestamp,
    src: h.srcUnitId,
    a: Math.abs(h.effectiveAmount ?? h.amount ?? 0),
  }));
  const healOut = ((owner.healOut ?? []) as any[]).map((h) => ({
    t: h.timestamp,
    dest: h.destUnitId,
  }));
  const friendControlCasts: { t: number; dest: string }[] = [];
  for (const u of units) {
    if (!u.info || !friendIds.has(u.id) || u.id === owner.id) continue;
    for (const c of (u.spellCastEvents ?? []) as any[])
      if (CONTROL_IDS.has(String(c.spellId ?? "")))
        friendControlCasts.push({ t: c.timestamp, dest: c.destUnitId });
  }
  const posOf = (
    u: any,
    t: number,
    tol = 1500,
  ): { x: number; y: number } | null => {
    let best: any = null;
    for (const a of (u.advancedActions ?? []) as any[]) {
      if (a.advancedActorPositionX == null) continue;
      const d = Math.abs(a.timestamp - t);
      if (d <= tol && (!best || d < Math.abs(best.timestamp - t))) best = a;
    }
    return best
      ? { x: best.advancedActorPositionX, y: best.advancedActorPositionY }
      : null;
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const hpAt = (t: number): number | null => {
    let best: any = null;
    for (const a of samples) {
      const d = Math.abs(a.t - t);
      if (d <= 1500 && (!best || d < Math.abs(best.t - t))) best = a;
    }
    return best ? Math.round(best.hp * 100) : null;
  };
  const lowestAllyAt = (t: number): number | null => {
    let low: number | null = null;
    for (const arr of allySamples) {
      let best: { t: number; hp: number } | null = null;
      for (const a of arr) {
        if (Math.abs(a.t - t) > 3000) continue;
        if (!best || Math.abs(a.t - t) < Math.abs(best.t - t)) best = a;
      }
      if (best && (low === null || best.hp < low)) low = best.hp;
    }
    return low === null ? null : Math.round(low * 100);
  };

  const responsesAt = (t: number) => {
    const w0 = t - ACTION_PRE_MS,
      w1 = t + RESPONSE_WINDOW_MS;
    const inWin = (tt: number) => tt >= w0 && tt <= w1;
    const attackers = new Set(
      dmgSrc
        .filter((d) => d.t > t - DMG_WINDOW_MS && d.t <= t)
        .map((d) => d.src),
    );
    const castsIn = ownerCasts.filter((c) => inWin(c.t));
    const selfHeal = healIn
      .filter((h) => h.t > t && h.t <= w1 && h.src === owner.id)
      .reduce((n, h) => n + h.a, 0);
    const allyHeal = healIn
      .filter((h) => h.t > t && h.t <= w1 && h.src !== owner.id)
      .reduce((n, h) => n + h.a, 0);
    const maxHp = samples.find((s) => s.t >= t)?.max ?? samples[0]!.max;
    const p0 = posOf(owner, t),
      p1 = posOf(owner, w1);
    const moved = p0 && p1 ? dist(p0, p1) : null;
    let kited = false;
    if (p0 && p1 && attackers.size) {
      const near = (p: { x: number; y: number }, tt: number) => {
        let m = Infinity;
        for (const id of attackers) {
          const u = unitById.get(id);
          const q = u ? posOf(u, tt, 2500) : null;
          if (q) m = Math.min(m, dist(p, q));
        }
        return m;
      };
      const d0 = near(p0, t),
        d1 = near(p1, w1);
      kited = isFinite(d0) && isFinite(d1) && d1 - d0 >= KITE_GAIN_YARDS;
    }
    return {
      rThroughputCd: castsIn.some((c) => throughputIds.has(c.id)),
      rExternalCast: castsIn.some((c) => externalIds.has(c.id)),
      rTeamHealCd: castsIn.some((c) => teamHealIds.has(c.id)),
      rSelfHeal: selfHeal / maxHp >= SELF_HEAL_BIG,
      selfHeal3s: Math.round((selfHeal / maxHp) * 100) / 100,
      allyHeal3s: Math.round((allyHeal / maxHp) * 100) / 100,
      rOwnerControl: castsIn.some(
        (c) => CONTROL_IDS.has(c.id) && c.dest && !friendIds.has(c.dest),
      ),
      rPeel: friendControlCasts.some(
        (c) => inWin(c.t) && attackers.has(c.dest),
      ),
      rMoved: moved != null && moved >= MOVE_YARDS,
      moved3s: moved == null ? null : Math.round(moved),
      rKited: kited,
      rHealedOthers: healOut.some(
        (h) => h.t > t && h.t <= w1 && h.dest !== owner.id,
      ),
      rIdle: castsIn.length === 0,
      hpAfter5s: hpAt(t + 5000),
    };
  };

  const out: Opp[] = [];
  for (const x of crossings) {
    const tSec = (x.t - start) / 1000;
    const ready = wallCds.filter((cd) => cdAvailableAt(cd, tSec));
    const readyIds = new Set(ready.map((c) => String(c.spellId)));
    let lastAgo: number | null = null;
    for (const c of wallCasts)
      if (c.t < x.t - ACTION_PRE_MS) lastAgo = x.t - c.t;
      else break;
    let sum = 0;
    for (const d of dmg)
      if (d.t > x.t - DMG_WINDOW_MS && d.t <= x.t) sum += d.a;
    const press = wallCasts.find(
      (c) =>
        c.t >= x.t - ACTION_PRE_MS &&
        c.t <= x.t + ACTION_WINDOW_MS &&
        readyIds.has(c.id),
    );
    out.push({
      matchId,
      seq,
      bracket: meta?.bracket ?? legacy.startInfo?.bracket ?? "?",
      week: isoWeek(meta?.startTime ?? start),
      rating: meta?.playerTeamRating ?? null,
      pct,
      spec: specToString(owner.spec),
      tSec: Math.round(tSec * 10) / 10,
      hpPct: Math.round(x.hp * 100),
      dmg2s: Math.round((sum / x.max) * 100) / 100,
      inCC: cc.some((i) => i.from <= x.t && i.to >= x.t),
      wallsReady: ready.length,
      wallsInKit: wallCds.length,
      pressed: !!press,
      pressedId: press?.id ?? null,
      pressedDelayMs: press ? press.t - x.t : null,
      diedIn10s: deaths.some((d) => d >= x.t && d <= x.t + DEATH_LOOKAHEAD_MS),
      gateFiredThisRound: gateFired,
      lastWallCastAgoMs: lastAgo,
      enemyBurst: enemyBurstCasts.some(
        (t) => t > x.t - ENEMY_BURST_LOOKBACK_MS && t <= x.t,
      ),
      attackers2s: new Set(
        dmgSrc
          .filter((d) => d.t > x.t - DMG_WINDOW_MS && d.t <= x.t)
          .map((d) => d.src),
      ).size,
      externalRecent: externalsOnOwner.some(
        (t) => t > x.t - EXTERNAL_LOOKBACK_MS && t <= x.t + ACTION_WINDOW_MS,
      ),
      lowestAllyHp: lowestAllyAt(x.t),
      ...responsesAt(x.t),
    });
  }
  return out;
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
      const owner = friends.find((u) => isHealerSpec(u.spec));
      const mySeq = combats.length > 1 ? seq++ : null;
      if (!owner) continue;
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
  const rows: Opp[] = [];
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
  const usable = all.filter((r) => r.wallsReady > 0);
  const lines: string[] = [];
  lines.push(
    `# behavior prior — owner HP crossed ≤${CRISIS_HP_PCT * 100}% with a PERSONAL wall ready (v4: bigDefensiveSpellIds only)\n`,
  );
  lines.push(
    `matches ${matches}, opportunities ${rows.length} (${usable.length} ranked). Action = a ready wall cast within [−${ACTION_PRE_MS}ms, +${ACTION_WINDOW_MS}ms].\n`,
  );
  const byBracket = new Map<string, Opp[]>();
  for (const r of usable)
    (
      byBracket.get(r.bracket) ?? byBracket.set(r.bracket, []).get(r.bracket)!
    ).push(r);

  for (const [bracket, rs] of byBracket) {
    lines.push(`\n## ${bracket} (${rs.length} opportunities)\n`);
    const table = (title: string, filt: (r: Opp) => boolean) => {
      lines.push(`\n### ${title}\n`);
      lines.push(`| rank bucket | pressed a wall | died within 10s | n |`);
      lines.push(`|---|---|---|---|`);
      for (const b of BUCKETS) {
        const sub = rs.filter((r) => bucketOfPct(r.pct!) === b && filt(r));
        const p = sub.filter((r) => r.pressed).length;
        const d = sub.filter((r) => r.diedIn10s).length;
        lines.push(
          `| ${b} | ${pctStr(p, sub.length)} | ${pctStr(d, sub.length)} | ${sub.length} |`,
        );
      }
    };
    table("all crossings (not in CC)", (r) => !r.inCC);
    table("crossings while in CC", (r) => r.inCC);
    table(
      "not in CC, took ≥20% max HP in prior 2s",
      (r) => !r.inCC && r.dmg2s >= 0.2,
    );
    table(
      "not in CC, took <10% max HP in prior 2s",
      (r) => !r.inCC && r.dmg2s < 0.1,
    );
    table(
      "not in CC, owner died within 10s (hindsight slice)",
      (r) => !r.inCC && r.diedIn10s,
    );
    table("not in CC, owner survived 10s", (r) => !r.inCC && !r.diedIn10s);

    // state cells (CC × dmg2s) — the "behavior prior" lookup table
    lines.push(
      `\n### press rate by state cell (CC × dmg2s bin) — top10 vs 60-90 vs <30\n`,
    );
    lines.push(`| CC | dmg2s | top10 | 60-90 | <30 |`);
    lines.push(`|---|---|---|---|---|`);
    const ccBins: [string, (r: Opp) => boolean][] = [
      ["free", (r) => !r.inCC],
      ["in CC", (r) => r.inCC],
    ];
    const dmgBins: [string, (d: number) => boolean][] = [
      ["<10%", (d) => d < 0.1],
      ["10-20%", (d) => d >= 0.1 && d < 0.2],
      ["≥20%", (d) => d >= 0.2],
    ];
    for (const [cn, cf] of ccBins)
      for (const [dn, df] of dmgBins) {
        const cell = (b: string) => {
          const sub = rs.filter(
            (r) => cf(r) && bucketOfPct(r.pct!) === b && df(r.dmg2s),
          );
          return pctStr(sub.filter((r) => r.pressed).length, sub.length);
        };
        lines.push(
          `| ${cn} | ${dn} | ${cell("top10")} | ${cell("60-90")} | ${cell("<30")} |`,
        );
      }

    // context cells (v3): free, wall ready
    lines.push(
      `\n### context cells (not in CC) — press rate top10 vs 60-90 vs <30\n`,
    );
    lines.push(`| context | top10 | 60-90 | <30 |`);
    lines.push(`|---|---|---|---|`);
    const ctx: [string, (r: Opp) => boolean][] = [
      ["enemy burst CD in last 8s", (r) => r.enemyBurst],
      ["no enemy burst CD", (r) => !r.enemyBurst],
      ["≥2 attackers on you (2s)", (r) => r.attackers2s >= 2],
      ["≤1 attacker (2s)", (r) => r.attackers2s <= 1],
      ["teammate external on you (−5s..+3s)", (r) => r.externalRecent],
      ["no external", (r) => !r.externalRecent],
      [
        "a teammate also ≤40%",
        (r) => r.lowestAllyHp != null && r.lowestAllyHp <= 40,
      ],
      [
        "teammates all >40%",
        (r) => r.lowestAllyHp != null && r.lowestAllyHp > 40,
      ],
      [
        "burst + ≥2 attackers + no external",
        (r) => r.enemyBurst && r.attackers2s >= 2 && !r.externalRecent,
      ],
      ["no burst + ≤1 attacker", (r) => !r.enemyBurst && r.attackers2s <= 1],
    ];
    for (const [name, f] of ctx) {
      const cell = (b: string) => {
        const sub = rs.filter(
          (r) => !r.inCC && bucketOfPct(r.pct!) === b && f(r),
        );
        return pctStr(sub.filter((r) => r.pressed).length, sub.length);
      };
      lines.push(
        `| ${name} | ${cell("top10")} | ${cell("60-90")} | ${cell("<30")} |`,
      );
    }
    // death rate by context, top10 — does the context predict lethality?
    lines.push(`\n### died ≤10s by context (not in CC), top10 vs <30\n`);
    lines.push(`| context | top10 | <30 |`);
    lines.push(`|---|---|---|`);
    for (const [name, f] of ctx) {
      const cell = (b: string) => {
        const sub = rs.filter(
          (r) => !r.inCC && bucketOfPct(r.pct!) === b && f(r),
        );
        return pctStr(sub.filter((r) => r.diedIn10s).length, sub.length);
      };
      lines.push(`| ${name} | ${cell("top10")} | ${cell("<30")} |`);
    }

    // v4: response mix (multi-label) by rank, free & wall ready
    const RESP: [string, (r: Opp) => boolean][] = [
      ["personal wall", (r) => r.pressed],
      ["external defensive cast (self or ally)", (r) => r.rExternalCast],
      ["team-heal CD", (r) => r.rTeamHealCd],
      ["other major CD (PI / wings / …)", (r) => r.rThroughputCd],
      ["self-heal ≥15% in 3s", (r) => r.rSelfHeal],
      ["own CC / root / interrupt on enemy", (r) => r.rOwnerControl],
      ["teammate peel on your attacker", (r) => r.rPeel],
      ["moved ≥15yd", (r) => r.rMoved],
      ["kited: +8yd from nearest attacker", (r) => r.rKited],
      ["kept healing others", (r) => r.rHealedOthers],
      ["cast nothing", (r) => r.rIdle],
      [
        "none of: wall/external/teamCD/otherCD/self-heal/control/peel/kite",
        (r) =>
          !(
            r.pressed ||
            r.rExternalCast ||
            r.rTeamHealCd ||
            r.rThroughputCd ||
            r.rSelfHeal ||
            r.rOwnerControl ||
            r.rPeel ||
            r.rKited
          ),
      ],
    ];
    const respTable = (title: string, filt: (r: Opp) => boolean) => {
      lines.push(`\n### ${title}\n`);
      lines.push(`| response within 3s | ${BUCKETS.join(" | ")} |`);
      lines.push(`|---|${BUCKETS.map(() => "---").join("|")}|`);
      for (const [name, f] of RESP) {
        const cells = BUCKETS.map((b) => {
          const sub = rs.filter((r) => filt(r) && bucketOfPct(r.pct!) === b);
          return pctStr(sub.filter(f).length, sub.length);
        });
        lines.push(`| ${name} | ${cells.join(" | ")} |`);
      }
      const med = (b: string, k: (r: Opp) => number | null) => {
        const v = rs
          .filter((r) => filt(r) && bucketOfPct(r.pct!) === b)
          .map(k)
          .filter((x): x is number => x != null)
          .sort((a, c) => a - c);
        return v.length ? String(v[Math.floor(v.length / 2)]) : "—";
      };
      lines.push(
        `| median self-heal in 3s (% maxHP) | ${BUCKETS.map((b) => med(b, (r) => Math.round(r.selfHeal3s * 100))).join(" | ")} |`,
      );
      lines.push(
        `| median ally heal on you in 3s (% maxHP) | ${BUCKETS.map((b) => med(b, (r) => Math.round(r.allyHeal3s * 100))).join(" | ")} |`,
      );
      lines.push(
        `| median yards moved in 3s | ${BUCKETS.map((b) => med(b, (r) => r.moved3s)).join(" | ")} |`,
      );
      lines.push(
        `| median HP 5s later | ${BUCKETS.map((b) => med(b, (r) => r.hpAfter5s)).join(" | ")} |`,
      );
    };
    respTable("response mix — not in CC, wall ready", (r) => !r.inCC);
    respTable(
      "response mix — not in CC, wall ready, enemy burst CD or ≥2 attackers",
      (r) => !r.inCC && (r.enemyBurst || r.attackers2s >= 2),
    );
    respTable(
      "response mix — not in CC, wall ready, wall NOT pressed",
      (r) => !r.inCC && !r.pressed,
    );
    respTable("response mix — in CC, wall ready", (r) => r.inCC);

    // pre-emptive walls: every crossing in this bracket (wall ready or not),
    // how often had a wall been pressed in the 10s BEFORE the HP got here?
    const allB = all.filter((r) => r.bracket === bracket);
    lines.push(
      `\n### pre-emptive walls — all ${allB.length} crossings in this bracket (wall ready or not)\n`,
    );
    lines.push(
      `| rank bucket | wall pressed ≤10s BEFORE crossing | no wall ready at crossing | pressed before OR within 3s after | n |`,
    );
    lines.push(`|---|---|---|---|---|`);
    for (const b of BUCKETS) {
      const sub = allB.filter((r) => bucketOfPct(r.pct!) === b);
      const pre = (r: Opp) =>
        r.lastWallCastAgoMs != null && r.lastWallCastAgoMs <= 10000;
      lines.push(
        `| ${b} | ${pctStr(sub.filter(pre).length, sub.length)} | ${pctStr(sub.filter((r) => r.wallsReady === 0).length, sub.length)} | ${pctStr(sub.filter((r) => r.pressed || pre(r)).length, sub.length)} | ${sub.length} |`,
      );
    }

    // product gate cross-reference
    const top = rs.filter(
      (r) => bucketOfPct(r.pct!) === "top10" && !r.inCC && r.dmg2s >= 0.2,
    );
    lines.push(
      `\n### product gate cross-reference — rounds where death-unused-defensive fired\n`,
    );
    lines.push(
      `top10 press rate in this bracket's (free, dmg2s≥20%) cell: ${pctStr(top.filter((r) => r.pressed).length, top.length)}\n`,
    );
    lines.push(
      `| rank bucket | rounds fired | crossings (wall ready) in those rounds | of which died ≤10s & no press |`,
    );
    lines.push(`|---|---|---|---|`);
    for (const b of BUCKETS) {
      const sub = rs.filter(
        (r) => bucketOfPct(r.pct!) === b && r.gateFiredThisRound,
      );
      lines.push(
        `| ${b} | ${new Set(sub.map((r) => `${r.matchId}#${r.seq}`)).size} | ${sub.length} | ${sub.filter((r) => r.diedIn10s && !r.pressed).length} |`,
      );
    }

    // delay distribution among presses, top10
    const delays = rs
      .filter(
        (r) =>
          r.pressed &&
          bucketOfPct(r.pct!) === "top10" &&
          r.pressedDelayMs != null,
      )
      .map((r) => r.pressedDelayMs!)
      .sort((a, b) => a - b);
    if (delays.length)
      lines.push(
        `\npress delay after crossing (top10, n=${delays.length}): p25 ${delays[Math.floor(delays.length * 0.25)]}ms, p50 ${delays[Math.floor(delays.length * 0.5)]}ms, p75 ${delays[Math.floor(delays.length * 0.75)]}ms`,
      );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

if (cmd === "scan") await scan();
else if (cmd === "report") report();
else {
  console.error("usage: behaviorPriorScan.ts scan|report ...");
  process.exit(1);
}
