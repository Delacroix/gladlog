import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Main-window bounds memory (UI rework 2026-08-01): the two-column layout
 * only kicks in at ≥1440px, which the old 1200×800 default could never reach
 * -- so remember the user's last window size/position, and after maximizing
 * once on a 4K screen it opens large every time.
 *
 * A separate window-state.json, not settings.json: SettingsStore carries
 * key-encryption/masking invariants, and high-frequency writes like window
 * geometry should not be coupled to them. Kept electron-free (the path is
 * injected by the caller), same unit-testing approach as settingsStore.
 */
export interface WindowState {
  width: number;
  height: number;
  /** No x/y = let the OS center it (first launch, or the previous position is
   * no longer on any screen). */
  x?: number;
  y?: number;
  maximized: boolean;
}

/** Same values as createWindow's minWidth/minHeight -- a persisted state read
 * back must never fall below them. */
export const MIN_WINDOW = { width: 900, height: 600 } as const;

export function loadWindowState(filePath: string): WindowState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null; // no file on first launch, or corrupt -> use the defaults
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const width = num(o["width"]);
  const height = num(o["height"]);
  if (width === null || height === null) return null;
  const state: WindowState = {
    width: Math.max(MIN_WINDOW.width, Math.round(width)),
    height: Math.max(MIN_WINDOW.height, Math.round(height)),
    maximized: o["maximized"] === true,
  };
  const x = num(o["x"]);
  const y = num(o["y"]);
  if (x !== null && y !== null) {
    state.x = Math.round(x);
    state.y = Math.round(y);
  }
  return state;
}

export function saveWindowState(filePath: string, state: WindowState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, filePath); // same as settingsStore: atomic replace, no half-written file on disk
  } catch {
    // A failed write only loses one remembered state and will be rewritten on
    // the next window close -- not worth making the shutdown path throw
  }
}
