import {
  buildDeepDivePack,
  buildMatchContext,
  buildOffensiveDeepDivePack,
  buildWindowPack,
  classifyFindingKind,
  DEEP_DIVE_MAX,
  extractCandidateFindings,
  hasCoachableSignal,
  hasOffensiveCoachableSignal,
  isHealerSpec,
  SEVERITY_RANK,
  specToString,
  type DeepDivePack,
  type Finding,
} from "@gladlog/analysis";
import { CombatUnitReaction, type ICombatUnit } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

/**
 * owner = the log recorder (playerId); falls back to the friendly healer when
 * not found (legacy behaviour).
 * Lifted into its own export so buildAnalysisInput and
 * buildWindowAnalysisRequest (#16) share it; moved verbatim (zero behaviour
 * change — the existing analysisInput.test.ts must stay green).
 */
export function resolveOwner(legacy: {
  units: Record<string, ICombatUnit>;
  playerId?: string;
}): ICombatUnit | undefined {
  const players = Object.values(legacy.units).filter((u) => u.info);
  return (
    players.find(
      (u) =>
        u.id === legacy.playerId && u.reaction === CombatUnitReaction.Friendly,
    ) ??
    players.find(
      (u) => isHealerSpec(u.spec) && u.reaction === CombatUnitReaction.Friendly,
    )
  );
}

export type AnalysisRunInput = {
  matchId: string;
  candidates: ReturnType<typeof extractCandidateFindings>;
  richContext: string;
  spec: string;
  ownerName: string;
  enemySpecs: number[];
};

/**
 * Input construction for single-match analysis — the one entry point shared by
 * StructuredAnalysisPanel and the batch driver (single-source predicate: owner
 * resolution, candidates and richContext must not diverge between the two
 * consumers).
 *
 * Precondition: await ensureAnalysisData() before calling (prompt spell names
 * must never degrade; see analysis's data/ensure.ts). The panel gates on
 * dataReady; the batch driver awaits it once before starting.
 */
export function buildAnalysisInput(
  source: ReportSource,
  matchId: string,
): AnalysisRunInput | null {
  try {
    const legacy = toLegacySafe(source);
    const owner = resolveOwner(legacy);
    if (!owner) return null;

    const players = Object.values(legacy.units).filter((u) => u.info);
    const candidates = extractCandidateFindings(legacy, owner.id);
    const friends = players.filter((u) => u.reaction === owner.reaction);
    const enemies = players.filter((u) => u.reaction !== owner.reaction);

    const richContext = buildMatchContext(legacy, friends, enemies, {
      useTimelinePrompt: true,
      owner,
    });
    const spec = specToString(owner.spec);

    return {
      matchId,
      candidates,
      richContext,
      spec,
      ownerName: owner.name,
      enemySpecs: enemies.map((u) => Number(u.spec)).filter((s) => s > 0),
    };
  } catch {
    return null;
  }
}

/**
 * Evidence-pack construction for the deep-dive round (first-round findings →
 * ≤DEEP_DIVE_MAX survival seats + one guaranteed offensive seat); also the
 * shared path for the panel's deep-dive effect and the batch driver. Returns an
 * empty array when pack construction fails (a failed deep dive is not fatal —
 * the first round stands).
 */
export function buildDeepenPacks(
  source: ReportSource,
  findings: Finding[],
  candidates: AnalysisRunInput["candidates"],
  ownerName?: string,
): DeepDivePack[] {
  try {
    const legacy = toLegacySafe(source);
    const ranked = findings
      .map((f, i) => ({ f, i }))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.f.severity] ?? 9) -
            (SEVERITY_RANK[b.f.severity] ?? 9) || a.i - b.i,
      );
    // Survival seats: take up to DEEP_DIVE_MAX death-class packs that pass the
    // gate, in severity order; plus one guaranteed offensive seat
    const survivalPacks: DeepDivePack[] = [];
    const offensivePacks: DeepDivePack[] = [];
    for (const { f, i } of ranked) {
      const kind = classifyFindingKind(f, candidates);
      if (kind === "survival") {
        if (survivalPacks.length >= DEEP_DIVE_MAX) continue;
        const pack = buildDeepDivePack(legacy, f, i, candidates, ownerName);
        // Coachable-signal gate: do not deep-dive a clean window, which would
        // only produce boilerplate
        if (pack && hasCoachableSignal(pack.items)) survivalPacks.push(pack);
      } else {
        if (offensivePacks.length >= 1) continue; // OFFENSIVE_DEEP_DIVE_MAX = 1
        const pack = buildOffensiveDeepDivePack(
          legacy,
          f,
          i,
          candidates,
          ownerName,
        );
        if (pack && hasOffensiveCoachableSignal(pack.items))
          offensivePacks.push(pack);
      }
    }
    return [...survivalPacks, ...offensivePacks];
  } catch {
    return [];
  }
}

/** Window-analysis request (#16): pack construction and gating both happen in
 * the renderer; returns null when the gate fails (no IPC is sent).
 * Precondition: await ensureAnalysisData() before calling (prompt spell names
 * must never degrade). */
export function buildWindowAnalysisRequest(
  source: ReportSource,
  fromS: number,
  toS: number,
): {
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName: string;
  /** The clamped window bounds (see clampedFromS/clampedToS below) — both the
   * IPC payload sent to main and the result card's title must use these
   * clamped values, never the raw fromS/toS the caller passed in (measure
   * divergence: the pack is built from the clamped window, so a card or request
   * still reporting the raw values would not match its own content). */
  fromS: number;
  toS: number;
} | null {
  try {
    const legacy = toLegacySafe(source);
    const owner = resolveOwner(legacy);
    if (!owner) return null;
    // Clamp the window to [0, match duration]: inWinIds filters on the raw
    // values, so an out-of-range window would pull in out-of-bounds candidates
    // (left over from Task 1; a TimeRangeBar drag is naturally in range, so the
    // clamp is defensive).
    const durationS = (source.endTime - source.startTime) / 1000;
    const clampedFromS = Math.max(0, Math.min(fromS, durationS));
    const clampedToS = Math.max(0, Math.min(toS, durationS));
    const candidates = extractCandidateFindings(legacy, owner.id);
    const r = buildWindowPack(
      legacy,
      clampedFromS,
      clampedToS,
      candidates,
      owner.name,
    );
    if (!r) return null;
    return {
      pack: r.pack,
      kind: r.kind,
      spec: specToString(owner.spec),
      ownerName: owner.name,
      fromS: clampedFromS,
      toS: clampedToS,
    };
  } catch {
    return null;
  }
}
