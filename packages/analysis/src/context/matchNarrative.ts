import { ICombatUnit } from "@gladlog/parser-compat";

import {
  cdAvailableAt,
  fmtTime,
  IMajorCooldownInfo,
  specToString,
} from "../utils/cooldowns";
import { IEnemyCDTimeline } from "../utils/enemyCDs";
import { lastCastBefore } from "./timelineHelpers";

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds a brief event-driven Match Flow narrative from burst windows and CD trades.
 * Segments are defined by burst windows (not time slices) so the LLM sees
 * Opening Burst → Post-Trade Window → Final Burst/Phase in causal order.
 *
 * @deprecated Replaced by `buildMatchArc` in production. Retained for test coverage only.
 * @internal Do not use in production prompt builders. Not exported from the public surface.
 */
export function buildMatchFlow(
  enemyCDTimeline: IEnemyCDTimeline,
  ownerCooldowns: IMajorCooldownInfo[],
  allTeamCooldownsWithPlayer: Array<{
    player: ICombatUnit;
    cd: IMajorCooldownInfo;
  }>,
  friendlyDeaths: Array<{ spec: string; atSeconds: number }>,
  durationSeconds: number,
): string[] {
  const lines: string[] = [];
  const bursts = [...enemyCDTimeline.alignedBurstWindows].sort(
    (a, b) => a.fromSeconds - b.fromSeconds,
  );
  const firstDeath = friendlyDeaths[0];

  lines.push("MATCH FLOW:");
  lines.push("");

  if (bursts.length === 0) {
    lines.push(
      "  No coordinated enemy bursts detected — match resolved through sustained pressure.",
    );
    if (firstDeath)
      lines.push(
        `  → ${firstDeath.spec} died at ${fmtTime(firstDeath.atSeconds)}.`,
      );
    lines.push("");
    return lines;
  }

  const firstBurst = bursts[0];

  // Segment 1: Opening burst
  lines.push(
    `  Opening Burst (${fmtTime(firstBurst.fromSeconds)}–${fmtTime(firstBurst.toSeconds)}):`,
  );
  const burstCDNames = firstBurst.activeCDs.map((c) => c.spellName).join(" + ");
  lines.push(
    `    - Enemy aligned burst (${firstBurst.dangerLabel} — ${burstCDNames})`,
  );

  // Defensive CDs traded into this burst (owner + teammates)
  const tradedDefItems: Array<{
    spec: string;
    spellName: string;
    cooldownSeconds: number;
  }> = [];
  for (const { player, cd } of allTeamCooldownsWithPlayer) {
    if (cd.tag !== "Defensive") continue;
    const traded = cd.casts.find(
      (c) =>
        c.timeSeconds >= firstBurst.fromSeconds - 5 &&
        c.timeSeconds <= firstBurst.toSeconds + 5,
    );
    if (traded) {
      tradedDefItems.push({
        spec: specToString(player.spec),
        spellName: cd.spellName,
        cooldownSeconds: cd.cooldownSeconds,
      });
    }
  }

  if (tradedDefItems.length > 0) {
    const formatted = tradedDefItems
      .map((item) => `${item.spec}'s ${item.spellName}`)
      .join(" + ");
    lines.push(`    - Team responded: ${formatted} committed`);
  } else {
    lines.push(`    - No major defensive CDs traded into this burst`);
  }

  // Check if match duration is shorter than the shortest traded team defensive CD's cooldown
  if (tradedDefItems.length > 0) {
    const minCooldown = Math.min(
      ...tradedDefItems.map((item) => item.cooldownSeconds),
    );
    if (durationSeconds < minCooldown) {
      lines.push(
        `    - Match duration (${fmtTime(durationSeconds)}) did not allow recovery of these major cooldowns after this trade`,
      );
      lines.push(
        `    - This match contained only one full cooldown cycle for the committed defensive abilities`,
      );
    }
  }
  lines.push("");

  // Segment 2: Post-trade window (between first and second burst, or first burst and death)
  const secondBurst = bursts[1];
  const midEnd = secondBurst
    ? secondBurst.fromSeconds
    : firstDeath
      ? firstDeath.atSeconds - 5
      : durationSeconds - 5;
  if (midEnd - firstBurst.toSeconds > 5) {
    lines.push(
      `  Post-Trade Window (${fmtTime(firstBurst.toSeconds)}–${fmtTime(midEnd)}):`,
    );
    const ownerDefsAvailableInWindow = ownerCooldowns.filter((cd) => {
      if (cd.tag !== "Defensive") return false;
      const lastCast = lastCastBefore(cd, firstBurst.toSeconds);
      if (!lastCast) return true; // never-used or not yet cast — still available
      return lastCast.timeSeconds + cd.cooldownSeconds <= midEnd;
    });
    if (ownerDefsAvailableInWindow.length === 0) {
      lines.push(
        `    - No major defensive CDs available on owner during this window`,
      );
    }
    if (!secondBurst) {
      lines.push(
        `    - No coordinated enemy burst — both sides recovering CDs`,
      );
    }
    lines.push("");
  }

  // Segment 3: Final burst or final phase
  const finalBurst = bursts.length >= 2 ? bursts[bursts.length - 1] : undefined;
  const finalEndTime = firstDeath?.atSeconds ?? durationSeconds;

  if (finalBurst) {
    lines.push(
      `  Final Burst (${fmtTime(finalBurst.fromSeconds)}–${fmtTime(finalEndTime)}):`,
    );
    const finalCDNames = finalBurst.activeCDs
      .map((c) => c.spellName)
      .join(" + ");
    lines.push(
      `    - Enemy burst (${finalBurst.dangerLabel} — ${finalCDNames})`,
    );
  } else {
    lines.push(
      `  Final Phase (${fmtTime(firstBurst.toSeconds)}–${fmtTime(finalEndTime)}):`,
    );
  }

  // Owner defensive CD state at death / match end. Single-source predicate
  // (BACKLOG #18 Minor #3, follow-up round): the point-in-time question "is it
  // available at death / at match end" is shared with cdAvailableAt.
  const spentAtEnd = ownerCooldowns
    .filter((cd) => cd.tag === "Defensive")
    .filter((cd) => !cdAvailableAt(cd, finalEndTime))
    .map((cd) => cd.spellName);
  if (spentAtEnd.length > 0) {
    lines.push(
      `    - ${firstDeath ? "At death" : "At match end"}: ${spentAtEnd.join(", ")} on cooldown`,
    );
  }
  if (firstDeath) {
    lines.push(
      `    - → ${firstDeath.spec} died at ${fmtTime(firstDeath.atSeconds)}`,
    );
  } else {
    lines.push(`    - → No friendly deaths — match ended in a win`);
  }
  lines.push("");

  return lines;
}

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Structured phase of `buildMatchArc`. `prose` is the exact sentence
 * `buildMatchArc` renders after the colon for this phase — the two must
 * stay byte-identical (gate predicates are the spec: the structured output is
 * the single source, prose only formats it).
 */
export interface IMatchArcPhase {
  phase: "early" | "mid" | "late";
  fromS: number;
  toS: number;
  /** One sentence for this phase (identical to the text after the colon on
   * buildMatchArc's corresponding line). */
  prose: string;
  /** early = the first defensive CD; mid = the first death or the first burst
   * window resolving, whichever comes earlier. */
  turningPoint?: { tS: number; label: string };
}

/**
 * Builds a compact 3-sentence match arc (Early / Mid / Late) before the CRITICAL MOMENTS
 * section, so the LLM understands match flow before evaluating individual moments.
 *
 * Phase boundaries (per AI_CONTEXT_REFACTOR.md):
 *   Early: match start → first major defensive used by either team
 *   Mid:   first defensive → first friendly death OR first burst window resolved
 *   Late:  that boundary → match end
 *
 * Edge cases:
 *   - Match < 90s: collapse to two phases (Pressure / Death or Resolution)
 *   - 3v3 + duration > 180s + no deaths: Late = "dampening reached"
 *   - Win with no friendly deaths: three phases still emitted; Late describes kill finish
 *
 * This is the structured single source (#10 T1). `buildMatchArc` below is a
 * pure formatter over this output — do not duplicate the phase-boundary math.
 */
export function buildMatchArcStructured(
  enemyCDTimeline: IEnemyCDTimeline,
  allTeamCooldownsWithPlayer: Array<{
    player: ICombatUnit;
    cd: IMajorCooldownInfo;
  }>,
  friendlyDeaths: Array<{ spec: string; atSeconds: number }>,
  durationSeconds: number,
  bracket: string,
): IMatchArcPhase[] {
  // Edge case: very short match — collapse to two phases
  if (durationSeconds < 90) {
    const mid = Math.round(durationSeconds / 2);
    const phases: IMatchArcPhase[] = [
      {
        phase: "early",
        fromS: 0,
        toS: mid,
        prose: "Early pressure established — no recovery window.",
      },
    ];
    if (friendlyDeaths.length > 0) {
      const d = friendlyDeaths[0];
      phases.push({
        phase: "late",
        fromS: mid,
        toS: durationSeconds,
        prose: `${d.spec} died at ${fmtTime(d.atSeconds)} — speed kill.`,
      });
    } else {
      phases.push({
        phase: "late",
        fromS: mid,
        toS: durationSeconds,
        prose: "Match resolved quickly — no friendly deaths.",
      });
    }
    return phases;
  }

  const burstsSorted = [...enemyCDTimeline.alignedBurstWindows].sort(
    (a, b) => a.fromSeconds - b.fromSeconds,
  );
  const firstBurst = burstsSorted[0] ?? null;
  const firstDeath = friendlyDeaths[0];

  // Find first defensive cast from either team
  let firstDefensiveSeconds = Infinity;
  let firstDefensiveName = "";
  let firstDefensiveSpec = "";
  for (const { player, cd } of allTeamCooldownsWithPlayer) {
    if (cd.tag !== "Defensive" || cd.neverUsed || cd.casts.length === 0)
      continue;
    const cast = cd.casts[0];
    if (cast.timeSeconds < firstDefensiveSeconds) {
      firstDefensiveSeconds = cast.timeSeconds;
      firstDefensiveName = cd.spellName;
      firstDefensiveSpec = specToString(player.spec);
    }
  }

  // Phase boundaries
  const earlyEnd =
    firstDefensiveSeconds < Infinity
      ? firstDefensiveSeconds
      : durationSeconds / 2;
  const firstBurstResolved =
    firstBurst !== null ? firstBurst.toSeconds : Infinity;
  const firstFriendlyDeathSeconds = firstDeath?.atSeconds ?? Infinity;
  const midEnd = Math.min(firstFriendlyDeathSeconds, firstBurstResolved);
  // Clamp lateStart >= earlyEnd to prevent inverted phase ranges (e.g. "Mid (1:11–0:53)")
  // when a death/burst occurs before the first defensive is spent.
  const rawLateStart =
    midEnd < Infinity ? midEnd : earlyEnd + (durationSeconds - earlyEnd) / 2;
  const lateStart = Math.max(earlyEnd, rawLateStart);

  const phases: IMatchArcPhase[] = [];

  // Early phase prose
  const earlyBursts = burstsSorted.filter((b) => b.fromSeconds < earlyEnd);
  let earlyProse: string;
  if (earlyBursts.length > 0) {
    const burst = earlyBursts[0];
    const cdNames = burst.activeCDs.map((c) => c.spellName).join(" + ");
    earlyProse = `Enemy aligned burst established pressure (${burst.dangerLabel} — ${cdNames}); no major defensives spent.`;
  } else if (firstDefensiveSeconds === Infinity) {
    earlyProse =
      "No coordinated burst; match opened with sustained pressure and no defensive CDs committed.";
  } else {
    earlyProse =
      "No coordinated enemy burst in opening phase; sustained/DoT pressure building.";
  }
  const earlyPhase: IMatchArcPhase = {
    phase: "early",
    fromS: 0,
    toS: earlyEnd,
    prose: earlyProse,
  };
  if (firstDefensiveSeconds < Infinity) {
    earlyPhase.turningPoint = {
      tS: firstDefensiveSeconds,
      label: `${firstDefensiveSpec}'s ${firstDefensiveName}`,
    };
  }
  phases.push(earlyPhase);

  // Mid phase prose — skip if zero-duration (earlyEnd === lateStart, e.g. first death/burst before first defensive)
  if (earlyEnd < lateStart) {
    let midProse: string;
    if (firstDefensiveSeconds < Infinity) {
      const midBursts = burstsSorted.filter(
        (b) => b.fromSeconds >= earlyEnd && b.fromSeconds < lateStart,
      );
      const burstNote =
        midBursts.length > 0
          ? ` in response to ${midBursts[0].dangerLabel} burst at ${fmtTime(midBursts[0].fromSeconds)}`
          : "";
      midProse = `${firstDefensiveSpec}'s ${firstDefensiveName} committed${burstNote} — limited major CD coverage remaining.`;
    } else {
      midProse =
        "No major defensive CDs committed; match progressed through sustained pressure.";
    }
    const midPhase: IMatchArcPhase = {
      phase: "mid",
      fromS: earlyEnd,
      toS: lateStart,
      prose: midProse,
    };
    if (midEnd < Infinity) {
      midPhase.turningPoint =
        firstFriendlyDeathSeconds <= firstBurstResolved
          ? { tS: midEnd, label: `${firstDeath!.spec} died` }
          : { tS: midEnd, label: "burst window resolved" };
    }
    phases.push(midPhase);
  }

  // Late phase prose
  let lateProse: string;
  const lateBursts = burstsSorted.filter((b) => b.fromSeconds >= lateStart);
  const lateBurstNote =
    lateBursts.length > 0
      ? `Second burst (${lateBursts[0].dangerLabel}) aligned with`
      : "Pressure continued with";
  if (firstDeath) {
    lateProse = `${lateBurstNote} limited defensive options → ${firstDeath.spec} died at ${fmtTime(firstDeath.atSeconds)}.`;
  } else if (bracket === "3v3" && durationSeconds > 180) {
    lateProse =
      "Dampening reached — healing reduced; match extended to kill window.";
  } else {
    lateProse = "Match concluded — no friendly deaths; pressure neutralized.";
  }
  phases.push({
    phase: "late",
    fromS: lateStart,
    toS: durationSeconds,
    prose: lateProse,
  });

  return phases;
}

/**
 * Formats `buildMatchArcStructured`'s output into the `MATCH ARC:` prose block.
 * Pure formatter — do not recompute phase boundaries here; consume the
 * structured phases (gate predicates are the spec: analysis and the gate must
 * share one predicate for the same judgment; prose is only the render layer).
 * Output must stay byte-identical to the pre-refactor
 * implementation (see matchNarrative.arc.test.ts consistency assertions).
 */
export function buildMatchArc(
  enemyCDTimeline: IEnemyCDTimeline,
  allTeamCooldownsWithPlayer: Array<{
    player: ICombatUnit;
    cd: IMajorCooldownInfo;
  }>,
  friendlyDeaths: Array<{ spec: string; atSeconds: number }>,
  durationSeconds: number,
  bracket: string,
): string[] {
  const lines: string[] = [];
  lines.push("MATCH ARC:");

  const phases = buildMatchArcStructured(
    enemyCDTimeline,
    allTeamCooldownsWithPlayer,
    friendlyDeaths,
    durationSeconds,
    bracket,
  );

  // Edge case: very short match — collapse to two phases
  if (durationSeconds < 90) {
    const [pressure, resolution] = phases;
    lines.push(`  Pressure (0:00–${fmtTime(pressure.toS)}): ${pressure.prose}`);
    const label = friendlyDeaths.length > 0 ? "Death" : "Resolution";
    lines.push(
      `  ${label} (${fmtTime(resolution.fromS)}–${fmtTime(resolution.toS)}): ${resolution.prose}`,
    );
    return lines;
  }

  const headerLabel: Record<IMatchArcPhase["phase"], string> = {
    early: "Early",
    mid: "Mid",
    late: "Late",
  };
  for (const phase of phases) {
    lines.push(
      `  ${headerLabel[phase.phase]} (${fmtTime(phase.fromS)}–${fmtTime(phase.toS)}): ${phase.prose}`,
    );
  }

  return lines;
}
