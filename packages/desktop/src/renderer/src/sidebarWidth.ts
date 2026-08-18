import { useCallback, useState } from "react";

/**
 * Width of the left match-list column, persisted across sessions.
 *
 * Persisted in localStorage rather than through SettingsStore on purpose:
 * SettingsStore.save is writeFileSync + renameSync (synchronous disk I/O)
 * behind an IPC hop, and this value changes on every pointermove of a drag.
 * Routing that through the main process would stutter the whole app for the
 * duration of the drag. Same reasoning, same mechanism as
 * report/components/useReplayLayout.ts — read that file first if you are
 * changing anything here.
 */

/** Narrow enough that the rich match rows still fit their two lines. */
export const SIDEBAR_MIN = 240;
/** Wide enough for a long realm-qualified name, and not so wide that the
 * report column stops being the subject of the screen. */
export const SIDEBAR_MAX = 560;
/** The pre-2026-08-18 hard-coded value, kept as the default so an existing
 * user's layout does not move until they drag it themselves. */
export const SIDEBAR_DEFAULT = 292;

const STORAGE_KEY = "gladlog.sidebarWidth";

/**
 * Clamp into [SIDEBAR_MIN, SIDEBAR_MAX]; anything non-finite — a key written by
 * an older build, a hand-edited localStorage entry, `null` from a cleared store
 * — falls back to the default rather than propagating NaN into a grid template
 * (which silently collapses the column to zero and hides the match list with no
 * way to get it back).
 */
export function clampSidebarWidth(desired: unknown): number {
  // 空串必须先挡掉:Number("") 是 0,是个有限数,会被下面夹成 SIDEBAR_MIN
  // 而不是回落到默认值 —— 用户会看到列表莫名其妙变成最窄,而不是原样。
  // localStorage 里出现空串不需要多离奇的场景:一次写入被打断就够了。
  const n =
    typeof desired === "string"
      ? desired.trim() === ""
        ? Number.NaN
        : Number(desired)
      : desired;
  if (typeof n !== "number" || !Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

function readPersisted(): number {
  try {
    return clampSidebarWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage can throw outright (Safari private mode, a sandboxed
    // renderer). A missing preference is not worth breaking the app shell over.
    return SIDEBAR_DEFAULT;
  }
}

function persist(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    /* not persistable in this environment; the session value still applies */
  }
}

export function useSidebarWidth(): {
  width: number;
  setWidth: (w: number) => void;
} {
  const [width, setWidthState] = useState<number>(readPersisted);
  const setWidth = useCallback((w: number) => {
    // Clamped here rather than at the call sites, so the pointer handler can
    // hand over a raw cursor offset and the keyboard handler a raw sum.
    const next = clampSidebarWidth(w);
    setWidthState(next);
    persist(next);
  }, []);
  return { width, setWidth };
}
