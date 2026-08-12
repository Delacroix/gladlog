/**
 * Eight fact-checking queries over a single `LegacyRound`, plus the single
 * shared dispatch (`runQuery`) both the prescreen (a later task) and the
 * exploration CLI call. Per CLAUDE.md's shared-predicate rule and the plan's
 * global constraint, this file writes zero sampling logic of its own — every
 * fact below is read off an existing `@gladlog/analysis` export, and every
 * instant is floored to the prompt's render grid (`toRenderSecond`) BEFORE
 * that export is called, so a query's answer always matches what the same
 * instant would render as in a prompt.
 *
 * `runQuery` is pure (no I/O, no `process.exit`) — it only parses `argv`,
 * floors times, and calls the per-query line-builders below.
 */
import {
  analyzeOutgoingCCChains,
  cdAvailableAt,
  detectHealingGaps,
  distanceBetween,
  extractMajorCooldowns,
  fmtTime,
  formatHealingGapsForContext,
  getHpPercentAtTime,
  getUnitPositionAtTime,
  type IMajorCooldownInfo,
  INTERP_MAX_GAP_MS,
  type IOutgoingCCApplication,
  isHealerSpec,
  LOS_SWEEP_GAP_MS,
  specToString,
  toRenderSecond,
} from "@gladlog/analysis";
import {
  aurasActiveAt,
  buildCastFlowLines,
} from "@gladlog/analysis/src/analysis/momentSnapshot";
import {
  getUnitRawPositionAtTime,
  hasLineOfSight,
} from "@gladlog/analysis/src/utils/losAnalysis";
import type { ICombatUnit } from "@gladlog/parser-compat";

import { type LegacyRound, overviewLines, splitTeams } from "./storeAccess";

const NO_DATA = "(无数据)";

/** All player units (friends + enemies), same population every query below
 * iterates — `splitTeams` is the single source for "who counts as a player"
 * (see its own header comment). */
function allPlayers(legacy: LegacyRound): ICombatUnit[] {
  const { friends, enemies } = splitTeams(legacy);
  return [...friends, ...enemies];
}

// ---------------------------------------------------------------------------
// cd
// ---------------------------------------------------------------------------

/** Remaining seconds until `cd` is off cooldown at `tt` (a render-grid
 * second). Only meaningful when `cdAvailableAt(cd, tt)` is false; derived
 * from the exact same fields (`cd.casts`, `cd.cooldownSeconds`) that
 * `cdAvailableAt`/`isCooldownAvailableFromLastUse` read — not a second
 * "available" judgement, just the arithmetic distance `cdAvailableAt`
 * doesn't itself expose. Its "most recent cast at/before t" lookup is a
 * hand-copy of the one inside `cdAvailableAt` (no export exposes it) —
 * 平价单测钉住与 cdAvailableAt 的边界一致性:explore.queries.test.ts. */
export function remainingCdSeconds(
  cd: Pick<IMajorCooldownInfo, "casts" | "cooldownSeconds" | "neverUsed">,
  tt: number,
): number {
  const last = [...cd.casts].filter((c) => c.timeSeconds <= tt).pop();
  if (!last) return 0;
  return last.timeSeconds + cd.cooldownSeconds - tt;
}

export function cdLines(legacy: LegacyRound, t: number): string[] {
  const tt = toRenderSecond(t);
  const lines = [`## cd @ ${fmtTime(tt)}`];
  const players = allPlayers(legacy);
  if (players.length === 0) {
    lines.push(NO_DATA);
    return lines;
  }
  for (const u of players) {
    const cds = extractMajorCooldowns(u, legacy);
    const ready = cds.filter((cd) => cdAvailableAt(cd, tt));
    const onCd = cds.filter((cd) => !cdAvailableAt(cd, tt));
    const readyStr = ready.length
      ? ready.map((cd) => cd.spellName).join(",")
      : "无";
    const onCdStr = onCd.length
      ? onCd
          .map(
            (cd) =>
              `${cd.spellName}(还剩 ${Math.max(0, Math.round(remainingCdSeconds(cd, tt)))}s)`,
          )
          .join(",")
      : "无";
    lines.push(
      `${fmtTime(tt)} ${u.name} ready: ${readyStr} | onCd: ${onCdStr}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// hp / hpcurve
// ---------------------------------------------------------------------------

function hpLineFor(u: ICombatUnit, tt: number, matchStartMs: number): string {
  const pct = getHpPercentAtTime(u, tt, matchStartMs);
  const pctStr = pct === null ? "无样本" : `${pct.toFixed(0)}%`;
  return `${fmtTime(tt)} ${u.name} HP: ${pctStr}`;
}

export function hpLines(legacy: LegacyRound, t: number): string[] {
  const tt = toRenderSecond(t);
  const lines = [`## hp @ ${fmtTime(tt)}`];
  const players = allPlayers(legacy);
  if (players.length === 0) {
    lines.push(NO_DATA);
    return lines;
  }
  for (const u of players) lines.push(hpLineFor(u, tt, legacy.startTime));
  return lines;
}

export function hpCurveLines(
  legacy: LegacyRound,
  fromS: number,
  toS: number,
  stepS: number,
): string[] {
  const fromTT = toRenderSecond(fromS);
  const toTT = toRenderSecond(toS);
  const stepTT = Math.max(1, toRenderSecond(stepS));
  const lines = [`## hpcurve @ ${fmtTime(fromTT)}-${fmtTime(toTT)}`];
  const players = allPlayers(legacy);
  if (players.length === 0 || toTT < fromTT) {
    lines.push(NO_DATA);
    return lines;
  }
  for (let tt = fromTT; tt <= toTT; tt += stepTT) {
    for (const u of players) lines.push(hpLineFor(u, tt, legacy.startTime));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// auras
// ---------------------------------------------------------------------------

export function auraLines(legacy: LegacyRound, t: number): string[] {
  const tt = toRenderSecond(t);
  const lines = [`## auras @ ${fmtTime(tt)}`];
  const players = allPlayers(legacy);
  if (players.length === 0) {
    lines.push(NO_DATA);
    return lines;
  }
  for (const u of players) {
    const auras = aurasActiveAt(u, legacy, tt);
    lines.push(
      `${fmtTime(tt)} ${u.name} auras: ${auras.length ? auras.join("、") : "无"}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// pos
// ---------------------------------------------------------------------------

export function posLines(legacy: LegacyRound, t: number): string[] {
  const tt = toRenderSecond(t);
  const tMs = legacy.startTime + tt * 1000;
  const lines = [`## pos @ ${fmtTime(tt)}`];
  const { owner } = splitTeams(legacy);
  const others = allPlayers(legacy).filter((u) => u !== owner);

  const ownerPos = owner
    ? getUnitPositionAtTime(owner, tMs, INTERP_MAX_GAP_MS)
    : null;
  const ownerRaw = owner
    ? getUnitRawPositionAtTime(owner, tMs, LOS_SWEEP_GAP_MS)
    : null;
  const zoneId = legacy.startInfo?.zoneId;

  let any = false;
  if (owner && ownerPos) {
    for (const u of others) {
      const pos = getUnitPositionAtTime(u, tMs, INTERP_MAX_GAP_MS);
      if (!pos) continue;
      const dist = distanceBetween(ownerPos, pos).toFixed(1);

      let losStr = "未知";
      if (ownerRaw && zoneId) {
        const otherRaw = getUnitRawPositionAtTime(u, tMs, LOS_SWEEP_GAP_MS);
        if (otherRaw) {
          const los = hasLineOfSight(zoneId, ownerRaw, otherRaw);
          // null → "未知", never treated as false (per shared-predicate rule).
          losStr = los === null ? "未知" : los ? "通" : "挡";
        }
      }
      lines.push(`${fmtTime(tt)} ${u.name} dist ${dist}yd | LoS ${losStr}`);
      any = true;
    }
  }
  if (!any) lines.push(NO_DATA);
  return lines;
}

// ---------------------------------------------------------------------------
// dr
// ---------------------------------------------------------------------------

export function drLines(
  legacy: LegacyRound,
  fromS: number,
  toS: number,
): string[] {
  const fromTT = toRenderSecond(fromS);
  const toTT = toRenderSecond(toS);
  const lines = [`## dr @ ${fmtTime(fromTT)}-${fmtTime(toTT)}`];
  const { friends, enemies } = splitTeams(legacy);

  interface Row {
    atTT: number;
    casterName: string;
    casterSpec: string;
    targetName: string;
    targetSpec: string;
    app: IOutgoingCCApplication;
  }
  const rows: Row[] = [];

  const collect = (
    chains: ReturnType<typeof analyzeOutgoingCCChains>,
  ): void => {
    for (const chain of chains) {
      for (const app of chain.applications) {
        const atTT = toRenderSecond(app.atSeconds);
        if (atTT < fromTT || atTT > toTT) continue;
        rows.push({
          atTT,
          casterName: app.casterName,
          casterSpec: app.casterSpec,
          targetName: chain.targetName,
          targetSpec: chain.targetSpec,
          app,
        });
      }
    }
  };

  // Both directions: friends' CC landing on enemies, and enemies' CC landing
  // on friends — "双向 CC 链" per the brief.
  collect(analyzeOutgoingCCChains(friends, enemies, legacy));
  collect(analyzeOutgoingCCChains(enemies, friends, legacy));

  rows.sort((a, b) => a.atTT - b.atTT);
  if (rows.length === 0) {
    lines.push(NO_DATA);
    return lines;
  }
  for (const r of rows) {
    lines.push(
      `${fmtTime(r.atTT)} ${r.casterName}(${r.casterSpec}) → ${r.targetName}(${r.targetSpec}) ${r.app.spellName} DR:${r.app.drInfo.level} 时长${r.app.durationSeconds.toFixed(1)}s`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// flow
// ---------------------------------------------------------------------------

export function flowLines(
  legacy: LegacyRound,
  fromS: number,
  toS: number,
): string[] {
  const fromTT = toRenderSecond(fromS);
  const toTT = toRenderSecond(toS);
  const lines = [`## flow @ ${fmtTime(fromTT)}-${fmtTime(toTT)}`];
  const flow = buildCastFlowLines(legacy, fromTT, toTT);
  lines.push(...(flow.length ? flow : [NO_DATA]));
  return lines;
}

// ---------------------------------------------------------------------------
// gaps
// ---------------------------------------------------------------------------

export function gapLines(legacy: LegacyRound): string[] {
  const lines = ["## gaps"];
  const { friends, enemies } = splitTeams(legacy);
  const healers = friends.filter((u) => isHealerSpec(u.spec));
  if (healers.length === 0) {
    lines.push(NO_DATA);
    return lines;
  }
  let any = false;
  for (const healer of healers) {
    const gaps = detectHealingGaps(healer, friends, enemies, legacy);
    if (gaps.length === 0) continue;
    any = true;
    lines.push(`-- ${healer.name}(${specToString(healer.spec)}) --`);
    lines.push(...formatHealingGapsForContext(gaps));
  }
  if (!any) lines.push(NO_DATA);
  return lines;
}

// ---------------------------------------------------------------------------
// runQuery — the shared dispatch
// ---------------------------------------------------------------------------

const USAGE =
  "usage: overview|cd --t S|hp --t S|hpcurve --from S --to S --step S|auras --t S|pos --t S|dr --from S --to S|flow --from S --to S|gaps";

function flagNum(argv: string[], name: string): number | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The single shared dispatch for the eight queries above (plus `overview`).
 * Both the prescreen and the exploration CLI must call this — not the
 * individual `*Lines` functions directly — so the two never drift on how a
 * subcommand's flags are parsed or validated. Pure: no I/O, never exits the
 * process; illegal input always throws `Error("usage: …")`.
 */
export function runQuery(legacy: LegacyRound, argv: string[]): string[] {
  const [cmd, ...rest] = argv;
  const t = flagNum(rest, "t");
  const fromS = flagNum(rest, "from");
  const toS = flagNum(rest, "to");
  const stepS = flagNum(rest, "step");

  switch (cmd) {
    case "overview":
      return overviewLines(legacy);
    case "cd":
      if (t === undefined) throw new Error(USAGE);
      return cdLines(legacy, t);
    case "hp":
      if (t === undefined) throw new Error(USAGE);
      return hpLines(legacy, t);
    case "hpcurve":
      if (fromS === undefined || toS === undefined || stepS === undefined)
        throw new Error(USAGE);
      return hpCurveLines(legacy, fromS, toS, stepS);
    case "auras":
      if (t === undefined) throw new Error(USAGE);
      return auraLines(legacy, t);
    case "pos":
      if (t === undefined) throw new Error(USAGE);
      return posLines(legacy, t);
    case "dr":
      if (fromS === undefined || toS === undefined) throw new Error(USAGE);
      return drLines(legacy, fromS, toS);
    case "flow":
      if (fromS === undefined || toS === undefined) throw new Error(USAGE);
      return flowLines(legacy, fromS, toS);
    case "gaps":
      return gapLines(legacy);
    default:
      throw new Error(USAGE);
  }
}
