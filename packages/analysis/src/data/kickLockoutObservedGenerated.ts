/**
 * Corpus-observed school-lockout length per kick id (GENERATED — do not
 * hand-edit; regenerate with `packages/eval/scripts/kickLockoutScan.ts`, see
 * docs/commands/update-wow-data.md §6b-pre-5).
 *
 * Why observed and not official: DB2 has no lockout field — a kick is
 * SpellEffect Effect 68 (INTERRUPT_CAST) with no SpellDuration row — and no
 * `interrupts` entry in SPELL_CATEGORIES ever carried a duration, so
 * `kickLockoutSeconds` had answered its 3 s fallback for every kick since it
 * was written (GH #62). The lockout IS observable: after SPELL_INTERRUPT the
 * victim's first same-school cast clusters at the lockout length (0.5 s bins).
 *
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 */
import raw from "./kickLockoutObservedGenerated.json";

export interface IKickLockoutObserved {
  name: string;
  /** 0.5 s-bin mode (lower edge) of the interrupt → first same-school cast gap. */
  lockoutSeconds: number;
  n: number;
  p25: number;
  p50: number;
}

export const KICK_LOCKOUT_OBSERVED: Record<string, IKickLockoutObserved> = (
  raw as { entries: Record<string, IKickLockoutObserved> }
).entries;
