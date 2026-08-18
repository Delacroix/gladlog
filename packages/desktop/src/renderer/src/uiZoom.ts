import { clampUiZoom } from "../../shared/uiZoom";
import { bridge } from "./bridge";

/**
 * Push the saved UI scale into Chromium via the preload bridge.
 *
 * Degrades to a silent no-op whenever that bridge is missing or predates the
 * `ui` surface: `dev:ui`, the VITE_FIXTURE_MODE browser test bed, the visual
 * regression harness and the component tests all run with no preload at all,
 * and they must keep rendering at 1:1 rather than throw on mount. Two separate
 * failure shapes are covered on purpose -- `bridge()` itself returns undefined
 * when neither window.gladlog nor the fixture is installed (the property read
 * then throws, hence the try/catch), while an older or partial stub has a
 * bridge object with no `ui` on it (hence the optional chaining). Same
 * precedent as SettingsPanel's bridge().ai read.
 *
 * Takes `unknown` because the usual caller is `settings.uiZoom` straight off
 * the IPC boundary; clampUiZoom is the single predicate that decides what a
 * legal factor is (shared with main/settingsStore.ts and preload/index.ts).
 */
export function applyUiZoom(zoom: unknown): void {
  try {
    bridge().ui?.setZoomFactor?.(clampUiZoom(zoom));
  } catch {
    /* No Electron bridge (browser test bed / visual harness): stay at 100% */
  }
}
