/**
 * Playback-time arithmetic for the recording tab. Pure and electron-free so
 * every consumer shares the SAME predicate (CLAUDE.md shared-predicate rule)
 * -- the phase-1 bug was exactly a second, divergent copy of this arithmetic
 * inline in a component.
 *
 * Exactly one consumer today: the renderer (VideoTab.tsx and the components it
 * drives). Do not restate a "N consumers" claim here without checking first --
 * the Windows gate-check script's headroom row and a phase-2 baseline-stats
 * consumer were both once planned/present but are gone (human ruling,
 * 2026-08-03): a stale single-sourcing claim inside the single-source module
 * is the wrong comment to leave standing.
 */

/** How far to roll back before a clicked combat moment, so the viewer sees the
 * setup rather than the outcome. 3s matches arenacoach's EVENT_PRE_ROLL_SEC
 * (design doc 2026-08-02-obs-phase2-design.md 2.12). */
export const PRE_ROLL_S = 3;

export interface VideoWindow {
  /**
   * Where this match's opening sits inside the video, in seconds.
   * MAY BE NEGATIVE: negative means the recording started AFTER the match
   * opened, i.e. the first |offsetS| seconds were never captured. Phase 1
   * wrapped this in Math.max(0, ...), which ate the negative value and shifted
   * every seek late by the whole log lag.
   */
  offsetS: number;
  /** Scrubber / playback lower bound: may sit before the opening when that
   * footage exists, never below video 0. */
  windowStartS: number;
  /** Scrubber / playback upper bound: the match's end, clamped by duration. */
  windowEndS: number;
  /**
   * SIGNED headroom in seconds, identical in meaning to the design doc's
   * headroomMs = matchStart - recordingStartedAt (9.1). Negative is a real,
   * reportable value (phase-1's baseline is entirely negative, and phase 2 has
   * one documented negative exception in 5.5) -- do NOT clamp it. For "how many
   * seconds are missing", use missingHeadS.
   */
  headroomS: number;
  /** Seconds of the opening never captured; 0 when the head is covered. UI copy
   * uses this, acceptance statistics use headroomS. */
  missingHeadS: number;
  /** The whole match sits past the end of the footage. Only meaningful once
   * duration is known -- false while durationS is 0. */
  noFootage: boolean;
}

export function computeVideoWindow(args: {
  matchStartMs: number;
  matchEndMs: number;
  recordingStartedAtMs: number;
  /** Measured video duration; pass 0 when not yet known. */
  durationS: number;
}): VideoWindow {
  const { matchStartMs, matchEndMs, recordingStartedAtMs, durationS } = args;
  const offsetS = (matchStartMs - recordingStartedAtMs) / 1000;
  const windowStartS = Math.max(0, offsetS - PRE_ROLL_S);
  const rawEndS = (matchEndMs - recordingStartedAtMs) / 1000;
  const clampedEndS = durationS > 0 ? Math.min(rawEndS, durationS) : rawEndS;
  return {
    offsetS,
    windowStartS,
    windowEndS: Math.max(windowStartS, clampedEndS),
    headroomS: offsetS,
    missingHeadS: Math.max(0, -offsetS),
    noFootage: durationS > 0 && offsetS >= durationS,
  };
}

/** Video seconds -> combat seconds within this match. */
export function toBattleSeconds(videoS: number, offsetS: number): number {
  return videoS - offsetS;
}

/** Combat seconds within this match -> video seconds. */
export function toVideoSeconds(battleS: number, offsetS: number): number {
  return battleS + offsetS;
}

/** Where to seek when the user clicks a combat moment: roll back PRE_ROLL_S,
 * then clamp into the window. */
export function seekTargetS(
  battleS: number,
  w: VideoWindow,
  opts?: { preRoll?: boolean },
): number {
  const raw = toVideoSeconds(battleS, w.offsetS);
  const rolled = opts?.preRoll === false ? raw : raw - PRE_ROLL_S;
  return Math.min(Math.max(rolled, w.windowStartS), w.windowEndS);
}
