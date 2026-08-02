/** Visual-regression scenes: each scene is a deterministic state reachable
 *  directly by URL. qa/visual/scenes.spec.ts screenshots them one by one; the
 *  baseline is the spec. */
export const SCENE_NAMES = [
  "report-battle",
  "report-replay",
  "report-ai",
  "report-synth",
  // The selected state of time-window linking (phase 4 ①): the only visible new
  // state, so it gets its own baseline
  "report-window",
  // events view (phase 4 ②)
  "report-events",
  "dashboard",
  "settings",
  "matchlist",
  // Developer workbench (3.7 redesign): shoots the three-column match
  // inspector at its core — rail, bottom status bar, list and filters all in
  // one frame, the composition that best guards this page against regressions
  "dev",
  // Recording page (2a redesign): a fake vod:// URL yields a black frame, plus
  // the log-driven timeline / moment list. The video area stays black, so the
  // pixels are stable; all recording-related UI goes into the baseline
  "video",
  // A large payload used only for first-paint timing — its size varies with the
  // data, so it gets no pixel baseline
  "report-heavy",
] as const;

export type SceneName = (typeof SCENE_NAMES)[number];

export function resolveScene(search: string): SceneName | null {
  const raw = new URLSearchParams(search).get("scene");
  if (!raw) return null;
  return (SCENE_NAMES as readonly string[]).includes(raw)
    ? (raw as SceneName)
    : null;
}
